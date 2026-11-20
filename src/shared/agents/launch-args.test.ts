// PAR-255: per-session `--launch-args` — the parser/validator, the typed line it produces on every
// harness grammar (fresh launch and resume), and the semantic intent a Windows pane executes.
import { describe, expect, it } from 'vitest'
import {
  LAUNCH_ARGS_MAX_LENGTH,
  LAUNCH_ARGS_MAX_TOKENS,
  launchArgsArgv,
  launchArgsError,
  launchArgsFlagRefusal,
  normalizeLaunchArgs
} from './launch-args'
import { assembleLaunchCommand, assembleResumeCommand } from './launch'
import { heldLaunchIntentFor } from './launch-intent'
import { shellSplitChecked } from '../shell-quote'
import type { CustomAgent } from '../types'

const CLAUDE_MCP = '--strict-mcp-config --mcp-config C:/x/mcp.json --settings C:/x/settings.json --plugin-dir C:/x/plugin'
const CODEX_OVERRIDES = `-c mcp_servers.linear.enabled=false -c 'skills.config=[{name="a:b",enabled=false}]'`

describe('launchArgsArgv / launchArgsError', () => {
  it('splits like the custom-agent args field: quotes group, backslash escapes', () => {
    expect(launchArgsArgv(CLAUDE_MCP)).toEqual([
      '--strict-mcp-config', '--mcp-config', 'C:/x/mcp.json', '--settings', 'C:/x/settings.json',
      '--plugin-dir', 'C:/x/plugin'
    ])
    expect(launchArgsArgv(CODEX_OVERRIDES)).toEqual([
      '-c', 'mcp_servers.linear.enabled=false', '-c', 'skills.config=[{name="a:b",enabled=false}]'
    ])
    expect(launchArgsArgv('--gemini_dir="C:/my dir/gemini"')).toEqual(['--gemini_dir=C:/my dir/gemini'])
    expect(launchArgsArgv('--a\\ b')).toEqual(['--a b'])
  })

  it('takes every piece literally: no env, variable or tilde expansion', () => {
    expect(launchArgsArgv('--dir ${env:HOME} $HOME ~/x')).toEqual(['--dir', '${env:HOME}', '$HOME', '~/x'])
  })

  it('refuses newline, carriage return, NUL and other control characters', () => {
    for (const bad of ['--a\nb', '--a\rb', '--a\x00b', '--a\tb', '--a\x1bb', '--a\u2028b']) {
      expect(launchArgsError(bad), JSON.stringify(bad)).toMatch(/control characters/)
      expect(launchArgsArgv(bad)).toEqual([])
    }
  })

  it('refuses an unterminated quote instead of guessing where it ends', () => {
    expect(launchArgsError(`-c 'skills.config=[`)).toMatch(/unterminated quote/)
    expect(launchArgsError('--x "open')).toMatch(/unterminated quote/)
    expect(launchArgsArgv('--x "open')).toEqual([])
  })

  it('refuses a blank value with the `--launch-args=` hint, and oversized values', () => {
    expect(launchArgsError('   ')).toMatch(/--launch-args="--flag value/)
    expect(launchArgsError('x'.repeat(LAUNCH_ARGS_MAX_LENGTH + 1))).toMatch(/longer than/)
    expect(launchArgsError(Array.from({ length: LAUNCH_ARGS_MAX_TOKENS + 1 }, () => '-v').join(' '))).toMatch(
      /more than/
    )
    expect(launchArgsError(Array.from({ length: LAUNCH_ARGS_MAX_TOKENS }, () => '-v').join(' '))).toBeNull()
  })

  it('normalizes to the trimmed raw string, or undefined when unusable', () => {
    expect(normalizeLaunchArgs(`  ${CLAUDE_MCP}  `)).toBe(CLAUDE_MCP)
    expect(normalizeLaunchArgs('')).toBeUndefined()
    expect(normalizeLaunchArgs('--a\nb')).toBeUndefined()
    expect(normalizeLaunchArgs(42)).toBeUndefined()
    expect(normalizeLaunchArgs(undefined)).toBeUndefined()
  })

  it('shellSplitChecked reports the unterminated state shellSplit forgives', () => {
    expect(shellSplitChecked(`a 'b c'`)).toEqual({ tokens: ['a', 'b c'], unterminated: false })
    expect(shellSplitChecked(`a 'b c`)).toEqual({ tokens: ['a', 'b c'], unterminated: true })
  })
})

describe('launchArgsFlagRefusal (the shared verb gate)', () => {
  it('passes when absent or valid on the agent-opening verbs', () => {
    expect(launchArgsFlagRefusal('open-agent', { agent: 'claude' })).toBeNull()
    expect(launchArgsFlagRefusal('open-agent', { agent: 'claude', 'launch-args': CLAUDE_MCP })).toBeNull()
    expect(launchArgsFlagRefusal('open-claude', { 'launch-args': CODEX_OVERRIDES })).toBeNull()
  })

  it('refuses it on any other verb', () => {
    expect(launchArgsFlagRefusal('open-terminal', { 'launch-args': '-v' })).toBe(
      'open-terminal: --launch-args applies only to open-agent / open-claude'
    )
    expect(launchArgsFlagRefusal('spawn-team', { 'launch-args': '-v' })).toMatch(/applies only to/)
  })

  it('refuses a malformed value by name, before anything opens', () => {
    expect(launchArgsFlagRefusal('open-agent', { 'launch-args': '--a\nb' })).toMatch(
      /^open-agent: --launch-args must not contain newlines/
    )
    // The shim's `--launch-args --strict-mcp-config` mistake arrives as an empty value.
    expect(launchArgsFlagRefusal('open-agent', { 'launch-args': '' })).toMatch(/needs a value/)
  })
})

describe('assembleLaunchCommand with launchArgs (the typed line)', () => {
  it('claude: in the managed-flags slot, after the positional prompt and nodeterm flags', () => {
    const { command } = assembleLaunchCommand(
      {
        agentId: 'claude',
        initialPrompt: 'do it',
        permissionMode: 'acceptEdits',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        sessionIdFlagSupported: true,
        model: 'opus',
        launchArgs: CLAUDE_MCP
      },
      {}
    )
    expect(command).toBe(
      "claude 'do it' --permission-mode acceptEdits --session-id 550e8400-e29b-41d4-a716-446655440000 " +
        "--model 'opus' '--strict-mcp-config' '--mcp-config' 'C:/x/mcp.json' '--settings' " +
        "'C:/x/settings.json' '--plugin-dir' 'C:/x/plugin'"
    )
  })

  it('codex: each override one quoted argument, before the trailing --no-daemon', () => {
    const { command } = assembleLaunchCommand(
      {
        agentId: 'codex',
        initialPrompt: 'go',
        launchArgs: CODEX_OVERRIDES,
        approvalCaps: { codexNoDaemon: true }
      },
      {}
    )
    expect(command).toBe(
      `codex 'go' '-c' 'mcp_servers.linear.enabled=false' '-c' 'skills.config=[{name="a:b",enabled=false}]' --no-daemon`
    )
  })

  it('grok: before the `--` prompt separator, never after it', () => {
    const { command } = assembleLaunchCommand(
      { agentId: 'grok', initialPrompt: 'hi', permissionMode: 'plan', launchArgs: '--verbose' },
      {}
    )
    expect(command).toBe("grok --permission-mode plan '--verbose' -- 'hi'")
  })

  it('antigravity: after its interactive-prompt flag pair', () => {
    const { command } = assembleLaunchCommand(
      { agentId: 'antigravity', initialPrompt: 'hi', launchArgs: '--gemini_dir=C:/x/gemini' },
      {}
    )
    expect(command).toMatch(/ '--gemini_dir=C:\/x\/gemini'$/)
    expect(command.indexOf("'hi'")).toBeLessThan(command.indexOf('--gemini_dir'))
  })

  it('a custom agent: after its own configured args, with no prompt', () => {
    const custom: CustomAgent = {
      id: 'claude-orq',
      label: 'Claude ORQ',
      launchCmd: 'claude',
      args: '--add-dir ${env:WORK}',
      baseAgent: 'claude'
    } as CustomAgent
    const { command } = assembleLaunchCommand(
      { agentId: 'claude-orq', customAgent: custom, launchArgs: '--mcp-config C:/x/mcp.json' },
      { WORK: '/w' }
    )
    expect(command).toBe("claude '--add-dir' '/w' '--mcp-config' 'C:/x/mcp.json'")
  })

  it('a shell metacharacter in a piece stays data', () => {
    const { command } = assembleLaunchCommand({ agentId: 'claude', launchArgs: `--x "a; rm -rf ~ 'q'"` }, {})
    expect(command).toBe(`claude '--x' 'a; rm -rf ~ '\\''q'\\'''`)
  })

  it('absent or invalid launch args leave the line byte-identical', () => {
    const base = assembleLaunchCommand({ agentId: 'claude', initialPrompt: 'go' }, {}).command
    expect(base).toBe("claude 'go'")
    expect(assembleLaunchCommand({ agentId: 'claude', initialPrompt: 'go', launchArgs: '' }, {}).command).toBe(base)
    expect(assembleLaunchCommand({ agentId: 'claude', initialPrompt: 'go', launchArgs: '--a\nb' }, {}).command).toBe(base)
  })
})

describe('assembleResumeCommand with launchArgs (cold restore / restart / wake)', () => {
  it('claude resume keeps the flags after the resume pair', () => {
    const { command } = assembleResumeCommand(
      { agentId: 'claude', sessionId: 'abc-123', model: 'opus', launchArgs: '--mcp-config C:/x/mcp.json' },
      {}
    )
    expect(command).toBe("claude --resume abc-123 --model 'opus' '--mcp-config' 'C:/x/mcp.json'")
  })

  it('codex resume puts the overrides after `resume <id>`', () => {
    const { command } = assembleResumeCommand(
      { agentId: 'codex', sessionId: 'abc-123', launchArgs: '-c mcp_servers.linear.enabled=false' },
      {}
    )
    expect(command).toBe("codex resume abc-123 '-c' 'mcp_servers.linear.enabled=false'")
  })

  it('a fresh relaunch (no session id) still carries them', () => {
    expect(assembleResumeCommand({ agentId: 'claude', launchArgs: '--strict-mcp-config' }, {}).command).toBe(
      "claude '--strict-mcp-config'"
    )
  })
})

describe('heldLaunchIntentFor with launchArgs (the Windows-native twin)', () => {
  const base = { agentId: 'codex', command: 'line', remote: false, resume: false } as const

  it('carries the argv beside the prompt', () => {
    expect(heldLaunchIntentFor({ ...base, initialPrompt: 'go', launchArgs: CODEX_OVERRIDES })?.intent).toEqual({
      kind: 'agent',
      action: 'start',
      agentId: 'codex',
      prompt: 'go',
      launchArgs: ['-c', 'mcp_servers.linear.enabled=false', '-c', 'skills.config=[{name="a:b",enabled=false}]']
    })
  })

  it('holds an intent even WITHOUT a prompt when launch args are present', () => {
    expect(heldLaunchIntentFor({ ...base, launchArgs: '-c a=b' })).toEqual({
      command: 'line',
      intent: { kind: 'agent', action: 'start', agentId: 'codex', launchArgs: ['-c', 'a=b'] }
    })
    expect(heldLaunchIntentFor({ ...base })).toBeUndefined()
    expect(heldLaunchIntentFor({ ...base, launchArgs: '--bad\n' })).toBeUndefined()
  })

  it('still yields none for a remote node or a resume', () => {
    expect(heldLaunchIntentFor({ ...base, remote: true, launchArgs: '-c a=b' })).toBeUndefined()
    expect(heldLaunchIntentFor({ ...base, resume: true, launchArgs: '-c a=b' })).toBeUndefined()
  })
})
