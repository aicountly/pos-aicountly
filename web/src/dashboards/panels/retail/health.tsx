/**
 * Queue and checkout health.
 *
 * THE MISSING METRIC IS THE POINT. Every POS dashboard shows an average
 * waiting time; this one cannot, because nothing in this product watches a
 * queue — there is no camera, no ticket dispenser and no door counter. The
 * panel says that in a footnote instead of filling the slot with a plausible
 * number, and shows the three things the counter really does measure: how long
 * the slowest bills take, how many carts got paid for, and how many were
 * abandoned before payment.
 */

import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { count, duration, money, percent } from '../../format'
import { ContextualEmpty, Panel } from '../../shell'
import type { RetailBoard } from '../../types'
import type { DashboardFilters } from '../../useDashboard'
import { withFilters } from '../../registry'

function Metric({
  label,
  value,
  note,
  title,
}: {
  label: string
  value: string
  note?: string
  title?: string
}) {
  return (
    <div className="pos-health__metric" title={title}>
      <span className="pos-health__label">{label}</span>
      <strong className="pos-health__value">{value}</strong>
      {note && <span className="pos-health__note">{note}</span>}
    </div>
  )
}

export function CheckoutHealth({ board, filters }: { board: RetailBoard; filters: DashboardFilters }) {
  const health = board.checkout_health
  const { checkout, completion, abandonment, on_counter: onCounter } = health

  const measured = completion.started > 0

  return (
    <Panel
      title="Queue & checkout health"
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/controls', filters)}>
          Details <span aria-hidden>→</span>
        </Link>
      }
    >
      {!measured ? (
        <ContextualEmpty title="Nothing to measure yet">
          No cart was opened in this period, so there is no checkout to time and no completion rate to report.
        </ContextualEmpty>
      ) : (
        <>
          <div className="pos-health">
            <Metric
              label="Slowest 1 in 10"
              value={checkout.p90_seconds === null ? 'Not measurable' : duration(checkout.p90_seconds)}
              note={
                checkout.median_seconds === null
                  ? 'Not enough measurable bills'
                  : `median ${duration(checkout.median_seconds)}`
              }
              title="The ninetieth percentile of cart-open to cart-complete, on this POS' own timestamps."
            />
            <Metric
              label="Paid for"
              value={completion.rate_pc === null ? '—' : percent(completion.rate_pc, 1)}
              note={`${count(completion.completed)} of ${count(completion.completed + completion.voided)} settled`}
              title="Completed bills as a share of carts that reached a final state in this window."
            />
            <Metric
              label="Walked away"
              value={abandonment.rate_pc === null ? '—' : percent(abandonment.rate_pc, 1)}
              note={`${count(abandonment.voided)} voided before payment`}
              title="Carts voided before they were paid for. The only abandonment this product can see."
            />
          </div>

          <div className={`pos-verdict pos-verdict--${health.status}`}>
            <Sparkles size={15} className="pos-verdict__icon" aria-hidden />
            <p>
              <strong>
                {health.status === 'unknown'
                  ? 'Not enough bills yet.'
                  : `Checkout is ${health.status === 'healthy' ? 'healthy' : health.status}.`}
              </strong>{' '}
              {health.summary}
              {onCounter.carts > 0 && (
                <>
                  {' '}
                  {count(onCounter.carts)} bill{onCounter.carts === 1 ? '' : 's'} worth {money(onCounter.value)}{' '}
                  {onCounter.carts === 1 ? 'is' : 'are'} sitting on a counter right now
                  {onCounter.oldest_seconds !== null && `, the oldest for ${duration(onCounter.oldest_seconds)}`}.
                </>
              )}
            </p>
          </div>

          <p className="pos-note">
            <strong>No waiting time.</strong> {health.wait.note} {health.basis}
          </p>
        </>
      )}
    </Panel>
  )
}
