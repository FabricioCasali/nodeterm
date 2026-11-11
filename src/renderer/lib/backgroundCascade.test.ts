import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, PendingLaunch, Project } from '@shared/types'
import type { StationOutcomeRecord } from '@shared/station-outcome'
import {
  backgroundCascadeTargets,
  backgroundLaunches,
  cascadeDepIds,
  cascadeKey,
  type CascadeContext
} from './backgroundCascade'
import { startHeadless, type HeadlessStartDeps } from './headlessRun'

const FAR = Date.now() + 86_400_000

function node(id: string, pendingLaunch?: Partial<PendingLaunch>, extra: Partial<CanvasNodeState> = {}): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    ...(pendingLaunch ? { pendingLaunch: { after: [], command: `run ${id}`, attempted: false, ...pendingLaunch } } : {}),
    ...extra
  } as CanvasNodeState
}

function project(id: string, nodes: CanvasNodeState[], extra: Partial<Project> = {}): Project {
  return { id, name: id, cwd: `/p/${id}`, viewport: { x: 0, y: 0, zoom: 1 }, nodes, ...extra } as Project
}

/** Project B (not active): station `a` and node `b` armed on it with `--after-success`. */
function successSetup(): Project[] {
  return [
    project('A', [node('x')]),
    project('B', [node('a'), node('b', { after: ['a'], afterSuccess: { deps: ['a'], deadlineAt: FAR } })])
  ]
}

function ctx(over: Partial<CascadeContext> = {}): CascadeContext {
  return {
    status: {},
    setupDone: () => true,
    deliveries: {},
    outcomes: {},
    handovers: {},
    now: Date.now(),
    ...over
  }
}

const report = (outcome: 'succeeded' | 'failed'): Record<string, StationOutcomeRecord> => ({
  a: { nodeId: 'a', outcome, at: 1 }
})

const noSkip = (): boolean => false

describe('backgroundCascadeTargets', () => {
  it('takes only non-active, open, local projects', () => {
    const projects = [
      project('A', [node('b1', { after: ['s'] })]),
      project('closed', [node('b2', { after: ['s'] })], { closed: true }),
      project('ssh', [node('b3', { after: ['s'] })], { ssh: {} as Project['ssh'] }),
      project('relay', [node('b4', { after: ['s'] })], { remote: true }),
      project('gone', [node('b5', { after: ['s'] })], { unavailable: true }),
      project('ok', [node('b6', { after: ['s'] })])
    ]
    expect(backgroundCascadeTargets(projects, 'A').map((t) => t.project.id)).toEqual(['ok'])
  })

  it('takes only nodes that wait on something', () => {
    const projects = [
      project('B', [
        node('cold', { after: [] }), // a cold open: starts on view, by contract
        node('dep', { after: ['s'] }),
        node('success', { after: [], afterSuccess: { deps: ['s'], deadlineAt: FAR } }),
        node('manual', { after: ['s'], manualOnly: true }),
        node('tried', { after: ['s'], attempted: true }),
        node('pr', { after: ['s'], afterPr: {} as PendingLaunch['afterPr'] }),
        node('server', { after: ['s'], executor: 'server' }),
        node('remote', { after: ['s'] }, { sshRemoteTmux: true } as Partial<CanvasNodeState>),
        node('plain')
      ])
    ]
    const [t] = backgroundCascadeTargets(projects, 'A')
    expect(t.armed.map((n) => n.id)).toEqual(['dep', 'success'])
    expect(cascadeDepIds([t]).sort()).toEqual(['s'])
    expect(cascadeKey([t])).toContain('dep:s')
  })
})

describe('backgroundLaunches', () => {
  const targets = (): ReturnType<typeof backgroundCascadeTargets> => backgroundCascadeTargets(successSetup(), 'A')

  it('starts the node once its station reported success and its turn is over', () => {
    const out = backgroundLaunches(targets(), ctx({ status: { a: { state: 'done' } }, outcomes: report('succeeded') }), noSkip)
    expect(out).toHaveLength(1)
    expect(out[0].project.id).toBe('B')
    expect(out[0].nodes.map((n) => n.id)).toEqual(['b'])
    // The STORED node, which is what the headless start takes.
    expect(out[0].nodes[0].pendingLaunch?.command).toBe('run b')
  })

  it('does not start on a reported failure', () => {
    expect(backgroundLaunches(targets(), ctx({ status: { a: { state: 'done' } }, outcomes: report('failed') }), noSkip)).toEqual([])
  })

  it('does not start while the station has not reported', () => {
    expect(backgroundLaunches(targets(), ctx({ status: { a: { state: 'done' } } }), noSkip)).toEqual([])
  })

  it('does not start while the station is still working', () => {
    expect(
      backgroundLaunches(targets(), ctx({ status: { a: { state: 'working' } }, outcomes: report('succeeded') }), noSkip)
    ).toEqual([])
  })

  it('plain --after: done releases, unknown and errored hold', () => {
    const t = backgroundCascadeTargets([project('B', [node('a'), node('b', { after: ['a'] })])], 'A')
    expect(backgroundLaunches(t, ctx({ status: { a: { state: 'done' } } }), noSkip)).toHaveLength(1)
    expect(backgroundLaunches(t, ctx(), noSkip)).toEqual([])
    expect(backgroundLaunches(t, ctx({ status: { a: { state: 'done', lastTurnError: { at: 1 } } } }), noSkip)).toEqual([])
  })

  it('honours the setup gate and the skip set', () => {
    const t = backgroundCascadeTargets(
      [project('B', [node('a'), node('b', { after: ['a'], awaitSetupGroup: 'g' })])],
      'A'
    )
    const done = ctx({ status: { a: { state: 'done' } } })
    expect(backgroundLaunches(t, { ...done, setupDone: () => false }, noSkip)).toEqual([])
    expect(backgroundLaunches(t, done, (id) => id === 'b')).toEqual([])
    expect(backgroundLaunches(t, done, noSkip)).toHaveLength(1)
  })

  it('two evaluations in a row start the node once', async () => {
    let release!: (v: boolean) => void
    const deps: HeadlessStartDeps = {
      launch: vi.fn(async () => ({ outcome: 'delivered' as const, fresh: true })),
      // The claim's write is still in flight when the second evaluation runs.
      savePending: vi
        .fn<HeadlessStartDeps['savePending']>()
        .mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)))
        .mockResolvedValue(true),
      markStarting: vi.fn(),
      markFailed: vi.fn(),
      clearDelivery: vi.fn(),
      inFlight: new Set()
    }
    const c = ctx({ status: { a: { state: 'done' } }, outcomes: report('succeeded') })
    const evaluate = (): Promise<unknown>[] =>
      backgroundLaunches(targets(), c, (id) => deps.inFlight.has(id)).flatMap((b) =>
        b.nodes.map((n) => startHeadless(deps, { project: b.project, node: n }))
      )
    const first = evaluate()
    const second = evaluate()
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    release(true)
    await Promise.all(first)
    expect(deps.launch).toHaveBeenCalledTimes(1)
  })
})
