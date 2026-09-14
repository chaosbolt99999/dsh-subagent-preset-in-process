import { Service } from '@deepseek-ai/cordis';
import { resolveRoute, roleRouteOverrides } from './route.js';
/**
 * Deliver one turn to a continuable child, across harness generations.
 *
 * The seam was RENAMED, not reshaped: older harnesses expose
 * `subagents.followup(parent, childId, content, options)`, current ones expose
 * `subagents.sendMessage(sender, targetId, content, options)` with the same
 * arguments and return value. A plugin that calls either name directly throws
 * "is not a function" on the other generation, so both are accepted and the
 * modern name wins.
 *
 * `source` is passed unconditionally: the older seam consumes it to record who
 * relayed the turn, and the newer one derives authorship itself and ignores the
 * extra key.
 * @param ctx - a context carrying the `subagents` service.
 * @param sender - the delegating parent agent.
 * @param targetId - the continuable child's session id.
 * @param content - the message content blocks.
 * @param options - relay source and caller cancellation.
 * @returns the accepted message id.
 * @throws when the harness exposes neither delivery method.
 */
export async function deliverTurn(ctx, sender, targetId, content, options) {
    const subagents = ctx.subagents;
    const deliver = subagents.sendMessage ?? subagents.followup;
    if (deliver === undefined) {
        throw new Error('this harness exposes neither subagents.sendMessage() nor subagents.followup(); crew handoff cannot be delivered');
    }
    return await deliver.call(ctx.subagents, sender, targetId, content, options);
}
/**
 * The crew service (`ctx.crews`). Manages role-bound continuable children per
 * crew, routes turns between them, and reads settlement as the per-member
 * "task done" signal.
 */
export class CrewService extends Service {
    readConfig;
    /** crew name -> role name -> live member (childId). */
    members = new Map();
    /** crew name -> Crew definition. */
    crews = new Map();
    /** crew name -> mutable task map (role -> taskId -> Task). */
    taskState = new Map();
    /** crew name -> pipeline cursor. */
    pipelineState = new Map();
    constructor(ctx, readConfig) {
        super(ctx, 'crews');
        this.readConfig = readConfig;
        for (const [crewName, entry] of Object.entries(this.readConfig().crews ?? {})) {
            if (this.crews.has(crewName)) {
                throw new Error(`crew "${crewName}" is declared more than once`);
            }
            const crew = toCrew(crewName, entry);
            this.crews.set(crewName, crew);
            this.members.set(crewName, new Map());
            this.taskState.set(crewName, buildTaskState(crew));
            this.pipelineState.set(crewName, initPipelineState(crew));
        }
    }
    listCrews() {
        return [...this.crews.keys()];
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
    reloadCrews(crewsConfig) {
        for (const [crewName, entry] of Object.entries(crewsConfig)) {
            const crew = toCrew(crewName, entry);
            this.crews.set(crewName, crew);
            if (!this.members.has(crewName))
                this.members.set(crewName, new Map());
            this.taskState.set(crewName, buildTaskState(crew));
            this.pipelineState.set(crewName, initPipelineState(crew));
        }
        // Crews removed from settings disappear from the roster. Members already
        // materialized keep running (durable continuable children are the
        // manager's, not the roster's) but no new handoffs resolve against them.
        for (const crewName of [...this.crews.keys()]) {
            if (!(crewName in crewsConfig))
                this.crews.delete(crewName);
        }
    }
    roles(crew) {
        const c = this.requireCrew(crew);
        return c.roles.map((r) => r.name);
    }
    /** Resolve the orchestrator role of a crew (the routing authority). */
    orchestrator(crew) {
        const c = this.requireCrew(crew);
        if (c.orchestratorRole !== undefined)
            return c.orchestratorRole;
        const orchestrator = c.roles.find((r) => r.name === 'orchestrator');
        return orchestrator !== undefined ? orchestrator.name : c.roles[0].name;
    }
    crew(crew) {
        return this.requireCrew(crew);
    }
    /**
     * The EFFECTIVE model route a role gets on its NEXT materialize: the role's
     * request-level override (`agentOptions`, else its legacy flat aliases) over
     * the plugin's live resolved settings, field by field. Exposed through
     * `crew_status` so a per-role override can be verified without decoding
     * session logs.
     */
    roleRoute(crew, role) {
        const c = this.requireCrew(crew);
        const def = c.roles.find((r) => r.name === role);
        if (def === undefined)
            throw new Error(`crew "${crew}" has no role "${role}"`);
        return resolveRoute(roleRouteOverrides(def), this.readConfig());
    }
    /** Live members of a crew, in declaration order (only materialized roles). */
    liveMembers(crew) {
        const c = this.requireCrew(crew);
        const out = [];
        for (const role of c.roles) {
            const m = this.members.get(crew)?.get(role.name);
            if (m !== undefined)
                out.push(m);
        }
        return out;
    }
    /** Resolved pipeline order for a crew (explicit order or declaration order). */
    pipelineOrder(crew) {
        const c = this.requireCrew(crew);
        if (c.pipeline.order.length > 0)
            return c.pipeline.order;
        return c.roles.map((r) => r.name);
    }
    /** Next role in pipeline order after `fromRole` (cyclic). */
    nextInPipeline(crew, fromRole) {
        const order = this.pipelineOrder(crew);
        const idx = order.indexOf(fromRole);
        if (idx === -1)
            return undefined;
        return order[(idx + 1) % order.length];
    }
    /** Previous role before `role` in pipeline order (cyclic). */
    previousInPipeline(crew, role) {
        const order = this.pipelineOrder(crew);
        const idx = order.indexOf(role);
        if (idx === -1)
            return undefined;
        return order[(idx - 1 + order.length) % order.length];
    }
    /** Whether a crew is in pipeline mode. */
    isPipeline(crew) {
        return this.requireCrew(crew).mode === 'pipeline';
    }
    /** Current pipeline cursor (last index, blocked). */
    pipelineCursor(crew) {
        const s = this.requirePipelineState(crew);
        return { lastIndex: s.lastIndex, blocked: s.blocked, order: s.order };
    }
    /** Reset pipeline cursor (useful after manual intervention). */
    resetPipeline(crew) {
        const c = this.requireCrew(crew);
        this.pipelineState.set(crew, initPipelineState(c));
    }
    // ── task state ────────────────────────────────────────────────────────
    /** All tasks for a crew role (mutable copy). */
    tasks(crew, role) {
        const m = this.requireTaskMap(crew, role);
        return [...m.values()];
    }
    /** One task by id, or undefined. */
    task(crew, role, taskId) {
        return this.requireTaskMap(crew, role).get(taskId);
    }
    /** Update a task's status (and optional acceptance/description). Returns the updated task. */
    updateTask(crew, role, taskId, patch) {
        const map = this.requireTaskMap(crew, role);
        const existing = map.get(taskId);
        if (existing === undefined)
            throw new Error(`crew "${crew}" role "${role}" has no task "${taskId}"`);
        const next = {
            ...existing,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteria: patch.acceptanceCriteria } : {}),
        };
        map.set(taskId, next);
        return next;
    }
    /** All tasks for a crew across roles (flattened). */
    allTasks(crew) {
        const c = this.requireCrew(crew);
        const out = [];
        for (const role of c.roles) {
            for (const t of this.requireTaskMap(crew, role.name).values()) {
                out.push({ ...t, role: role.name });
            }
        }
        return out;
    }
    /**
     * Materialize (startContinuable) every role of a crew that is not yet live.
     * The provider is the same preset-pinning provider this plugin registers;
     * each role is pinned to its own preset + route.
     */
    async materialize(crew, parent, signal) {
        const c = this.requireCrew(crew);
        const config = this.readConfig();
        const provider = config.providerName;
        const out = [];
        for (let i = 0; i < c.roles.length; i++) {
            const role = c.roles[i].name;
            const def = c.roles[i];
            const existing = this.members.get(crew).get(role);
            if (existing !== undefined) {
                out.push(existing);
                continue;
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
            const route = this.roleRoute(crew, role);
            const request = {
                prompt: rolePrompt(def, crew, role),
                parent,
                agentOptions: route,
                presetId: def.presetId ?? config.presetId,
                // Role tool scoping (see CrewRole.toolFilter): without it a host-plane
                // deployment hands every role the parent's full global tool set. Passed
                // through unclipped: the preset-pinned compose seam sanitizes the filter
                // against the child's OWN view (global registry plus the mounted preset's
                // registrations) at application time — the parent's global-only view is
                // the wrong vantage point on planes whose tools are preset-mounted.
                ...(def.toolFilter !== undefined ? { toolFilter: def.toolFilter } : {}),
            };
            const res = await this.ctx.subagents.startContinuable({
                provider,
                label: `crew:${crew}:${role}`,
                request,
                signal,
            });
            const member = { crew, role, childId: res.childId, presetId: def.presetId, route };
            this.members.get(crew).set(role, member);
            out.push(member);
        }
        // initialize pipeline cursor to entry role (-1 so next is first)
        if (this.isPipeline(crew)) {
            const state = this.requirePipelineState(crew);
            state.order = this.pipelineOrder(crew);
        }
        return out;
    }
    /**
     * Hand work from one role to the next, as a followup turn. Returns the
     * accepted message id. Enforcement is scoping-only in `routed` mode; in
     * `pipeline` mode the `toRole` must be the deterministic next role unless
     * the verify-gate loops (handled via `pipelineAdvance` or the verifier
     * verdict helpers).
     */
    async handoff(crew, fromRole, toRole, task, parent, signal) {
        const c = this.requireCrew(crew);
        if (fromRole === toRole) {
            throw new Error(`crew "${crew}": cannot hand off "${fromRole}" to itself`);
        }
        const from = this.requireMember(crew, fromRole);
        const to = this.requireMember(crew, toRole);
        // Pipeline enforcement: toRole must be the deterministic successor.
        // The verify-gate loop is a deliberate exception: when the verifier fails,
        // it hands back to the predecessor, so allow that single backward edge.
        if (c.mode === 'pipeline') {
            const expected = this.nextInPipeline(crew, fromRole);
            const gate = c.pipeline.verifyGate;
            const isVerifierLoop = gate.enabled && fromRole === gate.verifierRole && toRole === this.previousInPipeline(crew, fromRole);
            if (toRole !== expected && !isVerifierLoop) {
                throw new Error(`crew "${crew}" pipeline violation: "${fromRole}" must hand to "${expected}" (got "${toRole}"); verifier may loop to "${this.previousInPipeline(crew, fromRole)}" on failure`);
            }
            // advance cursor
            const state = this.requirePipelineState(crew);
            if (state.blocked)
                throw new Error(`crew "${crew}" pipeline is blocked after exceeding maxRetries`);
            state.lastIndex = state.order.indexOf(toRole);
        }
        const targetDef = c.roles.find((r) => r.name === toRole);
        const prefix = [
            { type: 'text', text: `You are the "${toRole}" role of crew "${crew}". ${targetDef?.roleTask ?? ''}\n\nWork handed to you from "${fromRole}":` },
        ];
        const messageId = await deliverTurn(this.ctx, parent, to.childId, [...prefix, ...task], {
            source: { kind: 'coordinator', form: 'relay', senderSessionId: from.childId },
            signal,
        });
        return { crew, fromRole, toRole, childId: to.childId, messageId };
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
    async pipelineAdvance(crew, fromRole, task, parent, signal, options) {
        const c = this.requireCrew(crew);
        const state = this.requirePipelineState(crew);
        if (state.blocked)
            throw new Error(`crew "${crew}" pipeline is blocked after exceeding maxRetries`);
        const gate = c.pipeline.verifyGate;
        const isVerifier = fromRole === gate.verifierRole;
        let nextRole;
        let looped = false;
        let retries = 0;
        if (c.mode === 'pipeline' && gate.enabled && isVerifier) {
            const verdict = options?.verifierVerdict;
            if (verdict === 'fail') {
                const taskId = options?.taskId ?? '__default__';
                const cur = state.retries.get(taskId) ?? 0;
                const next = cur + 1;
                if (next > gate.maxRetries) {
                    state.blocked = true;
                    throw new Error(`crew "${crew}" verify-gate blocked after ${gate.maxRetries} failures for task "${taskId}"`);
                }
                state.retries.set(taskId, next);
                retries = next;
                looped = true;
                nextRole = this.previousInPipeline(crew, fromRole);
                // mark task failed so callers can filter
                if (options?.taskId !== undefined) {
                    const roleForTask = this.roleForTask(crew, options.taskId) ?? this.previousInPipeline(crew, fromRole);
                    if (roleForTask !== undefined) {
                        try {
                            this.updateTask(crew, roleForTask, options.taskId, { status: 'failed' });
                        }
                        catch {
                            // task may be crew-level; ignore
                        }
                    }
                }
            }
            else if (verdict === 'pass') {
                if (options?.taskId !== undefined) {
                    const roleForTask = this.roleForTask(crew, options.taskId);
                    if (roleForTask !== undefined) {
                        try {
                            this.updateTask(crew, roleForTask, options.taskId, { status: 'done' });
                        }
                        catch { }
                    }
                    state.retries.delete(options.taskId);
                }
                nextRole = this.nextInPipeline(crew, fromRole);
            }
            else {
                // No verdict supplied — treat as normal advance past verifier (pass)
                nextRole = this.nextInPipeline(crew, fromRole);
            }
        }
        else {
            nextRole = this.nextInPipeline(crew, fromRole);
        }
        if (nextRole === undefined)
            throw new Error(`crew "${crew}" has no successor for "${fromRole}"`);
        const handoffTask = looped && options?.evidence !== undefined
            ? [...task, { type: 'text', text: `\n\nVerifier failed: ${options.evidence}` }]
            : task;
        const h = await this.handoff(crew, fromRole, nextRole, handoffTask, parent, signal);
        // pipeline cursor is advanced inside handoff; also update for looped case
        if (looped) {
            // handoff already set lastIndex to nextRole; keep retries
        }
        return { ...h, gate: { looped, retries, blocked: state.blocked } };
    }
    /** Record a verifier's structured pass/fail for a task without delivering a turn. */
    recordVerification(crew, taskId, passed, evidence) {
        const c = this.requireCrew(crew);
        const gate = c.pipeline.verifyGate;
        const state = this.requirePipelineState(crew);
        if (state.blocked)
            throw new Error(`crew "${crew}" pipeline is blocked`);
        const roleForTask = this.roleForTask(crew, taskId);
        if (roleForTask !== undefined) {
            this.updateTask(crew, roleForTask, taskId, { status: passed ? 'done' : 'failed' });
        }
        if (!gate.enabled || c.mode !== 'pipeline') {
            return { looped: false, nextRole: this.nextInPipeline(crew, gate.verifierRole), retries: 0, blocked: false };
        }
        if (passed) {
            state.retries.delete(taskId);
            return { looped: false, nextRole: this.nextInPipeline(crew, gate.verifierRole), retries: 0, blocked: false };
        }
        const cur = state.retries.get(taskId) ?? 0;
        const next = cur + 1;
        if (next > gate.maxRetries) {
            state.blocked = true;
            return { looped: true, nextRole: this.previousInPipeline(crew, gate.verifierRole), retries: next, blocked: true };
        }
        state.retries.set(taskId, next);
        return { looped: true, nextRole: this.previousInPipeline(crew, gate.verifierRole), retries: next, blocked: false };
    }
    /** Find which role owns a task id, or undefined. */
    roleForTask(crew, taskId) {
        const c = this.requireCrew(crew);
        for (const r of c.roles) {
            const m = this.taskState.get(crew)?.get(r.name);
            if (m?.has(taskId))
                return r.name;
        }
        return undefined;
    }
    /** Read a member's live child handle (or undefined when not resident). */
    member(crew, role) {
        return this.members.get(crew)?.get(role);
    }
    requireCrew(crew) {
        const c = this.crews.get(crew);
        if (c === undefined)
            throw new Error(`unknown crew "${crew}"`);
        return c;
    }
    requirePipelineState(crew) {
        const s = this.pipelineState.get(crew);
        if (s === undefined)
            throw new Error(`crew "${crew}" has no pipeline state`);
        return s;
    }
    requireTaskMap(crew, role) {
        const crewMap = this.taskState.get(crew);
        if (crewMap === undefined)
            throw new Error(`unknown crew "${crew}"`);
        const roleMap = crewMap.get(role);
        if (roleMap === undefined)
            throw new Error(`crew "${crew}" has no role "${role}"`);
        return roleMap;
    }
    requireMember(crew, role) {
        const m = this.members.get(crew)?.get(role);
        if (m === undefined)
            throw new Error(`crew "${crew}" has no materialized role "${role}" (call materialize first)`);
        return m;
    }
}
/** Convert one config crew entry into the internal Crew shape (name = map key). */
function toCrew(name, entry) {
    return {
        name,
        orchestratorRole: entry.orchestratorRole,
        mode: entry.mode ?? 'routed',
        roles: entry.roles.map((r) => ({
            name: r.name,
            presetId: r.presetId,
            agentOptions: r.agentOptions,
            provider: r.provider,
            model: r.model,
            maxTokens: r.maxTokens,
            toolFilter: r.toolFilter,
            roleTask: r.roleTask,
            description: r.description,
            tasks: (r.tasks ?? []),
        })),
        pipeline: {
            order: entry.pipeline?.order ?? [],
            verifyGate: {
                enabled: entry.pipeline?.verifyGate?.enabled ?? true,
                verifierRole: entry.pipeline?.verifyGate?.verifierRole ?? 'verifier',
                maxRetries: entry.pipeline?.verifyGate?.maxRetries ?? 3,
            },
        },
    };
}
function buildTaskState(crew) {
    const out = new Map();
    for (const role of crew.roles) {
        const m = new Map();
        for (const t of role.tasks) {
            m.set(t.id, { ...t });
        }
        out.set(role.name, m);
    }
    return out;
}
function initPipelineState(crew) {
    return {
        order: crew.pipeline.order.length > 0 ? [...crew.pipeline.order] : crew.roles.map((r) => r.name),
        lastIndex: -1,
        retries: new Map(),
        blocked: false,
    };
}
/** Role name is its explicit stable name. */
function rolePrompt(def, crew, role) {
    const taskList = def.tasks.length > 0
        ? `\n\nYour structured tasks:\n${def.tasks.map((t) => `- ${t.id}: ${t.title} [${t.status}]${t.acceptanceCriteria ? ` (accept: ${t.acceptanceCriteria})` : ''}`).join('\n')}`
        : '';
    return [
        {
            type: 'text',
            text: `You are the "${role}" role of crew "${crew}". ${def.roleTask}${taskList}\n\nWork one turn at a time: complete your assigned task, report your result, then wait for the next task.`,
        },
    ];
}
