import { describe, expect, it } from 'vitest'
import { createAgentNode, duplicateNode, flowToNodeStates, nodeStatesToFlow } from './workspace'
import { applyMutationToFlow } from './workspace'
import { receivedCanvasMutation } from '../session/relay-ssh'

function queued(model?: string) {
  const n = createAgentNode('claude', 0, 'C:/repo', undefined, undefined,
    undefined, undefined, undefined, undefined, model, 'C:/brief com espaço.md')
  n.data.pendingLaunch = { command: n.data.initialCommand!, after: [], attempted: false }
  return n
}

describe('PAR-230 F2 local launch persistence', () => {
  it('T09 carries model and promptFile from the real node factory', () => {
    const n = queued('opus')
    expect(n.data.launchIntent).toMatchObject({
      command: n.data.initialCommand,
      intent: { kind: 'agent', action: 'start', agentId: 'claude', model: 'opus' },
      promptFile: 'C:/brief com espaço.md'
    })
  })

  it('T11 local save/load preserves the exact semantic intent while its matching launch is pending', () => {
    const n = queued()
    const saved = JSON.parse(JSON.stringify(flowToNodeStates([n])))
    const restored = nodeStatesToFlow(saved)[0]
    expect(restored.data.pendingLaunch).toEqual(n.data.pendingLaunch)
    expect(restored.data.launchIntent).toEqual(n.data.launchIntent)
  })

  it('T11 completed launches and duplicated nodes carry no execution intent', () => {
    const n = queued()
    expect(duplicateNode(n).data.launchIntent).toBeUndefined()
    n.data.pendingLaunch = undefined
    expect(flowToNodeStates([n])[0]).not.toHaveProperty('launchIntent')
  })

  it('T11 a mismatched pending command cannot preserve semantic execution authority', () => {
    const n = queued()
    n.data.pendingLaunch = { command: 'echo different', after: [], attempted: false }
    expect(flowToNodeStates([n])[0]).not.toHaveProperty('launchIntent')
  })

  it('T11 a relay core cannot plant a queued launch or its intent through a canvas mutation', () => {
    const foreign = queued()
    const own = createAgentNode('claude', 0)
    const foreignState = { ...flowToNodeStates([foreign])[0], launchIntent: foreign.data.launchIntent }
    const mutation = receivedCanvasMutation({ op: 'upsert', origin: 'core', node: foreignState }, true)
    const received = applyMutationToFlow([own], mutation).find((n) => n.id === foreign.id)!
    expect(received.data.pendingLaunch).toBeUndefined()
    expect(received.data.launchIntent).toBeUndefined()
  })
})
