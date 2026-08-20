import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Config as PluginConfig } from './config.js'

/**
 * Crew orchestration: a named set of role-bound, continuously-resident child
 * agents (planner <-> orchestrator <-> builder <-> verifier) that hand work to
 * each other by turns. Each role is a continuable subagent pinned to its own
 * preset (and optional model route); a "turn" is one inbox message, and a
 * member's turn is "done" when its Activation settles (stopReason +
 * final output). The plugin enforces role scoping and handoff validity while a
 * designated orchestrator role routes the work.
 */

/** One role's durable definition. */
export interface CrewRole {
  /** The role's stable name (planner/orchestrator/builder/verifier). */
  readonly name: string
  /** The agent preset this role is composed under (required). */
  readonly presetId: string
  /** Optional model-route override; falls back to the plugin defaults. */
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  /** The role's standing task statement, prepended to its scoped turns. */
  readonly roleTask: string
  /** Human-facing description surfaced by the crew tools. */
  readonly description?: string
}

/** One crew: a named, ordered set of roles. */
export interface Crew {
  readonly name: string
  /** Roles in declaration order; the first role is the entry (planner). */
  readonly roles: readonly CrewRole[]
  /** Which role routes handoffs; defaults to the role named `orchestrator` if present, else the first role. */
  readonly orchestratorRole?: string
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

interface MemberState {
  readonly crew: string
  readonly role: string
  readonly childId: SessionId
  readonly presetId: string
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

  constructor(ctx: Context, private readonly readConfig: () => PluginConfig) {
    super(ctx, 'crews')
    for (const [crewName, entry] of Object.entries(this.readConfig().crews ?? {})) {
      if (this.crews.has(crewName)) {
        throw new Error(`crew "${crewName}" is declared more than once`)
      }
      this.crews.set(crewName, toCrew(crewName, entry as CrewConfigEntry))
      this.members.set(crewName, new Map())
    }
  }

  listCrews(): string[] {
    return [...this.crews.keys()]
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
      const request: any = {
        prompt: rolePrompt(def, crew, role),
        parent,
        agentOptions: {
          provider: def.provider ?? config.provider,
          model: def.model ?? config.model,
          ...(def.maxTokens !== undefined || config.maxTokens !== undefined
            ? { maxTokens: def.maxTokens ?? config.maxTokens }
            : {}),
        },
        presetId: def.presetId ?? config.presetId,
      }
      const res = await this.ctx.subagents.startContinuable({
        provider,
        label: `crew:${crew}:${role}`,
        request,
        signal,
      })
      const member: MemberState = { crew, role, childId: res.childId, presetId: def.presetId }
      this.members.get(crew)!.set(role, member)
      out.push(member)
    }
    return out
  }

  /**
   * Hand work from one role to the next, as a followup turn. Returns the
   * accepted message id. Enforcement is scoping-only: the followup is admitted
   * iff both roles belong to the same crew and the target role is not the
   * source (no self-handoff).
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
    const targetDef = c.roles.find((r) => r.name === toRole)
    const prefix: ContentBlock[] = [
      { type: 'text', text: `You are the "${toRole}" role of crew "${crew}". ${targetDef?.roleTask ?? ''}\n\nWork handed to you from "${fromRole}":` },
    ]
    const messageId = await this.ctx.subagents.followup(parent, to.childId, [...prefix, ...task], {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: from.childId },
      signal,
    })
    return { crew, fromRole, toRole, childId: to.childId, messageId }
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
    orchestratorRole: entry.orchestratorRole,
    roles: entry.roles.map((r) => ({
      name: r.name,
      presetId: r.presetId,
      provider: r.provider,
      model: r.model,
      maxTokens: r.maxTokens,
      roleTask: r.roleTask,
      description: r.description,
    })),
  }
}

/** Role name is its explicit stable name. */
function rolePrompt(def: CrewRole, crew: string, role: string): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `You are the "${role}" role of crew "${crew}". ${def.roleTask}\n\nWork one turn at a time: complete your assigned task, report your result, then wait for the next task.`,
    },
  ]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    crews: CrewService
  }
}
