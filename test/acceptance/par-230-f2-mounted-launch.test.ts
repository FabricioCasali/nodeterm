import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createAgentNode } from '../../src/renderer/state/workspace'
import { createLaunchWriter } from '../../src/renderer/terminal/launch-command'
import { executeHeldLaunch } from '../../src/renderer/terminal/launch-intent'
import { commitLaunchAttempt } from '../../src/renderer/terminal/launch-attempt'
import { executeLaunchIntent, readPromptFileBounded, type LaunchIntentDeps } from '../../src/core/launch-intent-execute'
import { testTmpDir } from '../../src/core/test-tmp'
import { terminateWindowsProcessTree } from '../../src/session-host/windows-process-tree'

describe.runIf(process.platform === 'win32')('PAR-230 F2 mounted launch through a real Windows shell', { timeout: 30_000 }, () => {
  it.each([false, true])('T09/T10 node factory → claim → writer → held executor → core → shell; model=%s', async (withModel) => {
    const directory = testTmpDir('par230-f2-mounted-')
    const file = path.join(directory, "brief ' com espaço.md")
    const injected = path.join(directory, 'injected')
    const brief = `Ação "quoted" it's 開発 🧪 $env:HOME \`tick\n$(Set-Content -LiteralPath '${injected.replace(/'/gu, "''")}' -Value BAD)`
    writeFileSync(file, brief)
    writeFileSync(path.join(directory, 'claude.ps1'), [
      'param([Parameter(ValueFromRemainingArguments=$true)][string[]] $Rest)',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '[Console]::Write((ConvertTo-Json -Compress -InputObject @{pid=$PID;argv=@($Rest)}))'
    ].join('\r\n'))
    const n = createAgentNode('claude', 0, directory, undefined, undefined, undefined,
      undefined, undefined, undefined, withModel ? 'opus' : undefined, file)
    n.data.pendingLaunch = { after: [], command: n.data.initialCommand!, attempted: false }
    const order: string[] = []
    const received: Array<{ pid: number; argv: string[] }> = []
    const pids: number[] = []
    onTestFinished(async () => {
      for (const pid of pids) {
        let running = false
        try { process.kill(pid, 0); running = true } catch { /* Already exited. */ }
        if (running) await terminateWindowsProcessTree(pid)
        expect(() => process.kill(pid, 0)).toThrow()
      }
    })
    const core: LaunchIntentDeps = {
      platform: 'win32', customAgents: () => [], exists: existsSync,
      sharedIdentityAvailable: async () => false,
      codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
      readPromptFile: readPromptFileBounded, isProtocolIncompatible: () => false,
      execute: async (_name, _id, plan) => {
        order.push('shell')
        const shell = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', plan.command], { cwd: directory, windowsHide: true })
        if (shell.pid) pids.push(shell.pid)
        let stdout = ''
        let stderr = ''
        shell.stdout.on('data', (d) => { stdout += String(d) })
        shell.stderr.on('data', (d) => { stderr += String(d) })
        await new Promise<void>((resolve, reject) => {
          shell.once('error', reject)
          shell.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)))
        })
        received.push(JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()))
        return { status: 'executed' }
      }
    }
    let echo: ((s: string) => void) | undefined
    const write = vi.fn((s: string) => { queueMicrotask(() => echo?.(s)) })
    const writer = createLaunchWriter({
      shellReady: async () => true, killLine: '\x15', cleanup: () => {},
      io: { write, onData: (cb) => { echo = cb; return () => { echo = undefined } } },
      claimAttempt: (manual, command) => commitLaunchAttempt({
        pending: n.data.pendingLaunch, command, manual,
        update: (next) => { n.data.pendingLaunch = next },
        save: async () => { order.push('claim-saved') }
      }),
      execute: (command) => executeHeldLaunch(command, {
        held: () => n.data.launchIntent, sessionHost: true, source: 'local',
        hostPlatform: async () => 'win32', newLaunchId: randomUUID,
        executeLaunch: (request) => executeLaunchIntent({
          name: n.id, sessionHost: true, remote: false, launchDialect: 'pwsh',
          agentId: 'claude', pathValue: directory
        }, request, core)
      })
    })
    expect(await writer(n.data.initialCommand!, false)).toBe('submitted')
    expect(write).not.toHaveBeenCalled()
    expect(order).toEqual(['claim-saved', 'shell'])
    expect(received).toHaveLength(1)
    expect(received[0].argv).toContain(brief.replace(/\s+/gu, ' ').trim())
    if (withModel) expect(received[0].argv).toContain('opus')
    expect(readFileSync(file, 'utf8')).toBe(brief)
    expect(existsSync(injected)).toBe(false)
    expect(await writer(n.data.initialCommand!, true)).toBe('submitted')
    expect(received).toHaveLength(1)
    for (const pid of [...pids, ...received.map((r) => r.pid)]) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })
})
