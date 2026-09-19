/**
 * Recent Cash Transactions — every movement of cash except the sale tenders.
 *
 * Sale tenders are excluded by the endpoint, not here: on a busy day they would
 * be several thousand rows and would bury the float top-up and the petty
 * withdrawal, which are the two a manager is actually looking for.
 */

import { useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { actor, clock, count, dateTime, moneyExact, titleCase } from '../format'
import { ControlCard, Pill, WidgetEmptyState, type PillTone } from './primitives'
import type { CashTransactionRow, MovementTone } from './derive'

const TONES: Record<MovementTone, PillTone> = {
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  neutral: 'neutral',
}

/** The kind of movement, with the server's own label inside it. */
export function CashTransactionTypeBadge({ label, tone, kind }: { label: string; tone: MovementTone; kind: string }) {
  return <Pill tone={TONES[tone]}>{label || titleCase(kind)}</Pill>
}

const PREVIEW = 8

export function RecentCashTransactionsCard({ rows }: { rows: CashTransactionRow[] }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? rows : rows.slice(0, PREVIEW)

  return (
    <ControlCard
      title="Recent cash transactions"
      icon={<ArrowLeftRight size={15} />}
      flush
      tools={
        rows.length > PREVIEW ? (
          <button type="button" className="cc-link" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
            {expanded ? 'Show fewer' : `View all ${count(rows.length)} →`}
          </button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <WidgetEmptyState title="No cash movements">
          Nothing went in or out of a drawer in this period beyond the sales themselves.
        </WidgetEmptyState>
      ) : (
        <div className="cc-table-wrap">
          <table className="cc-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Counter</th>
                <th scope="col" className="is-number">Amount</th>
                <th scope="col">By</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.eventId}>
                  <th scope="row" className="cc-strong">
                    {row.reference}
                  </th>
                  <td title={dateTime(row.at)}>{clock(row.at)}</td>
                  <td>
                    <CashTransactionTypeBadge label={row.label} tone={row.tone} kind={row.kind} />
                  </td>
                  <td>{row.account}</td>
                  <td className="is-number">
                    {row.direction === 'none' ? (
                      <span className="cc-muted">{moneyExact(row.amount)}</span>
                    ) : row.direction === 'unclassified' ? (
                      <span title="This drawer event kind is not in the expected-cash formula.">
                        {moneyExact(row.amount)}
                        <span className="cc-sub">unclassified</span>
                      </span>
                    ) : (
                      <span className={row.direction === 'out' ? 'cc-amount-short' : 'cc-amount-level'}>
                        {row.direction === 'out' ? '− ' : '+ '}
                        {moneyExact(row.amount)}
                      </span>
                    )}
                  </td>
                  <td title={row.actor}>
                    {actor(row.actor)}
                    {row.approvedBy && row.approvedBy !== row.actor && (
                      <span className="cc-sub">approved {actor(row.approvedBy)}</span>
                    )}
                  </td>
                  <td className="cc-wrap" title={row.note ?? undefined}>
                    {row.note ?? <span className="cc-muted">—</span>}
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
