/**
 * The plugin-owned delegation tool whose `preset` argument selects the
 * composition a child is composed under.
 *
 * WHY A SEPARATE TOOL. The shipped `tool-subagent` consumer cannot express "use
 * preset X" per call: its schema exposes only `description`/`prompt`/
 * `run_in_background` (plus the optional model-selection triple), and
 * `SubagentStartRequest` carries no `presetId` on an unpatched harness. A
 * `tool-subagent` row therefore pins exactly the one preset its `provider`
 * instance was registered with, which is why the PRESET had to be a deployment
 * setting rather than a call argument.
 *
 * THE MECHANISM. `ctx.subagents` is a provider REGISTRY, not a single provider,
 * and the provider NAME is the one thing a caller may select per delegation. So
 * this plugin registers one provider instance per configured preset (`preset`,
 * `preset:<name>`) and this tool maps the `preset` argument to a registry name.
 * No harness change, no capability flag, and the same start paths the shipped
 * consumer uses.
 *
 * @module @dsh-subagent-preset-in-process/preset-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { resolveRoute } from './route.js'
import type { Config, PresetEntry } from './config.js'

/** One selectable preset, resolved at call time. */
export interface PresetChoice {
  /** The registry name of the provider instance that composes this preset. */
  readonly providerName: string
  /** The agent preset id it composes. */
  readonly presetId: string
  /** Optional model-facing hint for when to choose it. */
  readonly description?: string
}

/** Dependencies the tool reads; injected so tests need no live harness. */
export interface PresetToolDeps {
  /** Model-facing tool name. */
  readonly toolName: string
  /** Live resolved plugin config. */
  readonly readConfig: () => Config
  /** The selectable presets, in registration order. */
  readonly choices: () => readonly PresetChoice[]
}

/** A rendered delegation result; both shapes are plain, lossless JSON. */
export interface DelegationResult {
  readonly kind: 'continuable' | 'foreground'
  /** Present when `kind` is `continuable`. */
  readonly subagentId?: string
  /** Present when `kind` is `foreground`. */
  readonly runId?: string
  /** The child's closing output, joined to text. Present when `foreground`. */
  readonly text?: string
}

/** The caller-supplied arguments, after narrowing. */
interface DelegationArgs {
  readonly description: string
  readonly prompt: string
  readonly preset?: string
  readonly run_in_background?: boolean
}

/** Join the text blocks of a content-block list into one string. */
function textOf(blocks: readonly { type?: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Resolve the `preset` argument to a registry name.
 *
 * Validated at CALL time rather than expressed as a schema `enum` on purpose:
 * the schema is part of every caller's request prefix, so baking the preset
 * names into it would make adding one preset silently invalidate the cached
 * prefix of every session that mounts this tool. A call-time check fails loud
 * with the valid names instead.
 * @param name - the caller's `preset` argument, or undefined for the default.
 * @param config - live resolved plugin config.
 * @returns the registry name of the provider instance to use.
 * @throws when the name is not a configured preset.
 */
export function providerNameFor(name: string | undefined, config: Config): string {
  const base = config.providerName ?? 'preset'
  if (name === undefined || name === '') return base
  const entry = (config.presets ?? {})[name as keyof typeof config.presets] as PresetEntry | undefined
  if (entry === undefined) {
    const known = Object.keys(config.presets ?? {})
    throw new Error(`unknown preset "${name}"; configured presets: ${known.join(', ')}`)
  }
  return `${base}:${name}`
}

/**
 * Drive a foreground delegation and read its result, mirroring the shipped
 * consumer's contract: a non-completed stop reason is an error that still
 * carries the partial output, and the run is disposed either way.
 * @param run - the started run.
 * @returns the rendered foreground result.
 */
async function settleForeground(run: SubagentRun): Promise<DelegationResult> {
  const [settled] = await Promise.allSettled([
    run.result.then((result): DelegationResult => {
      const text = textOf((result.output ?? []) as readonly { type?: string; text?: string }[])
      if (result.stopReason !== 'completed') {
        // The registry converts this throw to `isError`; the preserved partial
        // answer still reaches the caller.
        throw new Error(
          `subagent ${String(run.id)} ended with "${result.stopReason}"`
          + `${text.length > 0 ? `: ${text}` : ''}`,
        )
      }
      return { kind: 'foreground', runId: String(run.id), text }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (settled.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [settled.reason, disposal.reason],
        `subagent run failed: ${String(settled.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw settled.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return settled.value
}

/**
 * Register the preset-selecting delegation tool.
 *
 * Registration is effect-scoped: unload removes the tool with the plugin. The
 * tool registers on the GLOBAL tool layer (this plugin is a host-plane bundle
 * row), so every agent — including agents nested several levels deep — can call
 * it. That is what makes a shared tool agent addressable from anywhere in the
 * tree without widening the adjacent-agent messaging authority.
 * @param ctx - the plugin's context.
 * @param deps - tool name, live config, and the selectable presets.
 * @returns a disposer.
 */
export function registerPresetTool(ctx: Context, deps: PresetToolDeps): () => void {
  const config = deps.readConfig()
  const names = Object.keys(config.presets ?? {})
  const presetHelp = names.length === 0
    ? ''
    : ` The \`preset\` argument selects the composition: ${names
        .map(name => `\`${name}\``)
        .join(', ')}, or omit it for the default \`${config.presetId}\` preset.`

  return ctx.tools.register({
    name: deps.toolName,
    description:
      'Delegate a self-contained task to a subagent composed under a named preset. '
      + 'The child runs in the background by default and returns a durable subagent id immediately; '
      + 'its conversation stays available for later turns.'
      + presetHelp
      + ' Set `run_in_background: false` only when your next action depends on receiving the result.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the delegated task, for display.' },
        prompt: {
          type: 'string',
          description:
            'The complete self-contained task for the subagent. It does not share this conversation, '
            + 'so include every instruction and piece of context it needs.',
        },
        preset: {
          type: 'string',
          description:
            'Which named preset to compose the child under. Omit it to use the default preset.'
            + (names.length > 0 ? ` Configured: ${names.join(', ')}.` : ''),
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Whether to run in the background and return a durable subagent id immediately. '
            + 'Defaults to true. Set false to wait for the result when your next action depends on it.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          subagentId: { type: 'string' },
          runId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const result = value as DelegationResult
        const text = result.kind === 'continuable'
          ? `started subagent ${result.subagentId ?? ''}`
          : (result.text ?? '')
        return [{ type: 'text' as const, text }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<DelegationResult> {
      const a = args as DelegationArgs
      const parent = exec.agent as Agent | undefined
      if (parent === undefined) {
        // Non-agent callers provide no parent for delegation ownership.
        throw new Error(`${deps.toolName} requires a calling agent (exec.agent was undefined)`)
      }
      const live = deps.readConfig()
      const provider = providerNameFor(a.preset, live)
      // The pinned route is resolved here as well as by the provider instance:
      // request-level `agentOptions` is what the harness validates and what a
      // one-shot creation applies, while continuable children get their route
      // from the pin listener. Both read the same resolver, so they agree.
      const route = resolveRoute(undefined, live)
      const prompt: ContentBlock[] = [{ type: 'text', text: a.prompt }]
      const background = a.run_in_background !== false
      exec.signal.throwIfAborted()

      const request = {
        prompt,
        parent,
        ...Object.keys(route).length > 0 ? { agentOptions: route } : {},
      }

      if (background) {
        // Resolves at inbox acceptance: the child owns its own turns from there.
        const started = await ctx.subagents.startContinuable({
          provider,
          label: a.description,
          request: request as never,
          signal: exec.signal,
        })
        return { kind: 'continuable', subagentId: String(started.childId) }
      }

      const run = await ctx.subagents.start(provider, {
        ...request,
        label: a.description,
        signal: exec.signal,
      } as never)
      return settleForeground(run)
    },
  })
}
