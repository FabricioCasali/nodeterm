import type { TextDeliveryResult } from '../shared/text-delivery'
import { envelopeGuardAllows, type EnvelopeGuard } from '../shared/agents/message-readiness'
import { randomUUID } from 'crypto'
import { OscColourScanner, TerminalEmulator } from '../session-host/terminal-emulator'
import { readWindowsConsoleOwner, sameNativeProcess } from '../session-host/windows-pane-owner'
import { sendTextWhenSettled } from './settled-text'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sanitizePasteText } from './paste-injection'
import { pasteThenSubmitWhenSettled, type SettleOptions } from './settled-submit'

export { sameNativeProcess } from '../session-host/windows-pane-owner'

/** Core-owned screen and generation for a direct Windows PTY. This is neither a persisted
 * agent label nor the "deepest descendant" restart heuristic. The caller still checks
 * project consent, verified idle status, agent binary and a receipt after delivery. */
export class NativeWindowsPane {
  private readonly generation = randomUUID()
  private readonly screen: TerminalEmulator
  private readonly colourScanner = new OscColourScanner()
  private tail: Promise<void> = Promise.resolve()
  private alive = true

  constructor(
    private readonly proc: { pid: number; write(data: string): void },
    size: { cols: number; rows: number; scrollback: number },
    private readonly probe = readWindowsConsoleOwner,
    private readonly settle: SettleOptions = {}
  ) {
    this.screen = new TerminalEmulator({
      cols: size.cols,
      rows: size.rows,
      scrollback: size.scrollback
    })
  }

  recordOutput(data: string): void {
    if (!this.alive) return
    for (const reply of this.colourScanner.push(data)) {
      try {
        this.proc.write(reply)
      } catch {
        // A pty that is already gone.
      }
    }
    this.tail = this.tail.then(() => this.screen.write(data)).catch(() => { this.alive = false })
  }

  resize(cols: number, rows: number): void {
    this.tail = this.tail.then(() => { if (this.alive) this.screen.resize(cols, rows) })
  }

  async capture(full: boolean): Promise<string> {
    await this.tail
    return this.alive ? this.screen.serialize(full ? undefined : 200) : ''
  }

  async owner(): Promise<PaneOwner | null> {
    if (!this.alive) return null
    const owner = await this.probe(this.proc.pid, this.generation)
    return this.alive ? owner : null
  }

  async pasteAware(): Promise<boolean> {
    await this.tail
    return this.alive && this.screen.bracketedPasteRequested()
  }

  async sendEnvelope(envelope: string, expected?: PaneOwner, guard?: EnvelopeGuard): Promise<boolean> {
    if (!envelope || !expected || !(await this.pasteAware())) return false
    // Re-check the exact process immediately before typing. A replacement with the same
    // PID but a different OS birth time, or a shell returned to the console, refuses.
    if (!sameNativeProcess(expected, await this.owner()) || !(await this.pasteAware())) return false
    const text = sanitizePasteText(envelope)
    if (!text) return false
    // Paste, let the composer install the block, then submit in a second write
    // (core/settled-submit.ts). Two synchronous writes arrive as one read on the other side.
    return pasteThenSubmitWhenSettled(text, {
      capture: async () => (this.alive ? this.capture(false) : null),
      paste: async () => {
        try {
          if (!this.alive || (guard && !sameNativeProcess(expected, await this.owner())) || !(await this.pasteAware())) return false
          if (guard) {
            await this.tail
            if (!this.alive || !this.screen.bracketedPasteRequested() || !envelopeGuardAllows(guard.beforePaste, this.screen.captureVisible().screen)) return false
          }
          this.proc.write(`\x1b[200~${text}\x1b[201~`)
          return true
        } catch { return false }
      },
      submit: async () => {
        try {
          if (!sameNativeProcess(expected, await this.owner()) || !(await this.pasteAware()) || !this.alive) return
          if (guard) {
            await this.tail
            if (!this.alive || !this.screen.bracketedPasteRequested() || !envelopeGuardAllows(guard.beforeSubmit, this.screen.captureVisible().screen)) return
          }
          this.proc.write('\r')
        } catch { /* paste landed; receipt reports stalled */ }
      }
    }, this.settle)
  }

  /**
   * `PtyManager.sendText` for a direct Windows PTY — the `paste-buffer -p` contract: framed only
   * when the app in the pane asked for bracketed paste, then Enter when requested. Unlike
   * `sendEnvelope` there is no process attestation: this is the user-confirmed `write` verb and the
   * app's own writers (rename, note push, dictation), which have always typed into whatever owns
   * the pane. Without it those callers fell through to the session-host backend, which has no
   * session for a direct PTY, and failed every time.
   */
  async sendText(text: string, enter: boolean): Promise<TextDeliveryResult> {
    return sendTextWhenSettled(this, text, enter, {
      current: () => this.alive,
      bracketed: () => this.pasteAware(),
      capture: () => this.capture(false),
      write: (chunk) => this.proc.write(chunk)
    }, this.settle)
  }

  dispose(): void {
    this.alive = false
    void this.tail.finally(() => this.screen.dispose())
  }
}
