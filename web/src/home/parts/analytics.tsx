/**
 * Today's takings, and what sold.
 *
 * The chart is the dashboards' own TrendChart — inline SVG with the same
 * figures repeated as a table in the accessibility tree. This product carries no
 * charting library on purpose (a till is often a cheap tablet on shop
 * broadband) and this screen was not the place to add the first one.
 *
 * The period selector asks the SAME board for a wider window rather than
 * computing a second version of "net sales" in the browser.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Trophy } from 'lucide-react'
import { TrendChart } from '../../dashboards/charts'
import { count, money } from '../../dashboards/format'
import type { OverviewBoard } from '../../dashboards/types'
import { useBoard } from '../../dashboards/useDashboard'
import { buildTrend, initialsFor, windowFor, type TrendPeriod } from '../model'
import { WidgetEmpty, WidgetFailed, WidgetRestricted } from './states'

const PERIODS: Array<{ value: TrendPeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
]

export function SalesTrendCard({
  board,
  loading,
  error,
  onRetry,
  allowed,
}: {
  board: OverviewBoard | null
  loading: boolean
  error: string | null
  onRetry: () => void
  allowed: boolean
}) {
  const [period, setPeriod] = useState<TrendPeriod>('today')

  const window = useMemo(() => windowFor(period, new Date()), [period])
  const wide = useBoard<OverviewBoard>(
    'v1/dashboards/overview',
    { from: window.from, to: window.to, compare: 'previous' },
    allowed && period !== 'today',
  )

  const source = period === 'today' ? board : wide.data
  const busy = period === 'today' ? loading : wide.loading
  const failure = period === 'today' ? error : wide.error
  const points = useMemo(() => buildTrend(source?.series ?? null, new Date()), [source])

  return (
    <section className="home-card home-trend-card" aria-label="Sales trend">
      <div className="home-card__head">
        <h2>
          <LineChart size={16} aria-hidden /> Sales Trend
        </h2>
        <label>
          <span className="pos-visually-hidden">Period</span>
          <select
            className="home-select"
            value={period}
            onChange={(event) => setPeriod(event.target.value as TrendPeriod)}
            disabled={!allowed}
          >
            {PERIODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="home-card__body">
        {!allowed ? (
          <WidgetRestricted>Takings across the shop need the reports permission.</WidgetRestricted>
        ) : failure ? (
          <WidgetFailed message={`Unable to load the sales trend. ${failure}`} onRetry={period === 'today' ? onRetry : wide.refresh} />
        ) : busy ? (
          <div aria-busy="true" role="status" aria-label="Loading the sales trend">
            <div className="home-skeleton home-skeleton--line" style={{ width: 120 }} />
            <div className="home-skeleton home-skeleton--chart" style={{ marginTop: 14 }} />
          </div>
        ) : (
          <>
            <div className="home-trend__summary">
              <strong>{money(source?.sales.net ?? 0)}</strong>
              <small>
                {count(source?.sales.bills ?? 0)} bill{(source?.sales.bills ?? 0) === 1 ? '' : 's'} ·{' '}
                {period === 'today' ? 'today' : PERIODS.find((p) => p.value === period)?.label.toLowerCase()}
              </small>
            </div>

            {points.length === 0 ? (
              <WidgetEmpty title={period === 'today' ? 'No sales recorded yet today.' : 'No sales in this period.'}>
                The line appears with the first completed bill.
              </WidgetEmpty>
            ) : (
              <>
                <TrendChart
                  points={points}
                  valueLabel="Net sales"
                  comparisonLabel={source?.window.comparison?.label ?? null}
                  format={(value) => money(value)}
                  height={190}
                  width={440}
                  caption={`Net sales ${source?.window.from ?? ''} to ${source?.window.to ?? ''}`}
                />
                <p className="home-note" style={{ marginTop: 10 }}>
                  {source?.metric_basis.net_sales}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}

const TINTS = ['green', 'blue', 'violet', 'teal', 'amber'] as const

export function TopItemsCard({
  board,
  loading,
  error,
  onRetry,
  allowed,
}: {
  board: OverviewBoard | null
  loading: boolean
  error: string | null
  onRetry: () => void
  allowed: boolean
}) {
  const items = (board?.top_items ?? []).slice(0, 5)

  return (
    <section className="home-card home-top-card" aria-label="Top selling items">
      <div className="home-card__head">
        <h2>
          <Trophy size={16} aria-hidden /> Top Selling Items
        </h2>
        {allowed && board && items.length > 0 && (
          <Link className="home-btn home-btn--quiet" to="/overview">
            View all
          </Link>
        )}
      </div>

      <div className={items.length > 0 && !loading && !error && allowed ? 'home-card__body home-card__body--flush' : 'home-card__body'}>
        {!allowed ? (
          <WidgetRestricted>What sold across the shop needs the reports permission.</WidgetRestricted>
        ) : error ? (
          <WidgetFailed message={`Unable to load top items. ${error}`} onRetry={onRetry} />
        ) : loading ? (
          <div aria-busy="true" role="status" aria-label="Loading top items">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="home-skeleton home-skeleton--line" style={{ height: 30, marginBottom: 10 }} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <WidgetEmpty title="Nothing sold yet today.">
            Top products appear after the first completed sale.
          </WidgetEmpty>
        ) : (
          <div className="home-items">
            {items.map((item, index) => (
              <div className="home-item" key={`${item.item_id ?? 'x'}-${item.display_name}`}>
                <span className="home-item__rank">{index + 1}</span>
                <span
                  className="home-item__avatar"
                  aria-hidden
                  style={{
                    color: `var(--home-${TINTS[index % TINTS.length]})`,
                    background: `var(--home-${TINTS[index % TINTS.length]}-soft)`,
                  }}
                >
                  {initialsFor(item.display_name)}
                </span>
                <span className="home-item__name">
                  <strong title={item.display_name}>{item.display_name}</strong>
                  <small>
                    {count(item.qty)} sold
                    {item.returned_qty > 0 ? ` · ${count(item.returned_qty)} returned` : ''}
                  </small>
                </span>
                <span className="home-item__money">{money(item.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
