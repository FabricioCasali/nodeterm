// PAR-255: the ONE renderer factory every canvas-control open route builds through (active canvas,
// `--project` target, cold store open — Canvas.tsx passes `args['launch-args']` at all three, pinned
// in canvas/control-launch-args.source.test.ts). The node's first line carries the per-session
// `--launch-args`, the node keeps them for later relaunches, and the serializer seams re-validate.
import { describe, it, expect, afterEach } from 'vitest'
import { createAgentNode, flowToNodeStates, nodeStatesToFlow } from './workspace'
import { resetClaudeCliCapsForTests } from './permissionMode'

afterEach(() => resetClaudeCliCapsForTests())

const MCP = '--strict-mcp-config --mcp-config C:/x/mcp.json'

/** createAgentNode's positional tail: (…, model, promptFile, resumeSessionId, launchArgs). */
function open(agentId: string, prompt: string | undefined, launchArgs: string | undefined, model?: string) {
  return createAgentNode(
    agentId, 0, '/repo', undefined, prompt, undefined, undefined, undefined, undefined, model, undefined, undefined,
    launchArgs
  )
}

describe('createAgentNode with launch args', () => {
  it('types them in the managed-flags slot and persists the raw value', () => {
    const n = open('claude', 'go', MCP, 'opus')
    expect(n.data.initialCommand).toBe(
      "claude 'go' --model 'opus' '--strict-mcp-config' '--mcp-config' 'C:/x/mcp.json'"
    )
    expect(n.data.agentLaunchArgs).toBe(MCP)
    expect(n.data.launchIntent).toEqual({
      command: n.data.initialCommand,
      intent: {
        kind: 'agent',
        action: 'start',
        agentId: 'claude',
        prompt: 'go',
        model: 'opus',
        launchArgs: ['--strict-mcp-config', '--mcp-config', 'C:/x/mcp.json']
      }
    })
  })

  it('holds a launch intent even without a prompt', () => {
    const n = open('codex', undefined, '-c mcp_servers.linear.enabled=false')
    expect(n.data.initialCommand).toContain("'-c' 'mcp_servers.linear.enabled=false'")
    expect(n.data.launchIntent?.intent).toMatchObject({
      action: 'start',
      agentId: 'codex',
      launchArgs: ['-c', 'mcp_servers.linear.enabled=false']
    })
  })

  it('a resumed node ("Open recent") also carries them', () => {
    const n = createAgentNode(
      'claude', 0, '/repo', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'abc-123', MCP
    )
    expect(n.data.initialCommand).toBe(
      "claude --resume abc-123 '--strict-mcp-config' '--mcp-config' 'C:/x/mcp.json'"
    )
    expect(n.data.agentLaunchArgs).toBe(MCP)
  })

  it('an invalid value is dropped: byte-identical line, nothing persisted', () => {
    const n = open('claude', 'go', '--a\nb')
    expect(n.data.initialCommand).toBe("claude 'go'")
    expect(n.data.agentLaunchArgs).toBeUndefined()
    expect(open('claude', 'go', undefined).data.agentLaunchArgs).toBeUndefined()
  })

  it('round-trips the serializer seams and drops a hand-edited invalid value there', () => {
    const n = open('claude', 'go', MCP)
    const [state] = flowToNodeStates([n])
    expect(state.agentLaunchArgs).toBe(MCP)
    expect(nodeStatesToFlow([state])[0].data.agentLaunchArgs).toBe(MCP)
    expect(nodeStatesToFlow([{ ...state, agentLaunchArgs: '--x "open' }])[0].data.agentLaunchArgs).toBeUndefined()
  })
})
