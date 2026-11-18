import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalEmulator } from '../../src/session-host/terminal-emulator'
import { readClaudeComposer, readClaudeDraft, readClaudeScreen } from '../../src/shared/agents/claude-screen'
import captured from '../../src/shared/agents/__fixtures__/claude/composer-capture.json'

const dialog = [
  '─'.repeat(100), ' Accessing workspace:', ' ~/project',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  " well-known open source project, or work from your team). If not, take a moment to review what's in",
  ' this folder first.', " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide', ' ❯ No, exit', '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel'
].join('\n')
const emulators: TerminalEmulator[] = []
afterEach(() => { for (const emulator of emulators.splice(0)) emulator.dispose() })

const screens = [
  ...Object.entries(captured.screens).map(([name, screen]) => ({ name, screen })),
  { name: 'folder-trust', screen: dialog }
]
const cases = screens.flatMap((item) => ['lines', 'cursor'].map((paint) => ({ ...item, paint })))

describe('PAR-230 ajuste 54: Claude readers on actual host captureVisible frames', () => {
  it.each(cases)('preserves $name interpretation after $paint replay', async ({ name, screen, paint }) => {
    const lines = stripVTControlCharacters(screen).split('\n')
    const cols = lines.find((line) => /^─+$/.test(line))!.length
    const emulator = new TerminalEmulator({ cols, rows: lines.length, scrollback: lines.length })
    emulators.push(emulator)
    const replay = paint === 'lines' ? screen.replace(/\n/g, '\r\n') : screen.split('\n')
      .map((line, row) => stripVTControlCharacters(line) ? `\x1b[${row + 1};1H${line}` : '').join('')
    await emulator.write('\x1b[?2004h' + replay)
    const frame = emulator.captureVisible().screen
    const original = { screen: readClaudeScreen(screen).kind, composer: readClaudeComposer(screen), draft: readClaudeDraft(screen) }
    const replayed = { screen: readClaudeScreen(frame).kind, composer: readClaudeComposer(frame), draft: readClaudeDraft(frame) }
    console.info(JSON.stringify({ name, paint, cols, rows: lines.length, original, replayed,
      controls: frame.match(/\x1b\[[0-9;?]*[A-Za-ln-z]/g) ?? [] }))
    expect(replayed).toEqual(original)
  })
})
