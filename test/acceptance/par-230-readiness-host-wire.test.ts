import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { build, stop, type Plugin } from 'esbuild'
import { LineFramer, encodeFrame, SESSION_HOST_PROTOCOL_VERSION, type SessionHostResponse } from '../../src/session-host/protocol'
import { sessionHostPaths, type SessionHostState } from '../../src/session-host/paths'
import { MESSAGE_ENVELOPE_REQUEST_TIMEOUT_MS } from '../../src/core/session-host-client'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'
import { readClaudeComposer, readClaudeDraft } from '../../src/shared/agents/claude-screen'

const feature = 'guardedMessageEnvelopeV1'
const features = ['captureVisible', feature]
const body = '--- NODETERM MESSAGE wire ---\nhello\n--- END NODETERM MESSAGE wire ---'
const spawnOptions = { cwd: '.', shell: 'fake-shell', args: [], env: {}, cols: 160, rows: 60 }
const sockets = new Set<net.Socket>()
let root: string
let child: ChildProcess
let endpoint: string
let token: string
let serial = 0
let control: { screen: string; born: string; repaintOnProbe: string | null; partial: boolean }
const controlPath = () => path.join(root, 'control.json')
const writeControl = () => writeFileSync(controlPath(), JSON.stringify(control))
const writes = (): string[] => readFileSync(path.join(root, 'writes.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

function dependencies(): Plugin {
  const originalProbe = path.resolve('src/session-host/windows-pane-owner.ts').replaceAll('\\', '/')
  return {
    name: 'par-230-pty-and-os-only',
    setup(bundle) {
      bundle.onResolve({ filter: /windows-pane-owner\.ts$/, namespace: 'par230' }, () => ({ path: path.resolve('src/session-host/windows-pane-owner.ts'), namespace: 'file' }))
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'pty', namespace: 'par230' }))
      bundle.onResolve({ filter: /\/windows-pane-owner$/ }, () => ({ path: 'probe', namespace: 'par230' }))
      bundle.onLoad({ filter: /^probe$/, namespace: 'par230' }, () => ({ loader: 'js', contents: `
        export * from ${JSON.stringify(originalProbe)};
        import { windowsConsoleOwner } from ${JSON.stringify(originalProbe)};
        import fs from 'node:fs';
        export async function readWindowsConsoleOwner(pid, generation) {
          const c = JSON.parse(fs.readFileSync(process.env.PAR230_CONTROL, 'utf8'));
          if (c.repaintOnProbe) globalThis.par230Paint?.(c.repaintOnProbe);
          return windowsConsoleOwner(pid, generation, { console: [pid, pid + 1], processes: [
            { pid, parent: 1, executable: 'C:/pwsh.exe', born: '2026-01-01T00:00:00Z' },
            { pid: pid + 1, parent: pid, executable: 'C:/claude.exe', born: c.born }
          ] });
        }
      ` }))
      bundle.onLoad({ filter: /^pty$/, namespace: 'par230' }, () => ({ loader: 'js', contents: `
        import fs from 'node:fs';
        export function spawn() {
          let exited, data;
          const paint = (screen) => data?.('\\x1b[2J\\x1b[H' + screen.replace(/\\n/g, '\\r\\n') + '\\x1b[?2004h');
          return { pid: 4242,
            onExit(cb) { exited = cb; },
            onData(cb) { data = cb; globalThis.par230Paint = paint; setTimeout(() => paint(JSON.parse(fs.readFileSync(process.env.PAR230_CONTROL, 'utf8')).screen), 0); },
            write(text) {
              if (text === '@@exit') return exited?.({ exitCode: 0 });
              if (text === '@@paint') return paint(JSON.parse(fs.readFileSync(process.env.PAR230_CONTROL, 'utf8')).screen);
              fs.appendFileSync(process.env.PAR230_WRITES, JSON.stringify(text) + '\\n');
              const m = /^\\x1b\\[200~([\\s\\S]*)\\x1b\\[201~$/.exec(text);
              if (m) {
                const c = JSON.parse(fs.readFileSync(process.env.PAR230_CONTROL, 'utf8'));
                if (!c.partial) paint(${JSON.stringify(captured.screens.draft)}.replace('heb ik getest', m[1].split('\\n').join('\\n  ')));
              }
            },
            resize() {}, pause() {}, resume() {}, kill() { exited?.({ exitCode: 0 }); }
          };
        }
      ` }))
    }
  }
}

interface Connection {
  socket: net.Socket
  call(body: Record<string, unknown>): Promise<SessionHostResponse>
}
function resultOf(response: SessionHostResponse): unknown {
  expect(response).toMatchObject({ ok: true })
  return response.ok ? response.result : undefined
}
async function connect(negotiate = features, authenticate = true): Promise<Connection> {
  const socket = net.connect(endpoint)
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  const framer = new LineFramer()
  let id = 0
  const waiting = new Map<number, (response: SessionHostResponse) => void>()
  socket.on('data', (chunk: Buffer) => {
    for (const frame of framer.push<SessionHostResponse>(chunk.toString('utf8'))) {
      if (typeof frame.id === 'number') waiting.get(frame.id)?.(frame)
    }
  })
  await once(socket, 'connect')
  const conn: Connection = { socket, call(request) {
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`no response: ${String(request.cmd)}`)) }, MESSAGE_ENVELOPE_REQUEST_TIMEOUT_MS)
      waiting.set(requestId, (frame) => {
        clearTimeout(timer); waiting.delete(requestId)
        if (!frame.ok && String(request.cmd).startsWith('messageEnvelope')) console.info(JSON.stringify({ cmd: request.cmd, error: frame.error }))
        resolve(frame)
      })
      socket.write(encodeFrame({ id: requestId, ...request }))
    })
  } }
  if (authenticate) expect(await conn.call({ cmd: 'hello', token, protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features: negotiate })).toMatchObject({ ok: true })
  return conn
}

async function session(screen = captured.screens.empty) {
  control = { screen, born: '2026-01-01T00:00:01Z', repaintOnProbe: null, partial: false }
  writeControl()
  const conn = await connect()
  const name = `par230-${++serial}`
  expect(await conn.call({ cmd: 'attach', name, spawn: spawnOptions, scrollback: 100 })).toMatchObject({ ok: true })
  let frame = ''
  for (let i = 0; i < 200; i++) {
    const r = await conn.call({ cmd: 'captureVisible', name })
    frame = (resultOf(r) as { screen: string }).screen
    if (readClaudeComposer(frame) === readClaudeComposer(screen) && readClaudeDraft(frame) === readClaudeDraft(screen)) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(readClaudeComposer(frame)).toBe(readClaudeComposer(screen))
  const response = await conn.call({ cmd: 'messageOwnerV1', name })
  expect(response).toMatchObject({ ok: true })
  const expected = resultOf(response)
  expect(expected).toMatchObject({ panePid: 4242, command: 'claude' })
  writeFileSync(path.join(root, 'writes.jsonl'), '')
  return { conn, name, expected, prepare: () => conn.call({ cmd: 'messageEnvelopePrepareV1', name, expected, agentId: 'claude', envelope: body }) }
}

async function prepared(f: Awaited<ReturnType<typeof session>>) {
  const r = await f.prepare()
  expect(r).toMatchObject({ ok: true, result: { kind: 'pasted', preparationId: expect.any(String) } })
  const result = resultOf(r) as { preparationId: string; screen: { screen: string } | null }
  expect(result.preparationId.length).toBeGreaterThan(0)
  expect(writes()).toEqual([`\x1b[200~${body}\x1b[201~`])
  return result
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'par-230-readiness-host-'))
  mkdirSync(path.join(root, 'data'))
  writeFileSync(path.join(root, 'writes.jsonl'), '')
  const bundle = path.join(root, 'host.cjs')
  await build({ absWorkingDir: process.cwd(), entryPoints: ['src/session-host/host.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [dependencies()] })
  stop()
  child = spawn(process.execPath, [bundle, path.join(root, 'data')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PAR230_CONTROL: controlPath(), PAR230_WRITES: path.join(root, 'writes.jsonl') } })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', (chunk) => console.info(`host stderr: ${String(chunk)}`))
  console.info(JSON.stringify({ process: 'fixture-host', pid: child.pid, spawnedAt: new Date().toISOString() }))
  const paths = sessionHostPaths(path.join(root, 'data'))
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as SessionHostState
      token = readFileSync(paths.tokenPath, 'utf8').trim()
      endpoint = state.endpoint
      if (endpoint && token) return
    } catch { /* host publishes asynchronously */ }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('fixture identity not published')
}, 30_000)

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
  if (child) console.info(JSON.stringify({ process: 'fixture-host', pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }))
  stop()
  if (root) {
    if (process.platform !== 'win32' && endpoint) rmSync(endpoint, { force: true })
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

describe('PAR-230 R5 real host dispatcher / fake PTY and OS probe', () => {
  it('negotiates the additive feature while preserving captureVisible', async () => {
    const conn = await connect()
    expect(await conn.call({ cmd: 'hello', token, protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features })).toMatchObject({ ok: true, result: { features: expect.arrayContaining(features) } })
  })
  it('keeps the established detached-write dispatcher operational', async () => {
    const f = await session()
    expect(await f.conn.call({ cmd: 'writeDetachedV1', name: f.name, data: 'control' })).toMatchObject({ ok: true })
    expect(writes()).toEqual(['control'])
  })
  it('keeps unguarded messageEnvelopeV1 functional without the new negotiated feature', async () => {
    const f = await session()
    const legacy = await connect(['captureVisible'])
    expect(await legacy.call({ cmd: 'messageEnvelopeV1', name: f.name, envelope: body, expected: f.expected })).toMatchObject({ ok: true, result: true })
    expect(writes()).toEqual([`\x1b[200~${body}\x1b[201~`, '\r'])
  })
  it('refuses unnegotiated preparation before any byte and preserves the live session', async () => {
    const f = await session()
    const old = await connect(['captureVisible'])
    expect(await old.call({ cmd: 'messageEnvelopePrepareV1', name: f.name, expected: f.expected, agentId: 'claude', envelope: body })).toMatchObject({ ok: false })
    for (const cmd of ['messageEnvelopeCommitV1', 'messageEnvelopeCancelV1']) expect(await old.call({ cmd, name: f.name, preparationId: 'unknown' })).toMatchObject({ ok: false })
    expect(writes()).toEqual([])
    expect(await old.call({ cmd: 'hasSession', name: f.name })).toMatchObject({ ok: true, result: { exists: true } })
  })
  it.each([
    ['messageEnvelopeCommitV1', { submitted: false }],
    ['messageEnvelopeCancelV1', { cancelled: false }]
  ] as const)('handles %s of an unknown preparation without writing', async (cmd, result) => {
    const f = await session()
    expect(await f.conn.call({ cmd, name: f.name, preparationId: 'unknown' })).toMatchObject({ ok: true, result })
    expect(writes()).toEqual([])
  })
  it('prepares without Enter then commits exactly once, refusing replay and another socket', async () => {
    const f = await session()
    const p = await prepared(f)
    expect(p.screen).not.toBeNull()
    const other = await connect()
    const commit = { cmd: 'messageEnvelopeCommitV1', name: f.name, preparationId: p.preparationId }
    expect(await other.call(commit)).toMatchObject({ ok: true, result: { submitted: false } })
    expect(await f.conn.call(commit)).toMatchObject({ ok: true, result: { submitted: true } })
    expect(await f.conn.call(commit)).toMatchObject({ ok: true, result: { submitted: false } })
    expect(writes()).toEqual([`\x1b[200~${body}\x1b[201~`, '\r'])
  })
  it('allows only one active preparation across sockets in a generation', async () => {
    const f = await session()
    await prepared(f)
    const other = await connect()
    expect(await other.call({ cmd: 'messageEnvelopePrepareV1', name: f.name, expected: f.expected, agentId: 'claude', envelope: body })).toMatchObject({ ok: true, result: { kind: 'not-pasted' } })
    expect(writes()).toHaveLength(1)
  })
  it('cancel is socket-bound, invalidates commit and never edits the composer', async () => {
    const f = await session()
    const p = await prepared(f)
    const other = await connect()
    const cancel = { cmd: 'messageEnvelopeCancelV1', name: f.name, preparationId: p.preparationId }
    expect(await other.call(cancel)).toMatchObject({ ok: true, result: { cancelled: false } })
    expect(await f.conn.call({ ...cancel, preparationId: 'wrong' })).toMatchObject({ ok: true, result: { cancelled: false } })
    expect(await f.conn.call(cancel)).toMatchObject({ ok: true, result: { cancelled: true } })
    expect(await f.conn.call(cancel)).toMatchObject({ ok: true, result: { cancelled: false } })
    expect(await f.conn.call({ ...cancel, cmd: 'messageEnvelopeCommitV1' })).toMatchObject({ ok: true, result: { submitted: false } })
    expect(writes()).toHaveLength(1)
  })
  it.each(['draft', 'multiline', 'pasted', 'shellmode'] as const)('refuses captured %s before paste', async (name) => {
    const f = await session(captured.screens[name])
    expect(await f.prepare()).toMatchObject({ ok: true, result: { kind: 'not-pasted' } })
    expect(writes()).toEqual([])
  })
  it('rechecks the visible screen after the OS probe before pasting', async () => {
    const f = await session()
    control.repaintOnProbe = captured.screens.draft
    writeControl()
    expect(await f.prepare()).toMatchObject({ ok: true, result: { kind: 'not-pasted' } })
    expect(writes()).toEqual([])
  })
  it.each(['edited', 'process', 'generation'] as const)('withholds Enter after %s substitution', async (change) => {
    const f = await session()
    const p = await prepared(f)
    if (change === 'edited') {
      control.screen = captured.screens.draft; writeControl()
      await f.conn.call({ cmd: 'writeDetachedV1', name: f.name, data: '@@paint' })
    } else if (change === 'process') {
      control.born = '2026-01-01T00:00:02Z'; writeControl()
    } else {
      await f.conn.call({ cmd: 'writeDetachedV1', name: f.name, data: '@@exit' })
      expect(await f.conn.call({ cmd: 'hasSession', name: f.name })).toMatchObject({ result: { exists: false } })
      expect(await f.conn.call({ cmd: 'attach', name: f.name, spawn: spawnOptions, scrollback: 100 })).toMatchObject({ ok: true })
    }
    if (change !== 'edited') expect(resultOf(await f.conn.call({ cmd: 'messageOwnerV1', name: f.name }))).not.toEqual(f.expected)
    expect(await f.conn.call({ cmd: 'messageEnvelopeCommitV1', name: f.name, preparationId: p.preparationId })).toMatchObject({ ok: true, result: { submitted: false } })
    expect(writes()).toHaveLength(1)
  })
  it('cleans preparation on socket close without ending the session or inheriting its nonce', async () => {
    const f = await session()
    const p = await prepared(f)
    const closed = once(f.conn.socket, 'close'); f.conn.socket.destroy(); await closed
    const next = await connect()
    expect(await next.call({ cmd: 'hasSession', name: f.name })).toMatchObject({ result: { exists: true } })
    expect(await next.call({ cmd: 'messageEnvelopeCommitV1', name: f.name, preparationId: p.preparationId })).toMatchObject({ ok: true, result: { submitted: false } })
    control.screen = captured.screens.empty; writeControl()
    await next.call({ cmd: 'writeDetachedV1', name: f.name, data: '@@paint' })
    const fresh = await next.call({ cmd: 'messageEnvelopePrepareV1', name: f.name, expected: f.expected, agentId: 'claude', envelope: body })
    expect(fresh).toMatchObject({ ok: true, result: { kind: 'pasted', preparationId: expect.any(String) } })
    expect((resultOf(fresh) as { preparationId: string }).preparationId).not.toBe(p.preparationId)
    expect(writes()).toHaveLength(2)
  })
  it('reports pasted with no screen when the compositor never confirms the paste', async () => {
    const f = await session()
    control.partial = true; writeControl()
    const p = await prepared(f)
    expect(p.screen).toBeNull()
    expect(await f.conn.call({ cmd: 'messageEnvelopeCommitV1', name: f.name, preparationId: p.preparationId })).toMatchObject({ ok: true, result: { submitted: false } })
    expect(writes()).toHaveLength(1)
  }, MESSAGE_ENVELOPE_REQUEST_TIMEOUT_MS)
})
