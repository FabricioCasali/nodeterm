import { afterEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { SessionHostClient } from '../../src/core/session-host-client'
import { sessionHostMessageEnvelope } from '../../src/core/session-host-backend'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'

afterEach(() => { vi.restoreAllMocks(); resetPlatformForTests() })
describe('PAR-230 R6 actual backend bridge', () => {
  it('forwards the fourth argument verbatim from bridge to existing client method', async () => {
    initPlatform(fakePlatform())
    const send = vi.spyOn(SessionHostClient.prototype, 'messageEnvelope').mockResolvedValue(true)
    const guard = { beforePaste: () => true, beforeSubmit: () => false }
    const owner: PaneOwner = { panePid: 10, tty: 'win32-console:10', command: 'claude', argv: ['claude'] }
    const forward = sessionHostMessageEnvelope as (...args: [string, string, PaneOwner, typeof guard?]) => Promise<boolean>
    expect(await forward('nt-worker', 'message', owner, guard)).toBe(true)
    expect(send).toHaveBeenCalledExactlyOnceWith('nt-worker', 'message', owner, guard)
  })
})
