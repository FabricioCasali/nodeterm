import { describe, expect, it, vi } from 'vitest'
import { createCapturePaneControlHandler } from './capture-pane-control'

function harness() {
  const captureVisible = vi.fn(async () => ({ screen: 'one\ntwo\n', cursor: null }))
  const next = vi.fn(async () => ({ ok: true, message: 'continued' }))
  const sessionOf = vi.fn((): string | undefined => 'session')
  const projects = [{ id: 'p', nodes: [{ id: 'caller', agentId: 'claude' }, { id: 'target' }] }]
  const handler = createCapturePaneControlHandler({ projects: () => projects, captureVisible, sessionOf }, next)
  const req = { verb: 'capture-pane', nodeId: 'caller', verified: true, args: { node: 'target' } }
  return { handler, captureVisible, next, sessionOf, projects, req }
}

describe('Desktop/Server registered capture handler', () => {
  it('delegates other verbs and their continuation unchanged', async () => {
    const h = harness()
    const req = { ...h.req, verb: 'run', onLateAnswer: vi.fn() }
    expect(await h.handler(req)).toEqual({ ok: true, message: 'continued' })
    expect(h.next).toHaveBeenCalledExactlyOnceWith(req)
    expect(h.captureVisible).not.toHaveBeenCalled()
  })
  it('reads without forwarding to renderer or changing focus', async () => {
    const h = harness()
    expect(await h.handler(h.req)).toEqual({ ok: true, message: 'one\ntwo\n' })
    expect(await h.handler({ ...h.req, args: { node: 'target', lines: '1' } })).toEqual({ ok: true, message: 'two' })
    expect(h.captureVisible).toHaveBeenCalledWith('session')
    expect(h.next).not.toHaveBeenCalled()
  })
  it.each([
    { verified: false }, { nodeId: 'absent' }, { args: { node: 'absent' } },
    { args: { node: 'target', lines: '0' } }, { args: { node: 'target', project: 'other' } },
    { args: { node: 'target', 'dry-run': '' } }
  ])('refuses before reading: %j', async (over) => {
    const h = harness()
    expect(await h.handler({ ...h.req, ...over, args: (over.args ?? h.req.args) as Record<string, string> }))
      .toMatchObject({ ok: false, error: expect.any(String) })
    expect(h.captureVisible).not.toHaveBeenCalled()
    expect(h.next).not.toHaveBeenCalled()
  })
  it('refuses duplicate node ids across projects', async () => {
    const h = harness()
    h.projects.push({ id: 'other', nodes: [{ id: 'target' }] })
    expect(await h.handler(h.req)).toMatchObject({ ok: false })
    expect(h.captureVisible).not.toHaveBeenCalled()
  })
  it('does not present an old session capture as the replacement session', async () => {
    const h = harness()
    h.sessionOf.mockReturnValueOnce('session').mockReturnValue('replacement')
    expect(await h.handler(h.req)).toMatchObject({ ok: false, error: expect.stringContaining('session changed') })
  })
  it('reports a missing or throwing backend', async () => {
    const h = harness()
    h.sessionOf.mockReturnValueOnce(undefined)
    expect(await h.handler(h.req)).toMatchObject({ ok: false })
    expect(h.captureVisible).not.toHaveBeenCalled()
    h.captureVisible.mockRejectedValueOnce(new Error('backend'))
    expect(await h.handler(h.req)).toMatchObject({ ok: false, error: expect.stringContaining('unreadable') })
  })
})
