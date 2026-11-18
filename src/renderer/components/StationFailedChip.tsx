/**
 * Station failures and informational approval reminders on the agent that opened the station
 * (src/core/agents/station-notice.ts). ONE component on the canvas node header and the kanban card
 * modal: one session seen twice must not speak in two voices.
 *
 * The canvas leg of a notice needs no switch, so this chip shows whether or not agent messaging let
 * the notice into the agent's session; the tooltip says which (`stationNoticePaneText`), so a user
 * can see a notice stayed on the canvas because messaging is off rather than guess. It goes away
 * when core's episode ends — the station completes a turn successfully, or it is closed.
 *
 * Click = go to the station (the first, when several stopped). The chip names only what core put
 * in the notice: the station's title (one line, capped) and a reason from the closed table.
 */
import { stationNoticeTooltip } from '@shared/station-notice'
import { noticeSigFor, noticesFor, useStationNotices } from '../state/stationNotices'

export function StationFailedChip({
  nodeId,
  className,
  dot = false
}: {
  nodeId: string
  className: string
  /** The canvas header's chips carry a leading dot; the kanban badges do not. */
  dot?: boolean
}) {
  const sig = useStationNotices((s) => noticeSigFor(s.views, nodeId))
  if (!sig) return null
  const views = noticesFor(useStationNotices.getState().views, nodeId)
  if (views.length === 0) return null
  const failures = views.filter((v) => v.reason !== 'approval-unconfirmed')
  const approvals = views.filter((v) => v.reason === 'approval-unconfirmed')
  return (
    <>
      {[failures, approvals].filter((group) => group.length > 0).map((group) => {
        const approval = group[0].reason === 'approval-unconfirmed'
        const label = approval
          ? (group.length === 1 ? 'AWAITING APPROVAL CONFIRMATION' : `${group.length} APPROVAL CONFIRMATIONS`)
          : (group.length === 1 ? 'STATION FAILED' : `${group.length} STATIONS FAILED`)
        return (
          <button
            key={approval ? 'approval' : 'failure'}
            className={className}
            title={`${stationNoticeTooltip(group)}\nClick to go to the station.`}
            onClick={(e) => {
              e.stopPropagation()
              window.dispatchEvent(
                new CustomEvent('nodeterm:focus-node', { detail: { nodeId: group[0].stationNodeId } })
              )
            }}
          >
            {dot && <span className="term-node__status-dot" />}
            {label}
          </button>
        )
      })}
    </>
  )
}
