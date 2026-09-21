/**
 * Shift Overview — who has custody of which drawer, and whether it balanced.
 *
 * THE SERVER'S STATUSES SURVIVE. A board that folded OPEN, CLOSING and CLOSED
 * into "running / closed" would hide the state a manager most needs: a shift
 * stuck mid-close is neither of those things.
 *
 * SEVEN COLUMNS, NOT TEN. Opened and closed share one cell; the shift name is
 * itself the focus control rather than a column holding a button that says
 * "Focus"; and counted cash is left out because expected plus variance already
 * says it. At the width this card gets on a 1366 laptop, every column spent on
 * chrome is a column of figures pushed out of sight — and variance is the one
 * that must never be the column past the edge.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, ChevronDown, Clock3 } from 'lucide-react'
import { actor, clock, count, dateTime, money, moneyExact } from '../format'
import { ControlCard, Pill, WidgetEmptyState, type PillTone } from './primitives'
import type { ShiftRow } from './derive'

const STATUS_TONE: Record<string, PillTone> = {
  OPEN: 'info',
  CLOSING: 'warning',
  CLOSED: 'success',
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open',
  CLOSING: 'Closing',
  CLOSED: 'Closed',
}

const REVIEW_LABEL: Record<ShiftRow['reviewState'], string> = {
  open: 'Still open',
  balanced: 'Balanced',
  needs_review: 'Out, unsigned',
  approved: 'Out, approved',
}

const REVIEW_TONE: Record<ShiftRow['reviewState'], PillTone> = {
  open: 'info',
  balanced: 'success',
  needs_review: 'danger',
  approved: 'warning',
}

/**
 * The status of a shift, said once but chosen from two facts.
 *
 * The server's status is what the row is; the review state is what it means for
 * the close-out. A drawer that is CLOSED and ₹150 short with nobody's name
 * against it is not "Closed", and showing only the first word is how it gets
 * missed at the end of a long day.
 */
export function ShiftStatusBadge({ status, reviewState }: { status: string; reviewState: ShiftRow['reviewState'] }) {
  if (reviewState === 'needs_review' || reviewState === 'approved') {
    return (
      <Pill tone={REVIEW_TONE[reviewState]} dot>
        {REVIEW_LABEL[reviewState]}
      </Pill>
    )
  }

  return (
    <Pill tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
    </Pill>
  )
}

type SortKey = 'opened' | 'counter' | 'expected' | 'variance'

type Sort = { key: SortKey; ascending: boolean }

function compare(a: ShiftRow, b: ShiftRow, key: SortKey): number {
  switch (key) {
    case 'counter':
      return a.counter.localeCompare(b.counter)
    case 'expected':
      return a.expected - b.expected
    case 'variance':
      // Uncounted drawers sort last whichever way the column points: they have
      // no variance, and treating null as zero would file them among the ones
      // that balanced.
      if (a.variance === null && b.variance === null) return 0
      if (a.variance === null) return 1
      if (b.variance === null) return -1

      return a.variance - b.variance
    default:
      return a.openedAt.localeCompare(b.openedAt)
  }
}

function SortButton({ label, column, sort, setSort }: { label: string; column: SortKey; sort: Sort; setSort: (next: Sort) => void }) {
  const active = sort.key === column

  return (
    <button
      type="button"
      className="cc-th-button"
      onClick={() => setSort({ key: column, ascending: active ? !sort.ascending : true })}
    >
      {label}
      {active && <ChevronDown size={12} aria-hidden style={{ transform: sort.ascending ? 'rotate(180deg)' : undefined }} />}
    </button>
  )
}

function sortState(sort: Sort, column: SortKey): 'ascending' | 'descending' | 'none' {
  if (sort.key !== column) return 'none'

  return sort.ascending ? 'ascending' : 'descending'
}

export function ShiftOverviewCard({
  shifts,
  totalShifts,
  focusedSession,
  onFocus,
  narrowed,
  canOpenTill,
}: {
  shifts: ShiftRow[]
  totalShifts: number
  focusedSession: number | null
  onFocus: (sessionId: number | null) => void
  /** True when the client-side filters are hiding some of the fetched shifts. */
  narrowed: boolean
  canOpenTill: boolean
}) {
  const [sort, setSort] = useState<Sort>({ key: 'opened', ascending: false })

  const rows = useMemo(() => {
    const sorted = [...shifts].sort((a, b) => compare(a, b, sort.key))

    return sort.ascending ? sorted : sorted.reverse()
  }, [shifts, sort])

  return (
    <ControlCard
      title="Shift overview"
      icon={<Clock3 size={15} />}
      flush
      tools={
        <>
          {focusedSession !== null && (
            <button type="button" className="cc-link" onClick={() => onFocus(null)}>
              Clear focus
            </button>
          )}
          <Link className="cc-link" to="/reports">
            View all shifts <ArrowUpRight size={13} aria-hidden />
          </Link>
        </>
      }
    >
      {rows.length === 0 ? (
        <WidgetEmptyState title={narrowed ? 'No shifts match these filters' : 'No active shifts'}>
          {narrowed
            ? `${count(totalShifts)} shift${totalShifts === 1 ? '' : 's'} were fetched for this period. Widen the filters to see them.`
            : 'No shift was opened for the selected period and outlet.'}
          {!narrowed && canOpenTill && (
            <>
              {' '}
              <Link className="cc-link" to="/till">
                Open a till
              </Link>
            </>
          )}
        </WidgetEmptyState>
      ) : (
        <div className="cc-table-wrap">
          <table className="cc-table">
            <thead>
              <tr>
                <th scope="col">Shift</th>
                <th scope="col" aria-sort={sortState(sort, 'counter')}>
                  <SortButton label="Counter" column="counter" sort={sort} setSort={setSort} />
                </th>
                <th scope="col">Staff</th>
                <th scope="col" aria-sort={sortState(sort, 'opened')}>
                  <SortButton label="Start · end" column="opened" sort={sort} setSort={setSort} />
                </th>
                <th scope="col" className="is-number" aria-sort={sortState(sort, 'expected')}>
                  <SortButton label="Expected" column="expected" sort={sort} setSort={setSort} />
                </th>
                <th scope="col" className="is-number" aria-sort={sortState(sort, 'variance')}>
                  <SortButton label="Variance" column="variance" sort={sort} setSort={setSort} />
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((shift) => (
                <tr key={shift.sessionId} aria-selected={focusedSession === shift.sessionId}>
                  <th scope="row">
                    <button
                      type="button"
                      className="cc-shift-button"
                      aria-pressed={focusedSession === shift.sessionId}
                      onClick={() => onFocus(focusedSession === shift.sessionId ? null : shift.sessionId)}
                      title="Narrow the whole board to this shift"
                    >
                      {shift.partOfDay}
                      <span className="cc-sub">Shift #{shift.sessionId}</span>
                    </button>
                  </th>
                  <td>
                    {shift.counter}
                    {shift.location && <span className="cc-sub">{shift.location}</span>}
                  </td>
                  <td title={shift.staff}>{actor(shift.staff)}</td>
                  <td title={dateTime(shift.openedAt)}>
                    {clock(shift.openedAt)}
                    <span className="cc-sub">
                      {shift.closedAt ? clock(shift.closedAt) : 'still open'}
                    </span>
                  </td>
                  <td className="is-number">{money(shift.expected)}</td>
                  <td className="is-number">
                    {shift.variance === null ? (
                      <span className="cc-muted">—</span>
                    ) : Math.abs(shift.variance) < 0.005 ? (
                      <span className="cc-amount-level">{moneyExact(0)}</span>
                    ) : (
                      <span className={shift.variance < 0 ? 'cc-amount-short' : 'cc-amount-over'}>
                        {moneyExact(shift.variance)}
                      </span>
                    )}
                  </td>
                  <td>
                    <ShiftStatusBadge status={shift.status} reviewState={shift.reviewState} />
                    {shift.varianceReason && (
                      <span className="cc-sub" title={shift.varianceReason}>
                        “{shift.varianceReason}”
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ControlCard>
  )
}
