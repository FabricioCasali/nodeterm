// Formats the main-side line for each session-host attach-existing: why it happened, how long since
// the same key last attached, and how many attaches (any key) landed in the last second. Pure and
// stateful per instance, so the caller only passes facts and logs what comes back.

/** Attaches within this window count toward the same burst. */
export const ATTACH_BURST_WINDOW_MS = 1000
/** A burst this large also emits a warn line. */
export const ATTACH_BURST_WARN = 4

export interface AttachExistingEvent {
  key: string
  /** A category the caller can prove; absent or empty → `unknown`. */
  reason?: string
  /** Facts printed next to the reason, as `k=v`. */
  facts?: Record<string, string | number | boolean>
  now: number
}

export interface AttachExistingLines {
  info: string
  warn?: string
}

export function createAttachExistingLog(): (e: AttachExistingEvent) => AttachExistingLines {
  const lastByKey = new Map<string, number>()
  let recent: number[] = []
  return ({ key, reason, facts, now }) => {
    const prev = lastByKey.get(key)
    lastByKey.set(key, now)
    recent = recent.filter((t) => now - t < ATTACH_BURST_WINDOW_MS)
    recent.push(now)
    const burst = recent.length
    const extra = Object.entries(facts ?? {})
      .map(([k, v]) => ` ${k}=${v}`)
      .join('')
    const info =
      `[pty] attach-existing key=${key} reason=${reason || 'unknown'}${extra}` +
      ` sincePrevMs=${prev === undefined ? 'first' : now - prev} burst=${burst}`
    return burst >= ATTACH_BURST_WARN
      ? { info, warn: `[pty] attach-existing burst=${burst} in 1s` }
      : { info }
  }
}
