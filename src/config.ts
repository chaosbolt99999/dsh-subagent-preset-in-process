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
  roleTask: z.string().required().description('Task statement delivered on every turn.'),
  description: z.string().description('Human-facing role description.'),
})

export const CrewSchema = z.object({
  orchestratorRole: z.string().description('Role that routes handoffs (default: orchestrator, else first role).'),
  roles: z.array(CrewRoleSchema).description('Ordered role chain.'),
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
