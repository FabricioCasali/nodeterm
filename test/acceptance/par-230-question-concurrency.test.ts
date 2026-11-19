import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeClaude } from '../../src/shared/agents/normalize'
import { _resetForTest, _snapshot, _inboxSnapshot, recordAgentEvent, recordRawToolEvent } from '../../src/core/agent-status-mirror'
import { listControlNodes } from '../../src/core/canvas-control-core'
import { createAgentStatusSession } from '../../src/renderer/state/agentStatus'
import { applyAgentEvent } from '../../src/renderer/state/applyAgentEvent'
import { controlListingText, storedNodeListing } from '../../src/renderer/lib/controlRouting'

beforeEach(() => { _resetForTest(); vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { _resetForTest(); vi.clearAllTimers(); vi.useRealTimers() })

it('PAR-230 T06: a concurrent child permission preserves the parent question across mirror, renderer and list', async () => {
  const { store } = createAgentStatusSession(undefined)
  // Payload sequence from core/pending-question.test.ts: parent picker and child permission.
  const hook = (hook_event_name: string, extra: Record<string, unknown>) => {
    const payload = { hook_event_name, session_id: 'parent', ...extra }
    recordRawToolEvent('node', payload)
    const normalized = normalizeClaude({ nodeId: 'node', agentId: 'claude', payload })
    expect(normalized).not.toBeNull()
    const broadcast = recordAgentEvent({ ...normalized!, verified: true })
    applyAgentEvent(store, null, broadcast, { observationRemote: false })
    return broadcast
  }
  const nodes = [{ id: 'node', kind: 'terminal', agentId: 'claude', title: 'Worker' }]
  const rendererList = () => controlListingText(storedNodeListing(nodes, store.getState().byId, {}, Date.now()))
  const serverList = () => listControlNodes('node', {}, {
    projects: () => [{ id: 'project', nodes, ropes: [] }],
    statusOf: (id) => _snapshot()[id], capture: async () => '', now: Date.now
  })
  hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } })
  const original = { ...store.getState().byId.node.pendingAsk }
  expect(original).toMatchObject({ kind: 'question', detail: 'Which?', id: 'ask-1', sessionId: 'parent', since: Date.now() })
  vi.advanceTimersByTime(12 * 60_000)
  expect(rendererList()).toContain('[question 12m: Which?]')

  hook('PermissionRequest', { agent_id: 'child', session_id: 'child-session', tool_name: 'Bash',
    tool_input: { command: 'echo child' }, nodeterm_pending_id: 'ticket-1' })

  expect(_snapshot().node.pendingQuestion).toEqual({ sessionId: 'parent', toolUseId: 'ask-1' })
  expect(_snapshot().node.state).toBe('waiting')
  const open = _inboxSnapshot().events.filter((event) => !event.resolved)
  expect(open).toHaveLength(2)
  expect(open.find((event) => event.kind === 'question')?.title).toBe('Which?')
  expect(open.find((event) => event.kind === 'approval')).toMatchObject({ pendingId: 'ticket-1' })
  expect((await serverList()).message).toContain('[question 12m: Which?]')
  expect.soft(store.getState().byId.node.pendingAsk).toEqual(original)
  expect.soft(rendererList()).toContain('[question 12m: Which?]')
  expect.soft(rendererList()).not.toContain('[approval')
})
