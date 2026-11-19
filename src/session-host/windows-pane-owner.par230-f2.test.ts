import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../core/test-tmp'
import { isAgentPane } from '../shared/agents/pane-owner-predicate'
import { readWindowsConsoleOwner, windowsConsoleProbeScript } from './windows-pane-owner'
import { terminateWindowsProcessTree } from './windows-process-tree'
import { readWin32OneShot, type ProcRow } from './process-tree'

const REAL_SHELL_BUDGET = 30_000
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const quote = (s: string): string => `'${s.replace(/'/gu, "''")}'`

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function fileAppears(directory: string, file: string, watchers: Set<FSWatcher>): Promise<void> {
  if (existsSync(file)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, () => {
      if (existsSync(file)) { watcher.close(); resolve() }
    })
    watchers.add(watcher)
    watcher.once('error', (error) => { watcher.close(); reject(error) })
    if (existsSync(file)) { watcher.close(); resolve() }
  })
}

describe.runIf(process.platform === 'win32')('PAR-230 F2 Windows tree probe without a renderer', { timeout: REAL_SHELL_BUDGET }, () => {
  it('observes the same shell generation before, during and after a simulated CLI with a child shell', async () => {
    const directory = testTmpDir('par230-f2-tree-')
    const cliFile = path.join(directory, 'cli.cjs')
    const ready = path.join(directory, 'ready.json')
    const stopped = path.join(directory, 'stopped.json')
    const stop = path.join(directory, 'stop')
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name: 'par230-fixture', bin: { 'par230-fixture': 'cli.cjs' }
    }))
    writeFileSync(cliFile, [
      "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
      `const dir = ${JSON.stringify(directory)};`,
      "const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q'], { stdio: 'inherit', windowsHide: true });",
      "const watcher = fs.watch(dir, () => { if (fs.existsSync(dir + '/stop')) { watcher.close(); child.kill(); } });",
      "child.once('exit', () => { fs.writeFileSync(dir + '/stopped.json', JSON.stringify({pid:process.pid, child:child.pid})); process.exit(0); });",
      "fs.writeFileSync(dir + '/ready.json', JSON.stringify({pid:process.pid, child:child.pid}));"
    ].join('\n'))

    const observedPids = new Set<number>()
    const watchers = new Set<FSWatcher>()
    const records: Array<Record<string, unknown>> = []
    const table = () => readWin32OneShot((file, args, options, cb) => {
      const child = execFile(file, args, { ...options, windowsHide: true }, (error, stdout) => cb(error, String(stdout)))
      if (child.pid) observedPids.add(child.pid)
    }, process.env)
    const before = new Set((await table()).map((row) => row.pid))
    const ownedTree: ProcRow[] = []
    const startedAt = performance.now()
    const term = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NoExit'], {
      name: 'xterm-256color', cols: 120, rows: 36, cwd: directory, env: process.env as Record<string, string>
    })
    observedPids.add(term.pid)
    const output = term.onData(() => {})
    let exited = false
    const onExit = new Promise<void>((resolve) => term.onExit(() => { exited = true; resolve() }))
    const observe = async () => {
      const began = performance.now()
      const owner = await readWindowsConsoleOwner(term.pid, 'par230-f2-generation', {
        request: async () => {
          const script = windowsConsoleProbeScript(term.pid)
          const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
          if (child.pid) observedPids.add(child.pid)
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (data) => { stdout += String(data) })
          child.stderr.on('data', (data) => { stderr += String(data) })
          await new Promise<void>((resolve, reject) => {
            child.once('error', reject)
            child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`probe exit ${code}: ${stderr}`)))
          })
          return { kind: 'ok', result: JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()) }
        }
      })
      records.push({ atMs: performance.now() - startedAt, probeMs: performance.now() - began, owner })
      return owner
    }

    try {
      const initial = await observe()
      expect(initial?.command).toMatch(/^pwsh(?:\.exe)?$/u)
      expect(isAgentPane(initial, 'custom:par230', ['par230-fixture'])).toBe('not-agent')
      term.write(`& ${quote(process.execPath)} ${quote(cliFile)}\r`)
      await fileAppears(directory, ready, watchers)
      const fixturePids = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; child: number }
      observedPids.add(fixturePids.pid)
      observedPids.add(fixturePids.child)
      const rows = await table()
      const descendants = new Set([process.pid])
      let added = true
      while (added) {
        added = false
        for (const row of rows) {
          if (descendants.has(row.ppid) && !descendants.has(row.pid) && !before.has(row.pid)) {
            descendants.add(row.pid)
            observedPids.add(row.pid)
            ownedTree.push(row)
            added = true
          }
        }
      }
      const running = await observe()
      expect(alive(fixturePids.child)).toBe(true)
      expect(isAgentPane(running, 'custom:par230', ['par230-fixture'])).toBe('agent')
      expect(running?.pids).toEqual([fixturePids.pid])

      const exitRequestedAt = performance.now()
      writeFileSync(stop, '')
      await fileAppears(directory, stopped, watchers)
      let final = await observe()
      if (!/^pwsh(?:\.exe)?$/u.test(final?.command ?? '')) {
        await expect.poll(async () => {
          final = await observe()
          return final?.command
        }, { timeout: REAL_SHELL_BUDGET }).toMatch(/^pwsh(?:\.exe)?$/u)
      }
      const firstProvenShellAfterExitMs = performance.now() - exitRequestedAt
      expect(final?.paneId).toBe(initial?.paneId)
      expect(final?.panePid).toBe(initial?.panePid)
      expect(alive(fixturePids.pid)).toBe(false)
      expect(alive(fixturePids.child)).toBe(false)
      records.push({ exitRequestedMs: exitRequestedAt - startedAt, firstProvenShellAfterExitMs })
    } finally {
      if (alive(term.pid)) await terminateWindowsProcessTree(term.pid)
      if (!exited) await onExit
      output.dispose()
      for (const watcher of watchers) watcher.close()
      const remainingAfterRootKill = [...observedPids].filter(alive)
      for (const pid of remainingAfterRootKill) await terminateWindowsProcessTree(pid)
      const survivors = [...observedPids].filter(alive)
      const evidence = { rootPid: term.pid, ownedTree, observedPids: [...observedPids], records, remainingAfterRootKill, survivors }
      if (process.env.PAR230_F2_EVIDENCE_DIR) {
        writeFileSync(path.join(process.env.PAR230_F2_EVIDENCE_DIR, 'tree.json'), JSON.stringify(evidence, null, 2))
      }
      expect(survivors).toEqual([])
    }
  })
})
