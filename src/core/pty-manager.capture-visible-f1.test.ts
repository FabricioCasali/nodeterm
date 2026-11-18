import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { PtyManager } from './pty-manager'

vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('Unexpected spawn') }) }))
beforeEach(() => { resetPlatformForTests(); initPlatform(fakePlatform()) })
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
