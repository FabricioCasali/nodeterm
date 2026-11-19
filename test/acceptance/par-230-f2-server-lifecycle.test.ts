import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { _resetForTest, _snapshot, recordAgentEvent } from '../../src/core/agent-status-mirror'
import { initServerCanvasControl, type ServerCanvasControl } from '../../src/server/canvas-control'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { PtyManager } from '../../src/core/pty-manager'
import { randomUUID } from 'node:crypto'
import type { StationNoticeMonitor } from '../../src/core/agents/station-notice'
import { buildAgentStatusSnapshot } from '../../src/core/agent-status-snapshot'
import { createAgentStatusSession } from '../../src/renderer/state/agentStatus'
import { applyAgentStatusSnapshot } from '../../src/renderer/session/relay-agent-status'
import { cardBadge, parseStatusChipSig, statusChipSig } from '../../src/renderer/lib/kanbanStatusChips'

const observed = vi.hoisted(() => ({ monitors: [] as StationNoticeMonitor[] }))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('unexpected machine spawn') }) }))
vi.mock('../../src/core/session-host-backend', async (original) => ({
  ...(await original<typeof import('../../src/core/session-host-backend')>()),
  sessionHostExecuteLaunch: vi.fn(async () => ({ status: 'executed' })),
  sessionHostSupported: () => true,
  createSessionHostPty: () => ({ ready: Promise.resolve({ fresh: true, launchDialect: 'pwsh' }), onSize: vi.fn(), onData: vi.fn(),
    onExit: vi.fn(), onAttachError: vi.fn(), write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), destroy: vi.fn(), kill: vi.fn() })
}))
vi.mock('../../src/core/pty-devices', async (original) => ({
  ...(await original<typeof import('../../src/core/pty-devices')>()), readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))
vi.mock('../../src/core/agents/station-notice', async (original) => {
  const actual = await original<typeof import('../../src/core/agents/station-notice')>()
  return { ...actual, StationNoticeMonitor: class extends actual.StationNoticeMonitor {
    constructor(...args: ConstructorParameters<typeof actual.StationNoticeMonitor>) {
      super(...args); observed.monitors.push(this)
    }
  } }
})

let runtime: ServerCanvasControl | undefined
let manager: PtyManager | undefined
beforeEach(() => { initPlatform(fakePlatform()); _resetForTest(); observed.monitors.length = 0 })
afterEach(async () => {
  runtime?.stop(); runtime = undefined
  await manager?.killAll(); manager = undefined
  _resetForTest(); resetPlatformForTests(); vi.restoreAllMocks()
})

async function harness(agentId: 'codex' | 'antigravity', state: 'working' | 'done') {
  const store = new WorkspaceStore()
  const node = (id: string, agent: string) => ({ id, kind: 'terminal' as const, agentId: agent,
    title: id, color: '#fff', position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, group: null })
  await store.save({ version: 2, activeProjectId: 'offscreen', projects: [{ id: 'offscreen', name: 'Offscreen', color: '#fff',
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('source', 'claude'), node('worker', agentId)] }] })
  manager = new PtyManager({ runtimePlatform: 'win32' })
  const internal = manager as unknown as { launchIntentDepsOverride: Record<string, unknown> }
  internal.launchIntentDepsOverride = { customAgents: () => [], exists: (p: string) => p.endsWith(`\\${agentId === 'codex' ? 'codex' : 'agy'}.exe`),
    sharedIdentityAvailable: async () => false, codexCaps: async () => ({ approvalValues: null, noDaemon: true }) }
  const paneOwner = vi.spyOn(manager, 'paneOwner').mockResolvedValue({ panePid: 700, tty: 'win32-console:700',
    paneId: 'win32:generation:birth', command: 'pwsh', argv: ['pwsh'], pids: [700], processBirths: ['birth'] })
  vi.spyOn(manager, 'paneCommand').mockResolvedValue('pwsh')
  vi.spyOn(manager, 'captureSession').mockResolvedValue('')
  vi.spyOn(manager, 'sessionExists').mockResolvedValue(true)
  const pty = manager
  runtime = await initServerCanvasControl({ workspaceStore: store, ptyManager: pty, settings: () => ({ ...DEFAULT_SETTINGS }),
    boardLog: { append: async () => false },
    cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
    codexCaps: async () => ({ approvalValues: null, noDaemon: true }), codexSharedIdentity: async () => false })
  expect(await manager.createHeadless({ persistKey: 'worker', cols: 80, rows: 24, shell: 'pwsh.exe', agentId })).toMatchObject({ persistent: true })
  const launched = await manager.executeLaunch('worker', { launchId: randomUUID(),
    intent: { kind: 'agent', action: 'start', agentId, prompt: 'literal' } })
  expect(launched, JSON.stringify(launched)).toEqual({ ok: true })
  recordAgentEvent({ nodeId: 'worker', agentId, sessionId: 'same-session', kind: 'state', state, verified: true })
  return { pty, paneOwner }
}

describe('PAR-230 F2 T14/T20 actual Server monitor → mirror → list', () => {
  for (const agent of ['codex', 'antigravity'] as const) for (const state of ['working', 'done'] as const) {
    it(`${agent} confirmed ${state} becomes DROPPED outside the renderer`, async () => {
      const h = await harness(agent, state)
      expect(observed.monitors.length).toBeGreaterThan(0)
      await Promise.all(observed.monitors.map((monitor) => monitor.sweep()))
      const reply = await runtime!.handler({ verb: 'list', nodeId: 'source', args: {}, verified: true })
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      expect.soft(h.paneOwner).toHaveBeenCalledWith('worker', expect.objectContaining({ resolveUnmounted: true }))
      expect.soft(JSON.stringify(_snapshot())).toContain('dropped')
      expect.soft(reply.message).toContain('DROPPED')
      const viewer = createAgentStatusSession(undefined)
      applyAgentStatusSnapshot(viewer.store, buildAgentStatusSnapshot(Object.entries(_snapshot())), new Set())
      const statuses = viewer.store.getState().byId
      expect.soft(cardBadge('terminal', statuses.worker)).toBe('dropped')
      const chips = parseStatusChipSig(statusChipSig(statuses, [{ id: 'worker', kind: 'terminal' }]))
      expect.soft(chips.running.has('worker')).toBe(false)
    })
  }
})
