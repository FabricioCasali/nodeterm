import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryQueue, DELIVERY_QUEUE_TTL_MS, type DeliveryQueueDeps, type QueuedDeliveryRequest } from '../../src/core/agents/delivery-queue'
import type { AgentMessageOutcome } from '../../src/core/agents/agent-message-decide'
import { PAIR_MIN_INTERVAL_MS, noteSent, reserveFlow, resetMessageFlow } from '../../src/core/agents/agent-message-flow'

const delivered: AgentMessageOutcome = { kind: 'delivered', traceId: 'delivery', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
const request = (over: Partial<QueuedDeliveryRequest> = {}): QueuedDeliveryRequest => ({
  verb: 'send', sourceNodeId: 'sender', targetNodeId: 'worker', sourceTitle: 'Sender', body: 'next task', ...over
})

function queue(deliver: DeliveryQueueDeps['deliver']) {
  const expired = vi.fn()
  const flushed = vi.fn()
  const q = new DeliveryQueue({
    now: Date.now,
    deliver,
    trace: async () => ({ traceId: 'queue', traced: 'memory' }),
    onExpired: expired,
    onFlushed: flushed,
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    }
  })
  return { q, expired, flushed }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetMessageFlow() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); resetMessageFlow() })

describe('PAR-230 T01/T02: queue progress without a new done', () => {
  it.each(['send', 'reply'] as const)('%s is offered before its original TTL without an idle event', async (verb) => {
    const deliver = vi.fn(async () => delivered)
    const { q, expired } = queue(deliver)
    await q.enqueue(request({ verb }))
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS - 1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(q.depth('worker')).toBe(0)
    expect(expired).not.toHaveBeenCalled()
  })

  it('reoffers an unreadable pane that recovers, without another idle event', async () => {
    const deliver = vi.fn<DeliveryQueueDeps['deliver']>()
      .mockResolvedValueOnce({ kind: 'targetPaneUnreadable' }).mockResolvedValue(delivered)
    const { q } = queue(deliver)
    await q.enqueue(request())
    await q.onTargetIdle('worker')
    expect(q.depth('worker')).toBe(1)
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS - 1)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(q.depth('worker')).toBe(0)
  })

  it('preserves the original TTL while the pane remains unreadable', async () => {
    const deliver = vi.fn<DeliveryQueueDeps['deliver']>().mockResolvedValue({ kind: 'targetPaneUnreadable' })
    const { q, expired } = queue(deliver)
    await q.enqueue(request())
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS / 2)
    await q.onTargetIdle('worker')
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS / 2)
    expect(q.depth('worker')).toBe(0)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(expired.mock.calls[0][1].queuedForMs).toBe(DELIVERY_QUEUE_TTL_MS)
    const attempts = deliver.mock.calls.length
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(deliver).toHaveBeenCalledTimes(attempts)
  })

  it('does not overlap an in-flight attempt with timers or another idle event', async () => {
    let finish!: (value: AgentMessageOutcome) => void
    const deliver = vi.fn(() => new Promise<AgentMessageOutcome>((resolve) => { finish = resolve }))
    const { q } = queue(deliver)
    await q.enqueue(request())
    const first = q.onTargetIdle('worker')
    const concurrent = q.onTargetIdle('worker')
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS / 2)
    const attempts = deliver.mock.calls.length
    finish(delivered)
    await Promise.all([first, concurrent])
    expect(attempts).toBe(1)
    expect(q.depth('worker')).toBe(0)
  })
})

describe('PAR-230 T03: real pair limiter and queue scheduler', () => {
  it('retries at the actual rate-limit deadline and keeps FIFO without duplicate delivery', async () => {
    const start = Date.now()
    noteSent('sender', 'worker', start)
    const accepted: string[] = []
    const { q } = queue(async (req) => {
      const reservation = reserveFlow(req.sourceNodeId, req.targetNodeId, Date.now())
      if (!reservation.ok) return reservation.outcome
      accepted.push(req.body)
      noteSent(req.sourceNodeId, req.targetNodeId, Date.now())
      reservation.release()
      return delivered
    })
    await q.enqueue(request({ body: 'first' }))
    await q.enqueue(request({ body: 'second' }))
    await q.onTargetIdle('worker')
    await vi.advanceTimersByTimeAsync(PAIR_MIN_INTERVAL_MS - 1)
    expect(accepted).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(accepted).toEqual(['first'])
    await q.onTargetIdle('worker')
    await vi.advanceTimersByTimeAsync(PAIR_MIN_INTERVAL_MS)
    expect(accepted).toEqual(['first', 'second'])
    expect(q.depth('worker')).toBe(0)
  })
})

describe('PAR-230 T05: terminal delivery failures', () => {
  it('never retries a possibly partial write represented by targetGone', async () => {
    const deliver = vi.fn<DeliveryQueueDeps['deliver']>().mockResolvedValue({ kind: 'targetGone' })
    const { q, flushed, expired } = queue(deliver)
    await q.enqueue(request())
    await q.onTargetIdle('worker')
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(flushed).toHaveBeenCalledTimes(1)
    expect(expired).not.toHaveBeenCalled()
    expect(q.depth('worker')).toBe(0)
  })
})
