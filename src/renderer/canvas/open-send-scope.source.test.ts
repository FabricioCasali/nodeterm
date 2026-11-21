import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('PAR-264: open-agent followed immediately by send shares persisted scope', () => {
  it('sets dirtyRef.current synchronously in bumpDirty so send never skips syncMessageScope', () => {
    const bump = between('const bumpDirty = useCallback(() => {', 'const markDirty = useCallback(')
    expect(bump).toContain('dirtyRef.current = true')
  })

  it('flushes addOpenNodes synchronously even without --run-now so nodesRef.current includes the new node', () => {
    const addOpen = between('const addOpenNodes = (', 'const replyLiveOpen = async')
    expect(addOpen).toContain('return flushSync(add)')
  })

  it('awaits off-canvas writeDisk before replying from replyLiveOpen', () => {
    const replyOpen = between('const replyLiveOpen = async', 'try {\n        switch (verb)')
    expect(replyOpen).toContain('if (offCanvas?.created.length) await writeDisk()')
  })
})
