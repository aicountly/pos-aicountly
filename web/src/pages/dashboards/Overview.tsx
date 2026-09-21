/**
 * Business Overview — the first screen an owner opens.
 *
 * It answers, in this order and without scrolling on a laptop: what did we
 * take, how many bills, what was the average, what came back, how many
 * counters are open — then whether anything is wrong, then when and where the
 * money came from, then what sold and what needs doing.
 *
 * ONE REQUEST BACKS THE WHOLE SCREEN. Every panel reads the same board object,
 * so no two panels can disagree, there is no waterfall of spinners, and a
 * refresh is one round trip rather than nine. The filters live in the URL
 * (see useDashboard), so the state survives a reload and a link carries what
 * the sender was looking at.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Banknote, LayoutGrid, Receipt, TrendingUp, Undo2 } from 'lucide-react'
import { usePos } from '../../context/PosContext'
import { Sparkline, SparkBars } from '../../dashboards/charts'
import { compactMoney, count, moneyExact, percent } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards, withFilters } from '../../dashboards/registry'
import { CardSkeleton, DashboardBody, PanelBoundary, PosDashboardShell } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  ActivityHeatmapCard,
  AIInsightsPanel,
  ExceptionsDrawer,
  OutletPerformanceCard,
  PaymentMethodMixCard,
  QuickActionsCard,
  ReturnsVoidsCard,
  SalesTrendCard,
  TopItemsCard,
  exceptionCount,
  kpiComparison,
  worstSeverity,
} from '../../dashboards/panels/overview'
import { downloadOverviewCsv } from '../../dashboards/exportSummary'
import type { OverviewBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

/**
 * The quiet graphic in the top right.
 *
 * Decoration, and treated as such: it is `aria-hidden`, it carries no figure,
 * and it is the first thing the layout drops when the header gets tight. A
 * decorative chart that a reader could mistake for this shop's numbers would be
 * worse than no chart, so the bars deliberately do not resemble a real series.
 */
function HeroMark() {
  return (
    <div className="pos-heromark" aria-hidden>
      <p>
        Turn everyday operations
        <br />
        into bigger opportunities
      </p>
      <svg viewBox="0 0 96 46" width="96" height="46">
        <rect x="2" y="30" width="14" height="14" rx="3" fill="#cfeadb" />
        <rect x="22" y="22" width="14" height="22" rx="3" fill="#b3dfc5" />
        <rect x="42" y="13" width="14" height="31" rx="3" fill="#8ecfa8" />
        <rect x="62" y="5" width="14" height="39" rx="3" fill="#4eb374" />
        <path d="M6 24 L29 17 L49 9 L69 2" fill="none" stroke="#0f8a3c" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="69" cy="2.5" r="3" fill="#0f8a3c" />
      </svg>
    </div>
  )
}

/** The shape of the board, while the board is on its way. */
function OverviewSkeleton() {
  return (
    <>
      <div className="pos-skeleton-block" aria-hidden>
        <CardSkeleton lines={2} height={78} />
      </div>
      <div className="pos-grid-analytics">
        <div className="pos-panel pos-panel--placeholder">
          <CardSkeleton lines={6} height={280} />
        </div>
        <div className="pos-panel pos-panel--placeholder">
          <CardSkeleton lines={5} height={280} />
        </div>
        <div className="pos-panel pos-panel--placeholder">
          <CardSkeleton lines={5} height={280} />
        </div>
      </div>
      <div className="pos-grid-secondary">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pos-panel pos-panel--placeholder">
            <CardSkeleton lines={5} height={220} />
          </div>
        ))}
      </div>
    </>
  )
}

export default function Overview() {
  const { can } = usePos()
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<OverviewBoard>('v1/dashboards/overview', query)
  const [exceptionsOpen, setExceptionsOpen] = useState(false)

  const data = board.data
  const previous = data?.comparison ?? null
  const comparisonLabel = previous?.label ?? null

  const { refresh } = board

  /**
   * R refreshes, the way it does on every other board people use.
   *
   * Only when nothing is being typed into and no modifier is held, or the key
   * would fire inside the date boxes and while somebody is using Ctrl-R to
   * reload the page.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'r') return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return

      event.preventDefault()
      refresh()
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [refresh])

  const onExport = useCallback(() => {
    if (data) downloadOverviewCsv(data, filters)
  }, [data, filters])

  const dayStart = data?.window.day_start_minutes ?? 0
  const dayStartLabel =
    dayStart > 0
      ? `, trading day starting ${String(Math.floor(dayStart / 60)).padStart(2, '0')}:${String(dayStart % 60).padStart(2, '0')}`
      : ''

  // The four shapes under the headline figures. Derived once per board, not per
  // card render — and every one of them is also stated in words on its card.
  const sparks = useMemo(() => {
    const points = data?.series.points ?? []

    return {
      net: points.map((point) => point.net),
      bills: points.map((point) => point.bills),
      average: points.map((point) => (point.bills > 0 ? point.net / point.bills : 0)),
      returns: points.map((point) => point.returns),
    }
  }, [data])

  const openCounters = data ? data.sales.open_shifts : 0
  const activeTills = data ? data.sales.active_tills : 0
  const counterShare = activeTills > 0 ? (openCounters / activeTills) * 100 : null

  return (
    <PosDashboardShell
      title="Business Overview"
      description="Complete view of your business performance across all outlets."
      activeDashboard="overview"
      visibleTabs={tabs}
      filterControls={<DashboardFilterBar filters={filters} update={update} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      heroAside={<HeroMark />}
      primaryAction={{ label: 'Open POS', to: '/' }}
      secondaryActions={
        can('reports.view') ? (
          <button
            type="button"
            className={[
              'pos-button pos-button--secondary',
              data && exceptionCount(data) > 0 ? 'pos-button--flagged' : '',
              // A pulse is an interruption, so it is spent only on a danger —
              // a sale Books refused or a drawer that is out. A badge that
              // pulses at everything is a badge nobody looks at.
              data && worstSeverity(data.insights.items) === 'danger' ? 'pos-button--urgent' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setExceptionsOpen(true)}
            disabled={!data}
          >
            Review exceptions
            {data && exceptionCount(data) > 0 && (
              <span className="pos-button__count num">{count(exceptionCount(data))}</span>
            )}
          </button>
        ) : null
      }
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metricsLoading={board.loading}
      metrics={
        data
          ? [
              {
                id: 'net',
                label: 'Net sales',
                value: moneyExact(data.sales.net),
                context: 'Tax-inclusive counter takings, discounts deducted',
                hint: 'Completed bills only. Voids are excluded and returns are shown separately, not deducted.',
                icon: <TrendingUp size={15} />,
                tone: 'brand',
                comparison: kpiComparison(data.sales.net, previous?.net, comparisonLabel),
                spark: (
                  <Sparkline
                    values={sparks.net}
                    tone="brand"
                    format={(value) => compactMoney(value)}
                    label="Net sales across this window"
                  />
                ),
                href: withFilters('/retail', filters),
              },
              {
                id: 'bills',
                label: 'Completed bills',
                value: count(data.sales.bills),
                context: 'Voided bills excluded',
                hint: 'Carts that reached COMPLETED inside this window.',
                icon: <Receipt size={15} />,
                tone: 'brand',
                comparison: kpiComparison(data.sales.bills, previous?.bills, comparisonLabel),
                spark: (
                  <SparkBars
                    values={sparks.bills}
                    tone="brand"
                    format={(value) => count(value)}
                    label="Bills across this window"
                  />
                ),
                href: withFilters('/retail', filters),
              },
              {
                id: 'average',
                label: 'Average bill',
                value: moneyExact(data.sales.average_bill),
                context: 'Net sales ÷ completed bills',
                hint: 'Averaged over completed bills. With no bills it is not zero — it is nothing to average.',
                icon: <Banknote size={15} />,
                tone: 'info',
                comparison: kpiComparison(data.sales.average_bill, previous?.average_bill, comparisonLabel),
                spark: (
                  <Sparkline
                    values={sparks.average}
                    tone="info"
                    format={(value) => compactMoney(value)}
                    label="Average bill across this window"
                  />
                ),
              },
              {
                id: 'returns',
                label: 'Returns',
                value: moneyExact(data.sales.returns_value),
                context: `${count(data.sales.returns_count)} raised in this period, whatever date the sale was`,
                hint: 'Refund value of returns raised in this window. Not deducted from net sales.',
                icon: <Undo2 size={15} />,
                tone: 'danger',
                // Returns rising is adverse, so the colour follows the meaning
                // while the arrow and the words follow the movement.
                comparison: kpiComparison(data.sales.returns_value, previous?.returns_value, comparisonLabel, true),
                spark: (
                  <Sparkline
                    values={sparks.returns}
                    tone="danger"
                    format={(value) => compactMoney(value)}
                    label="Returns across this window"
                  />
                ),
                href: '/returns',
              },
              {
                id: 'counters',
                label: 'Counters open',
                value: `${count(data.sales.open_shifts)} / ${count(data.sales.active_tills)}`,
                context:
                  counterShare === null
                    ? 'No till is active in this scope'
                    : `${percent(counterShare, 0)} of active tills have a shift open`,
                hint: 'Tills with a shift open right now, out of the tills marked active. A live figure, not a figure for the window.',
                icon: <LayoutGrid size={15} />,
                tone: counterShare !== null && counterShare < 50 ? 'warning' : 'brand',
                progress: {
                  value: openCounters,
                  max: Math.max(activeTills, 1),
                  label:
                    counterShare === null
                      ? 'No active till'
                      : `${count(openCounters)} of ${count(activeTills)} tills open`,
                },
                href: withFilters('/retail', filters),
              },
            ]
          : []
      }
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        empty={data !== null && data.sales.bills === 0 && data.outlets.length === 0}
        emptyTitle="No activity in this period"
        emptyBody="Choose another period, change the outlet, or open the POS to start selling."
        emptyActions={
          <>
            <Link className="pos-button pos-button--primary" to="/">
              Open POS
            </Link>
            <button
              type="button"
              className="pos-button pos-button--secondary"
              onClick={() => {
                const today = new Date()
                const iso = [
                  today.getFullYear(),
                  String(today.getMonth() + 1).padStart(2, '0'),
                  String(today.getDate()).padStart(2, '0'),
                ].join('-')
                update({ from: iso, to: iso })
              }}
            >
              Today
            </button>
            <button
              type="button"
              className="pos-button pos-button--secondary"
              onClick={() => {
                const today = new Date()
                const iso = (date: Date) =>
                  [
                    date.getFullYear(),
                    String(date.getMonth() + 1).padStart(2, '0'),
                    String(date.getDate()).padStart(2, '0'),
                  ].join('-')
                const from = new Date(today)
                from.setDate(from.getDate() - 6)
                update({ from: iso(from), to: iso(today) })
              }}
            >
              Last 7 days
            </button>
          </>
        }
        skeleton={<OverviewSkeleton />}
        onRetry={board.refresh}
      >
        {data && (
          <>
            <AIInsightsPanel board={data} />

            {/*
              Each panel is boundaried on its own. One of them throwing leaves
              the other seven on screen, which on a board a shop runs its
              morning from is the difference between "the heatmap is broken"
              and "the dashboard is down".
            */}
            <div className="pos-grid-analytics">
              <PanelBoundary title="Sales trend">
                <SalesTrendCard board={data} filters={filters} />
              </PanelBoundary>
              <PanelBoundary title="Outlet performance">
                <OutletPerformanceCard
                  board={data}
                  filters={filters}
                  onOutlet={(locationId) => update({ locationId: locationId === 0 ? null : locationId })}
                />
              </PanelBoundary>
              <PanelBoundary title="Payment method mix">
                <PaymentMethodMixCard board={data} filters={filters} />
              </PanelBoundary>
            </div>

            <div className="pos-grid-secondary">
              <PanelBoundary title="Top items by sales">
                <TopItemsCard board={data} filters={filters} />
              </PanelBoundary>
              <PanelBoundary title="Hourly activity heatmap">
                <ActivityHeatmapCard board={data} />
              </PanelBoundary>
              <PanelBoundary title="Returns & voids">
                <ReturnsVoidsCard board={data} />
              </PanelBoundary>
              <QuickActionsCard
                onReviewExceptions={() => setExceptionsOpen(true)}
                onRefresh={board.refresh}
                onExport={onExport}
                refreshing={board.refreshing}
                exceptions={exceptionCount(data)}
                canOpenShift={can('shift.open') || can('sell')}
                canSeeReports={can('reports.view')}
              />
            </div>

            <p className="pos-note">
              Showing {data.window.from} to {data.window.to} in {data.window.timezone}
              {dayStartLabel}. {data.window.scope_note}
            </p>

            <ExceptionsDrawer
              board={data}
              filters={filters}
              open={exceptionsOpen}
              onClose={() => setExceptionsOpen(false)}
            />
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
