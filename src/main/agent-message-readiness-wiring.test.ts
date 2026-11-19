import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessagingDeps } from '../core/agents/agent-messaging'

describe('Desktop guarded envelope registration', () => {
  it('executes the registered transport and capability callbacks with the same guard', async () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf('const messagingDeps: AgentMessagingDeps = {')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n  }', start)
    expect(end).toBeGreaterThan(start)
    const properties = source.slice(start, end).match(/^    (?:sendEnvelope|envelopeGuardSupported):[^\n]+,$/gm) ?? []
    expect(properties).toHaveLength(2)
    const ptyManager = { sendEnvelope: vi.fn(async () => true), envelopeGuardSupported: vi.fn(async () => true) }
    const registered = new Function('ptyManager', `return ({${properties.join('\n')}})`)(ptyManager) as
      Pick<AgentMessagingDeps, 'sendEnvelope' | 'envelopeGuardSupported'>
    const owner = { panePid: 10, tty: 'test-console', command: 'claude', argv: ['claude'] }
    const guard = { beforePaste: () => true, beforeSubmit: () => false }
    expect(await registered.envelopeGuardSupported!('worker')).toBe(true)
    expect(await registered.sendEnvelope('worker', 'envelope', owner, guard)).toBe(true)
    expect(ptyManager.envelopeGuardSupported).toHaveBeenCalledExactlyOnceWith('worker')
    expect(ptyManager.sendEnvelope).toHaveBeenCalledExactlyOnceWith('worker', 'envelope', owner, guard)
  })
})
