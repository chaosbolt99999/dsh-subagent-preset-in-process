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
   then applies the delegation-context statement and per-child persona/toolFilter
   (fail loud on a missing roster or unknown preset — no silent inheritance).

## Deployed install

The running harness loads `@deepseek-ai/dsh-subagent` from the npx cache
(`~/.npm/_npx/…/node_modules/@deepseek-ai/dsh-subagent`). The runtime
equivalent of the five edits above has been applied directly to that bundle's
`lib/index.js` (plus the matching `lib/types/types.d.ts`), so a DSH restart picks
it up. Re-apply after any `dsh` update that re-fetches the package.
