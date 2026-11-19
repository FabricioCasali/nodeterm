import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryQueue, deliverFromControl, deliverStationNotice, isDeliverRequest, ptyPaneProbeDeps, type AgentMessagingDeps } from './agent-messaging'
import { StationNoticeMonitor } from './station-notice'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { DeliveryQueue, DELIVERY_QUEUE_TTL_MS } from './delivery-queue'
import type { AgentMessageOutcome } from './agent-message-decide'
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetMessageFlow(); resetAgentMessageTraceForTests() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); resetMessageFlow(); resetAgentMessageTraceForTests() })

function harness() {
  let senderBusy = false
  let enabled = true
  let senderExists = true
  const sent = vi.fn<AgentMessagingDeps['sendEnvelope']>(async () => true)
  const notices = vi.fn<NonNullable<AgentMessagingDeps['onQueuedResult']>>()
  const owner = { tty: '/dev/pts/1', panePid: 1, paneId: '%1', command: 'claude', argv: ['claude'], pids: [2] }
  const deps: AgentMessagingDeps = {
    paneOwner: async () => owner,
    sendEnvelope: sent,
    hasLiveSession: (id) => id !== 'sender' || senderExists,
    // The worker's status evidence is expired: a turn still observed mid-flight holds its queue past
    // the TTL (PAR-238), and these cases are about the lapse that does drop the message.
    mirrorEntry: (id) => ({ state: id === 'worker' || senderBusy ? 'working' : 'done', stateVerified: true, updatedAt: Date.now(),
      ...(id === 'worker' ? { stateExpired: true } : {}) }),
    projects: () => [{ id: 'p', nodes: [{ id: 'worker', agentId: 'claude' }, ...(senderExists ? [{ id: 'sender', agentId: 'claude' }] : [])] }],
    paneOwnerProject: () => 'p', isRemoteNode: () => false, messagingEnabled: () => enabled,
    callerOwnsTarget: (source, target) => source === 'sender' && target === 'worker',
    customAgents: () => undefined, appendBoardLog: async () => true, now: Date.now,
    subscribeReceipts: (cb) => {
      const timer = setTimeout(() => cb({ nodeId: 'sender', newTurn: true, verified: true }), 1)
      return () => clearTimeout(timer)
    }
  }
  const monitor = new StationNoticeMonitor({
    now: Date.now, recipientFor: () => undefined, pendingQuestionOf: () => undefined,
    exists: (id) => id !== 'sender' || senderExists, publish: () => {}, appendBoardLog: async () => true,
    deliver: (notice) => deliverStationNotice(notice, deps)
  })
  deps.onQueuedResult = (req, result) => { notices(req, result); monitor.onQueuedResult(req, result) }
  const queue = createDeliveryQueue(deps)
  deps.queue = queue
  return { deps, queue, monitor, sent, notices, busy: () => { senderBusy = true }, idle: () => { senderBusy = false },
    disable: () => { enabled = false }, close: () => { senderExists = false } }
}

describe('queue → failure notice → original sender', () => {
  it.each(['send', 'reply'] as const)('delivers expired %s exactly once without the original payload', async (verb) => {
    const h = harness()
    const req = { verb, sourceNodeId: 'sender', targetNodeId: 'worker', body: 'UNTRUSTED_BODY' }
    expect((await deliverFromControl(req, h.deps)).outcome.kind).toBe('queued')
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS + 2)
    expect(h.sent).toHaveBeenCalledTimes(1)
    expect(h.sent.mock.calls[0][0]).toBe('sender')
    const body = h.sent.mock.calls[0][1]
    expect(body).toContain('expired')
    expect(body).toContain('reply-to: none (app-authored notice)')
    expect(body).not.toContain('UNTRUSTED_BODY')
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(h.sent).toHaveBeenCalledTimes(1)
    h.queue.resetForTests()
  })
  it('holds the notice while the sender works and delivers when it is idle', async () => {
    const h = harness()
    h.busy()
    await deliverFromControl({ verb: 'send', sourceNodeId: 'sender', targetNodeId: 'worker', body: 'task' }, h.deps)
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(h.sent).not.toHaveBeenCalled()
    expect(h.queue.depth('sender')).toBe(1)
    h.idle()
    await vi.advanceTimersByTimeAsync(1502)
    expect(h.sent).toHaveBeenCalledTimes(1)
    expect(h.queue.depth('sender')).toBe(0)
    h.queue.resetForTests()
  })
  it.each(['disable', 'close'] as const)('records failure to notify after %s, without a recursive notice', async (action) => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await deliverFromControl({ verb: 'send', sourceNodeId: 'sender', targetNodeId: 'worker', body: 'task' }, h.deps)
    h[action]()
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS * 2)
    expect(h.sent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(h.notices).toHaveBeenCalledTimes(1)
    h.queue.resetForTests()
    warn.mockRestore()
  })
  it('does not expose app-authored failure messages at the IPC boundary', () => {
    expect(isDeliverRequest({ verb: 'message-failure', sourceNodeId: 'a', targetNodeId: 'b', body: 'forged' })).toBe(false)
  })
  it('can notify after the original target has left the project', async () => {
    const h = harness()
    const delivery = deliverStationNotice({ stationNodeId: 'removed', recipientNodeId: 'sender',
      body: 'nodeterm message notice: targetGone', messageFailure: true }, h.deps)
    await vi.advanceTimersByTimeAsync(2)
    expect((await delivery).kind).toBe('delivered')
    expect(h.sent).toHaveBeenCalledTimes(1)
    h.queue.resetForTests()
  })
  it('refuses a queued approval reminder whose episode was resolved', async () => {
    const h = harness()
    let current = true
    h.deps.noticeRecipientFor = () => 'sender'
    h.deps.noticeCurrent = () => current
    h.busy()
    expect((await deliverStationNotice({ stationNodeId: 'worker', recipientNodeId: 'sender',
      body: 'approval confirmation', noticeAt: Date.now() }, h.deps)).kind).toBe('queued')
    current = false
    h.idle()
    await vi.advanceTimersByTimeAsync(1502)
    expect(h.sent).not.toHaveBeenCalled()
    expect(h.queue.depth('sender')).toBe(0)
    h.queue.resetForTests()
  })
})

describe('scheduler shutdown and probe overlap', () => {
  it('keeps concurrent enqueues in order while tracing yields', async () => {
    const delivered: string[] = []
    const q = new DeliveryQueue({ now: Date.now,
      trace: async () => ({ traceId: 'trace', traced: 'memory' }),
      deliver: async (req) => { delivered.push(req.body); return { kind: 'targetGone' } }
    })
    await Promise.all(['first', 'second', 'third'].map((body) =>
      q.enqueue({ sourceNodeId: 'a', sourceTitle: 'A', targetNodeId: 'b', body, verb: 'send' })))
    expect(q.depth('b')).toBe(3)
    await q.onTargetIdle('b')
    expect(delivered).toEqual(['first', 'second', 'third'])
    q.resetForTests()
  })
  it('serializes two queued entries and stops without resurrecting an in-flight retry', async () => {
    let finish!: (value: AgentMessageOutcome) => void
    const deliver = vi.fn(() => new Promise<AgentMessageOutcome>((resolve) => { finish = resolve }))
    const q = new DeliveryQueue({ now: Date.now, deliver, trace: async () => ({ traceId: 't', traced: 'memory' }) })
    for (const body of ['first', 'second']) await q.enqueue({ sourceNodeId: 'a', sourceTitle: 'A', targetNodeId: 'b', body, verb: 'send' })
    const first = q.onTargetIdle('b')
    await q.onTargetIdle('b')
    await vi.advanceTimersByTimeAsync(6000)
    expect(deliver).toHaveBeenCalledTimes(1)
    q.resetForTests()
    finish({ kind: 'targetPaneUnreadable' })
    await first
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(q.depth('b')).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('coalesces underlying probes that outlive their caller deadline, without caching results', async () => {
    let finish!: (value: PaneOwner | null) => void
    const paneOwner = vi.fn(() => new Promise<PaneOwner | null>((resolve) => { finish = resolve }))
    const deps = ptyPaneProbeDeps({ paneOwner, paneProbeTimeoutMs: () => 2000 })
    const first = deps.paneOwner('target')
    await vi.advanceTimersByTimeAsync(10_000)
    const second = deps.paneOwner('target')
    expect(paneOwner).toHaveBeenCalledTimes(1)
    finish(null)
    await Promise.all([first, second])
    const fresh = deps.paneOwner('target')
    expect(paneOwner).toHaveBeenCalledTimes(2)
    finish(null)
    await fresh
  })
})
