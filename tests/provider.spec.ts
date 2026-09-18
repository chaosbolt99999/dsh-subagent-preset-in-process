import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { Config } from '../src/config.js'
import { PresetInProcessProvider, childMeta } from '../src/provider.js'
import { forgetPin, recordedPin } from '../src/pin.js'

const cfg = {
  providerName: 'preset',
  presetId: 'subagent-slim',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxDepth: 3 as const,
}

describe('Config', () => {
  it('defaults providerName/provider/model/maxDepth', () => {
    const parsed = Config({ presetId: 'subagent-slim' })
    assert.equal(parsed.providerName, 'preset')
    assert.equal(parsed.provider, 'deepseek-official')
    assert.equal(parsed.model, 'deepseek-v4-flash')
    assert.equal(parsed.maxDepth, 3)
  })

  it('crews default to an empty map', () => {
    const parsed = Config({ presetId: 'subagent-slim' })
    assert.deepEqual(parsed.crews, {})
  })

  it('parses a named crew with role presets', () => {    const parsed = Config({
      presetId: 'subagent-slim',
      crews: {
        engineering: {
          orchestratorRole: 'orchestrator',
          roles: [
            { name: 'planner', presetId: 'subagent-slim', roleTask: 'Plan the work.' },
            { name: 'orchestrator', presetId: 'subagent-slim', roleTask: 'Route work.' },
            { name: 'builder', presetId: 'subagent-slim', roleTask: 'Build it.' },
            { name: 'verifier', presetId: 'subagent-slim', roleTask: 'Verify it.' },
          ],
        },
      },
    })
    assert.deepEqual(Object.keys(parsed.crews), ['engineering'])
    assert.equal(parsed.crews.engineering.orchestratorRole, 'orchestrator')
    assert.equal(parsed.crews.engineering.roles.length, 4)
  })

  it('keeps an omitted role toolFilter and agentOptions ABSENT, never materialized', () => {
    // Regression: Schemastery materializes an absent nested object as
    // `{ allow: [], deny: [] }`, and an empty allowlist makes `tools.restrict()`
    // strip every tool from the role (live failure: "the filter was authored for
    // a different plane"). Omission must mean "no scoping".
    const parsed = Config({
      presetId: 'subagent-slim',
      crews: { engineering: { roles: [{ name: 'planner', presetId: 'slim', roleTask: 'Plan.' }] } },
    })
    const role = parsed.crews.engineering.roles[0]
    assert.equal(role.toolFilter, undefined)
    assert.equal(role.agentOptions, undefined)
    assert.equal('toolFilter' in role, false, 'the key must be absent, never an empty allowlist')
  })

  it('keeps a role toolFilter that IS declared', () => {
    const parsed = Config({
      presetId: 'subagent-slim',
      crews: {
        engineering: {
          roles: [{ name: 'builder', presetId: 'slim', roleTask: 'Build.', toolFilter: { allow: ['bash', 'read'] } }],
        },
      },
    })
    assert.deepEqual(parsed.crews.engineering.roles[0].toolFilter, { allow: ['bash', 'read'], deny: [] })
  })
})

describe('PresetInProcessProvider', () => {
  it('advertises all five start-time capabilities', () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.deepEqual(p.capabilities, {
      // `agentOptions` is advertised because the provider HONORS it
      // (`resolveRoute` merges a caller override over the plugin route). Leaving
      // it out made `assertCapabilities` reject any `tool-subagent` row that
      // named one, silently making row-level route overrides unusable.
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    })
  })

  it('does not inherit parent context', () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.equal(p.inheritsParentContext, false)
  })

  it('registers under its configured name', () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.equal(p.name, 'preset')
  })

  it('resolves a NAMED preset\'s composition, route, filter, and persona over the top level', () => {
    const p = new PresetInProcessProvider('preset:coding', () => ({
      ...cfg,
      presets: {
        coding: {
          presetId: 'subagent-coder',
          provider: 'merge',
          model: 'zai/glm-5.3-flash',
          maxTokens: 32000,
          toolFilter: { allow: ['bash'] },
          persona: 'You are the coder.',
        },
      },
    }) as never, 'coding')
    const view = p.view()
    assert.equal(view.presetId, 'subagent-coder')
    assert.equal(view.provider, 'merge')
    assert.equal(view.model, 'zai/glm-5.3-flash')
    assert.equal(view.maxTokens, 32000)
    assert.deepEqual(view.toolFilter, { allow: ['bash'] })
    assert.equal(view.persona, 'You are the coder.')
    assert.deepEqual(p.route(), { provider: 'merge', model: 'zai/glm-5.3-flash', maxTokens: 32000 })
  })

  it('falls back to the top-level preset and route for the default instance', () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.equal(p.view().presetId, 'subagent-slim')
    assert.deepEqual(p.route(), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('omits unset route fields, so the parent route can still be inherited', () => {
    const p = new PresetInProcessProvider('preset', () => ({
      ...cfg,
      provider: undefined,
      model: undefined,
    }) as never)
    assert.deepEqual(p.route(), {})
  })

  it('records the pinned ROUTE alongside the preset for continuable children', async () => {
    const p = new PresetInProcessProvider('preset:coding', () => ({
      ...cfg,
      presets: { coding: { presetId: 'subagent-coder', provider: 'merge', model: 'zai/glm-5.3-flash' } },
    }) as never, 'coding')
    // The returned spec is discarded by an unpatched harness; the recorded pin is
    // what the agent/request listener enforces, so it must carry the route.
    await p.prepareContinuable({ sessionId: 'child-route', parent: {} as never, signal: new AbortController().signal } as never)
    const pin = recordedPin('child-route')
    assert.equal(pin?.presetId, 'subagent-coder')
    assert.deepEqual(pin?.route, { provider: 'merge', model: 'zai/glm-5.3-flash' })
    forgetPin('child-route')
  })

  it('prepareContinuable contributes the pinned preset id and the settings route', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.deepEqual(await p.prepareContinuable(), {
      presetId: 'subagent-slim',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
  })

  it('prepareContinuable carries maxTokens when configured', async () => {
    const p = new PresetInProcessProvider('preset', () => ({ ...cfg, maxTokens: 4096 }) as never)
    assert.deepEqual(await p.prepareContinuable(), {
      presetId: 'subagent-slim',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 4096 },
    })
  })

  it('prepareContinuable follows a live settings route change', async () => {
    // The readConfig callback is the live resolved settings: a Settings →
    // Plugins edit must reach the NEXT continuable child's route verbatim.
    let current = { ...cfg }
    const p = new PresetInProcessProvider('preset', () => current)
    const before = await p.prepareContinuable()
    current = { ...cfg, provider: 'custom2', model: 'x-preview-f-free' }
    const after = await p.prepareContinuable()
    assert.deepEqual(before.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    assert.deepEqual(after.agentOptions, { provider: 'custom2', model: 'x-preview-f-free' })
  })

  it('prepareContinuable contributes only the route without a preset id', async () => {
    const p = new PresetInProcessProvider('preset', () => ({ ...cfg, presetId: undefined }) as never)
    assert.deepEqual(await p.prepareContinuable(), {
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      p.start({
        prompt: [{ type: 'text', text: 'hi' }],
        parent: {} as never,
        signal: controller.signal,
        descriptor: { version: 2, mode: 'one-shot', provider: 'preset' } as never,
      } as never),
      /aborted before child publication/,
    )
  })
})

describe('PresetInProcessProvider.start composition', () => {
  /** Capture what `start` passes to `agents.create` without driving a real agent. */
  function captureCreate() {
    const calls: any[] = []
    const parent = {
      ctx: {
        get: () => undefined,
        agents: {
          create: (opts: any) => {
            calls.push(opts)
            return Promise.resolve({ agent: { id: 'child', followup: () => {}, whenIdle: () => Promise.resolve(), session: { events: [], snapshotEvents: () => [] } }, dispose: async () => {} })
          },
        },
      },
      session: {
        events: [],
        header: { delegationDepth: 0 },
      },
      options: { provider: 'parent-prov', model: 'parent-model' },
      id: 'parent-session',
    } as never
    return { calls, parent }
  }

  it('honors a per-request presetId over the configured default', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate()
    await p.start({
      prompt: [{ type: 'text', text: 'hi' }],
      parent,
      signal: new AbortController().signal,
      presetId: 'custom-preset',
      descriptor: { version: 2, mode: 'one-shot', provider: 'preset' } as never,
    } as never)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].meta.agentPreset, 'custom-preset')
  })

  it('records the configured preset id when the request names none', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate()
    await p.start({
      prompt: [{ type: 'text', text: 'hi' }],
      parent,
      signal: new AbortController().signal,
      descriptor: { version: 2, mode: 'one-shot', provider: 'preset' } as never,
    } as never)
    assert.equal(calls[0].meta.agentPreset, 'subagent-slim')
  })
})

describe('PresetInProcessProvider.start request-level route override', () => {
  /** Capture what `start` passes to `agents.create` without driving a real agent. */
  function captureCreate(parentOptions: Record<string, unknown> = { provider: 'parent-prov', model: 'parent-model' }) {
    const calls: any[] = []
    const parent = {
      ctx: {
        get: () => undefined,
        agents: {
          create: (opts: any) => {
            calls.push(opts)
            return Promise.resolve({ agent: { id: 'child', followup: () => {}, whenIdle: () => Promise.resolve(), session: { events: [], snapshotEvents: () => [] } }, dispose: async () => {} })
          },
        },
      },
      session: { events: [], header: { delegationDepth: 0 } },
      options: parentOptions,
      id: 'parent-session',
    } as never
    return { calls, parent }
  }

  const request = (extra: Record<string, unknown>) => ({
    prompt: [{ type: 'text', text: 'hi' }],
    parent: undefined as never,
    signal: new AbortController().signal,
    descriptor: { version: 2, mode: 'one-shot', provider: 'preset' } as never,
    ...extra,
  })

  it('applies the settings route when the request carries no override', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate()
    await p.start({ ...request({}), parent } as never)
    assert.equal(calls[0].agentOptions.provider, 'deepseek-official')
    assert.equal(calls[0].agentOptions.model, 'deepseek-v4-flash')
    assert.equal(calls[0].agentOptions.subagentDepth, 1)
  })

  it('lets a request-level model override win over the settings route (the old bug)', async () => {
    // Before the fix, `start()` wrote config.provider/model OVER the request's
    // agentOptions, so a row-level override was silently discarded.
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate()
    await p.start({ ...request({ agentOptions: { model: 'gpt-5.6-sol' } }), parent } as never)
    assert.equal(calls[0].agentOptions.model, 'gpt-5.6-sol')
    assert.equal(calls[0].agentOptions.provider, 'deepseek-official', 'the untouched field still follows settings')
  })

  it('lets a request-level provider override win over the settings route', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate()
    await p.start({ ...request({ agentOptions: { provider: 'ccode' } }), parent } as never)
    assert.equal(calls[0].agentOptions.provider, 'ccode')
    assert.equal(calls[0].agentOptions.model, 'deepseek-v4-flash')
  })

  it('lets a request-level maxTokens override the settings cap', async () => {
    const p = new PresetInProcessProvider('preset', () => ({ ...cfg, maxTokens: 4096 }) as never)
    const { calls, parent } = captureCreate()
    await p.start({ ...request({ agentOptions: { maxTokens: 8192 } }), parent } as never)
    assert.equal(calls[0].agentOptions.maxTokens, 8192)
  })

  it('inherits the parent maxTokens when neither the request nor the settings cap it', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate({ provider: 'parent-prov', model: 'parent-model', maxTokens: 1234 })
    await p.start({ ...request({}), parent } as never)
    assert.equal(calls[0].agentOptions.maxTokens, 1234)
  })

  it('keeps the settings model when the request overrides only the provider', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    const { calls, parent } = captureCreate()
    await p.start({ ...request({ agentOptions: { provider: 'ccode' } }), parent } as never)
    assert.deepEqual(
      { provider: calls[0].agentOptions.provider, model: calls[0].agentOptions.model },
      { provider: 'ccode', model: 'deepseek-v4-flash' },
    )
  })

  it('tightens the depth cap to the request value when it is stricter than the config', async () => {
    const p = new PresetInProcessProvider('preset', () => ({ ...cfg, maxDepth: 5 }) as never)
    const { calls, parent } = captureCreate()
    await p.start({ ...request({ maxDepth: 1 }), parent } as never)
    // childDepth = parent depth (0) + 1 = 1, which the request's cap of 1 allows
    assert.equal(calls[0].agentOptions.subagentDepth, 1)
  })

  it('rejects a child the effective depth cap forbids', () => {
    // `start()` is a plain function whose pre-publication guards throw
    // synchronously; the service awaits it, so the throw rejects `start()`.
    const p = new PresetInProcessProvider('preset', () => ({ ...cfg, maxDepth: 5 }) as never)
    const { parent } = captureCreate()
    assert.throws(() => p.start({ ...request({ maxDepth: 0 }), parent } as never), /exceeds maxDepth/)
  })
})

describe('child creation metadata across harness generations', () => {
  /**
   * The plugin compiles against its VENDORED @deepseek-ai copies and runs
   * against whatever harness serves it, and the meta helper changed shape across
   * that seam: the vendored copy takes `lineageSeedLength` (number) and emits
   * `seedLength`; current harnesses take `isSeeded` (boolean) and their session
   * header REJECTS `seedLength` outright. This pins the normalization that keeps
   * both ends honest.
   */
  const parent = {
    id: 'parent-1',
    session: { header: { id: 'parent-1', cwd: '/tmp' } },
    ctx: { get: () => undefined },
  } as never

  it('emits a boolean isSeeded and never a seedLength', () => {
    const meta = childMeta(parent, 1, false)
    assert.equal(meta.isSeeded, false)
    assert.equal('seedLength' in meta, false)
    assert.equal(meta.origin, 'subagent')
    assert.equal(meta.delegationDepth, 1)
    assert.equal(meta.parentSession, 'parent-1')
  })

  it('reports a seeded child as isSeeded: true', () => {
    assert.equal(childMeta(parent, 2, true).isSeeded, true)
  })
})
