import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  applyPresetChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { attachStructuredRuntime, type StructuredHandle } from './structured.js'
import { effectiveMaxDepth, resolveRoute } from './route.js'
import type { Config } from './config.js'

// Load the cordis context augmentations the setup callback relies on
// (`systemPrompt`, `tools`, `agentPresets`). These are ambient declarations
// provided by the peer packages; the imports exist purely for type resolution.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason: { kind: string } | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    default:
      return 'error'
  }
}

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/**
 * Append one one-shot descriptor inside the child's initial turn before its
 * first request. Mirrors the shared driver's `attachDescriptorAppend`.
 */
function attachDescriptorAppend(
  childCtx: Context,
  descriptor: ResolvedSubagentStartRequest['descriptor'],
): void {
  let appended = false
  childCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      payload.agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/**
 * Drive a published child for exactly one turn and read its result. Reimplements
 * the module-local `drivePublishedRun`/`readResult` from the shared driver in
 * `@deepseek-ai/dsh-subagent-in-process-driver` (which are not exported), using
 * the same public helpers.
 */
function drivePublishedRun(
  handle: { agent: Agent; dispose(): Promise<void> },
  signal: AbortSignal,
  prompt: ResolvedSubagentStartRequest['prompt'],
  childId: ReturnType<typeof SessionId>,
  boundary: number,
  structured: StructuredHandle | undefined,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = () => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  const result = (async (): Promise<SubagentResult> => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return readResult(child, boundary, flags.cancelled, structured)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose() {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const disposal = (await Promise.allSettled([handle.dispose(), result]))[0]
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

function readResult(
  child: Agent,
  boundary: number,
  cancelled: boolean,
  structured: StructuredHandle | undefined,
): SubagentResult {
  const own = child.session.events.slice(boundary)
  const lastEnd = foldConsumedWork(own).end
  const output = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  const stopReason = (cancelled && recorded !== 'completed' ? 'aborted' : recorded) as SubagentStopReason
  if (structured !== undefined) {
    const capturedValue = structured.captured()
    if (capturedValue !== undefined) {
      return { output, structured: capturedValue, stopReason }
    }
    if (stopReason === 'completed') {
      return { output, stopReason: cancelled ? 'aborted' : 'error' }
    }
  }
  return { output, stopReason }
}

/**
 * The preset-pinning in-process subagent provider. Mirrors the spawn provider
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`) but, instead of joining the
 * parent's preset, mounts the configured named preset for every child and forces
 * the configured model route.
 */
export class PresetInProcessProvider implements SubagentProvider {
  readonly capabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly readConfig: () => Config,
  ) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    assertSubagentMaxDepth(request.maxDepth)
    if (request.signal.aborted) return Promise.reject(prePublicationAbort())

    const config = this.readConfig()
    const parent = request.parent
    // Depth: the tighter of the caller's cap and the plugin's setting, so a
    // row-level `maxDepth` and the deployment's setting each keep their effect.
    const maxDepth = effectiveMaxDepth(request.maxDepth, config.maxDepth)
    const childDepth = resolveChildDepth(parent, maxDepth)
    const childId = SessionId(randomUUID())
    const boundary = 0
    const inherited = captureDelegatedPolicyOverrides(parent)
    // Per-request composition wins over the config default: a caller that names
    // a presetId (or brings its own toolFilter) is pinning THIS child, not
    // asking for the provider's base composition. Unset fields fall back to the
    // configured preset/filter.
    const presetId = request.presetId ?? config.presetId
    // Per-request ROUTE wins field by field over the plugin's resolved settings
    // (see `resolveRoute`): an `agentOptions` override on the delegating
    // `tool-subagent` row, or on a direct `ctx.subagents.start()` call, is the
    // finer-grained control knob over Settings → Plugins.
    const forcedAgentOptions = resolveRoute(request.agentOptions, config)
    const meta = {
      ...childSessionMeta(parent, childDepth, boundary),
      agentPreset: presetId,
    }

    let structured: StructuredHandle | undefined

    return parent.ctx.agents
      .create({
        sessionId: childId,
        meta,
        agentOptions: resolveChildAgentOptions(parent, forcedAgentOptions, childDepth),
        signal: request.signal,
        setup: async (childCtx: Context): Promise<void> => {
          const childSession = (childCtx.agent as Agent).session
          appendDelegatedPolicyOverrides(childSession, inherited)
          await applyPresetChildComposition(childCtx, presetId, {
            persona: request.persona,
            toolFilter: request.toolFilter,
          })
          if (request.outputSchema !== undefined) {
            structured = attachStructuredRuntime(childCtx, request.outputSchema)
          }
          attachDescriptorAppend(childCtx, request.descriptor)
        },
      })
      .then((handle) =>
        drivePublishedRun(handle, request.signal, request.prompt, childId, boundary, structured),
      )
  }

  prepareContinuable() {
    // Continuable children follow the SAME live settings route as one-shot
    // runs: the detached spec carries the resolved config's provider/model
    // (plus maxTokens when set), and the continuation manager merges it UNDER
    // any caller-supplied request overrides (role-level pins win). `presetId`
    // mounts the pinned preset instead of inheriting the parent's composition;
    // a role-level `request.presetId` (crews) still overrides this default.
    const config = this.readConfig()
    return Promise.resolve({
      ...(config.presetId !== undefined ? { presetId: config.presetId } : {}),
      agentOptions: resolveRoute(undefined, config),
    })
  }
}
