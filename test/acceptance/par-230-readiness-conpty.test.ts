import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeWindowsPane } from '../../src/core/native-windows-pane'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import { readClaudeComposer, readClaudeScreen } from '../../src/shared/agents/claude-screen'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

type Guard = { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }
type GuardedPane = { sendEnvelope(body: string, owner: PaneOwner, guard?: Guard): Promise<boolean> }
const owner: PaneOwner = { panePid: 10, paneId: 'win32:generation-a:birth-root', tty: 'win32-console:10', command: 'claude', argv: ['claude'], pids: [20], processBirths: ['birth-agent'] }
const body = '--- NODETERM MESSAGE nonce ---\nbody\n--- END NODETERM MESSAGE nonce ---'
const panes: NativeWindowsPane[] = []

function fixture() {
  let pane: NativeWindowsPane
  let pasted = false
  let stillIdle = true
  const write = vi.fn((data: string) => {
    const match = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
    if (match) {
      pasted = true
      stillIdle = false
      pane.recordOutput('\x1b[2J\x1b[H' + captured.screens.draft.replace('heb ik getest', match[1].split('\n').join('\n  ')).replace(/\n/g, '\r\n'))
    }
  })
  pane = new NativeWindowsPane({ pid: 10, write }, { cols: 160, rows: 60, scrollback: 100 }, async () => owner, { wait: async () => {} })
  panes.push(pane)
  pane.recordOutput('\x1b[?2004h' + captured.screens.empty.replace(/\n/g, '\r\n'))
  return { pane: pane as GuardedPane, write, pasted: () => pasted, stillIdle: () => stillIdle }
}

afterEach(() => { for (const pane of panes.splice(0)) pane.dispose() })

describe('PAR-230 R3/R4/R5: direct ConPTY reaches actual paste and Enter', () => {
  it('honors a beforePaste refusal before emitting any byte', async () => {
    const f = fixture()
    const guard: Guard = { beforePaste: vi.fn(() => false), beforeSubmit: vi.fn(() => true) }
    expect(await f.pane.sendEnvelope(body, owner, guard)).toBe(false)
    expect(guard.beforePaste).toHaveBeenCalledTimes(1)
    expect(guard.beforeSubmit).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('reads current state after paste and withholds the actual Enter, preserving partial=true', async () => {
    const f = fixture()
    const guard: Guard = {
      beforePaste: vi.fn((screen) => f.stillIdle() && readClaudeComposer(screen) === 'empty'),
      beforeSubmit: vi.fn(() => f.stillIdle())
    }
    expect(await f.pane.sendEnvelope(body, owner, guard)).toBe(true)
    expect(f.pasted()).toBe(true)
    expect(guard.beforePaste).toHaveBeenCalledTimes(1)
    expect(guard.beforeSubmit).toHaveBeenCalledTimes(1)
    expect(f.write.mock.calls).toEqual([['\x1b[200~' + body + '\x1b[201~']])
  })

  it('calls both guards on fresh screens and submits exactly once when both approve', async () => {
    const f = fixture()
    const guard: Guard = {
      beforePaste: vi.fn((screen) => readClaudeComposer(screen) === 'empty'),
      beforeSubmit: vi.fn((screen) => readClaudeScreen(screen).kind === 'prompt' && screen.includes('--- END NODETERM MESSAGE nonce ---'))
    }
    expect(await f.pane.sendEnvelope(body, owner, guard)).toBe(true)
    expect(guard.beforePaste).toHaveBeenCalledTimes(1)
    expect(guard.beforeSubmit).toHaveBeenCalledTimes(1)
    expect(f.write.mock.calls).toEqual([['\x1b[200~' + body + '\x1b[201~'], ['\r']])
  })
})
