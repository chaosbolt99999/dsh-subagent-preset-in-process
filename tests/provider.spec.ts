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

  it('prepareContinuable contributes the pinned preset id', async () => {
    const p = new PresetInProcessProvider('preset', () => cfg as never)
    assert.deepEqual(await p.prepareContinuable(), { presetId: 'subagent-slim' })
  })

  it('prepareContinuable contributes nothing without a preset id', async () => {
    const p = new PresetInProcessProvider('preset', () => ({ ...cfg, presetId: undefined }) as never)
    assert.deepEqual(await p.prepareContinuable(), {})
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
