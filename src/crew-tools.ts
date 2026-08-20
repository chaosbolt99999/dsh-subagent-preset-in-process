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
        'Hand one crew member\'s completed work to the next role as its next turn. Each role runs on its own preset and completes its task turn before waiting for the next handoff. The target role receives the task as its next inbox turn.',
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
      description: 'List the named crews, their roles, and the orchestrator role that routes handoffs.',
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
          crews: crews.listCrews().map((name) => ({
            name,
            roles: crews.roles(name),
            orchestrator: crews.orchestrator(name),
          })),
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
        const settled = []
        for (const role of roleNames) {
          const member = crews.member(a.crew, role)
          if (member === undefined) {
            throw new Error(`crew "${a.crew}" role "${role}" is not materialized (call crew_materialize first)`)
          }
          const result = await waitForSettlement(ctx, String(member.childId), exec.signal)
          settled.push({ role, ...result })
        }
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
