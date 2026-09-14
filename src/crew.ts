import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Config as PluginConfig, Task } from './config.js'
import { resolveRoute, roleRouteOverrides, type RouteOverrides } from './route.js'

/**
 * Deliver one turn to a continuable child.
 *
 * `subagents.sendMessage(sender, targetId, content, options)` is the current
 * seam and the only one this package targets. The cast is purely about this
 * package's VENDORED `@deepseek-ai` copies being a generation behind (they
 * declare the older `followup` name) — reach the real API rather than a shim.
 * @param ctx - a context carrying the `subagents` service.
 * @param sender - the delegating parent agent.
 * @param targetId - the continuable child's session id.
 * @param content - the message content blocks.
 * @param options - caller cancellation.
 * @returns the accepted message id.
 */
export async function deliverTurn(
  ctx: Context,
  sender: Agent,
  targetId: SessionId,
  content: ContentBlock[],
  options: { signal: AbortSignal },
): Promise<MessageId> {
  const subagents = ctx.subagents as unknown as {
    sendMessage: (sender: Agent, targetId: SessionId, content: ContentBlock[], options: { signal: AbortSignal }) => Promise<MessageId>
  }
  return await subagents.sendMessage(sender, targetId, content, options)
}

/** One role's durable definition. */
export interface CrewRole {  /** The role's stable name (planner/orchestrator/builder/verifier). */
  readonly name: string
  /** The agent preset this role is composed under (required). */
  readonly presetId: string
  /**
   * Per-role model-route override (the request-level knob): `provider`/`model`/
   * `maxTokens` win over the plugin settings field by field when this role is
   * materialized. Absent by default, so a role with no override follows
   * Settings → Plugins like every other child.
   */
  readonly agentOptions?: RouteOverrides
  /** Legacy flat alias of `agentOptions.provider` (per-field fallback). */
  readonly provider?: string
  /** Legacy flat alias of `agentOptions.model` (per-field fallback). */
  readonly model?: string
  /** Legacy flat alias of `agentOptions.maxTokens` (per-field fallback). */
  readonly maxTokens?: number
  /**
   * Optional role tool scoping, applied as the child's scoped `tools.restrict()`.
   * This matters on deployments whose model-facing tools sit in the HOST plane
   * (every CLI/headless profile): there a preset join is additive — the child
   * keeps seeing the global registry — so without an explicit filter a "slim"
   * preset silently yields the parent's full tool set. On the web plane the
   * preset owns the tools and the filter is a no-op for the same names.
   */
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
  /** The role's standing task statement, prepended to its scoped turns. */
  readonly roleTask: string
  /** Human-facing description surfaced by the crew tools. */
  readonly description?: string
  /** Structured task list for this role. */
  readonly tasks: readonly Task[]
}

/** One crew: a named, ordered set of roles. */
export interface Crew {
  readonly name: string
  /** Roles in declaration order; the first role is the entry (planner). */
  readonly roles: readonly CrewRole[]
  /** Which role routes handoffs; defaults to the role named `orchestrator` if present, else the first role. */
  readonly orchestratorRole?: string
  /** Routing mode. */
  readonly mode: 'routed' | 'pipeline'
  /** Pipeline order and verify-gate. Only meaningful when mode === 'pipeline'. */
  readonly pipeline: {
    readonly order: readonly string[]
    readonly verifyGate: {
      readonly enabled: boolean
      readonly verifierRole: string
      readonly maxRetries: number
    }
  }
}

type CrewConfigEntry = NonNullable<PluginConfig['crews']>[string]

/** Results of materializing / handing off one crew member. */
export interface CrewHandoff {
  readonly crew: string
  readonly fromRole: string
  readonly toRole: string
  readonly childId: SessionId
  readonly messageId: MessageId
}

/** One materialized crew member (role -> live continuable child). */
export interface MemberState {
  readonly crew: string
  readonly role: string
  readonly childId: SessionId
  readonly presetId: string
  /** The EFFECTIVE route this member was materialized on (durable in its descriptor). */
  readonly route: RouteOverrides
}

interface PipelineState {
  /** Resolved order (pipeline.order or declaration order). */
  order: readonly string[]
  /** Index of the last role that ran (or -1 before any turn). */
  lastIndex: number
  /** Per-task retry count for verify-gate loops. */
  retries: Map<string, number>
  /** Whether the pipeline is blocked after exceeding maxRetries. */
  blocked: boolean
}

/**
 * The crew service (`ctx.crews`). Manages role-bound continuable children per
 * crew, routes turns between them, and reads settlement as the per-member
 * "task done" signal.
 */
export class CrewService extends Service {
  /** crew name -> role name -> live member (childId). */
  private readonly members = new Map<string, Map<string, MemberState>>()
  /** crew name -> Crew definition. */
  private readonly crews = new Map<string, Crew>()
  /** crew name -> mutable task map (role -> taskId -> Task). */
  private readonly taskState = new Map<string, Map<string, Map<string, Task>>>()
  /** crew name -> pipeline cursor. */
  private readonly pipelineState = new Map<string, PipelineState>()

  constructor(ctx: Context, private readonly readConfig: () => PluginConfig) {
    super(ctx, 'crews')
    for (const [crewName, entry] of Object.entries(this.readConfig().crews ?? {})) {
      if (this.crews.has(crewName)) {
        throw new Error(`crew "${crewName}" is declared more than once`)
      }
      const crew = toCrew(crewName, entry as CrewConfigEntry)
      this.crews.set(crewName, crew)
      this.members.set(crewName, new Map())
      this.taskState.set(crewName, buildTaskState(crew))
      this.pipelineState.set(crewName, initPipelineState(crew))
    }
  }

  listCrews(): string[] {
    return [...this.crews.keys()]
  }

  /**
   * Re-read crew definitions from a fresh resolved config. Called from the
   * settings `onChange` hook: a live Settings edit must reach the NEXT
   * materialize() without a restart, because materialize() composes members
   * from the CURRENT role definitions (preset, route, filter, roleTask).
   * Definitions update in place; live members keep their materialized
   * composition until the next fresh start (a config change never revokes a
   * running member), which matches how one-shot/continuable routes treat the
   * settings: "the next child follows the resolved settings."
   */
  reloadCrews(crewsConfig: NonNullable<PluginConfig['crews']>): void {
    for (const [crewName, entry] of Object.entries(crewsConfig)) {
      const crew = toCrew(crewName, entry as CrewConfigEntry)
      this.crews.set(crewName, crew)
      if (!this.members.has(crewName)) this.members.set(crewName, new Map())
      this.taskState.set(crewName, buildTaskState(crew))
      this.pipelineState.set(crewName, initPipelineState(crew))
    }
    // Crews removed from settings disappear from the roster. Members already
    // materialized keep running (durable continuable children are the
    // manager's, not the roster's) but no new handoffs resolve against them.
    for (const crewName of [...this.crews.keys()]) {
      if (!(crewName in crewsConfig)) this.crews.delete(crewName)
    }
  }

  roles(crew: string): readonly string[] {
    const c = this.requireCrew(crew)
    return c.roles.map((r) => r.name)
  }

  /** Resolve the orchestrator role of a crew (the routing authority). */
  orchestrator(crew: string): string {
    const c = this.requireCrew(crew)
    if (c.orchestratorRole !== undefined) return c.orchestratorRole
    const orchestrator = c.roles.find((r) => r.name === 'orchestrator')
    return orchestrator !== undefined ? orchestrator.name : c.roles[0].name
  }

  crew(crew: string): Crew {
    return this.requireCrew(crew)
  }

  /**
   * The EFFECTIVE model route a role gets on its NEXT materialize: the role's
   * request-level override (`agentOptions`, else its legacy flat aliases) over
   * the plugin's live resolved settings, field by field. Exposed through
   * `crew_status` so a per-role override can be verified without decoding
   * session logs.
   */
  roleRoute(crew: string, role: string): RouteOverrides {
    const c = this.requireCrew(crew)
    const def = c.roles.find((r) => r.name === role)
    if (def === undefined) throw new Error(`crew "${crew}" has no role "${role}"`)
    return resolveRoute(roleRouteOverrides(def), this.readConfig())
  }

  /** Live members of a crew, in declaration order (only materialized roles). */
  liveMembers(crew: string): readonly MemberState[] {
    const c = this.requireCrew(crew)
    const out: MemberState[] = []
    for (const role of c.roles) {
      const m = this.members.get(crew)?.get(role.name)
      if (m !== undefined) out.push(m)
    }
    return out
  }

  /** Resolved pipeline order for a crew (explicit order or declaration order). */
  pipelineOrder(crew: string): readonly string[] {
    const c = this.requireCrew(crew)
    if (c.pipeline.order.length > 0) return c.pipeline.order
    return c.roles.map((r) => r.name)
  }

  /** Next role in pipeline order after `fromRole` (cyclic). */
  nextInPipeline(crew: string, fromRole: string): string | undefined {
    const order = this.pipelineOrder(crew)
    const idx = order.indexOf(fromRole)
    if (idx === -1) return undefined
    return order[(idx + 1) % order.length]
  }

  /** Previous role before `role` in pipeline order (cyclic). */
  previousInPipeline(crew: string, role: string): string | undefined {
    const order = this.pipelineOrder(crew)
    const idx = order.indexOf(role)
    if (idx === -1) return undefined
    return order[(idx - 1 + order.length) % order.length]
  }

  /** Whether a crew is in pipeline mode. */
  isPipeline(crew: string): boolean {
    return this.requireCrew(crew).mode === 'pipeline'
  }

  /** Current pipeline cursor (last index, blocked). */
  pipelineCursor(crew: string): { lastIndex: number; blocked: boolean; order: readonly string[] } {
    const s = this.requirePipelineState(crew)
    return { lastIndex: s.lastIndex, blocked: s.blocked, order: s.order }
  }

  /** Reset pipeline cursor (useful after manual intervention). */
  resetPipeline(crew: string): void {
    const c = this.requireCrew(crew)
    this.pipelineState.set(crew, initPipelineState(c))
  }

  // ── task state ────────────────────────────────────────────────────────

  /** All tasks for a crew role (mutable copy). */
  tasks(crew: string, role: string): readonly Task[] {
    const m = this.requireTaskMap(crew, role)
    return [...m.values()]
  }

  /** One task by id, or undefined. */
  task(crew: string, role: string, taskId: string): Task | undefined {
    return this.requireTaskMap(crew, role).get(taskId)
  }

  /** Update a task's status (and optional acceptance/description). Returns the updated task. */
  updateTask(
    crew: string,
    role: string,
    taskId: string,
    patch: { status?: Task['status']; title?: string; description?: string; acceptanceCriteria?: string },
  ): Task {
    const map = this.requireTaskMap(crew, role)
    const existing = map.get(taskId)
    if (existing === undefined) throw new Error(`crew "${crew}" role "${role}" has no task "${taskId}"`)
    const next: Task = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteria: patch.acceptanceCriteria } : {}),
    } as Task
    map.set(taskId, next)
    return next
  }

  /** All tasks for a crew across roles (flattened). */
  allTasks(crew: string): readonly (Task & { role: string })[] {
    const c = this.requireCrew(crew)
    const out: (Task & { role: string })[] = []
    for (const role of c.roles) {
      for (const t of this.requireTaskMap(crew, role.name).values()) {
        out.push({ ...t, role: role.name })
      }
    }
    return out
  }

  /**
   * Materialize (startContinuable) every role of a crew that is not yet live.
   * The provider is the same preset-pinning provider this plugin registers;
   * each role is pinned to its own preset + route.
   */
  async materialize(crew: string, parent: Agent, signal: AbortSignal): Promise<MemberState[]> {
    const c = this.requireCrew(crew)
    const config = this.readConfig()
    const provider = config.providerName
    const out: MemberState[] = []
    for (let i = 0; i < c.roles.length; i++) {
      const role = c.roles[i].name
      const def = c.roles[i]
      const existing = this.members.get(crew)!.get(role)
      if (existing !== undefined) {
        out.push(existing)
        continue
      }
      // The child's pinned preset is threaded through the continuable path via
      // `request.presetId` (the shared subagent runtime mounts it instead of
      // inheriting the parent's preset). Per-role `def.presetId` wins; the
      // provider-level fallback covers roles that name none.
      //
      // Route: the role's request-level override (agentOptions, or its legacy
      // flat aliases) wins field by field over the plugin's resolved settings —
      // exactly the precedence the one-shot path applies — so a role that pins
      // nothing follows Settings → Plugins.
      const route = this.roleRoute(crew, role)
      const request: any = {
        prompt: rolePrompt(def, crew, role),
        parent,
        agentOptions: route,
        presetId: def.presetId ?? config.presetId,
      // Role tool scoping (see CrewRole.toolFilter) is NOT passed through the
      // request: the harness would apply it at creation, validated against the
      // PARENT's composition, where a plane-specific name fails the spawn with
      // "unknown global tool". The pin listener applies the role's filter
      // instead, after the child is re-linked onto its pinned preset — the
      // composition the filter was written for.
      }
      const res = await this.ctx.subagents.startContinuable({
        provider,
        label: `crew:${crew}:${role}`,
        request,
        signal,
      })
      const member: MemberState = { crew, role, childId: res.childId, presetId: def.presetId, route }
      this.members.get(crew)!.set(role, member)
      out.push(member)
    }
    // initialize pipeline cursor to entry role (-1 so next is first)
    if (this.isPipeline(crew)) {
      const state = this.requirePipelineState(crew)
      state.order = this.pipelineOrder(crew)
    }
    return out
  }

  /**
   * Hand work from one role to the next, as a followup turn. Returns the
   * accepted message id. Enforcement is scoping-only in `routed` mode; in
   * `pipeline` mode the `toRole` must be the deterministic next role unless
   * the verify-gate loops (handled via `pipelineAdvance` or the verifier
   * verdict helpers).
   */
  async handoff(
    crew: string,
    fromRole: string,
    toRole: string,
    task: readonly ContentBlock[],
    parent: Agent,
    signal: AbortSignal,
  ): Promise<CrewHandoff> {
    const c = this.requireCrew(crew)
    if (fromRole === toRole) {
      throw new Error(`crew "${crew}": cannot hand off "${fromRole}" to itself`)
    }
    const from = this.requireMember(crew, fromRole)
    const to = this.requireMember(crew, toRole)
    // Pipeline enforcement: toRole must be the deterministic successor.
    // The verify-gate loop is a deliberate exception: when the verifier fails,
    // it hands back to the predecessor, so allow that single backward edge.
    if (c.mode === 'pipeline') {
      const expected = this.nextInPipeline(crew, fromRole)
      const gate = c.pipeline.verifyGate
      const isVerifierLoop =
        gate.enabled && fromRole === gate.verifierRole && toRole === this.previousInPipeline(crew, fromRole)
      if (toRole !== expected && !isVerifierLoop) {
        throw new Error(
          `crew "${crew}" pipeline violation: "${fromRole}" must hand to "${expected}" (got "${toRole}"); verifier may loop to "${this.previousInPipeline(crew, fromRole)}" on failure`,
        )
      }
      // advance cursor
      const state = this.requirePipelineState(crew)
      if (state.blocked) throw new Error(`crew "${crew}" pipeline is blocked after exceeding maxRetries`)
      state.lastIndex = state.order.indexOf(toRole)
    }
    const targetDef = c.roles.find((r) => r.name === toRole)
    const prefix: ContentBlock[] = [
      { type: 'text', text: `You are the "${toRole}" role of crew "${crew}". ${targetDef?.roleTask ?? ''}\n\nWork handed to you from "${fromRole}":` },
    ]
    const messageId = await deliverTurn(this.ctx, parent, to.childId, [...prefix, ...task], { signal })
    return { crew, fromRole, toRole, childId: to.childId, messageId }
  }

  /**
   * Deterministic pipeline advance: decide the next role (respecting the
   * verify-gate), deliver the handoff, and — when `taskId` is given — update
   * the task's status based on the gate outcome so the filtered view stays
   * accurate. Returns the handoff plus gate metadata.
   *
   * - In `routed` mode, `pipelineAdvance` simply hands to the next in
   *   declaration order (useful for scripted demos).
   * - In `pipeline` mode with the gate enabled, a failing verifier loops to
   *   the predecessor with `retries` incremented; exceeding `maxRetries`
   *   blocks the pipeline and throws.
   */
  async pipelineAdvance(
    crew: string,
    fromRole: string,
    task: readonly ContentBlock[],
    parent: Agent,
    signal: AbortSignal,
    options?: { taskId?: string; verifierVerdict?: 'pass' | 'fail'; evidence?: string },
  ): Promise<CrewHandoff & { gate: { looped: boolean; retries: number; blocked: boolean } }> {
    const c = this.requireCrew(crew)
    const state = this.requirePipelineState(crew)
    if (state.blocked) throw new Error(`crew "${crew}" pipeline is blocked after exceeding maxRetries`)
    const gate = c.pipeline.verifyGate
    const isVerifier = fromRole === gate.verifierRole
    let nextRole: string | undefined
    let looped = false
    let retries = 0

    if (c.mode === 'pipeline' && gate.enabled && isVerifier) {
      const verdict = options?.verifierVerdict
      if (verdict === 'fail') {
        const taskId = options?.taskId ?? '__default__'
        const cur = state.retries.get(taskId) ?? 0
        const next = cur + 1
        if (next > gate.maxRetries) {
          state.blocked = true
          throw new Error(`crew "${crew}" verify-gate blocked after ${gate.maxRetries} failures for task "${taskId}"`)
        }
        state.retries.set(taskId, next)
        retries = next
        looped = true
        nextRole = this.previousInPipeline(crew, fromRole)
        // mark task failed so callers can filter
        if (options?.taskId !== undefined) {
          const roleForTask = this.roleForTask(crew, options.taskId) ?? this.previousInPipeline(crew, fromRole)
          if (roleForTask !== undefined) {
            try {
              this.updateTask(crew, roleForTask, options.taskId, { status: 'failed' })
            } catch {
              // task may be crew-level; ignore
            }
          }
        }
      } else if (verdict === 'pass') {
        if (options?.taskId !== undefined) {
          const roleForTask = this.roleForTask(crew, options.taskId)
          if (roleForTask !== undefined) {
            try {
              this.updateTask(crew, roleForTask, options.taskId, { status: 'done' })
            } catch {}
          }
          state.retries.delete(options.taskId)
        }
        nextRole = this.nextInPipeline(crew, fromRole)
      } else {
        // No verdict supplied — treat as normal advance past verifier (pass)
        nextRole = this.nextInPipeline(crew, fromRole)
      }
    } else {
      nextRole = this.nextInPipeline(crew, fromRole)
    }

    if (nextRole === undefined) throw new Error(`crew "${crew}" has no successor for "${fromRole}"`)
    const handoffTask: readonly ContentBlock[] =
      looped && options?.evidence !== undefined
        ? ([...task, { type: 'text', text: `\n\nVerifier failed: ${options.evidence}` }] as readonly ContentBlock[])
        : task
    const h = await this.handoff(crew, fromRole, nextRole, handoffTask, parent, signal)
    // pipeline cursor is advanced inside handoff; also update for looped case
    if (looped) {
      // handoff already set lastIndex to nextRole; keep retries
    }
    return { ...h, gate: { looped, retries, blocked: state.blocked } }
  }

  /** Record a verifier's structured pass/fail for a task without delivering a turn. */
  recordVerification(
    crew: string,
    taskId: string,
    passed: boolean,
    evidence?: string,
  ): { looped: boolean; nextRole: string | undefined; retries: number; blocked: boolean } {
    const c = this.requireCrew(crew)
    const gate = c.pipeline.verifyGate
    const state = this.requirePipelineState(crew)
    if (state.blocked) throw new Error(`crew "${crew}" pipeline is blocked`)
    const roleForTask = this.roleForTask(crew, taskId)
    if (roleForTask !== undefined) {
      this.updateTask(crew, roleForTask, taskId, { status: passed ? 'done' : 'failed' })
    }
    if (!gate.enabled || c.mode !== 'pipeline') {
      return { looped: false, nextRole: this.nextInPipeline(crew, gate.verifierRole), retries: 0, blocked: false }
    }
    if (passed) {
      state.retries.delete(taskId)
      return { looped: false, nextRole: this.nextInPipeline(crew, gate.verifierRole), retries: 0, blocked: false }
    }
    const cur = state.retries.get(taskId) ?? 0
    const next = cur + 1
    if (next > gate.maxRetries) {
      state.blocked = true
      return { looped: true, nextRole: this.previousInPipeline(crew, gate.verifierRole), retries: next, blocked: true }
    }
    state.retries.set(taskId, next)
    return { looped: true, nextRole: this.previousInPipeline(crew, gate.verifierRole), retries: next, blocked: false }
  }

  /** Find which role owns a task id, or undefined. */
  roleForTask(crew: string, taskId: string): string | undefined {
    const c = this.requireCrew(crew)
    for (const r of c.roles) {
      const m = this.taskState.get(crew)?.get(r.name)
      if (m?.has(taskId)) return r.name
    }
    return undefined
  }

  /** Read a member's live child handle (or undefined when not resident). */
  member(crew: string, role: string): MemberState | undefined {
    return this.members.get(crew)?.get(role)
  }

  private requireCrew(crew: string): Crew {
    const c = this.crews.get(crew)
    if (c === undefined) throw new Error(`unknown crew "${crew}"`)
    return c
  }

  private requirePipelineState(crew: string): PipelineState {
    const s = this.pipelineState.get(crew)
    if (s === undefined) throw new Error(`crew "${crew}" has no pipeline state`)
    return s
  }

  private requireTaskMap(crew: string, role: string): Map<string, Task> {
    const crewMap = this.taskState.get(crew)
    if (crewMap === undefined) throw new Error(`unknown crew "${crew}"`)
    const roleMap = crewMap.get(role)
    if (roleMap === undefined) throw new Error(`crew "${crew}" has no role "${role}"`)
    return roleMap
  }

  private requireMember(crew: string, role: string): MemberState {
    const m = this.members.get(crew)?.get(role)
    if (m === undefined) throw new Error(`crew "${crew}" has no materialized role "${role}" (call materialize first)`)
    return m
  }
}

/** Convert one config crew entry into the internal Crew shape (name = map key). */
function toCrew(name: string, entry: CrewConfigEntry): Crew {
  return {
    name,
    orchestratorRole: (entry as any).orchestratorRole,
    mode: ((entry as any).mode as 'routed' | 'pipeline') ?? 'routed',
    roles: (entry.roles as any[]).map((r) => ({
      name: r.name,
      presetId: r.presetId,
      agentOptions: r.agentOptions,
      provider: r.provider,
      model: r.model,
      maxTokens: r.maxTokens,
      toolFilter: r.toolFilter,
      roleTask: r.roleTask,
      description: r.description,
      tasks: (r.tasks ?? []) as readonly Task[],
    })),
    pipeline: {
      order: ((entry as any).pipeline?.order as readonly string[]) ?? [],
      verifyGate: {
        enabled: ((entry as any).pipeline?.verifyGate?.enabled as boolean) ?? true,
        verifierRole: ((entry as any).pipeline?.verifyGate?.verifierRole as string) ?? 'verifier',
        maxRetries: ((entry as any).pipeline?.verifyGate?.maxRetries as number) ?? 3,
      },
    },
  }
}

function buildTaskState(crew: Crew): Map<string, Map<string, Task>> {
  const out = new Map<string, Map<string, Task>>()
  for (const role of crew.roles) {
    const m = new Map<string, Task>()
    for (const t of role.tasks as readonly Task[]) {
      m.set(t.id, { ...t })
    }
    out.set(role.name, m)
  }
  return out
}

function initPipelineState(crew: Crew): PipelineState {
  return {
    order: crew.pipeline.order.length > 0 ? [...crew.pipeline.order] : crew.roles.map((r) => r.name),
    lastIndex: -1,
    retries: new Map(),
    blocked: false,
  }
}

/** Role name is its explicit stable name. */
function rolePrompt(def: CrewRole, crew: string, role: string): ContentBlock[] {
  const taskList =
    def.tasks.length > 0
      ? `\n\nYour structured tasks:\n${def.tasks.map((t) => `- ${t.id}: ${t.title} [${t.status}]${t.acceptanceCriteria ? ` (accept: ${t.acceptanceCriteria})` : ''}`).join('\n')}`
      : ''
  return [
    {
      type: 'text',
      text: `You are the "${role}" role of crew "${crew}". ${def.roleTask}${taskList}\n\nWork one turn at a time: complete your assigned task, report your result, then wait for the next task.`,
    },
  ]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    crews: CrewService
  }
}
