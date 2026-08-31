# Shared runtime patch: continuable preset pinning

The plugin's **one-shot** path (`PresetInProcessProvider.start()`) already mounts
`config.presetId` for every child. But **continuable** children (crew members and
`backgroundMode: continuable` via `tool-subagent`) are composed by the subagent
continuation manager, not by the provider — and that manager hardcodes parent
inheritance (`composeFrom`). This is why, in the session logs, every crew member
recorded `agentPreset: "standard"` and carried the full `standard` toolset even
though it was configured for `subagent-slim`.

A provider cannot express this through the public seam (`prepareContinuable`
returns only a `seed`; `registerContinuableSetup` contributions are synchronous
while `AgentPresets.mount` is async). So the fix is a small, additive change to
`@deepseek-ai/dsh-subagent` that threads an optional `presetId` through the
continuable path.

## Change (monorepo: `packages/subagent/subagent/src/`)

1. `types.ts` — add `presetId?: string` to `SubagentStartRequest` and to
   `ContinuableCreateSpec`.

2. `continuation.ts` / `SubagentRuntime.startContinuable` — derive the pinned
   preset from the request (role-level) or the provider's `prepareContinuable`
   result, record it on the child's durable header, and pass it in the
   composition:

   ```ts
   const presetId = request.presetId ?? prepared.presetId
   // meta:
   meta: presetId !== undefined
     ? { ...childSessionMeta(parent, childDepth, lineageSeedLength), agentPreset: presetId }
     : childSessionMeta(parent, childDepth, lineageSeedLength)
   // composition:
   composition: { persona: request.persona, toolFilter: request.toolFilter, ...presetId !== undefined ? { presetId } : {} }
   ```

3. `continuation.ts` / `coldResume` — reconstruct the pinned preset from the
   durable header (it differs from the parent's composed preset only when the
   child was pinned):

   ```ts
   const parentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
   const pinnedPreset = loaded.meta.agentPreset !== undefined && loaded.meta.agentPreset !== parentPreset
     ? loaded.meta.agentPreset
     : undefined
   // composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter, ...pinnedPreset !== undefined ? { presetId: pinnedPreset } : {} }
   ```

4. `continuation.ts` / `materializeTracked` — make the child `setup` async and
   branch on the preset:

   ```ts
   const setup = async (childCtx) => {
     if (create !== undefined) appendDelegatedPolicyOverrides(childCtx.agent.session, create.delegatedPolicies)
     if (inputs.composition.presetId !== undefined) {
       await applyPresetChildComposition(childCtx, inputs.composition.presetId, inputs.composition)
     } else {
       applyChildComposition(childCtx, parent, inputs.composition)
     }
     return this.setupRegistry.apply(childCtx)
   }
   ```

5. `child-agent.ts` — add `applyPresetChildComposition`, the async counterpart
   of `applyChildComposition` that `await`s `agentPresets.mount(childCtx, presetId)`

6. `types.ts` + `continuation.ts` / `startContinuable` (added 2026-08-26,
   settings-following route) — `ContinuableCreateSpec.agentOptions?: AgentOptions`
   carries the provider's detached ROUTE DEFAULT. The manager merges it UNDER
   the request's own options (caller wins), resolves as usual, and snapshots
   the EFFECTIVE route into the descriptor so cold resume reuses it:

   ```ts
   const requestedAgentOptions = prepared.agentOptions !== undefined
     ? { ...prepared.agentOptions, ...request.agentOptions }
     : request.agentOptions
   // descriptor agentProvider/agentModel read from requestedAgentOptions
   agentOptions: resolveChildAgentOptions(parent, requestedAgentOptions, childDepth)
   ```

   Precedence: request (role/tool-level override) > provider default (live
   settings) > parent inheritance. The plugin's `prepareContinuable()` now
   returns `{ presetId?, agentOptions }` from its live resolved config, and the
   `tool-subagent-preset` row no longer carries a static `agentOptions` pin —
   so EVERY child (one-shot, continuable, crew member) follows Settings →
   Plugins. Finer per-child control later = set `agentOptions` on a tool row or
   role again; it overrides the settings route.
   then applies the delegation-context statement and per-child persona/toolFilter
   (fail loud on a missing roster or unknown preset — no silent inheritance).

## Deployed install

The running harness loads `@deepseek-ai/dsh-subagent` from the npx cache
(`~/.npm/_npx/…/node_modules/@deepseek-ai/dsh-subagent`). The runtime
equivalent of the five edits above has been applied directly to that bundle's
`lib/index.js` (plus the matching `lib/types/types.d.ts`), so a DSH restart picks
it up. Re-apply after any `dsh` update that re-fetches the package.

## Run-from-source install (2026-08-26)

The deployment moved to a repository checkout (`/home/chaosbolt/deepseek-harness`,
release `0.1.1-rc.2`, run via `pnpm dsh web`), which lost the npx-cache edit
above. The five edits have been **re-applied to the checkout sources**:

1. `packages/subagent/subagent/src/types.ts` — `presetId?: string` on
   `SubagentStartRequest` and `ContinuableCreateSpec`.
2. `packages/subagent/subagent/src/child-agent.ts` — `applyPresetChildComposition`
   (+ `ChildComposition.presetId`).
3. `packages/subagent/subagent/src/continuation.ts` — request/provider preset
   derivation in `startContinuable`, `meta.agentPreset` recording, cold-resume
   reconstruction from the durable header, async pinned setup in
   `materializeTracked`.
4. `packages/subagent/subagent/src/index.ts` — export the new helper.
5. Rebuilt with `pnpm run build:lib:host` (tsc types + tsdown bundle).

Verified: harness subagent workspace tests 543/543 green (incl.
`continuation-inheritance.spec.ts`, which pins the unchanged default path);
plugin `tsc --noEmit` clean and 25/25 unit tests. The change is an uncommitted
working-tree diff on the checkout — review with `git -C /home/chaosbolt/deepseek-harness diff`,
and re-apply after any `git pull` that touches these files. A `pnpm dsh web`
restart activates it.

## Cross-plane tool-filter sanitization (2026-08-31, patch item 6b)

Revalidation on the web plane exposed a real defect: every delegation through
the plugin failed with
`tools.restrict() names unknown global tool "todo_write"` (and `get_goal` on
crew roles). Cause: the plugin's filters (added 2026-08-27 for host-plane tool
isolation) are authored for the **headless** global registry, which registers
`todo_write`/`get_goal` globally — the **web** plane's registry does not, and
`tools.restrict()` fails loud on unknown names.

Fix (two pieces, both additive):

1. `@deepseek-ai/dsh-tools` (`packages/core/tools/src/index.ts`) — new public
   `ToolRuntime.restrictableNames(scope?)`: the pre-restriction global names a
   scoped restriction may name for the viewed scope (global registry when
   omitted). Read-only; no behavior change.

2. `@deepseek-ai/dsh-subagent` (`packages/subagent/subagent/src/child-agent.ts`)
   — `sanitizePresetChildToolFilter` clips a pinned child's filter against the
   child scope's restrictable names before `tools.restrict()`, applied ONLY in
   `applyPresetChildComposition` (the preset-pinned seam introduced by this
   patch). The inherit path (`applyChildComposition`) is deliberately
   untouched: the upstream fail-loud unknown-name contract is pinned by
   `subagent-spawn-in-process.spec.ts` and
   `subagent-in-process-driver.spec.ts`, and both suites keep passing.
   Clipping never widens the child (dropped names cannot exist in its view
   anyway); an allowlist that clips to empty still throws (material
   cross-plane misconfiguration).

Vantage-point note (learned the hard way): an earlier iteration also
pre-clipped the plugin's filters at delegation time against
`parent.ctx.tools.restrictableNames()` — the PARENT's global-only view. That
is the wrong vantage point on planes whose tools are preset-mounted (web):
the parent's global layer holds almost none of the model-facing tools, so the
clip gutted a correct filter (the web child was left with `crew_wait` only).
The child's own view — global registry PLUS the mounted preset's
registrations — is only knowable after the mount, i.e. inside the compose.
The shared `sanitizePresetChildToolFilter` is therefore the ONE seam; the
plugin passes role/row filters through unclipped (`src/plane.ts` was
removed), and hosts whose facade predates `restrictableNames()` simply get
the pre-patch fail-loud behavior.

Follow-up (same day): the sanitizer's first cut called
`restrictableNames()` WITHOUT a scope — the optional-argument form answers the
global registry, which on the web plane holds almost none of the model-facing
tools — so the web child's correct filter was gutted to `crew_wait` alone
(turn still completed; caught by decoding the child's `request/header`). The
sanitizer now passes the CHILD's scope key, so the known set is the chain view:
global registry plus the mounted preset's registrations. Headless re-verified
(9/9 authored tools survive), web re-verified after restart (8/8, no
`todo_write` — it genuinely does not exist there). Lesson: on preset-mounted
planes the only valid vantage point for filter validation is the child's OWN
post-mount view.

Verified: harness `packages/core/tools` + `packages/subagent` 1051/1051 green
(fail-loud inherit-path tests intact); plugin `tsc --noEmit` clean, 31/31 unit
tests; headless one-shot + crew re-run post-fix, children log-asserted on
`ccode/deepseek/deepseek-v4-flash` @ `subagent-slim` (depth 1, full authored
tool set). Web plane requires a `pnpm dsh web` restart to load the rebuilt
libs.
