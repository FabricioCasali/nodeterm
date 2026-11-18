import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initServerCanvasControl, type ServerCanvasControl } from '../../src/server/canvas-control'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { _resetForTest, recordAgentEvent } from '../../src/core/agent-status-mirror'
import { resetMessageFlow } from '../../src/core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../../src/core/agents/agent-message-trace'
import { writeNodeTokenFile, resetNodeTokenFilesForTests } from '../../src/core/agents/node-token-files'
import { recordFreshSpawnOwner, resetPaneOwnershipForTests } from '../../src/core/agents/pane-ownership'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import { PANE_PROBE_TIMEOUT_MS } from '../../src/core/agents/pane-probe'
import type { PtyManager } from '../../src/core/pty-manager'
import type { WorkspaceStore } from '../../src/core/workspace-store'
import { DEFAULT_SETTINGS, type Workspace } from '../../src/shared/types'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
let runtime: ServerCanvasControl | undefined
beforeEach(() => {
  initPlatform(fakePlatform())
  _resetForTest(); resetMessageFlow(); resetAgentMessageTraceForTests()
  resetNodeTokenFilesForTests(); resetPaneOwnershipForTests()
})
afterEach(() => {
  runtime?.stop(); runtime = undefined
  _resetForTest(); resetMessageFlow(); resetAgentMessageTraceForTests()
  resetNodeTokenFilesForTests(); resetPaneOwnershipForTests(); resetPlatformForTests()
})

async function fixture() {
  const workspace: Workspace = { version: 2, activeProjectId: 'p1', projects: [{
    id: 'p1', name: 'Project', color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'source', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, title: 'Source', color: '#d97757', group: null, agentId: 'claude' }]
  }] }
  const store = {
    load: async () => workspace,
    save: async (next: Workspace) => { Object.assign(workspace, structuredClone(next)) },
    persistedCanvases: () => [{ id: 'p1', nodes: workspace.projects[0].nodes }],
    capabilityProjectFor: () => ({ agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } })
  } as unknown as WorkspaceStore
  const taps = new Map<string, Set<(chunk: string) => void>>()
  const prompts = new Set<string>()
  let screen = captured.screens.empty
  const checks: boolean[] = []
  const owner: PaneOwner = { tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }
  const receipt = (nodeId: string) => queueMicrotask(() => runtime?.onAgentEvent({
    nodeId, agentId: 'claude', sessionId: 'session-1', kind: 'state', state: 'working', newTurn: true, verified: true, clientRevision: MANAGED_SCRIPT_REVISION
  }))
  const sendEnvelope = vi.fn(async (id: string, body: string, _owner?: PaneOwner, guard?: Guard) => {
    if (guard) {
      checks.push(guard.beforePaste(screen))
      if (!checks.at(-1)) return false
    }
    screen = captured.screens.draft.replace('heb ik getest', body.split('\n').join('\n  '))
    if (guard) {
      checks.push(guard.beforeSubmit(screen))
      if (!checks.at(-1)) return true
    }
    receipt(id)
    return true
  })
  const sendText = vi.fn(async (id: string, text: string, opts?: { enter?: boolean }) => {
    if (text) screen = captured.screens.draft.replace('heb ik getest', text.split('\n').join('\n  '))
    if (opts?.enter) receipt(id)
    return true
  })
  const capability = vi.fn(async () => true)
  const pty = {
    persistentSpawnAvailable: () => true,
    createHeadless: async () => ({ sessionId: 'unused', fresh: true }),
    releaseHeadless: () => {}, destroySession: async () => {},
    onOutput: (key: string, cb: (chunk: string) => void) => {
      let set = taps.get(key)
      if (!set) taps.set(key, set = new Set())
      set.add(cb)
      if (!prompts.has(key)) { prompts.add(key); queueMicrotask(() => { if (set!.has(cb)) cb('$ ') }) }
      return () => { set!.delete(cb) }
    },
    writeHeadless: (key: string, text: string) => { for (const cb of taps.get(key) ?? []) cb(text); return true },
    paneCommand: async () => 'bash', paneOwner: async () => owner,
    captureSession: async () => screen,
    sendText, sendEnvelope, envelopeGuardSupported: capability,
    hasLiveSession: () => true, sessionExists: async () => true,
    paneProbeTimeoutMs: () => PANE_PROBE_TIMEOUT_MS
  } as unknown as PtyManager
  runtime = await initServerCanvasControl({ workspaceStore: store, ptyManager: pty, settings: () => ({ ...DEFAULT_SETTINGS }), boardLog: { append: async () => false } })
  const opened = await runtime.handler({ verb: 'open-agent', nodeId: 'source', args: { agent: 'claude', prompt: 'owned target' }, verified: true })
  expect(opened).toMatchObject({ ok: true })
  const targetId = (opened.result as { id: string }).id
  recordFreshSpawnOwner(targetId, 'p1')
  expect(writeNodeTokenFile(targetId, 'test-token')).toBe(true)
  const event = (over: Partial<NormalizedAgentEvent>): NormalizedAgentEvent => ({ nodeId: targetId, agentId: 'claude', sessionId: 'session-1', kind: 'state', state: 'done', verified: true, clientRevision: MANAGED_SCRIPT_REVISION, ...over })
  screen = captured.screens.empty
  sendText.mockClear(); sendEnvelope.mockClear(); capability.mockClear()
  return { targetId, sendText, sendEnvelope, capability, checks, event,
    send: () => runtime!.handler({ verb: 'send', nodeId: 'source', args: { node: targetId, text: 'hello' }, verified: true }) }
}

describe('PAR-230 R6 / ajuste 54: real Server shell registration', () => {
  it('keeps ordinary done on its current adapter', async () => {
    const f = await fixture()
    recordAgentEvent(f.event({}))
    expect(await f.send()).toMatchObject({ ok: true, message: expect.stringContaining('delivered') })
    expect(f.sendText).toHaveBeenCalledTimes(2)
    expect(f.sendEnvelope).not.toHaveBeenCalled()
  })

  it('routes inferred-Claude recovery to the guarded PTY transport', async () => {
    const f = await fixture()
    recordAgentEvent(f.event({ state: 'working', newTurn: true }))
    recordAgentEvent(f.event({ state: 'done', idle: true }))
    expect(await f.send()).toMatchObject({ ok: true, message: expect.stringContaining('delivered') })
    expect(f.capability).toHaveBeenCalledWith(f.targetId)
    expect(f.sendEnvelope).toHaveBeenCalledTimes(1)
    expect(f.sendEnvelope.mock.calls[0][3]).toEqual({ beforePaste: expect.any(Function), beforeSubmit: expect.any(Function) })
    expect(f.checks).toEqual([true, true])
    expect(f.sendText).not.toHaveBeenCalled()
  })
})
