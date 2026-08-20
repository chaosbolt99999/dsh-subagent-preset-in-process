# dsh-subagent-preset-in-process

A DSH subagent backend that pins **every child agent** to a named **agent
preset** and a fixed **model route** (`deepseek-v4-flash` by default). It is a
Cordis function plugin that registers a `SubagentProvider` on `ctx.subagents`,
so the shipped `tool-subagent` (or any custom tool) can delegate children that
always run under one composition regardless of the parent's preset.

## Why

The shipped in-process backends (`spawn`, `fork`) inherit the **parent's**
preset (`composeFrom`) and the parent's model. There is no shipped backend that
mounts a *named* preset for a child. This plugin fills that gap: it mounts
`config.presetId` for every child (via `AgentPresets.mount`, not inheritance)
and forces `config.provider`/`config.model` on the child's `agentOptions`.

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
| `provider` | `deepseek-official` | Default child LLM provider. |
| `model` | `deepseek-v4-flash` | Default child model id. |
| `maxTokens` | *(none)* | Optional default output-token cap. |
| `maxDepth` | `3` | Numeric delegation cap, or `'provider-managed'`. |
| `crews` | `{}` | Named crews (see below). |

## Crews

A **crew** is a named, ordered set of **roles** (e.g.
`planner <-> orchestrator <-> builder <-> verifier`). Each role is a
**continuable** subagent pinned to its own preset and optional model route, and
carries a `roleTask` delivered on every one of its turns.

- **Turn** = one inbox message to a role (the continuable-subagent FIFO inbox).
- **Task done** = the role's Activation settles (`stopReason` + closing output),
  the same settlement-notice the subagent service uses — the built-in "it will do
  no further work until you send it more" signal.
- **Routing** = hybrid: the model (via the `orchestrator` role or `crew_handoff`)
  decides the next role; the plugin enforces scoping (roles, presets, no
  self-handoff) and records each handoff.

```yaml
subagent-preset-in-process:
  config:
    providerName: preset
    presetId: subagent-slim
    provider: deepseek-official
    model: deepseek-v4-flash
    crews:
      engineering:
        orchestratorRole: orchestrator
        roles:
          - name: planner
            presetId: subagent-slim       # or a dedicated planner preset
            roleTask: Break the goal into ordered tasks and hand them to the orchestrator.
            model: deepseek-v4-pro        # optional per-role route override
          - name: orchestrator
            presetId: subagent-slim
            roleTask: Route each task to the right role and track completion.
          - name: builder
            presetId: subagent-slim
            roleTask: Implement the assigned task and report the result.
          - name: verifier
            presetId: subagent-slim
            roleTask: Verify the builder's result against the task and report.
```

### Crew tools

The plugin registers these model-facing tools over `ctx.crews`:

- `crew_materialize(crew)` — start every role as a resident worker (idempotent).
- `crew_handoff(crew, from_role, to_role, task)` — deliver one role's work to the
  next role as its next turn. The target role then runs **its** task turn and
  settles; the orchestrator (or model) reads the settlement and hands off again.
- `crew_wait(crew, role?)` — **block the current turn** until a role (or every
  role when omitted) settles, then return each stop reason + closing output.
  This replaces `sleep N` + `list_agents` polling: it wakes the moment the role
  reports done, so it stays correct no matter how long the task runs.
- `subagent_wait(subagent_id)` — the same indefinite wait for any continuable
  child by id.
- `crew_status()` — list crews, roles, and each crew's orchestrator role.

### Continuable preset pinning

Continuable children (crew members and `backgroundMode: continuable` through a
`tool-subagent` instance) are composed by the subagent continuation manager, not
by this plugin's provider. Pinning them to `presetId` therefore requires a small
additive change to `@deepseek-ai/dsh-subagent` (see `SHARED-PATCH.md`). With that
patch, `request.presetId` (per-role) and `prepareContinuable().presetId`
(provider-level) are mounted instead of inheriting the parent's preset, and the
pinned preset survives cold resume via the durable session header.

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
    provider: deepseek-official
    model: deepseek-v4-flash

- id: tool-subagent-preset
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: preset
    toolName: subagent_preset
    backgroundMode: continuable
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
npm install            # installs typescript, vitest, @types/node + peers
npx tsc --noEmit       # typecheck
npx vitest run         # unit tests
npx tsc                # emit dist/
```

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

**Verification** — `tsc --noEmit` clean; 14/14 unit tests pass (Config defaults +
crew parsing, capability advertisement, `inheritsParentContext`, registry name,
seedless `prepareContinuable`, pre-publication abort, crew role/orchestrator
resolution, self-handoff and unknown-crew rejection). A full keyless
ground-truth run was not possible in the authoring environment (no monorepo test
kit or keyed model route).
