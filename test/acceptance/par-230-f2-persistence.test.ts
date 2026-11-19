import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { testTmpDir } from '../../src/core/test-tmp'
import { createAgentNode, flowToNodeStates, nodeStatesToFlow } from '../../src/renderer/state/workspace'
import { sanitizeInboundNode, sanitizeInboundMutation } from '../../src/shared/node-exec'
import { receivedCanvasMutation } from '../../src/renderer/session/relay-ssh'
import { applyCanvasMutation } from '../../src/shared/canvas-mutations'
import { initCanvasSync, publishCanvasMutation, setReflectedListener } from '../../src/core/canvas-sync'
import { IPC } from '../../src/shared/ipc'
import type { CanvasMutation, CanvasNodeState } from '../../src/shared/types'

let root: string
beforeEach(() => {
  root = testTmpDir('par230-f2-persist-')
  mkdirSync(path.join(root, 'data'))
  initPlatform(fakePlatform({ userDataDir: path.join(root, 'data') }))
})
afterEach(() => { setReflectedListener(null); resetPlatformForTests() })

function armed() {
  const n = createAgentNode('claude', 0, root, undefined, 'literal')
  n.data.pendingLaunch = { command: n.data.initialCommand!, after: [], attempted: false }
  return { flow: n, state: { ...flowToNodeStates([n])[0], launchIntent: n.data.launchIntent } }
}

describe('PAR-230 F2 T11 machine-local file authority', () => {
  it.each([false, true])('local semantic intent round-trips through a NEW store and renderer; folder=%s', async (folder) => {
    const { flow } = armed()
    const project = { id: 'local', name: 'Local', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 },
      ...(folder ? { cwd: root } : {}), nodes: flowToNodeStates([flow]) }
    await new WorkspaceStore().save({ version: 2, activeProjectId: 'local', projects: [project] })
    const loaded = await new WorkspaceStore().load({ sideline: false })
    const restored = nodeStatesToFlow(loaded.projects[0].nodes)[0]
    expect.soft(restored.data.pendingLaunch).toEqual(flow.data.pendingLaunch)
    expect.soft(restored.data.launchIntent).toEqual(flow.data.launchIntent)
    if (folder) {
      const shared = readFileSync(path.join(root, '.nodeterm/project.json'), 'utf8')
      expect.soft(shared).not.toContain('pendingLaunch')
      expect.soft(shared).not.toContain('launchIntent')
    }
  })

  it('imports a real foreign project.json without adopting its pending launch or semantic authority', async () => {
    const { state } = armed()
    const cwd = path.join(root, 'foreign')
    mkdirSync(path.join(cwd, '.nodeterm'), { recursive: true })
    writeFileSync(path.join(cwd, '.nodeterm/project.json'), JSON.stringify({ version: 1, rev: 1,
      name: 'Foreign', color: '#fff', nodes: [state] }))
    const store = new WorkspaceStore()
    const adopted = await store.adoptFolder(cwd, { home: root })
    const project = (await new WorkspaceStore().load({ sideline: false })).projects.find((p) => p.id === adopted.projectId)!
    const restored = nodeStatesToFlow(project.nodes)[0]
    expect.soft(restored.data.pendingLaunch).toBeUndefined()
    expect.soft(restored.data.launchIntent).toBeUndefined()
    await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
    expect.soft(readFileSync(path.join(cwd, '.nodeterm/project.json'), 'utf8')).not.toContain('launchIntent')
  })

  it.each(['node', 'mutation', 'relay'] as const)('foreign %s input has no executable authority at its real consumer', (source) => {
    const { state } = armed()
    let result: CanvasNodeState
    if (source === 'node') result = sanitizeInboundNode(state)
    else {
      const mutation: CanvasMutation = { op: 'upsert', node: state, origin: 'core' }
      const received = source === 'relay' ? receivedCanvasMutation(mutation, true) : sanitizeInboundMutation(mutation)
      result = applyCanvasMutation([], received)[0]
    }
    expect.soft(result.pendingLaunch).toBeUndefined()
    expect.soft(result).not.toHaveProperty('launchIntent')
    expect.soft(nodeStatesToFlow([result])[0].data.launchIntent).toBeUndefined()
  })

  it('core publication carries local intent only to owners and strips it for relay peers', () => {
    const sent: Array<{ id: number; mutation: CanvasMutation }> = []
    const fake = fakePlatform()
    fake.clientIds = () => [1, 2, 9]
    fake.isOwnerClient = (id) => id === 1 || id === 2
    fake.sendTo = (id, channel, _project, mutation) => {
      if (channel === IPC.canvasMut) sent.push({ id, mutation: mutation as CanvasMutation })
    }
    initPlatform(fake)
    initCanvasSync()
    const { state } = armed()
    publishCanvasMutation('local', { op: 'upsert', node: state })
    for (const id of [1, 2]) {
      const mutation = sent.find((s) => s.id === id)!.mutation as Extract<CanvasMutation, { op: 'upsert' }>
      expect.soft(mutation.origin).toBe('core')
      expect.soft(mutation.node).toHaveProperty('launchIntent', state.launchIntent)
    }
    const relay = sent.find((s) => s.id === 9)!.mutation as Extract<CanvasMutation, { op: 'upsert' }>
    expect.soft(relay.origin).toBeUndefined()
    expect.soft(relay.node.pendingLaunch).toBeUndefined()
    expect.soft(relay.node).not.toHaveProperty('launchIntent')
  })
})
