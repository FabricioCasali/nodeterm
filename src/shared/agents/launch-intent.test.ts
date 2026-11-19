import { describe, expect, it } from 'vitest'
import { heldLaunchIntentFor, type HeldLaunchInputs } from './launch-intent'

const base = (extra: Partial<HeldLaunchInputs> = {}): HeldLaunchInputs => ({
  agentId: 'claude',
  command: 'claude …',
  remote: false,
  resume: false,
  initialPrompt: "fix it's\n  bug",
  ...extra
})

describe('heldLaunchIntentFor', () => {
  it('describes a builtin prompt launch, collapsing the prompt exactly like the typed line', () => {
    expect(
      heldLaunchIntentFor(base({ permissionMode: 'auto', mintedSessionId: '123e4567-e89b-42d3-a456-426614174000' }))
    ).toEqual({
      command: 'claude …',
      intent: {
        kind: 'agent',
        action: 'start',
        agentId: 'claude',
        prompt: "fix it's bug",
        permissionMode: 'auto',
        newSessionId: '123e4567-e89b-42d3-a456-426614174000'
      }
    })
  })

  it('carries a prompt file by path, with no inline prompt', () => {
    expect(heldLaunchIntentFor(base({ promptFile: ' C:\\brief.md ' }))).toEqual({
      command: 'claude …',
      intent: { kind: 'agent', action: 'start', agentId: 'claude' },
      promptFile: 'C:\\brief.md'
    })
  })

  it('drops a mode or minted id the agent cannot express (the typed line has none either)', () => {
    const held = heldLaunchIntentFor(
      base({ agentId: 'opencode', permissionMode: 'plan', mintedSessionId: '123e4567-e89b-42d3-a456-426614174000' })
    )
    expect(held?.intent).toEqual({ kind: 'agent', action: 'start', agentId: 'opencode', prompt: "fix it's bug" })
  })

  it.each([
    ['no prompt', { initialPrompt: undefined }],
    ['a whitespace-only prompt', { initialPrompt: '   ' }],
    ['a resume', { resume: true }],
    ['a remote (SSH) node', { remote: true }],
    ['a launch-command override', { launchCmdOverride: 'my-claude' }]
  ] as const)('builds nothing for %s — the legacy line stays the only launch', (_n, extra) => {
    expect(heldLaunchIntentFor(base(extra as Partial<HeldLaunchInputs>))).toBeUndefined()
  })

  it('PAR-230 F2 carries the per-node model in the semantic start intent', () => {
    expect(heldLaunchIntentFor(base({ model: 'opus' }))).toMatchObject({
      command: 'claude …', intent: { kind: 'agent', action: 'start', agentId: 'claude', model: 'opus' }
    })
  })

  it('PAR-230 F2 a custom agent with free-form id and its own args keeps its identity too', () => {
    expect(heldLaunchIntentFor(base({
      agentId: 'claude-coder-particular', initialPrompt: 'brief', model: 'opus',
      customAgent: { launchCmd: 'claude', args: '--mcp-config ${env:ROOT}/x.json --strict-mcp-config' }
    }))).toMatchObject({ intent: { kind: 'agent', action: 'start', agentId: 'claude-coder-particular', prompt: 'brief', model: 'opus' } })
    // No record for a free-form id on this machine: nothing to resolve, the typed line stays.
    expect(heldLaunchIntentFor(base({ agentId: 'unknown-agent', initialPrompt: 'brief' }))).toBeUndefined()
  })

  it.each([
    ['an env expansion in its launch command', { launchCmd: '${env:HOME}/bin/fixture' }],
    ['shell syntax in its launch command', { launchCmd: 'FOO=1 fixture | tee log' }]
  ])('PAR-230 F2 builds nothing for a custom agent with %s — the planner takes a plain argv only', (_n, customAgent) => {
    expect(heldLaunchIntentFor(base({ agentId: 'custom:abc', initialPrompt: 'brief', customAgent }))).toBeUndefined()
  })

  it('PAR-230 F2 keeps a custom agent identity for resolution against its current machine-local config', () => {
    expect(heldLaunchIntentFor(base({ agentId: 'custom:abc', command: "fixture 'literal brief'", initialPrompt: 'literal brief' }))).toMatchObject({
      command: "fixture 'literal brief'", intent: { kind: 'agent', action: 'start', agentId: 'custom:abc', prompt: 'literal brief' }
    })
  })
})
