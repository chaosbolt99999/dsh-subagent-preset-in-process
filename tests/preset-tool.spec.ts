import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { Config } from '../src/config.js'
import { providerNameFor } from '../src/preset-tool.js'

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
