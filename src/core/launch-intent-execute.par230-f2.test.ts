import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentLaunchIntent, CustomAgent } from '../shared/types'
import {
  executeLaunchIntent,
  readPromptFileBounded,
  type LaunchIntentDeps,
  type LaunchTarget
} from './launch-intent-execute'
import { testTmpDir } from './test-tmp'

const LAUNCH_ID = '123e4567-e89b-42d3-a456-426614174000'
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const PWSH = 'pwsh.exe'
const quote = (s: string): string => `'${s.replace(/'/gu, "''")}'`

function fixture() {
  const directory = testTmpDir('par230-f2-transport-')
  const shim = path.join(directory, 'claude.ps1')
  const briefFile = path.join(directory, "brief ' com espaço.md")
  const marker = path.join(directory, 'injected.txt')
  const brief = `# Ação\r\n\r\nIt's "quoted"; 開発 🧪 $env:HOME \`tick\n$(Set-Content -LiteralPath ${quote(marker)} -Value BAD) & | < > % ^ !\n`
  writeFileSync(shim, [
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]] $Rest)',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::Write((ConvertTo-Json -Compress -Depth 4 -InputObject @{ pid = $PID; argv = @($Rest) }))'
  ].join('\r\n'))
  writeFileSync(path.join(directory, 'codex.ps1'), readFileSync(shim))
  writeFileSync(briefFile, brief)
  return { directory, shim, briefFile, marker, brief, flattened: brief.replace(/\s+/gu, ' ').trim() }
}

function harness(f: ReturnType<typeof fixture>, dialect: LaunchTarget['launchDialect'], agent = 'claude') {
  const custom = agent.startsWith('custom:')
  const config: CustomAgent = {
    id: 'custom:par230', label: 'PAR230 fixture', baseAgent: 'claude',
    launchCmd: quote(f.shim), promptInjectionMode: 'argv'
  }
  const target: LaunchTarget = {
    name: 'par230-f2-isolated', sessionHost: true, remote: false,
    launchDialect: dialect, agentId: custom ? config.id : agent, pathValue: f.directory
  }
  const received: Array<{ pid: number; argv: string[] }> = []
  const spawned: number[] = []
  const d: LaunchIntentDeps = {
    platform: 'win32', customAgents: () => custom ? [config] : [],
    sharedIdentityAvailable: async () => false,
    codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
    exists: existsSync, systemRoot: process.env.SystemRoot,
    readPromptFile: readPromptFileBounded,
    isProtocolIncompatible: () => false,
    execute: async (_name, _launchId, plan) => {
      const cmd = dialect === 'cmd'
      const shell = cmd ? (process.env.ComSpec ?? 'cmd.exe') : dialect === 'pwsh' ? PWSH : PS
      const args = cmd ? ['/d', '/v:off', '/c', plan.command] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', plan.command]
      const child = spawn(shell, args, { cwd: f.directory, windowsHide: true, windowsVerbatimArguments: cmd })
      if (child.pid) spawned.push(child.pid)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => { stdout += String(data) })
      child.stderr.on('data', (data) => { stderr += String(data) })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}: ${stderr}`)))
      })
      received.push(JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()))
      return { status: 'executed' }
    }
  }
  return { target, d, received, spawned }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

describe.runIf(process.platform === 'win32')('PAR-230 F2 core transport with a real Windows shell', { timeout: 30_000 }, () => {
  for (const dialect of ['pwsh', 'windows-powershell', 'cmd'] as const) {
    it.each(['claude', 'codex', 'custom:par230'])(`T09 ${dialect} promptFile; agent=%s`, async (agent) => {
      const f = fixture()
      const h = harness(f, dialect, agent)
      const result = await executeLaunchIntent(h.target, {
        launchId: LAUNCH_ID,
        intent: { kind: 'agent', action: 'start', agentId: h.target.agentId } as AgentLaunchIntent,
        promptFile: f.briefFile
      }, h.d)
      expect(result).toEqual({ ok: true })
      expect(h.received).toHaveLength(1)
      expect(h.received[0].argv.filter((arg) => arg === f.flattened)).toHaveLength(1)
      expect(existsSync(f.marker)).toBe(false)
      expect(h.spawned.every((pid) => !alive(pid))).toBe(true)
      expect(alive(h.received[0].pid)).toBe(false)
      if (process.env.PAR230_F2_EVIDENCE_DIR) {
        writeFileSync(path.join(process.env.PAR230_F2_EVIDENCE_DIR, `transport-${dialect}-${agent.replace(':', '-')}.json`), JSON.stringify({
          dialect, agent, received: h.received, spawned: h.spawned, teardown: true
        }, null, 2))
      }
    })
  }

  it.each(['claude', 'codex', 'custom:par230'])('T09 transports model together with a quoted promptFile; agent=%s', async (agent) => {
    const f = fixture()
    const h = harness(f, 'pwsh', agent)
    const result = await executeLaunchIntent(h.target, {
      launchId: LAUNCH_ID,
      intent: { kind: 'agent', action: 'start', agentId: agent, model: agent === 'codex' ? 'gpt-5' : 'opus' },
      promptFile: f.briefFile
    }, h.d)
    expect(result).toEqual({ ok: true })
    expect(h.received[0].argv).toContain(f.flattened)
    const modelAt = h.received[0].argv.indexOf('--model')
    expect(modelAt).toBeGreaterThanOrEqual(0)
    expect(h.received[0].argv[modelAt + 1]).toBe(agent === 'codex' ? 'gpt-5' : 'opus')
    expect(existsSync(f.marker)).toBe(false)
  })

  it.each(['pwsh', 'windows-powershell', 'cmd'] as const)(
    'T09 %s a team profile (free-form id, base harness, ${env:…} args) keeps its args, model and brief',
    async (dialect) => {
      const f = fixture()
      const h = harness(f, dialect)
      const profile: CustomAgent = {
        id: 'claude-coder-particular', label: 'Claude Coder (Particular)', baseAgent: 'claude',
        launchCmd: quote(f.shim), promptInjectionMode: 'argv',
        args: '--mcp-config "${env:PAR230_ROOT}/perfis/it\'s coder.mcp.json" --strict-mcp-config ${env:PAR230_UNSET}'
      }
      const result = await executeLaunchIntent({ ...h.target, agentId: profile.id }, {
        launchId: LAUNCH_ID,
        intent: { kind: 'agent', action: 'start', agentId: profile.id, model: 'opus' },
        promptFile: f.briefFile
      }, { ...h.d, customAgents: () => [profile], env: () => ({ PAR230_ROOT: 'H:/ambiente raiz/03-mcps' }) })
      expect(result).toEqual({ ok: true })
      const argv = h.received[0].argv
      // The profile's own args, expanded per token and still ONE argument each; an unset one is gone.
      expect(argv.slice(0, 3)).toEqual(['--mcp-config', "H:/ambiente raiz/03-mcps/perfis/it's coder.mcp.json", '--strict-mcp-config'])
      expect(argv[argv.indexOf('--model') + 1]).toBe('opus')
      expect(argv.filter((arg) => arg === f.flattened)).toHaveLength(1)
      expect(existsSync(f.marker)).toBe(false)
    }
  )

  it('T10 transports a readable long file without losing its contents at the inline Windows limit', async () => {
    const f = fixture()
    const brief = '開発 "literal" '.repeat(4_000).trim()
    writeFileSync(f.briefFile, brief)
    const h = harness(f, 'pwsh')
    expect(readFileSync(f.briefFile, 'utf8')).toBe(brief)
    const result = await executeLaunchIntent(h.target, {
      launchId: LAUNCH_ID, intent: { kind: 'agent', action: 'start', agentId: 'claude' }, promptFile: f.briefFile
    }, h.d)
    expect(result).toEqual({ ok: true })
    expect(h.received[0].argv).toEqual([brief])
  })
})
