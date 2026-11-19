/** Preserve wire order for commands targeting the same session on one socket. Dispatch itself is
 * asynchronous (warm snapshots and geometry barriers await), so merely iterating parsed frames in
 * order lets a later detach run before the earlier attach has even prepared its claim. Different
 * names keep independent lanes and therefore retain the protocol's intended concurrency. */
/**
 * Commands that only READ the process table and therefore stay OUT of the per-session lane.
 *
 * A Windows pane probe is a PowerShell round trip: 0.3 s on an idle machine, seconds on a loaded
 * one, and up to its deadlines (windows-probe-budget.ts: 6 s warm, then 15 s cold, then an 8 s
 * one-shot) when the machine is saturated. Inside the lane, every later command for the same
 * session waited behind it — including `write`, so a keystroke typed into a terminal while its
 * liveness poll (every 30 s per parked agent node) or a message-owner probe was in flight was held
 * for the whole probe, and `pause`/`resume`/`resize` with it. Past 10 s the client's `write`
 * request timed out and retired the WHOLE connection (PAR-241).
 *
 * Neither command touches session state: they need no ordering against attach/detach, and a probe
 * that races a spawn or an exit answers "unknown", which every caller already handles.
 */
const LANE_FREE_COMMANDS: ReadonlySet<string> = new Set(['paneCommand', 'messageOwnerV1'])

/** Whether a named command must keep wire order with the other commands of its session. */
export function usesSessionLane(cmd: string): boolean {
  return !LANE_FREE_COMMANDS.has(cmd)
}

export class SessionHostSocketRequestQueue {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue(name: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    this.tails.set(name, current)
    void current.then(
      () => this.release(name, current),
      () => this.release(name, current)
    )
    return current
  }

  private release(name: string, current: Promise<void>): void {
    if (this.tails.get(name) === current) this.tails.delete(name)
  }
}
