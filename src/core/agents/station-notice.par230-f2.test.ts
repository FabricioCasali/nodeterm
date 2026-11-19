import { afterEach, describe, expect, it, vi } from 'vitest'
import { StationNoticeMonitor, type StationNoticeDeps } from './station-notice'
import { stationRecipient } from '../../shared/station-notice'

interface Attempt {
  nodeId: string
  attemptId: string
  sessionKey: string
  agentId: string
  revision: number
  confirmed: boolean
  suppressed: boolean
}
interface Proof {
  sessionKey: string
  kind: 'agent' | 'shell' | 'unknown'
  commandFinished?: true
}

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  nodeId: 'worker', attemptId: 'attempt-1', sessionKey: 'root:100:birth-1',
  agentId: 'codex', revision: 1, confirmed: false, suppressed: false, ...over
})

function harness(initial = attempt()) {
  let attempts: Attempt[] = [initial]
  const probe = vi.fn<(_a: Attempt) => Promise<Proof | null>>(async () => ({
    sessionKey: initial.sessionKey, kind: 'shell', commandFinished: true
  }))
  const publish = vi.fn()
  const deliver = vi.fn<NonNullable<StationNoticeDeps['deliver']>>(async () => ({ kind: 'queued' as const, position: 1, ttlMs: 1, traceId: 'test' }))
  const deps: StationNoticeDeps & { liveness: {
    attempts(): readonly Attempt[]
    probe: typeof probe
    publish: typeof publish
  } } = {
    now: () => 1_000_000,
    exists: () => true,
    pendingQuestionOf: () => undefined,
    recipientFor: (id) => stationRecipient([{
      id: 'p1', nodes: [
        { id: 'opener', kind: 'terminal', title: 'Opener', agentId: 'claude' },
        { id: 'worker', kind: 'terminal', title: 'Worker', agentId: 'codex', openedBy: 'opener' }
      ], ropes: [{ source: 'opener', target: 'worker' }]
    }], id),
    appendBoardLog: vi.fn(async () => true),
    deliver,
    publish: vi.fn(),
    liveness: { attempts: () => attempts, probe, publish }
  }
  const monitor = new StationNoticeMonitor(deps)
  monitor.onAgentEvent({ nodeId: 'opener', kind: 'state', state: 'done', verified: true })
  return { monitor, deps, probe, publish, deliver, replace: (next: Attempt[]) => { attempts = next } }
}

afterEach(() => vi.useRealTimers())

describe('PAR-230 F2 lifecycle in the core monitor, without a mounted renderer', () => {
  it('T13 publishes launch-failed once only after the same invocation returned, and tells its opener', async () => {
    const h = harness()
    await h.monitor.sweep()
    await h.monitor.sweep()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.publish.mock.calls).toEqual([['worker', 'attempt-1', 'launch-failed']])
    expect(h.deliver).toHaveBeenCalledOnce()
    expect(h.deliver.mock.calls[0]?.[0]).toMatchObject({ stationNodeId: 'worker', recipientNodeId: 'opener' })
  })

  it('T13 publishes lifecycle even when no authorized opener can receive a notice', async () => {
    const h = harness()
    h.deps.recipientFor = () => undefined
    await h.monitor.sweep()
    expect(h.publish).toHaveBeenCalledWith('worker', 'attempt-1', 'launch-failed')
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it.each([
    ['slow initialization in the root shell', { sessionKey: 'root:100:birth-1', kind: 'shell' }],
    ['unreadable probe', null],
    ['unknown tree', { sessionKey: 'root:100:birth-1', kind: 'unknown' }],
    ['another backend generation', { sessionKey: 'root:100:birth-2', kind: 'shell', commandFinished: true }]
  ] as const)('T13 cannot conclude failure from %s', async (_label, proof) => {
    const h = harness()
    h.probe.mockResolvedValue(proof)
    await h.monitor.sweep()
    expect(h.probe).toHaveBeenCalledOnce()
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.deliver).not.toHaveBeenCalled()
  })

  for (const agentId of ['codex', 'antigravity']) {
    for (const state of ['done', 'working'] as const) {
      it(`T14 ${agentId} leaving ${state} publishes dropped once from same-session process proof`, async () => {
        const h = harness(attempt({ agentId, confirmed: true }))
        h.monitor.onAgentEvent({ nodeId: 'worker', kind: 'state', state, verified: true })
        await h.monitor.sweep()
        await h.monitor.sweep()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(h.publish.mock.calls).toEqual([['worker', 'attempt-1', 'dropped']])
        expect(h.deliver).toHaveBeenCalledOnce()
      })
    }
  }

  it('T14 preserves positive CLI observation across sweeps and distinguishes a child shell from exit', async () => {
    const h = harness()
    h.probe.mockResolvedValueOnce({ sessionKey: 'root:100:birth-1', kind: 'agent' })
    await h.monitor.sweep()
    expect(h.publish.mock.calls.some((c) => c[2] === 'dropped' || c[2] === 'launch-failed')).toBe(false)
    await h.monitor.sweep()
    expect(h.publish).toHaveBeenLastCalledWith('worker', 'attempt-1', 'dropped')
  })

  it('T14 positive process observation clears a previous conclusion for the same attempt', async () => {
    const h = harness()
    await h.monitor.sweep()
    h.probe.mockResolvedValue({ sessionKey: 'root:100:birth-1', kind: 'agent' })
    await h.monitor.sweep()
    expect(h.publish.mock.calls).toEqual([
      ['worker', 'attempt-1', 'launch-failed'], ['worker', 'attempt-1', undefined]
    ])
  })

  it('T14 suppressed controls and still-armed launches never probe or publish', async () => {
    const h = harness(attempt({ suppressed: true, confirmed: true }))
    await h.monitor.sweep()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
  })

  it.each(['revision', 'attempt', 'generation', 'removed', 'suppressed', 'forget', 'stop'])(
    'T13/T15 discards a pending result after %s changes', async (change) => {
      const h = harness()
      let resolve!: (p: Proof) => void
      h.probe.mockImplementation(() => new Promise((r) => { resolve = r }))
      const pending = h.monitor.sweep()
      try {
        await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce())
        if (change === 'revision') h.replace([attempt({ revision: 2, confirmed: true })])
        if (change === 'attempt') h.replace([attempt({ attemptId: 'attempt-2' })])
        if (change === 'generation') h.replace([attempt({ sessionKey: 'root:100:birth-2' })])
        if (change === 'removed') h.replace([])
        if (change === 'suppressed') h.replace([attempt({ suppressed: true })])
        if (change === 'forget') h.monitor.forget('worker')
        if (change === 'stop') h.monitor.stop()
      } finally {
        resolve?.({ sessionKey: 'root:100:birth-1', kind: 'shell', commandFinished: true })
        await pending
      }
      expect(h.publish).not.toHaveBeenCalled()
    }
  )

  it('T15 coalesces probes for the same node and leaves no timer after stop', async () => {
    vi.useFakeTimers()
    const h = harness()
    let resolve!: (p: Proof) => void
    h.probe.mockImplementation(() => new Promise((r) => { resolve = r }))
    h.monitor.start()
    const first = h.monitor.sweep()
    const second = h.monitor.sweep()
    try {
      await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce())
      h.monitor.stop()
    } finally {
      h.monitor.stop()
      resolve?.({ sessionKey: 'root:100:birth-1', kind: 'shell', commandFinished: true })
      await Promise.all([first, second])
    }
    expect(h.publish).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
