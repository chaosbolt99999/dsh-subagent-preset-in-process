import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'vitest'
import {
  applyChildToolFilter,
  clearPins,
  forgetPin,
  installPinning,
  recordPin,
  recordedPin,
  rePin,
  resolvePin,
} from '../src/pin.js'

/**
 * These tests cover the plugin-side half of preset pinning: which child gets
 * which preset, and how a filter is made valid for the composition the child
 * actually ends up on. They use fakes rather than a live harness because the
 * behaviour under test is the plugin's decision-making — the harness calls it
 * makes are asserted by shape.
 */

/**
 * A tools service that accepts exactly `known` names, like ToolRuntime.restrict.
 * `restrictions` lists what is STANDING: a lifted restriction is removed, so a
 * probe that installs and immediately lifts leaves the list untouched.
 */
function fakeTools(known: string[]) {
  const restrictions: { allow?: readonly string[]; deny?: readonly string[] }[] = []
  return {
    restrictions,
    restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
      const names = [...filter.allow ?? [], ...filter.deny ?? []]
      const unknown = names.filter(name => !known.includes(name))
      if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
      restrictions.push(filter)
      let standing = true
      return () => {
        if (!standing) return
        standing = false
        const index = restrictions.indexOf(filter)
        if (index >= 0) restrictions.splice(index, 1)
      }
    },
    /** Restrictions still standing — a probe must leave none behind. */
    standing: () => restrictions.length,
  }
}

/** A preset roster that reports the given current composition. */
function fakePresets(current: string, onRecompose?: (id: string) => void) {
  const calls: string[] = []
  return {
    calls,
    composedPreset: () => current,
    recompose: async (_ctx: unknown, id: string) => {
      calls.push(id)
      onRecompose?.(id)
      return { id }
    },
  }
}

function fakeCtx(services: Record<string, unknown>) {
  return { get: (name: string) => services[name] } as never
}

/** A child agent as the listeners see it: id, ctx, and a session event log. */
function fakeAgent(id: string, ctx: unknown, events: { type: string; data?: unknown }[] = []) {
  return { id, ctx, session: { events } } as never
}

const deps = (overrides: Partial<{ presetId: string; crews: Record<string, unknown> }> = {}) => ({
  providerName: 'preset',
  readConfig: () => ({
    presetId: overrides.presetId ?? 'subagent-worker',
    crews: (overrides.crews ?? {}) as never,
  }),
})

beforeEach(() => {
  clearPins()
})

describe('pin resolution', () => {
  it('prefers a recorded pin, keyed by the child session id', () => {
    recordPin('session-1', { presetId: 'subagent-slim' })
    const pin = resolvePin(fakeAgent('session-1', fakeCtx({})), deps())
    assert.equal(pin?.presetId, 'subagent-slim')
    assert.equal(recordedPin('session-1')?.presetId, 'subagent-slim')
    forgetPin('session-1')
    assert.equal(recordedPin('session-1'), undefined)
  })

  it('falls back to the child\'s own durable descriptor, so a cold resume re-pins', () => {
    const events = [
      { type: 'session/start' },
      { type: 'subagent/descriptor', data: { provider: 'preset', label: 'research the tree' } },
    ]
    const pin = resolvePin(fakeAgent('session-2', fakeCtx({}), events), deps({ presetId: 'subagent-worker' }))
    assert.equal(pin?.presetId, 'subagent-worker')
  })

  it('resolves a crew member\'s pin from its creation label, with the role filter', () => {
    const events = [{
      type: 'subagent/descriptor',
      data: { provider: 'preset', label: 'crew:engineering:builder' },
    }]
    const pin = resolvePin(fakeAgent('session-3', fakeCtx({}), events), deps({
      presetId: 'subagent-worker',
      crews: {
        engineering: {
          roles: [{ name: 'builder', presetId: 'subagent-slim', toolFilter: { allow: ['bash', 'find_symbol'] } }],
        },
      },
    }))
    assert.equal(pin?.presetId, 'subagent-slim')
    assert.deepEqual(pin?.toolFilter, { allow: ['bash', 'find_symbol'] })
  })

  it('returns nothing for a child another provider established', () => {
    const events = [{ type: 'subagent/descriptor', data: { provider: 'spawn', label: 'other' } }]
    assert.equal(resolvePin(fakeAgent('session-4', fakeCtx({}), events), deps()), undefined)
  })

  it('returns nothing for an agent with no descriptor at all', () => {
    assert.equal(resolvePin(fakeAgent('root', fakeCtx({})), deps()), undefined)
  })
})

describe('filter application', () => {
  it('clips names the child\'s composition does not provide, keeping the rest', () => {
    const tools = fakeTools(['bash', 'read', 'find_symbol'])
    applyChildToolFilter(fakeCtx({ tools }), { allow: ['bash', 'todo_write', 'find_symbol'] })
    assert.deepEqual(tools.restrictions, [{ allow: ['bash', 'find_symbol'] }])
  })

  it('leaves no probe restriction behind while clipping', () => {
    const tools = fakeTools(['bash', 'read'])
    applyChildToolFilter(fakeCtx({ tools }), { allow: ['bash', 'read', 'todo_write'] })
    assert.equal(tools.standing(), 1, 'exactly the real restriction stands')
  })

  it('drops unknown deny names but keeps the known ones', () => {
    const tools = fakeTools(['bash', 'workflow'])
    applyChildToolFilter(fakeCtx({ tools }), { deny: ['workflow', 'get_goal'] })
    assert.deepEqual(tools.restrictions, [{ deny: ['workflow'] }])
  })

  it('fails loud when an allowlist names nothing this composition has', () => {
    const tools = fakeTools(['bash'])
    assert.throws(
      () => applyChildToolFilter(fakeCtx({ tools }), { allow: ['todo_write', 'get_goal'] }),
      /allows no tool known to this composition/,
    )
    assert.equal(tools.standing(), 0, 'nothing was installed')
  })

  it('installs no restriction for an empty filter object', () => {
    const tools = fakeTools(['bash'])
    applyChildToolFilter(fakeCtx({ tools }), {})
    assert.equal(tools.restrictions.length, 0)
  })
})

describe('rePin', () => {
  it('re-links a child that joined its parent, then applies the filter', async () => {
    const presets = fakePresets('cordis')
    const tools = fakeTools(['bash', 'find_symbol'])
    await rePin(fakeCtx({ agentPresets: presets, tools }), {
      presetId: 'subagent-worker',
      toolFilter: { allow: ['bash', 'find_symbol'] },
    })
    assert.deepEqual(presets.calls, ['subagent-worker'])
    assert.deepEqual(tools.restrictions, [{ allow: ['bash', 'find_symbol'] }])
  })

  it('does not re-link a child already on its pinned preset, but still filters', async () => {
    const presets = fakePresets('subagent-worker')
    const tools = fakeTools(['bash'])
    await rePin(fakeCtx({ agentPresets: presets, tools }), {
      presetId: 'subagent-worker',
      toolFilter: { allow: ['bash'] },
    })
    assert.deepEqual(presets.calls, [], 'a harness that pins at creation is left alone')
    assert.deepEqual(tools.restrictions, [{ allow: ['bash'] }])
  })

  it('throws a named error when no roster is composed', async () => {
    await assert.rejects(
      () => rePin(fakeCtx({}), { presetId: 'subagent-worker' }),
      /requires the agent-presets roster/,
    )
  })
})

describe('pin enforcement listeners', () => {
  /** A ctx that records listeners so the test can fire them by hand. */
  function listenerCtx() {
    const handlers = new Map<string, ((...args: never[]) => unknown)[]>()
    return {
      handlers,
      ctx: {
        get: () => undefined,
        logger: { warn: () => {} },
        on: (name: string, handler: (...args: never[]) => unknown) => {
          const list = handlers.get(name) ?? []
          list.push(handler)
          handlers.set(name, list)
          return () => {
            const at = (handlers.get(name) ?? []).indexOf(handler)
            if (at >= 0) handlers.get(name)!.splice(at, 1)
          }
        },
      } as never,
    }
  }

  it('registers both listeners and removes them on dispose', () => {
    const { ctx, handlers } = listenerCtx()
    const dispose = installPinning(ctx, deps())
    assert.deepEqual([...handlers.keys()].sort(), ['agent/pre-step', 'agent/session-start'])
    dispose()
    assert.equal(handlers.get('agent/session-start')?.length, 0)
    assert.equal(handlers.get('agent/pre-step')?.length, 0)
  })

  it('applies a recorded pin once, then leaves later steps alone', async () => {
    const { ctx, handlers } = listenerCtx()
    const presets = fakePresets('cordis')
    const tools = fakeTools(['bash'])
    const childCtx = fakeCtx({ agentPresets: presets, tools })
    // The installer resolves services from the listener's own ctx in production;
    // here the child ctx is what rePin reads, which is what the fake below
    // returns.
    ;(ctx as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'agentPresets' ? presets : name === 'tools' ? tools : undefined
    recordPin('child-1', { presetId: 'subagent-worker', toolFilter: { allow: ['bash'] } })
    installPinning(ctx, deps())
    const step = handlers.get('agent/pre-step')![0]!
    const next = (async () => ({ kind: 'enter' })) as never
    await step({ agent: fakeAgent('child-1', childCtx) } as never, next)
    await step({ agent: fakeAgent('child-1', childCtx) } as never, next)
    assert.deepEqual(presets.calls, ['subagent-worker'], 'pinned exactly once')
    assert.equal(recordedPin('child-1'), undefined, 'the applied pin is forgotten')
  })

  it('leaves an unrelated agent untouched and lets its step proceed', async () => {
    const { ctx, handlers } = listenerCtx()
    const presets = fakePresets('cordis')
    ;(ctx as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'agentPresets' ? presets : undefined
    installPinning(ctx, deps())
    const step = handlers.get('agent/pre-step')![0]!
    let proceeded = false
    const next = (async () => {
      proceeded = true
      return { kind: 'enter' }
    }) as never
    await step({ agent: fakeAgent('root-session', fakeCtx({ agentPresets: presets })) } as never, next)
    assert.deepEqual(presets.calls, [])
    assert.equal(proceeded, true, 'the waterfall always continues')
  })
})
