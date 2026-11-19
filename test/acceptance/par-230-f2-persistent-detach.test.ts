import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Socket } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { HostSession } from '../../src/session-host/session'
import type { TerminalEmulator } from '../../src/session-host/terminal-emulator'
import { terminateWindowsProcessTree } from '../../src/session-host/windows-process-tree'

describe.runIf(process.platform === 'win32')('PAR-230 F2 T15 persistent HostSession detach', () => {
  it('detach keeps the actual root and child alive and removes only its subscriber', async () => {
    const childProgram = "setInterval(() => {}, 1000)"
    const program = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify({root:process.pid,child:child.pid}));setInterval(()=>{},1000)`
    const root = spawn(process.execPath, ['-e', program], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const pids = new Set<number>()
    if (root.pid) pids.add(root.pid)
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    onTestFinished(async () => {
      const errors: string[] = []
      for (const pid of pids) if (alive(pid)) {
        try { await terminateWindowsProcessTree(pid) } catch (error) { errors.push(String(error)) }
      }
      const survivors = [...pids].filter(alive)
      const evidence = process.env.PAR230_F2COVERAGE_EVIDENCE_DIR
      if (evidence) writeFileSync(path.join(evidence, 'persistent-detach-processes.json'), JSON.stringify({ pids: [...pids], survivors, errors }, null, 2))
      expect(survivors).toEqual([])
      expect(errors).toEqual([])
    })
    const identity = await new Promise<{ root: number; child: number }>((resolve, reject) => {
      let output = ''
      root.once('error', reject)
      root.once('exit', () => reject(new Error('persistent fixture exited before ready')))
      root.stdout.on('data', (data) => {
        output += String(data)
        if (output.includes('\n')) resolve(JSON.parse(output.trim()))
      })
    })
    pids.add(identity.child)
    expect(identity.root).toBe(root.pid)
    const kill = vi.fn(() => root.kill())
    const proc = { pid: root.pid!, kill, pause: vi.fn(), resume: vi.fn(), resize: vi.fn() } as unknown as IPty
    const term = { write: vi.fn(async () => {}), serialize: vi.fn(() => ''), resize: vi.fn(), dispose: vi.fn() } as unknown as TerminalEmulator
    const session = new HostSession('par230-f2-detach', { shell: process.execPath, args: [], cwd: '.', env: {}, cols: 80, rows: 24 }, 100, { proc, term })
    const subscriber = {} as Socket
    session.subscribers.add(subscriber)
    await session.detach(subscriber)
    expect(session.subscribers.size).toBe(0)
    expect(kill).not.toHaveBeenCalled()
    expect(alive(identity.root)).toBe(true)
    expect(alive(identity.child)).toBe(true)
  }, 20_000)
})
