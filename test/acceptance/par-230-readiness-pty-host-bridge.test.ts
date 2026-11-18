import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { sessionName } from '../../src/core/tmux-naming'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'

const host = vi.hoisted(() => ({ send: vi.fn(async (..._args: unknown[]) => true) }))
vi.mock('../../src/core/session-host-backend', async (original) => ({
  ...(await original<typeof import('../../src/core/session-host-backend')>()),
  sessionHostMessageEnvelope: host.send,
  sessionHostSupported: () => true,
  sessionHostEnvelopeGuardSupported: () => true
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('PTY spawn forbidden in bridge test') }) }))

beforeEach(() => { initPlatform(fakePlatform()); host.send.mockClear() })
afterEach(() => { resetPlatformForTests() })

describe('PAR-230 R6 actual PtyManager host routing', () => {
  it.each(['attached', 'released'] as const)('propagates the guard through a %s host generation', async (state) => {
    const { PtyManager } = await import('../../src/core/pty-manager')
    const manager = new PtyManager() as unknown as {
      sessions: Map<string, unknown>; released: Map<string, unknown>; byPersistKey: Map<string, string>
      sendEnvelope(id: string, body: string, owner: PaneOwner, guard?: { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }): Promise<boolean>
    }
    if (state === 'attached') {
      manager.sessions.set('host-session', { persistKey: 'worker', indexKey: 'worker', sessionHost: true })
      manager.byPersistKey.set('worker', 'host-session')
    } else manager.released.set('worker', { sessionId: 'host-session', remote: false, sessionHost: true })
    const owner: PaneOwner = { panePid: 10, tty: 'win32-console:10', command: 'claude', argv: ['claude'], paneId: 'generation' }
    const guard = { beforePaste: vi.fn(() => true), beforeSubmit: vi.fn(() => false) }
    expect(await manager.sendEnvelope('worker', 'message', owner, guard)).toBe(true)
    expect(host.send).toHaveBeenCalledExactlyOnceWith(sessionName('worker'), 'message', owner, guard)
  })
})
