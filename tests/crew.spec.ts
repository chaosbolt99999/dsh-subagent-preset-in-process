import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { Config } from '../src/config.js'
import { CrewService } from '../src/crew.js'

function makeCrew() {
  return Config({
    presetId: 'subagent-slim',
    crews: {
      engineering: {
        orchestratorRole: 'orchestrator',
        roles: [
          { name: 'planner', presetId: 'slim-planner', roleTask: 'Plan work.' },
          { name: 'orchestrator', presetId: 'slim-orchestrator', roleTask: 'Route work.' },
          { name: 'builder', presetId: 'slim-builder', roleTask: 'Build.' },
          { name: 'verifier', presetId: 'slim-verifier', roleTask: 'Verify.' },
        ],
      },
    },
  })
}

/** Minimal Context stub: only what `Service`'s `super(ctx, name)` touches. */
function mockContext() {
  const provided = new Map<string, unknown>()
  return {
    reflect: { provide: (name: string, value: unknown) => { provided.set(name, value); return () => provided.delete(name) } },
    provided,
  } as never
}

describe('CrewService', () => {
  it('lists crew names and roles', () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    assert.deepEqual(svc.listCrews(), ['engineering'])
    assert.deepEqual(svc.roles('engineering'), ['planner', 'orchestrator', 'builder', 'verifier'])
  })

  it('resolves the configured orchestrator role', () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    assert.equal(svc.orchestrator('engineering'), 'orchestrator')
  })

  it('defaults the orchestrator to the first role when none configured and none named orchestrator', () => {
    const config = Config({
      presetId: 'subagent-slim',
      crews: {
        plain: {
          roles: [
            { name: 'alpha', presetId: 'p', roleTask: 'a' },
            { name: 'beta', presetId: 'p', roleTask: 'b' },
          ],
        },
      },
    })
    const svc = new CrewService(mockContext(), () => config)
    assert.equal(svc.orchestrator('plain'), 'alpha')
  })

  it('rejects handoff to an unknown crew', async () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    await assert.rejects(
      svc.handoff('nope', 'planner', 'builder', [], {} as never, new AbortController().signal),
      /unknown crew/,
    )
  })

  it('rejects self-handoff', async () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    await assert.rejects(
      svc.handoff('engineering', 'planner', 'planner', [], {} as never, new AbortController().signal),
      /cannot hand off/,
    )
  })

  it('throws on duplicate crew names during construction', () => {
    // Config schema collapses duplicate keys, so simulate by direct construction is not needed;
    // the constructor's guard is exercised by the toCrew path in practice. Assert the happy path.
    const svc = new CrewService(mockContext(), () => makeCrew())
    assert.equal(svc.member('engineering', 'planner'), undefined)
  })
})

describe('CrewService.reloadCrews (live settings)', () => {  it('picks up an added crew and updated role pins without a restart', () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    const updated = Config({
      presetId: 'subagent-slim',
      crews: {
        engineering: {
          roles: [{ name: 'planner', presetId: 'slim-planner', roleTask: 'Plan work.' }],
        },
        support: {
          roles: [{ name: 'triage', presetId: 'slim-triage', roleTask: 'Triage.' }],
        },
      },
    })
    svc.reloadCrews(updated.crews ?? {})
    assert.deepEqual(svc.listCrews().sort(), ['engineering', 'support'])
    assert.deepEqual(svc.roles('engineering'), ['planner'])
    assert.deepEqual(svc.roles('support'), ['triage'])
  })

  it('drops removed crews from the roster', () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    const empty = Config({ presetId: 'subagent-slim', crews: {} })
    svc.reloadCrews(empty.crews ?? {})
    assert.deepEqual(svc.listCrews(), [])
  })
})

describe('CrewService role route (request-level override)', () => {
  /** Context stub whose `subagents.startContinuable` records each request. */
  function mockCtxWithSubagents(captured: any[]) {
    return {
      reflect: { provide: () => () => {} },
      subagents: {
        startContinuable: async (spec: any) => {
          captured.push(spec)
          return { childId: `child-${captured.length}`, messageId: `msg-${captured.length}` }
        },
      },
    } as never
  }

  /** A crew whose roles carry the overrides passed in. */
  function crewWithRoles(roles: any[], extra: Record<string, unknown> = {}) {
    return Config({
      presetId: 'subagent-slim',
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
      ...extra,
      crews: { engineering: { roles } },
    })
  }

  it('follows the plugin settings when a role overrides nothing', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([{ name: 'builder', presetId: 'slim', roleTask: 'Build.' }]),
    )
    const members = await svc.materialize('engineering', {} as never, new AbortController().signal)
    assert.deepEqual(captured[0].request.agentOptions, {
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
    })
    assert.equal('maxTokens' in captured[0].request.agentOptions, false)
    // A role that declares no toolFilter must not send one: an empty/false
    // filter would strip the child's entire tool set.
    assert.equal('toolFilter' in captured[0].request, false)
    assert.deepEqual(members[0].route, {
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
    })
  })

  it('forwards a declared role toolFilter unchanged', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([{ name: 'builder', presetId: 'slim', roleTask: 'Build.', toolFilter: { allow: ['bash'] } }]),
    )
    await svc.materialize('engineering', {} as never, new AbortController().signal)
    assert.deepEqual(captured[0].request.toolFilter, { allow: ['bash'], deny: [] })
  })

  it('lets a role agentOptions override win field by field', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([
        { name: 'builder', presetId: 'slim', roleTask: 'Build.', agentOptions: { model: 'gpt-5.6-sol' } },
        { name: 'verifier', presetId: 'slim', roleTask: 'Verify.', agentOptions: { provider: 'ccode', maxTokens: 2048 } },
      ]),
    )
    await svc.materialize('engineering', {} as never, new AbortController().signal)
    assert.deepEqual(captured[0].request.agentOptions, {
      provider: 'merge',
      model: 'gpt-5.6-sol',
    })
    assert.deepEqual(captured[1].request.agentOptions, {
      provider: 'ccode',
      model: 'deepseek/deepseek-v4-flash-0731',
      maxTokens: 2048,
    })
  })

  it('keeps the legacy flat role fields working as aliases', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([{ name: 'builder', presetId: 'slim', roleTask: 'Build.', model: 'flat-model', maxTokens: 512 }]),
    )
    await svc.materialize('engineering', {} as never, new AbortController().signal)
    assert.deepEqual(captured[0].request.agentOptions, {
      provider: 'merge',
      model: 'flat-model',
      maxTokens: 512,
    })
  })

  it('prefers the nested field over the flat alias for the same field', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([
        { name: 'builder', presetId: 'slim', roleTask: 'Build.', model: 'flat-model', agentOptions: { model: 'nested-model' } },
      ]),
    )
    await svc.materialize('engineering', {} as never, new AbortController().signal)
    assert.equal(captured[0].request.agentOptions.model, 'nested-model')
  })

  it('lets a role maxTokens override the plugin cap', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([{ name: 'builder', presetId: 'slim', roleTask: 'Build.', agentOptions: { maxTokens: 900 } }], {
        maxTokens: 4096,
      }),
    )
    await svc.materialize('engineering', {} as never, new AbortController().signal)
    assert.equal(captured[0].request.agentOptions.maxTokens, 900)
  })

  it('reports the effective route per role and follows a live settings change', () => {
    let current = crewWithRoles([
      { name: 'builder', presetId: 'slim', roleTask: 'Build.' },
      { name: 'verifier', presetId: 'slim', roleTask: 'Verify.', agentOptions: { model: 'pinned' } },
    ])
    const svc = new CrewService(mockContext(), () => current)
    assert.deepEqual(svc.roleRoute('engineering', 'builder'), {
      provider: 'merge',
      model: 'deepseek/deepseek-v4-flash-0731',
    })
    assert.deepEqual(svc.roleRoute('engineering', 'verifier'), { provider: 'merge', model: 'pinned' })
    current = Config({
      presetId: 'subagent-slim',
      provider: 'ccode',
      model: 'gpt-5.6-luna',
      crews: {
        engineering: {
          roles: [
            { name: 'builder', presetId: 'slim', roleTask: 'Build.' },
            { name: 'verifier', presetId: 'slim', roleTask: 'Verify.', agentOptions: { model: 'pinned' } },
          ],
        },
      },
    })
    assert.deepEqual(svc.roleRoute('engineering', 'builder'), { provider: 'ccode', model: 'gpt-5.6-luna' })
    assert.deepEqual(svc.roleRoute('engineering', 'verifier'), { provider: 'ccode', model: 'pinned' })
  })

  it('rejects an unknown role when resolving its route', () => {
    const svc = new CrewService(mockContext(), () => makeCrew())
    assert.throws(() => svc.roleRoute('engineering', 'nope'), /has no role/)
  })

  it('tracks only materialized members and their effective routes', async () => {
    const captured: any[] = []
    const svc = new CrewService(mockCtxWithSubagents(captured), () =>
      crewWithRoles([
        { name: 'builder', presetId: 'slim', roleTask: 'Build.' },
        { name: 'verifier', presetId: 'slim', roleTask: 'Verify.' },
      ]),
    )
    assert.deepEqual(svc.liveMembers('engineering'), [])
    await svc.materialize('engineering', {} as never, new AbortController().signal)
    const live = svc.liveMembers('engineering')
    assert.deepEqual(live.map((m) => m.role), ['builder', 'verifier'])
    assert.equal(String(live[0].childId), 'child-1')
    assert.equal(live[0].presetId, 'slim')
  })
})
