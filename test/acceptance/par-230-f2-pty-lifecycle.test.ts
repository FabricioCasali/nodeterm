import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { PtyManager } from '../../src/core/pty-manager'
import { launchHeadless } from '../../src/core/headless-launch'

const backend = vi.hoisted(() => ({ create: vi.fn(), kill: vi.fn(async () => {}) }))
vi.mock('../../src/core/session-host-backend', async (original) => ({
  ...(await original<typeof import('../../src/core/session-host-backend')>()),
  sessionHostSupported: () => true,
  createSessionHostPty: backend.create,
  sessionHostKillSession: backend.kill,
  sessionHostHasSession: async () => false
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('unexpected direct machine spawn') }) }))
vi.mock('../../src/core/pty-devices', async (original) => ({
  ...(await original<typeof import('../../src/core/pty-devices')>()), readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

let manager: PtyManager | undefined
beforeEach(() => { initPlatform(fakePlatform()); backend.create.mockReset(); backend.kill.mockClear() })
afterEach(async () => { await manager?.killAll(); manager = undefined; resetPlatformForTests(); vi.restoreAllMocks(); vi.useRealTimers() })

function shim(ready = Promise.resolve({ fresh: true })) {
  return { ready, onSize: vi.fn(), onData: vi.fn(), onExit: vi.fn(), onAttachError: vi.fn(),
    write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), destroy: vi.fn() }
}

describe('PAR-230 F2 T15 real PtyManager lifecycle with an isolated host transport', () => {
  it('releasing a persistent headless client detaches it and leaves the host session alive', async () => {
    const proc = shim()
    backend.create.mockReturnValue(proc)
    manager = new PtyManager({ runtimePlatform: 'win32' })
    expect(await manager.createHeadless({ cols: 80, rows: 24, persistKey: 'worker', shell: 'pwsh.exe' })).toMatchObject({ persistent: true })
    manager.releaseHeadless('worker')
    expect(proc.destroy).toHaveBeenCalledOnce()
    expect(proc.kill).not.toHaveBeenCalled()
    expect(backend.kill).not.toHaveBeenCalled()
    expect(manager.writeHeadless('worker', 'forbidden after release')).toBe(false)
  })

  it('explicit close waits for the host acknowledgement and retires the exact node', async () => {
    const proc = shim()
    backend.create.mockReturnValue(proc)
    manager = new PtyManager({ runtimePlatform: 'win32' })
    await manager.createHeadless({ cols: 80, rows: 24, persistKey: 'worker', shell: 'pwsh.exe' })
    const ended = vi.fn()
    const off = manager.onSessionEnded(ended)
    let acknowledge!: () => void
    backend.kill.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve }))
    const closing = manager.destroySession(0, 'worker')
    await vi.waitFor(() => expect(backend.kill).toHaveBeenCalledOnce())
    expect(ended).not.toHaveBeenCalled()
    acknowledge()
    await closing
    expect(ended).toHaveBeenCalledWith('worker')
    expect(manager.writeHeadless('worker', 'after close')).toBe(false)
    off()
  })

  it('an attach refused after provisional spawn destroys its transport and publishes no live headless client', async () => {
    let reject!: (error: Error) => void
    const proc = shim(new Promise((_resolve, rejectReady) => { reject = rejectReady }))
    backend.create.mockReturnValue(proc)
    manager = new PtyManager({ runtimePlatform: 'win32' })
    const spawning = manager.createHeadless({ cols: 80, rows: 24, persistKey: 'worker', shell: 'pwsh.exe' })
    const refused = expect(spawning).rejects.toThrow('refused after spawn')
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledOnce())
    reject(new Error('refused after spawn'))
    await refused
    expect(proc.destroy).toHaveBeenCalledOnce()
    expect(manager.writeHeadless('worker', 'after refused spawn')).toBe(false)
    expect(backend.kill).not.toHaveBeenCalled()
  })

  it('a headless refusal after spawn releases its persistent client without killing the detached session', async () => {
    const proc = shim(Promise.resolve({ fresh: false }))
    backend.create.mockReturnValue(proc)
    manager = new PtyManager({ runtimePlatform: 'win32' })
    vi.spyOn(manager, 'paneCommand').mockResolvedValue('codex')
    const result = await launchHeadless(manager, { command: 'claude literal',
      ptyOptions: { cols: 80, rows: 24, persistKey: 'worker', shell: 'pwsh.exe' }, release: true, requirePersistent: true })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'no-shell' })
    expect(proc.write).not.toHaveBeenCalled()
    expect(proc.destroy).toHaveBeenCalledOnce()
    expect(backend.kill).not.toHaveBeenCalled()
  })
})
