// Per-session extra CLI arguments for an agent launch (canvas-control `open-agent --launch-args`).
//
// A custom agent's `args` are fixed in settings, so an orchestrator that needs to vary ONE session's
// flags (`--mcp-config <file>`, `-c mcp_servers.x.enabled=false`, `--gemini_dir=<dir>`) had to keep
// one custom agent per combination. `--launch-args` carries those flags for a single node instead:
// split ONCE here with the same POSIX-style grammar a custom agent's `args` use (`shellSplit`), and
// from then on handled as argv — each element single-quoted on the typed line
// (`assembleLaunchCommand` / `assembleResumeCommand`) and encoded per dialect by the core planner
// for a Windows-native pane (core/agent-launch.ts). They land right after the agent's configured
// args, so before the prompt and before the base harness's prompt separator.
//
// Taken LITERALLY: no `${env:…}`, `$VAR` or `~` expansion. The value comes from an agent on the
// canvas, and expanding the environment for it would hand that agent an env-variable oracle (the
// #171/#190 review); the orchestrator already knows the absolute paths it wants to pass.
//
// The raw string is persisted on the node (`agentLaunchArgs`) so a cold restore / restart relaunches
// with the same flags. It is EXEC-ENABLING (`--mcp-config` starts processes, `--settings` installs
// hooks), so it is machine-local exactly like `shell`: never written to a shared project file, never
// taken from a peer (@shared/node-exec), and re-validated wherever it becomes a command.

import { shellSplitChecked } from '../shell-quote'

/** The canvas-control flag name (`--launch-args`). */
export const LAUNCH_ARGS_FLAG = 'launch-args'
/** Upper bound for the raw value: generous for a handful of flags and paths, far below any
 *  command-line limit the typed line or the Windows planner enforces. */
export const LAUNCH_ARGS_MAX_LENGTH = 16384
/** Upper bound for the number of argv elements the value may split into. */
export const LAUNCH_ARGS_MAX_TOKENS = 256

// Every C0 control (newline, carriage return, NUL, tab, ESC…), DEL, and the Unicode line/paragraph
// separators: the typed line is ONE line, and the core planner refuses the same set.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x1f\x7f\u2028\u2029]/u

/** Why `raw` cannot be used as launch args, or null when it can. An all-blank value is refused:
 *  passing the flag with nothing in it is the shim's `--launch-args --flag` mistake (a value that
 *  starts with `--` must be written `--launch-args=<args>`), never an intent. */
export function launchArgsError(raw: string): string | null {
  if (!raw.trim()) {
    return 'needs a value; when the arguments start with "--", write --launch-args="--flag value ..."'
  }
  if (raw.length > LAUNCH_ARGS_MAX_LENGTH) return `is longer than ${LAUNCH_ARGS_MAX_LENGTH} characters`
  if (FORBIDDEN.test(raw)) return 'must not contain newlines, NUL or other control characters'
  const { tokens, unterminated } = shellSplitChecked(raw)
  if (unterminated) return 'has an unterminated quote'
  if (tokens.length > LAUNCH_ARGS_MAX_TOKENS) return `splits into more than ${LAUNCH_ARGS_MAX_TOKENS} arguments`
  return null
}

/**
 * The argv elements of a launch-args value, or [] for none. Fails CLOSED: a value that does not
 * pass `launchArgsError` (a hand-edited workspace file, a stale node) contributes nothing rather
 * than a guess — the agent then launches as it would without the flag.
 */
export function launchArgsArgv(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim() || launchArgsError(raw)) return []
  return shellSplitChecked(raw).tokens
}

/** The value to persist on a node (`agentLaunchArgs`): the trimmed raw string when it is usable,
 *  else undefined. */
export function normalizeLaunchArgs(raw: unknown): string | undefined {
  // Validated BEFORE trimming: a value carrying a control character anywhere — a trailing newline
  // included — is refused, never quietly repaired.
  if (typeof raw !== 'string' || launchArgsError(raw)) return undefined
  return raw.trim()
}

/**
 * The `--launch-args` gate shared by every shell (desktop main before forwarding, the renderer as
 * its belt, the Server Edition inside `parseControlRequest`): only the agent-opening verbs give the
 * flag a meaning, and a malformed value is refused before anything is created.
 */
export function launchArgsFlagRefusal(verb: string, args: Record<string, string | undefined>): string | null {
  const raw = args[LAUNCH_ARGS_FLAG]
  if (raw === undefined) return null
  if (verb !== 'open-agent' && verb !== 'open-claude') {
    return `${verb}: --launch-args applies only to open-agent / open-claude`
  }
  const err = launchArgsError(raw)
  return err ? `${verb}: --launch-args ${err}` : null
}
