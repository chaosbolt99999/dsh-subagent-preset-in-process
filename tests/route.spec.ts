import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { effectiveMaxDepth, resolveRoute, roleRouteOverrides } from '../src/route.js'

/** The plugin-settings side of every resolution below. */
const settings = { provider: 'merge', model: 'deepseek/deepseek-v4-flash-0731' }

describe('resolveRoute', () => {
  it('uses the settings route when the request overrides nothing', () => {
    assert.deepEqual(resolveRoute(undefined, settings), {
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
    })
  })

  it('treats an empty request override as no override', () => {
    assert.deepEqual(resolveRoute({}, settings), {
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
    })
  })

  it('lets a request-level override win field by field', () => {
    // The exact knob this exists for: a `tool-subagent` row (or crew role) that
    // pins ONLY a model keeps the settings provider.
    assert.deepEqual(resolveRoute({ model: 'gpt-5.6-sol' }, settings), {
      provider: 'merge',
      model: 'gpt-5.6-sol',
    })
    assert.deepEqual(resolveRoute({ provider: 'ccode' }, settings), {
      provider: 'ccode',
      model: 'deepseek/deepseek-v4-flash-0731',
    })
    assert.deepEqual(
      resolveRoute({ provider: 'ccode', model: 'gpt-5.6-sol' }, settings),
      { provider: 'ccode', model: 'gpt-5.6-sol' },
    )
  })

  it('lets a request-level maxTokens win over the settings cap', () => {
    assert.deepEqual(resolveRoute({ maxTokens: 8192 }, { ...settings, maxTokens: 4096 }), {
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
      maxTokens: 8192,
    })
    // ...and keeps the settings cap when the request names none.
    assert.deepEqual(resolveRoute({ model: 'x' }, { ...settings, maxTokens: 4096 }), {
      provider: 'merge',
      model: 'x',
      maxTokens: 4096,
    })
  })

  it('omits maxTokens entirely when neither source sets it', () => {
    // An explicit `maxTokens: undefined` key would SHADOW the parent's cap when
    // the route is spread over the parent's options — inheritance must win.
    const route = resolveRoute({ model: 'x' }, settings)
    assert.equal('maxTokens' in route, false)
    assert.equal(Object.keys(route).includes('maxTokens'), false)
  })

  it('omits a field neither source defines instead of pinning undefined', () => {
    const route = resolveRoute(undefined, { model: 'only-model' })
    assert.deepEqual(route, { model: 'only-model' })
    assert.equal('provider' in route, false)
  })

  it('falls through to settings for fields the request leaves undefined', () => {
    assert.deepEqual(resolveRoute({ provider: undefined, model: 'x' }, settings), {
      provider: 'merge',
      model: 'x',
    })
  })
})

describe('roleRouteOverrides', () => {
  it('reads the canonical nested agentOptions', () => {
    assert.deepEqual(
      roleRouteOverrides({ agentOptions: { provider: 'ccode', model: 'gpt-5.6-luna', maxTokens: 1024 } }),
      { provider: 'ccode', model: 'gpt-5.6-luna', maxTokens: 1024 },
    )
  })

  it('keeps the legacy flat fields working as per-field aliases', () => {
    assert.deepEqual(roleRouteOverrides({ provider: 'ccode', model: 'gpt-5.6-luna' }), {
      provider: 'ccode',
      model: 'gpt-5.6-luna',
    })
  })

  it('takes the nested value for a field that both shapes define', () => {
    assert.deepEqual(roleRouteOverrides({ agentOptions: { model: 'nested' }, model: 'flat' }), { model: 'nested' })
  })

  it('mixes a nested field with a flat field without dropping either', () => {
    assert.deepEqual(roleRouteOverrides({ agentOptions: { model: 'nested' }, provider: 'flat-provider' }), {
      provider: 'flat-provider',
      model: 'nested',
    })
  })

  it('omits every field the role does not define', () => {
    assert.deepEqual(roleRouteOverrides({}), {})
    assert.deepEqual(roleRouteOverrides({ agentOptions: {} }), {})
  })
})

describe('effectiveMaxDepth', () => {
  it('returns the request cap when the plugin config names none', () => {
    assert.equal(effectiveMaxDepth(2, undefined), 2)
  })

  it('uses the plugin cap when the request sends none (crew members)', () => {
    assert.equal(effectiveMaxDepth(undefined, 4), 4)
  })

  it('tightens to the smaller numeric cap rather than discarding either', () => {
    assert.equal(effectiveMaxDepth(5, 2), 2)
    assert.equal(effectiveMaxDepth(1, 3), 1)
    assert.equal(effectiveMaxDepth(3, 3), 3)
  })

  it("treats 'provider-managed' as no cap from that source", () => {
    assert.equal(effectiveMaxDepth(3, 'provider-managed'), 3)
    assert.equal(effectiveMaxDepth(undefined, 'provider-managed'), undefined)
  })

  it('keeps a zero cap (delegation forbidden) instead of treating it as absent', () => {
    assert.equal(effectiveMaxDepth(0, 3), 0)
  })
})
