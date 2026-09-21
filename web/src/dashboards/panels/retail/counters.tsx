/**
 * Live counter status.
 *
 * The table a supervisor keeps open. It replaces the card grid this board used
 * to show and carries everything that grid did — the shift, who opened it, what
 * the till has taken, the click that focuses one counter — in a form that fits
 * five counters on screen instead of two.
 *
 * THE "QUEUE" COLUMN IS NOT A QUEUE. Nothing in this product observes people
 * standing in line, so the column counts BILLS SITTING ON THE COUNTER — carts
 * that are open or held on that till right now. It is headed "On counter" for
 * that reason, and the panel's footnote says so. A column headed "Queue" over
 * this number would be the one dishonest thing on the board.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { User } from 'lucide-react'
import { actor, count, dateTime, money, sinceLabel } from '../../format'
import { EmptyState, Panel, StatusBadge, type BadgeTone } from '../../shell'
import type { CounterState, RetailBoard, RetailCounter } from '../../types'
import type { DashboardFilters } from '../../useDashboard'
import { withFilters } from '../../registry'

const STATE: Record<CounterState, { label: string; tone: BadgeTone; note: string }> = {
  busy: { label: 'Busy', tone: 'warning', note: 'A bill is open on this counter.' },
  open: { label: 'Open', tone: 'success', note: 'A shift is open and the till is working.' },
  idle: { label: 'Idle', tone: 'neutral', note: 'A shift is open, with no bill completed for 45 minutes.' },
  closing: { label: 'Closing', tone: 'info', note: 'The drawer is being counted.' },
  closed: { label: 'Closed', tone: 'neutral', note: 'No shift is open on this till.' },
}

const FIRST_PAGE = 5

/** Two letters from a name, for the avatar. Never from a uuid — that is not initials. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Who is signed on.
 *
 * POS stores the sign-on identifier, not a directory of names — those live in
 * the AICOUNTLY portal and POS does not keep a copy of them. So the signed-in
 * person sees their own name and everyone else is shown by the identifier the
 * shift was opened with, shortened, with the whole of it in the tooltip.
 */
function Cashier({ uuid, me }: { uuid: string | null; me: { uuid: string; display_name: string } | null }) {
  if (!uuid) return <span className="pos-muted">No one signed on</span>

  const isMe = me !== null && me.uuid === uuid
  const label = isMe ? me.display_name : actor(uuid)

  return (
    <span className="pos-cashier" title={isMe ? me.display_name : `Shift opened by ${uuid}`}>
      <span className="pos-avatar" aria-hidden>
        {isMe ? initials(me.display_name) : <User size={13} />}
      </span>
      <span className="pos-cashier__name">{label}</span>
    </span>
  )
}

function CounterRow({
  counter,
  selected,
  onFocus,
  me,
}: {
  counter: RetailCounter
  selected: boolean
  onFocus: (terminalId: number) => void
  me: { uuid: string; display_name: string } | null
}) {
  const state = STATE[counter.state] ?? STATE.closed
  const onCounter = counter.open_carts

  return (
    <tr aria-selected={selected}>
      <th scope="row">
        {/* The row is focusable through this one button rather than the whole
            <tr>: a clickable table row is invisible to a keyboard. */}
        <button
          type="button"
          className="pos-counter-row__button"
          onClick={() => onFocus(counter.terminal_id)}
          aria-label={`Focus ${counter.display_name}, ${state.label.toLowerCase()}`}
        >
          <StatusBadge tone={state.tone} dot>
            {counter.terminal_code}
          </StatusBadge>
        </button>
        <span
          className="pos-counter-row__meta"
          title={`${counter.display_name} · ${money(counter.net)} taken on ${count(counter.bills)} bill(s)${
            counter.shift ? ` · shift opened ${dateTime(counter.shift.opened_at)}` : ''
          }`}
        >
          {counter.display_name} · {money(counter.net)}
        </span>
      </th>

      <td>
        <Cashier uuid={counter.shift?.opened_by ?? null} me={me} />
      </td>

      <td className="is-number">
        <span
          className={`pos-pill${onCounter >= 3 ? ' pos-pill--busy' : onCounter > 0 ? ' pos-pill--calm' : ''}`}
          title={`${onCounter} bill(s) open or held on this counter`}
        >
          {count(onCounter)}
        </span>
      </td>

      <td className="is-number" title={counter.bills_per_hour === null ? 'Less than fifteen minutes of trading to measure' : undefined}>
        {counter.bills_per_hour === null ? <span className="pos-muted">—</span> : counter.bills_per_hour}
      </td>

      <td>
        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
      </td>
    </tr>
  )
}

export function LiveCounterStatus({
  board,
  filters,
  onTerminal,
  me,
}: {
  board: RetailBoard
  filters: DashboardFilters
  onTerminal: (terminalId: number) => void
  me: { uuid: string; display_name: string } | null
}) {
  const [expanded, setExpanded] = useState(false)

  const counters = board.counters
  const shown = useMemo(
    () => (expanded ? counters : counters.slice(0, FIRST_PAGE)),
    [counters, expanded],
  )

  const quiet = counters.filter((counter) => counter.state === 'idle').length

  return (
    <Panel
      title="Live counter status"
      description={
        counters.length === 0
          ? undefined
          : `${count(board.kpis.active_counters)} of ${count(board.kpis.total_counters)} open` +
            (quiet > 0 ? `, ${count(quiet)} quiet` : '')
      }
      action={
        counters.length > 0 && (
          <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/controls', filters)}>
            All {count(counters.length)} counters <span aria-hidden>→</span>
          </Link>
        )
      }
    >
      {counters.length === 0 ? (
        <div className="pos-empty-panel">
          <EmptyState title="No retail counters yet">
            Create a till, or assign one to this outlet, and this board starts tracking it.
          </EmptyState>
          <Link className="pos-button pos-button--secondary pos-button--small" to="/setup">
            Go to Setup
          </Link>
        </div>
      ) : (
        <>
          <div className="pos-table-wrap">
            <table className="pos-table pos-table--compact pos-counter-table">
              <thead>
                <tr>
                  <th scope="col">Counter</th>
                  <th scope="col">Cashier</th>
                  <th scope="col" className="is-number" title="Bills open or held on this counter right now">
                    On counter
                  </th>
                  <th scope="col" className="is-number">Bills/hr</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((counter) => (
                  <CounterRow
                    key={counter.terminal_id}
                    counter={counter}
                    selected={filters.terminalId === counter.terminal_id}
                    onFocus={onTerminal}
                    me={me}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {counters.length > FIRST_PAGE && (
            <button
              type="button"
              className="pos-showmore"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
            >
              {expanded
                ? 'Show fewer counters'
                : `Show ${count(counters.length - FIRST_PAGE)} more counter${counters.length - FIRST_PAGE === 1 ? '' : 's'}`}
              <span aria-hidden>{expanded ? '▴' : '▾'}</span>
            </button>
          )}

          <p className="pos-note">
            <strong>On counter</strong> is bills open or held on that till right now — not people waiting. Nothing in
            this product observes a queue. Last activity across all counters:{' '}
            {sinceLabel(
              counters
                .map((counter) => counter.last_activity)
                .filter((at): at is string => at !== null)
                .sort()
                .at(-1) ?? null,
            )}
            .
          </p>
        </>
      )}
    </Panel>
  )
}
