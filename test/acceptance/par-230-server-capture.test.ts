import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { _resetForTest as resetMirror } from '../../src/core/agent-status-mirror'
import { resetPaneOwnershipForTests } from '../../src/core/agents/pane-ownership'
import { resetNodeTokenFilesForTests } from '../../src/core/agents/node-token-files'
import { resetMessageFlow } from '../../src/core/agents/agent-message-flow'
import { TerminalEmulator } from '../../src/session-host/terminal-emulator'
import { initServerCanvasControl, type ServerCanvasControl } from '../../src/server/canvas-control'
import type { WorkspaceStore } from '../../src/core/workspace-store'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Project, type Workspace } from '../../src/shared/types'

vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('Unexpected native spawn') }) }))

let runtime: ServerCanvasControl | undefined
let screen: TerminalEmulator

beforeEach(() => {
  resetPlatformForTests()
  initPlatform(fakePlatform())
  resetMirror()
  resetPaneOwnershipForTests()
  resetNodeTokenFilesForTests()
  resetMessageFlow()
  screen = new TerminalEmulator({ cols: 40, rows: 3, scrollback: 10 })
})

afterEach(() => {
  runtime?.stop()
  runtime = undefined
  screen.dispose()
  resetMirror()
  resetPaneOwnershipForTests()
  resetNodeTokenFilesForTests()
  resetMessageFlow()
  resetPlatformForTests()
})

async function harness(activeProjectId = 'project') {
  const node = (id: string): CanvasNodeState => ({
    id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 640, height: 440 },
    title: id, color: '#d97757', group: null, tags: [], agentId: 'claude'
  })
  const project = (id: string, nodes: CanvasNodeState[]): Project => ({
    id, name: id, color: '#d97757', viewport: { x: 0, y: 0, zoom: 1 }, nodes,
    ropes: id === 'project' ? [{ id: 'link', source: 'sender', target: 'target' }] : [], bridges: []
  })
  const workspace: Workspace = {
    version: 2, activeProjectId,
    projects: [project('project', [node('sender'), node('target')]), project('other', [node('foreign')])]
  }
  const save = vi.fn(async () => {})
  const store = {
    load: async () => structuredClone(workspace), save,
    persistedCanvases: () => workspace.projects,
    capabilityProjectFor: () => ({ agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } })
  } as unknown as WorkspaceStore
  const { PtyManager } = await import('../../src/core/pty-manager')
  const pty = new PtyManager()
  const sessions = (pty as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.set('target-session', { persistKey: 'target', indexKey: 'target', tmuxBacked: true })
  sessions.set('sender-session', { persistKey: 'sender', indexKey: 'sender', tmuxBacked: true })
  const capture = vi.spyOn(pty, 'captureVisible').mockImplementation(async () => screen.captureVisible())
  const history = vi.spyOn(pty, 'captureSession').mockResolvedValue('HISTORY MUST NOT BE READ')
  const sendText = vi.spyOn(pty, 'sendText').mockResolvedValue(true)
  const sendEnvelope = vi.spyOn(pty, 'sendEnvelope').mockResolvedValue(true)
  const create = vi.spyOn(pty, 'createHeadless').mockRejectedValue(new Error('Capture must never create a session'))
  const destroy = vi.spyOn(pty, 'destroySession').mockResolvedValue(undefined)
  const write = vi.spyOn(pty, 'writeHeadless').mockReturnValue(true)
  runtime = await initServerCanvasControl({
    workspaceStore: store, ptyManager: pty, settings: () => ({ ...DEFAULT_SETTINGS }),
    boardLog: { append: async () => false },
    cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
    codexCaps: async () => ({ approvalValues: null, noDaemon: true }), codexSharedIdentity: async () => false
  })
  const read = (args: Record<string, string> = { node: 'target' }, verified = true) =>
    runtime!.handler({ verb: 'capture-pane', nodeId: 'sender', args, verified })
  const unchanged = () => {
    for (const operation of [save, history, sendText, sendEnvelope, create, destroy, write]) expect(operation).not.toHaveBeenCalled()
  }
  return { capture, read, unchanged }
}

describe('PAR-230 T07/T20: capture-pane through the Server handler', () => {
  it.each(['project', 'other'])('reads the target visible screen when the active project is %s', async (active) => {
    const h = await harness(active)
    await screen.write('old history\r\none\r\ntwo\r\nthree')
    expect(screen.serialize()).toContain('old history')
    expect(screen.captureVisible().screen).toBe('one\ntwo\nthree\n')
    const response = await h.read()
    h.unchanged()
    expect(response).toMatchObject({ ok: true, message: 'one\ntwo\nthree\n' })
    expect(h.capture).toHaveBeenCalledExactlyOnceWith('target-session')
  })

  it.each([['1', 'three'], ['2', 'two\nthree'], ['8', 'one\ntwo\nthree']])('returns the last %s visible rows', async (lines, expected) => {
    const h = await harness()
    await screen.write('old history\r\none\r\ntwo\r\nthree')
    const response = await h.read({ node: 'target', lines })
    h.unchanged()
    expect(response.ok).toBe(true)
    expect(response.message?.replace(/\n$/, '')).toBe(expected)
    expect(h.capture).toHaveBeenCalledExactlyOnceWith('target-session')
  })

  it('does not mix the alternate screen with normal-screen history', async () => {
    const h = await harness()
    await screen.write('old shell\r\n$ app\x1b[?1049h\x1b[Hdialog')
    const expected = screen.captureVisible().screen
    const response = await h.read()
    h.unchanged()
    expect(response).toMatchObject({ ok: true, message: expected })
    expect(response.message).not.toContain('old shell')
  })

  it('accepts a genuinely empty visible screen', async () => {
    const h = await harness()
    const response = await h.read()
    h.unchanged()
    expect(response).toMatchObject({ ok: true, message: '' })
    expect(h.capture).toHaveBeenCalledExactlyOnceWith('target-session')
  })

  it('reports an unavailable backend as a read failure', async () => {
    const h = await harness()
    h.capture.mockResolvedValue({ screen: '', cursor: null, unavailable: true })
    const response = await h.read()
    h.unchanged()
    expect(h.capture).toHaveBeenCalledExactlyOnceWith('target-session')
    expect(response).toMatchObject({ ok: false, error: expect.any(String), message: expect.any(String) })
    expect(response.error).toMatch(/captur|unavailable|unreadable|backend/i)
    expect(response.message).not.toBe('')
  })

  it.each(['0', '-1', '1.5', 'NaN', '2tail'])('rejects invalid lines=%s before capture', async (lines) => {
    const h = await harness()
    const response = await h.read({ node: 'target', lines })
    h.unchanged()
    expect(h.capture).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: expect.any(String), message: expect.any(String) })
    expect(response.error).toMatch(/lines|integer|positive/i)
  })

  it.each([
    { node: 'absent', verified: true, reason: /node|target|found|exist/i },
    { node: 'foreign', verified: true, reason: /project|scope|permit|authoriz|access|denied/i },
    { node: 'target', verified: false, reason: /verif|identity|authoriz|authentic/i }
  ])('refuses target=$node verified=$verified without capture', async ({ node, verified, reason }) => {
    const h = await harness()
    const response = await h.read({ node }, verified)
    h.unchanged()
    expect(h.capture).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: expect.any(String), message: expect.any(String) })
    expect(response.error).toMatch(reason)
  })
})
