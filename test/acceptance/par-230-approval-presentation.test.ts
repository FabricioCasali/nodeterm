// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StationFailedChip } from '../../src/renderer/components/StationFailedChip'
import { useStationNotices } from '../../src/renderer/state/stationNotices'
import { StationNoticeMonitor } from '../../src/core/agents/station-notice'
import { STATION_QUESTION_NOTICE_MS, stationRecipient, type StationCanvas } from '@shared/station-notice'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  useStationNotices.getState().setViews([])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStationNotices.getState().setViews([])
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function publishApproval(dot: boolean) {
  const canvas: StationCanvas = { id: 'project', nodes: [
    { id: 'opener', kind: 'terminal', agentId: 'claude' },
    { id: 'approval', kind: 'terminal', agentId: 'claude', title: 'Approval worker', openedBy: 'opener' },
    { id: 'failure', kind: 'terminal', agentId: 'claude', title: 'Failed worker', openedBy: 'opener' }
  ], ropes: [{ source: 'opener', target: 'approval' }, { source: 'opener', target: 'failure' }] }
  const monitor = new StationNoticeMonitor({
    now: Date.now, recipientFor: (id) => stationRecipient([canvas], id),
    pendingQuestionOf: () => undefined, exists: () => true,
    appendBoardLog: async () => true,
    publish: (views) => useStationNotices.getState().setViews(views),
    schedule: (ms, fn) => { setTimeout(fn, ms) }
  })
  await act(async () => {
    root.render(createElement(StationFailedChip, { nodeId: 'opener', className: 'chip', dot }))
    monitor.onAgentEvent({ nodeId: 'opener', kind: 'state', state: 'done', verified: true })
    monitor.onAgentEvent({ nodeId: 'approval', kind: 'state', state: 'blocked', verified: true })
    await vi.advanceTimersByTimeAsync(STATION_QUESTION_NOTICE_MS)
    monitor.sweep()
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(useStationNotices.getState().views).toEqual([
    expect.objectContaining({ stationNodeId: 'approval', reason: 'approval-unconfirmed' })
  ])
  return monitor
}

describe('PAR-230 T08: published approval reminders in node/card presentation', () => {
  it.each([true, false])('shows missing confirmation without failure or close/reassign actions (dot=%s)', async (dot) => {
    await publishApproval(dot)
    expect(host.querySelector('button')).not.toBeNull()
    const text = host.textContent ?? ''
    const tooltip = [...host.querySelectorAll<HTMLElement>('[title]')].map((element) => element.title).join('\n')
    expect.soft(text).not.toMatch(/STATIONS? FAILED/i)
    expect.soft(`${text}\n${tooltip}`).toMatch(/confirm/i)
    expect.soft(tooltip).not.toMatch(/stopped/i)
    expect.soft(`${text}\n${tooltip}`).not.toMatch(/close --node|reassign|handover/i)
  })

  it('keeps a real failure visible without counting the approval reminder as a failed station', async () => {
    const monitor = await publishApproval(false)
    await act(async () => {
      monitor.onAgentEvent({ nodeId: 'failure', kind: 'state', state: 'done', errored: true, verified: true })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(useStationNotices.getState().views.map((view) => view.reason).sort())
      .toEqual(['approval-unconfirmed', 'turn-errored'])
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent)
    const tooltip = [...host.querySelectorAll<HTMLElement>('[title]')].map((element) => element.title).join('\n')
    expect.soft(labels).toContain('STATION FAILED')
    expect.soft(host.textContent).not.toContain('2 STATIONS FAILED')
    expect.soft(tooltip).toMatch(/Failed worker.*stopped/)
    expect.soft(tooltip).toMatch(/confirm/i)
    expect.soft(tooltip).not.toMatch(/Approval worker[^\n]*stopped/)
  })
})
