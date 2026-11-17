import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StationNoticeMonitor, type StationNoticeDeps, type StationNoticeEvent } from '../../src/core/agents/station-notice'
import { STATION_QUESTION_NOTICE_MS, stationRecipient, stationRecipientFromOwner, type StationCanvas } from '../../src/shared/station-notice'
import { _resetForTest, openAskFor, recordAgentEvent } from '../../src/core/agent-status-mirror'
import { syntheticAnsweredEvent } from '../../src/core/agents/pending-approvals'

const canvas: StationCanvas = {
  id: 'project',
  nodes: [
    { id: 'opener', kind: 'terminal', agentId: 'claude', title: 'Opener' },
    { id: 'sender', kind: 'terminal', agentId: 'claude', title: 'Sender' },
    { id: 'worker', kind: 'terminal', agentId: 'claude', title: 'Worker', openedBy: 'opener' }
  ],
  ropes: [{ source: 'opener', target: 'worker' }]
}

function harness() {
  const deliver = vi.fn<NonNullable<StationNoticeDeps['deliver']>>().mockResolvedValue({
    kind: 'delivered', traceId: 'notice', traced: 'memory', receipt: 'observed', signal: 'newTurn'
  })
  const questions = new Map<string, string>()
  const monitor = new StationNoticeMonitor({
    now: Date.now, recipientFor: (id) => stationRecipient([canvas], id),
    pendingQuestionOf: (id) => questions.get(id), appendBoardLog: async () => true,
    deliver, publish: () => {}, exists: () => true,
    schedule: (ms, fn) => { setTimeout(fn, ms) }
  })
  const event = (nodeId: string, over: Partial<StationNoticeEvent>) =>
    monitor.onAgentEvent({ nodeId, kind: 'state', verified: true, ...over })
  event('opener', { state: 'done' })
  event('sender', { state: 'done' })
  return { monitor, deliver, questions, event }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); _resetForTest() })
afterEach(() => { _resetForTest(); vi.clearAllTimers(); vi.useRealTimers() })

describe('PAR-230 T05: send/reply failures reach their sender', () => {
  it.each(['send', 'reply'] as const)('expired %s notifies the sender once, without copying the payload', async (verb) => {
    const h = harness()
    const req = { verb, sourceNodeId: 'sender', targetNodeId: 'worker', sourceTitle: 'Sender', body: 'UNTRUSTED_PAYLOAD' }
    const outcome = { kind: 'expired' as const, traceId: 'expired-1', queuedForMs: 300_000 }
    h.monitor.onQueuedResult(req, outcome)
    h.monitor.onQueuedResult(req, outcome)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.deliver.mock.calls[0][0].recipientNodeId).toBe('sender')
    expect(h.deliver.mock.calls[0][0].body).toMatch(/worker/)
    expect(h.deliver.mock.calls[0][0].body).toMatch(/expir/i)
    expect(h.deliver.mock.calls[0][0].body).not.toContain('UNTRUSTED_PAYLOAD')
  })

  it('a discarded send reports its refusal to the sender', async () => {
    const h = harness()
    h.monitor.onQueuedResult({ verb: 'send', sourceNodeId: 'sender', targetNodeId: 'worker' }, {
      kind: 'notPermitted', reason: 'switch-off'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.deliver.mock.calls[0][0].recipientNodeId).toBe('sender')
    expect(h.deliver.mock.calls[0][0].body).toMatch(/switch|permission|disabled/i)
  })
})

describe('PAR-230 T08: permission notices and resolution', () => {
  it('reports an unresolved approval at 15 minutes, once, without close/reassign actions', async () => {
    const h = harness()
    h.event('worker', { state: 'blocked' })
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS - 1)
    h.monitor.sweep()
    expect(h.deliver).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    h.monitor.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.deliver.mock.calls[0][0].body).toMatch(/approval|aprova/i)
    expect(h.deliver.mock.calls[0][0].body).toMatch(/confirm/i)
    expect(h.deliver.mock.calls[0][0].body).not.toMatch(/close --node|reassign|handover/i)
    h.monitor.sweep()
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS)
    expect(h.deliver).toHaveBeenCalledTimes(1)
  })

  it('does not report an approval after verified work resumes', async () => {
    const h = harness()
    h.event('worker', { state: 'blocked' })
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS / 2)
    h.event('worker', { state: 'working' })
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS)
    h.monitor.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it('the real mirror retires a ticket on its correlated native answer', () => {
    recordAgentEvent({ nodeId: 'worker', agentId: 'claude', kind: 'state', state: 'blocked', pendingId: 'worker-1-1' })
    expect(openAskFor('worker')).toEqual({ kind: 'approval', pendingId: 'worker-1-1' })
    recordAgentEvent(syntheticAnsweredEvent('worker', 'worker-1-1', 'allow')!)
    expect(openAskFor('worker')).toBeUndefined()
  })

  it('question reassertion keeps the original age and resolution suppresses its notice', async () => {
    const h = harness()
    h.questions.set('worker', 'question-1')
    h.event('worker', { state: 'waiting', questionId: 'question-1' })
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS / 2)
    h.event('worker', { state: 'blocked' })
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS / 2)
    h.monitor.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    h.questions.delete('worker')
    h.monitor.sweep()
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS)
    expect(h.deliver).toHaveBeenCalledTimes(1)
  })

  it('revoking the opener rope revokes desktop notification authority', () => {
    expect(stationRecipient([canvas], 'worker')?.recipientNodeId).toBe('opener')
    expect(stationRecipient([{ ...canvas, ropes: [] }], 'worker')).toBeUndefined()
  })

  it('server authority needs the matching runtime creator ledger', () => {
    expect(stationRecipientFromOwner([canvas], 'worker', undefined)).toBeUndefined()
    expect(stationRecipientFromOwner([canvas], 'worker', { sourceNodeId: 'opener', projectId: 'other' })).toBeUndefined()
    expect(stationRecipientFromOwner([canvas], 'worker', { sourceNodeId: 'opener', projectId: 'project' })?.recipientNodeId).toBe('opener')
  })
})
