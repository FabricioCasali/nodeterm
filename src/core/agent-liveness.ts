// Process liveness outside the renderer — the producer behind `StationLivenessDeps`
// (core/agents/station-notice.ts), shared by the desktop and the Server Edition.
//
// WHY it is in core: a station opened with `--run-now` in a project that is not on screen has no
// mounted terminal, so nothing in a renderer can tell "its CLI never started" or "its CLI died"
// from "it is working quietly". The core can: it delivered the launch, it hears the hooks, and it
// can read the pane's process tree without attaching (`paneOwner(…, { resolveUnmounted: true })`).
//
// WHAT is watched — never the whole canvas or the whole process table:
//  - launches this core delivered through `executeLaunch` (one attempt per launch id), until they
//    are confirmed, concluded, or `LAUNCH_WATCH_MS` old; and
//  - sessions of agents with no SessionEnd hook (codex, antigravity) that the status mirror holds a
//    VERIFIED state for from this run. Those CLIs never announce their exit, so their pane is the
//    only witness.
//
// Every fact here is the core's own: the launch record, the mirror, the pane probe, the receipt
// file the launch itself writes on return. Nothing is taken from a renderer or a shared file.

import fs from 'fs'
import type { AgentId } from '../shared/agents/config'
import { reportsSessionEnd } from '../shared/agents/config'
import { isLaunchShell } from '../shared/agents/pane'
import { binariesFor, isAgentPane, type PaneOwner } from '../shared/agents/pane-owner-predicate'
import type { MirrorEntry } from './agent-status-mirror'
import type {
  StationLaunchAttempt,
  StationLivenessDeps,
  StationProcessProof
} from './agents/station-notice'

/** A semantic launch the session host accepted (`PtyManager.launchAttempts`). */
export interface DeliveredLaunch {
  nodeId: string
  launchId: string
  agentId: string
  /** When the host accepted it. */
  at: number
  /** The file the launch writes when its invocation returns to the shell, when one could be kept. */
  receipt?: string
}

/** How long an unconfirmed launch keeps being probed. Past it the launch simply stays unconfirmed:
 *  this bounds the probing, it is never a reason to call a launch failed. */
export const LAUNCH_WATCH_MS = 10 * 60_000

/** A tracked session whose CLI is known to be there is re-read at most this often: the Windows
 *  pane probe walks the process table, and one per node per sweep adds up on a full canvas. */
export const SESSION_PROBE_MIN_MS = 60_000

export interface StationLivenessSources {
  now(): number
  launches(): readonly DeliveredLaunch[]
  mirrorEntries(): ReadonlyArray<readonly [string, Readonly<MirrorEntry>]>
  paneOwner(nodeId: string, opts: { resolveUnmounted: true }): Promise<PaneOwner | null>
  customAgents(): readonly { id: string; launchCmd: string; baseAgent?: string }[] | undefined
  /** When the app itself last ended this node's foreground program or session (restart, close). */
  deliberateExitAt(nodeId: string): number | undefined
  /** Record the conclusion on the status mirror (list, cards, snapshot read it from there). */
  setLifecycle(nodeId: string, state: 'launch-failed' | 'dropped' | undefined): void
  /** Test seam. */
  receiptExists?(file: string): boolean
}

/** The generation a pane read belongs to: the host's own handle when it has one, else the root
 *  process and its birth. A respawned shell in the same node reads differently. */
function generationOf(owner: PaneOwner): string {
  return owner.paneId ?? `${owner.panePid}:${owner.processBirths?.[0] ?? ''}`
}

/** A fixed token: the generation is BOUND at the first read (see `probe`), so a later read of a
 *  different one answers a different key and the monitor discards it. */
const BOUND = 'bound'

export function createStationLiveness(d: StationLivenessSources): StationLivenessDeps {
  /** attemptId → the generation its first read saw. */
  const generations = new Map<string, string>()
  /** nodeId → the attempt already concluded, and the mirror clock it was concluded at. */
  const concluded = new Map<string, { attemptId: string; at: number }>()
  /** nodeId → the last proof and when it was read (the tracked-session throttle). */
  const lastRead = new Map<string, { attemptId: string; at: number; proof: StationProcessProof | null }>()
  const receipts = new Map<string, string>()
  const receiptExists = d.receiptExists ?? ((file: string) => fs.existsSync(file))

  const confirmedSince = (m: Readonly<MirrorEntry> | undefined, at: number): boolean =>
    !!m && m.stateVerified === true && m.restored !== true && m.stateExpired !== true &&
    m.state !== undefined && m.updatedAt >= at

  /** Still the conclusion on record: nothing newer has been asserted about the node since. */
  const stillConcluded = (nodeId: string, attemptId: string, m: Readonly<MirrorEntry> | undefined): boolean => {
    const c = concluded.get(nodeId)
    if (!c || c.attemptId !== attemptId) return false
    if (m && m.updatedAt > c.at) {
      concluded.delete(nodeId)
      return false
    }
    return true
  }

  function attempts(): readonly StationLaunchAttempt[] {
    const now = d.now()
    const mirror = new Map(d.mirrorEntries())
    const out: StationLaunchAttempt[] = []
    const launched = new Set<string>()
    for (const l of d.launches()) {
      launched.add(l.nodeId)
      const m = mirror.get(l.nodeId)
      if (stillConcluded(l.nodeId, l.launchId, m)) continue
      const confirmed = confirmedSince(m, l.at)
      // A confirmed agent with a SessionEnd hook announces its own exit: nothing left to watch.
      if (confirmed && reportsSessionEnd(l.agentId as AgentId)) continue
      if (!confirmed && now - l.at > LAUNCH_WATCH_MS) continue
      if (l.receipt) receipts.set(l.launchId, l.receipt)
      out.push({
        nodeId: l.nodeId,
        attemptId: l.launchId,
        sessionKey: BOUND,
        agentId: l.agentId,
        revision: confirmed ? 1 : 0,
        confirmed,
        suppressed: m?.hibernated === true
      })
    }
    for (const [nodeId, m] of mirror) {
      if (launched.has(nodeId) || !m.agentId || !m.sessionId) continue
      if (reportsSessionEnd(m.agentId)) continue
      if (m.stateVerified !== true || m.restored === true || m.stateExpired === true || m.state === undefined) continue
      const attemptId = `session:${m.sessionId}`
      if (stillConcluded(nodeId, attemptId, m)) continue
      const exitAt = d.deliberateExitAt(nodeId)
      out.push({
        nodeId,
        attemptId,
        sessionKey: BOUND,
        agentId: m.agentId,
        revision: 1,
        confirmed: true,
        // The app ended it and no hook has spoken since: an exit somebody asked for.
        suppressed: m.hibernated === true || (exitAt !== undefined && exitAt >= m.updatedAt)
      })
    }
    return out
  }

  async function probe(attempt: StationLaunchAttempt): Promise<StationProcessProof | null> {
    const now = d.now()
    const last = lastRead.get(attempt.nodeId)
    // Only a session whose CLI was just seen is throttled; a shell or an unreadable pane is re-read.
    if (
      attempt.confirmed && last && last.attemptId === attempt.attemptId &&
      last.proof?.kind === 'agent' && now - last.at < SESSION_PROBE_MIN_MS
    )
      return last.proof
    const remember = (proof: StationProcessProof | null): StationProcessProof | null => {
      lastRead.set(attempt.nodeId, { attemptId: attempt.attemptId, at: now, proof })
      return proof
    }
    let owner: PaneOwner | null
    try {
      owner = await d.paneOwner(attempt.nodeId, { resolveUnmounted: true })
    } catch {
      owner = null
    }
    if (!owner) return remember(null)
    const generation = generationOf(owner)
    const bound = generations.get(attempt.attemptId)
    if (bound === undefined) generations.set(attempt.attemptId, generation)
    else if (bound !== generation) return remember({ sessionKey: `replaced:${generation}`, kind: 'unknown' })
    const verdict = isAgentPane(owner, attempt.agentId, binariesFor(attempt.agentId, d.customAgents()))
    if (verdict === 'agent') return remember({ sessionKey: BOUND, kind: 'agent' })
    // `shell` is said only about the ROOT shell standing alone: a foreground shell that is a child
    // of the CLI (a tool it ran) leaves the CLI in the tree, and anything else is not proof.
    const rootAlone =
      verdict === 'not-agent' && isLaunchShell(owner.command) &&
      (owner.pids === undefined || (owner.pids.length === 1 && owner.pids[0] === owner.panePid))
    if (!rootAlone) return remember({ sessionKey: BOUND, kind: 'unknown' })
    const receipt = receipts.get(attempt.attemptId)
    return remember({
      sessionKey: BOUND,
      kind: 'shell',
      ...(receipt && receiptExists(receipt) ? { commandFinished: true as const } : {})
    })
  }

  function publish(nodeId: string, attemptId: string, state: 'launch-failed' | 'dropped' | undefined): void {
    d.setLifecycle(nodeId, state)
    if (!state) {
      concluded.delete(nodeId)
      return
    }
    const m = new Map(d.mirrorEntries()).get(nodeId)
    concluded.set(nodeId, { attemptId, at: m?.updatedAt ?? d.now() })
    lastRead.delete(nodeId)
    generations.delete(attemptId)
    receipts.delete(attemptId)
  }

  return { attempts, probe, publish }
}
