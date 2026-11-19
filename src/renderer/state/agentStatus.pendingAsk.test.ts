import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusSession } from './agentStatus'
import { controlListingText, storedNodeListing } from '../lib/controlRouting'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('pending question and approval age', () => {
  it('retains age on a repeated ticket and resets on ticket/session replacement', () => {
    const { store } = createAgentStatusSession(undefined)
    const set = (id: string, sessionId = 's') => store.getState().setState('node', 'blocked', 'claude',
      false, id, true, false, undefined, false, { kind: 'approval', detail: 'Bash "pwd"', id, sessionId })
    set('ticket1')
    vi.advanceTimersByTime(65 * 60_000)
    set('ticket1')
    const text = () => controlListingText(storedNodeListing([{ id: 'node', agentId: 'claude' }], store.getState().byId))
    expect(text()).toContain('[approval 65m: Bash "pwd"]')
    set('ticket2')
    expect(text()).toContain('[approval 0m:')
    vi.advanceTimersByTime(60_000)
    set('ticket2', 'replacement')
    expect(text()).toContain('[approval 0m:')
    store.getState().setState('node', 'working', 'claude', true, undefined, true)
    expect(store.getState().byId.node.pendingAsk).toBeUndefined()
    expect(text()).not.toContain('approval')
  })
  it('formats question text as one data line', () => {
    const { store } = createAgentStatusSession(undefined)
    store.getState().setState('node', 'waiting', 'claude', false, undefined, true, false, undefined, false,
      { kind: 'question', detail: 'Qual escopo?\nOutra linha', id: 'q', sessionId: 's' })
    const text = controlListingText(storedNodeListing([{ id: 'node', agentId: 'claude' }], store.getState().byId))
    expect(text).toContain('[question 0m: Qual escopo? Outra linha]')
    expect(text.split('\n')).toHaveLength(1)
  })
})
