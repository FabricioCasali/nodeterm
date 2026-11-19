import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { SessionHostClient } from '../../src/core/session-host-client'
import { sessionHostPaths } from '../../src/session-host/paths'
import { LineFramer, encodeFrame, SESSION_HOST_PROTOCOL_VERSION } from '../../src/session-host/protocol'
import { createDeliveryQueue, deliverFromControl, type AgentMessagingDeps } from '../../src/core/agents/agent-messaging'
import { deliverAgentMessage, type ReceiptEvent } from '../../src/core/agents/agent-message'
import { RETRYABLE } from '../../src/core/agents/agent-message-decide'
import { DELIVERY_QUEUE_TTL_MS } from '../../src/core/agents/delivery-queue'
import { resetMessageFlow } from '../../src/core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../../src/core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import { reduceEntry } from '../../src/core/agent-status-mirror'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { writeNodeTokenFile, resetNodeTokenFilesForTests } from '../../src/core/agents/node-token-files'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
type Mode = 'not-pasted' | 'unreadable' | 'ready' | 'lost-prepare' | 'refused-commit'
const owner: PaneOwner = { panePid: 42, paneId: 'win32:g:birth', tty: 'win32-console:42', command: 'claude', argv: ['claude'], pids: [43], processBirths: ['born'] }
const request = { verb: 'send' as const, sourceNodeId: 'sender', targetNodeId: 'worker', body: 'task' }
const cleanup: Array<() => Promise<void> | void> = []
const event = (over: Partial<NormalizedAgentEvent>): NormalizedAgentEvent => ({ nodeId: 'worker', agentId: 'claude', sessionId: 'session-1', kind: 'state', verified: true, clientRevision: MANAGED_SCRIPT_REVISION, ...over })
const inferred = () => reduceEntry(reduceEntry(undefined, event({ state: 'working', newTurn: true }), Date.now()), event({ state: 'done', idle: true }), Date.now())

beforeEach(() => {
  initPlatform(fakePlatform())
  resetNodeTokenFilesForTests()
  expect(writeNodeTokenFile('worker', 'sanitized-refusal-token')).toBe(true)
  vi.useFakeTimers(); vi.setSystemTime(1_000_000)
  resetMessageFlow(); resetAgentMessageTraceForTests()
})
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
  resetMessageFlow(); resetAgentMessageTraceForTests()
  resetNodeTokenFilesForTests(); resetPlatformForTests()
})

async function harness(initialMode: Mode = 'not-pasted') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'par-230-refusal-peer-'))
  const paths = sessionHostPaths(dir)
  cleanup.push(() => {
    if (process.platform !== 'win32') fs.rmSync(paths.endpoint, { force: true })
    fs.rmSync(dir, { recursive: true, force: true })
    expect(fs.existsSync(dir)).toBe(false)
  })
  const token = createHash('sha256').update('sanitized-refusal-peer').digest('hex')
  fs.writeFileSync(paths.tokenPath, token)
  fs.writeFileSync(paths.statePath, JSON.stringify({ pid: process.pid, endpoint: paths.endpoint, tokenPath: paths.tokenPath, startedAt: 1, protocolVersion: SESSION_HOST_PROTOCOL_VERSION }))
  let mode = initialMode
  let entry = inferred()
  let live = true
  let connections = 0
  let legacyResult = true
  const requests: Array<{ cmd: string; envelope?: string; connection: number }> = []
  const sockets = new Set<net.Socket>()
  const listeners = new Set<(event: ReceiptEvent) => void>()
  const checks: Array<{ phase: 'paste' | 'submit'; accepted: boolean }> = []
  const pasted: string[] = []
  const submitted: string[] = []
  const frame = (screen: string) => ({ screen, cursor: { x: 0, y: 0 }, altScreen: false })
  const server = net.createServer((socket) => {
    const connection = ++connections
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      for (const req of framer.push<{ id: number; cmd: string; envelope?: string }>(chunk.toString('utf8'))) {
        requests.push({ ...req, connection })
        let result: unknown
        if (req.cmd === 'hello') result = { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features: ['captureVisible', 'guardedMessageEnvelopeV1'] }
        else if (req.cmd === 'messageOwnerV1') result = owner
        else if (req.cmd === 'hasSession') result = { exists: live, generation: 'same-generation' }
        else if (req.cmd === 'captureVisible') result = mode === 'unreadable' ? null : frame(captured.screens.empty)
        else if (req.cmd === 'messageEnvelopePrepareV1') {
          if (mode === 'lost-prepare') { socket.destroy(); continue }
          if (mode === 'not-pasted') result = { kind: 'not-pasted' }
          else {
            pasted.push(req.envelope!)
            result = { kind: 'pasted', preparationId: 'sanitized-preparation', screen: frame(captured.screens.draft.replace('heb ik getest', req.envelope!.split('\n').join('\n  '))) }
          }
        } else if (req.cmd === 'messageEnvelopeCommitV1') {
          result = { submitted: mode !== 'refused-commit' }
          if (mode !== 'refused-commit') {
            submitted.push(pasted.at(-1)!)
            for (const listener of listeners) listener({ nodeId: 'worker', newTurn: true, verified: true })
          }
        } else if (req.cmd === 'messageEnvelopeV1') result = legacyResult
        else {
          socket.write(encodeFrame({ id: req.id, ok: false, error: 'unexpected command' }))
          continue
        }
        socket.write(encodeFrame({ id: req.id, ok: true, result }))
      }
    })
  })
  cleanup.push(async () => {
    const closed = [...sockets].map((socket) => once(socket, 'close'))
    for (const socket of sockets) socket.destroy()
    await Promise.all(closed)
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    expect(sockets.size).toBe(0)
    expect(server.listening).toBe(false)
  })
  server.listen(paths.endpoint); await once(server, 'listening')
  const client = new SessionHostClient({ userDataDir: dir, repoRoot: dir })
  const send = vi.fn(async (_id: string, envelope: string, expected?: PaneOwner, guard?: Guard) => {
    const observed = guard && {
      beforePaste(screen: string) {
        const accepted = guard.beforePaste(screen)
        checks.push({ phase: 'paste', accepted }); return accepted
      },
      beforeSubmit(screen: string) {
        const accepted = guard.beforeSubmit(screen)
        checks.push({ phase: 'submit', accepted }); return accepted
      }
    }
    return client.messageEnvelope('nt-worker', envelope, expected!, observed)
  })
  const deps: AgentMessagingDeps = {
    paneOwner: () => client.messageOwner('nt-worker'), sendEnvelope: send,
    envelopeGuardSupported: async () => client.connectedFeature('guardedMessageEnvelopeV1') === true,
    hasLiveSession: () => live,
    mirrorEntry: (id) => id === 'worker' ? entry : { state: 'done', stateVerified: true, updatedAt: Date.now() },
    projects: () => [{ id: 'p', nodes: [{ id: 'sender', agentId: 'claude' }, { id: 'worker', agentId: 'claude' }] }],
    paneOwnerProject: () => 'p', isRemoteNode: () => false, messagingEnabled: () => true,
    callerOwnsTarget: (a, b) => a === 'sender' && b === 'worker', customAgents: () => undefined,
    appendBoardLog: async () => true, now: Date.now,
    subscribeReceipts: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const flushed = vi.fn(); deps.onQueuedResult = flushed
  const queue = createDeliveryQueue(deps); deps.queue = queue
  cleanup.push(() => { queue.resetForTests(); expect(listeners.size).toBe(0) })
  return { client, deps, queue, send, checks, pasted, submitted, requests, flushed,
    commands: () => requests.map((req) => req.cmd),
    get connections() { return connections },
    get entry() { return entry }, set entry(value: typeof entry) { entry = value },
    set mode(value: Mode) { mode = value }, set live(value: boolean) { live = value },
    set legacyResult(value: boolean) { legacyResult = value },
    deliver: () => deliverFromControl(request, deps),
    enqueue: () => queue.enqueue({ ...request, sourceTitle: 'Sender' }) }
}

function expectRefusalPath(f: Awaited<ReturnType<typeof harness>>, mode: 'not-pasted' | 'unreadable') {
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.send.mock.calls[0][3]).toBeDefined()
  expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible', ...(mode === 'not-pasted' ? ['messageEnvelopePrepareV1'] : [])])
  expect(f.checks).toEqual(mode === 'not-pasted' ? [{ phase: 'paste', accepted: true }] : [])
  expect(f.pasted).toEqual([]); expect(f.submitted).toEqual([])
  expect(f.connections).toBe(1)
  expect(f.entry).toMatchObject({ state: 'done', idleInferred: true, stateVerified: true, sessionId: 'session-1' })
}

describe('PAR-230 C1–C5 real service/core/client/queue with simulated protocol peer', () => {
  it.each(['not-pasted', 'unreadable'] as const)('C1/C2 classifies %s as retryable only after the client refusal', async (mode) => {
    const f = await harness(mode)
    delete f.deps.queue
    const initial = { ...f.entry }
    const result = await f.deliver()
    expectRefusalPath(f, mode)
    expect(await f.client.hasSession('nt-worker')).toBe(true)
    expect(await f.client.messageOwner('nt-worker')).toEqual(owner)
    expect(f.entry).toEqual(initial)
    expect(result.outcome.kind).toBe('targetNotIdleUnknown')
    expect(RETRYABLE[result.outcome.kind]).toBe(true)
    expect(JSON.stringify(result)).not.toContain('no live session exists')
  })

  it('control: the ready peer exercises both real core guards and delivers once', async () => {
    const f = await harness('ready')
    const result = await f.deliver()
    expect(result.outcome.kind).toBe('delivered')
    expect(f.checks).toEqual([{ phase: 'paste', accepted: true }, { phase: 'submit', accepted: true }])
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible', 'messageEnvelopePrepareV1', 'messageEnvelopeCommitV1', 'messageOwnerV1'])
    expect(f.pasted).toHaveLength(1); expect(f.submitted).toEqual(f.pasted)
    expect(f.entry.idleInferred).toBe(true)
  })

  it('C3 retains a refused body and reoffers it once when the same session is ready', async () => {
    const f = await harness()
    await f.enqueue()
    await f.queue.onTargetIdle('worker')
    expectRefusalPath(f, 'not-pasted')
    expect(f.queue.depth('worker')).toBe(1)
    expect(f.flushed).not.toHaveBeenCalled()
    f.mode = 'ready'
    await f.queue.onTargetIdle('worker')
    expect(f.queue.depth('worker')).toBe(0)
    expect(f.flushed).toHaveBeenCalledWith(expect.objectContaining({ body: 'task' }), expect.objectContaining({ kind: 'delivered' }))
    expect(f.pasted).toHaveLength(1); expect(f.submitted).toEqual(f.pasted)
    expect(f.pasted[0].split('\n').filter((line) => line === 'task')).toHaveLength(1)
    await f.queue.onTargetIdle('worker')
    await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.requests.filter((req) => req.cmd === 'messageEnvelopeCommitV1')).toHaveLength(1)
    expect(f.connections).toBe(1)
  })

  it('C3 keeps the original TTL after a late confirmed not-pasted refusal', async () => {
    const f = await harness()
    const start = Date.now()
    await f.enqueue()
    vi.setSystemTime(start + DELIVERY_QUEUE_TTL_MS / 2)
    await f.queue.onTargetIdle('worker')
    expectRefusalPath(f, 'not-pasted')
    expect(f.queue.depth('worker')).toBe(1)
    vi.setSystemTime(start + DELIVERY_QUEUE_TTL_MS)
    await f.queue.onTargetIdle('worker')
    expect(f.queue.depth('worker')).toBe(0)
    expect(f.flushed).toHaveBeenCalledWith(expect.objectContaining({ body: 'task' }), expect.objectContaining({ kind: 'expired', queuedForMs: DELIVERY_QUEUE_TTL_MS }))
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('C4 preserves proven disappearance before transport', async () => {
    const f = await harness(); f.live = false
    const outcome = await deliverAgentMessage({ ...request, sourceTitle: 'Sender', targetAgentId: 'claude', targetLive: false }, {
      paneOwner: f.deps.paneOwner, sendEnvelope: f.send, mirrorEntry: () => f.entry,
      tokenFilePresent: () => true, lock: async (_id, fn) => fn(),
      bracketPasteRequested: async () => true, now: Date.now,
      subscribeEvents: () => () => {},
      trace: async () => ({ traceId: 'proven-gone', traced: 'memory' })
    })
    expect(outcome.kind).toBe('targetGone')
    expect(f.send).not.toHaveBeenCalled(); expect(f.requests).toEqual([])
  })

  it('C4 preserves legacy false for ordinary verified done through the real client', async () => {
    const f = await harness(); f.entry = { ...f.entry, idleInferred: undefined }; f.legacyResult = false
    const result = await f.deliver()
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'messageEnvelopeV1'])
    expect(f.checks).toEqual([])
    expect(result.outcome.kind).toBe('targetGone')
  })

  it.each(['lost-prepare', 'refused-commit'] as const)('C5 does not reoffer %s after a potential or confirmed paste', async (mode) => {
    const f = await harness(mode)
    await f.enqueue()
    const pending = f.queue.onTargetIdle('worker')
    if (mode === 'lost-prepare') {
      await vi.waitFor(() => expect(f.requests.some((req) => req.cmd === 'messageEnvelopePrepareV1')).toBe(true))
    } else {
      await vi.waitFor(() => expect(f.requests.some((req) => req.cmd === 'messageEnvelopeCommitV1')).toBe(true))
    }
    await vi.runOnlyPendingTimersAsync()
    await pending
    expect(f.checks[0]).toEqual({ phase: 'paste', accepted: true })
    expect(f.flushed).toHaveBeenCalledWith(expect.objectContaining({ body: 'task' }), expect.objectContaining({ kind: 'stalled' }))
    expect(f.queue.depth('worker')).toBe(0); expect(f.submitted).toEqual([])
    f.mode = 'ready'
    await f.queue.onTargetIdle('worker'); await vi.advanceTimersByTimeAsync(DELIVERY_QUEUE_TTL_MS)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.requests.filter((req) => req.cmd === 'messageEnvelopePrepareV1')).toHaveLength(1)
    expect(f.requests.some((req) => req.cmd === 'messageEnvelopeV1')).toBe(false)
    expect(f.requests.filter((req) => req.cmd.startsWith('messageEnvelope')).every((req) => req.connection === 1)).toBe(true)
  })
})
