# subagent-preset-provider — implementation notes

> Vendored copy of the project's working plan/status document. It describes the
> plugin in this repository plus the shared-runtime patch it depends on
> (`SHARED-PATCH.md`) and the deployment it was verified against.

Goal: ship a subagent backend that pins every child agent to a named **agent preset** and routes every child through the plugin's resolved **settings** (`provider`/`model`, live-editable in Settings → Plugins; per-child overrides shipped 2026-09-14 via request-level `agentOptions` on a tool row or crew role — see §12), registered on `ctx.subagents` so the shipped `tool-subagent` (or a custom tool) can delegate through it.

All repo-relative paths below are relative to the `deepseek-harness` checkout (`/home/chaosbolt/deepseek-harness`, release 0.1.1-rc.2, run from source via `pnpm run build:lib:host && pnpm dsh web`).

## 1. What is already true (do not rebuild these)

- The seam is `ctx.subagents` = `SubagentRuntime`, a named-provider registry (`packages/subagent/subagent/src/index.ts`). Providers register with `registerProvider(provider)` (effect-scoped; duplicate name throws `DUPLICATE_PROVIDER`; emits `subagent/provider-added`/`-removed`).
- The provider contract is `SubagentProvider` (`packages/subagent/subagent/src/types.ts:285`): `name`, `capabilities {outputSchema, depthLimit, toolFilter, persona}`, `inheritsParentContext`, `start(request)`, optional `prepareContinuable`.
- `SubagentStartRequest` (`types.ts:100`) already carries `agentOptions` (`provider`/`model`/`maxTokens`), `maxDepth`, `toolFilter`, `persona`, `outputSchema`, `label`, `prompt`, `parent`, `signal`.
- The agent factory's `setup` callback may be **async**: `AgentSetup = (...) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void` (`packages/core/agent/src/index.ts:69`).
- `ctx.agentPresets.mount(childCtx, id)` composes an unpublished agent under a **named** preset (async); `composeFrom(childCtx, parentCtx)` joins the **parent's** standing preset (sync). Both are on `AgentPresets` (`packages/preset/agent-presets/src/index.ts:275` / `:316`).
- The shipped in-process driver `startInProcessRun(request, { seed? })` (`packages/subagent/subagent-in-process-driver/src/index.ts:102`) hardcodes child composition via `applyChildComposition` → `composeFrom` (parent inheritance) and inherits the parent's model via `resolveChildAgentOptions`. This is why the default behavior is "child = parent's preset, parent's model."

**Consequence:** model pinning needs no code — `agentOptions` already does it. Preset pinning is the only thing that needs a change, because the shipped driver never asks for a different preset.

## 2. The two levers and how each is done

### 2a. Spawn the child on a different model than the parent

The child's model route is set entirely through `agentOptions` — no composition
change and no shared-code change. The runtime resolves the child route with
`resolveChildAgentOptions(parent, request.agentOptions, childDepth)`
(`child-agent.ts:68-83`), which merges the request **over** the parent's route, so
any `provider`/`model` supplied on the request wins.

- **One-shot path** (`subagent`/`subagent_preset` tool): the provider's
  `start(request)` forces the child route from config and hands it through
  `resolveChildAgentOptions`:
  ```ts
  const forcedAgentOptions = {
    ...request.agentOptions,
    provider: config.provider,   // e.g. 'deepseek-official'
    model: config.model,         // e.g. 'deepseek-v4-flash'
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
  }
  // agentOptions: resolveChildAgentOptions(parent, forcedAgentOptions, childDepth)
  ```
- **Continuable path** (`backgroundMode: continuable` and crew members):
  since the 2026-08-26 shared-patch extension, `ContinuableCreateSpec` carries an
  optional detached `agentOptions` route default. `prepareContinuable()` returns
  `{ presetId?, agentOptions }` from the LIVE resolved settings, and the manager
  merges it UNDER any caller-supplied request options before
  `resolveChildAgentOptions` (precedence: request > settings > parent). Crews
  keep placing per-role routes on `request.agentOptions` (role override >
  config fallback). The durable `subagent/descriptor` records the EFFECTIVE
  `agentProvider`/`agentModel`, which is what cold resume reuses. No static
  tool-row pin is needed anymore; adding one is the per-child override knob.
- **Config + settings surface**: `provider` (default `deepseek-official`) and
  `model` (default `deepseek-v4-flash`) are the child route. The settings card
  exposes them as ONE dropdown populated from the host `llm.models` catalog, so
  the two fields cannot drift apart.
- **Verification**: after a delegation, the child's `request/header` `config` AND
  its `subagent/descriptor` must show the forced route, not the parent's. The
  descriptor line is the authoritative in-log check:
  ```json
  {"type":"subagent/descriptor","data":{"provider":"preset","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash"}}
  ```
  If the descriptor still shows the parent's `agentProvider`/`agentModel`, the
  child was delegated through the inherited `spawn` provider, not the pinned
  `preset` provider — fix the wiring, not the model code.

### 2b. Pin the child preset — needs a small driver hook + a thin provider

Because `startInProcessRun` hardcodes `composeFrom`, choose one of:

- **Option A (recommended): extend the shared driver.** Add an optional composition override to `InProcessRunOptions` so the driver mounts a named preset instead of inheriting. Then the new provider is as thin as `spawn`. Small, testable, keeps the drive/read/structured logic in one home.
- **Option B: full standalone provider.** Reimplement `start()` (mint id, `ctx.agents.create`, drive to quiescence, `readResult`) with `agentPresets.mount` in an async `setup`. No change to shared code, but duplicates the drive/read/structured logic.
- **Option C: no custom provider — inherit.** Make the child preset equal the parent's preset. Then the shipped spawn/fork providers already do everything; only set the model. Zero code.
- **Option D: out-of-process.** Use the `dsh-sdk` provider with `args` pointing at a child `cordis.yml` (its own composition = its own "preset") plus `model: 'deepseek-v4-flash'`. No code, process boundary.

This plan **implemented Option B** (standalone provider, no shared-driver change) for deployability without touching the monorepo. Option A remains documented as the preferred upstream shape (see §6). B/D remain fallbacks.

## 3. Process — Option A (reference) → Option B (implemented)

### 3.1 Extend the in-process driver

File: `packages/subagent/subagent-in-process-driver/src/index.ts`.

Add to `InProcessRunOptions` (currently `{ seed?: SessionEvent[] }`):

```ts
export interface InProcessRunOptions {
  readonly seed?: SessionEvent[]
  /** When set, compose the child under this preset id instead of joining the parent's. */
  readonly presetId?: string
}
```

In `startInProcessRun`'s `setup`, branch on `presetId`:

```ts
const setup = (childCtx: Context): void => {
  appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, inherited)
  if (options.presetId !== undefined) {
    composeChildUnderPreset(childCtx, parent, options.presetId, { persona: request.persona, toolFilter: request.toolFilter })
  } else {
    applyChildComposition(childCtx, parent, { persona: request.persona, toolFilter: request.toolFilter })
  }
  if (request.outputSchema !== undefined) {
    structured = attachStructuredRuntime(childCtx, request.outputSchema)
  }
  attachDescriptorAppend(childCtx, request.descriptor)
}
```

And record the pinned preset in durable metadata so cold reads reconstruct the child under the right tool set. `childSessionMeta` records the **parent's** preset; override it when pinning:

```ts
const meta = childSessionMeta(parent, childDepth, activationBoundary)
const metaWithPreset = options.presetId !== undefined
  ? { ...meta, agentPreset: options.presetId }
  : meta
```

The new `composeChildUnderPreset` helper replaces the `composeFrom` join with an async mount plus the same delegation-context sentence `applyChildComposition` adds (`SUBAGENT_DELEGATION_CONTEXT`, `child-agent.ts:135`):

```ts
async function composeChildUnderPreset(
  childCtx: Context,
  parent: Agent,
  presetId: string,
  composition: ChildComposition,
): Promise<void> {
  const presets = childCtx.get('agentPresets')
  if (presets === undefined) {
    throw new Error('subagent preset pinning requires the agent-presets roster')
  }
  await presets.mount(childCtx, presetId)          // async; setup may await it
  childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
  if (composition.persona !== undefined) {
    childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: composition.persona })
  }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
}
```

Because `setup` becomes async, confirm the factory still awaits it (it does — `AgentSetup` may return a Promise) and that `structured`/`attachDescriptorAppend` still run after the `await` before publication.

### 3.2 Create the provider plugin

New package `packages/subagent/subagent-preset-in-process/` (mirror `subagent-spawn-in-process`). Function plugin with **named exports only** (`name`/`inject`/`Config`/`apply`; no default export).

`src/index.ts`:

```ts
export const name = 'subagent-preset-in-process'
export const inject = ['subagents']

export interface Config {
  providerName: string      // default 'preset'
  presetId: string          // required: the child preset to mount
  provider?: string         // default 'deepseek-official'
  model?: string            // default 'deepseek-v4-flash'
  maxTokens?: number
  maxDepth?: number | 'provider-managed'
}
export const Config: z<Config> = z.object({
  providerName: z.string().default('preset'),
  presetId: z.string().required(),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')]).default(3),
})

class PresetInProcessProvider implements SubagentProvider {
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = false
  constructor(readonly name: string, private readonly config: Config) {}

  start(request: ResolvedSubagentStartRequest) {
    const forced = {
      ...request.agentOptions,
      provider: this.config.provider,
      model: this.config.model,
      ...(this.config.maxTokens !== undefined ? { maxTokens: this.config.maxTokens } : {}),
    }
    return startInProcessRun(
      { ...request, agentOptions: forced },
      { presetId: this.config.presetId },
    )
  }

  prepareContinuable() {
    return Promise.resolve({})   // fresh child, no seed
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new PresetInProcessProvider(config.providerName, config))
}
```

Notes:
- `maxDepth` numeric requires the provider's `depthLimit` capability (it advertises it); `'provider-managed'` leaves recursion to the child runtime. Keep the tool-subagent convention.
- `prepareContinuable` presence enables continuable children; the continuation manager still owns their lifecycle (cold resume re-runs the child under the recorded `meta.agentPreset`).
- For structured output, reuse `attachStructuredRuntime` from the driver (`packages/subagent/subagent-in-process-driver/src/structured.ts`); if it is not exported, export it in the same PR.

### 3.3 The child preset

Author the "subagent-tailored" preset the provider mounts. Shipped presets live at `apps/cli/config/agent-presets/<id>/agent.cordis.yml`; a user preset lives at `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` (`packages/preset/agent-presets/src/discovery.ts`, `USER_PRESET_DIR = '.agent-presets'`).

Minimal child preset (agent-plane composition — tools + persona, NOT the subagent registry/backends, which stay host-plane):

```yaml
# ~/.dsh/.agent-presets/subagent-slim/agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a focused worker subagent. Complete the assigned subtask and report.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
```

Remember the two-plane rule: a service row in a preset needs an `isolate` realm or it leaks to the root (`packages/preset/agent-presets/src/mount.ts`, and the `standard` preset header). Tools that only `register()` into the host registry need no realm.

### 3.4 Wire it in a cordis composition

Register the provider and point a `tool-subagent` instance at it:

```yaml
- id: subagent-preset-in-process
  name: '@deepseek-ai/dsh-subagent-preset-in-process'
  config:
    providerName: preset
    presetId: subagent-slim
    provider: custom2          # base route only; Settings → Plugins overrides it live
    model: x-preview-f-free

- id: tool-subagent-preset
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: preset
    toolName: subagent_preset
    backgroundMode: continuable
    # no agentOptions: the route follows Settings via prepareContinuable().
    # Add agentOptions here later for a per-tool override.
```

> **Continuable routing:** requires the shared-runtime patch (`SHARED-PATCH.md`),
> which threads `presetId` AND `agentOptions` through `ContinuableCreateSpec`.
> `prepareContinuable()` supplies both from live settings; caller-supplied request
> options win over them (precedence: request > settings > parent). One-shot
> children are routed inside the provider's `start()`. Cold resume reuses the
> effective route recorded in the durable descriptor.

> **Headless fix:** the headless profile does not include `dsh-base`'s `agent-presets` roster by default, so `~/.dsh/profiles/headless/cordis.patch.yml` now inserts `agent-presets` (`default: standard`). Without it `prepareContinuable` throws `subagent preset pinning requires the agent-presets roster`.

On the Web plane this belongs in the preset's `delegation` group (the host tool rows are disabled there); on the headless/base plane the base rows already mount the subagent registry + spawn/fork backends, so only these two rows are added.

### 3.5 Verification

- **Unit tests** (`tests/` at package level): provider registers under `providerName`; duplicate name throws; `start` forces `agentOptions.provider/model`; `prepareContinuable` returns `{presetId, agentOptions}` from live settings (incl. route-change and maxTokens cases); `meta.agentPreset` records the pinned id. **Now 27/27** (`crew.spec 6` + `provider.spec 11` + `pipeline.spec 10`).
- **Real-composition test** (required for product-visible plugins): boot a `cordis.yml` through the Loader with a preset roster + this provider + a `tool-subagent` instance; assert the child's assembled tool set comes from the pinned preset (mirror `packages/subagent/subagent-in-process-driver/tests/preset-inheritance.spec.ts`, which asserts the opposite — inheritance).
- **Manual smoke**: `dsh --profile headless "use subagent_preset to …"` with a key, and confirm the child's model route and tool set. **Now automated** via `scripts/verify-headless-different-model.sh` (see §8.1): isolates a workspace at `/tmp/headless-workspace` (`ProjectKey --tmp-headless-workspace--`), runs `DSH_PERMISSION_MODE=danger-full-access dsh --profile headless` to delegate via `subagent_preset` (file write) and `crew_materialize`, then per-frame `zstd` decompresses `~/.dsh/sessions/--tmp-headless-workspace--/*/session.jsonl.zstd` (16 concatenated frames, not single-frame `zstdDecompressSync`) and asserts `request/header` + `subagent/descriptor` + `agentPreset`.
- **Repo gates** (per `IMPLEMENTATION-NOTES.md`): `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, `pnpm run build`, `pnpm run hygiene`. A non-trivial change needs an **Agent Note** in the same PR; a product-visible behavior change needs a keyless snapshot through a runnable example.

## 4. Fallback paths

- **Option B (standalone provider, no driver change):** implement `start()` from scratch in the new package — mint `SessionId`, `captureDelegatedPolicyOverrides` + `appendDelegatedPolicyOverrides`, async `setup` that `await agentPresets.mount(childCtx, presetId)` + delegation sentence + persona/toolFilter, `ctx.agents.create` with forced `agentOptions` and `meta.agentPreset`, then drive (`followup` + `whenIdle`) and map the turn outcome via `toStopReason`/`finalAssistantOutput`. These helpers are exported from `@deepseek-ai/dsh-subagent` (`child-agent.ts`, `assistant-output.ts`); `drivePublishedRun`/`readResult` are module-local to the driver and must be reimplemented.
- **Option C (inherit, no code):** child preset = parent's preset; set `tool-subagent.agentOptions = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }` only.
- **Option D (out-of-process):** `dsh-sdk` provider row with `command`/`args` (child `cordis.yml`), `provider`, `model`, `maxTokens`, `env` (`packages/subagent/subagent-dsh-sdk/src/index.ts:29-69`).

## 5. Contract checklist (must hold)

- `start()` must publish the child before resolving; a rejection means "cleaned up, nothing published," no lifecycle pair. Post-publication failures settle through `run.result` (never rejects on child-level failure).
- `capabilities` must be truthful: the service rejects a requested capability the provider lacks (`UNSUPPORTED_CAPABILITY`) before `start()`.
- Registration is an effect: return the disposer; duplicate name throws; removal blocks new starts but never revokes already-returned runs.
- Model-visible == logged: anything the pinned child sees must be reconstructable from its session log (`meta.agentPreset` is the durable composition record; the descriptor is appended in the child's first turn).
- Misconfiguration fails loud: missing `agentPresets` roster or unknown `presetId` must throw at mount/start, never silently fall back to inheritance.

## 6. Decision — Option B implemented (Option A deferred)

The plan originally recommended Option A (extend shared driver with `presetId` in `InProcessRunOptions`). In practice **Option B was implemented**: a standalone `PresetInProcessProvider` that duplicates the ~40-line drive/read/structured loop (`followup` + `whenIdle` + `finalAssistantOutput`) but mounts the child with `await AgentPresets.mount(childCtx, presetId)` in an async `setup` and records `meta.agentPreset`. Rationale: deployable as a linked plugin without patching the monorepo's shared driver; no shared-surface change required. The duplicated logic mirrors the driver exactly and is covered by 25 unit tests. Option A remains the preferred upstream shape — if merged, the provider collapses to a thin wrapper around `startInProcessRun(..., {presetId})` — but B is not blocking further features (pipeline, verify-gate, crews all work on B).

## 7. Crews — shipped (hybrid → pipeline)

**Decision (completed):** the user confirmed the long-term design is a **deterministic
pipeline with a verify-gate** (planner → orchestrator → builder → verifier) plus a
**richer per-role task spec**. The minimal hybrid-routed crew was shipped first for
smoke-testing, then the pipeline was implemented and landed.

### Shipped

- `src/crew.ts` `CrewService` (`ctx.crews`): `materialize()` (each role =
  continuable child via `startContinuable`), `handoff()` (target role's next
  `followup` turn), `roles()`/`orchestrator()`, `pipelineOrder`/`nextInPipeline`/`previousInPipeline`, `isPipeline`/`pipelineCursor`/`resetPipeline`, `tasks()`/`task()`/`updateTask()`/`allTasks()`/`roleForTask()`, `pipelineAdvance()`/`recordVerification()`.
- `src/crew-tools.ts`: `crew_materialize`, `crew_handoff`, `crew_wait`,
  `crew_status`, `subagent_wait`, **plus** `crew_pipeline_advance`, `crew_pipeline_status`, `crew_task_update`, `crew_verify` — pipeline-aware handoff enforces successor (except verifier loop), verify-gate loops on fail (`maxRetries` → `blocked`), `crew_wait`/`subagent_wait` block indefinitely on `subagent/end`.
- Routing is **configurable**: `mode: 'routed'` (hybrid, model chooses next role) or `mode: 'pipeline'` (deterministic `pipeline.order`). `pipeline.verifyGate {enabled, verifierRole, maxRetries}` gates advancement; `rolePrompt` renders task lists.
- Done signal = the continuable **settlement notice** (`stopReason` + closing
  output). `ContentBlock[]` readonly fix applied.

### Config shape

```yaml
crews:
  engineering:                 # routed (default)
    mode: routed
    orchestratorRole: orchestrator
    roles: [{name: planner, presetId: subagent-slim, roleTask: ...}, ...]
  engineering-pipeline:        # pipeline
    mode: pipeline
    roles:
      - {name: planner, presetId: subagent-slim, roleTask: Break goal into tasks, tasks: [{id: T1, title: ..., status: pending}]}
      - {name: builder, presetId: subagent-slim, roleTask: Implement T1 with evidence}
      - {name: verifier, presetId: subagent-slim, roleTask: Verify T1, call crew_verify}
    pipeline: {order: [planner, builder, verifier], verifyGate: {enabled: true, verifierRole: verifier, maxRetries: 3}}
```

### What was verified in harness smoke before pipeline

- `crew_materialize` starts all roles as continuable children under their pinned
  presets (no inheritance fallback, no DUPLICATE_PROVIDER).
- `crew_handoff` delivers exactly one FIFO turn; the target role runs its
  `roleTask` and settles; the settlement notice reaches the parent.
- Cold-resume / `list_agents` shows the crew members as `continuable` (`ready`),
  and `send_message` reaches an idle member.
- No self-handoff, unknown-crew, or missing-`agentPresets` silent fallback.

## 8. Implementation status (as of 2026-08-26)

- **Deployment moved to run-from-source** — `/home/chaosbolt/deepseek-harness` at release `0.1.1-rc.2`, booted with `pnpm dsh web`; the plugin is linked into BOTH profiles (`~/.dsh/profiles/{web,headless}/package.json` `dsh.profile.bundles` + node_modules symlinks).
- **Settings-driven child routes (2026-08-26)** — every child (one-shot, continuable, crew) takes provider/model from the plugin's LIVE resolved settings (`custom2/x-preview-f-free` today); precedence request override > settings > parent. Implemented by extending `ContinuableCreateSpec` with detached `agentOptions` (shared patch item 6) returned from `prepareContinuable()`; the static `tool-subagent-preset.agentOptions` pin was REMOVED from `cordis.patch.yml`. Verified live in the web plane: continuable delegation `fb691986…` completed (`settings-route-ok`) with descriptor `provider:preset / mode:continuable / agentProvider:custom2 / agentModel:x-preview-f-free`, session header `agentPreset:subagent-slim` + `delegationDepth:1`, 18-tool slim set vs parent's 35.
- **Shipped in `subagent-preset-plugin/`**: provider + structured runtime + `CrewService` + 8 crew tools + presets + cordis wiring + settings client. `tsc --noEmit` clean; **27/27 tests pass** (`crew.spec 6` + `provider.spec 11` + `pipeline.spec 10`). Harness subagent workspaces (with shared patch): **543/543**.
- **Model routing mechanics**: one-shot forced inside `start()`; continuable via `prepareContinuable().agentOptions` merged under request options; crew roles send per-role routes (`def.provider/model ?? config`) on `request.agentOptions`, which win over the detached default. Descriptor records the EFFECTIVE route → cold resume reuses it.
- **Historical fixed-route verification (2026-08-20)**: one-shot `test/deepseek-v4-flash` over parent `test/muse-spark-1.2-contributor`; children `b19c0704…` (preset) + crew `1b889459…/cf1cf151…` all pinned `subagent-slim`. Superseded by settings routing after a real outage: child `98427cd8…` failed with upstream `401 CreditsError` on the then-static `test/deepseek-v4-flash` pin while settings already pointed at `custom2/x-preview-f-free` — the motivation for this change.
- **Continuable preset pinning — shared-runtime patch** (`SHARED-PATCH.md`): continuation manager previously hardcoded `composeFrom`; patch threads `presetId` AND `agentOptions` through `ContinuableCreateSpec`, mounts via `AgentPresets.mount` in an async setup, records `meta.agentPreset`, reconstructs both from durable state on cold resume. **Applied as source edits to the checkout** (`packages/subagent/subagent/src/{types,child-agent,continuation,index}.ts`; committed on the harness `master` 2026-08-26); rebuild host libs with `pnpm run build:lib:host` after applying, restart DSH to pick up. The earlier npx-cache bundle edit is obsolete. Headless additionally needs `agent-presets` insertion in `~/.dsh/profiles/headless/cordis.patch.yml` (`insert: - id: agent-presets, config: {default: standard}`) — without it `prepareContinuable` throws `subagent preset pinning requires the agent-presets roster`.
- **Indefinite wait shipped** — `crew_wait`/`subagent_wait` block on `subagent/end` wake, replacing `sleep N` + `list_agents` polling.
- **Pipeline + verify-gate shipped** — §7 deterministic pipeline implemented: `mode` union (`routed|pipeline`), `pipeline.order` + `verifyGate`, per-role `tasks`, `pipelineAdvance`/`recordVerification`, 4 new tools, pipeline-aware `crew_handoff`/`crew_status`, client help text. `crew_verify` schema fix: `next_role` single-type `string` (`''` on null) — DSH forbids `["string","null"]`.
- **Session persistence quirk** — headless `~/.dsh/sessions/<ProjectKey>/*/session.jsonl.zstd` is concatenated `zstd` frames; single-frame `zstdDecompressSync` only returns the `{"type":"session"}` header. Per-frame decompression (slice at `28 b5 2f fd` boundaries + concat) yields the full log with `subagent/descriptor` + `request/header` visible.

## 8.1 Testing methodology — headless different-model

> **2026-08-26:** routes now follow Settings, so the script's expectations are
> env-tunable: `EXPECTED_CHILD_PROVIDER` / `EXPECTED_CHILD_MODEL` (defaults
> `custom2` / `x-preview-f-free`) and `PARENT_MODEL_SUBSTR` (default
> `x-preview`). The fixed `test/deepseek-v4-flash` assertions below describe the
> historical 2026-08-20 run only.

**Isolation.** Workspace ` /tmp/headless-workspace` (`ProjectKey --tmp-headless-workspace--`) isolates sessions from the main `--home-chaosbolt-dsh_subagents--` key. Clean state: `rm -rf ~/.dsh/sessions/--tmp-headless-workspace--/*` + `mkdir -p` before each run. Historical run: parent `provider: test, model: muse-spark-1.2-contributor`; child statically pinned `test/deepseek-v4-flash` — both since replaced by settings-driven routing.

**Headless run.** `DSH_PERMISSION_MODE=danger-full-access` (file `danger-full-access`, approvals `never`) + `timeout 90 dsh --profile headless "Use subagent_preset to write /tmp/headless_verify_different_model.txt with content 'hello-different-model' and report. Also crew_materialize/crew_status."` — no Web GUI needed; the `agent-presets` provider row in headless `cordis.patch.yml` supplies `subagent-slim` (linked `link:/home/chaosbolt/dsh_subagents/subagent-preset-plugin`).

**Log inspection.** `~/.dsh/sessions/--tmp-headless-workspace--/<sessionId>/session.jsonl.zstd` — not the Web's `dsh-session-*` folder. Decompress per-frame (see `scripts/verify-headless-different-model.sh`):

```js
const buf = fs.readFileSync(p); // .zstd
const offs = []; for (let i=0;i<buf.length-4;i++) if (buf[i]==0x28&&buf[i+1]==0xb5&&buf[i+2]==0x2f&&buf[i+3]==0xfd) offs.push(i);
let tot=Buffer.alloc(0); for (let i=0;i<offs.length;i++) tot=Buffer.concat([tot, zlib.zstdDecompressSync(buf.slice(offs[i], offs[i+1]??buf.length))]);
raw = tot.toString('utf-8'); // 71 kB, not 266 B
```

Assert: parent `request/header` `config.provider==test && model==muse-spark-1.2-contributor`; child `subagent/descriptor` `provider==preset && agentProvider==test && agentModel==deepseek-v4-flash && label prefixed crew:… or Write verification file` + `agentPreset==subagent-slim` header (`delegationDepth:1`) + `request/header` `test/deepseek-v4-flash` + slim persona ("You are a focused worker subagent…") + `tool-bash`/`fs`/`fs-search` composition. Crew members `1b889459…`/`cf1cf151…` etc. same `deepseek-v4-flash` + `subagent-slim`.

**Return check.** Child `finalAssistantOutput`/`stopReason: completed` + parent `write` tool output `hello-different-model` (24 B) verified via `read`/`cat`/`od -c` and via parent's `assistant/chunk` stream — not just file-exists. `scripts/verify-headless-different-model.sh` automates both steps (file content + crew) + log asserts and exits non-zero on any mismatch.

**Regression command.** `bash subagent-preset-plugin/scripts/verify-headless-different-model.sh` — standalone, no harness watcher needed. `pnpm --prefix subagent-preset-plugin exec tsc --noEmit && pnpx vitest run` covers unit.

## 9. Next

- §7 smoke re-run against live harness with pipeline mode (materialize `engineering-pipeline`, `crew_handoff` successor enforcement, `crew_verify` pass/fail → loop vs advance, `maxRetries` → `blocked`, cold resume) — pipeline is local-tested; the plain continuable path was live-smoked in the web plane on 2026-08-26 (`fb691986…`), but a full pipeline crew has not been.
- Optionally upstream the shared patch (`presetId` + `agentOptions` threading through `ContinuableCreateSpec`) to `deepseek-ai/deepseek-harness` — it supersedes/collapses the Option A driver idea for the continuable path; the one-shot driver hook (§3.1) remains the only un-upstreamed piece.
- Optional finer-grained routing controls later: per-tool-row and per-role `agentOptions` already override settings via request precedence; a settings-card UI for role-level overrides would build directly on that.

## 10. Crews live-testing round — bugs found and fixed (2026-08-27)

A live headless testing round on the crews feature (routed + pipeline modes,
`merge/deepseek/deepseek-v4-flash-0731` = merge/dsv4f child route over a
`zai/glm-5.3-flash` parent) surfaced four real bugs. All are fixed in the plugin
(commits `725e98c` + `7ba0696`), verified live from the per-frame-decoded session
logs, and covered by unit tests (**31/31**: `crew.spec 8` + `provider.spec 13` +
`pipeline.spec 10`).

### 10.1 BUG #1 (major) — crew members were never tool-isolated

**Symptom (from the 2026-08-26 headless crew run, sessions
`~/.dsh/sessions/--home-chaosbolt-deepseek-harness--/f1a067b9…` et al.):** every
crew child's header recorded `agentPreset: subagent-slim`, yet its
`request/header` listed **36 tools** — the parent's full set + `report` — and the
children ran parent-plane tools (`get_goal`, `crew_status`, git bash). The prior
session had proven `agentPreset` alone does not isolate: on host-plane
deployments (`dsh-base` registers all model-facing tools globally) a preset join
is **additive** — `tools.view()` filters only the INHERITED surface, and the
global layer IS inherited. The 2026-08-26 web-plane smoke looked isolated only
because the web bundle moves tools behind presets (host rows disabled).

**Fix:** per-role `toolFilter` (`allow`/`deny`) on crew roles
(`CrewRoleSchema`, threaded through `CrewService.materialize()` →
`request.toolFilter` → the child's scoped `tools.restrict()`); also restated on
the `tool-subagent-preset` row so one-shot children are isolated on host-plane
deployments too. Filters land in the durable `subagent/descriptor`
(`toolFilter.allow`), so cold resume reconstructs them. On the web plane the
same names are no-ops (the preset owns those tools).

**Pitfall (caught live):** `report` must NEVER appear in an allowlist — it is a
continuable-setup registration in the child's own layer (exempt from
filtering), not a global tool, and `tools.restrict()` fails loud on unknown
names (`crew_materialize` rejected every role until `report` was removed from
`cordis.patch.yml` AND `~/.dsh/settings.yaml` — both surfaces must agree).

**Verified (2026-08-27 22:52 run):** planner/orchestrator 14 tools, builder 12
(no `get_goal`/`crew_task_update`), verifier 13 (`crew_verify` present); all
headers `agentPreset: subagent-slim`, `delegationDepth: 1`, route
`merge/deepseek-v4-flash-0731`.

### 10.2 BUG #2 — `crew_wait` fabricated a `completed` settlement before the turn ran

`waitForSettlement` returned `stopReason: "completed"` whenever the child's
`status !== 'running'`, but `Agent.status` stays `idle` in the window between
`followup()` and the first turn start — a wait fired right after a handoff
returned `completed` with empty output before the role had done anything.

**Fix (`src/wait.ts`, rewritten):** the ambiguous `idle` read is re-armed after
a macrotask boundary — an accepted turn flips the agent to `running` by then
(and keeps it registered), while a truly settled Activation is disposed and gone
from the registry, so `completed` is only ever reported for a child that cannot
start a turn anymore. Added an optional `timeoutMs` bound (`timeout`
stop reason instead of an unbounded block on a stuck model) and `crew_wait` now
observes roles **concurrently** instead of serially.

### 10.3 BUG #3 — one-shot `subagent_preset` ignored a per-request `presetId`

`start()` always pinned `config.presetId`, so a caller naming its own preset was
silently overridden. Fixed: `request.presetId ?? config.presetId` (per-request
composition wins; unset fields keep the config default). Covered by new
provider tests (`PresetInProcessProvider.start composition`).

### 10.4 BUG #4 — live settings edits never reached crews

`CrewService` built its crew map once in the constructor and the settings
`onChange` hook was a no-op, so a Settings → Plugins edit (new crew, changed
role pins/route) never took effect. Fixed: `CrewService.reloadCrews()` is
invoked from `onChange` — definitions update in place for the NEXT
`materialize()` (already-materialized members keep their composition, matching
the "next child follows the resolved settings" rule); removed crews leave the
roster.

### 10.5 Live validation summary (post-fix, headless, log-verified)

- **Routed crew**: `crew_status → crew_materialize → crew_handoff (planner →
  orchestrator, "Reply with the single word ACK") → crew_wait` all clean;
  orchestrator settled `completed` with output exactly `ACK`.
- **One-shot `subagent_preset`**: wrote
  `/tmp/headless_verify_different_model.txt` (`hello-different-model`, verified
  on disk); child header `agentPreset: subagent-slim`, 9-tool slim set, route
  `merge/deepseek-v4-flash-0731` in both header and descriptor.
- **Pipeline crew**: materialize/handoff/`crew_pipeline_advance` accepted with
  correct role scoping; one run hit a transient provider outage (502/503 from
  the merge gateway) and one long builder turn was cut by the shell `timeout` —
  both external, not plugin defects. Full gate loop (`crew_verify` fail → loop →
  `maxRetries` → blocked) is still exercised by unit tests only.
- **Model-route validation per spawn type**: one-shot `subagent_preset` ✅
  dsv4f (descriptor + header), continuable `subagent_preset` ✅ (same path,
  descriptor-recorded), crew members ✅ (per-role route, descriptor-verified);
  `spawn`/`subagent`/`subagent_fork` inherit the parent **by design** (harness
  contract, not routed through this plugin).

### 10.6 Tooling updates

- `scripts/verify-headless-different-model.sh`: defaults now `merge` /
  `deepseek/deepseek-v4-flash-0731`, `PARENT_MODEL_SUBSTR=glm`, and the harness
  CLI runs via `DSH_BIN` (default `pnpm --dir /home/chaosbolt/deepseek-harness
  dsh` — there is no global `dsh` binary). Note: the per-frame zstd check reads
  session logs under the **parent's** ProjectKey — a headless run launched via
  `pnpm --dir <checkout>` logs under `--home-chaosbolt-deepseek-harness--`
  (pnpm changes cwd), not `--tmp-headless-workspace--`.
- New debug tools: `scripts/decode-session.js` (per-frame zstd → JSONL) and
  `scripts/summarize-session.js` (event counts, tool calls/results, errors).
- `~/.dsh/settings.yaml` carries the resolved plugin settings (crew role
  filters + merge/dsv4f route); it must stay in sync with `cordis.patch.yml`
  because Settings overrides the composition base at runtime.

## 11. Cross-plane filter fix + web-plane revalidation (2026-08-31)

Revalidation on the **web plane** exposed a real defect the headless rounds could
never catch: every delegation through the plugin failed with
`tools.restrict() names unknown global tool "todo_write"` (and `get_goal` on
crew roles). The filters added in §10.1 for host-plane isolation name tools the
**headless** registry registers globally but the **web** registry does not —
and `tools.restrict()` fails loud on unknown names. Reinstalling the plugin
could not have fixed it; the fix landed in the shared runtime (SHARED-PATCH.md
item 6b):

- `@deepseek-ai/dsh-tools`: new public `ToolRuntime.restrictableNames(scope?)`
  — the pre-restriction global names a scoped restriction may name.
- `@deepseek-ai/dsh-subagent`: `applyPresetChildComposition` (the pinned-path
  seam this project introduced) now clips the filter via
  `sanitizePresetChildToolFilter` against the **child's own scope view**
  (global ∪ the mounted preset's registrations) before `restrict()`. The
  inherit path keeps the upstream fail-loud contract (pinned by the
  spawn/driver suites, 1051/1051 green).
- **Vantage-point rule (learned twice the hard way):** clipping against the
  *parent's* global-only view, or against the global view (scope omitted), guts
  correct filters on preset-mounted planes — a web child was left with
  `crew_wait` alone (turn still `completed`; caught only by decoding the child's
  `request/header`). The child's own **post-mount** view is the only valid
  vantage point, and it is only knowable inside the compose. Plugin-side
  pre-clipping was removed (`src/plane.ts` deleted); filters pass through
  unclipped.

Final verified state (both planes, route = live settings `ccode /
deepseek/deepseek-v4-flash`, preset `subagent-slim`, depth 1):
- headless one-shot: 9/9 authored tools (`todo_write` exists there);
- web one-shot: 8/8 (authored minus `todo_write`);
- web crew: builder 11, planner/orchestrator 12 (`crew_task_update`), verifier
  12 (with `crew_verify`) — each = authored minus `todo_write`, child-scope
  `report` present, durable `subagent/descriptor` records the effective route.
- plugin 31/31 unit tests; harness tools+subagent 1051/1051.
Commits: harness `4a74811f43` + `0ce74dbff2`; plugin `15e8ad9` + `0aa5dd9` +
`c62ed67` (docs). Web GUI restart required after any rebuild of these libs —
`~/.dsh/restart-web.sh` automates the stop/relaunch/health-check cycle.

## 12. Request-level route override — finished, and the bugs it hid (2026-09-14)

The README documented a route precedence whose #1 entry — "**Request-level
override** — `agentOptions` on a `tool-subagent` row or a crew role
(`provider`/`model`/`maxTokens`). Absent by default; this is the future
finer-grained control knob." — was **never finished**. Three defects hid behind
that, plus a fourth found by the new end-to-end test.

### 12.1 BUG #5 (major) — a one-shot request-level override was silently discarded

`PresetInProcessProvider.start()` spread `request.agentOptions` and then wrote
`config.provider`/`config.model` (and `maxTokens`) *over* it:

```ts
const forcedAgentOptions = { ...request.agentOptions, provider: config.provider, model: config.model, ... }
```

So a `tool-subagent` row that pinned a model still ran on the plugin settings
model — for ONE-SHOT children only. The continuable path (crew members,
`backgroundMode: continuable` background children) merges request over
`prepareContinuable()`'s detached default and was already correct, so the same
row behaved differently depending on whether a given call ran in the foreground
or as a background child. Fixed by ONE resolver used by every path
(`src/route.ts` → `resolveRoute`), with the rule documented in code: per-field
`request > settings > parent`, undefined fields omitted (an explicit
`undefined` key would shadow the parent's inherited value).

### 12.2 BUG #6 — a request-level `maxDepth` was discarded whenever the config named a number

`const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : request.maxDepth`
meant the plugin setting silently won over the caller's cap (a tool row always
sends its own, default 3), and for crew members the reverse. Now
`effectiveMaxDepth(request, config)` takes the TIGHTER of the two
(`'provider-managed'` = no cap from that source), so neither knob can be
silently discarded and neither can widen the other.

### 12.3 BUG #7 — crew roles could not express `agentOptions` at all

Roles only had flat `provider`/`model`/`maxTokens`. `CrewRoleSchema` now takes
the canonical `agentOptions: {provider, model, maxTokens}` object (flat fields
kept as per-field aliases, nested wins), threaded through
`roleRouteOverrides()` → `resolveRoute()` in `CrewService.materialize()`, and
`crew_status` now reports each role's EFFECTIVE route (`routes`) plus every live
member's materialized route (`members[].route`) — so a pin is verifiable without
decoding session logs.

### 12.4 BUG #8 (found live, not by any unit test) — an omitted role `toolFilter` denied the role every tool

Schemastery MATERIALIZES an absent nested object, so a role that declared no
`toolFilter` resolved to `{ allow: [], deny: [] }`. An empty allowlist makes
`tools.restrict()` strip the child's entire tool set; the pinned child then
failed loud with *"allows no tool known to this deployment; the filter was
authored for a different plane"*. Every deployment so far had declared a filter
on every role (added in §10.1), which is exactly why this stayed invisible until
a role without one was exercised. Fixed with the same "preserve omission" guard
the shipped `tool-subagent` row uses for its own `toolFilter`
(`.default(undefined as unknown as {...})`); `CrewRoleSchema.agentOptions`
carries the same guard so an omitted override is absent rather than `{}`.

Unit tests: **67/67** (`route.spec 17` + `crew.spec 17` + `provider.spec 23` +
`pipeline.spec 10`), `tsc --noEmit` clean.

### 12.5 Live end-to-end verification (new script, both directions)

`subagent-preset-plugin/scripts/verify-route-override.sh` boots a real headless
DSH with a `--patch` overlay that adds (a) a second `tool-subagent` row whose
`agentOptions.model` differs from Settings and (b) a two-role crew where only the
`pinned` role pins a model, then decodes the per-frame zstd session logs
(mtime-scoped, parsed by event `type`) and asserts the EFFECTIVE route of every
child.

- **Post-fix run (2026-09-14, EXIT=0):** one-shot row child `request/header`
  `merge/deepseek/deepseek-v4-flash-0731` (the row override; Settings was
  `merge/zai/glm-5.3-flash`) with the untouched Settings provider; crew
  `override-check:pinned` descriptor `agentModel=deepseek/deepseek-v4-flash-0731`;
  crew `override-check:plain` descriptor `agentModel=zai/glm-5.3-flash` (follows
  Settings); both roles settled `completed` with `ACK`; the marker file was
  written (`override-ok`). `crew_status` reported the same per-role routes.
- **Pre-fix run:** same script against HEAD's `src/provider.ts` fails exactly the
  row assertion (`the one-shot child of the pinned tool row never ran on
  deepseek/deepseek-v4-flash-0731 (saw: merge/zai/glm-5.3-flash) — the row-level
  override was discarded`) while the crew assertions still pass — the bug was
  one-shot-only, as diagnosed.
- **No-leak regression:** a parallel headless run of the *deployment's own*
  `engineering` crew (settings config, per-role `toolFilter`, NO route overrides)
  materialized all four roles on the Settings route `merge/zai/glm-5.3-flash`,
  and `subagent_preset` one-shot children likewise — the per-row/per-role
  override does not leak into un-overridden children (checked from the same
  post-fix build).

### 12.6 Deployment fix required by the round (headless was broken)

The first verification run could not materialize ANY preset:
`Cannot find package 'dsh-tool-symbol-index'` — the user presets
(`subagent-slim`, `subagent-worker`) carry a `dsh-tool-symbol-index` row, but the
**headless profile did not depend on that package** (only `web` did), so every
preset mount failed and every delegation in headless errored. Fixed by adding
`"dsh-tool-symbol-index": "link:/home/chaosbolt/dsh_subagents/dsh-tool-symbol-index"`
to `~/.dsh/profiles/headless/package.json` + the matching `node_modules` symlink
(mirroring the web profile). This is profile-level delivery, unrelated to the
route work but blocking it; the general rule is now in the plugin README: every
preset a crew role pins must be mountable from the profile that runs the
delegation.

### 12.7 Vendored as a public GitHub plugin

The plugin is published as its own repository (mirroring `dsh-tool-symbol-index`):
`https://github.com/chaosbolt99999/dsh-subagent-preset-in-process`.

- `LICENSE` (MIT), `README.md`, `SHARED-PATCH.md` and `IMPLEMENTATION-NOTES.md`
  (this document) ship in the repo;
- `dist/` and `lib/client.js` are COMMITTED (the repository is directly usable as
  a plugin bundle and as a `link:`/git dependency), and `npm run build`
  regenerates both;
- `scripts/build-client.mjs` encodes the browser-half build recipe that was
  previously manual (esbuild CJS + the `window.__ModuleLoader__` envelope, the
  in-factory `"use strict"`, and `__toESM(require("react"), 1)`) — the committed
  `lib/client.js` had silently drifted from `src/client.tsx` before this round.

### 12.8 Still open

- The running **web plane** keeps the plugin code loaded at its boot
  (2026-09-14 02:25): the fix reaches the GUI only after a `dsh web` restart
  (`~/.dsh/restart-web.sh`). Headless runs pick the rebuilt `dist/` immediately,
  which is how the verification above was performed.
- A full pipeline-crew live smoke (§9) is still outstanding; the gate loop remains
  unit-tested only.
