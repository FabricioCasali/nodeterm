// PAR-255: `--launch-args` in the shared control parser (the Server Edition runs it; desktop main
// runs the same gate before forwarding) and in both agent-facing bodies.
import { describe, expect, it } from 'vitest'
import {
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  parseControlRequest
} from './canvas-control-core'

describe('parseControlRequest --launch-args', () => {
  it('accepts a valid value on open-agent / open-claude', () => {
    expect(
      parseControlRequest('open-agent', { agent: 'claude', 'launch-args': '--strict-mcp-config --mcp-config /x.json' })
    ).toMatchObject({ verb: 'open-agent' })
    expect(parseControlRequest('open-claude', { 'launch-args': '--plugin-dir /p' })).toMatchObject({
      verb: 'open-claude'
    })
  })

  it('refuses a newline / NUL, an unterminated quote, an empty value and another verb', () => {
    expect(parseControlRequest('open-agent', { agent: 'codex', 'launch-args': '-c a=b\n-c x' })).toEqual({
      error: 'open-agent: --launch-args must not contain newlines, NUL or other control characters'
    })
    expect(parseControlRequest('open-agent', { agent: 'codex', 'launch-args': '-c a\u0000' })).toHaveProperty('error')
    expect(parseControlRequest('open-agent', { agent: 'codex', 'launch-args': "-c 'a=[" })).toEqual({
      error: 'open-agent: --launch-args has an unterminated quote'
    })
    expect(parseControlRequest('open-agent', { agent: 'claude', 'launch-args': '' })).toHaveProperty('error')
    expect(parseControlRequest('open-terminal', { 'launch-args': '-v' })).toEqual({
      error: 'open-terminal: --launch-args applies only to open-agent / open-claude'
    })
  })
})

describe('the agent-facing docs list --launch-args', () => {
  for (const [name, body] of [
    ['instructions', buildCanvasControlInstructions('/shim.sh')],
    ['skill', buildCanvasSkillBody('/shim.sh')]
  ] as const) {
    it(`${name}: in both open verb synopses, with the --launch-args="..." spelling explained`, () => {
      const synopses = body.split('\n').filter((l) => /`open-(claude|agent) /.test(l) && l.includes('[--count N]'))
      expect(synopses.length).toBeGreaterThanOrEqual(2)
      for (const line of synopses) expect(line).toContain('[--model M] [--launch-args A]')
      expect(body).toContain('`--launch-args <args>` (open-agent / open-claude)')
      expect(body).toContain('--launch-args="..."')
      expect(body).toMatch(/LITERALLY/)
    })
  }
})
