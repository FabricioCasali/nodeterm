// PAR-255: `agentLaunchArgs` is exec-enabling (`--mcp-config` starts processes, `--settings`
// installs hooks), so it obeys the same machine-local rule as `shell` (@shared/node-exec).
import { describe, it, expect } from 'vitest'
import type { CanvasNodeState } from './types'
import {
  applyLocalNodeExec,
  carryLocalNodeExec,
  hoistLegacyNodeExec,
  localNodeExec,
  sanitizeInboundNode,
  stripCastNodeExec,
  stripSharedNodeExec
} from './node-exec'

const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-abc',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  title: 't',
  color: '#fff',
  group: null,
  agentId: 'claude',
  ...over
})

const ARGS = '--mcp-config C:/x/mcp.json'

describe('agentLaunchArgs is machine-local', () => {
  it('never reaches a shared project file, a cast or an inbound peer copy', () => {
    const n = node({ agentLaunchArgs: ARGS })
    expect(stripSharedNodeExec([n])[0].agentLaunchArgs).toBeUndefined()
    expect(stripCastNodeExec([n])[0].agentLaunchArgs).toBeUndefined()
    expect(sanitizeInboundNode(n).agentLaunchArgs).toBeUndefined()
    expect(sanitizeInboundNode(n, true).agentLaunchArgs).toBeUndefined()
    // The input is not mutated.
    expect(n.agentLaunchArgs).toBe(ARGS)
  })

  it('round-trips through the machine-local index', () => {
    const local = localNodeExec([node({ agentLaunchArgs: ARGS })])
    expect(local).toEqual({ 'term-abc': { agentLaunchArgs: ARGS } })
    const fromFile = node()
    expect(applyLocalNodeExec([fromFile], local)[0].agentLaunchArgs).toBe(ARGS)
  })

  it('a project file can never contribute one, and the index re-validates its own', () => {
    // A cloned/hostile project.json carrying the field: dropped, with or without an index entry.
    const hostile = node({ agentLaunchArgs: '--settings /tmp/evil.json' })
    expect(applyLocalNodeExec([hostile], undefined)[0].agentLaunchArgs).toBeUndefined()
    expect(hoistLegacyNodeExec([hostile])).toBeUndefined()
    // A hand-edited workspace.json value that the launch line would refuse is not re-attached.
    expect(applyLocalNodeExec([node()], { 'term-abc': { agentLaunchArgs: '--x\n' } })[0].agentLaunchArgs).toBeUndefined()
    expect(localNodeExec([node({ agentLaunchArgs: '--x "open' })])).toBeUndefined()
  })

  it('ours survive a peer upsert of the same node', () => {
    const prev = node({ agentLaunchArgs: ARGS })
    const theirs = sanitizeInboundNode(node({ title: 'moved', agentLaunchArgs: '--settings /evil' }))
    const out = carryLocalNodeExec(prev, theirs)
    expect(out.agentLaunchArgs).toBe(ARGS)
    expect(out.title).toBe('moved')
  })
})
