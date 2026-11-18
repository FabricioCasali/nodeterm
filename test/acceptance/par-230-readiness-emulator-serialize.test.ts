import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { TerminalEmulator } from '../../src/session-host/terminal-emulator'
import { readClaudeComposer, readClaudeDraft, readClaudeScreen } from '../../src/shared/agents/claude-screen'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

const read = (screen: string) => ({ kind: readClaudeScreen(screen).kind, composer: readClaudeComposer(screen), draft: readClaudeDraft(screen) })
const dialog = ['─'.repeat(81), ' Accessing workspace:', ' ~/project', ' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n')
describe('PAR-230 55 real emulator captureVisible and serialize(0)', () => {
  it.each(Object.entries(captured.screens))('preserves %s in both real emulator outputs at ConPTY fixture geometry', async (_name, screen) => {
    const terminal = new TerminalEmulator({ cols: 160, rows: 60, scrollback: 100 })
    try {
      await terminal.write(screen.replaceAll('\n', '\r\n') + '\x1b[?2004h')
      expect(read(terminal.captureVisible().screen)).toEqual(read(screen))
      expect(read(terminal.serialize(0))).toEqual(read(screen))
    } finally { terminal.dispose() }
  })
  it.each(['dialog', 'style-loss', 'unknown'] as const)('does not mistake %s for an empty composer', async (negative) => {
    const terminal = new TerminalEmulator({ cols: 160, rows: 60, scrollback: 100 })
    try {
      const input = negative === 'dialog' ? dialog : negative === 'style-loss' ? stripVTControlCharacters(captured.screens.empty) : 'unreadable output'
      await terminal.write(input.replaceAll('\n', '\r\n'))
      for (const screen of [terminal.captureVisible().screen, terminal.serialize(0)]) {
        expect(readClaudeComposer(screen)).not.toBe('empty')
        if (negative === 'dialog') expect(readClaudeScreen(screen).kind).toBe('dialog')
      }
    } finally { terminal.dispose() }
  })
})
