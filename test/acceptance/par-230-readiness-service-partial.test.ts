import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryQueue, deliverFromControl, type AgentMessagingDeps } from '../../src/core/agents/agent-messaging'
import { DELIVERY_QUEUE_TTL_MS } from '../../src/core/agents/delivery-queue'
import { resetMessageFlow } from '../../src/core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../../src/core/agents/agent-message-trace'
import { reduceEntry, type MirrorEntry } from '../../src/core/agent-status-mirror'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import type { ReceiptEvent } from '../../src/core/agents/agent-message'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { writeNodeTokenFile, resetNodeTokenFilesForTests } from '../../src/core/agents/node-token-files'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
const owner: PaneOwner = { panePid: 10, paneId: 'win32:g1:root-birth', tty: 'win32-console:10', command: 'claude', argv: ['claude'], pids: [11], processBirths: ['agent-birth'] }
const event = (over: Partial<NormalizedAgentEvent>): NormalizedAgentEvent => ({ nodeId: 'worker', agentId: 'claude', sessionId: 'session-1', kind: 'state', verified: true, clientRevision: MANAGED_SCRIPT_REVISION, ...over })
const inferred = () => reduceEntry(reduceEntry(undefined, event({ state: 'working', newTurn: true }), Date.now()), event({ state: 'done', idle: true }), Date.now())
const queues: ReturnType<typeof createDeliveryQueue>[] = []

beforeEach(() => {
  initPlatform(fakePlatform())
  resetNodeTokenFilesForTests()
  expect(writeNodeTokenFile('worker', 'test-token')).toBe(true)
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetMessageFlow(); resetAgentMessageTraceForTests()
})
afterEach(() => { for (const queue of queues.splice(0)) queue.resetForTests(); vi.clearAllTimers(); vi.useRealTimers(); resetMessageFlow(); resetAgentMessageTraceForTests(); resetNodeTokenFilesForTests(); resetPlatformForTests() })

function harness(change: Partial<MirrorEntry> | null = null) {
  let entry = inferred()
  let emit: (event: ReceiptEvent) => void = () => {}
  const checks: boolean[] = []
  const pasted: string[] = []
  const enters: string[] = []
  const order: string[] = []
  const capability = vi.fn(async () => { order.push('capability'); return true })
  const send = vi.fn(async (_id: string, envelope: string, _owner?: PaneOwner, guard?: Guard) => {
    if (guard) {
      checks.push(guard.beforePaste(captured.screens.empty))
      if (!checks.at(-1)) return false
    }
    pasted.push(envelope)
    if (change) entry = { ...entry, ...change }
    const screen = captured.screens.draft.replace('heb ik getest', envelope.split('\n').join('\n  '))
    if (guard) {
      checks.push(guard.beforeSubmit(screen))
      if (!checks.at(-1)) return true
    }
    enters.push(envelope); emit({ nodeId: 'worker', newTurn: true, verified: true })
    return true
  })
  const deps: AgentMessagingDeps & { envelopeGuardSupported: (id: string) => Promise<boolean> } = {
    paneOwner: async () => { order.push('owner'); return owner }, sendEnvelope: send,
    envelopeGuardSupported: capability, hasLiveSession: () => true,
    mirrorEntry: (id) => id === 'worker' ? entry : { state: 'done', stateVerified: true, updatedAt: Date.now() },
    projects: () => [{ id: 'p', nodes: [{ id: 'sender', agentId: 'claude' }, { id: 'worker', agentId: 'claude' }] }],
    paneOwnerProject: () => 'p', isRemoteNode: () => false, messagingEnabled: () => true,
    callerOwnsTarget: (a, b) => a === 'sender' && b === 'worker', customAgents: () => undefined,
    appendBoardLog: async () => true, now: Date.now,
    subscribeReceipts: (cb) => { emit = cb; return () => { emit = () => {} } }
  }
  const flushed = vi.fn(); deps.onQueuedResult = flushed
  const queue = createDeliveryQueue(deps); queues.push(queue); deps.queue = queue
  const request = { verb: 'send' as const, sourceNodeId: 'sender', targetNodeId: 'worker', body: 'task' }
  return { deps, queue, send, checks, pasted, enters, capability, order, flushed,
    get entry() { return entry }, set entry(value: MirrorEntry) { entry = value },
    deliver: () => deliverFromControl(request, deps),
    enqueue: () => queue.enqueue({ ...request, sourceTitle: 'Sender' }) }
}

async function finish<T>(promise: Promise<T>) { await vi.runAllTimersAsync(); return promise }
describe('PAR-230 R4/R6 real service and queue, simulated guarded backend', () => {
  it('forwards capacity after owner proof and both guards through deliverFromControl', async () => {
    const f = harness()
    const result = await finish(f.deliver())
    expect(f.checks).toEqual([true, true])
    expect(result.outcome.kind).toBe('delivered')
    expect(f.capability).toHaveBeenCalledWith('worker')
    expect(f.order.indexOf('owner')).toBeLessThan(f.order.indexOf('capability'))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.entry.idleInferred).toBe(true)
  })
  it.each([
    { pendingQuestion: { sessionId: 'session-1', toolUseId: 'question' } },
    { pendingAsk: { kind: 'approval' as const, since: 1_000_000, id: 'approval' } },
    { concurrentApprovalIds: ['concurrent-approval'] },
    { awaitingInput: true }
  ])('vetoes pending input after paste and does not enqueue the partial: %j', async (change) => {
    const f = harness(change)
    const result = await finish(f.deliver())
    expect(f.checks).toEqual([true, false])
    expect(result.outcome.kind).toBe('stalled')
    expect(f.pasted).toHaveLength(1); expect(f.enters).toEqual([])
    await f.queue.onTargetIdle('worker'); await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(f.queue.depth('worker')).toBe(0); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('claims a queued body once and never offers it again after a pasted partial', async () => {
    const f = harness({ concurrentApprovalIds: ['approval-after-paste'] })
    await f.enqueue()
    await finish(f.queue.onTargetIdle('worker'))
    expect(f.checks).toEqual([true, false])
    expect(f.pasted).toHaveLength(1); expect(f.enters).toEqual([])
    expect(f.queue.depth('worker')).toBe(0)
    expect(f.flushed).toHaveBeenCalledWith(expect.objectContaining({ body: 'task' }), expect.objectContaining({ kind: 'stalled' }))
    f.entry = inferred()
    await f.queue.onTargetIdle('worker'); await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('keeps the ordinary verified done control working without capability', async () => {
    const f = harness(); f.entry = { ...f.entry, idleInferred: undefined }
    expect((await finish(f.deliver())).outcome.kind).toBe('delivered')
    expect(f.enters).toHaveLength(1)
    expect(f.capability).not.toHaveBeenCalled()
  })
})
