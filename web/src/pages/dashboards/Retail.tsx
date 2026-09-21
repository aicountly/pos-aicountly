/**
 * Retail Operations — the counter command centre.
 *
 * WHAT A MANAGER HAS TO SEE IN FIVE SECONDS, in this order down the page:
 * how many counters are working, what has been rung up, what is stuck, how
 * fast checkout is, and what needs a person. Everything below the KPI row
 * answers one of those in more detail, and all of it comes from
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
 *   It will not badge a threshold as a model's work. The strip is the same
 *   Aicountly AI Insights surface Business Overview carries, with the same
 *   BETA badge and the same Rule-based alert on every item inside it.
 *
 *   It will not colour a rise green because it is a rise. Every comparison
 *   carries a tone as well as a direction, because a checkout that got slower
 *   and a void count that fell are both changes and only one is good news.
 */

import { useCallback, useMemo } from 'react'
import { AlertTriangle, Clock3, PauseCircle, ReceiptText, Store } from 'lucide-react'
import { SparkBars, Sparkline } from '../../dashboards/charts'
import { downloadRetailCsv } from '../../dashboards/exportSummary'
import { clockDuration, compactMoney, count, percent } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards, withFilters } from '../../dashboards/registry'
import {
  CardSkeleton,
  DashboardBody,
  PanelBoundary,
  PosDashboardShell,
  type MetricProps,
} from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  CheckoutHealth,
  DeviceHealth,
  HeldBills,
  HourlySalesTrend,
  LiveCounterStatus,
  OperationalAlerts,
  RecentTransactions,
  RetailAttention,
  RetailInsights,
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
 * Forty-five seconds is the compromise between a board worth leaving open and
 * one that costs the server an aggregate query per manager per second.
 * `useBoard` stops the timer entirely while the tab is hidden.
 */
const REFRESH_MS = 45_000

/** The quiet graphic in the header. Decoration; it carries no figure. */
function HeroMark() {
  return (
    <div className="pos-heromark" aria-hidden>
      <p>
        Keep every counter moving,
        <br />
        and every customer served
      </p>
      <svg viewBox="0 0 96 46" width="96" height="46">
        <rect x="8" y="14" width="42" height="30" rx="4" fill="#cfeadb" />
        <rect x="14" y="20" width="30" height="13" rx="2" fill="#8ecfa8" />
        <rect x="14" y="37" width="12" height="3" rx="1.5" fill="#4eb374" />
        <rect x="30" y="37" width="7" height="3" rx="1.5" fill="#4eb374" />
        <path d="M58 8h28v36l-4.7-3.4L76.6 44l-4.7-3.4L67.2 44l-4.7-3.4L58 44z" fill="#b3dfc5" />
        <path d="M64 17h16M64 24h16M64 31h9" stroke="#0f8a3c" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  )
}

/** The shape of the board, while the board is on its way. */
function RetailSkeleton() {
  return (
    <>
      <div className="pos-skeleton-block" aria-hidden>
        <CardSkeleton lines={2} height={78} />
      </div>
      <div className="pos-grid-retail">
        {[0, 1, 2].map((i) => (
          <div key={i} className="pos-panel pos-panel--placeholder">
            <CardSkeleton lines={6} height={300} />
          </div>
        ))}
      </div>
      <div className="pos-grid-retail pos-grid-retail--secondary">
        {[0, 1, 2].map((i) => (
          <div key={i} className="pos-panel pos-panel--placeholder">
            <CardSkeleton lines={5} height={240} />
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * A KPI comparison, coloured by whether the change is GOOD rather than by
 * which way it went.
 *
 * Null when there is nothing honest to say: no comparison window, or a
 * previous value of zero, where the percentage is infinite and the badge would
 * be decoration with a number in it.
 */
function kpiComparison(
  current: number,
  previous: number | null | undefined,
  betterWhen: 'higher' | 'lower',
  label: string | null,
): MetricProps['comparison'] {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null

  const change = ((current - previous) / previous) * 100
  const suffix = label ? ` ${label}` : ''

  if (Math.abs(change) < 0.5) {
    return { label: `about the same${suffix}`, direction: 'flat', tone: 'neutral' }
  }

  const rose = change > 0
  const good = betterWhen === 'higher' ? rose : !rose

  return {
    label: `${rose ? 'up' : 'down'} ${percent(Math.abs(change), 0)}${suffix}`,
    direction: rose ? 'up' : 'down',
    tone: good ? 'good' : 'bad',
  }
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

  const periodLabel = filters.from === filters.to ? 'Today' : 'This period'
  const focusCounter = useCallback((terminalId: number) => update({ terminalId }), [update])
  const onExport = useCallback(() => {
    if (data) downloadRetailCsv(data, filters)
  }, [data, filters])

  // The three shapes under the headline figures, derived once per board rather
  // than per card render. Each is also stated in words on its own card.
  const sparks = useMemo(() => {
    const points = data?.trend.points ?? []

    return {
      bills: points.map((point) => point.bills),
      checkout: points
        .map((point) => point.checkout_seconds)
        .filter((seconds): seconds is number => seconds !== null),
      voids: points.map((point) => point.voids),
    }
  }, [data])

  const metrics: MetricProps[] = useMemo(() => {
    if (!data) return []

    const { kpis, comparison } = data
    const label = comparison?.label ?? null
    const checkout = kpis.checkout
    const previousCheckout = comparison?.checkout.available === true ? comparison.checkout.median_seconds : null

    return [
      {
        id: 'counters',
        label: 'Active counters',
        value: `${count(kpis.active_counters)} / ${count(kpis.total_counters)}`,
        context: 'Tills with a shift open',
        hint: 'A till counts as active when a shift is open on it, whatever the date filter says.',
        icon: <Store size={15} />,
        tone: 'brand',
        accent: 'green',
        // A ratio, not a series. There is no history of "how many tills were
        // open an hour ago", so nothing here pretends to draw one.
        progress: {
          value: kpis.active_counters,
          max: kpis.total_counters,
          label: `${count(kpis.active_counters)} of ${count(kpis.total_counters)} tills have a shift open`,
        },
      },
      {
        id: 'bills',
        label: 'Completed bills',
        value: count(kpis.bills),
        context: `${compactMoney(kpis.net)} taken`,
        hint: 'Carts that reached COMPLETED inside this window. Voids are excluded.',
        icon: <ReceiptText size={15} />,
        tone: 'info',
        accent: 'blue',
        comparison: kpiComparison(kpis.bills, comparison?.bills, 'higher', label),
        spark: (
          <SparkBars
            values={sparks.bills}
            tone="info"
            format={(value) => count(value)}
            label="Bills across this window"
          />
        ),
        href: withFilters('/controls', filters),
      },
      {
        id: 'held',
        label: 'Bills on hold',
        value: count(kpis.held_bills),
        // No comparison: held bills are a right-now figure that ignores the
        // date filter, so there is no previous value to compare against.
        context: `${compactMoney(kpis.held_value)} sitting on counters`,
        hint: 'Shown whatever the dates say — a bill held yesterday is still on the counter today.',
        icon: <PauseCircle size={15} />,
        tone: 'warning',
        accent: 'orange',
      },
      {
        id: 'checkout',
        label: 'Median checkout',
        value: checkout.available ? clockDuration(checkout.median_seconds) : null,
        context: checkout.available
          ? `Across ${count(checkout.sampled)} bills, cart opened to completed`
          : 'Not enough completed bills to measure',
        hint: checkout.available ? checkout.basis : checkout.note,
        icon: <Clock3 size={15} />,
        tone: 'brand',
        accent: 'purple',
        // Slower is worse, so a rise is red here and green on the card above.
        comparison: checkout.available
          ? kpiComparison(checkout.median_seconds, previousCheckout, 'lower', label)
          : null,
        spark: (
          <Sparkline
            values={sparks.checkout}
            tone="brand"
            format={(value) => clockDuration(value)}
            label="Median checkout across this window"
          />
        ),
      },
      {
        id: 'exceptions',
        label: 'Needs attention',
        value: count(kpis.exceptions),
        context: 'Voids, overrides and stuck sales',
        hint: 'Voids and approvals in this window, plus sales stuck with Books or Inventory on any date.',
        icon: <AlertTriangle size={15} />,
        tone: 'danger',
        accent: 'cyan',
        // Windowed against windowed: the headline also counts sales stuck on
        // every date, which no previous window can be compared with.
        comparison: kpiComparison(
          kpis.exceptions_windowed,
          comparison?.exceptions_windowed,
          'lower',
          label,
        ),
        spark: (
          <SparkBars
            values={sparks.voids}
            tone="danger"
            format={(value) => count(value)}
            label="Voids across this window"
          />
        ),
        href: withFilters('/controls', filters, { panel: 'approvals' }),
      },
    ]
  }, [data, filters, sparks])

  return (
    <PosDashboardShell
      title="Retail Operations"
      description="Keep every counter moving. Smarter operations. Happier customers."
      headerIcon={<Store size={20} />}
      activeDashboard="retail"
      visibleTabs={tabs}
      heroAside={<HeroMark />}
      filterControls={<DashboardFilterBar filters={filters} update={update} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      secondaryActions={
        mayExport ? (
          <button
            type="button"
            className="pos-button pos-button--secondary"
            onClick={onExport}
            disabled={!data}
          >
            Export CSV
          </button>
        ) : null
      }
      primaryAction={{
        label: 'Start a sale',
        // The till owns the sale, the shift and the permission. This is the
        // way in, not a second one: /till asks for a counter, opens the shift
        // if one is needed, and refuses what the cashier may not do.
        to: maySell ? '/till' : undefined,
        disabled: !maySell,
      }}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metricsLoading={board.loading}
      metrics={metrics}
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        onRetry={board.refresh}
        skeleton={<RetailSkeleton />}
      >
        {data && (
          <>
            <PanelBoundary title="Aicountly insights">
              <RetailInsights board={data} />
            </PanelBoundary>

            {/* Who is working, what they sold, how fast it went. */}
            <div className="pos-grid-retail">
              <PanelBoundary title="Live counter status">
                <LiveCounterStatus board={data} filters={filters} onTerminal={focusCounter} me={me} />
              </PanelBoundary>
              <PanelBoundary title="Sales trend">
                <HourlySalesTrend board={data} />
              </PanelBoundary>
              <PanelBoundary title="Queue and checkout health">
                <CheckoutHealth board={data} filters={filters} />
              </PanelBoundary>
            </div>

            {/* What sold, what broke, what is not ready. */}
            <div className="pos-grid-retail pos-grid-retail--secondary">
              <PanelBoundary title="Top selling categories">
                <TopSellingCategories board={data} periodLabel={periodLabel} />
              </PanelBoundary>
              <PanelBoundary title="Operational alerts">
                <OperationalAlerts board={data} filters={filters} />
              </PanelBoundary>
              <PanelBoundary title="Shift readiness">
                <ShiftReadiness board={data} />
              </PanelBoundary>
            </div>

            {/* Everything the counter board carried before, and still does:
                the screens a supervisor drills into, none of which stopped
                being useful when the layout changed. */}
            <div className="pos-grid-main">
              <PanelBoundary title="Bills on hold">
                <HeldBills board={data} />
              </PanelBoundary>
              <PanelBoundary title="Needs a person">
                <RetailAttention board={data} filters={filters} />
              </PanelBoundary>
            </div>

            <div className="pos-grid-main">
              <PanelBoundary title="Recent bills">
                <RecentTransactions board={data} />
              </PanelBoundary>
              <PanelBoundary title="Stock needing attention">
                <StockAttention board={data} />
              </PanelBoundary>
            </div>

            <PanelBoundary title="Devices">
              <DeviceHealth board={data} />
            </PanelBoundary>

            <p className="pos-note">{data.window.scope_note}</p>
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
