import { describe, expect, it, vi } from 'vitest'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import type { MirrorEntry } from './agent-status-mirror'
import { createStationLiveness, LAUNCH_WATCH_MS, type DeliveredLaunch } from './agent-liveness'

const SHELL: PaneOwner = { panePid: 700, tty: 'win32-console:700', paneId: 'win32:g1:b1', command: 'pwsh', argv: ['pwsh'], pids: [700] }
const CODEX: PaneOwner = { ...SHELL, command: 'codex', argv: ['codex'], pids: [800] }
// A shell in the foreground that is NOT the pane's root: a tool the CLI ran.
const CHILD_SHELL: PaneOwner = { ...SHELL, pids: [900] }

function harness() {
  let now = 1_000_000
  const launches: DeliveredLaunch[] = []
  const mirror = new Map<string, MirrorEntry>()
  let owner: PaneOwner | null = SHELL
  const receipts = new Set<string>()
  const exits = new Map<string, number>()
  const lifecycle = vi.fn()
  const paneOwner = vi.fn(async () => owner)
  const liveness = createStationLiveness({
    now: () => now,
    launches: () => launches,
    mirrorEntries: () => [...mirror],
    paneOwner,
    customAgents: () => [],
    deliberateExitAt: (id) => exits.get(id),
    setLifecycle: lifecycle,
    receiptExists: (file) => receipts.has(file)
  })
  return {
    liveness, launches, mirror, receipts, exits, lifecycle, paneOwner,
    setOwner: (next: PaneOwner | null) => { owner = next },
    advance: (ms: number) => { now += ms },
    now: () => now
  }
}

const launch = (over: Partial<DeliveredLaunch> = {}): DeliveredLaunch => ({
  nodeId: 'worker', launchId: 'launch-1', agentId: 'codex', at: 1_000_000, receipt: 'C:/r/launch-1.done', ...over
})
const verified = (over: Partial<MirrorEntry> = {}): MirrorEntry => ({
  state: 'working', stateVerified: true, agentId: 'codex', sessionId: 's1', updatedAt: 1_000_000, ...over
})

describe('station liveness producer', () => {
  it('a delivered launch is an unconfirmed attempt; its root shell alone is `shell`, finished only with its receipt', async () => {
    const h = harness()
    h.launches.push(launch())
    const [attempt] = h.liveness.attempts()
    expect(attempt).toMatchObject({ nodeId: 'worker', attemptId: 'launch-1', agentId: 'codex', confirmed: false, suppressed: false })
    expect(await h.liveness.probe(attempt)).toEqual({ sessionKey: attempt.sessionKey, kind: 'shell' })
    h.receipts.add('C:/r/launch-1.done')
    expect(await h.liveness.probe(attempt)).toEqual({ sessionKey: attempt.sessionKey, kind: 'shell', commandFinished: true })
    expect(h.paneOwner).toHaveBeenCalledWith('worker', { resolveUnmounted: true })
  })

  it('the CLI in the tree is `agent`; a child shell, an unreadable pane and another generation prove nothing', async () => {
    const h = harness()
    h.launches.push(launch())
    const [attempt] = h.liveness.attempts()
    h.setOwner(CODEX)
    expect(await h.liveness.probe(attempt)).toMatchObject({ sessionKey: attempt.sessionKey, kind: 'agent' })
    h.setOwner(CHILD_SHELL)
    expect(await h.liveness.probe(attempt)).toMatchObject({ kind: 'unknown' })
    h.setOwner(null)
    expect(await h.liveness.probe(attempt)).toBeNull()
    h.setOwner({ ...SHELL, paneId: 'win32:g2:b2' })
    const replaced = await h.liveness.probe(attempt)
    expect(replaced?.sessionKey).not.toBe(attempt.sessionKey)
  })

  it('a verified hook after the launch confirms it; an old unconfirmed launch stops being watched', () => {
    const h = harness()
    h.launches.push(launch())
    h.mirror.set('worker', verified({ updatedAt: 1_000_500 }))
    expect(h.liveness.attempts()[0]).toMatchObject({ confirmed: true, revision: 1 })
    h.mirror.clear()
    h.advance(LAUNCH_WATCH_MS + 1)
    expect(h.liveness.attempts()).toEqual([])
  })

  it('tracks verified sessions of agents with no SessionEnd hook only, and never restored or expired state', () => {
    const h = harness()
    h.mirror.set('codex', verified())
    h.mirror.set('agy', verified({ agentId: 'antigravity', sessionId: 's2', state: 'done' }))
    h.mirror.set('claude', verified({ agentId: 'claude', sessionId: 's3' }))
    h.mirror.set('restored', verified({ sessionId: 's4', restored: true }))
    h.mirror.set('unverified', verified({ sessionId: 's5', stateVerified: false }))
    expect(h.liveness.attempts().map((a) => [a.nodeId, a.attemptId, a.confirmed])).toEqual([
      ['codex', 'session:s1', true], ['agy', 'session:s2', true]
    ])
  })

  it('suppresses a hibernated node and one whose program the app itself ended, until a later hook', () => {
    const h = harness()
    h.mirror.set('sleeping', verified({ hibernated: true }))
    h.mirror.set('restarted', verified({ sessionId: 's2' }))
    h.exits.set('restarted', 1_000_000)
    expect(h.liveness.attempts().map((a) => a.suppressed)).toEqual([true, true])
    h.mirror.set('restarted', verified({ sessionId: 's2', updatedAt: 1_000_001 }))
    expect(h.liveness.attempts().find((a) => a.nodeId === 'restarted')?.suppressed).toBe(false)
  })

  it('records the conclusion on the mirror and stops watching it until something newer is asserted', () => {
    const h = harness()
    h.mirror.set('worker', verified())
    const [attempt] = h.liveness.attempts()
    h.liveness.publish('worker', attempt.attemptId, 'dropped')
    expect(h.lifecycle).toHaveBeenCalledWith('worker', 'dropped')
    expect(h.liveness.attempts()).toEqual([])
    h.mirror.set('worker', verified({ updatedAt: 1_000_001 }))
    expect(h.liveness.attempts()).toHaveLength(1)
  })
})
