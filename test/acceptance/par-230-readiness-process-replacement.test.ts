import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeWindowsPane } from '../../src/core/native-windows-pane'
import type { PaneOwner } from '../../src/shared/agents/pane-owner-predicate'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

const owner: PaneOwner = { panePid: 10, paneId: 'win32:g:root-birth', tty: 'win32-console:10', command: 'claude', argv: ['claude'], pids: [20], processBirths: ['agent-birth'] }
const panes: NativeWindowsPane[] = []
afterEach(() => { for (const pane of panes.splice(0)) pane.dispose() })

describe('PAR-230 R4 real ConPTY adapter, simulated process replacement after paste', () => {
  it.each(['process-birth', 'generation'] as const)('does not send Enter when %s changes after the paste', async (change) => {
    let liveOwner = owner
    let pane: NativeWindowsPane
    const write = vi.fn((data: string) => {
      const match = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
      if (!match) return
      pane.recordOutput('\x1b[2J\x1b[H' + captured.screens.draft.replace('heb ik getest', match[1]).replaceAll('\n', '\r\n'))
      liveOwner = { ...owner, ...(change === 'process-birth' ? { processBirths: ['replacement-process'] } : { paneId: 'win32:g2:root-birth' }) }
    })
    const probe = vi.fn(async () => liveOwner)
    pane = new NativeWindowsPane({ pid: 10, write }, { cols: 160, rows: 60, scrollback: 100 }, probe, { wait: async () => {} })
    panes.push(pane)
    pane.recordOutput(captured.screens.empty.replaceAll('\n', '\r\n') + '\x1b[?2004h')
    const guard = { beforePaste: vi.fn(() => true), beforeSubmit: vi.fn(() => true) }
    const guarded = pane as unknown as { sendEnvelope(body: string, expected: PaneOwner, guard?: { beforePaste(screen: string): boolean; beforeSubmit(screen: string): boolean }): Promise<boolean> }
    expect(await guarded.sendEnvelope('task', owner, guard)).toBe(true)
    expect(write.mock.calls).toEqual([['\x1b[200~task\x1b[201~']])
    expect(probe.mock.calls.length).toBeGreaterThan(1)
  })
})
