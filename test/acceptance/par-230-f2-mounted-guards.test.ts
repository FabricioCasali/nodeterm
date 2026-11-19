import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitLaunchAttempt } from '../../src/renderer/terminal/launch-attempt'
import { createLaunchWriter } from '../../src/renderer/terminal/launch-command'
import { executeHeldLaunch } from '../../src/renderer/terminal/launch-intent'
import { executeLaunchIntent, readPromptFileBounded, type LaunchIntentDeps } from '../../src/core/launch-intent-execute'
import { createAgentNode } from '../../src/renderer/state/workspace'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { IPC } from '../../src/shared/ipc'
import type { HeldLaunchIntent } from '../../src/shared/types'

afterEach(() => { resetPlatformForTests(); vi.restoreAllMocks() })

function setup() {
  const fake = fakePlatform()
  initPlatform(fake)
  new WorkspaceStore().registerIpc()
  return fake.handlers[IPC.workspaceClaimLaunch]
}

function viewer(claim: ReturnType<typeof setup>, client: number, condition: 'valid' | 'invalid' | 'missing' | 'old' = 'valid') {
  const node = createAgentNode('claude', 0, 'C:/repo', undefined, "it's \"quoted\" $ `tick 開発")
  node.id = 'worker'
  const command = node.data.initialCommand!
  node.data.pendingLaunch = { command, after: [], attempted: false }
  const intent = structuredClone(node.data.launchIntent!)
  if (condition === 'invalid') (intent as unknown as { intent: unknown }).intent = { kind: 'agent', action: 'unknown', agentId: 'claude' }
  if (condition === 'missing') { delete (intent.intent as { prompt?: string }).prompt; intent.promptFile = 'C:/missing/brief.md' }
  const order: string[] = []
  const host = vi.fn(async () => { order.push('effect'); if (condition === 'old') throw new Error('old-host'); return { status: 'executed' as const } })
  const deps: LaunchIntentDeps = {
    platform: 'win32', exists: (p) => p === 'C:\\fixture\\claude.exe', customAgents: () => [],
    sharedIdentityAvailable: async () => false, codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
    readPromptFile: readPromptFileBounded, execute: host, isProtocolIncompatible: (e) => String(e).includes('old-host')
  }
  let echo: ((s: string) => void) | undefined
  const write = vi.fn((s: string) => { queueMicrotask(() => echo?.(s)) })
  const writer = createLaunchWriter({
    shellReady: async () => true, killLine: '\x1b', cleanup: () => {},
    io: { write, onData: (cb) => { echo = cb; return () => { echo = undefined } } },
    claimAttempt: (manual, line) => commitLaunchAttempt({
      pending: node.data.pendingLaunch, current: () => node.data.pendingLaunch, command: line, manual,
      claim: async () => claim(client, node.id, line, manual) as Promise<'claimed' | 'elsewhere'>,
      update: (next) => { node.data.pendingLaunch = next }, save: async () => { order.push('saved-claim') }
    }),
    execute: (line) => executeHeldLaunch(line, {
      held: () => intent as HeldLaunchIntent, source: 'local', sessionHost: true,
      hostPlatform: async () => 'win32', newLaunchId: randomUUID,
      executeLaunch: (request) => executeLaunchIntent({ name: 'worker', sessionHost: true, remote: false,
        launchDialect: 'pwsh', agentId: 'claude', pathValue: 'C:\\fixture' }, request, deps)
    })
  })
  return { node, command, writer, write, host, order }
}

describe('PAR-230 F2 T10 mounted full refusal/claim chain', () => {
  it.each(['invalid', 'missing', 'old'] as const)('refuses %s after claim without POSIX fallback or Enter', async (condition) => {
    const h = viewer(setup(), 1, condition)
    expect.soft(await h.writer(h.command, false)).toBe('cancelled')
    expect.soft(h.write).not.toHaveBeenCalled()
    expect.soft(h.node.data.pendingLaunch).toMatchObject({ attempted: true, manualOnly: true })
    if (condition !== 'old') expect.soft(h.host).not.toHaveBeenCalled()
    else expect.soft(h.host).toHaveBeenCalledOnce()
  })

  it('two viewers use the real core claim ledger; duplicate calls produce one native delivery', async () => {
    const claim = setup()
    const first = viewer(claim, 11), second = viewer(claim, 12)
    // Session minting can make each factory's command differ; viewers share the same persisted node.
    second.node.data.initialCommand = first.command
    second.node.data.pendingLaunch = { command: first.command, after: [], attempted: false }
    const results = await Promise.all([first.writer(first.command, false), second.writer(first.command, false)])
    expect(results).toEqual(['submitted', 'elsewhere'])
    expect(first.order).toEqual(['saved-claim', 'effect'])
    expect(first.host).toHaveBeenCalledOnce()
    expect(second.host).not.toHaveBeenCalled()
    expect(second.write).not.toHaveBeenCalled()
    expect(second.node.data.pendingLaunch).toMatchObject({ attempted: false })
    expect(first.write).not.toHaveBeenCalled()
    expect(await first.writer(first.command, true)).toBe('submitted')
    expect(await second.writer(first.command, false)).toBe('elsewhere')
    expect(first.host).toHaveBeenCalledOnce()
  })
})
