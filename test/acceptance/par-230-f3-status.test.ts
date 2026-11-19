import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAntigravity, normalizeCodex, type NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import {
  _resetForTest,
  DONE_HOLDOFF_MS,
  mirrorEntry,
  reaffirmIsStale,
  recordAgentEvent
} from '../../src/core/agent-status-mirror'
import { listControlNodes } from '../../src/core/canvas-control-core'
import { StationHandoverTracker } from '../../src/core/station-handover'
import { buildCodexWindowsWrapper } from '../../src/core/agents/hooks/codex-windows-wrapper'
import { createStationLiveness } from '../../src/core/agent-liveness'
import { antigravityBackgroundWork, cardBadge } from '../../src/renderer/lib/kanbanStatusChips'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'

beforeEach(() => { initPlatform(fakePlatform()); _resetForTest() })
afterEach(() => { vi.useRealTimers(); _resetForTest(); resetPlatformForTests() })

const codex = (event: string, extra: Record<string, unknown> = {}) =>
  normalizeCodex({ nodeId: 'codex', agentId: 'codex', payload: { hook_event_name: event, session_id: 's1', ...extra } })
const agy = (event: string, extra: Record<string, unknown> = {}) =>
  normalizeAntigravity({ nodeId: 'agy', agentId: 'antigravity',
    payload: { nodeterm_hook_event: event, conversationId: 'c1', ...extra } })
/** What both shells do with an event: drop a stale reassertion, else record it as verified. */
const feed = (ev: NormalizedAgentEvent | null): void => {
  if (!ev || reaffirmIsStale(ev)) return
  recordAgentEvent({ ...ev, verified: true })
}
const row = async (id: string, agentId: string): Promise<string> =>
  (await listControlNodes('src', {}, {
    projects: () => [{ id: 'p', nodes: [{ id: 'src', kind: 'terminal', title: 'src', agentId: 'claude' },
      { id, kind: 'terminal', title: id, agentId }] }],
    statusOf: mirrorEntry, capture: async () => '', now: Date.now
  })).message.split('\n').find((line) => line.startsWith(id)) ?? ''

describe('PAR-230 F3 · PAR-174 codex on Windows', () => {
  it('T16 the Windows wrapper has no env gate: a daemon-run hook reaches codex.sh, which resolves the thread', () => {
    const wrapper = buildCodexWindowsWrapper()
    expect(wrapper).not.toContain('if not defined NODETERM_NODE_ID')
    expect(wrapper).not.toContain('CODEX_THREAD_ID')
    // Still drains and exits 0 with no shell or no script.
    expect(wrapper).toContain('if not defined NT_SH goto :nt_drain')
    expect(wrapper.trimEnd().endsWith('exit /b 0')).toBe(true)
  })

  it('T16 SessionStart is a session boundary: a codex opened with no prompt is not WORKING', async () => {
    expect(codex('SessionStart')).toMatchObject({ kind: 'session', sessionPhase: 'start', sessionId: 's1' })
    feed(codex('SessionStart'))
    expect(mirrorEntry('codex')?.state).toBeUndefined()
    expect(await row('codex', 'codex')).not.toContain('WORKING')
  })

  it('T16 real turns still move it: prompt and tools are WORKING, Stop is IDLE', async () => {
    feed(codex('SessionStart'))
    feed(codex('UserPromptSubmit'))
    expect(await row('codex', 'codex')).toContain('WORKING')
    feed(codex('PostToolUse', { tool_name: 'shell' }))
    expect(mirrorEntry('codex')?.state).toBe('working')
    feed(codex('Stop'))
    expect(await row('codex', 'codex')).toContain('IDLE')
  })

  it('a verified SessionStart confirms the launch that produced it (no state needed)', () => {
    feed(codex('SessionStart'))
    const started = mirrorEntry('codex')!.sessionStarted!.at
    const liveness = createStationLiveness({
      now: () => started, mirrorEntries: () => [['codex', mirrorEntry('codex')!]],
      launches: () => [{ nodeId: 'codex', launchId: 'l1', agentId: 'codex', at: started }],
      paneOwner: async () => null, customAgents: () => [], deliberateExitAt: () => undefined, setLifecycle: () => {}
    })
    expect(liveness.attempts()[0]).toMatchObject({ attemptId: 'l1', confirmed: true })
  })
})

describe('PAR-230 F3 · PAR-177 antigravity background work', () => {
  it('T17 Stop fullyIdle:false is WORKING (background) in list and on the card, never a clean IDLE', async () => {
    feed(agy('PreInvocation', { invocationNum: 0 }))
    feed(agy('Stop', { fullyIdle: false }))
    expect(mirrorEntry('agy')).toMatchObject({ state: 'done', backgroundWork: true })
    expect(await row('agy', 'antigravity')).toContain('WORKING (background)')
    const status = { unread: false, state: 'done' as const, agentId: 'antigravity' as const, backgroundTaskAt: 1 }
    expect(antigravityBackgroundWork(status)).toBe(true)
    expect(cardBadge('terminal', status)).toBe('running')
    // Claude and Codex keep their own background semantics.
    expect(cardBadge('terminal', { ...status, agentId: 'claude' })).toBeNull()
  })

  it('T17 the wake-up turn and a Stop fullyIdle:true end it; a Stop with no field leaves it standing', async () => {
    feed(agy('PreInvocation', { invocationNum: 0 }))
    feed(agy('Stop', { fullyIdle: false }))
    feed(agy('Stop', {}))
    expect(mirrorEntry('agy')?.backgroundWork).toBe(true)
    feed(agy('PreInvocation', { invocationNum: 0 }))
    expect(mirrorEntry('agy')?.backgroundWork).toBeUndefined()
    feed(agy('Stop', { fullyIdle: true }))
    expect(await row('agy', 'antigravity')).toContain('IDLE')
  })

  it('T17 a plain --after hold waits for the background work, and is released by the empty inventory', () => {
    let now = 1000
    const tracker = new StationHandoverTracker(() => {}, () => now)
    const at = (ev: NormalizedAgentEvent | null): void => { now += 10; if (ev) tracker.onAgentEvent({ ...ev, verified: true }) }
    tracker.markHandedOver('agy', now)
    at(agy('PreInvocation', { invocationNum: 0 }))
    at(agy('Stop', { fullyIdle: false }))
    expect(tracker.isHandedOver('agy')).toBe(true)
    at(agy('PreInvocation', { invocationNum: 0 }))
    at(agy('Stop', { fullyIdle: true }))
    expect(tracker.isHandedOver('agy')).toBe(false)
  })

  it('T17 every tool reasserts WORKING — it lights a node whose turn-start hook was lost', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    feed(agy('Stop', { fullyIdle: true }))
    expect(mirrorEntry('agy')?.state).toBe('done')
    // Past the mirror's done-holdoff (a non-newTurn `working` right behind a `done` is a late
    // echo of the turn that just ended, for every agent).
    vi.setSystemTime(1_000_000 + DONE_HOLDOFF_MS + 1)
    feed(agy('PostToolUse', { toolCall: { name: 'run_command' } }))
    expect(mirrorEntry('agy')?.state).toBe('working')
  })

  it('T17 a reassertion never ends a pending question, and never relights a turn that left background work', () => {
    const ping = agy('PostToolUse', { toolCall: { name: 'run_command' } })!
    expect(ping).toMatchObject({ state: 'working', reaffirm: true })
    feed(agy('PreInvocation', { invocationNum: 0 }))
    feed(agy('PreToolUse', { toolCall: { name: 'ask_question', args: { questions: [{ question: 'Qual escopo?' }] } } }))
    expect(mirrorEntry('agy')?.state).toBe('waiting')
    expect(reaffirmIsStale(ping)).toBe(true)
    feed(ping)
    expect(mirrorEntry('agy')?.state).toBe('waiting')
    // The ask's own answer is what ends it.
    feed(agy('PostToolUse', { toolCall: { name: 'ask_question' } }))
    expect(mirrorEntry('agy')?.state).toBe('working')
    expect(reaffirmIsStale(ping)).toBe(false)
    feed(agy('Stop', { fullyIdle: false }))
    expect(reaffirmIsStale(ping)).toBe(true)
    feed(ping)
    expect(mirrorEntry('agy')?.state).toBe('done')
  })
})
