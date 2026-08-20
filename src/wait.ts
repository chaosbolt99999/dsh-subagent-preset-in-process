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
  readonly childId: string
  readonly stopReason: string
  readonly output: unknown[]
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
 * @param ctx - the plugin's host context (`ctx.agents`, `ctx.on`).
 * @param childId - the durable continuable child session id.
 * @param signal - the calling tool's cancellation signal.
 */
export function waitForSettlement(ctx: any, childId: string, signal: AbortSignal): Promise<SettlementResult> {
  return new Promise<SettlementResult>((resolve) => {
    let done = false
    let off: () => void = () => {}

    const cleanup = () => {
      off()
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (info?: { stopReason?: string; lastAssistantMessage?: unknown[] }) => {
      if (done) return
      done = true
      cleanup()
      resolve({
        childId,
        stopReason: info?.stopReason ?? 'completed',
        output: info?.lastAssistantMessage ?? [],
      })
    }
    const onEnd = (info: any) => {
      if (info && info.id === childId) finish(info)
    }
    const onAbort = () => finish({ stopReason: 'aborted' })

    if (typeof ctx.on === 'function') {
      try {
        off = ctx.on('subagent/end', onEnd)
      } catch {
        off = () => {}
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      finish({ stopReason: 'aborted' })
      return
    }

    const child = ctx.agents?.get(childId)
    if (child === undefined) {
      // Not live: already settled (or this id is not a live child).
      finish({ stopReason: 'completed' })
      return
    }
    if (child.status !== 'running') {
      // No active turn right now (waiting/idle): nothing to wait for.
      finish({ stopReason: 'completed' })
      return
    }

    // Running: wait for the turn to finish, then wait for the Activation to be
    // disposed. The `subagent/end` edge above finishes the call with the exact
    // stopReason; polling liveness is the fallback that still terminates even
    // when that scoped edge is not delivered to this context.
    child.whenIdle().then(
      () => {
        const poll = () => {
          if (done) return
          if (ctx.agents?.get(childId) === undefined) {
            // Disposed: the settlement notice has been delivered (it precedes
            // the end edge). Give the edge one short grace to land its exact
            // stopReason before the neutral fallback.
            setTimeout(() => finish({ stopReason: 'completed' }), 120)
            return
          }
          setTimeout(poll, 40)
        }
        poll()
      },
      () => finish({ stopReason: 'aborted' }),
    )
  })
}
