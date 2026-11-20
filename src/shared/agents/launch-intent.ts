// The semantic twin of a prompt-bearing first launch (`data.launchIntent`, `HeldLaunchIntent`).
//
// `assembleLaunchCommand` builds POSIX source, which a Windows session-host pane running pwsh,
// Windows PowerShell or cmd.exe mis-parses the moment the prompt holds an apostrophe, a double
// quote or a cmd metacharacter (or a `$(cat …)` prompt file). The core can encode the same launch
// correctly for that pane's own parser (`pty:execute-launch`, core/launch-intent-execute.ts) — but
// only from a SEMANTIC request, never by re-parsing the typed line. This builds that request.
//
// It is built only where it is a faithful description of the legacy line. Anything the core
// planner does not model — a launch-command override, a custom agent whose launch command holds
// an ${env:…} expansion or shell syntax, a remote node, a resume — yields NO intent, and such a
// node keeps its legacy line on every surface. A custom agent is named by id only: the core
// resolves its CURRENT machine-local record (launch command, base harness, `args`), so no launch
// material ever rides the intent. A launch with no prompt
// yields none either: without a prompt the legacy line holds only bare flag words and validated
// ids, which every Windows shell already parses the same way — UNLESS it carries per-session
// `--launch-args`: those are free text (a `-c 'k=[{name="a"}]'` override, a path with spaces), so
// a launch with them always gets an intent, prompt or not.

import type { CustomAgent, HeldLaunchIntent } from '../types'
import { launchArgsArgv } from './launch-args'
import {
  AGENT_CONFIG,
  hasPermissionMode,
  mintsSessionId,
  type AgentId,
  type AgentPermissionMode
} from './config'

export interface HeldLaunchInputs {
  agentId: AgentId
  /** The exact legacy line this intent stands in for. */
  command: string
  launchCmdOverride?: string
  /** The custom agent's current record, when `agentId` is a custom id and the caller has it. */
  customAgent?: Pick<CustomAgent, 'launchCmd' | 'args'>
  model?: string
  /** An SSH / relay node: its shell is on another machine, never a local session host. */
  remote: boolean
  /** The node RESUMES an existing conversation (no prompt by construction). */
  resume: boolean
  initialPrompt?: string
  promptFile?: string
  permissionMode?: AgentPermissionMode
  /** The id the factory minted AND put on the legacy line (`--session-id`). */
  mintedSessionId?: string
  /** Per-session extra CLI arguments (`--launch-args`) the legacy line carries, raw. */
  launchArgs?: string
}

export function heldLaunchIntentFor(inputs: HeldLaunchInputs): HeldLaunchIntent | undefined {
  if (inputs.resume || inputs.remote) return undefined
  if (inputs.launchCmdOverride?.trim()) return undefined
  if (!Object.hasOwn(AGENT_CONFIG, inputs.agentId)) {
    // A custom agent: one this machine has a record for (ids are free-form), or a `custom:` id.
    if (!inputs.customAgent && !inputs.agentId.startsWith('custom:')) return undefined
    // An ${env:…} expansion or shell syntax in the launch COMMAND: the core planner takes a plain
    // program there, so such an agent keeps its typed line rather than be refused. (`args` are
    // modelled: the planner expands and encodes them itself.)
    if (/[;&|<>()$`]/u.test(inputs.customAgent?.launchCmd ?? '')) return undefined
  }
  const model = inputs.model?.trim()
  const promptFile = inputs.promptFile?.trim()
  // Collapsed exactly like the legacy line collapses it (`assembleLaunchCommand`).
  const prompt = promptFile ? undefined : inputs.initialPrompt?.replace(/\s+/g, ' ').trim()
  const launchArgs = launchArgsArgv(inputs.launchArgs)
  if (!promptFile && !prompt && !launchArgs.length) return undefined
  return {
    command: inputs.command,
    intent: {
      kind: 'agent',
      action: 'start',
      agentId: inputs.agentId,
      ...(prompt ? { prompt } : {}),
      // The legacy line carries a mode flag only for an agent that has one; the core planner
      // refuses a mode for any other, so the two agree by construction.
      ...(inputs.permissionMode && hasPermissionMode(inputs.agentId)
        ? { permissionMode: inputs.permissionMode }
        : {}),
      ...(inputs.mintedSessionId && mintsSessionId(inputs.agentId)
        ? { newSessionId: inputs.mintedSessionId }
        : {}),
      ...(model ? { model } : {}),
      ...(launchArgs.length ? { launchArgs } : {})
    },
    ...(promptFile ? { promptFile } : {})
  }
}
