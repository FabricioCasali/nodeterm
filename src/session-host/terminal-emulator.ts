import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { clampEmulatorScrollback } from '../shared/scrollback'
import { activateTerminalWidths } from '../shared/terminal-width'

// @xterm/addon-serialize's published types are written against @xterm/xterm's (browser) Terminal,
// which has a superset of DOM-specific members @xterm/headless's Terminal lacks. The addon only
// ever touches buffer/modes/cols/rows at runtime — all present on the headless Terminal — so this
// is a real type mismatch between two packages that are runtime-compatible, not a runtime risk.

// The default terminal theme (`nodeterm-dark` in src/renderer/terminal/themes.ts), the colours a
// colour query is answered with. Per-session themes do not reach the host.
const COLOURS: Record<number, string> = { 10: '#e6e6e6', 11: '#1e1e1e', 12: '#ffffff' }

const xtermRgb = (hex: string): string =>
  'rgb:' + [1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2)).join('/')

/**
 * The reply to `OSC <ident> ; ? [; ? …]` (OSC 10 = foreground, 11 = background, 12 = cursor; each
 * extra `?` asks the next colour), in xterm's own `rgb:rrrr/gggg/bbbb` ST-terminated form. `null`
 * when the sequence sets a colour instead of asking, so xterm's own handler takes it.
 */
export function colourQueryReply(ident: number, data: string): string | null {
  const params = data.split(';')
  if (params.some((p, i) => p !== '?' || !COLOURS[ident + i])) return null
  return params.map((_, i) => `\x1b]${ident + i};${xtermRgb(COLOURS[ident + i])}\x1b\\`).join('')
}

const COLOUR_QUERY = /\x1b\](1[012])((?:;\?)+)(?:\x07|\x1b\\)/g
const COLOUR_PARTIAL = /^\x1b\](?:1(?:[012](?:;\??)*\x1b?)?)?$/
const MAX_COLOUR_CARRY = 24

/**
 * Synchronous OSC 10/11/12 colour-query scanner for PTY output chunks.
 * `@xterm/headless` defers `term.write()` parsing to a timer tick behind the session output queue,
 * which misses Codex's startup colour-query deadline on Windows.
 */
export class OscColourScanner {
  private carry = ''

  push(chunk: string): string[] {
    if (!chunk) return []
    const text = this.carry + chunk
    this.carry = ''
    if (text.indexOf('\x1b') === -1) return []
    const replies: string[] = []
    COLOUR_QUERY.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = COLOUR_QUERY.exec(text))) {
      const reply = colourQueryReply(Number(m[1]), m[2].slice(1))
      if (reply !== null) replies.push(reply)
    }
    const osc = text.lastIndexOf('\x1b]')
    if (osc !== -1 && text.length - osc <= MAX_COLOUR_CARRY && COLOUR_PARTIAL.test(text.slice(osc))) {
      this.carry = text.slice(osc)
    } else if (text.endsWith('\x1b')) {
      this.carry = '\x1b'
    }
    return replies
  }
}

/**
 * One session's server-side screen. This is the piece that makes the session host able to
 * reconstruct a fresh client's screen on attach WITHOUT itself being a "painter" the way a real
 * tmux client is — see docs/windows-session-host.md ("The seeding trap") before touching any of
 * this, and CLAUDE.md's "Seeding a fresh xterm" section for why a tmux-shaped answer here
 * (seed nothing on warm attach) would ship a blank terminal or duplicated screens depending on
 * which half you got wrong.
 *
 * MODE RESTORATION, VERIFIED NOT ASSUMED: xterm.js's own `SerializeAddon` already restores most
 * DEC private modes as part of its `serialize()` output (bracketed paste, application cursor
 * keys, origin mode, insert mode, reverse-wraparound, send-focus, wraparound, and — when the
 * active buffer is the alternate screen — the `?1049h` switch). Read directly from the compiled
 * `_serializeModes()` in `node_modules/@xterm/addon-serialize/lib/addon-serialize.js` rather than
 * assumed from the docs. It does NOT emit `CSI ?1006h` (SGR extended mouse coordinates) — there
 * is no separate field on the public `IModes` API for it to read; `modes.mouseTrackingMode` only
 * says which tracking PROTOCOL is on (x10/vt200/drag/any), not the coordinate ENCODING. This app
 * always turns mouse tracking on together with SGR (`CO_ATTACH_MOUSE_SEQ` in the renderer mirrors
 * real tmux's `mouse on`, which always pairs `?1000h`/`?1002h` with `?1006h`), so that one
 * sequence is appended by hand below whenever tracking is active. If a future xterm.js version
 * starts emitting it itself, appending it twice is a harmless idempotent DECSET, not a bug.
 */
export class TerminalEmulator {
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  private readonly defaultScrollback: number

  /**
   * `onColourReply`, when given, answers the pane app's OSC 10/11/12 colour queries from this
   * emulator, in the pty's own process. @xterm/headless parses those queries but never answers them
   * (it has no theme service); only the renderer's xterm did, a process hop away — late enough for
   * an app that stops waiting (Codex) to read the reply as typed text in its prompt.
   */
  constructor(opts: { cols: number; rows: number; scrollback: number; onColourReply?: (reply: string) => void }) {
    // Capped at the renderer's own xterm cap (`XTERM_SCROLLBACK_MAX`): xterm allocates every
    // buffered line at full width (cols × 12 B), and nothing past the renderer's cap is ever
    // shown. Clamped HERE as well as in core, because an older client still sends 50,000.
    this.defaultScrollback = clampEmulatorScrollback(opts.scrollback)
    this.term = new Terminal({
      cols: Math.max(1, opts.cols),
      rows: Math.max(1, opts.rows),
      scrollback: this.defaultScrollback,
      allowProposedApi: true
    })
    // The renderer's width table, not xterm's Unicode 6 default: this buffer is what a reattaching
    // viewer is repainted from, so a character it sizes differently from the viewer (an emoji, an
    // emoji + VS16) shifts every later column of that line in the repaint.
    try {
      activateTerminalWidths(this.term)
    } catch {
      // Fail open: xterm's default table, exactly as before the shared table existed.
    }
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon)
    const onColourReply = opts.onColourReply
    if (onColourReply) {
      for (const ident of [10, 11, 12]) {
        this.term.parser.registerOscHandler(ident, (data) => {
          const reply = colourQueryReply(ident, data)
          if (reply === null) return false
          try {
            onColourReply(reply)
          } catch {
            // A pty that is already gone; the parser must keep going.
          }
          return true
        })
      }
    }
  }

  /**
   * Feed one chunk of PTY output. Resolves once xterm has fully applied it — `Terminal.write`'s
   * own write queue can defer processing of a large chunk past the current tick, and a caller
   * that called `serialize()` without waiting for this would race a partially-applied write (the
   * screen it hands back could be missing the tail of what just arrived).
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows)
  }

  /**
   * The reconstructed screen: serialized content (scrollback capped at `scrollback`, defaulting
   * to this emulator's construction-time cap — smaller for `captureSession`'s "recent lines"
   * callers) plus the mode-restore/alt-buffer/cursor tail `SerializeAddon` already produces, with
   * the SGR-mouse gap above patched in by hand. Returns '' for a session that has never painted
   * anything (a cold session moments after spawn) — callers treat '' the same way the rest of
   * this app already treats an empty tmux capture: "nothing to seed", never a screen reset.
   */
  serialize(scrollback = this.defaultScrollback): string {
    let out = this.serializer.serialize({ scrollback: Math.max(0, scrollback) })
    if (this.term.modes.mouseTrackingMode !== 'none' && !out.includes('\x1b[?1006h')) {
      out += '\x1b[?1006h'
    }
    return out
  }

  /**
   * A live link's keyframe: the VISIBLE rows of the ACTIVE buffer only (never history), in the shape
   * `capture-pane -p -e` prints — SGR, one `\n`-terminated line per row — plus the viewport-relative
   * cursor and whether the alternate buffer is active.
   *
   * Built from `SerializeAddon` with `scrollback: 0` rather than by hand, so attributes, wide cells
   * and soft wraps encode exactly as the warm-attach replay does. Adjustments:
   *  - the ALTERNATE buffer: `serialize` always writes the normal buffer first and the alternate one
   *    after `CSI ?1049h CSI H`; a keyframe is the active screen only (the viewer switches buffers
   *    itself from `altScreen` BEFORE painting), so only the part after that marker is kept;
   *  - row separators: the addon joins rows with `\r\n`; a keyframe's contract is `\n`.
   * The private-mode tail (bracketed paste, application cursor keys, mouse) IS kept, after the last
   * row: unlike a tmux client, a viewer joining a session-host stream mid-way never saw the app
   * request them, and a Control viewer's keys encode by them. It is pure DECSET, so the viewer's
   * reset + clear paint is unaffected. The addon's trailing relative cursor restore is dropped (the
   * viewer places the cursor absolutely from `cursor`).
   */
  captureVisible(): { screen: string; cursor: { x: number; y: number }; altScreen: boolean } {
    const buffer = this.term.buffer.active
    const altScreen = buffer.type === 'alternate'
    const bare = this.serializer.serialize({ scrollback: 0, excludeModes: true })
    // `serialize` appends the mode tail LAST, so the difference of the two answers is exactly it.
    const withModes = this.serialize(0)
    const modes = withModes.startsWith(bare) ? withModes.slice(bare.length) : ''
    const ALT = '\x1b[?1049h\x1b[H'
    const altAt = bare.indexOf(ALT)
    const screenPart = altScreen ? (altAt === -1 ? '' : bare.slice(altAt + ALT.length)) : altAt === -1 ? bare : bare.slice(0, altAt)
    const body = screenPart
      .replace(/\r\n/g, '\n')
      // The addon's trailing RELATIVE cursor restore (CUU/CUD/CUF/CUB after the last row) is dropped:
      // the keyframe carries the cursor absolutely, and a relative move followed by the row's `\n`
      // could scroll the viewer. A row itself never ends in one (a gap is only emitted before a
      // following character), so only the tail matches. The pen-style SGR after it is kept.
      // eslint-disable-next-line no-control-regex
      .replace(/(?:\x1b\[\d+[ABCD])+((?:\x1b\[[\d;]*m)?)$/, '$1')
    return {
      screen: body ? `${body}${modes}\n` : modes,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      altScreen
    }
  }

  /**
   * Has the app running in this session REQUESTED bracketed paste (`CSI ?2004h`)?
   *
   * This is the session host's answer to the question `paste-buffer -p` asks tmux's pane state,
   * and it is answerable here for a reason the tmux side cannot claim: the emulator is fed the
   * session's OWN pty output, so a `?2004h` it saw was written by the app in the pane. (The
   * tombstone in `pty-manager.ts` for `bracketPasteRequested` and CLAUDE.md's "the emulator is
   * NOT the answer here" both concern a RENDERER xterm attached as a tmux CLIENT, where the mode
   * it observes is tmux's own paste-through on the outer terminal and reads true for every pane.
   * No tmux sits between this emulator and the pane's app.)
   *
   * Read through `HostSession.bracketedPasteRequested()`, never directly: emulator writes are
   * queued, so the answer is only current behind `outputTail`.
   */
  bracketedPasteRequested(): boolean {
    return this.term.modes.bracketedPasteMode
  }

  /**
   * Which mouse-tracking protocol the app in this pane has requested (`CSI ?1000h` / `?1002h` /
   * `?1003h` / `?9h`), `'none'` when it has asked for none. Same provenance argument as
   * `bracketedPasteRequested`: this emulator is fed the pane's own output, so the mode is the
   * app's, not a client terminal's. The relay's `pty.scroll` asks it before writing a wheel event
   * into a session-host pane (`PtyManager.scrollRoute`) — with no tmux in front, a wheel the app
   * did not ask for lands in the prompt as raw escape text.
   */
  mouseTrackingMode(): 'none' | 'x10' | 'vt200' | 'drag' | 'any' {
    return this.term.modes.mouseTrackingMode
  }

  dispose(): void {
    try {
      this.serializer.dispose()
    } catch {
      /* already disposed */
    }
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }
}
