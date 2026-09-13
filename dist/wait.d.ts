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
export interface SettlementResult {
    readonly childId: string;
    readonly stopReason: string;
    readonly output: unknown[];
}
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
export declare function waitForSettlement(ctx: any, childId: string, signal: AbortSignal, opts?: {
    timeoutMs?: number;
}): Promise<SettlementResult>;
