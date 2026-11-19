import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { randomUUID } from 'crypto'
import { claudeComposerEmpty, claudeComposerMatches } from '../shared/agents/message-readiness'
import type { CaptureVisibleResult, MessageEnvelopePreparation } from './protocol'
import { sanitizePasteText } from '../core/paste-injection'
import { pasteThenSubmitWhenSettled, type SettleOptions } from '../core/settled-submit'
import { readWindowsConsoleOwner, sameNativeProcess } from './windows-pane-owner'

export interface MessagePaneSession {
  generation: string
  exited: boolean
  proc: { pid: number; write(data: string): void }
  messagePasteReady(): Promise<boolean>
  /** The host emulator's screen (`HostSession.serialize`), read to see the envelope land. */
  serialize(scrollback?: number): Promise<string>
  captureVisible?(): Promise<CaptureVisibleResult>
}

export interface MessagePreparation {
  id: string
  socket: object
  session: MessagePaneSession
  generation: string
  expected: PaneOwner
  text: string
  pasted: boolean
  settled: boolean
  consumed: boolean
}

/** Recent lines are enough to find the envelope footer; the whole scrollback is not needed. */
const SETTLE_CAPTURE_LINES = 200

/** The persistent host owns both the emulator and the generation. Never route this through the
 * main process's direct-PTY adapter: that object cannot observe a replacement inside this host.
 * Project grants, verified hooks, agent binary checks and receipts still belong to core. */
export function hostMessagePane(
  lookup: () => MessagePaneSession | undefined,
  probe = readWindowsConsoleOwner,
  settle: SettleOptions = {},
  preparations = new Map<MessagePaneSession, MessagePreparation>()
) {
  const current = (s: MessagePaneSession): boolean => !s.exited && lookup() === s
  return {
    async prepare(envelope: string, expected: PaneOwner, socket: object): Promise<MessageEnvelopePreparation> {
      const s = lookup()
      if (!s || !current(s) || !expected || typeof envelope !== 'string' || preparations.has(s))
        return { kind: 'not-pasted' }
      const text = sanitizePasteText(envelope)
      if (!text) return { kind: 'not-pasted' }
      const p: MessagePreparation = {
        id: randomUUID(), socket, session: s, generation: s.generation,
        expected, text, pasted: false, settled: false, consumed: false
      }
      preparations.set(s, p)
      const valid = (): boolean => current(s) && s.generation === p.generation && preparations.get(s) === p
      const visible = async (): Promise<CaptureVisibleResult | null> => {
        const cap = await s.captureVisible?.()
        return valid() && cap ? cap : null
      }
      try {
        const first = await visible()
        if (!first || !claudeComposerEmpty(first.screen) || !(await s.messagePasteReady())) return { kind: 'not-pasted' }
        if (!sameNativeProcess(expected, await probe(s.proc.pid, s.generation)) || !valid()) return { kind: 'not-pasted' }
        await pasteThenSubmitWhenSettled(text, {
          capture: async () => (await visible())?.screen ?? null,
          paste: async () => {
            if (!sameNativeProcess(expected, await probe(s.proc.pid, s.generation))) return false
            if (!(await s.messagePasteReady())) return false
            const cap = await visible()
            if (!valid() || !cap || !claudeComposerEmpty(cap.screen)) return false
            p.pasted = true
            s.proc.write(`\x1b[200~${text}\x1b[201~`)
            return true
          },
          submit: async () => { p.settled = valid() }
        }, settle)
        if (!p.pasted) return { kind: 'not-pasted' }
        const cap = p.settled ? await visible() : null
        p.settled = !!cap && claudeComposerMatches(cap.screen, text)
        return { kind: 'pasted', preparationId: p.id, screen: p.settled ? cap : null }
      } catch {
        return p.pasted ? { kind: 'pasted', preparationId: p.id, screen: null } : { kind: 'not-pasted' }
      } finally {
        if (!p.pasted && preparations.get(s) === p) preparations.delete(s)
      }
    },
    async commit(preparationId: string, socket: object): Promise<boolean> {
      const s = lookup()
      const p = s && preparations.get(s)
      if (!s || !p || p.id !== preparationId || p.socket !== socket || p.consumed) return false
      p.consumed = true
      try {
        if (!p.pasted || !p.settled || p.session !== s || p.generation !== s.generation || !current(s)) return false
        if (!sameNativeProcess(p.expected, await probe(s.proc.pid, s.generation))) return false
        if (!(await s.messagePasteReady())) return false
        const cap = await s.captureVisible?.()
        if (!current(s) || p.generation !== s.generation || preparations.get(s) !== p ||
            !cap || !claudeComposerMatches(cap.screen, p.text)) return false
        s.proc.write('\r')
        return true
      } catch { return false } finally {
        if (preparations.get(s) === p) preparations.delete(s)
      }
    },
    cancel(preparationId: string, socket: object): boolean {
      const s = lookup()
      const p = s && preparations.get(s)
      if (!s || !p || p.id !== preparationId || p.socket !== socket) return false
      preparations.delete(s)
      return true
    },
    async owner(): Promise<PaneOwner | null> {
      const s = lookup()
      if (!s || !current(s)) return null
      const owner = await probe(s.proc.pid, s.generation)
      return current(s) ? owner : null
    },
    async pasteReady(): Promise<boolean> {
      const s = lookup()
      return !!s && current(s) && await s.messagePasteReady() && current(s)
    },
    async send(envelope: string, expected: PaneOwner | undefined): Promise<boolean> {
      const s = lookup()
      if (!s || !current(s) || !expected || typeof envelope !== 'string') return false
      const text = sanitizePasteText(envelope)
      if (!text || !(await s.messagePasteReady()) || !current(s)) return false
      const owner = await probe(s.proc.pid, s.generation)
      if (!current(s) || !sameNativeProcess(expected, owner)) return false
      // Paste, let the composer install the block, then submit in a second write
      // (core/settled-submit.ts): an Enter in the same write was swallowed by the paste.
      return pasteThenSubmitWhenSettled(text, {
        capture: async () => {
          if (!current(s)) return null
          try {
            const screen = await s.serialize(SETTLE_CAPTURE_LINES)
            return current(s) ? screen : null
          } catch { return null }
        },
        paste: async () => {
          // Cross the emulator barrier again after the OS probe and the baseline capture: paste
          // mode may have changed meanwhile. No await between this check and the write.
          if (!(await s.messagePasteReady()) || !current(s)) return false
          try {
            s.proc.write(`\x1b[200~${text}\x1b[201~`)
            return true
          } catch { return false }
        },
        submit: async () => {
          // A replaced or exited generation gets nothing: a bare Enter into a stranger's pane.
          try {
            const owner = await probe(s.proc.pid, s.generation)
            if (!sameNativeProcess(expected, owner) || !(await s.messagePasteReady()) || !current(s)) return
            s.proc.write('\r')
          } catch { /* the paste already landed; receipt reports stalled */ }
        }
      }, settle)
    }
  }
}
