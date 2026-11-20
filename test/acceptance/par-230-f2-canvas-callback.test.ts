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
import * as launchArgs from '../../src/shared/agents/launch-args'
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
import { backgroundCascadeTargets } from '../../src/renderer/lib/backgroundCascade'
import { useProjects } from '../../src/renderer/state/projects'
import { useSettings } from '../../src/renderer/state/settings'
import { useAgentStatus } from '../../src/renderer/state/agentStatus'
import { useLaunchDelivery } from '../../src/renderer/state/launchDelivery'
import { useStationOutcomes } from '../../src/renderer/state/stationOutcomes'
import { useStationHandovers } from '../../src/renderer/state/stationHandovers'
import { useBoardLog } from '../../src/renderer/state/boardLog'
import { useProjectSetup } from '../../src/renderer/state/projectSetup'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Project } from '../../src/shared/types'
import { desktopHeadlessRequest, launchHeadless } from '../../src/core/headless-launch'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { testTmpDir } from '../../src/core/test-tmp'

// The callback is evaluated unchanged; React geometry and shell effects are supplied separately.
function mountCallback(scope: Record<string, unknown>) {
  const source = readFileSync(new URL('../../src/renderer/canvas/Canvas.tsx', import.meta.url), 'utf8')
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  let callback: { start?: number | null; end?: number | null } | undefined
  let canvasLaunches: typeof callback
  let headlessStarter: typeof callback
  const helpers: string[] = []
  function visit(node: unknown) {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, any>
    if (n.type === 'CallExpression' && n.callee?.object?.name === 'api' && n.callee?.property?.name === 'onAgentControl') callback = n.arguments[0]
    if (n.type === 'CallExpression' && n.callee?.name === 'useEffect') {
      const effect = n.arguments[0]
      if (effect?.body?.type === 'BlockStatement' && effect.body.body.some((statement: any) => statement.declarations?.[0]?.id?.name === 'briefPresent')) {
        canvasLaunches = effect
      }
    }
    if (n.type === 'AssignmentExpression' && n.left?.object?.name === 'startNodesHeadlessRef' && n.left?.property?.name === 'current') {
      headlessStarter = n.right
    }
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
  const functions = { callback, canvasLaunches, headlessStarter }
  const code = transformSync(`${helpers.join('\n')} return {${Object.entries(functions).map(([name, fn]) => {
    if (fn?.start == null || fn.end == null) throw new Error(`Cannot mount Canvas function ${name}`)
    return `${name}: ${source.slice(fn.start, fn.end)}`
  }).join(',')}}`, { loader: 'tsx', target: 'es2022' }).code
  const names = new Proxy(scope, {
    has: (_target, key) => !['setupHoldGroup', 'agentIdOf', 'parentInto', 'ropeEdge', 'linkEndpointOf'].includes(String(key)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined
      if (key in target) return target[key as string]
      if (key in globalThis) return (globalThis as Record<string, unknown>)[key as string]
      throw new ReferenceError(`Canvas fixture missing binding: ${String(key)}`)
    }
  })
  return new Function('scope', `with (scope) { ${code} }`)(names) as {
    callback: (request: unknown) => Promise<void>
    canvasLaunches: () => void
    headlessStarter: (project: Project, nodes: CanvasNodeState[]) => Promise<headlessRun.HeadlessStartBatch>
  }
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
  type NodesUpdate = (nodes: typeof nodesRef.current) => typeof nodesRef.current
  const renderQueue: NodesUpdate[] = []
  const renderNodes = () => {
    for (const update of renderQueue.splice(0)) nodesRef.current = update(nodesRef.current)
  }
  const replies: unknown[][] = []
  const api = {
    sendAgentControlResult: vi.fn((...args: unknown[]) => { replies.push(args) }),
    workspace: { save: vi.fn(async () => {}), saveProject: vi.fn(async () => true) },
    fs: { saveUpload: vi.fn(async () => 'C:/fixture/brief.md'), exists: vi.fn(async () => true) }
  }
  vi.stubGlobal('window', { nodeTerminal: api })
  const scope = {
    ...workspace, ...routing, ...cold, ...projectOpen, ...pending, ...batches, ...confirm, ...permission, ...availability,
    ...colors, ...verbs, ...geometry, ...launch, ...launchArgs, ...config, ...outcome, ...issue, ...spill, ...prWait, ...placement, ...opener,
    ...noteLink, ...edgeModel, ...oneLine, ...storedGeometry, ...headlessRun,
    useProjects, useSettings, useAgentStatus, useLaunchDelivery, useStationOutcomes, useStationHandovers, useBoardLog, useProjectSetup,
    api, nodesRef, nodesProjectIdRef: { current: 'active' },
    controlPlaceClaims: { current: [] }, snapGridNow: () => undefined,
    isBrowserRuntime: () => false, flushSync: <T,>(update: () => T) => update(),
    launchInFlight: { current: new Set<string>() }, setupDoneForGroup: () => true,
    setNodes: (update: any) => { nodesRef.current = typeof update === 'function' ? update(nodesRef.current) : update },
    markDirty: vi.fn(), persist: vi.fn(async () => {}), writeDisk: vi.fn(async () => {}),
    dirtyRef: { current: false }, conflictRef: { current: false }, confirmBusy: { current: false },
    setConfirm: vi.fn(), setControlWaiveChoice: vi.fn(), setNotice: vi.fn(),
    controlStatus: () => ({}), startNodesHeadlessRef: { current: vi.fn(async (_project: Project, nodes: CanvasNodeState[]): Promise<headlessRun.HeadlessStartBatch> => ({
      outcomes: nodes.map(({ id }) => ({ id, started: true })), unhidden: false
    })) },
    runQueuedNodeRef: { current: vi.fn(async () => ({ started: true })) },
    controlEdgesRef: { current: [] }, linkEdgesRef: { current: [] },
    setControlEdges: vi.fn(), setLinkEdges: vi.fn()
  }
  return { ...mountCallback(scope), nodesRef, replies, scope, api, renderQueue, renderNodes }
}

function activeLaunchHarness(canvasReady: boolean) {
  const harnessState = harness('active')
  const { scope, api, canvasLaunches, nodesRef, renderQueue, renderNodes } = harnessState
  let notifyOpening!: () => void
  const opening = new Promise<void>((resolve) => { notifyOpening = resolve })
  const typed = vi.fn(async () => 'submitted')
  const executeLaunch = vi.fn(async () => {
    executeIn.push(useProjects.getState().activeProjectId)
    return { ok: true as const }
  })
  const executeIn: string[] = []
  const start = vi.fn<headlessRun.HeadlessStartDeps['launch']>((request) =>
    launchHeadless({
      persistentSpawnAvailable: () => true,
      createHeadless: async () => ({ sessionId: 'probe', fresh: false, persistent: true, sessionHost: true }),
      paneCommand: async () => 'pwsh',
      writeHeadless: () => false,
      onOutput: () => () => {},
      releaseHeadless: () => {},
      executeLaunch
    }, desktopHeadlessRequest(request))
  )
  Object.assign(api, { pty: { launchHeadless: start } })
  Object.assign(scope, {
    renderedProjectId: 'active',
    activeSession: { api },
    setupDoneForGroup: () => true,
    pullBoardFor: () => undefined,
    useGitHubIssues: { getState: () => ({}) },
    useProjectLimit: { getState: () => ({}) },
    isSessionReady: () => canvasReady,
    isBrowserRuntime: () => false,
    clearStallTimer: () => {},
    launchStallTimers: { current: new Map() },
    launchAttempts: { current: new Map() },
    launchInFlight: { current: new Set() },
    headlessInFlightRef: { current: new Set() },
    launchCommand: typed,
    writeDisk: async () => true,
    setNodes: (update: Parameters<typeof renderQueue.push>[0]) => {
      renderQueue.push(update)
      notifyOpening()
    },
    flushSync: <T,>(update: () => T) => {
      const result = update()
      renderNodes()
      if (canvasReady) canvasLaunches()
      return result
    }
  })
  Object.defineProperty(scope, 'nodes', { get: () => nodesRef.current })
  scope.startNodesHeadlessRef.current.mockImplementation(harnessState.headlessStarter)
  const show = (projectId: string) => {
    renderNodes()
    const store = useProjects.getState()
    const outgoing = store.getProject(store.activeProjectId)!
    store.commitCanvas(outgoing.id, workspace.flowToNodeStates(nodesRef.current), outgoing.viewport)
    store.setActive(projectId)
    nodesRef.current = workspace.nodeStatesToFlow(store.getProject(projectId)!.nodes)
    Object.assign(scope, { renderedProjectId: projectId })
  }
  const open = (runNow: boolean) => harnessState.callback({
    requestId: 'par-250', sourceNodeId: 'source', verb: 'open-agent',
    args: { agent: 'claude', 'prompt-file': 'C:/fixture/brief.md', ...(runNow ? { 'run-now': '' } : {}) }
  })
  return { opening, open, show, typed, executeLaunch, executeIn, start, canvasLaunches, renderNodes, replies: harnessState.replies }
}

describe('PAR-230 F2 actual Desktop Canvas control callback', () => {
  it('PAR-250 starts after leaving the opening project before its canvas delivers', async () => {
    const h = activeLaunchHarness(false)
    const reply = h.open(true)
    await h.opening
    h.show('cold')
    await reply
    const { projects, activeProjectId, getProject } = useProjects.getState()
    expect(activeProjectId).toBe('cold')
    expect(backgroundCascadeTargets(projects, activeProjectId)).toEqual([])
    expect(h.typed).not.toHaveBeenCalled()
    expect(h.executeLaunch).toHaveBeenCalledOnce()
    expect(h.executeIn).toEqual(['cold'])
    expect(getProject('active')?.nodes.find(({ id }) => id !== 'source')).toMatchObject({ pendingLaunch: undefined })
    expect(h.replies[0]?.[0]).toMatchObject({ ok: true, result: { started: true, queued: false } })
  })

  it.each(['open-terminal', 'open-claude'])('PAR-250 %s --run-now hands the held node to the starter', async (verb) => {
    const h = harness('active')
    await h.callback({ requestId: 'par-250', sourceNodeId: 'source', verb, args: {
      'run-now': '', ...(verb === 'open-terminal' ? { cmd: 'echo fixture' } : { prompt: 'fixture' })
    } })
    expect(h.scope.startNodesHeadlessRef.current).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'active' }),
      [expect.objectContaining({ pendingLaunch: expect.objectContaining({ after: [], command: expect.any(String) }) })]
    )
    expect(h.replies[0]?.[0]).toMatchObject({ ok: true, result: { started: true, queued: false } })
  })

  it.each([false, true])('PAR-250 delivers once on the same project (run-now=%s)', async (runNow) => {
    const h = activeLaunchHarness(true)
    await h.open(runNow)
    expect(h.start).not.toHaveBeenCalled()
    if (!runNow) expect(h.typed).not.toHaveBeenCalled()
    h.renderNodes()
    h.canvasLaunches()
    await vi.waitFor(() => expect(h.typed).toHaveBeenCalledOnce())
    h.renderNodes()
    h.canvasLaunches()
    expect(h.start).not.toHaveBeenCalled()
    expect(h.typed).toHaveBeenCalledOnce()
  })

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

    it.each([false, true])(`PAR-255 ${route} open-agent --launch-args reaches the line, the intent and the node; run-now=%s`, async (runNow) => {
      const h = harness(route)
      const raw = '--strict-mcp-config --mcp-config C:/x/mcp.json'
      await h.callback({ requestId: 'launch-args', sourceNodeId: 'source', verb: 'open-agent', args: {
        agent: 'claude', prompt: 'go', 'launch-args': raw,
        ...(runNow ? { 'run-now': '' } : {}), ...(route === 'project' ? { project: 'cold' } : {})
      } })
      const reply = h.replies[0]?.[0] as { ok: boolean; error?: string }
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
      const target = route === 'active' ? h.nodesRef.current.map((n) => ({ id: n.id, ...n.data }))
        : useProjects.getState().projects.find((p) => p.id === 'cold')!.nodes
      const made = target.filter((n) => n.id !== 'source') as Array<Record<string, any>>
      expect(made).toHaveLength(1)
      expect(made[0].agentLaunchArgs).toBe(raw)
      expect(made[0].launchIntent?.intent).toMatchObject({
        kind: 'agent', action: 'start', agentId: 'claude', prompt: 'go',
        launchArgs: ['--strict-mcp-config', '--mcp-config', 'C:/x/mcp.json']
      })
      // The typed line the intent is bound to carries them too, in the managed-flags slot.
      expect(made[0].launchIntent?.command).toContain("'go'")
      expect(made[0].launchIntent?.command).toMatch(/'go'.* '--strict-mcp-config' '--mcp-config' 'C:\/x\/mcp\.json'$/)
    })

    it(`PAR-255 ${route} open-agent refuses a malformed --launch-args before opening anything`, async () => {
      const h = harness(route)
      await h.callback({ requestId: 'launch-args-bad', sourceNodeId: 'source', verb: 'open-agent', args: {
        agent: 'claude', 'launch-args': "--mcp-config 'C:/open", ...(route === 'project' ? { project: 'cold' } : {})
      } })
      const reply = h.replies[0]?.[0] as { ok: boolean; error?: string }
      expect(reply).toMatchObject({ ok: false, error: 'open-agent: --launch-args has an unterminated quote' })
      const target = route === 'active' ? h.nodesRef.current : useProjects.getState().projects.find((p) => p.id === 'cold')!.nodes
      expect(target.filter((n) => n.id !== 'source')).toHaveLength(0)
    })
  }
})
