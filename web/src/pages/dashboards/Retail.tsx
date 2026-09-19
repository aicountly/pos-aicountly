/**
 * Retail Operations — the counter command centre.
 *
 * WHAT A MANAGER HAS TO SEE IN FIVE SECONDS, in this order down the page:
 * how many counters are working, what has been rung up, what is stuck, how
 * fast checkout is, and what needs a person. Everything below the KPI row
 * answers one of those in more detail, and everything on it comes from
 * `GET v1/dashboards/retail` — one request, one permission check, one
 * consistent snapshot, rather than nine widgets racing each other.
 *
 * THREE THINGS THIS BOARD WILL NOT DO.
 *
 *   It will not report a queue. Nothing here watches people standing in line,
 *   so the counter table counts BILLS on the counter and says so, and the
 *   checkout panel shows the three timings POS genuinely measures instead of
 *   an invented average wait.
 *
 *   It will not badge a threshold as an insight. The pulse strip is headed
 *   "Operations pulse" and marked Rule-based, and flips to AI on the day a
 *   model actually writes it — which is one field on the response away.
 *
 *   It will not colour a rise green because it is a rise. Every trend badge
 *   carries an INTENT as well as a direction, because a checkout that got
 *   slower and a void count that fell are both changes and only one of them
 *   is good news.
 */

import { useCallback, useMemo } from 'react'
import {
  AlertTriangle,
  Clock3,
  PauseCircle,
  ReceiptText,
  Store,
} from 'lucide-react'
import { RatioMeter, Sparkline } from '../../dashboards/charts'
import { ExportMenu, downloadCsv, type CsvRow } from '../../dashboards/export'
import { clockDuration, count, moneyCompact, percent } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards } from '../../dashboards/registry'
import { DashboardBody, PanelSkeleton, PosDashboardShell, type MetricProps, type MetricTrend } from '../../dashboards/shell'
import { Freshness, PulseStrip } from '../../dashboards/panels/common'
import {
  CheckoutHealth,
  DeviceHealth,
  HeldBills,
  HourlySalesTrend,
  LiveCounterStatus,
  OperationalAlerts,
  RecentTransactions,
  RetailAttention,
  ShiftReadiness,
  StockAttention,
  TopSellingCategories,
} from '../../dashboards/panels/retail'
import type { RetailBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'
import { usePos } from '../../context/PosContext'

/**
 * Counters and alerts go stale in minutes, not hours.
 *
 * Forty-five seconds is the compromise between a board that is worth leaving
 * open and a board that costs the server one aggregate query per manager per
 * second. `useBoard` stops the timer entirely while the tab is hidden.
 */
const REFRESH_MS = 45_000

/**
 * A trend badge, coloured by whether the change is GOOD, not by which way it
 * went.
 *
 * Returns null when there is nothing honest to say: no comparison window, or a
 * previous value of zero, where the percentage is infinite and the badge would
 * be a decoration with a number in it.
 */
function trendOf(
  current: number,
  previous: number | null | undefined,
  betterWhen: 'higher' | 'lower',
  label: string | null,
): MetricTrend | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null

  const change = ((current - previous) / previous) * 100
  if (Math.abs(change) < 0.5) {
    return { label: 'level', direction: 'flat', intent: 'neutral', describe: `about the same ${label ?? ''}`.trim() }
  }

  const rose = change > 0
  const good = betterWhen === 'higher' ? rose : !rose

  return {
    label: percent(Math.abs(change), 0),
    direction: rose ? 'up' : 'down',
    intent: good ? 'good' : 'bad',
    describe: `${rose ? 'up' : 'down'} ${percent(Math.abs(change), 0)} ${label ?? 'on the comparison window'}`,
  }
}

function kpis(data: RetailBoard): MetricProps[] {
  const { kpis: k, comparison, trend } = data
  const label = comparison?.label ?? null
  const checkout = k.checkout

  const bills = trend.points.map((point) => point.bills)
  const checkoutSeries = trend.points
    .map((point) => point.checkout_seconds)
    .filter((seconds): seconds is number => seconds !== null)
  const exceptions = trend.points.map((point) => point.voids)

  const comparisonCheckout = comparison?.checkout.available === true ? comparison.checkout.median_seconds : null

  return [
    {
      id: 'counters',
      label: 'Active counters',
      value: `${count(k.active_counters)} / ${count(k.total_counters)}`,
      context: `${count(k.active_counters)} till${k.active_counters === 1 ? '' : 's'} with a shift open`,
      tone: 'green',
      icon: <Store />,
      // A ratio, not a series. There is no history of "how many tills were
      // open an hour ago", so nothing here pretends to draw one.
      figure: <RatioMeter value={k.active_counters} of={k.total_counters} label="Tills with a shift open" />,
    },
    {
      id: 'bills',
      label: 'Completed bills',
      value: count(k.bills),
      context: `${moneyCompact(k.net)} taken`,
      tone: 'blue',
      icon: <ReceiptText />,
      trend: trendOf(k.bills, comparison?.bills, 'higher', label),
      figure: <Sparkline values={bills} tone="blue" />,
    },
    {
      id: 'held',
      label: 'Bills on hold',
      value: count(k.held_bills),
      // No trend badge: held bills are a right-now figure that ignores the
      // date filter, so there is no previous value to compare it against.
      context: `${moneyCompact(k.held_value)} sitting on counters`,
      tone: 'orange',
      icon: <PauseCircle />,
    },
    {
      id: 'checkout',
      label: 'Median checkout',
      value: checkout.available ? clockDuration(checkout.median_seconds) : null,
      context: checkout.available
        ? `across ${count(checkout.sampled)} bill${checkout.sampled === 1 ? '' : 's'}`
        : 'Not enough completed bills to measure',
      tone: 'purple',
      icon: <Clock3 />,
      // Slower is worse, so a rise is red here and green on the card above.
      trend: checkout.available ? trendOf(checkout.median_seconds, comparisonCheckout, 'lower', label) : null,
      figure: <Sparkline values={checkoutSeries} tone="purple" />,
    },
    {
      id: 'exceptions',
      label: 'Needs attention',
      value: count(k.exceptions),
      context: 'Voids, overrides and stuck sales',
      tone: 'red',
      icon: <AlertTriangle />,
      // Windowed against windowed. `exceptions` also counts sales stuck on
      // every date, which no previous window can be compared with.
      trend: trendOf(k.exceptions_windowed, comparison?.exceptions_windowed, 'lower', label),
      figure: <Sparkline values={exceptions} tone="red" />,
    },
  ]
}

export default function Retail() {
  const { filters, update, query } = useDashboardFilters()
  const { can, session } = usePos()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<RetailBoard>('v1/dashboards/retail', query, true, REFRESH_MS)

  const data = board.data
  const maySell = can('sell')
  const mayExport = can('reports.view')

  const me = useMemo(
    () => (session ? { uuid: session.user.uuid, display_name: session.user.display_name } : null),
    [session],
  )

  const periodLabel = filters.from === filters.to ? 'Today' : `${filters.from} — ${filters.to}`

  const focusCounter = useCallback((terminalId: number) => update({ terminalId }), [update])

  const exportOptions = useMemo(() => {
    if (!data || !mayExport) return []

    const stamp = filters.from === filters.to ? filters.from : `${filters.from}_${filters.to}`

    return [
      {
        key: 'counters',
        label: 'Counter status (CSV)',
        disabled: data.counters.length === 0,
        run: () =>
          downloadCsv(
            `retail-counters-${stamp}.csv`,
            data.counters.map<CsvRow>((counter) => ({
              counter: counter.terminal_code,
              name: counter.display_name,
              outlet: counter.location_name,
              status: counter.state,
              on_counter: counter.open_carts,
              bills: counter.bills,
              bills_per_hour: counter.bills_per_hour ?? '',
              taken: counter.net,
              voids: counter.voids,
              shift_opened_by: counter.shift?.opened_by ?? '',
              shift_opened_at: counter.shift?.opened_at ?? '',
            })),
          ),
      },
      {
        key: 'trend',
        label: 'Sales trend (CSV)',
        disabled: data.trend.points.length === 0,
        run: () =>
          downloadCsv(
            `retail-trend-${stamp}.csv`,
            data.trend.points.map<CsvRow>((point) => ({
              bucket: point.bucket,
              bills: point.bills,
              sales: point.sales,
              items: point.items,
              average_bill: point.average_bill,
              voids: point.voids,
              checkout_seconds: point.checkout_seconds ?? '',
              comparison_sales: point.comparison_sales ?? '',
            })),
          ),
      },
      {
        key: 'categories',
        label: 'Top categories (CSV)',
        disabled: !data.categories.available,
        run: () =>
          downloadCsv(
            `retail-categories-${stamp}.csv`,
            data.categories.available
              ? data.categories.rows.map<CsvRow>((row) => ({
                  category: row.label,
                  sales_value: row.amount,
                  quantity: row.qty,
                  bills: row.bills,
                  share_pc: row.share_pc ?? '',
                }))
              : [],
          ),
      },
      {
        key: 'alerts',
        label: 'Operational alerts (CSV)',
        disabled: data.alerts.items.length === 0,
        run: () =>
          downloadCsv(
            `retail-alerts-${stamp}.csv`,
            data.alerts.items.map<CsvRow>((alert) => ({
              severity: alert.severity,
              alert: alert.title,
              context: alert.context,
              at: alert.at ?? '',
            })),
          ),
      },
    ]
  }, [data, mayExport, filters.from, filters.to])

  return (
    <PosDashboardShell
      title="Retail Operations"
      description="Keep every counter moving. Smarter operations. Happier customers."
      activeDashboard="retail"
      visibleTabs={tabs}
      heroArt
      heroQuote={
        <>
          “Every sale
          <br />
          moves your business forward.”
        </>
      }
      pulse={<PulseStrip block={data?.pulse ?? null} loading={board.loading} />}
      filterControls={
        <DashboardFilterBar filters={filters} update={update} comparisonAs="toggle" />
      }
      secondaryActions={mayExport ? <ExportMenu options={exportOptions} disabled={!data} /> : undefined}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={{
        label: 'Start a sale',
        // The till owns the sale, the shift and the permission. This is the
        // way in, not a second one: /  asks for a counter, opens the shift if
        // one is needed and refuses what the cashier may not do.
        to: '/',
        disabled: !maySell,
        title: maySell ? 'Open the till' : 'You do not have permission to sell. Ask a manager.',
      }}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metricsLoading={board.loading}
      metrics={data ? kpis(data) : []}
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        onRetry={board.refresh}
        skeleton={
          <>
            <div className="pos-grid-ops">
              <PanelSkeleton title="Live counter status" rows={6} />
              <PanelSkeleton title="Hourly sales trend" rows={5} height={22} />
              <PanelSkeleton title="Queue & checkout health" rows={4} />
            </div>
            <div className="pos-grid-ops pos-grid-ops--secondary">
              <PanelSkeleton title="Top selling categories" rows={5} />
              <PanelSkeleton title="Operational alerts" rows={5} />
              <PanelSkeleton title="Shift readiness" rows={5} />
            </div>
          </>
        }
      >
        {data && (
          <>
            {/* The operations row: who is working, what they sold, how fast. */}
            <div className="pos-grid-ops">
              <LiveCounterStatus board={data} filters={filters} onTerminal={focusCounter} me={me} />
              <HourlySalesTrend board={data} />
              <CheckoutHealth board={data} filters={filters} />
            </div>

            {/* The attention row: what sold, what broke, what is not ready. */}
            <div className="pos-grid-ops pos-grid-ops--secondary">
              <TopSellingCategories board={data} periodLabel={periodLabel} />
              <OperationalAlerts board={data} filters={filters} />
              <ShiftReadiness board={data} />
            </div>

            {/* Everything the counter board carried before, and still does:
                these are the screens a supervisor drills into, and none of
                them stopped being useful when the layout changed. */}
            <div className="pos-grid-main">
              <HeldBills board={data} />
              <RetailAttention board={data} filters={filters} />
            </div>

            <div className="pos-grid-main">
              <RecentTransactions board={data} />
              <StockAttention board={data} />
            </div>

            <DeviceHealth board={data} />

            <p className="pos-note">
              {data.window.scope_note}
              {data.kpis.checkout.available && ` ${data.kpis.checkout.basis}`}
            </p>
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
