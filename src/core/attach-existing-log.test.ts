import { describe, expect, it } from 'vitest'
import { createAttachExistingLog } from './attach-existing-log'

describe('createAttachExistingLog', () => {
  it('counts a burst, tracks the gap per key, and resets after the window', () => {
    const log = createAttachExistingLog()
    const at = (key: string, now: number) => log({ key, now })
    const lines = [at('a', 0), at('b', 200), at('a', 400), at('c', 600), at('d', 800)]
    expect(lines.map((l) => /sincePrevMs=(\S+)/.exec(l.info)?.[1])).toEqual(['first', 'first', '400', 'first', 'first'])
    expect(lines.map((l) => /burst=(\d+)/.exec(l.info)?.[1])).toEqual(['1', '2', '3', '4', '5'])
    expect(lines.map((l) => l.warn)).toEqual([
      undefined,
      undefined,
      undefined,
      '[pty] attach-existing burst=4 in 1s',
      '[pty] attach-existing burst=5 in 1s'
    ])
    const late = at('a', 2800)
    expect(late.info).toBe('[pty] attach-existing key=a reason=unknown sincePrevMs=2400 burst=1')
    expect(late.warn).toBeUndefined()
  })

  it('never prints an empty reason, and prints the facts next to it', () => {
    const log = createAttachExistingLog()
    expect(log({ key: 'k', reason: '', now: 0 }).info).toContain('reason=unknown')
    expect(log({ key: 'k', reason: 'reconnect', facts: { sessions: 7 }, now: 5000 }).info).toBe(
      '[pty] attach-existing key=k reason=reconnect sessions=7 sincePrevMs=5000 burst=1'
    )
  })
})
