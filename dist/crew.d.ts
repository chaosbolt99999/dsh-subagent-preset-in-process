import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Config as PluginConfig, Task } from './config.js';
import { type RouteOverrides } from './route.js';
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
export declare function deliverTurn(ctx: Context, sender: Agent, targetId: SessionId, content: ContentBlock[], options: {
    signal: AbortSignal;
}): Promise<MessageId>;
/** One role's durable definition. */
export interface CrewRole {
    readonly name: string;
    /** The agent preset this role is composed under (required). */
    readonly presetId: string;
    /**
     * Per-role model-route override (the request-level knob): `provider`/`model`/
     * `maxTokens` win over the plugin settings field by field when this role is
     * materialized. Absent by default, so a role with no override follows
     * Settings → Plugins like every other child.
     */
    readonly agentOptions?: RouteOverrides;
    /** Legacy flat alias of `agentOptions.provider` (per-field fallback). */
    readonly provider?: string;
    /** Legacy flat alias of `agentOptions.model` (per-field fallback). */
    readonly model?: string;
    /** Legacy flat alias of `agentOptions.maxTokens` (per-field fallback). */
    readonly maxTokens?: number;
    /**
     * Optional role tool scoping, applied as the child's scoped `tools.restrict()`.
     * This matters on deployments whose model-facing tools sit in the HOST plane
     * (every CLI/headless profile): there a preset join is additive — the child
     * keeps seeing the global registry — so without an explicit filter a "slim"
     * preset silently yields the parent's full tool set. On the web plane the
     * preset owns the tools and the filter is a no-op for the same names.
     */
    readonly toolFilter?: {
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
    };
    /** The role's standing task statement, prepended to its scoped turns. */
    readonly roleTask: string;
    /** Human-facing description surfaced by the crew tools. */
    readonly description?: string;
    /** Structured task list for this role. */
    readonly tasks: readonly Task[];
}
/** One crew: a named, ordered set of roles. */
export interface Crew {
    readonly name: string;
    /** Roles in declaration order; the first role is the entry (planner). */
    readonly roles: readonly CrewRole[];
    /** Which role routes handoffs; defaults to the role named `orchestrator` if present, else the first role. */
    readonly orchestratorRole?: string;
    /** Routing mode. */
    readonly mode: 'routed' | 'pipeline';
    /** Pipeline order and verify-gate. Only meaningful when mode === 'pipeline'. */
    readonly pipeline: {
        readonly order: readonly string[];
        readonly verifyGate: {
            readonly enabled: boolean;
            readonly verifierRole: string;
            readonly maxRetries: number;
        };
    };
}
/** Results of materializing / handing off one crew member. */
export interface CrewHandoff {
    readonly crew: string;
    readonly fromRole: string;
    readonly toRole: string;
    readonly childId: SessionId;
    readonly messageId: MessageId;
}
/** One materialized crew member (role -> live continuable child). */
export interface MemberState {
    readonly crew: string;
    readonly role: string;
    readonly childId: SessionId;
    readonly presetId: string;
    /** The EFFECTIVE route this member was materialized on (durable in its descriptor). */
    readonly route: RouteOverrides;
}
/**
 * The crew service (`ctx.crews`). Manages role-bound continuable children per
 * crew, routes turns between them, and reads settlement as the per-member
 * "task done" signal.
 */
export declare class CrewService extends Service {
    private readonly readConfig;
    /** crew name -> role name -> live member (childId). */
    private readonly members;
    /** crew name -> Crew definition. */
    private readonly crews;
    /** crew name -> mutable task map (role -> taskId -> Task). */
    private readonly taskState;
    /** crew name -> pipeline cursor. */
    private readonly pipelineState;
    constructor(ctx: Context, readConfig: () => PluginConfig);
    listCrews(): string[];
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
    reloadCrews(crewsConfig: NonNullable<PluginConfig['crews']>): void;
    roles(crew: string): readonly string[];
    /** Resolve the orchestrator role of a crew (the routing authority). */
    orchestrator(crew: string): string;
    crew(crew: string): Crew;
    /**
     * The EFFECTIVE model route a role gets on its NEXT materialize: the role's
     * request-level override (`agentOptions`, else its legacy flat aliases) over
     * the plugin's live resolved settings, field by field. Exposed through
     * `crew_status` so a per-role override can be verified without decoding
     * session logs.
     */
    roleRoute(crew: string, role: string): RouteOverrides;
    /** Live members of a crew, in declaration order (only materialized roles). */
    liveMembers(crew: string): readonly MemberState[];
    /** Resolved pipeline order for a crew (explicit order or declaration order). */
    pipelineOrder(crew: string): readonly string[];
    /** Next role in pipeline order after `fromRole` (cyclic). */
    nextInPipeline(crew: string, fromRole: string): string | undefined;
    /** Previous role before `role` in pipeline order (cyclic). */
    previousInPipeline(crew: string, role: string): string | undefined;
    /** Whether a crew is in pipeline mode. */
    isPipeline(crew: string): boolean;
    /** Current pipeline cursor (last index, blocked). */
    pipelineCursor(crew: string): {
        lastIndex: number;
        blocked: boolean;
        order: readonly string[];
    };
    /** Reset pipeline cursor (useful after manual intervention). */
    resetPipeline(crew: string): void;
    /** All tasks for a crew role (mutable copy). */
    tasks(crew: string, role: string): readonly Task[];
    /** One task by id, or undefined. */
    task(crew: string, role: string, taskId: string): Task | undefined;
    /** Update a task's status (and optional acceptance/description). Returns the updated task. */
    updateTask(crew: string, role: string, taskId: string, patch: {
        status?: Task['status'];
        title?: string;
        description?: string;
        acceptanceCriteria?: string;
    }): Task;
    /** All tasks for a crew across roles (flattened). */
    allTasks(crew: string): readonly (Task & {
        role: string;
    })[];
    /**
     * Materialize (startContinuable) every role of a crew that is not yet live.
     * The provider is the same preset-pinning provider this plugin registers;
     * each role is pinned to its own preset + route.
     */
    materialize(crew: string, parent: Agent, signal: AbortSignal): Promise<MemberState[]>;
    /**
     * Hand work from one role to the next, as a followup turn. Returns the
     * accepted message id. Enforcement is scoping-only in `routed` mode; in
     * `pipeline` mode the `toRole` must be the deterministic next role unless
     * the verify-gate loops (handled via `pipelineAdvance` or the verifier
     * verdict helpers).
     */
    handoff(crew: string, fromRole: string, toRole: string, task: readonly ContentBlock[], parent: Agent, signal: AbortSignal): Promise<CrewHandoff>;
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
    pipelineAdvance(crew: string, fromRole: string, task: readonly ContentBlock[], parent: Agent, signal: AbortSignal, options?: {
        taskId?: string;
        verifierVerdict?: 'pass' | 'fail';
        evidence?: string;
    }): Promise<CrewHandoff & {
        gate: {
            looped: boolean;
            retries: number;
            blocked: boolean;
        };
    }>;
    /** Record a verifier's structured pass/fail for a task without delivering a turn. */
    recordVerification(crew: string, taskId: string, passed: boolean, evidence?: string): {
        looped: boolean;
        nextRole: string | undefined;
        retries: number;
        blocked: boolean;
    };
    /** Find which role owns a task id, or undefined. */
    roleForTask(crew: string, taskId: string): string | undefined;
    /** Read a member's live child handle (or undefined when not resident). */
    member(crew: string, role: string): MemberState | undefined;
    private requireCrew;
    private requirePipelineState;
    private requireTaskMap;
    private requireMember;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        crews: CrewService;
    }
}
