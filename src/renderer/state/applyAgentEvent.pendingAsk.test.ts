import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentStatusSession } from './agentStatus'
import { applyAgentEvent } from './applyAgentEvent'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('correlates pending metadata by session and question, preserving incidental-event age', () => {
  const { store } = createAgentStatusSession(undefined)
  const send = (over: Partial<NormalizedAgentEvent> = {}) => applyAgentEvent(store, null, {
    nodeId: 'worker', agentId: 'claude', sessionId: 's', kind: 'state', state: 'waiting',
    askKind: 'question', questionId: 'q1', lastMessage: 'Qual escopo?', verified: true, ...over
  }, { observationRemote: false })
  send()
  const since = store.getState().byId.worker.pendingAsk!.since
  vi.advanceTimersByTime(60_000)
  send({ questionId: undefined, lastMessage: undefined })
  expect(store.getState().byId.worker.pendingAsk).toMatchObject({ since, detail: 'Qual escopo?' })
  send({ sessionId: 'new' })
  expect(store.getState().byId.worker.pendingAsk?.since).toBe(Date.now())
  vi.advanceTimersByTime(60_000)
  send({ sessionId: 'new', questionId: 'q2' })
  expect(store.getState().byId.worker.pendingAsk?.since).toBe(Date.now())
  send({ sessionId: 'new', kind: 'session', sessionPhase: 'end', state: undefined })
  expect(store.getState().byId.worker.pendingAsk).toBeUndefined()
})
