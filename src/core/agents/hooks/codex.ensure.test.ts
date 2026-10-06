// Launch-time repair of the codex hook install (ensureCodexHooksCurrent).
//
// Codex runs a hook only when ~/.codex/config.toml holds a matching `trusted_hash`, and reads it at
// session start. These pin that drift is repaired before a Codex pane spawns, that a CURRENT
// install is not rewritten (codex writes config.toml too), and that a broken install never throws
// into the spawn path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let home = ''
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home }
})

import { codexHookDrift, ensureCodexHooksCurrent, installCodexHooks } from './codex'

const toml = (): string => path.join(home, '.codex', 'config.toml')
const hooks = (): string => path.join(home, '.codex', 'hooks.json')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ensure-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('ensureCodexHooksCurrent', () => {
  it('installs on a home that has never had the hooks', () => {
    expect(codexHookDrift()).not.toEqual([])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(fs.readFileSync(toml(), 'utf8')).toContain('trusted_hash')
  })

  it('does not rewrite a current install', () => {
    installCodexHooks()
    const past = new Date(Date.now() - 60_000)
    for (const f of [toml(), hooks()]) fs.utimesSync(f, past, past)
    const before = [toml(), hooks()].map((f) => fs.statSync(f).mtimeMs)
    ensureCodexHooksCurrent()
    expect([toml(), hooks()].map((f) => fs.statSync(f).mtimeMs)).toEqual(before)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('repairs config.toml that lost the trust entries (the incident shape)', () => {
    installCodexHooks()
    // What was found on the machine: the user's own config kept, nodeterm's trust blocks gone.
    fs.writeFileSync(toml(), 'model = "gpt-5"\n')
    expect(codexHookDrift()).toEqual(['config.toml trust (8/8)'])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(fs.readFileSync(toml(), 'utf8')).toContain('model = "gpt-5"')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('config.toml trust'))
  })

  it('repairs a trust hash that no longer matches the hook', () => {
    installCodexHooks()
    const text = fs.readFileSync(toml(), 'utf8')
    fs.writeFileSync(toml(), text.replace(/trusted_hash = "sha256:[0-9a-f]+"/, 'trusted_hash = "sha256:00"'))
    expect(codexHookDrift()).toEqual(['config.toml trust (1/8)'])
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
  })

  it('repairs hooks.json that lost our entries, keeping the user hooks', () => {
    installCodexHooks()
    const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }
    fs.writeFileSync(hooks(), JSON.stringify(user))
    expect(codexHookDrift()).toContain('hooks.json entries')
    ensureCodexHooksCurrent()
    expect(codexHookDrift()).toEqual([])
    expect(fs.readFileSync(hooks(), 'utf8')).toContain('echo mine')
  })

  it('never throws when the install cannot be read', () => {
    fs.mkdirSync(toml(), { recursive: true }) // config.toml is a DIRECTORY: every read fails
    expect(() => ensureCodexHooksCurrent()).not.toThrow()
  })
})

describe('PtyManager wiring', () => {
  it('checks before a LOCAL codex-harness pane spawns, never for an SSH one', () => {
    const src = fs
      .readFileSync(path.join(__dirname, '..', '..', 'pty-manager.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    const at = src.indexOf('ensureCodexHooksCurrent()\n')
    expect(at).toBeGreaterThan(0)
    const gate = src.slice(at - 300, at)
    expect(gate).toContain("capabilityAgentId(options.agentId as AgentId) === 'codex'")
    expect(gate).toContain('!options.sshRemote')
  })
})
