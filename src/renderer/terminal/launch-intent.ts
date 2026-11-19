// The renderer half of `pty:execute-launch`: decide whether a launch line about to be typed should
// instead be executed as its semantic intent (core/launch-intent-execute.ts), and map the answer
// onto the launch writer's outcome vocabulary.
//
// Asked only for a LOCAL session-host pane on a win32 core — the one place the POSIX line is wrong.
// On macOS, Linux, tmux, SSH and relay this answers `'fallback'` without a single IPC, so those
// launches are byte-identical to before.
//
// The outcome split is the safety property: only the core's "this channel does not apply to this
// session" answer (`typedLineSafe`: tmux, a POSIX shell on Windows) falls back to the typed line.
// Every other refusal — and a delivery that may have reached the pane, or the call itself failing —
// is reported as `'cancelled'`, which leaves the launch held for an explicit Run now: the POSIX
// line is what a Windows-native shell mis-parses, so it is never typed behind a refusal.

import type { DeliveryOutcome } from '@shared/command-delivery'
import type {
  HeldLaunchIntent,
  LaunchIntentExecutionResult,
  LaunchIntentRequest
} from '@shared/types'

export interface HeldLaunchDeps {
  /** The node's CURRENT held intent (live node data, read at delivery time). */
  held(): HeldLaunchIntent | undefined
  sessionHost: boolean
  /** `session.source` of the live terminal: only `'local'` is eligible. */
  source: string | undefined
  /** `process.platform` of the owning core (`hostPlatformFor`). */
  hostPlatform(): Promise<string | null>
  executeLaunch?: (request: LaunchIntentRequest) => Promise<LaunchIntentExecutionResult>
  newLaunchId(): string
}

export function outcomeForLaunchResult(
  result: LaunchIntentExecutionResult
): DeliveryOutcome | 'fallback' {
  if (result.ok) return 'submitted'
  return result.typedLineSafe === true && result.reason === 'unsupported-shell' ? 'fallback' : 'cancelled'
}

export async function executeHeldLaunch(
  command: string,
  deps: HeldLaunchDeps
): Promise<DeliveryOutcome | 'fallback'> {
  const held = deps.held()
  if (!held || held.command !== command) return 'fallback'
  if (!deps.sessionHost || deps.source !== 'local') return 'fallback'
  if ((await deps.hostPlatform()) !== 'win32') return 'fallback'
  // A Windows session-host pane on a surface with no launch channel: nothing safe to type.
  if (!deps.executeLaunch) return 'cancelled'
  let result: LaunchIntentExecutionResult
  try {
    result = await deps.executeLaunch({
      launchId: deps.newLaunchId(),
      intent: held.intent,
      ...(held.promptFile ? { promptFile: held.promptFile } : {})
    })
  } catch {
    return 'cancelled'
  }
  return outcomeForLaunchResult(result)
}
