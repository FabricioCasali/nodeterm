import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { SessionHostClient } from '../../src/core/session-host-client'
import { sessionHostPaths } from '../../src/session-host/paths'
import { LineFramer, encodeFrame, SESSION_HOST_PROTOCOL_VERSION } from '../../src/session-host/protocol'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
type GuardedClient = { messageEnvelope(name: string, body: string, expected: PaneOwner, guard?: Guard): Promise<boolean> }
const owner: PaneOwner = { panePid: 42, paneId: 'win32:g:birth', tty: 'win32-console:42', command: 'claude', argv: ['claude'], pids: [43], processBirths: ['born'] }
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks() })

async function peer(options: { feature?: boolean; captureFeature?: boolean; capture?: string | null; pasted?: string | null; drop?: 'prepare' | 'commit'; notPasted?: boolean; submitted?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'par-230-client-peer-'))
  const paths = sessionHostPaths(dir)
  cleanup.push(() => { if (process.platform !== 'win32') fs.rmSync(paths.endpoint, { force: true }); fs.rmSync(dir, { recursive: true, force: true }) })
  const token = createHash('sha256').update('sanitized-fixture').digest('hex')
  fs.writeFileSync(paths.tokenPath, token)
  fs.writeFileSync(paths.statePath, JSON.stringify({ pid: process.pid, endpoint: paths.endpoint, tokenPath: paths.tokenPath, startedAt: 1, protocolVersion: SESSION_HOST_PROTOCOL_VERSION }))
  const requests: Array<{ cmd: string; connection: number; [key: string]: unknown }> = []
  const sockets = new Set<net.Socket>()
  let connections = 0
  const frame = (screen: string) => ({ screen, cursor: { x: 0, y: 0 }, altScreen: false })
  const server = net.createServer((socket) => {
    const connection = ++connections
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      for (const req of framer.push<{ id: number; cmd: string }>(chunk.toString('utf8'))) {
        requests.push({ ...req, connection })
        if ((req.cmd === 'messageEnvelopePrepareV1' && options.drop === 'prepare') || (req.cmd === 'messageEnvelopeCommitV1' && options.drop === 'commit')) { socket.destroy(); continue }
        let result: unknown
        if (req.cmd === 'hello') result = { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features: [...(options.captureFeature === false ? [] : ['captureVisible']), ...(options.feature === false ? [] : ['guardedMessageEnvelopeV1'])] }
        else if (req.cmd === 'messageOwnerV1') result = owner
        else if (req.cmd === 'hasSession') result = { exists: true, generation: 'g' }
        else if (req.cmd === 'captureVisible') result = options.capture === null ? null : frame(options.capture ?? captured.screens.empty)
        else if (req.cmd === 'messageEnvelopePrepareV1') result = options.notPasted ? { kind: 'not-pasted' } : { kind: 'pasted', preparationId: 'peer-preparation', screen: options.pasted === null ? null : frame(options.pasted ?? captured.screens.draft) }
        else if (req.cmd === 'messageEnvelopeCommitV1') result = { submitted: options.submitted ?? true }
        else if (req.cmd === 'messageEnvelopeCancelV1') result = { cancelled: true }
        else if (req.cmd === 'messageEnvelopeV1') result = true
        else { socket.write(encodeFrame({ id: req.id, ok: false, error: 'unknown command' })); continue }
        socket.write(encodeFrame({ id: req.id, ok: true, result }))
      }
    })
  })
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) })
  server.listen(paths.endpoint); await once(server, 'listening')
  const client = new SessionHostClient({ userDataDir: dir, repoRoot: dir })
  const guard = { beforePaste: vi.fn(() => true), beforeSubmit: vi.fn(() => true) }
  return { client, guard, requests,
    connect: () => client.messageOwner('nt-worker'),
    send: () => (client as unknown as GuardedClient).messageEnvelope('nt-worker', 'body\x1b[201~', owner, guard),
    commands: () => requests.map((r) => r.cmd), get connections() { return connections } }
}

describe('PAR-230 R5 client only, simulated protocol peer', () => {
  it('control: the existing unguarded client sends V1 to this peer', async () => {
    const f = await peer({ feature: false }); await f.connect()
    expect(await f.client.messageEnvelope('nt-worker', 'body', owner)).toBe(true)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'messageEnvelopeV1'])
  })
  it('does not connect for a guarded operation before a pane proof established the socket', async () => {
    const f = await peer()
    expect(await f.send()).toBe(false)
    expect(f.requests).toEqual([])
  })
  it('captures, prepares, runs both local guards and commits on the already proven socket', async () => {
    const f = await peer()
    await f.connect()
    expect(await f.send()).toBe(true)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible', 'messageEnvelopePrepareV1', 'messageEnvelopeCommitV1'])
    expect(f.connections).toBe(1)
    expect(f.guard.beforePaste).toHaveBeenCalledWith(captured.screens.empty)
    expect(f.guard.beforeSubmit).toHaveBeenCalledWith(captured.screens.draft)
    expect(f.requests.find((r) => r.cmd === 'messageEnvelopePrepareV1')).toMatchObject({ name: 'nt-worker', expected: owner, agentId: 'claude', envelope: 'body[201~' })
    expect(f.requests.every((r) => !('guard' in r))).toBe(true)
  })
  it('refuses a host without feature with no mutating request or legacy fallback', async () => {
    const f = await peer({ feature: false }); await f.connect()
    expect(await f.send()).toBe(false)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1'])
    expect(await f.client.hasSession('nt-worker')).toBe(true)
    expect(f.connections).toBe(1)
  })
  it('requires captureVisible negotiated on the same socket', async () => {
    const f = await peer({ captureFeature: false }); await f.connect()
    expect(await f.send()).toBe(false)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1'])
  })
  it.each(['veto', 'throw', 'unreadable'] as const)('refuses %s before prepare', async (reason) => {
    const f = await peer({ capture: reason === 'unreadable' ? null : undefined }); await f.connect()
    if (reason === 'veto') f.guard.beforePaste.mockReturnValue(false)
    if (reason === 'throw') f.guard.beforePaste.mockImplementation(() => { throw new Error('guard veto') })
    expect(await f.send()).toBe(false)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible'])
  })
  it.each(['veto', 'throw', 'null-screen'] as const)('keeps pasted partial true and cancels on %s', async (reason) => {
    const f = await peer({ pasted: reason === 'null-screen' ? null : undefined }); await f.connect()
    if (reason === 'veto') f.guard.beforeSubmit.mockReturnValue(false)
    if (reason === 'throw') f.guard.beforeSubmit.mockImplementation(() => { throw new Error('guard veto') })
    expect(await f.send()).toBe(true)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible', 'messageEnvelopePrepareV1', 'messageEnvelopeCancelV1'])
    if (reason === 'null-screen') expect(f.guard.beforeSubmit).not.toHaveBeenCalled()
    expect(f.connections).toBe(1)
  })
  it.each(['prepare', 'commit'] as const)('returns partial true on lost %s response, without reconnect or retransmission', async (drop) => {
    const f = await peer({ drop }); await f.connect()
    expect(await f.send()).toBe(true)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible', 'messageEnvelopePrepareV1', ...(drop === 'commit' ? ['messageEnvelopeCommitV1'] : [])])
    expect(f.connections).toBe(1)
  })
  it('returns false only for confirmed not-pasted', async () => {
    const f = await peer({ notPasted: true }); await f.connect()
    expect(await f.send()).toBe(false)
    expect(f.commands()).toEqual(['hello', 'messageOwnerV1', 'captureVisible', 'messageEnvelopePrepareV1'])
    expect(f.guard.beforeSubmit).not.toHaveBeenCalled()
  })
  it('preserves partial true after refused commit', async () => {
    const f = await peer({ submitted: false }); await f.connect()
    expect(await f.send()).toBe(true)
    expect(f.commands().filter((cmd) => cmd === 'messageEnvelopeCommitV1')).toHaveLength(1)
  })
})
