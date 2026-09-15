import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork, type AgentSetup, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
  type ContinuableCreateRequest,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { attachStructuredRuntime, type StructuredHandle } from './structured.js'
import { composePinnedChild, recordPin, type Pin } from './pin.js'
import { effectiveMaxDepth, resolveRoute } from './route.js'
import type { Config } from './config.js'

// Load the cordis context augmentations the setup callback relies on
// (`systemPrompt`, `tools`, `agentPresets`). These are ambient declarations
// provided by the peer packages; the imports exist purely for type resolution.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'

/** The creation-metadata type the agent service accepts. */
type ChildCreationMeta = NonNullable<CreateAgentOptions['meta']>

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
 * Build one child's durable creation metadata.
 *
 * Written out here rather than delegated to the harness's `childSessionMeta`:
 * this package's VENDORED copy of that helper is a generation behind (it takes
 * `lineageSeedLength` and emits `seedLength`, a field the current session header
 * REJECTS outright), and this plugin targets the current harness only. Owning
 * the object means its fields are exactly the ones the running session
 * validates; the cast covers the stale field types in the vendored `.d.ts`.
 * @param parent - the delegating parent.
 * @param childDepth - the child's delegation depth.
 * @param isSeeded - whether the child session is seeded with a parent prefix.
 * @returns metadata accepted by the live session implementation.
 */
export function childMeta(parent: Agent, childDepth: number, isSeeded: boolean): ChildCreationMeta {
  const header = parent.session.header
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: header.id,
    isSeeded,
    origin: 'subagent',
    delegationDepth: childDepth,
  } as unknown as ChildCreationMeta
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
  // The session's event log is read through `snapshotEvents(fromIndex)` on the
  // current harness; the older `session.events` array this package's vendored
  // types declare no longer exists (reading it yielded
  // "Cannot read properties of undefined (reading 'slice')").
  const own = (child.session as unknown as {
    snapshotEvents: (from: number) => readonly SessionEvent[]
  }).snapshotEvents(boundary)
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
    // `agentOptions` IS honored (`resolveRoute` merges a caller's override over
    // the plugin route field by field), and a `tool-subagent` row that names one
    // is REJECTED by `assertCapabilities` unless it is advertised. Leaving it out
    // made row-level route overrides silently unusable on the one-shot path; the
    // continuable path never checked capabilities, which is why the omission
    // went unnoticed there for so long.
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly readConfig: () => Config,
    /** The named preset this instance composes, or undefined for the default. */
    readonly presetName?: string,
  ) {}

  /**
   * This instance's effective config: the named preset's fields win over the
   * plugin's top-level ones, so one provider instance per preset is a complete,
   * self-describing delegation target.
   * @returns the resolved config view for this instance.
   */
  view(): Config & { presetId: string } {
    const config = this.readConfig()
    const entry = this.presetName === undefined
      ? undefined
      : config.presets?.[this.presetName as keyof typeof config.presets]
    return {
      ...config,
      presetId: entry?.presetId ?? config.presetId,
      provider: entry?.provider ?? config.provider,
      model: entry?.model ?? config.model,
      maxTokens: entry?.maxTokens ?? config.maxTokens,
      toolFilter: entry?.toolFilter ?? config.toolFilter,
      persona: entry?.persona ?? config.persona,
    } as Config & { presetId: string }
  }

  /** The route this instance pins, before any request-level override. */
  route(): { provider?: string; model?: string; maxTokens?: number } {
    const view = this.view()
    const out: { provider?: string; model?: string; maxTokens?: number } = {}
    if (view.provider !== undefined) out.provider = view.provider
    if (view.model !== undefined) out.model = view.model
    if (view.maxTokens !== undefined) out.maxTokens = view.maxTokens
    return out
  }

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    assertSubagentMaxDepth(request.maxDepth)
    if (request.signal.aborted) return Promise.reject(prePublicationAbort())

    const config = this.view()
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
      ...childMeta(parent, childDepth, false),
      agentPreset: presetId,
    }

    let structured: StructuredHandle | undefined

    return parent.ctx.agents
      .create({
        sessionId: childId,
        meta,
        agentOptions: resolveChildAgentOptions(parent, forcedAgentOptions, childDepth),
        signal: request.signal,
        // Cast because the VENDORED `AgentSetup` (one parameter) is a generation
        // behind the running one, which passes the agent as a second argument.
        setup: (async (childCtx: Context, child: Agent): Promise<void> => {
          // The agent arrives as the setup's SECOND parameter. Reading
          // `childCtx.agent` instead — which this package's vendored `AgentSetup`
          // type (one parameter) invites — is guard-rejected on the current
          // harness ("cannot get property agent without inject").
          const childSession = child.session
          appendDelegatedPolicyOverrides(childSession, inherited)
          // The pinned composition is built by THIS plugin (`src/pin.ts`) rather
          // than by a harness helper: `applyChildComposition` carries the
          // delegation statement, `recompose()` then re-links the child onto the
          // pinned preset, and the filter is applied last, against the child's
          // real post-re-link view. That keeps the whole capability inside the
          // package, so it runs against an unpatched harness.
          // The EFFECTIVE filter: a row that still carries one wins, otherwise
          // the plugin's own `toolFilter` setting. Applied after the re-link, so
          // it is validated against the composition the child ends up on — a row
          // filter is validated by the harness at creation, against the PARENT's
          // composition, which is what made "unknown global tool" possible.
          const filter = request.toolFilter ?? config.toolFilter
          await composePinnedChild(
            childCtx,
            parent,
            {
              presetId,
              ...filter !== undefined ? { toolFilter: filter } : {},
              route: forcedAgentOptions,
            },
            request.persona ?? config.persona,
          )
          if (request.outputSchema !== undefined) {
            structured = attachStructuredRuntime(childCtx, request.outputSchema)
          }
          attachDescriptorAppend(childCtx, request.descriptor)
        }) as unknown as AgentSetup,
      })
      .then((handle) =>
        drivePublishedRun(handle, request.signal, request.prompt, childId, boundary, structured),
      )
  }

  prepareContinuable(request?: ContinuableCreateRequest) {
    // Continuable children follow the SAME live settings route as one-shot
    // runs: the detached spec carries the resolved config's provider/model
    // (plus maxTokens when set), and the continuation manager merges it UNDER
    // any caller-supplied request overrides (role-level pins win).
    //
    // The PIN is recorded here because this call is the one moment the provider
    // is handed the child's reserved session id before the child exists — the
    // continuation manager owns creation, so a plugin-side re-link
    // (`src/pin.ts`, on `agent/session-start` / `agent/pre-step`) needs that id
    // to know which child to pin. Returning `presetId` as well is harmless: a
    // patched harness pins at creation and the re-link then finds the child
    // already on its preset, while an unpatched harness ignores the field and
    // the listener does the work.
    const config = this.view()
    // A deployment that names no preset pins nothing: the child keeps the
    // harness's default composition (the parent join) and no pin is recorded,
    // so the listeners have nothing to act on.
    const sessionId = request?.sessionId
    if (config.presetId !== undefined) {
      const pin: Pin = {
        presetId: config.presetId,
        ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
        // The ROUTE rides the same pin. On an unpatched harness the
        // `agentOptions` returned below is DISCARDED, so this map — read by the
        // `agent/request` listener — is the only thing that puts a continuable
        // child on the configured route instead of its parent's.
        route: this.route(),
      }
      // Older harness generations call this with no request; without a session
      // id there is nothing to key the pin by, and the descriptor fallback in
      // the listeners still covers the child.
      if (sessionId !== undefined) recordPin(String(sessionId), pin)
    }
    return Promise.resolve({
      ...config.presetId !== undefined ? { presetId: config.presetId } : {},
      agentOptions: resolveRoute(undefined, config),
    })
  }
}
