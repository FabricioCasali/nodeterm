import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseControlRequest } from '../../src/core/canvas-control-core'
import { controlListingText, storedNodeListing } from '../../src/renderer/lib/controlRouting'
import { createAgentStatusSession } from '../../src/renderer/state/agentStatus'
import { useAgentNodes } from '../../src/renderer/state/agentNodes'
import { applyAgentEvent } from '../../src/renderer/state/applyAgentEvent'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('PAR-230 T06: list details from real status events', () => {
  it.each([
    { state: 'blocked' as const, askKind: 'approval' as const, text: 'Bash "pwd"', minutes: 65 },
    { state: 'waiting' as const, askKind: 'question' as const, text: 'Qual escopo?', minutes: 12 }
  ])('lists $askKind detail and the original age after a repeated hook', ({ state, askKind, text, minutes }) => {
    const { store } = createAgentStatusSession(undefined)
    const event: NormalizedAgentEvent = {
      nodeId: 'worker', agentId: 'claude', sessionId: 'session-1', kind: 'state',
      state, askKind, lastMessage: text, verified: true,
      ...(askKind === 'approval' ? { pendingId: 'worker-1-1' } : {})
    }
    applyAgentEvent(store, useAgentNodes, event, { observationRemote: false })
    vi.advanceTimersByTime(minutes * 60_000 - 1)
    applyAgentEvent(store, useAgentNodes, event, { observationRemote: false })
    vi.advanceTimersByTime(1)
    const rows = storedNodeListing([{ id: 'worker', agentId: 'claude' }], store.getState().byId, {}, Date.now())
    const listing = controlListingText(rows)
    expect(listing).toContain('NEEDS YOU')
    expect(listing).toContain(askKind)
    expect(listing).toContain(`${minutes}m`)
    expect(listing).toContain(text)
  })
})

describe('PAR-230 T07: capture-pane at the shared verb boundary', () => {
  it.each([undefined, '1', '30'])('accepts a visible-screen read with lines=%s', (lines) => {
    const args = { node: 'worker', ...(lines === undefined ? {} : { lines }) }
    expect(parseControlRequest('capture-pane', args)).toEqual({ verb: 'capture-pane', args })
  })

  it.each(['0', '-1', '1.5', 'NaN', '2tail'])('rejects invalid --lines %s explicitly', (lines) => {
    const result = parseControlRequest('capture-pane', { node: 'worker', lines })
    expect(result).toHaveProperty('error')
    expect('error' in result && result.error).toMatch(/lines/i)
  })

  it('requires the target node explicitly', () => {
    const result = parseControlRequest('capture-pane', {})
    expect(result).toHaveProperty('error')
    expect('error' in result && result.error).toMatch(/node/i)
  })
})
