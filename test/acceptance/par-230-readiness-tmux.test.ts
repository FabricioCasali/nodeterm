import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

const calls = vi.hoisted(() => [] as string[][])
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (_file: string, _args: string[], a?: unknown, b?: unknown) => {
    const cb = (typeof a === 'function' ? a : b) as ((error: null, output: { stdout: string; stderr: string }) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' })
    return {}
  }
  Object.assign(execFile, { [promisify.custom]: (file: string, args: string[]) => {
    calls.push([file, ...args])
    return Object.assign(Promise.resolve({ stdout: '', stderr: '' }), { child: { stdin: { on: () => {}, end: () => {} } } })
  } })
  return { execFile, execFileSync: () => '' }
})
vi.mock('../../src/core/exec-path', async (original) => ({
  ...(await original<typeof import('../../src/core/exec-path')>()),
  findExecutableSync: (bin: string) => bin === 'ssh' ? '/usr/bin/ssh' : null
}))
vi.mock('../../src/core/session-host-backend', async () => (await import('../../src/core/__fixtures__/no-session-host')).noSessionHost())
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('Unexpected spawn') } }))

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
interface Manager {
  agentByKey: Map<string, string>
  tmuxPath: string | null
  liveSessionForPersistKey(id: string): unknown
  sessionByPersistKey(id: string): unknown
  sessionOfNode(id: string): string | undefined
  paneOwner(id: string): Promise<PaneOwner | null>
  captureSession(id: string): Promise<string>
  captureVisible(id: string): Promise<{ screen: string; cursor: null }>
  sendEnvelope(id: string, body: string, owner?: PaneOwner, guard?: Guard): Promise<boolean | 'dialog'>
}
let PtyManager: typeof import('../../src/core/pty-manager').PtyManager
beforeAll(async () => { ({ PtyManager } = await import('../../src/core/pty-manager')) })
beforeEach(() => { vi.stubEnv('NODETERM_NATIVE_SSH', '0'); initPlatform(fakePlatform()); vi.useFakeTimers(); calls.length = 0 })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); resetPlatformForTests(); vi.unstubAllEnvs() })
const owner: PaneOwner = { panePid: 10, paneId: '%1', tty: '/dev/pts/1', command: 'claude', argv: ['claude'], pids: [20] }
const body = '--- NODETERM MESSAGE nonce ---\nbody\n--- END NODETERM MESSAGE nonce ---'

function fixture(ssh: boolean) {
  const manager = new PtyManager() as unknown as Manager
  manager.agentByKey.set('worker', 'claude')
  manager.tmuxPath = '/usr/bin/tmux'
  const live = ssh ? { sshRemote: { conn: { host: 'isolated.invalid', user: 'tester' }, controlPath: '/unused/cm.sock' } } : {}
  manager.liveSessionForPersistKey = () => live
  manager.sessionByPersistKey = () => live
  manager.sessionOfNode = () => 'test-session'
  manager.paneOwner = async () => owner
  let reads = 0
  const screen = () => reads++ === 0 ? captured.screens.empty : captured.screens.draft.replace('heb ik getest', body.split('\n').join('\n  '))
  manager.captureSession = async () => screen()
  manager.captureVisible = async () => ({ screen: screen(), cursor: null })
  return manager
}

for (const ssh of [false, true]) describe(`PAR-230 R3/R4/R5 ${ssh ? 'SSH' : 'local tmux'} isolated adapter`, () => {
  it('R6 control: existing unguarded envelope reaches the simulated transport', async () => {
    const manager = fixture(ssh)
    const send = manager.sendEnvelope('worker', body, owner)
    await vi.runAllTimersAsync()
    expect(await send).toBe(true)
    expect(calls.some((call) => call.join(' ').includes('paste-buffer'))).toBe(true)
  })

  it('invokes beforePaste and refuses before sending bytes', async () => {
    const manager = fixture(ssh)
    const guard: Guard = { beforePaste: vi.fn(() => false), beforeSubmit: vi.fn(() => true) }
    const send = manager.sendEnvelope('worker', body, owner, guard)
    await vi.runAllTimersAsync()
    await send
    expect(guard.beforePaste).toHaveBeenCalledTimes(1)
    expect(calls.filter((call) => call.join(' ').includes('paste-buffer') || call.includes('Enter'))).toEqual([])
  })

  it('withholds Enter after paste when beforeSubmit refuses', async () => {
    const manager = fixture(ssh)
    const guard: Guard = { beforePaste: vi.fn(() => true), beforeSubmit: vi.fn(() => false) }
    const send = manager.sendEnvelope('worker', body, owner, guard)
    await vi.runAllTimersAsync()
    expect(await send).toBe(true)
    expect(guard.beforePaste).toHaveBeenCalledTimes(1)
    expect(guard.beforeSubmit).toHaveBeenCalledTimes(1)
    const writes = calls.filter((call) => /paste-buffer|Enter/.test(call.join(' ')))
    expect(writes).toHaveLength(1)
    expect(writes[0].join(' ')).toContain('paste-buffer')
    expect(writes[0].join(' ')).not.toContain('Enter')
    expect(writes[0][0]).toBe(ssh ? '/usr/bin/ssh' : '/usr/bin/tmux')
  })
})
