import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { Config } from '../src/config.js'
import { PresetInProcessProvider } from '../src/provider.js'

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

  it('parses a named crew with role presets', () => {
    const parsed = Config({
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
})

describe('PresetInProcessProvider', () => {
  it('advertises all four start-time capabilities', () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.deepEqual(p.capabilities, {
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
            return Promise.resolve({ agent: { id: 'child', followup: () => {}, whenIdle: () => Promise.resolve(), session: { events: [] } }, dispose: async () => {} })
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
