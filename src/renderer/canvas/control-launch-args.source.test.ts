import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for PAR-255 `--launch-args` — the same class of test as
 * `control-cold-open.source.test.ts`: the open routes live inside a 20,000-line component's IPC
 * listener with no unit seam. PAR-250 found the routes diverging (one honoured a flag the others
 * dropped), so every route that builds an agent node is pinned to hand the flag to the factory,
 * whose behaviour is proven in `state/workspace.launch-args.test.ts`. The relaunch paths
 * (cold-restore resume, restart, wake) are pinned the same way in TerminalNode.
 */
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const canvas = read('./Canvas.tsx')
const terminal = read('../nodes/TerminalNode.tsx')
const main = read('../../main/index.ts')

describe('--launch-args reaches every open route (source pins)', () => {
  it('all three createAgentNode calls of the open verbs pass it after the prompt file', () => {
    // active canvas, `--project` target, cold store open
    const calls = canvas.match(/openPrompt\.promptFile,\n[^\n]*\n\s*undefined,\n\s*args\['launch-args'\]\n/g) ?? []
    expect(calls).toHaveLength(3)
    expect(canvas.match(/args\['launch-args'\]/g)).toHaveLength(3)
  })

  it('the renderer re-runs the shape gate before any route creates a node', () => {
    const gate = canvas.indexOf('launchArgsFlagRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    // Before the first route that opens anything (the `--project` target route).
    expect(gate).toBeLessThan(canvas.indexOf("args['launch-args']"))
  })

  it('desktop main refuses a malformed value before forwarding', () => {
    expect(main).toContain('const launchArgsRefusal = launchArgsFlagRefusal(verb, args)')
  })
})

describe('the node relaunches with its launch args (source pins)', () => {
  it('every resume assembled for this node carries data.agentLaunchArgs', () => {
    const resumes = terminal.split('assembleResumeCommand(').slice(1).map((s) => s.slice(0, 1600))
    expect(resumes).toHaveLength(4)
    // cold-restore resume, the fresh relaunch fallback, the variant restart (same agent only), wake
    for (const body of resumes) expect(body).toMatch(/launchArgs:/)
    expect(resumes.filter((b) => b.includes('launchArgs: data.agentLaunchArgs')).length).toBe(3)
    expect(resumes.some((b) => /target === sourceAgentId\s*\?\s*\(getNode\(id\)\?\.data\.agentLaunchArgs/.test(b))).toBe(
      true
    )
  })

  it('switching the node to another agent drops them', () => {
    expect(terminal).toContain('...(target !== sourceAgentId ? { agentLaunchArgs: undefined } : {})')
    expect(canvas).toContain(
      '...(targetAgentId && targetAgentId !== n.data.agentId ? { agentLaunchArgs: undefined } : {})'
    )
  })
})
