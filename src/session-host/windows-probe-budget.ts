// The deadlines of the Windows pane probe, in one dependency-free leaf so the core's outer budget
// (`WINDOWS_PANE_PROBE_TIMEOUT_MS`, core/agents/pane-probe.ts) can be derived from them without
// pulling child_process into the agent-messaging module graph.
//
// MEASURED 2026-11-18 on Windows 11 (26300), 24 logical cores, ~590 processes (PAR-239), with the
// real probe scripts:
//                         idle machine     CPU saturated (48 busy processes)
//   warm worker request   0.3 s            1.3 - 1.9 s
//   cold worker request   1.3 s            11 s
//   one-shot powershell   1.1 - 1.5 s      5 - 10 s
// The previous deadlines (1.5 s warm, 6 s cold, 4 s one-shot) all sat INSIDE the loaded column, and
// they compound: one warm answer that took 1.6 s ended the warm worker — the only path that still
// fit — and every path after it (a cold worker, a one-shot) was slower than its own deadline. Every
// pane on the machine then read `unknown` and every agent message was refused
// `targetPaneUnreadable` for as long as the load lasted. A deadline here must clear the LOADED
// figure, because under load is exactly when agents are working and messages are being sent.

/** Per-request deadline once the probe worker is warm (windows-probe-worker.ts). Ending a warm
 *  worker is expensive — the next request pays a cold start — so this is generous on purpose. */
export const PROBE_WARM_REQUEST_TIMEOUT_MS = 6000

/** Deadline for the first request after the probe worker spawns: PowerShell startup + the
 *  one-time Add-Type compile (windows-probe-worker.ts). */
export const PROBE_FIRST_REQUEST_TIMEOUT_MS = 15_000

/** Deadline of the one-shot powershell.exe `readWindowsConsoleOwner` falls back to when the worker
 *  cannot answer (windows-pane-owner.ts). */
export const WINDOWS_ONESHOT_PROBE_TIMEOUT_MS = 8000
