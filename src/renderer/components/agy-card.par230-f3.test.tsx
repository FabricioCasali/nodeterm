// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { normalizeAntigravity } from '../../shared/agents/normalize'
import { ContextMeter } from './ContextMeter'
import { AgentProfileChip } from './AccountChip'
import { useAgentStatus } from '../state/agentStatus'
import { applyAgentEvent } from '../state/applyAgentEvent'
import { useSettings } from '../state/settings'
import { DEFAULT_SETTINGS, type CustomAgent } from '../../shared/types'

const PROFILES: CustomAgent[] = [
  { id: 'agy-coder-particular', label: 'Antigravity Coder (Particular)', baseAgent: 'antigravity',
    launchCmd: 'agy', promptInjectionMode: 'argv' },
  { id: 'claude-coder-particular', label: 'Claude Coder (Particular)', baseAgent: 'claude',
    launchCmd: 'claude', promptInjectionMode: 'argv' }
]

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAgentStatus.setState({ byId: {}, activeId: null })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, customAgents: PROFILES } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const hook = (nodeId: string, conversationId: string, modelName?: string) =>
  normalizeAntigravity({ nodeId, agentId: 'antigravity',
    payload: { nodeterm_hook_event: 'PreInvocation', invocationNum: 0, conversationId, ...(modelName ? { modelName } : {}) } })!

describe('PAR-230 F3 · PAR-225 the agy card names its model and profile', () => {
  it('T18 each node keeps the model its OWN session named', () => {
    applyAgentEvent(useAgentStatus, null, hook('agy-1', 'conv-1', 'gemini-4-argon-high'), { observationRemote: false })
    applyAgentEvent(useAgentStatus, null, hook('agy-2', 'conv-2', 'gemini-3.8-flash-high'), { observationRemote: false })
    const byId = useAgentStatus.getState().byId
    expect(byId['agy-1'].model).toBe('gemini-4-argon-high')
    expect(byId['agy-2'].model).toBe('gemini-3.8-flash-high')
    // A later model change in one session moves only that node.
    applyAgentEvent(useAgentStatus, null, hook('agy-1', 'conv-1', 'gemini-3.1-pro-high'), { observationRemote: false })
    expect(useAgentStatus.getState().byId['agy-1'].model).toBe('gemini-3.1-pro-high')
    expect(useAgentStatus.getState().byId['agy-2'].model).toBe('gemini-3.8-flash-high')
  })

  it('T19 the model shows before any token usage exists, and nothing is invented without one', async () => {
    await act(async () => root.render(<ContextMeter sessionId="conv-1" agentId="antigravity" fallbackModel="gemini-4-argon-high" />))
    expect(host.querySelector('.ctx-pill__model')?.textContent).toBe('gemini-4-argon-high')
    // No usage read: no percentage, no bar.
    expect(host.querySelector('.ctx-pill__num')).toBeNull()
    expect(host.querySelector('.ctx-pill__bar')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="conv-1" agentId="antigravity" />))
    expect(host.textContent).toBe('')
  })

  it('T18 the profile is the custom agent the node runs as — antigravity only, never the node title', async () => {
    await act(async () => root.render(<AgentProfileChip agentId="agy-coder-particular" />))
    const chip = host.querySelector('.node-account-chip')
    expect(chip?.textContent).toBe('Antigravity Coder (Particular)')
    expect(chip?.getAttribute('title')).toContain('agy-coder-particular')
    for (const other of ['antigravity', 'claude-coder-particular', 'unknown-agent', undefined]) {
      await act(async () => root.render(<AgentProfileChip agentId={other} />))
      expect(host.textContent).toBe('')
    }
  })
})
