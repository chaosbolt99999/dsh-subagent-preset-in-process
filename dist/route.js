/**
 * Child model-route resolution.
 *
 * A delegation's route has exactly three sources, in descending precedence:
 *
 * 1. **Request-level override** — the `agentOptions` on a `tool-subagent` row,
 *    or a crew role's `agentOptions` (its legacy flat `provider`/`model`/
 *    `maxTokens` fields are aliases of it).
 * 2. **Plugin settings** — the resolved `subagent-preset-in-process` config
 *    (`provider`/`model`/`maxTokens`), live-editable in Settings → Plugins.
 * 3. **Parent inheritance** — any field neither source defines falls through to
 *    the parent's route inside `resolveChildAgentOptions`.
 *
 * Every path that builds a child route (the one-shot provider, the detached
 * continuable default, crew materialization) goes through {@link resolveRoute},
 * so the precedence cannot drift between them — it did: the one-shot path used
 * to write the plugin's route *over* the request's, silently discarding a
 * row-level or per-request override.
 *
 * @module route
 */
/**
 * Resolve one child's route from a request-level override and the plugin's
 * resolved settings, field by field.
 *
 * Fields that NEITHER source defines are omitted from the result rather than
 * set to `undefined`: the result is spread over the parent's route by
 * `resolveChildAgentOptions`, and an explicit `undefined` key would overwrite
 * the inherited value instead of falling through to it.
 *
 * @param request - the caller's override (tool row / crew role / direct call).
 * @param config - the plugin's resolved settings for this delegation.
 * @returns the effective partial route, request fields winning per field.
 */
export function resolveRoute(request, config) {
    const effective = {};
    const provider = request?.provider ?? config.provider;
    const model = request?.model ?? config.model;
    const maxTokens = request?.maxTokens ?? config.maxTokens;
    if (provider !== undefined)
        effective.provider = provider;
    if (model !== undefined)
        effective.model = model;
    if (maxTokens !== undefined)
        effective.maxTokens = maxTokens;
    return effective;
}
/**
 * Flatten a crew role's route override: the canonical `agentOptions` object
 * wins per field, with the legacy flat `provider`/`model`/`maxTokens` fields as
 * the per-field fallback (so a role that only ever set `model: x` keeps
 * working, and a role that migrates one field at a time is not silently split).
 *
 * Undefined fields are omitted, so {@link resolveRoute} can fall through to the
 * plugin settings for them.
 *
 * @param role - a crew role definition (structural: any object with those keys).
 * @returns the role's request-level route override.
 */
export function roleRouteOverrides(role) {
    const nested = role.agentOptions;
    return omitUndefined({
        provider: nested?.provider ?? role.provider,
        model: nested?.model ?? role.model,
        maxTokens: nested?.maxTokens ?? role.maxTokens,
    });
}
/**
 * The effective delegation-depth cap for one child: the tighter of the
 * request's cap (a `tool-subagent` row always sends its own, default 3) and the
 * plugin's `maxDepth` setting. `'provider-managed'` on either side means "no
 * cap from this source", so the other side still applies — neither knob can be
 * silently discarded, and neither can widen the other.
 *
 * @param requestMax - the request's numeric cap, when it carries one.
 * @param configMax - the plugin's configured cap or `'provider-managed'`.
 * @returns the numeric cap to enforce, or `undefined` for provider-managed.
 */
export function effectiveMaxDepth(requestMax, configMax) {
    const configured = typeof configMax === 'number' ? configMax : undefined;
    if (requestMax === undefined)
        return configured;
    if (configured === undefined)
        return requestMax;
    return Math.min(requestMax, configured);
}
/** Drop undefined-valued keys so a spread cannot shadow an inherited field. */
function omitUndefined(input) {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
