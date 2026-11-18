import { describe, expect, it } from 'vitest'
import { normalizeAntigravity, normalizeClaude } from './normalize'
import captured from './__fixtures__/antigravity/hook-payloads.json'

describe('question details from CLI payloads', () => {
  it('retains the measured agy question without changing its state mapping', () => {
    const sample = captured.events.find((e) => e.event === 'PreToolUse' &&
      (e.payload.toolCall as { name?: string })?.name === 'ask_question')!
    const event = normalizeAntigravity({ nodeId: 'worker', agentId: 'antigravity',
      payload: { ...sample.payload, nodeterm_hook_event: sample.event } })
    expect(event).toMatchObject({ state: 'waiting', lastMessage: 'Qual formato de arquivo de configuração você prefere utilizar?' })
  })
  it.each([null, {}, { questions: 'invalid' }, { questions: [{ question: 7 }] }])('omits malformed agy details: %j', (args) => {
    expect(normalizeAntigravity({ nodeId: 'worker', agentId: 'antigravity', payload: {
      nodeterm_hook_event: 'PreToolUse', conversationId: 's', toolCall: { name: 'ask_question', args }
    } })).toMatchObject({ state: 'waiting' })
    expect(normalizeAntigravity({ nodeId: 'worker', agentId: 'antigravity', payload: {
      nodeterm_hook_event: 'PreToolUse', toolCall: { name: 'ask_question', args }
    } })?.lastMessage).toBeUndefined()
  })
  it('retains Claude question text with the existing question parser', () => {
    const event = normalizeClaude({ nodeId: 'worker', agentId: 'claude', payload: {
      hook_event_name: 'PreToolUse', session_id: 'session', tool_name: 'AskUserQuestion', tool_use_id: 'question-1',
      tool_input: { questions: [{ question: 'Qual escopo?', header: 'Escopo', multiSelect: false,
        options: [{ label: 'F1', description: 'Mensagens' }, { label: 'Tudo', description: 'Todas as fatias' }] }] }
    } })
    expect(event).toMatchObject({ state: 'waiting', questionId: 'question-1', lastMessage: 'Qual escopo?' })
  })
})
