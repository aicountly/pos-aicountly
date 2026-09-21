/**
 * New against returning, over the chosen period.
 *
 * The range control here is not a second date filter — it writes to the page's
 * one date filter, which is in the URL. Two controls that both claim to choose
 * the period is how a screen ends up showing a chart from one range beside a
 * KPI from another.
 */

import { TrendChart } from '../charts'
import { count } from '../format'
import { Panel, Unavailable } from '../shell'
import type { CustomersBoard } from '../types'

const RANGES: Array<{ id: string; label: string; days: number }> = [
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 3 months', days: 91 },
  { id: '180d', label: 'Last 6 months', days: 182 },
  { id: '365d', label: 'Last 12 months', days: 365 },
]

/** A bucket key as the axis should read it. */
function axisLabel(bucket: string): string {
  // 2026-09 — a month
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const [year, month] = bucket.split('-').map(Number)

    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
  }
  // 2026-09-18 — a day, shown without the year the axis repeats
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const [, month, day] = bucket.split('-').map(Number)

    return `${day} ${new Date(2000, month - 1, 1).toLocaleDateString(undefined, { month: 'short' })}`
  }

  return bucket
}

export function CustomerTrendPanel({
  board,
  spanDays,
  onRange,
}: {
  board: CustomersBoard
  spanDays: number
  onRange: (days: number) => void
}) {
  const points = board.trend.points.map((point) => ({
    label: axisLabel(point.bucket),
    value: point.returning_bills,
    comparison: point.new_bills,
  }))

  // The closest preset to whatever the date filter currently says, so the
  // control reflects a range that was set from the filter bar too.
  const active = RANGES.reduce<string | null>((best, range) => {
    if (Math.abs(range.days - spanDays) <= 3) return range.id

    return best
  }, null)

  return (
    <Panel
      title="Customer trend"
      description="Bills from someone who had bought here before, against bills from someone new."
      action={
        <label className="cg-select">
          <span className="pos-visually-hidden">Trend range</span>
          <select
            value={active ?? ''}
            onChange={(e) => {
              const range = RANGES.find((r) => r.id === e.target.value)
              if (range) onRange(range.days)
            }}
          >
            {active === null && <option value="">Chosen period</option>}
            {RANGES.map((range) => (
              <option key={range.id} value={range.id}>
                {range.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {points.length === 0 ? (
        <Unavailable muted title="No identified bills in this period">
          Attach a customer at the till and this fills in.
        </Unavailable>
      ) : (
        <TrendChart
          points={points}
          valueLabel="Returning"
          comparisonLabel="New to this POS"
          secondary="series"
          height={240}
          format={(v) => count(Math.round(v))}
          caption={`Identified bills by new and returning, ${board.window.from} to ${board.window.to}`}
        />
      )}
      <p className="pos-note">
        “New” means their first bill on this POS fell in this period. They may have bought from another Aicountly
        product for years — POS cannot see that and does not claim to.
      </p>
    </Panel>
  )
}
