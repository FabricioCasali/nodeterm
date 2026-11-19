import { describe, expect, it, vi } from 'vitest'
import { createAgentNode, flowToNodeStates } from '../state/workspace'
import { startHeadless, type HeadlessStartDeps } from './headlessRun'

describe('PAR-230 F2 real renderer factory to off-screen headless start', () => {
  it.each([false, true])('T09/T20 carries semantic intent and promptFile into core; withModel=%s', async (withModel) => {
    const n = createAgentNode('claude', 0, 'C:/repo', undefined, undefined,
      undefined, undefined, undefined, undefined, withModel ? 'opus' : undefined, 'C:/brief com espaço.md')
    n.data.pendingLaunch = { after: [], command: n.data.initialCommand!, attempted: false }
    const node = { ...flowToNodeStates([n])[0], launchIntent: n.data.launchIntent }
    const order: string[] = []
    const launch = vi.fn(async () => { order.push('launch'); return { outcome: 'delivered' as const, fresh: true } })
    const deps: HeadlessStartDeps = {
      launch, inFlight: new Set(),
      savePending: vi.fn(async (_id, pending) => { order.push(pending ? 'claim' : 'clear'); return true }),
      markStarting: vi.fn(), markFailed: vi.fn(), clearDelivery: vi.fn()
    }
    expect(await startHeadless(deps, { project: { id: 'off-screen', cwd: 'C:/repo' }, node })).toEqual({ id: n.id, started: true })
    expect(order).toEqual(['claim', 'launch', 'clear'])
    const received = JSON.stringify(launch.mock.calls)
    expect(received).toContain('C:/brief com espaço.md')
    expect(received).toContain('"kind":"agent"')
    if (withModel) expect(received).toContain('"model":"opus"')
    expect(deps.inFlight.size).toBe(0)
  })
})
