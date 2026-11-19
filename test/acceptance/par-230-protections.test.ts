import { describe, expect, it, vi } from 'vitest'
import { deliverAgentMessage, type DeliveryDeps } from '../../src/core/agents/agent-message'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import type { MirrorEntry } from '../../src/core/agent-status-mirror'
import { readClaudeComposer, readClaudeScreen } from '../../src/shared/agents/claude-screen'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

const idle: MirrorEntry = {
  state: 'done', updatedAt: 1_000_000, stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION, agentId: 'claude', sessionId: 'session-1'
}

describe('PAR-230 T04: refusal before any write', () => {
  it.each([
    { name: 'working', entry: { ...idle, state: 'working' as const } },
    { name: 'question', entry: { ...idle, state: 'waiting' as const } },
    { name: 'approval', entry: { ...idle, state: 'blocked' as const } },
    { name: 'inferred idle without current proof', entry: { ...idle, idleInferred: true as const } },
    { name: 'old hook', entry: { ...idle, stateVerified: false, clientRevision: 1 } },
    { name: 'missing identity', entry: undefined }
  ])('$name never authorizes a write', async ({ entry }) => {
    const write = vi.fn(async () => true)
    const deps: DeliveryDeps = {
      paneOwner: async () => ({ tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }),
      bracketPasteRequested: async () => true,
      sendEnvelope: write, mirrorEntry: () => entry, tokenFilePresent: () => true,
      subscribeEvents: (cb) => {
        const timer = setTimeout(() => cb({ nodeId: 'worker', newTurn: true, verified: true }), 0)
        return () => clearTimeout(timer)
      },
      lock: async (_id, fn) => fn(), now: () => 1_000_000,
      trace: async () => ({ traceId: 'refused', traced: 'memory' })
    }
    const result = await deliverAgentMessage({ targetNodeId: 'worker', sourceNodeId: 'sender', sourceTitle: 'Sender', body: 'task', targetAgentId: 'claude' }, deps)
    expect(result.kind).not.toBe('delivered')
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['shell', 'unreadable'] as const)('a %s pane never authorizes a write', async (pane) => {
    const write = vi.fn(async () => true)
    const deps: DeliveryDeps = {
      paneOwner: async () => pane === 'unreadable' ? null : ({ tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'bash', argv: ['bash'], pids: [100] }),
      bracketPasteRequested: async () => true,
      sendEnvelope: write, mirrorEntry: () => idle, tokenFilePresent: () => true,
      subscribeEvents: (cb) => {
        const timer = setTimeout(() => cb({ nodeId: 'worker', newTurn: true, verified: true }), 0)
        return () => clearTimeout(timer)
      },
      lock: async (_id, fn) => fn(), now: () => 1_000_000,
      trace: async () => ({ traceId: 'refused', traced: 'memory' })
    }
    const result = await deliverAgentMessage({ targetNodeId: 'worker', sourceNodeId: 'sender', sourceTitle: 'Sender', body: 'task', targetAgentId: 'claude' }, deps)
    expect(result.kind).toBe(pane === 'unreadable' ? 'targetPaneUnreadable' : 'targetNotAgentPane')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('PAR-230 T01/T04: captured Claude composer evidence', () => {
  it('distinguishes a free composer from drafts and shell input in the captured CLI', () => {
    expect(readClaudeComposer(captured.screens.empty)).toBe('empty')
    for (const screen of [captured.screens.draft, captured.screens.multiline, captured.screens.pasted, captured.screens.shellmode]) {
      expect(readClaudeComposer(screen)).toBe('draft')
    }
  })

  it('a visible composer is not positive evidence of idle', () => {
    const rule = '─'.repeat(100)
    const working = ['⏺ Bash(sleep 20)', '✻ Working… (12s · esc to interrupt)', rule,
      '❯ first line of a queued message', '  second line', rule, '  ? for shortcuts'].join('\n')
    expect(readClaudeScreen(working)).toEqual({ kind: 'prompt' })
  })
})
