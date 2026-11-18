import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { PtyManager } from './pty-manager'

vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('Unexpected spawn') }) }))
const hostCapture = vi.hoisted(() => vi.fn(async () => ({ screen: 'visible', cursor: null, altScreen: false })))
vi.mock('./session-host-backend', async (original) => ({
  ...(await original<typeof import('./session-host-backend')>()),
  sessionHostCaptureVisible: hostCapture
}))
beforeEach(() => { resetPlatformForTests(); initPlatform(fakePlatform()); hostCapture.mockClear() })
afterEach(() => resetPlatformForTests())

it('the visible-only bridge reads the resolved session and rejects unavailable capture', async () => {
  const pty = new PtyManager()
  const sessions = (pty as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.set('session', { persistKey: 'node', indexKey: 'node', tmuxBacked: true })
  const capture = vi.spyOn(pty, 'captureVisible').mockResolvedValue({ screen: 'visible', cursor: null })
  expect(await pty.captureSession('node', true, true)).toBe('visible')
  expect(capture).toHaveBeenCalledExactlyOnceWith('session')
  capture.mockResolvedValue({ screen: '', cursor: null, unavailable: true })
  await expect(pty.captureSession('node', false, true)).rejects.toThrow('unavailable')
  await expect(pty.captureSession('absent', false, true)).rejects.toThrow('unavailable')
})

it('does not resolve an old released generation after its node was replaced or forgotten', async () => {
  const pty = new PtyManager()
  const { sessions, released } = pty as unknown as {
    sessions: Map<string, unknown>; released: Map<string, unknown>
  }
  released.set('node', { sessionId: 'old', remote: false, sessionHost: true })
  expect(pty.sessionOfNode('node')).toBe('old')
  expect(await pty.captureVisible('old')).toMatchObject({ screen: 'visible' })
  hostCapture.mockClear()
  sessions.set('replacement', { persistKey: 'node', indexKey: 'node', tmuxBacked: false })
  expect(pty.sessionOfNode('node')).toBe('replacement')
  expect(await pty.captureVisible('old')).toMatchObject({ unavailable: true })
  expect(hostCapture).not.toHaveBeenCalled()
  sessions.clear()
  released.clear()
  expect(pty.sessionOfNode('node')).toBeUndefined()
  expect(await pty.captureVisible('old')).toMatchObject({ unavailable: true })
})

it.each([{ zellij: true }, { nativeWindowsPane: true }, { tmuxBacked: false }])(
  'keeps unsupported released backends unavailable: %j', async (backend) => {
    const pty = new PtyManager()
    const internals = pty as unknown as { tmuxPath: string; released: Map<string, unknown> }
    internals.tmuxPath = '/unused/tmux'
    internals.released.set('node', { sessionId: 'old', remote: false, tmuxBacked: true, ...backend })
    expect(await pty.captureVisible('old')).toMatchObject({ unavailable: true })
  }
)
