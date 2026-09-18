import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { Config } from '../src/config.js'
import { providerNameFor, registerPresetTool } from '../src/preset-tool.js'

/**
 * These tests cover the preset-SELECTING half of the delegation path: how a
 * `preset` argument becomes the registry name of the provider instance that
 * composes that preset. They use plain config objects rather than a live
 * harness because the decision under test is pure.
 */

const cfg = (overrides: Record<string, unknown> = {}) => Config({
  presetId: 'subagent-slim',
  ...overrides,
}) as never

describe('Config: presets', () => {
  it('defaults to an empty preset map and an enabled default tool name', () => {
    const parsed = Config({ presetId: 'subagent-slim' })
    assert.deepEqual(parsed.presets, {})
    assert.deepEqual(parsed.presetTool, { enabled: true, toolName: 'subagent_preset' })
  })

  it('parses named presets with their own route, filter, and persona', () => {
    const parsed = Config({
      presetId: 'subagent-slim',
      presets: {
        coding: {
          presetId: 'subagent-coder',
          provider: 'merge',
          model: 'zai/glm-5.3-flash',
          maxTokens: 32000,
          persona: 'You are the coder.',
          toolFilter: { allow: ['bash', 'read'] },
        },
      },
    })
    assert.equal(parsed.presets.coding.presetId, 'subagent-coder')
    assert.equal(parsed.presets.coding.model, 'zai/glm-5.3-flash')
    // A PRESENT filter materializes `deny: []`, the same convention the crew
    // roles follow; only an OMITTED one stays undefined (see the next test).
    assert.deepEqual(parsed.presets.coding.toolFilter, { allow: ['bash', 'read'], deny: [] })
  })

  it('preserves an OMITTED preset toolFilter, which would otherwise strip every tool', () => {
    // Schemastery materializes an absent nested object as `{ allow: [], deny: [] }`,
    // and an empty allowlist means "keep nothing".
    const parsed = Config({ presetId: 'subagent-slim', presets: { bare: { presetId: 'subagent-slim' } } })
    assert.equal(parsed.presets.bare.toolFilter, undefined)
  })
})

describe('providerNameFor', () => {
  it('resolves an omitted preset to the default provider instance', () => {
    assert.equal(providerNameFor(undefined, cfg()), 'preset')
    assert.equal(providerNameFor('', cfg()), 'preset')
  })

  it('resolves a named preset to its own provider instance', () => {
    const config = cfg({ presets: { coding: { presetId: 'subagent-coder' } } })
    assert.equal(providerNameFor('coding', config), 'preset:coding')
  })

  it('honours a renamed base provider', () => {
    const config = cfg({ providerName: 'pinned', presets: { coding: { presetId: 'subagent-coder' } } })
    assert.equal(providerNameFor(undefined, config), 'pinned')
    assert.equal(providerNameFor('coding', config), 'pinned:coding')
  })

  it('fails loud on an unknown preset, naming the configured ones', () => {
    const config = cfg({ presets: { coding: { presetId: 'subagent-coder' }, memory: { presetId: 'subagent-worker' } } })
    assert.throws(
      () => providerNameFor('nope', config),
      /unknown preset "nope"; configured presets: coding, memory/,
    )
  })
})

describe('registerPresetTool: the selected preset decides the route', () => {
  /** Minimal ctx capturing the registered tool and every start request. */
  function harness(routeFor: (name: string) => Record<string, string>) {
    const starts: Array<{ provider: string; request: any }> = []
    let definition: any
    const ctx = {
      tools: { register: (def: any) => { definition = def; return () => {} } },
      subagents: {
        start: (provider: string, request: any) => {
          starts.push({ provider, request })
          return Promise.resolve({
            id: 'run-1',
            result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
            dispose: () => Promise.resolve(),
          })
        },
      },
    }
    return { ctx, starts, tool: () => definition }
  }

  const choicesFor = (routes: Record<string, Record<string, string>>) =>
    Object.entries(routes).map(([name, route]) => ({
      providerName: name,
      presetId: `preset-of-${name}`,
      route: () => route,
    }))

  it("uses the SELECTED entry's route, not the top-level one", async () => {
    const h = harness(() => ({}))
    registerPresetTool(h.ctx as never, {
      toolName: 'subagent_preset',
      readConfig: () => cfg({
        provider: 'top-provider',
        model: 'top-model',
        presets: { coding: { presetId: 'subagent-coder', provider: 'ccode', model: 'deepseek/deepseek-v4.1-flash' } },
      }) as never,
      choices: () => choicesFor({ preset: { provider: 'merge', model: 'top-model' }, 'preset:coding': { provider: 'ccode', model: 'deepseek/deepseek-v4.1-flash' } }),
    })
    await h.tool().execute(
      { description: 'd', prompt: 'p', preset: 'coding', run_in_background: false },
      { agent: {}, signal: new AbortController().signal },
    )
    assert.equal(h.starts.length, 1)
    assert.equal(h.starts[0].provider, 'preset:coding')
    // Request-level agentOptions beats the provider's own view, so this MUST be
    // the entry's route; the top-level route here is what made a named preset
    // spawn on the plugin default model.
    assert.deepEqual(h.starts[0].request.agentOptions, { provider: 'ccode', model: 'deepseek/deepseek-v4.1-flash' })
  })

  it('falls back to the top-level route for the default choice', async () => {
    const h = harness(() => ({}))
    registerPresetTool(h.ctx as never, {
      toolName: 'subagent_preset',
      readConfig: () => cfg({ provider: 'merge', model: 'zai/glm-5.3-flash' }) as never,
      choices: () => choicesFor({ preset: { provider: 'merge', model: 'zai/glm-5.3-flash' } }),
    })
    await h.tool().execute(
      { description: 'd', prompt: 'p', run_in_background: false },
      { agent: {}, signal: new AbortController().signal },
    )
    assert.deepEqual(h.starts[0].request.agentOptions, { provider: 'merge', model: 'zai/glm-5.3-flash' })
  })
})
