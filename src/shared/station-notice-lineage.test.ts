import { describe, expect, it } from 'vitest'
import { StationLineage, type StationCanvas } from './station-notice'

function canvas(): StationCanvas {
  return { id: 'p', nodes: [
    { id: 'root', agentId: 'claude' }, { id: 'parent', openedBy: 'root', agentId: 'claude' },
    { id: 'worker', openedBy: 'parent', agentId: 'claude' }
  ], ropes: [{ source: 'root', target: 'parent' }, { source: 'parent', target: 'worker' }] }
}

describe('notice ancestry and revocation', () => {
  it('retains closed ancestors and picks the first live node', () => {
    const c = canvas(), lineage = new StationLineage()
    lineage.observe([c])
    expect(lineage.recipient([c], 'worker')?.recipientNodeId).toBe('parent')
    c.nodes = c.nodes.filter((n) => n.id !== 'parent')
    c.ropes = []
    lineage.observe([c])
    expect(lineage.recipient([c], 'worker')?.recipientNodeId).toBe('root')
    c.nodes = c.nodes.map((n) => n.id === 'worker' ? { ...n, openedBy: undefined } : n)
    lineage.observe([c])
    expect(lineage.recipient([c], 'worker')).toBeUndefined()
  })
  it('does not resurrect an edge revoked before a close', () => {
    const c = canvas(), lineage = new StationLineage()
    lineage.observe([c])
    c.ropes = c.ropes!.filter((r) => r.target !== 'worker')
    lineage.observe([c])
    c.nodes = c.nodes.filter((n) => n.id !== 'parent')
    lineage.observe([c])
    expect(lineage.recipient([c], 'worker')).toBeUndefined()
  })
  it('refuses cycles, duplicate ids, and ancestors moved to another project', () => {
    const c = canvas(), lineage = new StationLineage()
    lineage.observe([c])
    c.nodes = c.nodes.filter((n) => n.id !== 'parent')
    lineage.observe([c])
    const other = { id: 'other', nodes: [{ id: 'root', agentId: 'claude' }] }
    expect(lineage.recipient([c, other], 'worker')).toBeUndefined()
    c.nodes = c.nodes.filter((n) => n.id !== 'root')
    lineage.observe([c, other])
    expect(lineage.recipient([c, other], 'worker')).toBeUndefined()
    c.nodes = [{ id: 'worker', agentId: 'claude', openedBy: 'worker' }]
    c.ropes = [{ source: 'worker', target: 'worker' }]
    lineage.observe([c])
    expect(lineage.recipient([c], 'worker')).toBeUndefined()
  })
  it('does not accept persisted openedBy in place of server creator proof', () => {
    const c = canvas(), lineage = new StationLineage()
    lineage.observe([c], () => undefined)
    expect(lineage.recipient([c], 'worker')).toBeUndefined()
  })
})
