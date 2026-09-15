/**
 * Plugin-side preset AND route pinning — compose a delegated child under a NAMED
 * agent preset, on a NAMED model route, using only public harness API.
 *
 * WHY THIS EXISTS. Pinning a child to a named preset and route instead of
 * joining its parent's composition was previously a HARNESS capability: a
 * provider's only lever over a continuable child's composition was data in
 * `ContinuableCreateSpec`, and that spec carries `{ seed? }` only — deliberately,
 * because "the continuation manager owns the child's whole lifecycle after
 * preparation". Reaching the composition therefore required a local harness
 * patch (a `presetId` field plus a mount path in the continuation manager),
 * which meant this plugin could not be used against an unpatched harness.
 *
 * The capability is reachable from a plugin after all, through three public
 * seams:
 *
 *  - `agentPresets.recompose(agentCtx, presetId)` re-links a composed agent to
 *    another preset's standing mount *through the binding the roster itself
 *    kept*, so it works on a child that already joined its parent — which is
 *    exactly the continuable child. It RE-LINKS rather than adds, so the pinned
 *    composition replaces the inherited one instead of piling on top of it (the
 *    additive-composition defect that makes a preset join non-isolating).
 *  - `agent/request` is an awaited waterfall that REPLACES the frozen call
 *    configuration, and it runs before `request/header` is logged. It is the
 *    only supported per-step rewrite of provider/model/maxTokens, so it is where
 *    a pinned ROUTE is enforced. `prepareContinuable()`'s returned
 *    `agentOptions` is silently discarded by an unpatched harness, which is why
 *    a continuable child otherwise inherits the PARENT's model.
 *  - `agent/session-start` fires "once before the first turn" with the child's
 *    `Agent` in hand, and `agent/pre-step` is an awaited waterfall, so the
 *    re-link can be attempted before the child's first request is assembled.
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
 *  - the child's `subagent/descriptor` likewise records the route the harness
 *    resolved at creation (the parent's), because the provider's detached spec
 *    is discarded on an unpatched harness. The pinned route is therefore
 *    re-derived from this plugin's live config on every activation rather than
 *    read back from the descriptor.
 *  - the FIRST request of a continuable child is assembled before any hook this
 *    plugin owns can run, so it may still use the parent's composition and
 *    route; the pin lands before the next request and forces a new request
 *    series. `warnLatePin` reports when that happened instead of allowing a
 *    silent half-pinned child.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type RouteOverrides } from './route.js';
import type { Config } from './config.js';
/**
 * Structural tool filter. Spelled out locally rather than imported so this
 * module compiles against every harness generation that has the field, and so
 * nothing here depends on a type that may move.
 */
export interface PinFilter {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}
/** One resolved pin: the preset a child is composed under, its filter, and its route. */
export interface Pin {
    readonly presetId: string;
    readonly toolFilter?: PinFilter;
    /** Model route forced on every request this child makes. */
    readonly route: RouteOverrides;
}
/** Dependencies the resolver reads; injected so tests need no live harness. */
export interface PinDeps {
    /** This provider's registry name — how a descriptor is recognized as ours. */
    readonly providerName: string;
    /** Live resolved plugin config (settings layer over the composition base). */
    readonly readConfig: () => Pick<Config, 'presetId' | 'crews'>;
    /** The route this provider pins: request-level override wins per field. */
    readonly route: () => RouteOverrides;
    /** Optional diagnostics sink. */
    readonly warn?: (message: string) => void;
}
/** Record the pin for one child session id. */
export declare function recordPin(sessionId: string, pin: Pin): void;
/** Drop a recorded pin once it has been applied (or the child is gone). */
export declare function forgetPin(sessionId: string): void;
/** Read a recorded pin without consuming it. */
export declare function recordedPin(sessionId: string): Pin | undefined;
/**
 * The pin already applied to one live activation, for the `agent/request`
 * listener that enforces the route. `undefined` for an agent this plugin did
 * not pin, which keeps the waterfall inert for the root session and for every
 * other provider's children.
 * @param agent - the agent about to make a model call.
 * @returns its applied pin, or undefined.
 */
export declare function appliedPin(agent: Agent): Pin | undefined;
/** Test seam: forget every recorded pin. */
export declare function clearPins(): void;
/**
 * Resolve the pin for one live agent: the recorded pin first, the child's own
 * durable descriptor second, nothing at all when the child is not ours.
 * @param agent - the child agent.
 * @param depsList - one entry per provider instance this plugin registered.
 * @returns the pin, or `undefined` when unowned.
 */
export declare function resolvePin(agent: Agent, depsList: readonly PinDeps[]): Pin | undefined;
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
export declare function applyChildToolFilter(childCtx: Context, filter: PinFilter): void;
/**
 * Re-link one composed child to its pinned preset and apply its filter.
 * @param childCtx - the child's scoped creation context.
 * @param pin - the resolved pin.
 * @throws when the deployment composes no preset roster.
 */
export declare function rePin(childCtx: Context, pin: Pin): Promise<void>;
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
export declare function composePinnedChild(childCtx: Context, parent: Agent, pin: Pin, persona: string | undefined): Promise<void>;
/**
 * Install the pin-enforcement listeners for every provider instance this plugin
 * registered.
 *
 * Three listeners, one guard:
 *  - `agent/session-start` is the earliest point the child's `Agent` exists
 *    ("once before the first turn") and handles the ordinary case;
 *  - `agent/pre-step` is an AWAITED waterfall, so it is the preset guarantee —
 *    the re-link has completed before the step that assembles the next request
 *    proceeds;
 *  - `agent/request` is an AWAITED waterfall that replaces the call config, and
 *    it is the ROUTE guarantee: it runs before `request/header` is logged, so
 *    the pinned provider/model is both what the call uses and what the log
 *    records. This is the only reason a continuable child follows the plugin's
 *    route at all, since the provider's detached `agentOptions` is discarded by
 *    an unpatched harness.
 *
 * A pin is applied once per live activation and re-applied on every new one; the
 * resolver returns nothing for agents this plugin did not establish, so the
 * listeners are inert for the root session and for other providers' children.
 * @param ctx - the plugin's context (unscoped: it must observe every agent).
 * @param depsList - one entry per registered provider instance.
 * @returns a disposer that removes every listener.
 */
export declare function installPinning(ctx: Context, depsList: readonly PinDeps[]): () => void;
