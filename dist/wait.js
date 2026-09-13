/**
 * Settlement wait for continuable subagents.
 *
 * Continuable children settle out-of-band: the continuation manager disposes
 * their Activation, delivers a `subagent-settled` notice to the parent's inbox,
 * and emits the scoped `subagent/end` lifecycle edge. A parent that wants to
 * wait for that settlement currently has no better tool than `bash sleep N` +
 * `list_agents` polling — which is both wasteful and unboundedly fragile as
 * tasks grow. This helper turns "wait until this child is done" into one
 * blocked tool call that wakes the moment the child settles.
 */
/**
 * Resolve when the continuable child named by `childId` has no active turn and
 * its Activation has settled (or was already settled). Blocks the calling
 * tool's turn for as long as the child runs — bounded only by `signal` — and
 * returns the child's stop reason and closing output.
 *
 * The `subagent/end` lifecycle edge is the authoritative wake: it fires after
 * the settlement notice is delivered and carries the exact `stopReason` + final
 * output. That edge is scoped to the delegating parent, so it may not reach
 * this (untagged) context; the live-agent registry is the safety net that still
 * terminates the call — the authoritative output then reaches the parent
 * through the ordinary `subagent-settled` inbox notice.
 *
 * The pre-`running` window is handled explicitly: `Agent.status` stays `idle`
 * between a `followup()` and the first turn start, so a child that was JUST
 * handed work reports `idle` here. Treating that as "settled" fabricates a
 * `completed` before the turn ever ran. Instead the liveness read is retried
 * after a macrotask boundary: an accepted turn flips the agent to `running` by
 * then (and keeps it registered), while a truly settled Activation is disposed
 * and gone from the registry. `crew_wait` additionally arms the listener and
 * takes its first liveness read BEFORE the handoff is delivered, so the race
 * window it guards cannot open in the first place.
 *
 * @param ctx - the plugin's host context (`ctx.agents`, `ctx.on`).
 * @param childId - the durable continuable child session id.
 * @param signal - the calling tool's cancellation signal.
 * @param opts - `timeoutMs` bounds the whole wait (0/undefined = unbounded).
 */
export function waitForSettlement(ctx, childId, signal, opts) {
    return new Promise((resolve) => {
        let done = false;
        let off = () => { };
        const cleanup = () => {
            off();
            signal.removeEventListener('abort', onAbort);
            if (timer !== undefined)
                clearTimeout(timer);
        };
        const finish = (info) => {
            if (done)
                return;
            done = true;
            cleanup();
            resolve({
                childId,
                stopReason: info?.stopReason ?? 'completed',
                output: info?.lastAssistantMessage ?? [],
            });
        };
        const onEnd = (info) => {
            if (info && info.id === childId)
                finish(info);
        };
        const onAbort = () => finish({ stopReason: 'aborted' });
        if (typeof ctx.on === 'function') {
            try {
                off = ctx.on('subagent/end', onEnd);
            }
            catch {
                off = () => { };
            }
        }
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            finish({ stopReason: 'aborted' });
            return;
        }
        let timer;
        if (opts?.timeoutMs !== undefined && opts.timeoutMs > 0) {
            timer = setTimeout(() => finish({ stopReason: 'timeout' }), opts.timeoutMs);
        }
        // One liveness probe: returns 'running' | 'quiescent' | 'gone'.
        const probe = () => {
            const child = ctx.agents?.get(childId);
            if (child === undefined)
                return 'gone';
            return child.status === 'running' ? 'running' : 'quiescent';
        };
        /** Turn active: await it, then await Activation disposal (poll). */
        const awaitTurn = (child) => {
            child.whenIdle().then(() => {
                const poll = () => {
                    if (done)
                        return;
                    if (ctx.agents?.get(childId) === undefined) {
                        // Disposed: the settlement notice has been delivered (it precedes
                        // the end edge). Give the edge one short grace to land its exact
                        // stopReason before the neutral fallback.
                        setTimeout(() => finish({ stopReason: 'completed' }), 120);
                        return;
                    }
                    setTimeout(poll, 40);
                };
                poll();
            }, () => finish({ stopReason: 'aborted' }));
        };
        // `idle` is ambiguous (see the module comment): re-read after a macrotask
        // boundary before concluding the child is settled. An accepted-but-unstarted
        // turn flips to `running` by then; a settled Activation is gone.
        const awaitQuiescenceConfirmation = () => {
            setTimeout(() => {
                if (done)
                    return;
                const state = probe();
                if (state === 'running') {
                    awaitTurn(ctx.agents.get(childId));
                    return;
                }
                finish({ stopReason: 'completed' });
            }, 0);
        };
        const initial = probe();
        if (initial === 'gone') {
            // Not live: already settled (or this id was never a live child). No
            // turn can start anymore, so `completed` cannot be a fabrication.
            finish({ stopReason: 'completed' });
            return;
        }
        if (initial === 'running') {
            awaitTurn(ctx.agents.get(childId));
            return;
        }
        awaitQuiescenceConfirmation();
    });
}
