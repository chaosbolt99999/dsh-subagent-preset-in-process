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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
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
/** One resolved pin: the preset a child is composed under, plus its filter. */
export interface Pin {
    readonly presetId: string;
    readonly toolFilter?: PinFilter;
}
/** Dependencies the resolver reads; injected so tests need no live harness. */
export interface PinDeps {
    /** This provider's registry name — how a descriptor is recognized as ours. */
    readonly providerName: string;
    /** Live resolved plugin config (settings layer over the composition base). */
    readonly readConfig: () => Pick<Config, 'presetId' | 'crews'>;
    /** Optional diagnostics sink. */
    readonly warn?: (message: string) => void;
}
/** Record the pin for one child session id. */
export declare function recordPin(sessionId: string, pin: Pin): void;
/** Drop a recorded pin once it has been applied (or the child is gone). */
export declare function forgetPin(sessionId: string): void;
/** Read a recorded pin without consuming it. */
export declare function recordedPin(sessionId: string): Pin | undefined;
/** Test seam: forget every recorded pin. */
export declare function clearPins(): void;
/**
 * Resolve the pin for one live agent: the recorded pin first, the child's own
 * durable descriptor second, nothing at all when the child is not ours.
 * @param agent - the child agent.
 * @param deps - provider name and live config.
 * @returns the pin, or `undefined` when unowned.
 */
export declare function resolvePin(agent: Agent, deps: PinDeps): Pin | undefined;
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
export declare function installPinning(ctx: Context, deps: PinDeps): () => void;
