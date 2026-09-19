/**
 * Which outlets hold on to their customers.
 *
 * Bars normalise against the biggest value rather than against the total: the
 * question is "how does Whitefield compare with the best outlet", not "what
 * share of the company is it".
 *
 * A customer who bought at two outlets is counted at both. That is deliberate
 * and stated on the panel — they are a returning customer of both shops, and
 * assigning them to one would flatter it at the other's expense.
 */

import { Store } from 'lucide-react'
import { compactMoney, count, money, percent } from '../format'
import { Panel, Unavailable } from '../shell'
import type { CustomerOutlet, CustomersBoard } from '../types'
import type { OutletMetric } from './constants'

const METRICS: Array<{ id: OutletMetric; label: string }> = [
  { id: 'customers', label: 'By customers' },
  { id: 'repeat', label: 'By repeat rate' },
  { id: 'revenue', label: 'By revenue' },
]

function valueOf(outlet: CustomerOutlet, metric: OutletMetric): number | null {
  if (metric === 'revenue') return outlet.identified_net
  if (metric === 'repeat') return outlet.repeat_rate_pc

  return outlet.customers
}

function displayOf(outlet: CustomerOutlet, metric: OutletMetric): string {
  if (metric === 'revenue') return compactMoney(outlet.identified_net)
  if (metric === 'repeat') return percent(outlet.repeat_rate_pc, 0)

  return count(outlet.customers)
}

export function TopOutletsPanel({
  board,
  metric,
  onMetric,
  selectedOutlet,
  onSelectOutlet,
}: {
  board: CustomersBoard
  metric: OutletMetric
  onMetric: (metric: OutletMetric) => void
  selectedOutlet: number | null
  onSelectOutlet: (locationId: number | null) => void
}) {
  const ranked = [...board.outlets].sort((a, b) => (valueOf(b, metric) ?? -1) - (valueOf(a, metric) ?? -1))
  const top = ranked.reduce((best, outlet) => Math.max(best, valueOf(outlet, metric) ?? 0), 0)
  const single = board.outlets.length === 1

  return (
    <Panel
      title="Outlets"
      description={single ? 'This outlet, in this period.' : 'How each outlet is doing at bringing customers back.'}
      action={
        <label className="cg-select">
          <span className="pos-visually-hidden">Rank outlets by</span>
          <select value={metric} onChange={(e) => onMetric(e.target.value as OutletMetric)}>
            {METRICS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {ranked.length === 0 ? (
        <Unavailable muted title="No outlets set up yet">
          Add an outlet in Setup and its customers appear here.
        </Unavailable>
      ) : (
        <ul className="cg-outlets">
          {ranked.map((outlet) => {
            const value = valueOf(outlet, metric)
            const width = top > 0 && value !== null ? Math.max(2, (value / top) * 100) : 0
            const chosen = selectedOutlet === outlet.location_id

            return (
              <li key={outlet.location_id}>
                <button
                  type="button"
                  className="cg-outlet"
                  aria-pressed={chosen}
                  // Pressing an outlet narrows the whole board to it, using the
                  // page's existing outlet filter. Pressing the chosen one
                  // again widens back out.
                  onClick={() => onSelectOutlet(chosen ? null : outlet.location_id)}
                  aria-label={`${outlet.display_name}: ${displayOf(outlet, metric)}. ${
                    chosen ? 'Showing every outlet again' : 'Narrow this board to this outlet'
                  }`}
                >
                  <span className="cg-outlet__name">
                    <Store size={13} strokeWidth={2} aria-hidden />
                    <span>{outlet.display_name}</span>
                  </span>
                  <span className="cg-outlet__track" aria-hidden>
                    <span className="cg-outlet__fill" style={{ width: `${width}%` }} />
                  </span>
                  <span className="cg-outlet__value">{displayOf(outlet, metric)}</span>
                </button>
                <span className="cg-outlet__sub">
                  {count(outlet.customers)} identified · {count(outlet.repeat_customers)} came back ·{' '}
                  {money(outlet.identified_net)}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <p className="pos-note">
        {single
          ? 'Only one outlet is set up, so there is nothing to compare it against.'
          : 'A customer who bought at two outlets is counted at both. Identified bills only.'}
      </p>
    </Panel>
  )
}
