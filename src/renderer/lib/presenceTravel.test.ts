import { describe, expect, it } from 'vitest'
import { linkFocusAction, nodeTravel, projectTravel, type TravelProject } from './presenceTravel'

const projects: TravelProject[] = [
  { id: 'open', nodes: [{ id: 'n-open' }] },
  { id: 'active', nodes: [{ id: 'n-active' }] },
  { id: 'closed', closed: true, nodes: [{ id: 'n-closed' }] },
  { id: 'gone', closed: true, unavailable: true, nodes: [{ id: 'n-gone' }] }
]

describe('projectTravel', () => {
  it('does nothing for the project we are already on', () => {
    expect(projectTravel(projects, 'active', 'active')).toEqual({ kind: 'none' })
  })

  it('switches to another open project', () => {
    expect(projectTravel(projects, 'active', 'open')).toEqual({ kind: 'switch', projectId: 'open' })
  })

  it('reopens a closed project rather than activating an invisible tab', () => {
    expect(projectTravel(projects, 'active', 'closed')).toEqual({
      kind: 'reopen',
      projectId: 'closed'
    })
  })

  it('blocks an unavailable project (reopening it would show an empty canvas)', () => {
    expect(projectTravel(projects, 'active', 'gone')).toEqual({ kind: 'blocked' })
  })

  it('does nothing for a project we do not have', () => {
    expect(projectTravel(projects, 'active', 'nope')).toEqual({ kind: 'none' })
  })

  it('travels from the welcome screen (no active project)', () => {
    expect(projectTravel(projects, '', 'open')).toEqual({ kind: 'switch', projectId: 'open' })
  })
})

describe('nodeTravel', () => {
  it('needs no travel for a node on the active canvas', () => {
    expect(nodeTravel(projects, 'active', 'n-active')).toEqual({ kind: 'none' })
  })

  it('switches to the open project that owns the node', () => {
    expect(nodeTravel(projects, 'active', 'n-open')).toEqual({ kind: 'switch', projectId: 'open' })
  })

  it('reopens the closed project that owns the node', () => {
    expect(nodeTravel(projects, 'active', 'n-closed')).toEqual({
      kind: 'reopen',
      projectId: 'closed'
    })
  })

  it('blocks a node in an unavailable project', () => {
    expect(nodeTravel(projects, 'active', 'n-gone')).toEqual({ kind: 'blocked' })
  })

  it('a node a closed, handed-off SSH project shares with its open team tab travels to the tab', () => {
    const shared: TravelProject[] = [
      { id: 'ssh-1', closed: true, handedOffTo: { at: 1 }, nodes: [{ id: 'n-team' }] },
      { id: 'team-tab', nodes: [{ id: 'n-team' }] },
      { id: 'active', nodes: [] }
    ]
    expect(nodeTravel(shared, 'active', 'n-team')).toEqual({ kind: 'switch', projectId: 'team-tab' })
  })

  it('a shared node whose team tab is CLOSED travels to the handed-off SSH project (guarded reopen), never the tab', () => {
    const shared: TravelProject[] = [
      { id: 'ssh-1', closed: true, handedOffTo: { at: 1 }, nodes: [{ id: 'n-team' }] },
      { id: 'team-tab', closed: true, remote: true, nodes: [{ id: 'n-team' }] },
      { id: 'active', nodes: [] }
    ]
    expect(nodeTravel(shared, 'active', 'n-team')).toEqual({ kind: 'reopen', projectId: 'ssh-1' })
  })

  it('does nothing for an unknown node', () => {
    expect(nodeTravel(projects, 'active', 'n-ghost')).toEqual({ kind: 'none' })
  })
})

describe('linkFocusAction', () => {
  // `active` is the active project; `open` is another open tab; `closed` is closed; `gone` is unreadable.
  const landed = { liveOnCanvas: false, activeLanded: true }

  it('a malformed link (no node id) is not found', () => {
    expect(linkFocusAction(projects, 'active', null, landed)).toBe('not-found')
    expect(linkFocusAction(projects, 'active', null, { liveOnCanvas: false, activeLanded: false })).toBe('not-found')
  })

  it('travels to a node on the live canvas of the landed active project', () => {
    expect(linkFocusAction(projects, 'active', 'n-active', { liveOnCanvas: true, activeLanded: true })).toBe('travel')
  })

  it('travels to a node of another open project', () => {
    expect(linkFocusAction(projects, 'active', 'n-open', landed)).toBe('travel')
  })

  it('travels to a node of a closed project', () => {
    expect(linkFocusAction(projects, 'active', 'n-closed', landed)).toBe('travel')
  })

  it('travels to a node of an unavailable project, like the notification click', () => {
    expect(linkFocusAction(projects, 'active', 'n-gone', landed)).toBe('travel')
  })

  it('a node no project has is not found', () => {
    expect(linkFocusAction(projects, 'active', 'n-ghost', landed)).toBe('not-found')
  })

  it('waits for the landing when the active project owns the node but has not landed yet', () => {
    expect(linkFocusAction(projects, 'active', 'n-active', { liveOnCanvas: false, activeLanded: false })).toBe('wait-landing')
  })

  it('a node in the landed active project store but off the live canvas is not found', () => {
    expect(linkFocusAction(projects, 'active', 'n-active', landed)).toBe('not-found')
  })
})
