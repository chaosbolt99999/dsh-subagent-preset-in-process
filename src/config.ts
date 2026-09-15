import z from '@deepseek-ai/schemastery'

/**
 * Configuration for the preset-pinning subagent backend.
 *
 * `providerName` is the name this backend registers on `ctx.subagents`; a
 * `tool-subagent` instance points at it via `provider`. `presetId` is the
 * agent preset every (non-crew) child is composed under, and the fallback
 * composition when a crew role names none. `provider`/`model`/`maxTokens`
 * force the child's model route; `maxDepth` caps delegation recursion (a
 * number requires the provider's `depthLimit` capability, which it advertises)
 * or hands the budget to the child runtime with `'provider-managed'`.
 *
 * `crews` is an optional named-crew map. Each crew is a role-ordered set of
 * continuable members (planner <-> orchestrator <-> builder <-> verifier);
 * every role is pinned to its own `presetId` and optional model route, and
 * carries a `roleTask` statement delivered on each of its turns.
 */

/** One structured task in a role's task list. */
export const TaskSchema = z.object({
  id: z.string().required().description('Stable task id (used for handoff evidence and gate checks).'),
  title: z.string().required().description('Short task title.'),
  description: z.string().description('Longer task description.'),
  acceptanceCriteria: z.string().description('Acceptance criteria checked by the verifier gate.'),
  status: z
    .union([z.const('pending'), z.const('in_progress'), z.const('done'), z.const('failed'), z.const('blocked')])
    .default('pending')
    .description('Current task status.'),
})

export type Task = ReturnType<typeof TaskSchema>

/** A crew role's per-role model-route override (the request-level knob). */
export const RoleAgentOptionsSchema = z.object({
  provider: z.string().description('Role LLM provider override.'),
  model: z.string().description('Role model override.'),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .description('Role output-token cap override.'),
})

/** One role in a crew. */
export const CrewRoleSchema = z.object({
  name: z.string().required().description('Stable role name (planner/orchestrator/builder/verifier).'),
  presetId: z.string().required().description('Agent preset this role is composed under.'),
  // Prevent Schemastery from materializing an omitted agentOptions as `{}`
  // (same guard the shipped `tool-subagent` row uses for its own field).
  agentOptions: RoleAgentOptionsSchema.default(undefined as unknown as { provider: string; model: string; maxTokens: number })
    .description('Per-role model-route override (provider/model/maxTokens); wins over the plugin settings field by field.'),
  provider: z.string().description('Per-role model-provider override (legacy alias of agentOptions.provider).'),
  model: z.string().description('Per-role model override (legacy alias of agentOptions.model).'),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .description('Per-role output-token cap (legacy alias of agentOptions.maxTokens).'),
  toolFilter: z
    .object({
      allow: z.array(z.string()).description('Global tool names the role keeps; everything else is removed.'),
      deny: z.array(z.string()).description('Global tool names removed from the role.'),
    })
    // Preserve omission. Schemastery otherwise MATERIALIZES an absent nested
    // object as `{ allow: [], deny: [] }`, and an empty allowlist means
    // `tools.restrict()` removes every tool — the child then fails loud with
    // "allows no tool known to this deployment" (or silently loses its whole
    // tool set on planes where the restrict is clipped). A role that names no
    // filter must mean "no scoping", not "deny everything".
    .default(undefined as unknown as { allow: string[]; deny: string[] })
    .description('Optional role tool scoping (allow and/or deny). Omitted = no scoping; the required capability is always advertised.'),
  roleTask: z.string().required().description('Task statement delivered on every turn.'),
  description: z.string().description('Human-facing role description.'),
  tasks: z.array(TaskSchema).default([]).description('Structured task list for this role; gate checks the verifier against these.'),
})

export const CrewPipelineSchema = z
  .object({
    order: z.array(z.string()).default([]).description('Explicit pipeline order; defaults to declaration order when empty.'),
    verifyGate: z
      .object({
        enabled: z.boolean().default(true).description('When true, the verifier must pass before the pipeline advances.'),
        verifierRole: z.string().default('verifier').description('Role whose structured pass/fail gates the pipeline.'),
        maxRetries: z.number().step(1).min(0).max(20).default(3).description('Max verifier failures before the pipeline blocks.'),
      })
      .default({ enabled: true, verifierRole: 'verifier', maxRetries: 3 })
      .description('Verify-gate config.'),
  })
  .default({ order: [], verifyGate: { enabled: true, verifierRole: 'verifier', maxRetries: 3 } })
  .description('Pipeline-mode order and gate.')

export const CrewSchema = z.object({
  orchestratorRole: z.string().description('Role that routes handoffs (default: orchestrator, else first role).'),
  mode: z.union([z.const('routed'), z.const('pipeline')]).default('routed').description("Crew routing mode: 'routed' (model chooses next role) or 'pipeline' (ordered chain with verify-gate)."),
  roles: z.array(CrewRoleSchema).description('Ordered role chain.'),
  pipeline: CrewPipelineSchema,
})

export const CrewsSchema = z.dict(CrewSchema).default({}).description('Named crews of role-bound workers.')

/**
 * One named, callable preset: the composition a `subagent_preset` call selects.
 *
 * Every field except `presetId` is optional and falls back to the plugin's
 * top-level value field by field, so a deployment can name several presets and
 * give only the interesting one its own route, filter, or persona.
 */
export const PresetEntrySchema = z.object({
  presetId: z.string().required().description('Agent preset this name composes children under.'),
  description: z.string().description('Model-facing hint for when to choose this preset (shown in the tool description).'),
  provider: z.string().description('Model provider for children of this preset (wins over the top-level provider).'),
  model: z.string().description('Model id for children of this preset (wins over the top-level model).'),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .description('Output-token cap for children of this preset (wins over the top-level maxTokens).'),
  persona: z.string().description('Per-child persona for this preset, shadowing the deployment persona.'),
  toolFilter: z
    .object({
      allow: z.array(z.string()).description('Global tool names children of this preset keep.'),
      deny: z.array(z.string()).description('Global tool names removed from children of this preset.'),
    })
    // Same omission guard as every other filter in this file: Schemastery would
    // otherwise MATERIALIZE an absent nested object as `{ allow: [], deny: [] }`,
    // and an empty allowlist strips the child's whole tool set.
    .default(undefined as unknown as { allow: string[]; deny: string[] })
    .description('Optional tool scoping for children of this preset. Omitted = fall back to the top-level filter.'),
})

export type PresetEntry = ReturnType<typeof PresetEntrySchema>

/**
 * The plugin's own `subagent_preset` delegation tool.
 *
 * This tool exists so the PRESET is a call argument rather than a fixed
 * deployment setting. The shipped `tool-subagent` consumer cannot express that:
 * its schema exposes only `description`/`prompt`/`run_in_background` (plus the
 * optional model-selection triple), and `SubagentStartRequest` carries no
 * `presetId` on an unpatched harness — so a `tool-subagent` row can only ever
 * pin the one preset its `provider` was registered with.
 *
 * The plugin registers one provider instance per configured preset and this
 * tool dispatches to the right one.
 */
export const PresetToolSchema = z
  .object({
    enabled: z.boolean().default(true).description('Register the plugin-owned preset-selecting delegation tool.'),
    toolName: z.string().default('subagent_preset').description('Model-facing tool name.'),
  })
  .default({ enabled: true, toolName: 'subagent_preset' })
  .description('The plugin-owned delegation tool whose `preset` argument selects the composition.')

/**
 * The plugin's composition-time `Config` (same shape as the settings schema).
 *
 * `provider`/`model`/`maxTokens` are the DEFAULT child route. A request-level
 * `agentOptions` — on a `tool-subagent` row, on a direct `ctx.subagents.start()`
 * call, or on a crew role — overrides them field by field (see `src/route.ts`).
 *
 * `presetId` is the composition every child gets when the caller names no
 * preset; `presets` adds NAMED alternatives, each registering its own provider
 * instance (registry name `<providerName>:<name>`) and selectable per call
 * through the `preset` argument of the tool configured by `presetTool`.
 */
export const Config = z.object({
  providerName: z.string().default('preset').description('Registry name on ctx.subagents.'),
  presetId: z.string().description('Agent preset every non-crew child is composed under.'),
  provider: z.string().default('deepseek-official').description('Default child LLM provider (a request-level agentOptions override wins).'),
  model: z.string().default('deepseek-v4-flash').description('Default child model id (a request-level agentOptions override wins).'),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .description('Optional default output-token cap (a request-level agentOptions override wins).'),
  maxDepth: z
    .union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')])
    .default(3)
    .description("Delegation depth cap, or 'provider-managed'. The effective cap is the tighter of this and the request's."),
  crews: CrewsSchema,
  presets: z.dict(PresetEntrySchema).default({}).description('Named callable presets; each registers its own provider instance and is selectable through the `preset` argument of the plugin-owned delegation tool.'),
  presetTool: PresetToolSchema,
  toolFilter: z
    .object({
      allow: z.array(z.string()).description('Global tool names every pinned child keeps; everything else is removed.'),
      deny: z.array(z.string()).description('Global tool names removed from every pinned child.'),
    })
    // Same omission guard as the crew roles: Schemastery materializes an absent
    // nested object as `{ allow: [], deny: [] }`, and an empty allowlist would
    // strip the child's whole tool set.
    .default(undefined as unknown as { allow: string[]; deny: string[] })
    .description('Optional filter applied to every child this provider pins. The PLUGIN applies it after the child is re-linked to its preset, so it is validated against the composition the child actually ends up on and never trips the harness fail-loud unknown-name validation. A filter on the delegating TOOL ROW is validated against the parent composition at creation, which is plane-dependent — move that list here to make the deployment independent of the harness.'),
})

export type Config = ReturnType<typeof Config>
