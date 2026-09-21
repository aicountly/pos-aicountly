/**
 * The four columns.
 *
 * Each lane is a landmark region with its own heading and its own count, so a
 * screen reader can jump to "Ready for pickup, 2 tickets" rather than walking
 * a hundred cards. The tints carry the same split visually; the headings carry
 * it in words, and neither is load-bearing on its own.
 *
 * Recently served is a column and not a drawer because the question it answers
 * — "did that go out?" — is asked while looking at the board, and a panel you
 * have to open to answer it is a panel nobody opens.
 */

import { memo } from 'react'
import type { KotStatus } from '../../services/types'
import type { KitchenTicket as Ticket, Lane } from '../types'
import type { LaneGroups } from '../derive'
import { KitchenTicketCard } from './KitchenTicket'

const LANE_META: Record<Lane, { title: string; blurb: string; empty: string }> = {
  new: { title: 'New orders', blurb: 'Just in. Start preparing.', empty: 'No new tickets.' },
  preparing: { title: 'Preparing', blurb: 'In progress. Keep it going.', empty: 'Nothing on the line.' },
  ready: { title: 'Ready for pickup', blurb: 'All set. Notify the floor.', empty: 'Nothing waiting on the pass.' },
  served: { title: 'Recently served', blurb: 'Completed tickets.', empty: 'Nothing served yet.' },
}

/**
 * One lane.
 *
 * Exported because the board is not the only thing that renders a column: when
 * the kitchen is clear, "Recently served" stays on screen beside the empty
 * state, and it has to be the same column rather than a second one that drifts.
 */
export function KitchenColumn({
  lane,
  tickets,
  nowMs,
  fetchedAt,
  warnPc,
  pending,
  arrived,
  canOperate,
  canCancel,
  onAdvance,
  onCancel,
  onOpenHistory,
  servedTotal,
}: {
  lane: Lane
  tickets: Ticket[]
  nowMs: number
  fetchedAt: number
  warnPc: number
  pending: ReadonlySet<number>
  arrived: ReadonlySet<number>
  canOperate: boolean
  canCancel: boolean
  onAdvance: (ticket: Ticket, to: KotStatus) => void
  onCancel: (ticket: Ticket) => void
  onOpenHistory: () => void
  servedTotal: number
}) {
  const meta = LANE_META[lane]

  return (
    <section className={`kds-col kds-col--${lane}`} aria-label={`${meta.title}, ${tickets.length}`}>
      <header className="kds-col__head">
        <div style={{ minWidth: 0 }}>
          <h2>{meta.title}</h2>
          <p>{meta.blurb}</p>
        </div>
        {lane === 'served' && servedTotal > tickets.length ? (
          <button type="button" className="kds-col__link" onClick={onOpenHistory}>
            View all →
          </button>
        ) : (
          <span className="kds-col__count">{tickets.length}</span>
        )}
      </header>

      <div className="kds-col__body">
        {tickets.length === 0 ? (
          <p className="kds-col__empty">{meta.empty}</p>
        ) : (
          tickets.map((ticket) => (
            <KitchenTicketCard
              key={ticket.id}
              ticket={ticket}
              nowMs={nowMs}
              fetchedAt={fetchedAt}
              warnPc={warnPc}
              busy={pending.has(ticket.id)}
              arrived={arrived.has(ticket.id)}
              canOperate={canOperate}
              canCancel={canCancel}
              onAdvance={onAdvance}
              onCancel={onCancel}
            />
          ))
        )}
      </div>
    </section>
  )
}

export interface BoardProps {
  groups: LaneGroups
  lanes: Lane[]
  nowMs: number
  fetchedAt: number
  warnPc: number
  pending: ReadonlySet<number>
  arrived: ReadonlySet<number>
  canOperate: boolean
  canCancel: boolean
  onAdvance: (ticket: Ticket, to: KotStatus) => void
  onCancel: (ticket: Ticket) => void
  onOpenHistory: () => void
  servedTotal: number
}

export const KitchenBoard = memo(function KitchenBoard({
  groups,
  lanes,
  nowMs,
  fetchedAt,
  warnPc,
  pending,
  arrived,
  canOperate,
  canCancel,
  onAdvance,
  onCancel,
  onOpenHistory,
  servedTotal,
}: BoardProps) {
  return (
    <div className={lanes.length === 3 ? 'kds-board kds-board--three' : 'kds-board'}>
      {lanes.map((lane) => (
        <KitchenColumn
          key={lane}
          lane={lane}
          tickets={groups[lane]}
          nowMs={nowMs}
          fetchedAt={fetchedAt}
          warnPc={warnPc}
          pending={pending}
          arrived={arrived}
          canOperate={canOperate}
          canCancel={canCancel}
          onAdvance={onAdvance}
          onCancel={onCancel}
          onOpenHistory={onOpenHistory}
          servedTotal={servedTotal}
        />
      ))}
    </div>
  )
})
