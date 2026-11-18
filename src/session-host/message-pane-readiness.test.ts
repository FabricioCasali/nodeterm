import { describe, expect, it, vi } from 'vitest'
import { hostMessagePane, type MessagePaneSession } from './message-pane'
import captured from '../shared/agents/__fixtures__/claude/composer-capture.json'

describe('guarded host preparation replay', () => {
  it('a cancelled nonce cannot commit a subsequent preparation in the same generation', async () => {
    let screen = captured.screens.empty
    const owner = {
      panePid: 10, paneId: 'win32:generation-a:birth-root', tty: 'win32-console:10',
      command: 'claude', argv: ['claude'], pids: [20], processBirths: ['birth-agent']
    }
    const write = vi.fn((data: string) => {
      const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
      if (paste) screen = captured.screens.draft.replace('heb ik getest', paste[1])
    })
    const session: MessagePaneSession = {
      generation: 'generation-a', exited: false, proc: { pid: 10, write },
      messagePasteReady: async () => true, serialize: async () => screen,
      captureVisible: async () => ({ screen, cursor: { x: 0, y: 0 }, altScreen: false })
    }
    const pane = hostMessagePane(() => session, async () => owner, { wait: async () => {} })
    const socket = {}
    const first = await pane.prepare('first envelope', owner, socket)
    if (first.kind !== 'pasted') throw new Error('first envelope was not pasted')
    expect(pane.cancel(first.preparationId, socket)).toBe(true)
    screen = captured.screens.empty
    const second = await pane.prepare('second envelope', owner, socket)
    if (second.kind !== 'pasted') throw new Error('second envelope was not pasted')
    expect(second.preparationId).not.toBe(first.preparationId)
    expect(await pane.commit(first.preparationId, socket)).toBe(false)
    expect(write.mock.calls).toEqual([['\x1b[200~first envelope\x1b[201~'], ['\x1b[200~second envelope\x1b[201~']])
    expect(await pane.commit(second.preparationId, socket)).toBe(true)
    expect(write.mock.calls.at(-1)).toEqual(['\r'])
  })
})
