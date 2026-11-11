// Armed nodes in a project that is NOT on screen (PAR-161). The canvas's launch loop only sees the
// ACTIVE project's React Flow nodes, so a node armed with `--after` / `--after-success` in another
// project used to sit QUEUED until someone opened that project — an orchestrator's team stalled
// while the user looked elsewhere. This module decides which of those nodes may start now; Canvas
// hands them to the #925 headless start (`startNodesHeadlessRef`), the same path `open-* --run-now`
// and `run` take. No tab is activated, none is restored.
//
// Pure: the decision is `launchesToFire` itself, run over the STORED nodes of each eligible project.
import type { CanvasNodeState, PendingLaunch, Project } from '@shared/types'
import { normalizeSuccessWaitHold, type StationOutcomeRecord } from '@shared/station-outcome'
import {
  launchesToFire,
  type ArmedNode,
  type HandoverById,
  type LaunchDelivery,
  type StatusById
} from './pendingLaunch'

export interface CascadeTarget {
  project: Project
  /** The project's armed nodes this module may start, in `launchesToFire`'s shape. */
  armed: ArmedNode[]
  /** Every node id the project holds: a dep outside it counts as deleted (`launchesToFire`). */
  live: ReadonlySet<string>
}

/**
 * Projects whose armed nodes may start off screen: not the active one (that one is the canvas
 * loop's), not closed (a headless start would restore its tab, and a closed tab is the user's "park
 * this"), and on THIS machine's disk — no SSH project (the headless launcher is local-only), no
 * relay tab (the host owns its launches), nothing unavailable or handed off to a team.
 */
export function cascadeProjectEligible(p: Project, activeProjectId: string): boolean {
  return (
    p.id !== activeProjectId && !p.closed && !p.ssh && !p.remote && !p.unavailable && !p.handedOffTo
  )
}

/**
 * A stored node this module may start. Only a node that WAITS on something: a held launch with no
 * dependency is a cold open (`open-* --project`), which by contract starts when its project is next
 * viewed — `--run-now` is the explicit way to start one now. Never an already-attempted launch (it
 * waits for Run now), a `--after-pr` wait (its pull request watch runs only for the project on
 * screen, so its board here is stale or absent), or a node that runs over SSH.
 */
export function cascadeNodeEligible(n: CanvasNodeState): boolean {
  const p = n.pendingLaunch as PendingLaunch | undefined
  if (!p?.command || p.manualOnly || p.attempted || p.executor === 'server' || p.afterPr) return false
  if (n.ssh || n.sshRemoteTmux || !Array.isArray(p.after)) return false
  const success = normalizeSuccessWaitHold(p.afterSuccess)
  return p.after.length > 0 || (!!success && !success.invalid)
}

export function backgroundCascadeTargets(
  projects: readonly Project[],
  activeProjectId: string
): CascadeTarget[] {
  const out: CascadeTarget[] = []
  for (const project of projects) {
    if (!cascadeProjectEligible(project, activeProjectId)) continue
    const armed = project.nodes
      .filter(cascadeNodeEligible)
      .map((n) => ({ id: n.id, data: { pendingLaunch: n.pendingLaunch as PendingLaunch } }))
    if (armed.length) out.push({ project, armed, live: new Set(project.nodes.map((n) => n.id)) })
  }
  return out
}

/** A primitive key of WHICH nodes are armed and on what — what the projects-store selector returns,
 *  so the canvas re-renders only when the background armed set changes. */
export function cascadeKey(targets: readonly CascadeTarget[]): string {
  let k = ''
  for (const t of targets) {
    k += `${t.project.id}{`
    for (const n of t.armed) {
      const p = n.data.pendingLaunch!
      k += `${n.id}:${p.after.join(',')}/${normalizeSuccessWaitHold(p.afterSuccess)?.deps.join(',') ?? ''}/${p.awaitSetupGroup ?? ''};`
    }
    k += '}'
  }
  return k
}

/** Every station a background armed node waits on (`after`, plus success deps). */
export function cascadeDepIds(targets: readonly CascadeTarget[]): string[] {
  const ids = new Set<string>()
  for (const t of targets)
    for (const n of t.armed) {
      const p = n.data.pendingLaunch!
      for (const d of p.after) ids.add(d)
      for (const d of normalizeSuccessWaitHold(p.afterSuccess)?.deps ?? []) ids.add(d)
    }
  return [...ids]
}

/** Setup groups a background armed node waits on. */
export function cascadeSetupGroups(targets: readonly CascadeTarget[]): string[] {
  const ids = new Set<string>()
  for (const t of targets)
    for (const n of t.armed) if (n.data.pendingLaunch!.awaitSetupGroup) ids.add(n.data.pendingLaunch!.awaitSetupGroup!)
  return [...ids]
}

export interface CascadeContext {
  status: StatusById
  setupDone: (groupId: string) => boolean
  deliveries: Record<string, LaunchDelivery | undefined>
  outcomes: Readonly<Record<string, StationOutcomeRecord>>
  handovers: HandoverById
  now: number
}

/**
 * The launches to start now, grouped per project with the STORED node (what the headless start
 * takes). `skip` answers ids someone else already owns: a headless start in flight, the canvas
 * loop's delivery, or a background start this run already declined. The PR context is deliberately
 * absent — `launchesToFire` reads that as closed, and `cascadeNodeEligible` already left those out.
 */
export function backgroundLaunches(
  targets: readonly CascadeTarget[],
  ctx: CascadeContext,
  skip: (nodeId: string) => boolean
): { project: Project; nodes: CanvasNodeState[] }[] {
  const out: { project: Project; nodes: CanvasNodeState[] }[] = []
  for (const t of targets) {
    const ready = launchesToFire(
      t.armed,
      ctx.status,
      t.live,
      ctx.setupDone,
      ctx.deliveries,
      undefined,
      { outcomes: ctx.outcomes, now: ctx.now },
      ctx.handovers
    ).filter((f) => !skip(f.id))
    if (!ready.length) continue
    const ids = new Set(ready.map((f) => f.id))
    out.push({ project: t.project, nodes: t.project.nodes.filter((n) => ids.has(n.id)) })
  }
  return out
}
