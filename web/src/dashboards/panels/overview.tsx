/**
 * The Business Overview panels.
 *
 * Every one of them drills somewhere: a manager who cannot get from a number to
 * the rows behind it stops believing the number.
 *
 * THE SHAPE OF THIS BOARD, and why it is this shape. The five cards answer
 * "how did we do"; the strip under them answers "is anything wrong"; the first
 * row of panels answers "when, where, and paid how"; the second answers "what
 * sold, when are we busy, what came back, and what can I do about it". A
 * manager reads top to bottom and stops as soon as the answer is good, which is
 * why nothing further down is needed to make sense of anything above it.
 *
 * NOTHING HERE INVENTS A FIGURE. Every total was summed in PostgreSQL over
 * NUMERIC columns; the browser computes shares for bar widths and nothing else,
 * and the number printed beside a bar is always the one the server sent.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Download,
  Info,
  PlayCircle,
  RefreshCw,
  ScrollText,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import {
  ColumnChart,
  DonutChart,
  Heatmap,
  type ColumnPoint,
  type HeatCell,
} from '../charts'
import { changePc, compactMoney, count, decimal, money, moneyExact, percent, signedPercent } from '../format'
import {
  DashboardDrawer,
  InsightCard,
  Panel,
  StatusBadge,
  Unavailable,
  type BadgeTone,
} from '../shell'
import type { InsightItem, OverviewBoard } from '../types'
import type { DashboardFilters } from '../useDashboard'
import { withFilters } from '../registry'
import { AttentionRow } from './common'

// ---------------------------------------------------------------------------
// Shared reading of the series
// ---------------------------------------------------------------------------

/**
 * A bucket key as a person reads it.
 *
 * `13:00` is an hour of a day and `2026-09-19` is a day; the two never appear in
 * the same series, so one function handles both by looking at the key.
 */
export function bucketLabel(bucket: string): string {
  if (/^\d{2}:\d{2}$/.test(bucket)) {
    const hour = Number.parseInt(bucket.slice(0, 2), 10)
    const suffix = hour < 12 ? 'am' : 'pm'

    return `${hour % 12 === 0 ? 12 : hour % 12}${suffix}`
  }

  const date = new Date(`${bucket}T00:00:00`)

  return Number.isNaN(date.getTime())
    ? bucket
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The same key, spelled out, for a tooltip and a table row. */
function bucketLongLabel(bucket: string): string {
  if (/^\d{2}:\d{2}$/.test(bucket)) {
    const hour = Number.parseInt(bucket.slice(0, 2), 10)
    const name = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`

    return name(hour)
  }

  const date = new Date(`${bucket}T00:00:00`)

  return Number.isNaN(date.getTime())
    ? bucket
    : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const SEVERITY_TONE: Record<string, BadgeTone> = {
  danger: 'danger',
  warning: 'warning',
  success: 'success',
  info: 'info',
}

// ---------------------------------------------------------------------------
// Sales trend
// ---------------------------------------------------------------------------

type TrendMetric = 'net' | 'bills' | 'average' | 'returns'

const TREND_METRICS: Array<{ id: TrendMetric; label: string }> = [
  { id: 'net', label: 'Net sales' },
  { id: 'bills', label: 'Bills' },
  { id: 'average', label: 'Average bill' },
  { id: 'returns', label: 'Returns' },
]

/**
 * When the money came in.
 *
 * THE COMPARISON LINE ONLY APPEARS OVER NET SALES, because net sales per bucket
 * is the only comparison series the server sends. Drawing it over "bills" by
 * dividing something by something would be a line nobody could reconcile, so
 * the marker is simply absent on the other three metrics and the legend with it.
 */
export function SalesTrendCard({ board, filters }: { board: OverviewBoard; filters: DashboardFilters }) {
  const [metric, setMetric] = useState<TrendMetric>('net')
  const isMoney = metric !== 'bills'
  const comparisonLabel = board.window.comparison?.label ?? null

  const points = useMemo<ColumnPoint[]>(
    () =>
      board.series.points.map((point) => {
        const value =
          metric === 'net'
            ? point.net
            : metric === 'bills'
              ? point.bills
              : metric === 'returns'
                ? point.returns
                : point.bills > 0
                  ? point.net / point.bills
                  : 0

        return {
          label: bucketLabel(point.bucket),
          tooltipLabel: bucketLongLabel(point.bucket),
          value,
          comparison: metric === 'net' ? (board.series.comparison_by_bucket?.[point.bucket] ?? null) : null,
          secondary:
            metric === 'bills'
              ? money(point.net)
              : `${count(point.bills)} bill${point.bills === 1 ? '' : 's'}`,
        }
      }),
    [board.series, metric],
  )

  const heading = TREND_METRICS.find((entry) => entry.id === metric)?.label ?? 'Net sales'

  return (
    <Panel
      title="Sales trend"
      description={
        board.series.bucket === 'hour'
          ? `${heading} by hour, in the outlet's own timezone (${board.window.timezone}).`
          : `${heading} by business day, in the outlet's own timezone.`
      }
      action={
        <div className="pos-panel__tools">
          <label className="pos-select">
            <span className="pos-visually-hidden">Metric to plot</span>
            <select value={metric} onChange={(event) => setMetric(event.target.value as TrendMetric)}>
              {TREND_METRICS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/retail', filters)}>
            See the bills
          </Link>
        </div>
      }
    >
      {points.length === 0 ? (
        <Unavailable muted title="Nothing to plot">
          No completed bill falls inside this window, so there is no shape to draw.
        </Unavailable>
      ) : (
        <ColumnChart
          points={points}
          valueLabel={heading}
          comparisonLabel={metric === 'net' ? comparisonLabel : null}
          format={(value) => (isMoney ? compactMoney(value) : count(Math.round(value)))}
          caption={`${heading} from ${board.window.from} to ${board.window.to}`}
        />
      )}
      <p className="pos-note">{metric === 'returns' ? board.metric_basis.returns : board.metric_basis.net_sales}</p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Outlet performance
// ---------------------------------------------------------------------------

/**
 * Which shop is carrying the period.
 *
 * WITH ONE OUTLET THERE IS NO COMPARISON and the card says so instead of
 * showing a single bar at 100% and a rank of one, which reads like a league
 * table with the losers hidden.
 *
 * The badge is "of target" where a target is set and "of takings" where it is
 * not — never a growth percentage, because the server sends no per-outlet
 * comparison window and a growth figure derived from one outlet's share would
 * be a number about the other outlets.
 */
export function OutletPerformanceCard({
  board,
  filters,
  onOutlet,
}: {
  board: OverviewBoard
  filters: DashboardFilters
  onOutlet: (locationId: number) => void
}) {
  const trading = board.outlets.filter((outlet) => outlet.net > 0 || outlet.bills > 0)
  const best = Math.max(0, ...board.outlets.map((outlet) => outlet.net))
  const total = board.outlets.reduce((sum, outlet) => sum + Math.max(0, outlet.net), 0)
  const single = board.outlets.length === 1

  return (
    <Panel
      title="Outlet performance"
      description={single ? 'Net sales for this outlet.' : 'Net sales, against the strongest outlet in the period.'}
      action={
        !single && trading.length > 0 ? (
          <span className="pos-muted pos-panel__hint">{count(trading.length)} trading</span>
        ) : null
      }
    >
      {board.outlets.length === 0 ? (
        <Unavailable muted title="No outlets yet">
          Set an outlet up under Setup before this board has anything to compare.
        </Unavailable>
      ) : (
        <ul className="pos-ranks">
          {board.outlets.map((outlet) => {
            const share = total > 0 ? (Math.max(0, outlet.net) / total) * 100 : 0
            const width = best > 0 ? (Math.max(0, outlet.net) / best) * 100 : 0
            const active = filters.locationId === outlet.location_id

            return (
              <li key={outlet.location_id}>
                <button
                  type="button"
                  className={active ? 'pos-rank pos-rank--active' : 'pos-rank'}
                  onClick={() => onOutlet(active ? 0 : outlet.location_id)}
                  aria-pressed={active}
                  aria-label={`${outlet.display_name}: ${money(outlet.net)} over ${count(outlet.bills)} bills. ${
                    active ? 'Showing this outlet only. Press to show every outlet.' : 'Press to narrow the board to it.'
                  }`}
                >
                  <span className="pos-rank__head">
                    <span className="pos-rank__name">{outlet.display_name}</span>
                    <span className="pos-rank__value num">{money(outlet.net)}</span>
                  </span>

                  <span className="pos-rank__track" aria-hidden>
                    <span
                      className={outlet.net > 0 ? 'pos-rank__fill' : 'pos-rank__fill pos-rank__fill--empty'}
                      style={{ width: `${Math.max(width, outlet.net > 0 ? 3 : 0)}%` }}
                    />
                  </span>

                  <span className="pos-rank__foot">
                    <span className="pos-muted">
                      {count(outlet.bills)} bill{outlet.bills === 1 ? '' : 's'} · {money(outlet.average_bill)} average
                    </span>
                    {outlet.target_pc !== null ? (
                      <StatusBadge tone={outlet.target_pc >= 100 ? 'success' : outlet.target_pc >= 80 ? 'warning' : 'danger'}>
                        {percent(outlet.target_pc, 0)} of target
                      </StatusBadge>
                    ) : single ? null : (
                      <StatusBadge tone="neutral">{percent(share, 0)} of takings</StatusBadge>
                    )}
                  </span>

                  {outlet.exceptions > 0 && (
                    <span className="pos-rank__flag">
                      <StatusBadge tone="warning" dot>
                        {count(outlet.exceptions)} stuck with Books or Inventory
                      </StatusBadge>
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="pos-note">
        <Link className="pos-link" to={withFilters('/controls', filters)}>
          Open cash and controls
        </Link>{' '}
        to see the shifts behind these figures.
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Payment method mix
// ---------------------------------------------------------------------------

type TenderView = 'all' | 'collected' | 'recorded'

/**
 * What the shop was paid with — and what that actually proves.
 *
 * The ring is the picture; the table beside it is the data. The distinction the
 * whole card exists to protect is at the bottom: cash is in the drawer and was
 * counted, everything else was typed off somebody else's terminal slip. POS
 * integrates no payment provider, so it cannot promote one to the other however
 * many reference numbers are on file.
 */
export function PaymentMethodMixCard({ board, filters }: { board: OverviewBoard; filters: DashboardFilters }) {
  const [view, setView] = useState<TenderView>('all')

  const lines = board.tenders.filter((line) => view === 'all' || line.settlement_state === view)
  const recorded = lines.filter((line) => line.settlement_state === 'recorded')

  return (
    <Panel
      title="Payment method mix"
      description="Tenders on completed bills in this window."
      action={
        <div className="pos-panel__tools">
          <label className="pos-select">
            <span className="pos-visually-hidden">Which tenders to show</span>
            <select value={view} onChange={(event) => setView(event.target.value as TenderView)}>
              <option value="all">All payments</option>
              <option value="collected">In the drawer</option>
              <option value="recorded">Recorded only</option>
            </select>
          </label>
          <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/controls', filters)}>
            Reconcile
          </Link>
        </div>
      }
    >
      <DonutChart
        slices={lines.map((line) => ({
          key: line.payment_mode,
          label: line.display_name,
          value: line.amount,
          note: `${count(line.count)} tender${line.count === 1 ? '' : 's'}${
            line.settlement_state === 'collected' ? ' · in the drawer' : ''
          }`,
        }))}
        format={(value) => compactMoney(value)}
        centreLabel={view === 'all' ? 'Tendered' : view === 'collected' ? 'In the drawer' : 'Recorded'}
        caption={`Payment mix from ${board.window.from} to ${board.window.to}`}
        emptyLabel={
          view === 'all'
            ? 'No tender was recorded in this period.'
            : 'No tender of that kind was recorded in this period.'
        }
      />

      {recorded.length > 0 && (
        <p className="pos-note">
          <strong>{recorded.map((line) => line.display_name).join(', ')}</strong>{' '}
          {recorded.length === 1 ? 'is' : 'are'} <strong>recorded, not confirmed</strong>: a cashier typed the approval
          from an external terminal. POS integrates no payment provider, so it cannot say the money was collected.
        </p>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Top items
// ---------------------------------------------------------------------------

/**
 * What sold, and the margin on it when Inventory will say.
 *
 * ROWS ARE NOT LINKS. There is no per-item screen in POS, and a row that looks
 * clickable and goes nowhere costs more trust than a row that never offered.
 * The card's action goes to the one place that has more to say about items,
 * which is what sells alongside what.
 */
export function TopItemsCard({ board, filters }: { board: OverviewBoard; filters: DashboardFilters }) {
  const anyReturns = board.top_items.some((item) => item.returned_qty > 0)

  return (
    <Panel
      title="Top items by sales"
      description="By value, on this POS. Quantity is in the item's own selling unit."
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/customers', filters)}>
          What sells together
        </Link>
      }
    >
      {board.top_items.length === 0 ? (
        <Unavailable muted title="Nothing sold in this period">
          Choose another period, or open a till and take a sale.
        </Unavailable>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table pos-table--compact">
            <thead>
              <tr>
                <th scope="col" className="pos-table__rank">
                  #
                </th>
                <th scope="col">Item</th>
                <th scope="col" className="is-number">
                  Qty
                </th>
                <th scope="col" className="is-number">
                  Net sales
                </th>
                {anyReturns && (
                  <th scope="col" className="is-number">
                    Came back
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {board.top_items.map((item, index) => (
                <tr key={`${item.item_id ?? 'x'}-${item.display_name}`}>
                  <td className="pos-table__rank num">{index + 1}</td>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {item.display_name}
                  </th>
                  <td className="is-number">{decimal(item.qty, 2)}</td>
                  <td className="is-number">{money(item.amount)}</td>
                  {anyReturns && (
                    <td className="is-number">
                      {item.returned_qty > 0 ? (
                        <span className="pos-negative">{decimal(item.returned_qty, 2)}</span>
                      ) : (
                        <span className="pos-muted">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {board.margin.available ? (
        <div className="pos-stack pos-stack--tight pos-margin">
          <div className="pos-split">
            <span>Sale value before tax</span>
            <strong>{money(board.margin.revenue)}</strong>
          </div>
          <div className="pos-split">
            <span>Inventory cost of what went out</span>
            <strong>{money(board.margin.cost)}</strong>
          </div>
          <div className="pos-split pos-split--total">
            <span>Gross margin</span>
            <strong>
              {money(board.margin.gross_margin)}
              {board.margin.margin_pc !== null && (
                <span className="pos-muted"> · {percent(board.margin.margin_pc, 1)}</span>
              )}
            </strong>
          </div>
          <p className="pos-note">{board.margin.note}</p>
          <p className="pos-note">{board.margin.revenue_basis}</p>
        </div>
      ) : (
        <div className="pos-margin">
          <Unavailable muted title="Gross margin is not shown">
            {board.margin.note}
          </Unavailable>
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Hourly activity heatmap
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24

  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`
}

/**
 * When the counter is busy, by day and hour.
 *
 * THE COLUMNS ARE DERIVED FROM THE DATA, NOT FIXED AT 6am–10pm. A fixed window
 * looks tidy and silently drops the 4am bakery and the 1am bar — the two shops
 * that most need to see their own shape. The span starts from the earliest and
 * ends at the latest hour that actually took money, widened to an even boundary
 * and never narrower than a normal trading day, so a quiet shop still gets a
 * grid rather than one column.
 */
export function ActivityHeatmapCard({ board }: { board: OverviewBoard }) {
  const [metric, setMetric] = useState<'bills' | 'net'>('bills')

  const { columns, cells } = useMemo(() => {
    const active = board.activity.cells.filter((cell) => cell.bills > 0)
    const first = active.length > 0 ? Math.min(...active.map((cell) => cell.hour)) : 6
    const last = active.length > 0 ? Math.max(...active.map((cell) => cell.hour)) : 22

    // Even boundaries, because each column is a two-hour pair.
    const start = Math.min(6, first - (first % 2))
    const end = Math.max(22, last % 2 === 0 ? last + 1 : last)

    const buckets: number[] = []
    for (let hour = start; hour <= end; hour += 2) buckets.push(hour)

    const totals = new Map<string, { bills: number; net: number }>()
    for (const cell of board.activity.cells) {
      // Which two-hour column this hour falls in. A plain index rather than
      // `findLastIndex`, which needs a newer lib than this project targets.
      const column = Math.floor((cell.hour - start) / 2)
      if (column < 0 || column >= buckets.length) continue
      const key = `${cell.dow - 1}:${column}`
      const current = totals.get(key) ?? { bills: 0, net: 0 }
      totals.set(key, { bills: current.bills + cell.bills, net: current.net + cell.net })
    }

    const heat: HeatCell[] = []
    for (const [key, value] of totals) {
      const [row, column] = key.split(':').map(Number)
      if (row < 0 || row > 6) continue
      const from = buckets[column]
      heat.push({
        row,
        column,
        value: metric === 'bills' ? value.bills : value.net,
        description: `${DAY_NAMES[row]}, ${hourLabel(from)} to ${hourLabel(from + 2)}: ${count(value.bills)} bill${
          value.bills === 1 ? '' : 's'
        }, ${money(value.net)}`,
      })
    }

    return { columns: buckets, cells: heat }
  }, [board.activity.cells, metric])

  return (
    <Panel
      title="Hourly activity heatmap"
      description={`${metric === 'bills' ? 'Bills' : 'Net sales'} by hour and day, in ${board.activity.timezone}.`}
      action={
        <label className="pos-select">
          <span className="pos-visually-hidden">Metric to shade by</span>
          <select value={metric} onChange={(event) => setMetric(event.target.value as 'bills' | 'net')}>
            <option value="bills">Bills count</option>
            <option value="net">Net sales</option>
          </select>
        </label>
      }
    >
      {cells.length === 0 ? (
        <Unavailable muted title="Nothing to shade yet">
          No completed bill falls inside this window, so every hour of it is equally quiet.
        </Unavailable>
      ) : (
        <Heatmap
          rowLabels={DAY_NAMES}
          columnLabels={columns.map(hourLabel)}
          cells={cells}
          valueLabel={metric === 'bills' ? 'Bills' : 'Net sales'}
          format={(value) => (metric === 'bills' ? count(value) : money(value))}
          caption={`Activity by day and hour, ${board.window.from} to ${board.window.to}`}
        />
      )}
      <p className="pos-note">{board.activity.basis}</p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Returns and voids
// ---------------------------------------------------------------------------

/**
 * Why money went back, and why a bill never happened.
 *
 * THE TWO COLUMNS DO NOT ADD UP AND MUST NOT BE TOTALLED. A return moved goods
 * and raised a credit, so its value is money. A void cancelled a bill before it
 * was ever taken, so its value is what the bill would have been and no money
 * moved at all. They share a panel because a manager asks about them in one
 * breath; they keep separate badges, separate subtotals and a note, because
 * adding them produces a refund figure that reconciles against nothing.
 */
export function ReturnsVoidsCard({ board }: { board: OverviewBoard }) {
  const { returns, voids, totals } = board.returns_voids
  const rows = [...returns, ...voids]

  return (
    <Panel
      title="Returns & voids"
      description="By the reason the cashier gave."
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to="/returns">
          View returns
        </Link>
      }
    >
      {rows.length === 0 ? (
        <Unavailable muted title="Nothing came back">
          No return was raised and no bill was voided in this window.
        </Unavailable>
      ) : (
        <>
          <div className="pos-table-wrap">
            <table className="pos-table pos-table--compact">
              <thead>
                <tr>
                  <th scope="col">Reason</th>
                  <th scope="col" className="is-number">
                    Count
                  </th>
                  <th scope="col" className="is-number">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.kind}-${row.reason}`}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      <span style={{ display: 'block' }}>{row.display_name}</span>
                      <StatusBadge tone={row.kind === 'return' ? 'warning' : 'neutral'}>
                        {row.kind === 'return' ? 'Return' : 'Void'}
                      </StatusBadge>
                    </th>
                    <td className="is-number">{count(row.count)}</td>
                    <td className="is-number">
                      {moneyExact(row.amount)}
                      {!row.amount_is_money && <span className="pos-visually-hidden"> — not money that moved</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Refunded</th>
                  <td className="is-number">{count(totals.returns_count)}</td>
                  <td className="is-number">{moneyExact(totals.returns_value)}</td>
                </tr>
                <tr>
                  <th scope="row">Voided before payment</th>
                  <td className="is-number">{count(totals.voids_count)}</td>
                  <td className="is-number">{moneyExact(totals.voids_value)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="pos-note">{board.returns_voids.note}</p>
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

/**
 * The five things a manager does straight off this board.
 *
 * EVERY ONE OF THEM GOES SOMEWHERE THAT EXISTS. An action whose destination is
 * not built is not rendered greyed out with a tooltip — it is absent, and the
 * grid closes over it.
 */
export function QuickActionsCard({
  onReviewExceptions,
  onRefresh,
  onExport,
  refreshing,
  exceptions,
  canOpenShift,
  canSeeReports,
}: {
  onReviewExceptions: () => void
  onRefresh: () => void
  onExport: () => void
  refreshing: boolean
  exceptions: number
  canOpenShift: boolean
  canSeeReports: boolean
}) {
  return (
    <Panel title="Quick actions" description="The next step, from here.">
      <div className="pos-quickactions">
        <button
          type="button"
          className={exceptions > 0 ? 'pos-quickaction pos-quickaction--alert' : 'pos-quickaction'}
          onClick={onReviewExceptions}
        >
          <TriangleAlert size={16} aria-hidden />
          <span>Review exceptions</span>
          {exceptions > 0 && <span className="pos-quickaction__count num">{count(exceptions)}</span>}
        </button>

        {canOpenShift && (
          <Link className="pos-quickaction" to="/">
            <PlayCircle size={16} aria-hidden />
            <span>Open a shift</span>
          </Link>
        )}

        {canSeeReports && (
          <Link className="pos-quickaction" to="/reports">
            <ScrollText size={16} aria-hidden />
            <span>Shift report</span>
          </Link>
        )}

        <button type="button" className="pos-quickaction" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={16} aria-hidden />
          <span>{refreshing ? 'Refreshing…' : 'Refresh data'}</span>
        </button>

        <button type="button" className="pos-quickaction" onClick={onExport}>
          <Download size={16} aria-hidden />
          <span>Export summary</span>
        </button>
      </div>

      <p className="pos-note">
        The export is a CSV of exactly what is on this screen, with the window and the filters written into it.
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// The insight strip
// ---------------------------------------------------------------------------

function InsightIcon({ severity }: { severity: string }) {
  if (severity === 'danger') return <CircleAlert size={15} aria-hidden />
  if (severity === 'warning') return <TriangleAlert size={15} aria-hidden />
  if (severity === 'success') return <CircleCheck size={15} aria-hidden />

  return <Info size={15} aria-hidden />
}

/**
 * The briefing strip.
 *
 * "AICOUNTLY AI INSIGHTS" IS THE NAME OF THE SURFACE, NOT A CLAIM ABOUT THE
 * CONTENT. POS has no model integration; every chip here is a threshold
 * crossing computed in SQL from this POS' own rows. So the strip carries a
 * BETA badge, every card inside the drawer is badged "Rule-based alert", and
 * the drawer closes with the server's own note saying no model produced any of
 * it. The day a model does publish here, its items arrive with `kind: 'ai'` and
 * badge themselves differently — which is the whole reason the badge is on the
 * item and not on the panel.
 *
 * A quiet shop gets a short strip. There is no filler chip.
 */
export function AIInsightsPanel({ board }: { board: OverviewBoard }) {
  const [open, setOpen] = useState(false)
  const items = board.insights.items
  const context = board.insights.context

  const contextLine = context
    ? `Read from ${count(context.bills)} bill${context.bills === 1 ? '' : 's'} across ${count(context.outlets)} outlet${
        context.outlets === 1 ? '' : 's'
      } and ${count(context.items)} item${context.items === 1 ? '' : 's'} in this window.`
    : 'Read from this window’s own rows.'

  return (
    <>
      <section className="pos-strip" aria-label="Aicountly insights">
        <div className="pos-strip__brand">
          <p className="pos-strip__title">
            <span className="pos-strip__mark" aria-hidden>
              <Sparkles size={15} />
            </span>
            Aicountly AI Insights
            <span className="pos-strip__beta">BETA</span>
          </p>
          <p className="pos-strip__context">{contextLine}</p>
        </div>

        {items.length === 0 ? (
          <p className="pos-strip__quiet">
            Nothing crossed a threshold. No sale is stuck, no drawer is out and no ticket is late in this window.
          </p>
        ) : (
          <ul className="pos-strip__items">
            {items.slice(0, 4).map((item) => {
              const severity = item.severity ?? 'info'

              return (
                <li key={item.id} className={`pos-chipcard pos-chipcard--${severity}`}>
                  <span className={`pos-chipcard__icon pos-chipcard__icon--${severity}`}>
                    <InsightIcon severity={severity} />
                  </span>
                  <span className="pos-chipcard__body">
                    <strong>{item.title}</strong>
                    {item.metric && <span className="pos-chipcard__metric">{item.metric}</span>}
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <button type="button" className="pos-strip__more" onClick={() => setOpen(true)}>
          View all insights
          <ArrowRight size={14} aria-hidden />
        </button>
      </section>

      <DashboardDrawer
        open={open}
        title="Aicountly insights"
        description={`${count(items.length)} rule${items.length === 1 ? '' : 's'} fired in this window.`}
        onClose={() => setOpen(false)}
      >
        {items.length === 0 ? (
          <Unavailable muted title="Nothing crossed a threshold">
            No rule fired for this window. Nothing is being hidden — there is nothing to show.
          </Unavailable>
        ) : (
          items.map((item) => <InsightCard key={item.id} insight={item} />)
        )}

        <p className="pos-note">
          <StatusBadge tone="neutral">No AI configured</StatusBadge> {board.insights.ai.note}
        </p>
      </DashboardDrawer>
    </>
  )
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export function exceptionCount(board: OverviewBoard): number {
  const a = board.attention

  return a.posting_failed + a.posting_blocked + a.offline_pending + a.cash_variances + a.late_tickets + a.held_bills
}

/**
 * Everything waiting for a person, in one panel.
 *
 * SORTED BY WHO HAS TO DO SOMETHING, NOT BY SIZE. A sale Books refused needs an
 * accountant, a drawer that is out needs a manager's signature and a held bill
 * needs a cashier — so they are three groups, not one "issues" number that
 * nobody owns.
 */
export function ExceptionsDrawer({
  board,
  filters,
  open,
  onClose,
}: {
  board: OverviewBoard
  filters: DashboardFilters
  open: boolean
  onClose: () => void
}) {
  const a = board.attention
  const total = exceptionCount(board)
  const alerts = board.insights.items.filter((item) => item.severity === 'danger' || item.severity === 'warning')

  return (
    <DashboardDrawer
      open={open}
      title="Exceptions"
      description={
        total === 0
          ? 'Nothing is waiting for a person right now.'
          : `${count(total)} item${total === 1 ? '' : 's'} waiting. These are counted across all dates, not only this window.`
      }
      onClose={onClose}
      footer={
        <Link className="pos-button pos-button--primary" to={withFilters('/controls', filters)} onClick={onClose}>
          Open cash, shifts & controls
        </Link>
      }
    >
      <h3>Needs someone now</h3>
      <div className="pos-stack pos-stack--tight">
        <AttentionRow
          label="Refused by Books or Inventory"
          description="A business reason. Retrying will not help until it is fixed."
          value={a.posting_blocked}
          tone="danger"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        <AttentionRow
          label="Drawers out and unsigned"
          description="The count did not match what the shift's own events say it should hold."
          value={a.cash_variances}
          tone="danger"
          href={withFilters('/controls', filters, { panel: 'shifts' })}
        />
      </div>

      <h3>Waiting</h3>
      <div className="pos-stack pos-stack--tight">
        <AttentionRow
          label="Not yet reached Books or Inventory"
          description="A transport failure. Safe to retry on the same key."
          value={a.posting_failed}
          tone="warning"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        <AttentionRow
          label="Offline sales still to post"
          description="Taken on a till that had no connection."
          value={a.offline_pending}
          tone="warning"
          href="/offline"
        />
        <AttentionRow
          label="Kitchen tickets past their station time"
          value={a.late_tickets}
          tone="warning"
          href={withFilters('/restaurant', filters, { panel: 'delays' })}
        />
      </div>

      <h3>For information</h3>
      <div className="pos-stack pos-stack--tight">
        <AttentionRow
          label="In flight — outcome unknown"
          description="Sent, no answer yet. Not the same as failed."
          value={a.posting_in_flight}
          tone="info"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        <AttentionRow
          label="Bills on hold"
          value={a.held_bills}
          tone="info"
          href={withFilters('/retail', filters, { panel: 'held' })}
        />
      </div>

      {alerts.length > 0 && (
        <>
          <h3>Flagged in this window</h3>
          {alerts.map((item) => (
            <InsightCard key={item.id} insight={item} />
          ))}
        </>
      )}

      <p className="pos-note">{board.metric_basis.source}</p>
    </DashboardDrawer>
  )
}

// ---------------------------------------------------------------------------
// Insight helpers the page header uses
// ---------------------------------------------------------------------------

/** The worst thing on the board, for the notification dot on "Review exceptions". */
export function worstSeverity(items: InsightItem[]): BadgeTone | null {
  if (items.some((item) => item.severity === 'danger')) return SEVERITY_TONE.danger
  if (items.some((item) => item.severity === 'warning')) return SEVERITY_TONE.warning

  return null
}

/** The KPI comparison line, built from the two figures the server sent. */
export function kpiComparison(
  current: number,
  previous: number | null | undefined,
  label: string | null | undefined,
  adverseWhenUp = false,
): { label: string; direction: 'up' | 'down' | 'flat'; tone: 'good' | 'bad' | 'neutral' } | null {
  const change = changePc(current, previous)
  if (change === null) return null

  const flat = Math.abs(change) < 0.5
  // Which way is good depends on the metric. Refunds rising is an increase and
  // a problem, so the arrow follows the movement and the colour follows the
  // meaning; the words say the movement either way.
  const direction: 'up' | 'down' | 'flat' = flat ? 'flat' : change > 0 ? 'up' : 'down'
  const good = adverseWhenUp ? change < 0 : change > 0

  return {
    label: `${flat ? 'about the same' : signedPercent(change)} ${label ?? 'vs the comparison period'}`,
    direction,
    tone: flat ? 'neutral' : good ? 'good' : 'bad',
  }
}

