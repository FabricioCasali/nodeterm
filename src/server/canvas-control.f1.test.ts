import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { _resetForTest, recordAgentEvent } from '../core/agent-status-mirror'
import { PtyManager } from '../core/pty-manager'
import { initServerCanvasControl, type ServerCanvasControl } from './canvas-control'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { WorkspaceStore } from '../core/workspace-store'

vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('Unexpected spawn') }) }))
let runtime: ServerCanvasControl | undefined
beforeEach(() => { resetPlatformForTests(); initPlatform(fakePlatform()); _resetForTest() })
afterEach(() => { runtime?.stop(); runtime = undefined; _resetForTest(); resetPlatformForTests() })

it('lists pending detail/age and folder trust through the real Server handler', async () => {
  const nodes = [{ id: 'sender', agentId: 'claude' }, { id: 'worker', agentId: 'claude' }, { id: 'trust', agentId: 'claude' }]
  const projects = [{ id: 'p', nodes }]
  const store = { load: async () => ({ version: 2, projects }),
    persistedCanvases: () => projects, save: vi.fn(), capabilityProjectFor: () => ({}) } as unknown as WorkspaceStore
  const pty = new PtyManager()
  const capture = vi.spyOn(pty, 'captureSession').mockImplementation(async (id) => id === 'trust'
    ? '─'.repeat(100) + '\n Accessing workspace:\n Yes, I trust this folder\n Enter to confirm · Esc to cancel' : '')
  runtime = await initServerCanvasControl({ workspaceStore: store, ptyManager: pty,
    settings: () => ({ ...DEFAULT_SETTINGS }), boardLog: { append: async () => false },
    cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
    codexCaps: async () => ({ approvalValues: null, noDaemon: true }), codexSharedIdentity: async () => false })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const event = { nodeId: 'worker', agentId: 'claude' as const, sessionId: 's', kind: 'state' as const,
    state: 'blocked' as const, askKind: 'approval' as const, pendingId: 'ticket', lastMessage: 'Bash "pwd"', verified: true }
  recordAgentEvent(event)
  clock.mockReturnValue(now + 65 * 60_000)
  recordAgentEvent(event)
  const reply = await runtime.handler({ verb: 'list', nodeId: 'sender', args: {}, verified: true })
  expect(reply.ok).toBe(true)
  expect(reply.message).toContain('NEEDS YOU [approval 65m: Bash "pwd"]')
  expect(reply.message).toContain('NEEDS YOU [dialog: folder-trust]')
  expect(capture).toHaveBeenCalledWith('trust', false, true)
  capture.mockClear()
  expect((await runtime.handler({ verb: 'list', nodeId: 'sender', args: {}, verified: false })).ok).toBe(false)
  expect((await runtime.handler({ verb: 'list', nodeId: 'sender', args: { project: 'other' }, verified: true })).ok).toBe(false)
  expect(capture).not.toHaveBeenCalled()
  expect(store.save).not.toHaveBeenCalled()
  clock.mockRestore()
})
