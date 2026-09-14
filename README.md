# dsh-subagent-preset-in-process

A DSH subagent backend that pins **every child agent** to a named **agent
preset** and routes every child through the plugin's resolved **settings**
(provider/model, editable live in Settings → Plugins) — with a request-level
`agentOptions` override on any delegating tool row or crew role. It is a Cordis
function plugin that registers a `SubagentProvider` on `ctx.subagents`, so the
shipped `tool-subagent` (or any custom tool) can delegate children that always
run under one composition regardless of the parent's preset. It also ships a
named-**crew** service (`ctx.crews`) — role-bound, continuously resident workers
with routed or deterministic-pipeline handoff — and a Settings → Plugins card.

## Install

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-subagent-preset-in-process": "link:/path/to/dsh-subagent-preset-in-process"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-subagent-preset-in-process"] } }
}
```

The package carries its own bundle patch (`cordis.patch.yml`), so adding it to
`dsh.profile.bundles` mounts the provider, the `subagent_preset` delegation tool
and the bundled `subagent-slim` preset. `dist/` and `lib/client.js` are committed
(and are what `main`/`exports` point at); rebuild them from source with
`npm install && npm run build`. Any preset a crew role pins must be mountable
from the profile that runs the delegation — a preset row importing a package
that is not a dependency of that profile fails at mount time, not at boot.

## Why

The shipped in-process backends (`spawn`, `fork`) inherit the **parent's**
preset (`composeFrom`) and the parent's model. There is no shipped backend that
mounts a *named* preset for a child. This plugin fills that gap: it mounts
`config.presetId` for every child (via `AgentPresets.mount`, not inheritance)
and resolves every child's route from the plugin's live resolved config.

## Model route — follows Settings

Every child — one-shot, continuable (`backgroundMode: continuable`), and crew
member — gets its provider/model from ONE place: the plugin's resolved settings
(composition base + the `subagent-preset-in-process` Settings namespace). A
Settings → Plugins edit applies to the next child with no restart. (On the
reference deployment the settings route is `merge/zai/glm-5.3-flash`; the
per-row / per-role overrides below are verified against exactly that, pinning
children to `merge/deepseek/deepseek-v4-flash-0731` instead.)

Route precedence (highest first):

1. **Request-level override** — `agentOptions` on the delegating `tool-subagent`
   row, on a crew role, or on a direct `ctx.subagents.start()` call
   (`provider`/`model`/`maxTokens`). Absent by default, so everything follows
   Settings; set it and only the fields you name are pinned.
2. **Plugin settings** — `provider`/`model`/`maxTokens` as resolved at start
   time.
3. **Parent inheritance** — any field still unresolved falls back to the
   parent's route via `resolveChildAgentOptions`.

Every path that builds a child route goes through one resolver
(`src/route.ts`), so the precedence cannot drift between them — the one-shot
path used to write the settings route *over* the request's, silently discarding
a row-level override (fixed; see "Route override" below).

Mechanics: one-shot runs resolve the route inside `start()`; continuable runs are
routed through the detached `ContinuableCreateSpec.agentOptions` returned by
`prepareContinuable()` (threaded by the shared-runtime patch — see
`SHARED-PATCH.md`), with the manager merging the request's own options OVER it,
and the EFFECTIVE route recorded in the durable descriptor so cold resume reuses
exactly what was used.

### Route override — the finer-grained knob

```yaml
# 1. per tool row: every child of THIS tool overrides Settings field by field
- id: tool-subagent-cheap
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: preset
    toolName: subagent_cheap
    agentOptions:
      model: gpt-5.6-luna        # provider still follows Settings

# 2. per crew role: only the verifier is pinned, everyone else follows Settings
crews:
  engineering:
    roles:
      - name: verifier
        presetId: subagent-slim
        roleTask: Verify the builder's result.
        agentOptions: { model: gpt-5.6-sol, maxTokens: 32000 }
```

Both shapes generalize per field: `agentOptions: { model: x }` pins only the
model. The legacy flat role fields (`provider`/`model`/`maxTokens`) remain as
per-field aliases; when both are present the nested `agentOptions` value wins.
`crew_status` reports each role's EFFECTIVE route (override over live settings),
so an override is verifiable without decoding session logs; the child's durable
`subagent/descriptor` records what it actually ran on.

## Behavior

`start(request)`:

1. Asserts the delegation depth and captures the parent's delegated policy.
2. Mints the child session id and its creation metadata, recording
   `meta.agentPreset = config.presetId` (the durable composition record, so a
   cold read reconstructs the child under the same tool set).
3. Creates the child with a forced `agentOptions` route and an **async** setup
   that `await`s `AgentPresets.mount(childCtx, presetId)`, then applies the
   delegation-scope statement, per-child persona, and tool filter.
4. Drives the child for one turn and reads its result.

Failures before publication reject `start()` (nothing published); post-publication
failures settle through `run.result`. A missing `agentPresets` roster or an
unknown `presetId` throws at mount — it never silently falls back to inheritance.

## Capabilities

Advertises `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`
and `inheritsParentContext = false`. `prepareContinuable` is present, so
`backgroundMode: continuable` children are supported.

## Config

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `preset` | Registry name on `ctx.subagents`. |
| `presetId` | *(optional)* | Default agent preset for non-crew children, and fallback composition. |
| `provider` | `deepseek-official` | Default child LLM provider — Settings → Plugins overrides live, and a request-level override wins over both. |
| `model` | `deepseek-v4-flash` | Default child model id — same precedence. |
| `maxTokens` | *(none)* | Optional default output-token cap — same precedence. |
| `maxDepth` | `3` | Delegation cap, or `'provider-managed'`. The EFFECTIVE cap is the tighter of this and the request's (a tool row always sends its own, default 3), so neither knob is silently discarded. |
| `crews` | `{}` | Named crews (see below). |

Role fields (inside `crews.<crew>.roles[]`): `name`, `presetId`, `roleTask`
(required); **`agentOptions`** (`provider`/`model`/`maxTokens` — the per-role
route override, see "Route override"); the legacy flat `provider`/`model`/
`maxTokens` (per-field aliases of it); **`toolFilter`** (`allow`/`deny`, see the
isolation warning below); `tasks` (structured task list); `description`.

Each crew entry:

```yaml
crews:
  engineering:
    mode: routed            # or pipeline (deterministic chain with verify-gate)
    orchestratorRole: orchestrator
    roles:
      - name: planner
        presetId: subagent-slim
        roleTask: Break the goal into ordered tasks.
        tasks:                               # structured task list per role
          - id: T1
            title: Implement login
            acceptanceCriteria: Tests pass on CI
            status: pending                  # pending | in_progress | done | failed | blocked
      - name: builder
        presetId: subagent-slim
        roleTask: Implement the assigned task.
      - name: verifier
        presetId: subagent-slim
        roleTask: Verify the builder's result.
    pipeline:                                # only for mode: pipeline
      order: [planner, builder, verifier]    # defaults to declaration order when omitted
      verifyGate:
        enabled: true
        verifierRole: verifier
        maxRetries: 3                        # block after this many fails for one task
```

## Crews

A **crew** is a named, ordered set of **roles** (e.g.
`planner <-> orchestrator <-> builder <-> verifier`). Each role is a
**continuable** subagent pinned to its own preset and optional model route, and
carries a `roleTask` delivered on every one of its turns plus an optional
structured `tasks` list (`id/title/acceptanceCriteria/status`) that handoffs
reference and the verifier gates.

- **Turn** = one inbox message to a role (the continuable-subagent FIFO inbox).
- **Task done** = the role's Activation settles (`stopReason` + closing output),
  the same settlement-notice the subagent service uses — the built-in "it will do
  no further work until you send it more" signal.
- **Routing** — two modes, additive on `crews[crew].mode` (default `routed`):
  - `routed` (default): the model (via `orchestrator` or `crew_handoff`) chooses
    the next role; the plugin enforces only same-crew + no self-handoff.
  - `pipeline`: an ordered chain driven by the plugin (`pipeline.order` else
    declaration order). `crew_handoff` must follow the deterministic successor;
    `crew_pipeline_advance` is the gate-aware handoff: a failing verifier loops
    back to its predecessor with the failure report, a passing verifier advances.
    The `verifyGate` (verifierRole, maxRetries, enabled) blocks after repeated
    failures and is reported by `crew_pipeline_status`/`crew_verify`.

Routed example (model chooses next role):

```yaml
subagent-preset-in-process:
  config:
    providerName: preset
    presetId: subagent-slim
    crews:
      engineering:
        mode: routed
        orchestratorRole: orchestrator
        roles:
          - name: planner
            presetId: subagent-slim
            roleTask: Break the goal into ordered tasks.
            model: deepseek-v4-pro
          - name: builder
            presetId: subagent-slim
            roleTask: Implement the assigned task.
          - name: verifier
            presetId: subagent-slim
            roleTask: Verify the builder's result.
```

Pipeline example (deterministic chain with verify-gate):

```yaml
subagent-preset-in-process:
  config:
    crews:
      engineering:
        mode: pipeline
        roles:
          - name: planner
            presetId: subagent-slim
            roleTask: Break the goal into ordered tasks.
            tasks:
              - id: T1
                title: Implement login
                acceptanceCriteria: Unit and integration tests pass
                status: pending
          - name: builder
            presetId: subagent-slim
            roleTask: Implement the task assigned to T1.
          - name: verifier
            presetId: subagent-slim
            roleTask: Verify T1 against its acceptanceCriteria; report pass/fail as structured verdict.
        pipeline:
          order: [planner, builder, verifier]
          verifyGate: { enabled: true, verifierRole: verifier, maxRetries: 3 }
```

### Preset isolation is NOT automatic on host-plane deployments (2026-08-27)

Mounting `subagent-slim` pins the composition, but on deployments where
`dsh-base` registers model-facing tools in the **host/global layer** (every
CLI/headless profile) a preset join is **additive**: the child still sees the
global registry, so without an explicit filter a "slim" role silently runs with
the parent's full tool set (36 tools in the 2026-08-26 crew run). This bit the
crews feature in live testing and is why every role — and the
`tool-subagent-preset` row — now carries a `toolFilter.allow` list in
`cordis.patch.yml`. Three rules learned the hard way:

1. `tools.restrict()` fails **loud** on names that are not global tools.
   `report` (the continuable child's reporting tool) is registered in the
   child's own layer by the subagent runtime and is EXEMPT from filtering — it
   must never appear in an allowlist, and children receive it regardless.
2. Both config surfaces must agree: `cordis.patch.yml` (composition base) AND
   `~/.dsh/settings.yaml` (Settings namespace, which overrides the base at
   runtime). Fixing only one still materializes roles with the stale filter.
3. `meta.agentPreset` in the session header is the durable *composition*
   record, not proof of isolation — verify the actual `request/header` tool
   list (or the descriptor's `toolFilter`) in the child's log.

### Live-testing fixes (2026-08-27)

Four bugs found by live headless crew testing (full diagnosis in
`IMPLEMENTATION-NOTES.md` §10, commit `725e98c`):

1. **Crew members were never tool-isolated** (above) — per-role `toolFilter`
   added and threaded through `materialize()`; recorded in the durable
   descriptor so cold resume reconstructs it.
2. **`crew_wait` fabricated `completed`** — `waitForSettlement` treated the
   pre-turn `idle` window as settled; it now re-arms the liveness read after a
   macrotask boundary, supports a `timeoutMs` bound (`timeout` stop reason),
   and `crew_wait` observes roles concurrently.
3. **One-shot `subagent_preset` ignored a per-request `presetId`** —
   `start()` now uses `request.presetId ?? config.presetId`.
4. **Live settings edits never reached crews** — `CrewService.reloadCrews()`
   runs on settings change; the next `materialize()` uses the new definitions
   (resident members keep their composition).

Unit tests at that point: **31/31** (`crew.spec 8` + `provider.spec 13` + `pipeline.spec 10`).

### Route-override round (2026-09-14)

The documented request-level override ("`agentOptions` on a `tool-subagent` row
or a crew role") was **not actually finished**, and its absence hid three bugs:

1. **A one-shot request-level override was silently discarded.** `start()` spread
   `request.agentOptions` and then wrote `config.provider`/`config.model` over
   it, so a row that pinned a model still ran on the settings model — the
   documented precedence (#1) was inverted for one-shot children (the
   continuable path was correct, so the same row behaved differently depending
   on whether the call ran in the foreground or as a background child). Fixed by
   one shared resolver (`src/route.ts`) used by every path.
2. **A request-level `maxDepth` was discarded whenever the config named a
   number** (`config.maxDepth ?? request.maxDepth`); the plugin's own setting had
   the same problem in reverse for crew members. Now the effective cap is the
   tighter of the two, so neither can silently override or widen the other.
3. **Crew roles had no `agentOptions` shape at all** — only flat
   `provider`/`model`/`maxTokens`. Roles now accept the canonical
   `agentOptions` object (flat fields kept as per-field aliases, nested wins),
   and `crew_status` reports the effective route per role and per live member,
   so a pin is verifiable without decoding session logs.
4. **A role that declared no `toolFilter` was denied every tool** (found live by
   the new end-to-end script, not by any unit test). Schemastery *materializes*
   an absent nested object: `CrewRoleSchema.toolFilter` resolved to
   `{ allow: [], deny: [] }`, and an empty allowlist makes `tools.restrict()`
   strip the child's whole tool set — the pinned child failed with
   `"the filter was authored for a different plane"`. The field now carries the
   same "preserve omission" guard the shipped `tool-subagent` row uses, so
   omitted **is** unscoped. Every deployment so far had declared a filter on
   every role, which is exactly why the missing-work round surfaced it.

Unit tests: **67/67** (`route.spec 17` + `crew.spec 17` + `provider.spec 23` +
`pipeline.spec 10`).

**Live end-to-end proof** (`scripts/verify-route-override.sh`, added this round)
— boots a real headless DSH with a `--patch` overlay adding (a) a second
`tool-subagent` row whose `agentOptions.model` differs from Settings and (b) a
two-role crew where only one role pins a model, then decodes the per-frame zstd
session logs and asserts the EFFECTIVE route of each child: the row child ran on
the override (not the Settings model) with the untouched Settings provider, the
pinned crew role ran on the override, and the un-pinned role stayed on Settings.

### The "registered but never delivered" tool (2026-09-14)

A preset-pinned child (`subagent_preset`) could not see a tool its own pinned
preset registers. The downstream plugin reported it as a harness/plugin defect,
because the row applied, `apply()` ran, `register()` returned, and the preset's
prompt section told the child to use the tool — while a sibling tool registered
by the *same* `apply()` arrived normally.

**The cause was this package's own bundle patch.** The `tool-subagent-preset`
row's `toolFilter.allow` in `cordis.patch.yml` listed
`bash, read, write, edit, glob, grep, read_image, crew_wait, todo_write` and did
not list `find_symbol`. A filter is a **global-tool mask**: `ToolRuntime.view()`
admits an inherited name only when every layer on the child's chain admits it, so
an omitted name is removed from the child's catalog even though the preset
registered it two layers away. `grep` and `glob` arrived because they were on the
list; the named tool did not because it was not. Renaming the tool could not help
either — the list names `find_symbol`, so a renamed registration is still
unnamed by it.

Why the layer went unexamined: **every allow/deny list outside this file already
named it.** `settings.yaml`'s crew lists name it, the agent presets name it, and
the plugin's settings namespace (`subagent-preset-in-process`) covers
provider/preset/route/crews but **not** this tool row — so no Settings edit could
surface it, and the row's config is composed from the bundle patch at boot.

Two checks pin it, neither requiring a running process or a unit test:

| check | how | result |
| --- | --- | --- |
| differential | same preset, plane and process; the crew role's allow-list names `find_symbol` and the `subagent_preset` row's does not | crew role: tool present and answering; `subagent_preset` child: absent |
| static | `node scripts/render-composition.mjs web tool-subagent-preset` | prints the composed `allow` array — the omitted name is visible in it |

The fix adds `find_symbol` to that list and to all four crew lists in the patch;
the lists in the patch are now the deployment default for a fresh install, while
`settings.yaml` continues to override the crews. A bundle patch is composed at
boot, so the change needs a restart to take effect.

Worth stating plainly for the next reader: the harness-side cross-plane fixes
(`restrictableNames()` + the scoped vantage in `sanitizePresetChildToolFilter`)
are what make a filter that names tools a plane does not register *clip* instead
of failing the delegation loudly. They were necessary for the over-broad lists
here — and they were never the reason a correctly-registered tool was invisible.

### Harness-independent preset pinning (2026-09-14)

Pinning a child to a named preset used to be a **harness** capability. A
provider's only lever over a continuable child's composition is data in
`ContinuableCreateSpec`, and that spec carries `{ seed? }` — deliberately, since
"the continuation manager owns the child's whole lifecycle after preparation".
So the capability was carried as a local harness patch (a `presetId` field plus a
mount path in the continuation manager), which meant this plugin could not run
against an unpatched harness and could not be used together with a `git pull`.

It is now entirely plugin-side (`src/pin.ts`), through two public seams:

| seam | what it provides |
| --- | --- |
| `agentPresets.recompose(agentCtx, presetId)` | re-links a composed agent to another preset's standing mount **through the binding the roster itself kept**, so it works on a child that already joined its parent — the continuable child. It *re-links* rather than adds, so the pinned composition replaces the inherited one instead of piling on top of it |
| `agent/session-start` + `agent/pre-step` | the child's `Agent` before its first turn, and an AWAITED waterfall, so the re-link completes before the request that assembles the child's catalog |

The one-shot path composes with `applyChildComposition` — which is what carries
the harness's own delegation-context statement and per-child persona, whose text
is not re-exported, so calling the harness keeps this drift-free — and then
re-links, before any turn runs.

The **filter is applied by the plugin, after the re-link**, clipped to the names
the child's final composition actually provides. Two reasons: a tool filter is
validated against the viewing scope's names and fails loud on an unknown one, and
the scope that matters is the one the child ENDS UP on. That also makes the new
`toolFilter` plugin setting the recommended home for a delegating row's list: a
filter on the tool row is validated against the *parent's* composition at
creation, which is plane-dependent — the exact trap the `find_symbol` incident
came from.

**What is honestly lost** relative to the harness patch:

1. **The durable header records the preset the harness composed at creation**
   (the parent's), because the header is written before the re-link. Composition
   and cold resume are unaffected — the listeners re-derive the pin from the
   child's own `subagent/descriptor` (`provider`, plus the `crew:<crew>:<role>`
   label) — but session listings and telemetry show the parent's preset.
2. **A brief composition window** between creation and the re-link, in which the
   child exists on the parent's composition. No turn runs in that window.
3. The settings-driven route reaches a continuable child only through the row's
   `agentOptions` (upstream behavior), not through the provider's detached spec.

Everything else is preserved: crew members, per-role routes, per-role filters,
cold resume, and the one-shot path. `src/provider.ts` no longer imports any
harness symbol that is not part of the released package, so the plugin builds and
runs against an unpatched checkout.

### Generation drift: three shims, and why they exist

This package compiles against its vendored `@deepseek-ai` copies while it RUNS
against whatever harness serves it. Every seam that moved between those two
generations fails at runtime while type-checking cleanly against the stale
`.d.ts`, so each one was found by a live failure rather than by `tsc`:

| seam | vendored copy | current harness | shim |
| --- | --- | --- | --- |
| settings registration | free `installSettingsSection()` + `settingsNamespace()` | `settings.installSection(owner, ns, schema, entry, hooks)` | `installSettings()` prefers the method, dynamic-imports the old helper, reports if neither exists |
| child session meta | `childSessionMeta(parent, depth, lineageSeedLength: number)` emitting `seedLength` | `childSessionMeta(parent, depth, isSeeded: boolean)`; the header REJECTS `seedLength` | `childMeta()` normalizes the one moved field |
| turn delivery | `subagents.followup(parent, childId, content, options)` | `subagents.sendMessage(sender, targetId, content, options)` | `deliverTurn()` accepts both, modern name first |

All three are covered by unit tests, and every other helper the plugin imports
was signature-diffed against the current harness (`applyChildComposition`,
`captureDelegatedPolicyOverrides`, `appendDelegatedPolicyOverrides`,
`resolveChildDepth`, `resolveChildAgentOptions`, `assertSubagentMaxDepth`,
`finalAssistantOutput`, `foldConsumedWork`, `createUserMessage`,
`validateJsonSchemaValue` — all identical).

The durable fix is to refresh the vendored copies so the compile-time types match
the generation that runs; until then, treat a missing runtime symbol as the
expected failure mode of a harness update, and prefer an explicit shim over a
direct call so both generations keep working.

### Crew tools

The plugin registers these model-facing tools over `ctx.crews`:

- `crew_materialize(crew)` — start every role as a resident worker (idempotent).
- `crew_handoff(crew, from_role, to_role, task)` — deliver one role's work to the
  next role as its next turn. In `pipeline` mode the `to_role` must be the
  deterministic successor (verifier may loop to predecessor on failure).
- `crew_pipeline_advance(crew, from_role, task, task_id?, verifier_verdict?, evidence?)` — deterministic pipeline handoff that respects the verify-gate (pass advances, fail loops with retry counting, `maxRetries` blocks). Handoffs carry `task_id + evidence`; the gate updates task status.
- `crew_pipeline_status(crew)` — read the pipeline cursor, verify-gate config and per-role structured tasks.
- `crew_task_update(crew, role, task_id, status?, title?, description?, acceptanceCriteria?)` — edit one structured task.
- `crew_verify(crew, task_id, passed, evidence?)` — record a verifier's structured pass/fail (updates task, computes loop/next/retries without delivering a turn).
- `crew_wait(crew, role?)` — **block the current turn** until a role (or every
  role when omitted — observed concurrently) settles, then return each stop
  reason + closing output. Correctly waits out the pre-turn `idle` window (a
  role that was just handed work is not reported `completed`), and stops
  waiting on abort or after an optional timeout. This replaces `sleep N` +
  `list_agents` polling: it wakes the moment the role reports done.
- `subagent_wait(subagent_id)` — the same indefinite wait for any continuable
  child by id.
- `crew_status()` — list crews, roles, orchestrator, `mode`, the **effective
  per-role routes** (`routes`) and live `members` with the route each was
  materialized on, plus pipeline `order`/`verifyGate`/cursor and `tasks`.

### Continuable preset pinning + routing

Continuable children (crew members and `backgroundMode: continuable` through a
`tool-subagent` instance) are composed by the subagent continuation manager, not
by this plugin's provider. Pinning them to `presetId` and giving them the
settings route therefore requires a small additive change to
`@deepseek-ai/dsh-subagent` (see `SHARED-PATCH.md`). With that patch:

- `request.presetId` (per-role) and `prepareContinuable().presetId`
  (provider-level) are mounted instead of inheriting the parent's preset, and
  the pinned preset survives cold resume via the durable session header.
- `prepareContinuable().agentOptions` carries the settings-derived route,
  merged UNDER any caller-supplied request options; the effective route is what
  the durable descriptor records, so cold resume reuses it.

Applied as source edits to a run-from-source checkout
(`/home/chaosbolt/deepseek-harness`, release 0.1.1-rc.2) on 2026-08-26; rebuild
host libs (`pnpm run build:lib:host`) after applying, then restart DSH.

## Wiring

```yaml
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    roots:
      - path: !!js new URL('./agent-presets', import.meta.url).pathname
        trust: system

- id: subagent-preset-in-process
  name: 'dsh-subagent-preset-in-process'
  config:
    providerName: preset
    presetId: subagent-slim
    provider: merge                                # base route only; Settings overrides live
    model: deepseek/deepseek-v4-flash-0731

- id: tool-subagent-preset
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: preset
    toolName: subagent_preset
    backgroundMode: continuable
    # agentOptions: { model: deepseek/deepseek-v4-flash-0731 }   # per-row override
```

The provider row is **host-plane** (registered once, like `spawn`/`fork`); the
`tool-subagent` row is a model-facing delegation tool and belongs in the
preset's `delegation` group on the Web plane, or directly added on the
headless/base plane. The crew tools are registered by this plugin's own
`apply`, layered over `ctx.crews`.

## Child preset

The bundled `agent-presets/subagent-slim/` is a minimal agent-plane composition
(persona + `bash` + `fs` + `fs-search`). See its `agent.cordis.yml` for the
two-plane rules (service rows need an `isolate` realm; plain tool registrations
do not).

## Development

```bash
npm install              # typescript, vitest, esbuild, @types/node
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run build            # tsc -> dist/ + scripts/build-client.mjs -> lib/client.js
npm run verify:override  # live headless end-to-end proof of the route override
npm run verify:route     # live headless proof of preset pinning + settings routes
```

`scripts/verify-route-override.sh` boots a real headless DSH with a `--patch`
overlay (a pinned `tool-subagent` row + a two-role crew where only one role pins
a model), then decodes the per-frame `zstd` session logs and asserts each child's
EFFECTIVE route. It needs a working profile and model credentials; it writes its
overlay and logs under `/tmp/route-override-workspace`.

## Agent Note

**What changed** — added a self-contained `subagent-preset-in-process` backend
that composes every child under a named agent preset and a fixed model route,
plus a named-**crew** service (`ctx.crews`) and control tools that materialize
role-bound continuable members (planner/orchestrator/builder/verifier) and route
per-turn handoffs between them. It reuses the exported `@deepseek-ai/dsh-subagent`
helpers (`childSessionMeta`, `captureDelegatedPolicyOverrides`,
`appendDelegatedPolicyOverrides`, `resolveChildAgentOptions`, `resolveChildDepth`,
`finalAssistantOutput`) and `AgentPresets.mount` from `@deepseek-ai/dsh-agent-presets`,
and reimplements the small driver-local drive/read/structured logic that the
shared in-process driver does not export.

**Why this shape** — the shared driver (`subagent-in-process-driver`) hardcodes
parent inheritance and does not export its drive/read/structured internals, so a
preset-pinning backend either extends that shared package (a source-repo change)
or stands alone. Standing alone keeps the plugin deployable into an installed
DSH without touching shared code; the duplicated drive/read logic is ~40 lines
and mirrors the driver's behavior exactly.

**Crew vs the built-ins** — crews are deliberately built on the continuable
subagent turn model (`startContinuable`/`followup`, inbox = one FIFO turn,
settlement notice = "done") rather than the `goal`/`workflow`/`todo` primitives:
goals are one-per-session with model-claimed completion, workflows are explicit
foreground fan-out scripts, and todo is single-owner advisory state. A crew needs
many durable role sessions that each hand off by turn, which only the continuable
path provides. Routing is hybrid (model/orchestrator chooses the next role; the
plugin enforces role scoping, preset pinning, and no self-handoff), matching the
reviewed third-party prior art (`dsh-crew` tier presets, `dsh-forge`
`spawn_model_subagent`) but as a minimal declarative `ctx.crews` backend.

**Behavioral impact** — none on existing providers; only children delegated
through the new `preset` provider (or crew members) are pinned. Model-visible ==
logged: each child's `meta.agentPreset` is the durable composition record, and
the descriptor is appended in the child's first turn; each crew handoff is a
`followup` turn with a `coordinator` message source.

**Verification** — `tsc --noEmit` clean; 67/67 unit tests pass (Config defaults +
crew parsing incl. per-role toolFilter and per-role `agentOptions`, capability
advertisement, `inheritsParentContext`, registry name, `prepareContinuable` spec
= pinned presetId + settings-derived route incl. live route changes and
maxTokens passthrough, pre-publication abort, per-request `presetId` override in
`start()`, **request-level route precedence: field-by-field override over the
settings route for one-shot `start()` and for crew materialization, legacy flat
role aliases, maxTokens inheritance when no source caps it, depth-cap
tightening, and schema-omission guards** (`toolFilter`/`agentOptions` stay absent
rather than becoming an empty allowlist), crew role/orchestrator resolution,
self-handoff and unknown-crew rejection, `reloadCrews` live-settings tests, plus
10 pipeline/task/verify-gate tests for order, next/prev, task status, verify
pass/fail, retry/block and handoff enforcement). The harness subagent workspaces
pass 1051/1051 with the shared-runtime patch applied.

**Live end-to-end (2026-09-14)** — `scripts/verify-route-override.sh` passes
(EXIT=0): the pinned row's one-shot child ran on `merge/deepseek/deepseek-v4-flash-0731`
while Settings said `merge/zai/glm-5.3-flash`; the crew role carrying
`agentOptions.model` ran on the override; its sibling role without one stayed on
Settings; both roles settled `completed`. The SAME test fails on the pre-fix
provider (`the one-shot child of the pinned tool row never ran on …`), which is
the regression this round fixed. A parallel run of the deployment's own
`engineering` crew (settings config, per-role `toolFilter`, no route overrides)
materialized all four roles on `merge/zai/glm-5.3-flash` — the override does not
leak into un-overridden children.

**Run-from-source web smoke (2026-08-26)** — DSH booted from a source checkout
(`pnpm dsh web`, release 0.1.1-rc.2) with this plugin linked into the `web`
profile. A continuable `subagent_preset` delegation produced child
`fb691986…`: durable session header `agentPreset: "subagent-slim"` +
`delegationDepth: 1`; descriptor `provider: preset, mode: continuable,
agentProvider: custom2, agentModel: x-preview-f-free`; request header on the
same route; 18-tool slim worker toolset (not the parent's 35); turn completed
with the expected sentinel reply. An earlier child (`98427cd8…`) before the
settings-route change showed the same pinning but the old static
`test/deepseek-v4-flash` route (upstream 401 out-of-credits), which is what
motivated settings-driven routing.

**Headless different-model smoke (keyed, `scripts/verify-headless-different-model.sh`)** — boots a headless DSH instance that delegates via `subagent_preset` (one-shot file write) and via `crew_materialize` (four roles). The script then decompresses per-frame `zstd` session logs and asserts:
- parent `request/header` contains `PARENT_MODEL_SUBSTR`,
- child `subagent/descriptor` `$EXPECTED_CHILD_PROVIDER/$EXPECTED_CHILD_MODEL` + `agentPreset: subagent-slim` + matching `request/header` (subagent-slim persona),
- crew members on the same route + preset,
and that the delegated file was written and the parent received the child's `completed` output. Expectations are env-overridable; **defaults now reflect the current deployment** (`EXPECTED_CHILD_PROVIDER=merge`, `EXPECTED_CHILD_MODEL=deepseek/deepseek-v4-flash-0731`, `PARENT_MODEL_SUBSTR=glm`). The harness CLI is invoked through `DSH_BIN` (default `pnpm --dir /home/chaosbolt/deepseek-harness dsh` — no global `dsh` binary exists). Note: a headless run launched via `pnpm --dir <checkout>` logs under the checkout's ProjectKey (`--home-chaosbolt-deepseek-harness--`), not the workspace key, because pnpm changes cwd.

**Crews live-test round (2026-08-27, post-fix)** — routed crew
(`crew_status → crew_materialize → crew_handoff planner→orchestrator "Reply
with the single word ACK" → crew_wait`) completed end to end; orchestrator
settled `completed` with output exactly `ACK`. One-shot `subagent_preset`
wrote the marker file with a 9-tool slim set. Every child verified from its
per-frame-decoded log: header `agentPreset: subagent-slim` + `delegationDepth:
1`, descriptor route `merge/deepseek-v4-flash-0731` (plus the role's
`toolFilter.allow`), and role-scoped tool lists (planner/orchestrator 14,
builder 12, verifier 13, one-shot 9). The pre-fix run of the same test showed
the 36-tool leak that motivated the `toolFilter` work (IMPLEMENTATION-NOTES.md §10.1).
