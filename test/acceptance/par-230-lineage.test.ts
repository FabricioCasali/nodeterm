import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessNodeFactory, createHeadlessNodeOwnership, type HeadlessPty } from '../../src/server/headless-node-factory'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Workspace } from '../../src/shared/types'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { stationRecipientFromOwner } from '../../src/shared/station-notice'

let factory: HeadlessNodeFactory | undefined
afterEach(() => { factory?.stop(); factory = undefined; resetPlatformForTests() })

describe('PAR-230 T08/T20: server lineage through a real close', () => {
  it('can still notify the live ancestor after the immediate parent closes', async () => {
    initPlatform(fakePlatform())
    const node = (id: string, openedBy?: string): CanvasNodeState => ({
      id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 640, height: 440 },
      title: id, color: '#d97757', group: null, tags: [], agentId: 'claude', openedBy
    })
    let workspace: Workspace = {
      version: 2, activeProjectId: 'project', projects: [{
        id: 'project', name: 'Test', color: '#d97757', viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [node('ancestor'), node('parent', 'ancestor'), node('worker', 'parent')],
        ropes: [{ id: 'ctrl-ancestor-parent', source: 'ancestor', target: 'parent' }, { id: 'ctrl-parent-worker', source: 'parent', target: 'worker' }],
        bridges: []
      }]
    }
    const ownership = createHeadlessNodeOwnership()
    ownership.record('parent', { sourceNodeId: 'ancestor', projectId: 'project' })
    ownership.record('worker', { sourceNodeId: 'parent', projectId: 'project' })
    const destroySession = vi.fn(async () => {})
    const pty: HeadlessPty = {
      persistentSpawnAvailable: () => true,
      createHeadless: vi.fn(async () => ({ sessionId: 'unused', fresh: true })),
      writeHeadless: vi.fn(() => true), onOutput: () => () => {}, releaseHeadless: () => {},
      paneCommand: async () => 'bash', sessionExists: async () => true,
      sendText: vi.fn(async () => true), destroySession
    }
    factory = new HeadlessNodeFactory({
      workspaceStore: { load: async () => structuredClone(workspace), save: async (next) => { workspace = structuredClone(next) } },
      ptyManager: pty, settings: () => ({ ...DEFAULT_SETTINGS }), ownership,
      cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
      codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
      codexSharedIdentity: async () => false, stateOf: () => undefined
    })
    const canvases = () => workspace.projects.map((p) => ({ id: p.id, nodes: p.nodes, ropes: p.ropes }))
    expect(stationRecipientFromOwner(canvases(), 'worker', factory.openerOf('worker'))?.recipientNodeId).toBe('parent')
    expect(await factory.close('ancestor', { node: 'parent' }, true)).toMatchObject({ ok: true })
    expect(workspace.projects[0].nodes.map((n) => n.id)).toEqual(['ancestor', 'worker'])
    expect(destroySession).toHaveBeenCalledTimes(1)
    expect(pty.createHeadless).not.toHaveBeenCalled()
    expect(pty.sendText).not.toHaveBeenCalled()
    expect(pty.writeHeadless).not.toHaveBeenCalled()
    expect(stationRecipientFromOwner(canvases(), 'worker', factory.openerOf('worker'))?.recipientNodeId).toBe('ancestor')
  })
})
