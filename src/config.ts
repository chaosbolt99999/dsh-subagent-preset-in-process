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

/** One role in a crew. */
export const CrewRoleSchema = z.object({
  name: z.string().required().description('Stable role name (planner/orchestrator/builder/verifier).'),
  presetId: z.string().required().description('Agent preset this role is composed under.'),
  provider: z.string().description('Optional role model-provider override.'),
  model: z.string().description('Optional role model override.'),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .description('Optional role output-token cap.'),
  toolFilter: z
    .object({
      allow: z.array(z.string()).description('Global tool names the role keeps; everything else is removed.'),
      deny: z.array(z.string()).description('Global tool names removed from the role.'),
    })
    .description('Optional role tool scoping (allow and/or deny). Required capability is always advertised.'),
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

/** The plugin's composition-time `Config` (same shape as the settings schema). */
export const Config = z.object({
  providerName: z.string().default('preset').description('Registry name on ctx.subagents.'),
  presetId: z.string().description('Agent preset every non-crew child is composed under.'),
  provider: z.string().default('deepseek-official').description('Default child LLM provider.'),
  model: z.string().default('deepseek-v4-flash').description('Default child model id.'),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .description('Optional default output-token cap.'),
  maxDepth: z
    .union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')])
    .default(3)
    .description("Delegation depth cap, or 'provider-managed'."),
  crews: CrewsSchema,
})

export type Config = ReturnType<typeof Config>
