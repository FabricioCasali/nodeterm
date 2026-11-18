import type { HookServer } from './agents/hook-server'
import { parseControlRequest } from './canvas-control-core'
import type { VisibleCapture } from './watch-link/capture-route'
import { isNoticeRecipient, type StationCanvas } from '../shared/station-notice'
import { isSafeNodeId } from '../shared/safe-id'

type ControlHandler = Parameters<HookServer['setControlHandler']>[0]

export function createCapturePaneControlHandler(
  deps: {
    projects(): readonly StationCanvas[]
    sessionOf(nodeId: string): string | undefined
    captureVisible(sessionId: string): Promise<VisibleCapture>
  },
  next: ControlHandler
): ControlHandler {
  return async (req) => {
    if (req.verb !== 'capture-pane') return next(req)
    const refuse = (error: string) => ({ ok: false, error, message: error })
    if (!req.verified) return refuse('capture-pane requires verified node identity')
    const parsed = parseControlRequest(req.verb, req.args)
    if ('error' in parsed) return refuse(parsed.error)
    const target = req.args.node
    if (!isSafeNodeId(req.nodeId) || !isSafeNodeId(target)) return refuse('Invalid node identity')
    const projects = deps.projects()
    const sources = projects.filter((p) => p.nodes.some((n) => n.id === req.nodeId))
    const targets = projects.filter((p) => p.nodes.some((n) => n.id === target))
    if (sources.length !== 1 || !isNoticeRecipient(sources[0].nodes.find((n) => n.id === req.nodeId)))
      return refuse('Source node is not authorized for canvas control')
    if (targets.length === 0) return refuse('Target node not found')
    if (targets.length !== 1 || targets[0].id !== sources[0].id)
      return refuse('Target node is outside the permitted project')
    const node = targets[0].nodes.find((n) => n.id === target)!
    if (node.kind !== undefined && node.kind !== 'terminal') return refuse('Target node is not a terminal')
    const sessionId = deps.sessionOf(target)
    if (!sessionId) return refuse('Target capture backend unavailable')
    try {
      const captured = await deps.captureVisible(sessionId)
      if (captured.unavailable || deps.sessionOf(target) !== sessionId)
        return refuse('Target capture backend unavailable or session changed')
      const text = req.args.lines === undefined
        ? captured.screen
        : captured.screen.replace(/\n$/, '').split('\n').slice(-Number(req.args.lines)).join('\n')
      return { ok: true, message: text }
    } catch {
      return refuse('Target capture backend unreadable')
    }
  }
}
