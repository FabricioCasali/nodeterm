import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { compareSwimlanePriority, swimlanePriorityTier } from '../../lib/kanban'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from './KanbanView'

const GLOBAL_KANBAN_SRC = fs.readFileSync(path.join(__dirname, 'GlobalKanbanView.tsx'), 'utf8')

describe('global kanban swimlane collapse wiring', () => {
  it('starts empty lanes collapsed, auto-recollapses after idle, and toggles the lane body from its header', () => {
    expect(GLOBAL_KANBAN_SRC).toContain('const [collapsed, setCollapsed] = useState(() => sessions.length === 0)')
    expect(GLOBAL_KANBAN_SRC).toContain('EMPTY_SWIMLANE_COLLAPSE_MS')
    expect(GLOBAL_KANBAN_SRC).toContain('onClick={toggleCollapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('aria-expanded={!collapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('setCollapsed((value) => !value)')
    expect(GLOBAL_KANBAN_SRC).toContain('{!collapsed && (')
  })
})

describe('global kanban priority sorting', () => {
  const board: ProjectKanban = {
    columns: [
      { id: 'c-comigo', title: 'Comigo', color: '#0a84ff' },
      { id: 'c-impl', title: 'Implementacao', color: '#ff453a' },
      { id: 'c-fixas', title: 'Fixas', color: '#6ac4dc' }
    ],
    assignments: []
  }
  const sess = (id: string): KanbanSession => ({
    id,
    title: id,
    color: '#fff',
    kind: 'terminal',
    spawn: {} as never
  })

  it('orders Comigo/NeedsYou (tier 0) > working/running (tier 1) > parked (tier 2) > empty (tier 3)', () => {
    expect(swimlanePriorityTier(board, [], {}).tier).toBe(3)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-fixas' }] },
        [sess('s1')],
        {}
      ).tier
    ).toBe(2)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-impl' }] },
        [sess('s1')],
        {}
      ).tier
    ).toBe(1)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-fixas' }] },
        [sess('s1')],
        { s1: { state: 'working' } }
      ).tier
    ).toBe(1)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-comigo' }] },
        [sess('s1')],
        {}
      ).tier
    ).toBe(0)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-fixas' }] },
        [sess('s1')],
        { s1: { state: 'waiting' } }
      ).tier
    ).toBe(0)
  })

  it('within the same priority tier, places the project with the most recent event on top', () => {
    const olderComigo = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's1', columnId: 'c-comigo' }] },
      [sess('s1')],
      { s1: { state: 'waiting', lastEventAt: 1000 } }
    )
    const newerComigo = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's2', columnId: 'c-comigo' }] },
      [sess('s2')],
      { s2: { state: 'waiting', lastEventAt: 5000 } }
    )
    const workingRecent = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's3', columnId: 'c-impl' }] },
      [sess('s3')],
      { s3: { state: 'working', lastEventAt: 9000 } }
    )
    const sorted = [
      { id: 'working-recent', priority: workingRecent, originalIdx: 0 },
      { id: 'older-comigo', priority: olderComigo, originalIdx: 1 },
      { id: 'newer-comigo', priority: newerComigo, originalIdx: 2 }
    ].sort(compareSwimlanePriority)
    expect(sorted.map((x) => x.id)).toEqual(['newer-comigo', 'older-comigo', 'working-recent'])
  })
})

describe('global kanban card read state', () => {
  it('clears the unread dot when a card opens, like the per-project board', () => {
    expect(GLOBAL_KANBAN_SRC).toContain("import { useAgentStatus } from '../../state/agentStatus'")
    expect(GLOBAL_KANBAN_SRC).toContain('if (modalNodeId) useAgentStatus.getState().clearUnread(modalNodeId)')
  })
})
