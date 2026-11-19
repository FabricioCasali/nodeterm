import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverAgentMessage, type DeliveryDeps, type DeliveryRequest, type ReceiptEvent } from '../../src/core/agents/agent-message'
import { RETRYABLE } from '../../src/core/agents/agent-message-decide'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import { reduceEntry, type MirrorEntry } from '../../src/core/agent-status-mirror'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
type GuardedSend = (...args: [...Parameters<DeliveryDeps['sendEnvelope']>, guard?: Guard]) => ReturnType<DeliveryDeps['sendEnvelope']>
type GuardedDeps = DeliveryDeps & { envelopeGuardSupported?: (id: string) => Promise<boolean> }
const owner: PaneOwner = { panePid: 10, paneId: '%1', tty: '/dev/pts/1', command: 'claude', argv: ['claude'], pids: [20] }
const request: DeliveryRequest = { sourceNodeId: 'sender', sourceTitle: 'Sender', targetNodeId: 'worker', targetAgentId: 'claude', body: 'task\nline two\x1b[201~' }
const event = (over: Partial<NormalizedAgentEvent>): NormalizedAgentEvent => ({ nodeId: 'worker', agentId: 'claude', sessionId: 'session-1', kind: 'state', verified: true, clientRevision: MANAGED_SCRIPT_REVISION, ...over })

function inferred() {
  const working = reduceEntry(undefined, event({ state: 'working', newTurn: true }), 999_000)
  return reduceEntry(working, event({ state: 'done', idle: true }), 1_000_000)
}

function harness() {
  let entry: MirrorEntry | undefined = inferred()
  let screen = captured.screens.empty
  let emit: (event: ReceiptEvent) => void = () => {}
  const pasted: string[] = []
  const submitted: string[] = []
  const checks: boolean[] = []
  let beforePaste = () => {}
  let beforeSubmit = () => {}
  const send: GuardedSend = async (_id, body, _owner, guard) => {
    beforePaste()
    if (guard) {
      checks.push(guard.beforePaste(screen))
      if (!checks.at(-1)) return 'dialog'
    }
    pasted.push(body)
    screen = captured.screens.draft.replace('heb ik getest', body.split('\n').join('\n  '))
    beforeSubmit()
    if (guard) {
      checks.push(guard.beforeSubmit(screen))
      if (!checks.at(-1)) return true
    }
    submitted.push(body)
    emit({ nodeId: 'worker', newTurn: true, verified: true })
    return true
  }
  const sender = vi.fn(send)
  const deps: GuardedDeps = {
    paneOwner: async () => owner, bracketPasteRequested: async () => true,
    sendEnvelope: sender, envelopeGuardSupported: async () => true,
    mirrorEntry: () => entry, tokenFilePresent: () => true,
    lock: async (_id, fn) => fn(), now: Date.now,
    trace: async () => ({ traceId: 'readiness', traced: 'memory' }),
    subscribeEvents: (listener) => { emit = listener; return () => { emit = () => {} } }
  }
  return { deps, sender, pasted, submitted, checks,
    get entry() { return entry },
    set entry(value: MirrorEntry | undefined) { entry = value },
    set screen(value: string) { screen = value },
    atPaste(fn: () => void) { beforePaste = fn },
    atSubmit(fn: () => void) { beforeSubmit = fn }
  }
}

async function run(h: ReturnType<typeof harness>, req = request) {
  const pending = deliverAgentMessage(req, h.deps)
  await vi.runAllTimersAsync()
  return pending
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('PAR-230 R1–R4: verified idle event and per-attempt core guard', () => {
  it('R1 delivers once, exercises both backend callbacks and leaves the mirror inferred', async () => {
    const h = harness()
    expect(h.entry).toMatchObject({ state: 'done', stateVerified: true, idleInferred: true, sessionId: 'session-1' })
    const original = { ...h.entry }
    expect((await run(h)).kind).toBe('delivered')
    expect(h.sender).toHaveBeenCalledTimes(1)
    expect(h.checks).toEqual([true, true])
    expect(h.pasted).toHaveLength(1)
    expect(h.submitted).toEqual(h.pasted)
    expect(h.pasted[0]).not.toContain('\x1b')
    expect(h.entry).toEqual(original)
  })

  it.each(['draft', 'multiline', 'pasted', 'shellmode'] as const)('R2 refuses captured %s before paste', async (name) => {
    const h = harness()
    h.screen = captured.screens[name]
    expect((await run(h)).kind).not.toBe('delivered')
    expect(h.pasted).toEqual([])
    expect(h.submitted).toEqual([])
  })

  it.each([
    '', 'unreadable output',
    ['─'.repeat(81), ' Accessing workspace:', ' ~/project', ' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')
  ])('R2 refuses unavailable or dialog screen %#', async (screen) => {
    const h = harness()
    h.screen = screen
    await run(h)
    expect(h.pasted).toEqual([])
    expect(h.submitted).toEqual([])
  })

  it.each([
    { state: 'working' as const }, { state: 'blocked' as const }, { state: 'waiting' as const },
    { pendingQuestion: { sessionId: 'session-1', toolUseId: 'question-1' } },
    { pendingAsk: { kind: 'question' as const, since: 999_000, id: 'ask-1' } },
    { concurrentApprovalIds: ['approval-1'] },
    { restored: true as const }, { stateExpired: true as const }, { stateVerified: false },
    { clientRevision: 1 }, { sessionId: undefined }, { agentId: 'codex' as const }
  ])('R2 preserves refusal for %j', async (change) => {
    const h = harness()
    h.entry = { ...h.entry!, ...change }
    expect((await run(h)).kind).not.toBe('delivered')
    expect(h.pasted).toEqual([])
    expect(h.submitted).toEqual([])
  })

  it.each(['absent', 'false'] as const)('R2/R5 refuses %s guard support without invoking transport', async (support) => {
    const h = harness()
    if (support === 'absent') delete h.deps.envelopeGuardSupported
    else h.deps.envelopeGuardSupported = async () => false
    await run(h)
    expect(h.sender).not.toHaveBeenCalled()
    expect(h.pasted).toEqual([])
  })

  it('R2 preserves missing-token refusal', async () => {
    const h = harness()
    h.deps.tokenFilePresent = () => false
    await run(h)
    expect(h.sender).not.toHaveBeenCalled()
  })

  it.each(['codex', 'antigravity'] as const)('R2 does not extend recovery to %s', async (agentId) => {
    const h = harness()
    h.entry = { ...h.entry!, agentId }
    await run(h, { ...request, targetAgentId: agentId })
    expect(h.sender).not.toHaveBeenCalled()
  })

  it.each(['self-send', 'permission'] as const)('R2 keeps %s ahead of readiness', async (gate) => {
    const h = harness()
    await run(h, { ...request, ...(gate === 'self-send' ? { sourceNodeId: 'worker' } : { notPermitted: 'switch-off' as const }) })
    expect(h.sender).not.toHaveBeenCalled()
  })

  it.each(['working', 'session', 'draft'] as const)('R3 revalidates %s inside beforePaste', async (change) => {
    const h = harness()
    h.atPaste(() => {
      if (change === 'draft') h.screen = captured.screens.draft
      else h.entry = { ...h.entry!, ...(change === 'session' ? { sessionId: 'session-2' } : { state: 'working' as const }) }
    })
    await run(h)
    expect(h.checks).toEqual([false])
    expect(h.pasted).toEqual([])
    expect(h.submitted).toEqual([])
  })

  it.each(['working', 'approval', 'question', 'session', 'edited', 'unreadable'] as const)('R4 withholds Enter after %s and reports non-retryable partial', async (change) => {
    const h = harness()
    h.atSubmit(() => {
      if (change === 'edited') h.screen = captured.screens.draft
      else if (change === 'unreadable') h.screen = ''
      else h.entry = { ...h.entry!, ...(change === 'session' ? { sessionId: 'session-2' } : { state: change === 'approval' ? 'blocked' as const : change === 'question' ? 'waiting' as const : 'working' as const }) }
    })
    const out = await run(h)
    expect(h.checks).toEqual([true, false])
    expect(h.pasted).toHaveLength(1)
    expect(h.submitted).toEqual([])
    expect(out.kind).toBe('stalled')
    expect(RETRYABLE[out.kind]).toBe(false)
  })

  it('R6 keeps ordinary verified done usable without the new capability', async () => {
    const h = harness()
    h.entry = reduceEntry(h.entry, event({ state: 'done', idle: false }), 1_000_000)
    delete h.deps.envelopeGuardSupported
    expect((await run(h)).kind).toBe('delivered')
    expect(h.submitted).toHaveLength(1)
  })
})
