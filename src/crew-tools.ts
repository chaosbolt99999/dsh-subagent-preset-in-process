import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CrewService } from './crew.js'
import { waitForSettlement } from './wait.js'

/**
 * Model-facing crew control tools: materialize a crew, hand work between roles,
 * read crew status, and — crucially — WAIT for a role (or any continuable
 * child) to settle without the parent resorting to `sleep` polling. The wait
 * tools block the calling agent's turn until the child reports done, so longer
 * tasks no longer need a guessed timeout.
 *
 * Pipeline mode adds deterministic ordering with a verify-gate: `crew_pipeline_advance`
 * routes to the next role (or loops back on verifier failure), `crew_task_update`
 * edits per-role structured tasks, and `crew_verify` / `crew_pipeline_status`
 * surface gate state.
 */

function objectOutput(schema: Record<string, unknown>) {
  return {
    schema,
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

/** Register the crew tools on `ctx.tools`. Returns the disposers. */
export function registerCrewTools(ctx: Context, crews: CrewService): (() => void)[] {
  return [
    ctx.tools.register({
      name: 'crew_handoff',
      description:
        'Hand one crew member\'s completed work to the next role as its next turn. Each role runs on its own preset and completes its task turn before waiting for the next handoff. The target role receives the task as its next inbox turn. In pipeline mode the to_role must be the deterministic successor (verifier may loop to predecessor on failure).',
      parameters: {
        type: 'object',
        properties: {
          crew: { type: 'string', description: 'The crew name (e.g. "engineering").' },
          from_role: { type: 'string', description: 'The role handing off (a crew member name).' },
          to_role: { type: 'string', description: 'The role receiving the work (a crew member name).' },
          task: { type: 'string', description: 'The work to hand to the target role.' },
        },
        required: ['crew', 'from_role', 'to_role', 'task'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: { ok: { type: 'boolean' }, to_role: { type: 'string' } },
        required: ['ok', 'to_role'],
        additionalProperties: false,
      }),
      async execute(args: unknown, exec: ToolRunContext) {
        const a = args as { crew: string; from_role: string; to_role: string; task: string }
        if (exec.agent === undefined) {
          throw new Error('crew_handoff requires a calling agent (exec.agent was undefined)')
        }
        const handoff = await crews.handoff(
          a.crew,
          a.from_role,
          a.to_role,
          [{ type: 'text', text: a.task }],
          exec.agent,
          exec.signal,
        )
        return { ok: true, to_role: handoff.toRole }
      },
    }),
    ctx.tools.register({
      name: 'crew_materialize',
      description:
        'Materialize every role of a named crew as continuously-resident worker agents (one per role preset). Call once before handing off work. Idempotent: already-live members are reused.',
      parameters: {
        type: 'object',
        properties: { crew: { type: 'string', description: 'The crew name to materialize.' } },
        required: ['crew'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: { roles: { type: 'array', items: { type: 'string' } } },
        required: ['roles'],
        additionalProperties: false,
      }),
      async execute(args: unknown, exec: ToolRunContext) {
        const a = args as { crew: string }
        if (exec.agent === undefined) {
          throw new Error('crew_materialize requires a calling agent (exec.agent was undefined)')
        }
        const members = await crews.materialize(a.crew, exec.agent, exec.signal)
        return { roles: members.map((m) => m.role) }
      },
    }),
    ctx.tools.register({
      name: 'crew_status',
      description: 'List the named crews, their roles, orchestrator, mode, pipeline order and verify-gate.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: { crews: { type: 'array', items: { type: 'object' } } },
        required: ['crews'],
        additionalProperties: false,
      }),
      execute() {
        return Promise.resolve({
          crews: crews.listCrews().map((name) => {
            const c = crews.crew(name)
            const cursor = crews.pipelineCursor(name)
            return {
              name,
              roles: crews.roles(name),
              orchestrator: crews.orchestrator(name),
              mode: c.mode,
              pipeline: {
                order: [...crews.pipelineOrder(name)],
                verifyGate: { ...c.pipeline.verifyGate },
                cursor: { lastIndex: cursor.lastIndex, blocked: cursor.blocked },
              },
              tasks: crews.allTasks(name),
            }
          }),
        })
      },
    }),
    // ── pipeline ──────────────────────────────────────────────────────
    ctx.tools.register({
      name: 'crew_pipeline_advance',
      description:
        'Deterministic pipeline advance: hand work from one role to the next role in pipeline order, respecting the verify-gate. When called from the verifier role, set verifier_verdict pass|fail and an evidence string; a failing verification loops back to the predecessor and increments retries, and exceeding maxRetries blocks the pipeline.',
      parameters: {
        type: 'object',
        properties: {
          crew: { type: 'string', description: 'The crew name.' },
          from_role: { type: 'string', description: 'The role that just completed (verifier when gating).' },
          task: { type: 'string', description: 'Work payload for the next role.' },
          task_id: { type: 'string', description: 'Optional structured task id whose status the gate updates.' },
          verifier_verdict: { type: 'string', enum: ['pass', 'fail'], description: 'Pass/fail when from_role is the verifier; omit elsewhere.' },
          evidence: { type: 'string', description: 'Evidence or failure report attached to the handoff (appended on loop).' },
        },
        required: ['crew', 'from_role', 'task'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          to_role: { type: 'string' },
          gate: {
            type: 'object',
            properties: {
              looped: { type: 'boolean' },
              retries: { type: 'number' },
              blocked: { type: 'boolean' },
            },
            required: ['looped', 'retries', 'blocked'],
          },
        },
        required: ['ok', 'to_role', 'gate'],
        additionalProperties: false,
      }),
      async execute(args: unknown, exec: ToolRunContext) {
        const a = args as {
          crew: string
          from_role: string
          task: string
          task_id?: string
          verifier_verdict?: 'pass' | 'fail'
          evidence?: string
        }
        if (exec.agent === undefined) throw new Error('crew_pipeline_advance requires a calling agent')
        const h = await crews.pipelineAdvance(
          a.crew,
          a.from_role,
          [{ type: 'text', text: a.task }],
          exec.agent,
          exec.signal,
          { taskId: a.task_id, verifierVerdict: a.verifier_verdict, evidence: a.evidence },
        )
        return { ok: true, to_role: h.toRole, gate: h.gate }
      },
    }),
    ctx.tools.register({
      name: 'crew_pipeline_status',
      description:
        'Read the pipeline cursor, verify-gate state and per-role structured tasks for one crew. Use to decide the next handoff or to render progress.',
      parameters: {
        type: 'object',
        properties: { crew: { type: 'string', description: 'The crew name.' } },
        required: ['crew'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: {
          crew: { type: 'string' },
          mode: { type: 'string' },
          order: { type: 'array', items: { type: 'string' } },
          cursor: { type: 'object' },
          verifyGate: { type: 'object' },
          tasks: { type: 'array', items: { type: 'object' } },
        },
        required: ['crew', 'mode', 'order', 'cursor', 'verifyGate', 'tasks'],
        additionalProperties: false,
      }),
      execute(args: unknown) {
        const a = args as { crew: string }
        const c = crews.crew(a.crew)
        const cursor = crews.pipelineCursor(a.crew)
        return Promise.resolve({
          crew: a.crew,
          mode: c.mode,
          order: [...crews.pipelineOrder(a.crew)],
          cursor: { lastIndex: cursor.lastIndex, blocked: cursor.blocked },
          verifyGate: { ...c.pipeline.verifyGate },
          tasks: [...crews.allTasks(a.crew)],
        })
      },
    }),
    ctx.tools.register({
      name: 'crew_task_update',
      description:
        'Update one structured task on a crew role (status, title, description, acceptanceCriteria). Tasks carry id/status/acceptance so the verifier gate can check them.',
      parameters: {
        type: 'object',
        properties: {
          crew: { type: 'string', description: 'The crew name.' },
          role: { type: 'string', description: 'The role that owns the task.' },
          task_id: { type: 'string', description: 'Task id.' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'failed', 'blocked'],
            description: 'New status.',
          },
          title: { type: 'string', description: 'New title.' },
          description: { type: 'string', description: 'New description.' },
          acceptanceCriteria: { type: 'string', description: 'New acceptance criteria.' },
        },
        required: ['crew', 'role', 'task_id'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: { ok: { type: 'boolean' }, task: { type: 'object' } },
        required: ['ok', 'task'],
        additionalProperties: false,
      }),
      execute(args: unknown) {
        const a = args as {
          crew: string
          role: string
          task_id: string
          status?: 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked'
          title?: string
          description?: string
          acceptanceCriteria?: string
        }
        const t = crews.updateTask(a.crew, a.role, a.task_id, {
          status: a.status,
          title: a.title,
          description: a.description,
          acceptanceCriteria: a.acceptanceCriteria,
        })
        return Promise.resolve({ ok: true, task: t })
      },
    }),
    ctx.tools.register({
      name: 'crew_verify',
      description:
        'Record a verifier\'s structured pass/fail for a task. Updates the task to done/failed and, in pipeline mode, advances or loops the pipeline (respecting maxRetries). Use when the verifier has produced a verdict but hasn\'t handed off yet.',
      parameters: {
        type: 'object',
        properties: {
          crew: { type: 'string', description: 'The crew name.' },
          task_id: { type: 'string', description: 'Task id being verified.' },
          passed: { type: 'boolean', description: 'Whether the verification passed.' },
          evidence: { type: 'string', description: 'Evidence or failure report.' },
        },
        required: ['crew', 'task_id', 'passed'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          looped: { type: 'boolean' },
          next_role: { type: 'string' },
          retries: { type: 'number' },
          blocked: { type: 'boolean' },
        },
        required: ['ok', 'looped', 'next_role', 'retries', 'blocked'],
        additionalProperties: false,
      }),
      execute(args: unknown) {
        const a = args as { crew: string; task_id: string; passed: boolean; evidence?: string }
        const r = crews.recordVerification(a.crew, a.task_id, a.passed, a.evidence)
        return Promise.resolve({
          ok: true,
          looped: r.looped,
          next_role: r.nextRole ?? '',
          retries: r.retries,
          blocked: r.blocked,
        })
      },
    }),
    ctx.tools.register({
      name: 'crew_wait',
      description:
        'Block the current turn until a crew role (or every role when `role` is omitted) finishes its current work and settles, then return each settlement (stop reason + closing output). Use this after crew_handoff instead of sleeping or polling list_agents: it returns as soon as the role reports done, however long that takes.',
      parameters: {
        type: 'object',
        properties: {
          crew: { type: 'string', description: 'The crew name (e.g. "engineering").' },
          role: { type: 'string', description: 'Optional role name; omit to wait for every role.' },
        },
        required: ['crew'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: {
          settled: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                childId: { type: 'string' },
                stopReason: { type: 'string' },
                output: { type: 'array', items: { type: 'object' } },
              },
              required: ['role', 'childId', 'stopReason', 'output'],
              additionalProperties: false,
            },
          },
        },
        required: ['settled'],
        additionalProperties: false,
      }),
      async execute(args: unknown, exec: ToolRunContext) {
        const a = args as { crew: string; role?: string }
        const roleNames = a.role !== undefined ? [a.role] : crews.roles(a.crew)
        const members = roleNames.map((role) => {
          const member = crews.member(a.crew, role)
          if (member === undefined) {
            throw new Error(`crew "${a.crew}" role "${role}" is not materialized (call crew_materialize first)`)
          }
          return { role, member }
        })
        // All waits share one settled[] result. Each member's settlement is
        // observed independently, so one slow role does not delay the others'
        // liveness reads (they run concurrently, unlike the previous serial
        // loop where a long first role skewed every later one).
        const settled = await Promise.all(
          members.map(({ role, member }) =>
            waitForSettlement(ctx, String(member.childId), exec.signal).then((result) => ({ role, ...result })),
          ),
        )
        return { settled }
      },
    }),
    ctx.tools.register({
      name: 'subagent_wait',
      description:
        'Block the current turn until a background continuable subagent (by subagent id) settles, then return its stop reason and closing output. Use this instead of sleeping or polling: it wakes the moment the subagent reports done, however long that takes.',
      parameters: {
        type: 'object',
        properties: { subagent_id: { type: 'string', description: 'The continuable subagent id to wait for.' } },
        required: ['subagent_id'],
        additionalProperties: false,
      },
      output: objectOutput({
        type: 'object',
        properties: {
          childId: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'array', items: { type: 'object' } },
        },
        required: ['childId', 'stopReason', 'output'],
        additionalProperties: false,
      }),
      async execute(args: unknown, exec: ToolRunContext) {
        const a = args as { subagent_id: string }
        return waitForSettlement(ctx, a.subagent_id, exec.signal)
      },
    }),
  ]
}
