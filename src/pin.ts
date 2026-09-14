/**
 * Plugin-side preset pinning — compose a delegated child under a NAMED agent
 * preset using only public harness API.
 *
 * WHY THIS EXISTS. Pinning a child to a named preset instead of joining its
 * parent's composition was previously a HARNESS capability: a provider's only
 * lever over a continuable child's composition was data in
 * `ContinuableCreateSpec`, and that spec carries `{ seed? }` only — deliberately,
 * because "the continuation manager owns the child's whole lifecycle after
 * preparation". Reaching the composition therefore required a local harness
 * patch (a `presetId` field plus a mount path in the continuation manager),
 * which meant this plugin could not be used against an unpatched harness.
 *
 * The capability is reachable from a plugin after all, through two public seams:
 *
 *  - `agentPresets.recompose(agentCtx, presetId)` re-links a composed agent to
 *    another preset's standing mount *through the binding the roster itself
 *    kept*, so it works on a child that already joined its parent — which is
 *    exactly the continuable child. It RE-LINKS rather than adds, so the pinned
 *    composition replaces the inherited one instead of piling on top of it (the
 *    additive-composition defect that makes a preset join non-isolating).
 *  - `agent/session-start` fires "once before the first turn" with the child's
 *    `Agent` in hand, and `agent/pre-step` is an awaited waterfall, so the
 *    re-link can be guaranteed before the child's first request is assembled.
 *
 * THE FILTER IS APPLIED HERE, after the re-link, for two reasons. A tool filter
 * is a global-tool mask validated against the viewing scope's names, so a list
 * authored for one plane fails loud on another; and it must be validated
 * against the scope the child ENDS UP on — the pinned composition — not the
 * parent's. Applying it after `recompose()` gives both: the vantage is the
 * child's real post-re-link view, and nothing is handed to the harness's
 * fail-loud validation to reject.
 *
 * HONEST LIMITS (see README, "The pinned composition"):
 *  - the child's durable header records the preset the harness composed at
 *    creation (the parent's), because the header is written before the re-link.
 *    Composition and resume are unaffected; the recorded label is.
 *  - between creation and the re-link the child exists on the parent's
 *    composition. No turn runs in that window.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyChildComposition } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { Config } from './config.js'

/**
 * Structural tool filter. Spelled out locally rather than imported so this
 * module compiles against every harness generation that has the field, and so
 * nothing here depends on a type that may move.
 */
export interface PinFilter {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** One resolved pin: the preset a child is composed under, plus its filter. */
export interface Pin {
  readonly presetId: string
  readonly toolFilter?: PinFilter
}

/** Dependencies the resolver reads; injected so tests need no live harness. */
export interface PinDeps {
  /** This provider's registry name — how a descriptor is recognized as ours. */
  readonly providerName: string
  /** Live resolved plugin config (settings layer over the composition base). */
  readonly readConfig: () => Pick<Config, 'presetId' | 'crews'>
  /** Optional diagnostics sink. */
  readonly warn?: (message: string) => void
}

/**
 * Pins recorded for children whose creation this plugin drives, keyed by the
 * child's session id. The provider records the pin in `prepareContinuable()`,
 * which the continuation manager calls with the child's reserved session id
 * before the child exists — the one moment a provider learns that id.
 */
const PINS = new Map<string, Pin>()

/** Record the pin for one child session id. */
export function recordPin(sessionId: string, pin: Pin): void {
  PINS.set(sessionId, pin)
}

/** Drop a recorded pin once it has been applied (or the child is gone). */
export function forgetPin(sessionId: string): void {
  PINS.delete(sessionId)
}

/** Read a recorded pin without consuming it. */
export function recordedPin(sessionId: string): Pin | undefined {
  return PINS.get(sessionId)
}

/** Test seam: forget every recorded pin. */
export function clearPins(): void {
  PINS.clear()
}

/**
 * Derive a pin from a child's own durable descriptor.
 *
 * This is what makes the pin survive a cold resume: the in-memory map dies with
 * the process, but every child this provider established carries a
 * `subagent/descriptor` event naming the provider and the creation label, and
 * the label of a crew member names its crew and role (`crew:<crew>:<role>`).
 * A descriptor that is not ours yields no pin — the resolver must never pin a
 * child some other provider is responsible for.
 * @param events - the child session's event log, read for leaf fields only.
 * @param deps - provider name and live config.
 * @returns the pin, or `undefined` when this child is not one of ours.
 */
function pinFromDescriptor(
  events: readonly { type: string; data?: unknown }[],
  deps: PinDeps,
): Pin | undefined {
  for (const event of events) {
    if (event.type !== 'subagent/descriptor') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const record = data as { provider?: unknown; label?: unknown }
    if (record.provider !== deps.providerName) continue
    const config = deps.readConfig()
    const label = typeof record.label === 'string' ? record.label : ''
    const parts = /^crew:([^:]+):([^:]+)$/.exec(label)
    if (parts !== null) {
      const crew = config.crews?.[parts[1] as keyof typeof config.crews]
      const role = crew?.roles.find(candidate => candidate.name === parts[2])
      if (role !== undefined) {
        return {
          presetId: role.presetId ?? config.presetId,
          ...role.toolFilter !== undefined ? { toolFilter: role.toolFilter } : {},
        }
      }
    }
    return { presetId: config.presetId }
  }
  return undefined
}

/**
 * Resolve the pin for one live agent: the recorded pin first, the child's own
 * durable descriptor second, nothing at all when the child is not ours.
 * @param agent - the child agent.
 * @param deps - provider name and live config.
 * @returns the pin, or `undefined` when unowned.
 */
export function resolvePin(agent: Agent, deps: PinDeps): Pin | undefined {
  const id = String(agent.id)
  const recorded = PINS.get(id)
  if (recorded !== undefined) return recorded
  // Read the log through the CURRENT accessor. `session.events` no longer
  // exists; reading it returned `undefined`, which made this fallback silently
  // resolve nothing — a crew member kept the parent's full tool surface with no
  // error anywhere, which is the worst possible failure for an isolation
  // feature. The cast covers the stale vendored `.d.ts`.
  const session = agent.session as unknown as {
    snapshotEvents: (from?: number) => readonly { type: string; data?: unknown }[]
  }
  const events = session?.snapshotEvents?.(0)
  if (events === undefined) return undefined
  return pinFromDescriptor(events, deps)
}

/**
 * Whether this child's scope can name one tool in a filter.
 *
 * The harness validates a restriction against the viewing scope's pre-restriction
 * names and fails loud on an unknown one. There is no public accessor for that
 * set on every harness generation, so this asks the registry directly with a
 * one-name restriction and lifts it again immediately: the answer is exact, the
 * probe leaves no trace, and no error message is parsed.
 * @param childCtx - the child's scoped context.
 * @param name - the tool name to test.
 * @returns whether `tools.restrict()` would accept the name for this scope.
 */
function scopeAdmits(childCtx: Context, name: string): boolean {
  const tools = childCtx.get('tools')
  if (tools === undefined) return false
  let undo: (() => void) | undefined
  try {
    undo = tools.restrict({ allow: [name] })
  } catch {
    return false
  }
  try {
    undo?.()
  } catch {
    // The probe restriction is already gone; a failed lift is not the caller's.
  }
  return true
}

/**
 * Apply one child's tool filter, clipped to the names its scope can restrict.
 *
 * An allowlist that clips to nothing is a material misconfiguration (a list
 * authored for a different plane) and stays loud — the pinned child would
 * otherwise silently lose its whole tool set, which is strictly worse than a
 * failed delegation.
 * @param childCtx - the child's scoped context, after its composition is final.
 * @param filter - the authored filter.
 * @throws when an allowlist names no tool this child's scope knows.
 */
export function applyChildToolFilter(childCtx: Context, filter: PinFilter): void {
  const tools = childCtx.get('tools')
  if (tools === undefined) return
  const clip = (names: readonly string[] | undefined): string[] | undefined =>
    names === undefined ? undefined : names.filter(name => scopeAdmits(childCtx, name))
  const allow = clip(filter.allow)
  const deny = clip(filter.deny)
  if (allow !== undefined && allow.length === 0) {
    throw new Error(
      'pinned child toolFilter allows no tool known to this composition;'
      + ' the filter was authored for a different plane (e.g. web vs headless tool names)'
      + ' or for a preset that does not provide those tools',
    )
  }
  if (allow === undefined && deny === undefined) return
  tools.restrict({
    ...allow !== undefined ? { allow } : {},
    ...deny !== undefined ? { deny } : {},
  })
}

/**
 * Re-link one composed child to its pinned preset and apply its filter.
 * @param childCtx - the child's scoped creation context.
 * @param pin - the resolved pin.
 * @throws when the deployment composes no preset roster.
 */
export async function rePin(childCtx: Context, pin: Pin): Promise<void> {
  const presets = childCtx.get('agentPresets') as AgentPresets | undefined
  if (presets === undefined) {
    throw new Error('pinned child composition requires the agent-presets roster')
  }
  // Idempotent: a child composed straight onto the pinned preset (a harness
  // that pins at creation) is left exactly as it is.
  if (presets.composedPreset(childCtx) !== pin.presetId) {
    await presets.recompose(childCtx, pin.presetId)
  }
  if (pin.toolFilter !== undefined) applyChildToolFilter(childCtx, pin.toolFilter)
}

/**
 * Compose a one-shot child under a pinned preset.
 *
 * The parent join comes first ON PURPOSE: it is what carries the harness's own
 * delegation-context statement and per-child persona, whose text lives in
 * `@deepseek-ai/dsh-subagent` but is not re-exported — so calling the harness is
 * how this stays drift-free instead of copying a prompt fragment. `rePin()`
 * then replaces the joined composition before any turn runs, so the child's
 * effective preset is the pinned one and no prompt section from the parent's
 * composition survives the swap.
 * @param childCtx - the child's scoped creation context.
 * @param parent - the delegating parent.
 * @param pin - the resolved pin.
 * @param persona - per-child persona that shadows the deployment persona.
 */
export async function composePinnedChild(
  childCtx: Context,
  parent: Agent,
  pin: Pin,
  persona: string | undefined,
): Promise<void> {
  applyChildComposition(childCtx, parent, persona === undefined ? {} : { persona })
  await rePin(childCtx, pin)
}

/**
 * Install the pin-enforcement listeners.
 *
 * Two events, one guard. `agent/session-start` is the earliest point the child's
 * `Agent` exists ("once before the first turn") and handles the ordinary case
 * before anything reads the child's catalog; `agent/pre-step` is an AWAITED
 * waterfall, so it is the guarantee — the re-link has completed before the step
 * that assembles the request proceeds. A pin is applied once per agent; the
 * resolver returns nothing for agents this provider did not establish, so the
 * listeners are inert for the root session and for other providers' children.
 * @param ctx - the plugin's context (unscoped: it must observe every agent).
 * @param deps - provider name and live config.
 * @returns a disposer that removes both listeners.
 */
export function installPinning(ctx: Context, deps: PinDeps): () => void {
  const settled = new Set<string>()
  const warn = deps.warn ?? ((message: string) => { ctx.logger?.warn?.(message) })

  const ensure = async (agent: Agent): Promise<void> => {
    const id = String(agent.id)
    if (settled.has(id)) return
    const pin = resolvePin(agent, deps)
    if (pin === undefined) return
    try {
      await rePin(agent.ctx, pin)
      settled.add(id)
      forgetPin(id)
    } catch (error) {
      // A pinned child that silently ran on its parent's composition would look
      // like a model-behaviour bug; say so instead, once per child.
      settled.add(id)
      warn(`subagent-preset: could not pin child ${id} to preset "${pin.presetId}": `
        + String(error instanceof Error ? error.message : error))
    }
  }

  const offStart = ctx.on('agent/session-start', (payload) => {
    const agent = (payload as { agent?: Agent }).agent
    if (agent === undefined) return
    // Best effort and deliberately not awaited: an emit listener must not stall
    // the session lifecycle. `agent/pre-step` below is the enforcement point.
    void ensure(agent)
  })

  const offStep = ctx.on('agent/pre-step', async (payload, next) => {
    const agent = (payload as { agent?: Agent }).agent
    if (agent !== undefined) await ensure(agent)
    return next()
  })

  return () => {
    offStart()
    offStep()
    settled.clear()
  }
}
