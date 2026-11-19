import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { describe, expect, it, onTestFinished } from 'vitest'
import { testTmpDir } from '../core/test-tmp'
import { executeLaunchIntent, readPromptFileBounded, type LaunchIntentDeps } from '../core/launch-intent-execute'
import { readWindowsConsoleOwner, windowsConsoleProbeScript } from './windows-pane-owner'
import { readWin32OneShot } from './process-tree'
import { terminateWindowsProcessTree } from './windows-process-tree'
import { isAgentPane } from '../shared/agents/pane-owner-predicate'
import type { CustomAgent } from '../shared/types'
import type { PreparedAgentLaunch, AgentLaunchDialect } from '../core/agent-launch'

const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const quote = (s: string) => `'${s.replace(/'/gu, "''")}'`
const neutralQuote = (s: string) => `"${s.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

interface InvocationIdentity { attemptId: string; sessionKey: string; rootPid: number; birth: string }
function readPrivateReceipt(file: string, expected: InvocationIdentity): (InvocationIdentity & { exitCode: number }) | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || value.attemptId !== expected.attemptId || value.sessionKey !== expected.sessionKey ||
      value.rootPid !== expected.rootPid || value.birth !== expected.birth || !Number.isInteger(value.exitCode)) return null
    return value
  } catch { return null }
}

function writeCmdCandidate(file: string, command: string): string {
  const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/]+=*)$/u)
  if (!encoded) throw new Error('Expected the real cmd planner PowerShell payload')
  const source = Buffer.from(encoded[1], 'base64').toString('utf16le')
  // The nested PowerShell process needs an explicit exit to retain the native status.
  const body = `$ErrorActionPreference = 'Stop'; try { ${source}; exit $LASTEXITCODE } catch { exit 1 }`
  const candidate = command.slice(0, -encoded[1].length) + Buffer.from(body, 'utf16le').toString('base64')
  writeFileSync(file, `@echo off\r\n${candidate}\r\nexit /b %errorlevel%\r\n`)
  return candidate
}

function shortHarness(dialect: AgentLaunchDialect, mode: 'file' | 'argv' | 'script-error' | 'native-error' | 'stdin-after-start') {
  const directory = testTmpDir('par230-f2-invocation-')
  const file = (name: string) => path.join(directory, name)
  const receiptFile = file('receipt.json')
  const launchId = randomUUID()
  const sessionKey = randomUUID()
  const spawned: number[] = []
  const commands: Array<{ command: string; chars: number; stdinAfterStart?: string }> = []
  const outputs: Array<{ code: number | null; stdout: string; stderr: string }> = []
  const observed = new Set<number>()
  let before: Set<number> | undefined
  const table = () => readWin32OneShot((exe, args, options, cb) => {
    const child = execFile(exe, args, { ...options, windowsHide: true }, (error, stdout) => cb(error, String(stdout)))
    if (child.pid) observed.add(child.pid)
  }, process.env)
  const custom: CustomAgent = {
    id: 'custom:par230', label: 'PAR230 invocation', baseAgent: 'claude',
    launchCmd: `${neutralQuote(process.execPath)} ${neutralQuote(file('cli.cjs'))}${mode === 'file' ? ` --brief-file ${neutralQuote(file('brief.md'))}` : ''}`,
    promptInjectionMode: mode === 'stdin-after-start' ? 'stdin-after-start' : 'argv'
  }
  writeFileSync(file('cli.cjs'), [
    "const fs = require('node:fs');",
    `const dir = ${JSON.stringify(directory)};`,
    "const argv = process.argv.slice(2);",
    "fs.writeFileSync(dir+'/received.json', JSON.stringify({pid:process.pid,argv,brief:argv[0]==='--brief-file'?fs.readFileSync(argv[1],'utf8'):argv[0]}));",
    'process.exitCode = 23;'
  ].join('\n'))
  if (mode === 'script-error') {
    writeFileSync(file('throw.ps1'), '\uFEFFthrow "par230 isolated invocation error"')
    custom.launchCmd = neutralQuote(file('throw.ps1'))
  }
  if (mode === 'native-error') {
    writeFileSync(file('invalid.exe'), 'par230 invalid executable fixture')
    custom.launchCmd = neutralQuote(file('invalid.exe'))
  }
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => cleanupPromise ??= (async () => {
    if (before) {
      const rows = await table()
      const own = new Set([process.pid])
      let added = true
      while (added) {
        added = false
        for (const row of rows) if (own.has(row.ppid) && !before.has(row.pid) && !own.has(row.pid)) {
          own.add(row.pid); observed.add(row.pid); added = true
        }
      }
    }
    for (const pid of spawned) if (alive(pid)) await terminateWindowsProcessTree(pid)
    for (const pid of observed) if (alive(pid)) await terminateWindowsProcessTree(pid)
    expect([...spawned, ...observed].filter(alive)).toEqual([])
  })()
  onTestFinished(cleanup)
  const execute = async (_name: string, attemptId: string, plan: PreparedAgentLaunch) => {
    before = new Set((await table()).map(row => row.pid))
    commands.push({ command: plan.command, chars: plan.command.length, stdinAfterStart: plan.stdinAfterStart })
    if (dialect === 'cmd') writeCmdCandidate(file('planned.cmd'), plan.command)
    writeFileSync(file('invoke.ps1'), '\uFEFF' + [
      "$ErrorActionPreference = 'Stop'", '$status = 1', '$invocationError = $false',
      'try {', `  ${dialect === 'cmd' ? '& $env:ComSpec /d /v:off /c .\\planned.cmd' : plan.command}`,
      '  $status = $LASTEXITCODE',
      '} catch { $invocationError = $true; $status = 1 } finally {',
      `  $r = @{attemptId=${quote(attemptId)}; sessionKey=${quote(sessionKey)}; rootPid=$PID; birth=(Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString('o'); exitCode=$status; invocationError=$invocationError}`,
      `  [IO.File]::WriteAllText(${quote(receiptFile)}, ($r | ConvertTo-Json -Compress))`,
      '  $global:LASTEXITCODE = $status', '}',
      `  [IO.File]::WriteAllText(${quote(file('returned.json'))}, ($LASTEXITCODE | ConvertTo-Json))`,
      dialect === 'cmd' ? 'exit $status' : ''
    ].join('\r\n'))
    const child = spawn(dialect === 'pwsh' ? 'pwsh.exe' : PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file('invoke.ps1')], {
      cwd: directory, windowsHide: true
    })
    if (child.pid) spawned.push(child.pid)
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += String(data) })
    child.stderr.on('data', data => { stderr += String(data) })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    outputs.push({ code, stdout, stderr })
    return { status: 'executed' as const }
  }
  const deps: LaunchIntentDeps = {
    platform: 'win32', customAgents: () => [custom], sharedIdentityAvailable: async () => false,
    codexCaps: async () => ({ approvalValues: null, noDaemon: null }), exists: existsSync,
    systemRoot: process.env.SystemRoot, readPromptFile: readPromptFileBounded,
    isProtocolIncompatible: () => false, execute
  }
  const target = { name: 'par230-isolated', sessionHost: true, remote: false, launchDialect: dialect, agentId: custom.id, pathValue: directory }
  const request = { launchId, intent: { kind: 'agent' as const, action: 'start' as const, agentId: custom.id } }
  const evidence = async (name: string, extra: Record<string, unknown>) => {
    await cleanup()
    if (process.env.PAR230_F2_EVIDENCE_DIR) writeFileSync(path.join(process.env.PAR230_F2_EVIDENCE_DIR, `${name}-${dialect}.json`),
      JSON.stringify({ mode, dialect, launchId, sessionKey, commands, outputs, spawned, observed: [...observed], survivors: [...spawned, ...observed].filter(alive), ...extra }, null, 2))
  }
  return { file, custom, receiptFile, target, request, deps, commands, spawned, evidence }
}

describe.runIf(process.platform === 'win32')('PAR-230 F2 correlated invocation candidate in an isolated shell', { timeout: 30_000 }, () => {
  const cases = (['pwsh', 'windows-powershell', 'cmd'] as const).flatMap(dialect =>
    (['powershell-script', 'native'] as const).map(entrypoint => ({ dialect, entrypoint })))
  it.each(cases)('T13 $dialect $entrypoint stays pending in shell initialization and a child tool, then records the exact return', async ({ dialect, entrypoint }) => {
    const directory = testTmpDir('par230-f2-invocation-')
    const file = (name: string) => path.join(directory, name)
    const attemptId = randomUUID()
    const sessionKey = randomUUID()
    const receipt = file('receipt.json')
    const brief = `Ação "literal" it's 開発 🧪 $env:HOME \`tick\n$(Set-Content -LiteralPath ${quote(file('injected'))} -Value BAD) & | < > % ^ ! trailing\\`
    const flattened = brief.replace(/\s+/gu, ' ').trim()
    writeFileSync(file('brief.md'), brief)
    writeFileSync(file('package.json'), JSON.stringify({ name: 'par230-invocation', bin: { 'par230-invocation': 'cli.cjs' } }))
    writeFileSync(file('cli.cjs'), [
      "const fs = require('node:fs'); const {spawn} = require('node:child_process');",
      `const dir = ${JSON.stringify(directory)};`,
      "const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d','/q'], {stdio:'inherit',windowsHide:true});",
      "const w = fs.watch(dir, () => { if (fs.existsSync(dir+'/stop')) { w.close(); child.kill(); } });",
      "child.once('exit', () => process.exit(23));",
      `const argv = ${entrypoint === 'powershell-script' ? "JSON.parse(fs.readFileSync(dir+'/script-argv.json','utf8').replace(/^\\uFEFF/,''))" : 'process.argv.slice(2)'};`,
      "child.once('spawn', () => fs.writeFileSync(dir+'/ready.json', JSON.stringify({pid:process.pid,child:child.pid,argv})));"
    ].join('\n'))
    writeFileSync(file('claude.ps1'), '\uFEFF' + [
      'param([Parameter(ValueFromRemainingArguments=$true)][string[]] $Rest)',
      `[IO.File]::WriteAllText(${quote(file('script-argv.json'))}, (ConvertTo-Json -Compress -InputObject @($Rest)))`,
      `& ${quote(process.execPath)} ${quote(file('cli.cjs'))}`
    ].join('\r\n'))
    const custom: CustomAgent = {
      id: 'custom:par230', label: 'PAR230 invocation', baseAgent: 'claude', promptInjectionMode: 'argv',
      launchCmd: entrypoint === 'native'
        ? `${neutralQuote(process.execPath)} ${neutralQuote(file('cli.cjs'))}`
        : neutralQuote(file('claude.ps1'))
    }

    const watchers = new Set<FSWatcher>()
    const observed = new Set<number>()
    const records: unknown[] = []
    const appears = async (name: string) => {
      if (existsSync(file(name))) return
      await new Promise<void>((resolve, reject) => {
        const w = watch(directory, () => { if (existsSync(file(name))) { w.close(); resolve() } })
        watchers.add(w)
        w.once('error', reject)
        if (existsSync(file(name))) { w.close(); resolve() }
      })
    }
    const table = () => readWin32OneShot((exe, args, options, cb) => {
      const child = execFile(exe, args, { ...options, windowsHide: true }, (err, out) => cb(err, String(out)))
      if (child.pid) observed.add(child.pid)
    }, process.env)
    const before = new Set((await table()).map((r) => r.pid))
    const captureOwnTree = async () => {
      const rows = await table()
      const own = new Set([process.pid])
      let added = true
      while (added) {
        added = false
        for (const row of rows) if (own.has(row.ppid) && !own.has(row.pid) && !before.has(row.pid)) {
          own.add(row.pid); observed.add(row.pid); added = true
        }
      }
    }
    const shell = dialect === 'cmd' ? (process.env.ComSpec ?? 'cmd.exe') : dialect === 'pwsh' ? 'pwsh.exe' : PS
    const term = pty.spawn(shell, dialect === 'cmd' ? ['/d', '/q', '/v:off'] : ['-NoLogo', '-NoProfile', '-NoExit'], {
      name: 'xterm-256color', cols: 120, rows: 36, cwd: directory, env: process.env as Record<string, string>
    })
    observed.add(term.pid)
    const subscription = term.onData(() => {})
    let exited = false
    const exit = new Promise<void>((resolve) => term.onExit(() => { exited = true; resolve() }))
    let cleanup: Promise<void> | undefined
    const teardown = () => cleanup ??= (async () => {
      await captureOwnTree()
      if (alive(term.pid)) await terminateWindowsProcessTree(term.pid)
      if (!exited) await exit
      subscription.dispose()
      for (const w of watchers) w.close()
      const afterRoot = [...observed].filter(alive)
      for (const pid of afterRoot) await terminateWindowsProcessTree(pid)
      const survivors = [...observed].filter(alive)
      if (process.env.PAR230_F2_EVIDENCE_DIR) writeFileSync(
        path.join(process.env.PAR230_F2_EVIDENCE_DIR, `invocation-${dialect}-${entrypoint}.json`),
        JSON.stringify({ dialect, entrypoint, attemptId, sessionKey, rootPid: term.pid, records, observed: [...observed], afterRoot, survivors }, null, 2)
      )
      expect(survivors).toEqual([])
    })()
    onTestFinished(teardown)
    const began = performance.now()
    const probe = async () => {
      const owner = await readWindowsConsoleOwner(term.pid, sessionKey, { request: async () => {
        const script = windowsConsoleProbeScript(term.pid)
        const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
        if (child.pid) observed.add(child.pid)
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => { stdout += String(d) })
        child.stderr.on('data', (d) => { stderr += String(d) })
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)))
        })
        return { kind: 'ok', result: JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()) }
      } })
      records.push({ ms: performance.now() - began, owner, receiptExists: existsSync(receipt) })
      return owner
    }
    try {
      const initial = await probe()
      expect(initial?.processBirths?.[0]).toEqual(expect.any(String))
      const identity = { attemptId, sessionKey, rootPid: term.pid, birth: initial!.processBirths![0] }
      const deps: LaunchIntentDeps = {
        platform: 'win32', customAgents: () => [custom], sharedIdentityAvailable: async () => false,
        codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
        exists: existsSync, systemRoot: process.env.SystemRoot,
        readPromptFile: readPromptFileBounded, isProtocolIncompatible: () => false,
        execute: async (_name, launchId, plan) => {
          if (dialect === 'cmd') records.push({ cmdCandidate: writeCmdCandidate(file('planned.cmd'), plan.command) })
          writeFileSync(file('invoke.ps1'), '\uFEFF' + [
            '$status = 1',
            'try {',
            `  $gate = New-Object IO.FileSystemWatcher(${quote(directory)})`,
            '  $gate.EnableRaisingEvents = $true',
            `  [IO.File]::WriteAllText(${quote(file('initializing'))}, 'ready')`,
            `  while (-not [IO.File]::Exists(${quote(file('continue'))})) { $null = $gate.WaitForChanged([IO.WatcherChangeTypes]::Created) }`,
            '  $gate.Dispose()',
            `  ${dialect === 'cmd' ? '& $env:ComSpec /d /v:off /c .\\planned.cmd' : plan.command}`,
            '  $status = $LASTEXITCODE',
            '} finally {',
            `  $r = @{attemptId=${quote(launchId)}; sessionKey=${quote(sessionKey)}; rootPid=${term.pid}; birth=(Get-CimInstance Win32_Process -Filter "ProcessId = ${term.pid}").CreationDate.ToUniversalTime().ToString('o'); invocationPid=$PID; exitCode=$status}`,
            `  [IO.File]::WriteAllText(${quote(receipt)}, ($r | ConvertTo-Json -Compress))`,
            '  $global:LASTEXITCODE = $status',
            '}',
            `[IO.File]::WriteAllText(${quote(file('returned.json'))}, ($LASTEXITCODE | ConvertTo-Json))`,
            dialect === 'cmd' ? 'exit $status' : ''
          ].join('\r\n'))
          records.push({ command: plan.command, stdinAfterStart: plan.stdinAfterStart ?? null })
          term.write(dialect === 'cmd'
            ? `"${PS}" -NoLogo -NoProfile -File "${file('invoke.ps1')}"\r`
            : `& ${quote(file('invoke.ps1'))}\r`)
          return { status: 'executed' }
        }
      }
      const result = await executeLaunchIntent({
        name: 'par230-isolated', sessionHost: true, remote: false,
        launchDialect: dialect, agentId: custom.id, pathValue: directory
      }, { launchId: attemptId, intent: { kind: 'agent', action: 'start', agentId: custom.id }, promptFile: file('brief.md') }, deps)
      expect(result).toEqual({ ok: true })
      await appears('initializing')
      const initializing = await probe()
      expect(initializing?.panePid).toBe(initial?.panePid)
      expect(initializing?.command).toMatch(/^(pwsh|powershell)(?:\.exe)?$/u)
      expect(existsSync(receipt)).toBe(false)
      expect(readPrivateReceipt(receipt, identity)).toBeNull()
      writeFileSync(file('continue'), '')
      await appears('ready.json')
      const cli = JSON.parse(readFileSync(file('ready.json'), 'utf8')) as { pid: number; child: number; argv: string[] }
      observed.add(cli.pid)
      observed.add(cli.child)
      await captureOwnTree()
      const running = await probe()
      expect(isAgentPane(running, 'custom:par230', ['par230-invocation'])).toBe('agent')
      expect(alive(cli.child)).toBe(true)
      expect(existsSync(receipt)).toBe(false)
      expect(readPrivateReceipt(receipt, identity)).toBeNull()
      writeFileSync(file('stop'), '')
      await appears('returned.json')
      const completed = JSON.parse(readFileSync(receipt, 'utf8'))
      records.push({ cli, completed, returned: JSON.parse(readFileSync(file('returned.json'), 'utf8')), injected: existsSync(file('injected')) })
      expect(completed).toMatchObject({ attemptId, sessionKey, rootPid: term.pid, exitCode: 23 })
      expect(completed.birth).toBe(initial?.processBirths?.[0])
      expect(readPrivateReceipt(receipt, identity)).toEqual(completed)
      for (const foreign of [
        { ...completed, attemptId: randomUUID() }, { ...completed, sessionKey: randomUUID() },
        { ...completed, rootPid: process.pid }, { ...completed, birth: 'different-process-birth' }
      ]) {
        writeFileSync(receipt, JSON.stringify(foreign))
        expect(readPrivateReceipt(receipt, identity)).toBeNull()
      }
      writeFileSync(receipt, 'unreadable receipt')
      expect(readPrivateReceipt(receipt, identity)).toBeNull()
      writeFileSync(receipt, JSON.stringify(completed))
      expect(readPrivateReceipt(receipt, { ...identity, attemptId: randomUUID() })).toBeNull()
      records.push({ privateHarnessReceiptChecks: 'same identity accepted; foreign attempt/session/root/birth and replacement rejected; no host consumer asserted' })
      expect(existsSync(file('injected'))).toBe(false)
      expect(JSON.parse(readFileSync(file('returned.json'), 'utf8'))).toBe(23)
      let final = await probe()
      await expect.poll(async () => {
        if (alive(cli.pid)) final = await probe()
        return !alive(cli.pid) && !alive(cli.child)
      }, { timeout: 30_000 }).toBe(true)
      expect(final?.paneId).toBe(initial?.paneId)
      expect(final?.panePid).toBe(initial?.panePid)
      await expect.poll(async () => { final = await probe(); return final?.command }, { timeout: 30_000 })
        .toMatch(dialect === 'cmd' ? /^cmd(?:\.exe)?$/u : /^(pwsh|powershell)(?:\.exe)?$/u)
      if (dialect === 'cmd') {
        term.write(`echo %errorlevel%>"${file('root-exit.txt')}"\r`)
        await appears('root-exit.txt')
        const rootExitCode = Number(readFileSync(file('root-exit.txt'), 'utf8').trim())
        records.push({ rootExitCode })
        expect(rootExitCode).toBe(23)
      }
      expect(cli.argv).toEqual([flattened])
    } finally {
      await teardown()
    }
  })
})

describe.runIf(process.platform === 'win32')('PAR-230 F2 private file candidate and invocation boundaries', { timeout: 30_000 }, () => {
  it.each(['pwsh', 'windows-powershell', 'cmd'] as const)('T10 %s prototype delivers a long literal by file without placing its contents in native argv', async dialect => {
    const h = shortHarness(dialect, 'file')
    const brief = `開発 "literal" it's $env:HOME \`tick\n$(Set-Content -LiteralPath ${quote(h.file('injected'))} -Value BAD) &|<>%^!\n`.repeat(400)
    writeFileSync(h.file('brief.md'), brief)
    expect(brief.length).toBeGreaterThan(32_767)
    expect(Buffer.byteLength(brief)).toBeLessThan(128 * 1024)
    expect(await readPromptFileBounded(h.file('brief.md'), 128 * 1024)).toBe(brief)
    const result = await executeLaunchIntent(h.target, h.request, h.deps)
    const received = JSON.parse(readFileSync(h.file('received.json'), 'utf8'))
    const receipt = JSON.parse(readFileSync(h.receiptFile, 'utf8'))
    await h.evidence('long-file-prototype', { result, received, receipt, utf16Units: brief.length, utf8Bytes: Buffer.byteLength(brief) })
    expect(result).toEqual({ ok: true })
    expect(received.argv).toEqual(['--brief-file', h.file('brief.md')])
    expect(received.brief).toBe(brief)
    expect(h.commands).toHaveLength(1)
    expect(h.commands[0].chars).toBeLessThan(32_767)
    expect(h.commands[0].command).not.toContain(brief)
    expect(receipt).toMatchObject({ attemptId: h.request.launchId, exitCode: 23 })
    expect(JSON.parse(readFileSync(h.file('returned.json'), 'utf8'))).toBe(23)
    expect(alive(received.pid)).toBe(false)
    expect(existsSync(h.file('injected'))).toBe(false)
  })

  it('T10 moving a long literal into a shell file cannot make an argv-only native CLI cross CreateProcessW', async () => {
    const h = shortHarness('pwsh', 'argv')
    const brief = '開発 "literal" '.repeat(4_000).trim()
    writeFileSync(h.file('brief.md'), brief)
    expect(await readPromptFileBounded(h.file('brief.md'), 128 * 1024)).toBe(brief)
    const result = spawnSync(process.execPath, [h.file('cli.cjs'), brief], { encoding: 'utf8', windowsHide: true })
    const spawnError = result.error as NodeJS.ErrnoException | undefined
    await h.evidence('native-argv-boundary', {
      utf16Units: brief.length, utf8Bytes: Buffer.byteLength(brief),
      executable: process.execPath, argumentPrefix: h.file('cli.cjs'),
      pid: result.pid, status: result.status, error: spawnError && { code: spawnError.code, message: spawnError.message }
    })
    expect(spawnError?.code).toBe('ENAMETOOLONG')
    expect(result.status).toBeNull()
    expect(existsSync(h.file('received.json'))).toBe(false)
    expect(existsSync(h.receiptFile)).toBe(false)
  })

  for (const dialect of ['pwsh', 'windows-powershell', 'cmd'] as const) {
    it.each(['script-error', 'native-error'] as const)(`T13 ${dialect} %s completes its own receipt after the failed invocation`, async mode => {
      const h = shortHarness(dialect, mode)
      const result = await executeLaunchIntent(h.target, h.request, h.deps)
      const receipt = JSON.parse(readFileSync(h.receiptFile, 'utf8'))
      await h.evidence(`error-${mode}`, { result, receipt })
      expect(result).toEqual({ ok: true })
      expect(receipt).toMatchObject({ attemptId: h.request.launchId, exitCode: 1 })
      expect(JSON.parse(readFileSync(h.file('returned.json'), 'utf8'))).toBe(1)
      expect(existsSync(h.file('received.json'))).toBe(false)
    })

    it(`T13 ${dialect} a shell spawn error is delivery-failed and produces no command-finished receipt`, async () => {
      const h = shortHarness(dialect, 'argv')
      let spawnError: string | undefined
      h.deps.execute = async () => {
        const child = spawn(h.file('missing-shell.exe'), [], { windowsHide: true })
        await new Promise<void>((resolve, reject) => {
          child.once('error', error => { spawnError = (error as NodeJS.ErrnoException).code; reject(error) })
          child.once('close', () => resolve())
        })
        throw new Error('missing executable unexpectedly started')
      }
      const result = await executeLaunchIntent(h.target, h.request, h.deps)
      await h.evidence('shell-spawn-error', { result, spawnError })
      expect(spawnError).toBe('ENOENT')
      expect(result).toMatchObject({ ok: false, reason: 'delivery-failed' })
      expect(existsSync(h.receiptFile)).toBe(false)
      expect(existsSync(h.file('received.json'))).toBe(false)
    })

    it(`T10 ${dialect} refuses stdinAfterStart without a trusted child-readiness handshake`, async () => {
      const h = shortHarness(dialect, 'stdin-after-start')
      writeFileSync(h.file('brief.md'), 'literal "brief" $env:HOME')
      const result = await executeLaunchIntent(h.target, { ...h.request, promptFile: h.file('brief.md') }, h.deps)
      await h.evidence('stdin-after-start-refusal', { result })
      expect(result).toMatchObject({ ok: false, reason: 'unsupported-shell' })
      expect(h.commands).toEqual([])
      expect(h.spawned).toEqual([])
      expect(existsSync(h.receiptFile)).toBe(false)
    })
  }
})
