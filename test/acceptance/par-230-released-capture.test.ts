import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyManager } from '../../src/core/pty-manager'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { createCapturePaneControlHandler } from '../../src/core/capture-pane-control'
import { listControlNodes } from '../../src/core/canvas-control-core'
import { TerminalEmulator } from '../../src/session-host/terminal-emulator'
import { sessionName } from '../../src/core/tmux-naming'

const backend = vi.hoisted(() => ({
  create: vi.fn(), attach: vi.fn(), visible: vi.fn(), history: vi.fn(), has: vi.fn(), kill: vi.fn()
}))
vi.mock('../../src/core/session-host-backend', async (original) => ({
  ...(await original<typeof import('../../src/core/session-host-backend')>()),
  sessionHostSupported: () => true,
  createSessionHostPty: backend.create, attachExistingSessionHostPty: backend.attach,
  sessionHostCaptureVisible: backend.visible, sessionHostCapture: backend.history,
  sessionHostHasSession: backend.has, sessionHostKillSession: backend.kill,
  sessionHostListSessions: async () => []
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('Unexpected native spawn') }) }))

let manager: PtyManager
let screen: TerminalEmulator
let attached: boolean
let alive: boolean
const NODE = 'target'
const NAME = sessionName(NODE)
const projects = [{ id: 'project', nodes: [
  { id: 'sender', kind: 'terminal', agentId: 'codex' },
  { id: NODE, kind: 'terminal', agentId: 'claude', title: 'Worker' }
], ropes: [] }]

beforeEach(() => {
  initPlatform(fakePlatform())
  screen = new TerminalEmulator({ cols: 80, rows: 3, scrollback: 10 })
  attached = false
  alive = false
  backend.create.mockReset().mockImplementation((name: string) => {
    expect(name).toBe(NAME)
    expect(alive).toBe(false)
    alive = attached = true
    return {
      ready: Promise.resolve({ fresh: true }),
      onData: vi.fn(), onExit: vi.fn(), onSize: vi.fn(), onAttachError: vi.fn(),
      write: vi.fn(() => { throw new Error('Unexpected write') }),
      resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      kill: vi.fn(() => { attached = false }), destroy: vi.fn(() => { attached = false })
    }
  })
  backend.attach.mockReset().mockImplementation(() => { throw new Error('Unexpected adoption') })
  backend.history.mockReset().mockImplementation(async () => screen.serialize())
  backend.visible.mockReset().mockImplementation(async (name: string) => {
    expect(name).toBe(NAME)
    return alive ? screen.captureVisible() : null
  })
  backend.has.mockReset().mockImplementation(async (name: string) => alive && name === NAME)
  backend.kill.mockReset().mockImplementation(async () => { alive = false })
  manager = new PtyManager()
})
afterEach(async () => {
  await manager.killAll()
  screen.dispose()
  resetPlatformForTests()
})

async function start() {
  const id = manager.createDetached({ cols: 80, rows: 3, persistKey: NODE }, { onData: () => {}, onExit: () => {} })
  await Promise.resolve()
  expect(manager.hasSession(id)).toBe(true)
  expect(manager.sessionOfNode(NODE)).toBe(id)
  expect(attached).toBe(true)
  return id
}
function release(id: string) {
  manager.kill(null, id)
  const indexes = manager as unknown as {
    sessions: Map<string, unknown>; byPersistKey: Map<string, string>
    released: Map<string, { sessionId: string; sessionHost: boolean; remote: boolean }>
  }
  expect(indexes.sessions.has(id)).toBe(false)
  expect(indexes.byPersistKey.has(NODE)).toBe(false)
  expect(indexes.released.get(NODE)).toMatchObject({ sessionId: id, sessionHost: true, remote: false })
  expect(attached).toBe(false)
  expect(alive).toBe(true)
  // Detach may persist its final snapshot; the subsequent read must never request history.
  backend.history.mockClear()
}
function handler() {
  return createCapturePaneControlHandler({ projects: () => projects,
    sessionOf: (node) => manager.sessionOfNode(node), captureVisible: (id) => manager.captureVisible(id)
  }, async () => { throw new Error('Unexpected control fallback') })
}
function read() {
  return handler()({ verb: 'capture-pane', nodeId: 'sender', verified: true, args: { node: NODE } })
}
function unchanged() {
  expect(backend.create).toHaveBeenCalledTimes(1)
  expect(backend.attach).not.toHaveBeenCalled()
  expect(backend.history).not.toHaveBeenCalled()
  expect(backend.kill).not.toHaveBeenCalled()
}

describe('PAR-230 T07/T20: capture through the persistent session release lifecycle', () => {
  it.each(['active', 'parked', 'released'] as const)('reads the same backend screen while %s', async (state) => {
    const id = await start()
    await screen.write('old history\r\none\r\ntwo\r\nthree')
    expect(screen.serialize()).toContain('old history')
    expect(screen.captureVisible().screen).toBe('one\ntwo\nthree\n')
    if (state === 'parked') {
      manager.resize(null, id, null, null)
      const sessions = (manager as unknown as { sessions: Map<string, { sizes: Map<unknown, unknown> }> }).sessions
      expect(sessions.get(id)?.sizes.size).toBe(0)
      expect(attached).toBe(true)
    }
    if (state === 'released') release(id)
    const response = await read()
    unchanged()
    expect.soft(response).toMatchObject({ ok: true, message: 'one\ntwo\nthree\n' })
    expect.soft(backend.visible).toHaveBeenCalledExactlyOnceWith(NAME)
  })

  it.each(['active', 'released'] as const)('keeps host-without-visible-capability refusal explicit while %s', async (state) => {
    const id = await start()
    backend.visible.mockResolvedValue(null)
    if (state === 'released') release(id)
    expect(await read()).toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/i) })
    unchanged()
  })

  it.each(['active', 'released'] as const)('reads current folder-trust in list while %s', async (state) => {
    const id = await start()
    screen.resize(120, 12)
    // Sanitized Claude 2.1.283 capture from shared/agents/claude-screen.test.ts.
    await screen.write([
      '─'.repeat(100), ' Accessing workspace:', ' ~/project',
      ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
      " well-known open source project, or work from your team). If not, take a moment to review what's in",
      ' this folder first.', " Claude Code'll be able to read, edit, and execute files here.",
      ' Security guide', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'
    ].join('\r\n'))
    if (state === 'released') release(id)
    const result = await listControlNodes('sender', {}, {
      projects: () => projects, statusOf: () => undefined, now: Date.now,
      capture: (node) => manager.captureSession(node, false, true)
    })
    unchanged()
    expect.soft(result.message).toContain('NEEDS YOU [dialog: folder-trust]')
    expect.soft(backend.visible).toHaveBeenCalledExactlyOnceWith(NAME)
  })
})
