import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchHeadless, desktopHeadlessRequest } from '../../src/core/headless-launch'
import { PtyManager } from '../../src/core/pty-manager'
import { readPromptFileBounded } from '../../src/core/launch-intent-execute'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { testTmpDir } from '../../src/core/test-tmp'
import type { LaunchIntentRequest } from '../../src/shared/types'
import { createAgentNode, flowToNodeStates } from '../../src/renderer/state/workspace'
import { startHeadless } from '../../src/renderer/lib/headlessRun'

vi.mock('child_process', () => ({
  execFile: (_f: string, _a: string[], a?: unknown, b?: unknown) => {
    const cb = (typeof a === 'function' ? a : b) as ((e: Error | null, r?: unknown) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' }); return {}
  },
  execFileSync: () => ''
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('unexpected machine spawn') }) }))
const host = vi.hoisted(() => ({ execute: vi.fn(async (_name: string, _id: string, _plan: unknown) => ({ status: 'executed' })) }))
vi.mock('../../src/core/session-host-backend', async (original) => ({
  ...(await original<typeof import('../../src/core/session-host-backend')>()),
  sessionHostExecuteLaunch: host.execute
}))

beforeEach(() => { vi.useFakeTimers(); host.execute.mockReset().mockResolvedValue({ status: 'executed' }); initPlatform(fakePlatform()) })
afterEach(() => { vi.useRealTimers(); resetPlatformForTests(); vi.restoreAllMocks() })

function harness(options: { model?: string; custom?: boolean; missing?: boolean; invalid?: boolean; oldHost?: boolean } = {}) {
  const directory = testTmpDir('par230-f2-core-headless-')
  const promptFile = path.join(directory, "brief ' ação.md")
  if (!options.missing) writeFileSync(promptFile, 'Ação "literal" $env:HOME `tick\n開発')
  const agentId = options.custom ? 'custom:fixture' : 'claude'
  const executable = 'C:\\fixture\\claude.exe'
  const command = `claude "$(cat '${promptFile}')"`
  const held = { command, promptFile, intent: {
    kind: 'agent' as const, action: 'start' as const, agentId,
    ...(options.model ? { model: options.model } : {}), ...(options.invalid ? { action: 'forged' } : {})
  } }
  const manager = new PtyManager({ runtimePlatform: 'win32' })
  const internal = manager as unknown as {
    sessions: Map<string, unknown>; byPersistKey: Map<string, string>; launchIntentDepsOverride: Record<string, unknown>
  }
  internal.sessions.set('s1', { persistKey: 'worker', indexKey: 'worker', sessionHost: true,
    launchDialect: 'pwsh', launchAgentId: agentId, launchPath: 'C:\\fixture' })
  internal.byPersistKey.set('worker', 's1')
  internal.launchIntentDepsOverride = {
    customAgents: () => options.custom ? [{ id: agentId, launchCmd: executable, promptInjectionMode: 'argv', baseAgent: 'claude' }] : [],
    sharedIdentityAvailable: async () => false, codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
    exists: (p: string) => p === executable, readPromptFile: readPromptFileBounded
  }
  if (options.oldHost) host.execute.mockRejectedValue(new Error('old host refuses executeLaunch'))
  const listeners = new Set<(data: string) => void>()
  const writes: string[] = []
  const execute = vi.spyOn(manager, 'executeLaunch')
  const deps = {
    persistentSpawnAvailable: () => true,
    createHeadless: vi.fn(async () => ({ sessionId: 's1', fresh: true, persistent: true, sessionHost: true })),
    paneCommand: vi.fn(async () => 'pwsh'),
    writeHeadless: vi.fn((_key: string, data: string) => { writes.push(data); for (const cb of listeners) cb(data); return true }),
    onOutput: (_key: string, cb: (data: string) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    releaseHeadless: vi.fn(),
    executeLaunch: (key: string, request: LaunchIntentRequest) => manager.executeLaunch(key, request)
  }
  const request = { ptyOptions: { cols: 80, rows: 24, persistKey: 'worker', agentId, shell: 'pwsh.exe' }, command,
    launchIntent: held, release: true, requirePersistent: true }
  return { deps, request, execute, writes, listeners }
}

describe('PAR-230 F2 core headless → real PtyManager → real executor/planner', () => {
  it.each([false, true])('T09/T20 renderer factory → startHeadless → Desktop adapter → core → PtyManager; model=%s', async (withModel) => {
    const h = harness()
    const flow = createAgentNode('claude', 0, 'C:/repo', undefined, undefined, undefined,
      undefined, undefined, undefined, withModel ? 'opus' : undefined, h.request.launchIntent.promptFile)
    flow.id = 'worker'
    flow.data.pendingLaunch = { command: flow.data.initialCommand!, after: [], attempted: false }
    const node = { ...flowToNodeStates([flow])[0], launchIntent: flow.data.launchIntent }
    const order: string[] = []
    const d = {
      inFlight: new Set<string>(), savePending: vi.fn(async (_id: string, pending: unknown) => { order.push(pending ? 'claim' : 'clear'); return true }),
      markStarting: vi.fn(), markFailed: vi.fn(), clearDelivery: vi.fn(),
      launch: (request: Parameters<typeof desktopHeadlessRequest>[0]) => { order.push('core'); return launchHeadless(h.deps, desktopHeadlessRequest(request)) }
    }
    const pending = startHeadless(d, { project: { id: 'cold', cwd: 'C:/repo' }, node })
    await vi.runAllTimersAsync()
    expect.soft(await pending).toMatchObject({ started: true })
    expect.soft(order).toEqual(['claim', 'core', 'clear'])
    expect.soft(h.execute).toHaveBeenCalledOnce()
    expect.soft(host.execute).toHaveBeenCalledOnce()
    expect.soft(h.writes).toEqual([])
    expect.soft(d.inFlight.size).toBe(0)
  })

  it.each([{ label: 'promptFile', options: {} }, { label: 'model and promptFile', options: { model: 'opus' } },
    { label: 'machine-local custom config', options: { custom: true } }])('T09/T20 executes $label without typing its POSIX twin', async ({ options }) => {
    const h = harness(options)
    const pending = launchHeadless(h.deps, h.request)
    await vi.runAllTimersAsync()
    const result = await pending
    expect.soft(result).toMatchObject({ outcome: 'delivered' })
    expect.soft(h.execute).toHaveBeenCalledOnce()
    expect.soft(host.execute).toHaveBeenCalledOnce()
    expect.soft(h.writes).toEqual([])
    expect.soft(h.deps.releaseHeadless).toHaveBeenCalledWith('worker')
    expect.soft(h.listeners.size).toBe(0)
    expect.soft(vi.getTimerCount()).toBe(0)
  })

  it.each([{ label: 'missing prompt file', options: { missing: true } }, { label: 'invalid intent', options: { invalid: true } },
    { label: 'old host refusal', options: { oldHost: true } }])('T10 refuses $label without a second textual launch', async ({ options }) => {
    const h = harness(options)
    const pending = launchHeadless(h.deps, h.request)
    await vi.runAllTimersAsync()
    expect.soft(await pending).toMatchObject({ outcome: 'failed' })
    expect.soft(h.execute).toHaveBeenCalledOnce()
    expect.soft(h.writes).toEqual([])
    if (!options.oldHost) expect.soft(host.execute).not.toHaveBeenCalled()
    expect.soft(h.deps.releaseHeadless).toHaveBeenCalledWith('worker')
    expect.soft(h.listeners.size).toBe(0)
    expect.soft(vi.getTimerCount()).toBe(0)
  })

  it('T20 Desktop adapter preserves the semantic request and strips transport authority', () => {
    const h = harness()
    const wire = { ...h.request, ptyOptions: { ...h.request.ptyOptions, viewerId: 'other', clearEnv: true,
      requireRemote: true, sshRemote: { controlPath: '/foreign' } }, release: false, requirePersistent: false }
    const adapted = desktopHeadlessRequest(wire as never)
    expect.soft(adapted).toHaveProperty('launchIntent', h.request.launchIntent)
    expect.soft(adapted).toMatchObject({ release: true, requirePersistent: true, ptyOptions: { requireRemote: true } })
    expect.soft(adapted.ptyOptions.viewerId).toBeUndefined()
    expect.soft(adapted.ptyOptions.clearEnv).toBeUndefined()
    expect.soft(adapted.ptyOptions.sshRemote).toBeUndefined()
  })

  it('T09 harness control reaches the real executor when called directly', async () => {
    const h = harness()
    const response = await h.deps.executeLaunch('worker', { launchId: randomUUID(),
      intent: { kind: 'agent', action: 'start', agentId: 'claude', prompt: 'literal' } })
    expect(response).toEqual({ ok: true })
    expect(host.execute).toHaveBeenCalledOnce()
  })

  it('T09 custom harness control resolves its exact current config through the real executor', async () => {
    const h = harness({ custom: true })
    expect(await h.deps.executeLaunch('worker', { launchId: randomUUID(),
      intent: { kind: 'agent', action: 'start', agentId: 'custom:fixture' }, promptFile: h.request.launchIntent.promptFile
    })).toEqual({ ok: true })
    expect(host.execute).toHaveBeenCalledOnce()
  })
})
