import { describe, expect, it, vi } from 'vitest'

// Importing the component transitively loads `session/localSession`, which reads
// `window.nodeTerminal` at module-eval time (safe in-app for its documented boot order) — a
// ReferenceError under the node vitest env, which has no `window`. Stub that one module so the
// import stays pure: only `pollOutcome` is exercised here, and the component is never rendered.
vi.mock('../session/localSession', () => ({
  localSession: { api: { pty: { tmuxStatus: async () => ({ available: false }) } } }
}))

import { INSTALL_CAP_MS, pollOutcome, windowsPersistenceUnavailable } from './TmuxBanner'

describe('pollOutcome', () => {
  it('stays installing while unavailable and under the cap', () => {
    expect(pollOutcome(false, 0)).toBe('installing')
    expect(pollOutcome(false, INSTALL_CAP_MS - 1)).toBe('installing')
  })
  it('flips to ready the moment tmux is available — even past the cap', () => {
    expect(pollOutcome(true, 0)).toBe('ready')
    expect(pollOutcome(true, INSTALL_CAP_MS + 1)).toBe('ready')
  })
  it('fails once the cap elapses without tmux', () => {
    expect(pollOutcome(false, INSTALL_CAP_MS)).toBe('failed')
  })
})

describe('windowsPersistenceUnavailable', () => {
  it('reports an explicitly unavailable Windows session host', () => {
    expect(
      windowsPersistenceUnavailable({
        available: false,
        sessionPersistenceAvailable: false,
        installCommand: null,
        installLabel: null,
        platform: 'win32'
      })
    ).toBe(true)
  })

  it('keeps old cores and non-Windows platforms fail-open', () => {
    expect(
      windowsPersistenceUnavailable({
        available: false,
        installCommand: null,
        installLabel: null,
        platform: 'win32'
      })
    ).toBe(false)
    expect(
      windowsPersistenceUnavailable({
        available: false,
        sessionPersistenceAvailable: false,
        installCommand: null,
        installLabel: null,
        platform: 'linux'
      })
    ).toBe(false)
  })
})
