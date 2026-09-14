import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { Config } from '../src/config.js'
import { CrewService } from '../src/crew.js'

function mockContext() {
  const provided = new Map<string, unknown>()
  return {
    reflect: { provide: (name: string, value: unknown) => { provided.set(name, value); return () => provided.delete(name) } },
    provided,
    subagents: {
      startContinuable: async () => ({ childId: 'child-' + Math.random().toString(36).slice(2) }),
      sendMessage: async () => 'msg-' + Math.random().toString(36).slice(2),
    },
  } as never
}

describe('Pipeline config', () => {
  it('defaults mode to routed and pipeline to enabled gate', () => {
    const cfg = Config({ presetId: 'subagent-slim', crews: { eng: { roles: [{ name: 'a', presetId: 'p', roleTask: 't' }] } } })
    assert.equal(cfg.crews.eng.mode, 'routed')
    assert.deepEqual(cfg.crews.eng.pipeline.order, [])
    assert.equal(cfg.crews.eng.pipeline.verifyGate.enabled, true)
    assert.equal(cfg.crews.eng.pipeline.verifyGate.verifierRole, 'verifier')
    assert.equal(cfg.crews.eng.pipeline.verifyGate.maxRetries, 3)
  })

  it('parses pipeline mode with tasks', () => {
    const cfg = Config({
      presetId: 'subagent-slim',
      crews: {
        eng: {
          mode: 'pipeline',
          roles: [
            { name: 'planner', presetId: 'p', roleTask: 'Plan', tasks: [{ id: 'T1', title: 'Implement', acceptanceCriteria: 'pass', status: 'pending' }] },
            { name: 'builder', presetId: 'p', roleTask: 'Build' },
            { name: 'verifier', presetId: 'p', roleTask: 'Verify' },
          ],
          pipeline: { order: ['planner', 'builder', 'verifier'], verifyGate: { enabled: true, verifierRole: 'verifier', maxRetries: 2 } },
        },
      },
    })
    assert.equal(cfg.crews.eng.mode, 'pipeline')
    assert.deepEqual(cfg.crews.eng.pipeline.order, ['planner', 'builder', 'verifier'])
    assert.equal(cfg.crews.eng.roles[0].tasks[0].id, 'T1')
  })
})

describe('CrewService pipeline', () => {
  function makePipelineCrew(overrides: any = {}) {
    const cfg = Config({
      presetId: 'subagent-slim',
      crews: {
        eng: {
          mode: 'pipeline',
          roles: [
            { name: 'planner', presetId: 'p', roleTask: 'Plan', tasks: [{ id: 'T1', title: 'Do thing', status: 'pending', acceptanceCriteria: 'done' }] },
            { name: 'builder', presetId: 'p', roleTask: 'Build' },
            { name: 'verifier', presetId: 'p', roleTask: 'Verify' },
          ],
          pipeline: { order: ['planner', 'builder', 'verifier'], verifyGate: { enabled: true, verifierRole: 'verifier', maxRetries: 2 }, ...overrides.pipeline },
          ...overrides,
        },
      },
    })
    return new CrewService(mockContext(), () => cfg)
  }

  it('resolves pipeline order from explicit order or declaration order', () => {
    const svc = makePipelineCrew()
    assert.deepEqual([...svc.pipelineOrder('eng')], ['planner', 'builder', 'verifier'])
    const cfg2 = Config({
      presetId: 'subagent-slim',
      crews: { eng: { mode: 'pipeline', roles: [{ name: 'a', presetId: 'p', roleTask: 't' }, { name: 'b', presetId: 'p', roleTask: 't' }] } },
    })
    const svc2 = new CrewService(mockContext(), () => cfg2)
    assert.deepEqual([...svc2.pipelineOrder('eng')], ['a', 'b'])
  })

  it('computes next and previous in pipeline (cyclic)', () => {
    const svc = makePipelineCrew()
    assert.equal(svc.nextInPipeline('eng', 'planner'), 'builder')
    assert.equal(svc.nextInPipeline('eng', 'verifier'), 'planner')
    assert.equal(svc.previousInPipeline('eng', 'verifier'), 'builder')
    assert.equal(svc.previousInPipeline('eng', 'planner'), 'verifier')
  })

  it('exposes per-role tasks and updates status', () => {
    const svc = makePipelineCrew()
    assert.equal(svc.tasks('eng', 'planner').length, 1)
    assert.equal(svc.task('eng', 'planner', 'T1')?.status, 'pending')
    const updated = svc.updateTask('eng', 'planner', 'T1', { status: 'in_progress' })
    assert.equal(updated.status, 'in_progress')
    assert.equal(svc.task('eng', 'planner', 'T1')?.status, 'in_progress')
    assert.deepEqual(svc.allTasks('eng').map((t) => t.id), ['T1'])
    assert.equal(svc.roleForTask('eng', 'T1'), 'planner')
  })

  it('recordVerification pass clears retries and marks done', () => {
    const svc = makePipelineCrew()
    const r = svc.recordVerification('eng', 'T1', true)
    assert.equal(r.looped, false)
    assert.equal(r.nextRole, 'planner') // verifier -> planner cyclic
    assert.equal(r.blocked, false)
    assert.equal(svc.task('eng', 'planner', 'T1')?.status, 'done')
  })

  it('recordVerification fail increments retries and loops to predecessor', () => {
    const svc = makePipelineCrew()
    let r = svc.recordVerification('eng', 'T1', false)
    assert.equal(r.looped, true)
    assert.equal(r.nextRole, 'builder')
    assert.equal(r.retries, 1)
    assert.equal(svc.task('eng', 'planner', 'T1')?.status, 'failed')
    r = svc.recordVerification('eng', 'T1', false)
    assert.equal(r.retries, 2)
    assert.equal(r.blocked, false)
    // third failure exceeds maxRetries=2 -> blocked
    r = svc.recordVerification('eng', 'T1', false)
    assert.equal(r.blocked, true)
    assert.equal(r.retries, 3)
  })

  it('pipelineAdvance success path from builder to verifier', async () => {
    const ctx = mockContext()
    const cfg = Config({
      presetId: 'subagent-slim',
      crews: {
        eng: {
          mode: 'pipeline',
          roles: [
            { name: 'planner', presetId: 'p', roleTask: 'Plan' },
            { name: 'builder', presetId: 'p', roleTask: 'Build' },
            { name: 'verifier', presetId: 'p', roleTask: 'Verify' },
          ],
          pipeline: { order: ['planner', 'builder', 'verifier'], verifyGate: { enabled: true, verifierRole: 'verifier', maxRetries: 1 } },
        },
      },
    })
    const svc = new CrewService(ctx as never, () => cfg)
    // materialize first (mock)
    await svc.materialize('eng', {} as never, new AbortController().signal)
    const h = await svc.pipelineAdvance('eng', 'builder', [{ type: 'text', text: 'done' } as any], {} as never, new AbortController().signal)
    assert.equal(h.toRole, 'verifier')
    assert.equal(h.gate.looped, false)
  })

  it('pipelineAdvance from verifier with fail loops to builder and with pass advances', async () => {
    const ctx = mockContext()
    const cfg = Config({
      presetId: 'subagent-slim',
      crews: {
        eng: {
          mode: 'pipeline',
          roles: [
            { name: 'planner', presetId: 'p', roleTask: 'Plan' },
            { name: 'builder', presetId: 'p', roleTask: 'Build', tasks: [{ id: 'T1', title: 'Build X', status: 'pending' }] },
            { name: 'verifier', presetId: 'p', roleTask: 'Verify' },
          ],
          pipeline: { order: ['planner', 'builder', 'verifier'], verifyGate: { enabled: true, verifierRole: 'verifier', maxRetries: 3 } },
        },
      },
    })
    const svc = new CrewService(ctx as never, () => cfg)
    await svc.materialize('eng', {} as never, new AbortController().signal)
    // fail
    const fail = await svc.pipelineAdvance('eng', 'verifier', [{ type: 'text', text: 'needs fix' } as any], {} as never, new AbortController().signal, {
      taskId: 'T1',
      verifierVerdict: 'fail',
      evidence: 'tests failed',
    })
    assert.equal(fail.toRole, 'builder')
    assert.equal(fail.gate.looped, true)
    assert.equal(svc.task('eng', 'builder', 'T1')?.status, 'failed')
    // pass
    const pass = await svc.pipelineAdvance('eng', 'verifier', [{ type: 'text', text: 'ok' } as any], {} as never, new AbortController().signal, {
      taskId: 'T1',
      verifierVerdict: 'pass',
    })
    assert.equal(pass.toRole, 'planner')
    assert.equal(pass.gate.looped, false)
    assert.equal(svc.task('eng', 'builder', 'T1')?.status, 'done')
  })

  it('pipeline handoff enforcement rejects non-successor', async () => {
    const ctx = mockContext()
    const cfg = Config({
      presetId: 'subagent-slim',
      crews: {
        eng: {
          mode: 'pipeline',
          roles: [
            { name: 'planner', presetId: 'p', roleTask: 'Plan' },
            { name: 'builder', presetId: 'p', roleTask: 'Build' },
            { name: 'verifier', presetId: 'p', roleTask: 'Verify' },
          ],
          pipeline: { order: ['planner', 'builder', 'verifier'], verifyGate: { enabled: true, verifierRole: 'verifier', maxRetries: 3 } },
        },
      },
    })
    const svc = new CrewService(ctx as never, () => cfg)
    await svc.materialize('eng', {} as never, new AbortController().signal)
    await assert.rejects(
      svc.handoff('eng', 'planner', 'verifier', [{ type: 'text', text: 'skip' } as any], {} as never, new AbortController().signal),
      /pipeline violation/,
    )
    // verifier loop to predecessor is allowed
    await svc.handoff('eng', 'verifier', 'builder', [{ type: 'text', text: 'loop' } as any], {} as never, new AbortController().signal)
  })
})
