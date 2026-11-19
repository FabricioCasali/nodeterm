import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as workspace from '../../src/renderer/state/workspace'
import * as routing from '../../src/renderer/lib/controlRouting'
import * as cold from '../../src/renderer/lib/coldOpen'
import * as projectOpen from '../../src/renderer/lib/projectOpen'
import * as pending from '../../src/renderer/lib/pendingLaunch'
import * as batches from '../../src/renderer/lib/controlOpenBatch'
import * as confirm from '../../src/renderer/state/controlConfirmGate'
import * as permission from '../../src/renderer/state/permissionMode'
import * as availability from '../../src/renderer/state/agentAvailability'
import * as colors from '../../src/shared/node-colors'
import * as verbs from '../../src/shared/control-verbs'
import * as geometry from '../../src/shared/geometry-verbs'
import * as launch from '../../src/shared/agents/launch'
import * as config from '../../src/shared/agents/config'
import * as outcome from '../../src/shared/station-outcome'
import * as issue from '../../src/renderer/lib/issueFlag'
import * as spill from '../../src/renderer/lib/promptSpill'
import * as prWait from '../../src/renderer/lib/prWait'
import * as placement from '../../src/renderer/lib/placement'
import * as opener from '../../src/renderer/lib/stationOpener'
import * as noteLink from '../../src/renderer/lib/noteLink'
import * as storedGeometry from '../../src/renderer/lib/storedGeometry'
import * as edgeModel from '../../src/renderer/lib/edgeModel'
import * as oneLine from '../../src/shared/one-line'
import * as headlessRun from '../../src/renderer/lib/headlessRun'
import { useProjects } from '../../src/renderer/state/projects'
import { useSettings } from '../../src/renderer/state/settings'
import { useAgentStatus } from '../../src/renderer/state/agentStatus'
import { useLaunchDelivery } from '../../src/renderer/state/launchDelivery'
import { useStationOutcomes } from '../../src/renderer/state/stationOutcomes'
import { useStationHandovers } from '../../src/renderer/state/stationHandovers'
import { useBoardLog } from '../../src/renderer/state/boardLog'
import { useProjectSetup } from '../../src/renderer/state/projectSetup'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { testTmpDir } from '../../src/core/test-tmp'

// The callback is evaluated unchanged; React geometry and shell effects are supplied separately.
function mountCallback(scope: Record<string, unknown>) {
  const source = readFileSync(new URL('../../src/renderer/canvas/Canvas.tsx', import.meta.url), 'utf8')
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  let callback: { start?: number | null; end?: number | null } | undefined
  const helpers: string[] = []
  function visit(node: unknown) {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, any>
    if (n.type === 'CallExpression' && n.callee?.object?.name === 'api' && n.callee?.property?.name === 'onAgentControl') callback = n.arguments[0]
    if (n.type === 'VariableDeclarator' && ['setupHoldGroup', 'agentIdOf', 'parentInto', 'ropeEdge', 'linkEndpointOf'].includes(n.id?.name)) {
      const fn = n.init?.type === 'CallExpression' && n.init.callee?.name === 'useCallback' ? n.init.arguments[0] : n.init
      if (!fn || !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn.type)) throw new Error(`Cannot mount Canvas helper ${n.id.name}`)
      helpers.push(`const ${n.id.name} = ${source.slice(fn.start, fn.end)};`)
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc') continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(tree)
  if (callback?.start == null || callback.end == null) throw new Error('Canvas api.onAgentControl callback not found')
  const code = transformSync(`${helpers.join('\n')} const callback = ${source.slice(callback.start, callback.end)}; callback`, { loader: 'tsx', format: 'esm', target: 'es2022' }).code
  const names = new Proxy(scope, {
    has: (_target, key) => !['callback', 'setupHoldGroup', 'agentIdOf', 'parentInto', 'ropeEdge', 'linkEndpointOf'].includes(String(key)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined
      if (key in target) return target[key as string]
      if (key in globalThis) return (globalThis as Record<string, unknown>)[key as string]
      throw new ReferenceError(`Canvas fixture missing binding: ${String(key)}`)
    }
  })
  return new Function('scope', `with (scope) { ${code}; return callback }`)(names) as (request: unknown) => Promise<void>
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetPlatformForTests() })

function harness(route: 'active' | 'cold' | 'project') {
  const source = workspace.createAgentNode('claude', 0, 'C:/repo')
  source.id = 'source'
  const sourceState = workspace.flowToNodeStates([source])[0]
  useProjects.getState().hydrate({ version: 2, activeProjectId: 'active', projects: [
    { id: 'active', name: 'Active', color: '#fff', cwd: 'C:/repo', viewport: { x: 0, y: 0, zoom: 1 }, nodes: route === 'cold' ? [] : [sourceState] },
    { id: 'cold', name: 'Cold', color: '#fff', cwd: 'C:/cold', viewport: { x: 0, y: 0, zoom: 1 }, nodes: route === 'cold' ? [sourceState] : [] }
  ] })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  const nodesRef = { current: route === 'cold' ? [] : [source] }
  const replies: unknown[][] = []
  const api = {
    sendAgentControlResult: vi.fn((...args: unknown[]) => { replies.push(args) }),
    workspace: { save: vi.fn(async () => {}), saveProject: vi.fn(async () => true) },
    fs: { saveUpload: vi.fn(async () => 'C:/fixture/brief.md'), exists: vi.fn(async () => true) }
  }
  vi.stubGlobal('window', { nodeTerminal: api })
  const scope = {
    ...workspace, ...routing, ...cold, ...projectOpen, ...pending, ...batches, ...confirm, ...permission, ...availability,
    ...colors, ...verbs, ...geometry, ...launch, ...config, ...outcome, ...issue, ...spill, ...prWait, ...placement, ...opener,
    ...noteLink, ...edgeModel, ...oneLine, ...storedGeometry, ...headlessRun,
    useProjects, useSettings, useAgentStatus, useLaunchDelivery, useStationOutcomes, useStationHandovers, useBoardLog, useProjectSetup,
    api, nodesRef, nodesProjectIdRef: { current: 'active' },
    controlPlaceClaims: { current: [] }, snapGridNow: () => undefined,
    setNodes: (update: any) => { nodesRef.current = typeof update === 'function' ? update(nodesRef.current) : update },
    markDirty: vi.fn(), persist: vi.fn(async () => {}), writeDisk: vi.fn(async () => {}),
    dirtyRef: { current: false }, conflictRef: { current: false }, confirmBusy: { current: false },
    setConfirm: vi.fn(), setControlWaiveChoice: vi.fn(), setNotice: vi.fn(),
    controlStatus: () => ({}), startNodesHeadlessRef: { current: vi.fn(async (_project: unknown, ids: string[]) => ({
      outcomes: ids.map((id) => ({ id, started: true })), unhidden: false
    })) },
    runQueuedNodeRef: { current: vi.fn(async () => ({ started: true })) },
    controlEdgesRef: { current: [] }, linkEdgesRef: { current: [] },
    setControlEdges: vi.fn(), setLinkEdges: vi.fn()
  }
  return { callback: mountCallback(scope), nodesRef, replies, scope }
}

describe('PAR-230 F2 actual Desktop Canvas control callback', () => {
  for (const route of ['active', 'cold', 'project'] as const) {
    it.each(['open-agent', 'open-claude', 'open-terminal']) (`T12 ${route} %s preserves explicit title/count`, async (verb) => {
      const h = harness(route)
      await h.callback({ requestId: 'request', sourceNodeId: 'source', verb, args: {
        ...(verb === 'open-agent' ? { agent: 'codex' } : {}), title: 'ARQ ORQ-78', count: '2',
        ...(verb === 'open-terminal' ? { cmd: 'echo literal' } : { prompt: 'literal' }),
        ...(route === 'project' ? { project: 'cold' } : {})
      } })
      const reply = JSON.stringify(h.replies)
      expect(reply, reply).not.toContain('Canvas fixture missing binding')
      expect(h.replies, reply).toHaveLength(1)
      const target = route === 'active' ? workspace.flowToNodeStates(h.nodesRef.current) : useProjects.getState().projects.find((p) => p.id === 'cold')!.nodes
      const made = target.filter((n) => n.id !== 'source')
      expect(made, reply).toHaveLength(2)
      expect.soft(new Set(made.map((n) => n.title)).size).toBe(2)
      for (const n of made) {
        expect.soft(n.title).toContain('ARQ ORQ-78')
        expect.soft(n.titleAuto).toBe(false)
      }
      const root = testTmpDir('par230-f2-canvas-store-')
      mkdirSync(path.join(root, 'data'))
      initPlatform(fakePlatform({ userDataDir: path.join(root, 'data') }))
      await new WorkspaceStore().save({ version: 2, activeProjectId: 'saved', projects: [{ id: 'saved', name: 'Saved',
        color: '#fff', nodes: made, viewport: { x: 0, y: 0, zoom: 1 } }] })
      const restored = (await new WorkspaceStore().load({ sideline: false })).projects[0].nodes
      expect.soft(restored.map((n) => [n.title, n.titleAuto])).toEqual(made.map((n) => [n.title, false]))
    })

    it.each(['open-agent', 'open-claude', 'open-terminal'])(`T12 ${route} %s keeps its default auto-title without --title`, async (verb) => {
      const h = harness(route)
      await h.callback({ requestId: 'defaults', sourceNodeId: 'source', verb, args: {
        ...(verb === 'open-agent' ? { agent: 'codex' } : {}),
        ...(verb === 'open-terminal' ? { cmd: 'echo literal' } : { prompt: 'literal' }),
        ...(route === 'project' ? { project: 'cold' } : {})
      } })
      const reply = h.replies[0]?.[0] as { ok: boolean; error?: string }
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
      const target = route === 'active' ? workspace.flowToNodeStates(h.nodesRef.current) : useProjects.getState().projects.find((p) => p.id === 'cold')!.nodes
      const made = target.filter((n) => n.id !== 'source')
      expect(made).toHaveLength(1)
      expect(made[0].title).toBeTruthy()
      expect(made[0].titleAuto).toBe(verb === 'open-terminal' ? undefined : true)
    })

    it.each([false, true])(`T09/T20 ${route} model and promptFile retain semantic intent; run-now=%s`, async (runNow) => {
      const h = harness(route)
      await h.callback({ requestId: 'semantic', sourceNodeId: 'source', verb: 'open-agent', args: {
        agent: 'claude', model: 'opus', 'prompt-file': 'C:/fixture/brief.md',
        ...(runNow ? { 'run-now': '' } : {}), ...(route === 'project' ? { project: 'cold' } : {})
      } })
      const reply = h.replies[0]?.[0] as { ok: boolean; error?: string }
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
      const target = route === 'active' ? h.nodesRef.current.map((n) => ({ id: n.id, ...n.data }))
        : useProjects.getState().projects.find((p) => p.id === 'cold')!.nodes
      const made = target.filter((n) => n.id !== 'source')
      expect(made).toHaveLength(1)
      expect.soft(made[0]).toHaveProperty('launchIntent', expect.objectContaining({
        intent: expect.objectContaining({ kind: 'agent', action: 'start', agentId: 'claude', model: 'opus' }),
        promptFile: 'C:/fixture/brief.md'
      }))
      if (runNow && route !== 'active') expect.soft(h.scope.startNodesHeadlessRef.current).toHaveBeenCalled()
    })
  }
})
