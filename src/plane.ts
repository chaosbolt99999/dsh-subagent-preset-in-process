/**
 * Cross-plane tool-filter sanitization.
 *
 * The plugin's role filters and the `tool-subagent-preset` row filter are
 * authored for the HEADLESS plane (they include `todo_write` / `get_goal`,
 * which dsh-base registers globally there). The web plane's global registry
 * has a different set — it has no `todo_write` (and no `get_goal`) — and
 * `tools.restrict()` fails loud on unknown names. Clipping every filter at
 * delegation time against the restrictable global names of the plane the
 * child is being composed on keeps ONE filter authoring valid across planes
 * instead of maintaining per-plane filter lists.
 *
 * `tools.restrict()` itself stays fail-loud: every filter that reaches it has
 * already been verified against this plane's registry, and the harness tests
 * that pin the fail-loud unknown-name contract keep passing.
 */

import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/**
 * Clip one tool filter against the restrictable global names of the plane it
 * will be applied on. `undefined` stays `undefined`; arrays keep only names
 * the plane knows. An allowlist that clips to EMPTY means the filter was
 * authored for a different plane entirely and would deny every global tool —
 * that is a material misconfiguration, so it throws rather than silently
 * narrowing the child to scoped-only tools.
 *
 * Names dropped here cannot exist in the child's inherited view anyway, so
 * clipping never widens the child's surface relative to the authored filter;
 * it only prevents a cross-plane authoring from killing the delegation.
 */
export function clipToolFilter(
  filter: ToolRestriction,
  known: ReadonlySet<string>,
): ToolRestriction {
  const clip = (names: readonly string[] | undefined): readonly string[] | undefined =>
    names === undefined ? undefined : names.filter(name => known.has(name))
  const allow = clip(filter.allow)
  const deny = clip(filter.deny)
  if (allow !== undefined && allow.length === 0) {
    throw new Error(
      'tool filter allows no tool known to this deployment;'
      + ' it was authored for a different plane (e.g. web vs headless tool names)',
    )
  }
  if (allow === undefined && deny === undefined) return filter
  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
  }
}

/** Structural shape the clip needs from a parent agent's context. */
interface ToolsView {
  readonly tools?: { readonly restrictableNames?: () => ReadonlySet<string> } | undefined
}

/**
 * Clip when the parent context exposes a tools registry; pass the filter
 * through unchanged otherwise (test fakes, embedded hosts). The preset-pinned
 * compose path sanitizes authoritatively at application time, so a filter
 * that reaches `tools.restrict()` unclipped here still cannot name an
 * unknown tool.
 */
export function clipToolFilterIfKnown(
  filter: ToolRestriction,
  parentCtx: unknown,
): ToolRestriction {
  const known = (parentCtx as ToolsView | undefined)?.tools?.restrictableNames?.()
  return known === undefined ? filter : clipToolFilter(filter, known)
}
