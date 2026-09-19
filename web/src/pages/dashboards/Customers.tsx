/**
 * Customers & Growth — repeat trade, measured only where it can be.
 *
 * WHAT THIS SCREEN IS FOR. Nine questions, in the order a shopkeeper asks them:
 * how many customers do we know, how many are new, how many came back, what did
 * they spend, which outlet keeps them, who has gone quiet, who are they, what
 * should we do next, and — underneath all of it — how much of the trade can this
 * board even see.
 *
 * THAT LAST ONE IS LOAD-BEARING. Most counter sales are anonymous. Every figure
 * here counts only bills a cashier attached a customer to, and the identified
 * share is on the banner at the top rather than in a footnote, because a 67%
 * repeat rate over 4% of bills and the same rate over 90% of bills are
 * different facts about a shop.
 *
 * COMPOSITION. The page holds the UI state and nothing else: which tab, which
 * search, which page, which panel is open. Filters live in the URL (shared
 * links, working back button), figures come from the board endpoint, and the
 * roster is its own paged endpoint so the browser never holds more than one
 * page of customers. No business rule is decided in this file — how many visits
 * make a regular and how many quiet days make a lapsed customer are the
 * server's, and arrive on `board.rules`.
 */

import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TrendingUp } from 'lucide-react'
import { count, percent } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards, withFilters } from '../../dashboards/registry'
import { PosDashboardShell } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import { Combinations, LoyaltyAndOffers, VisitRecency } from '../../dashboards/panels/customers'
import type { CustomersBoard, CustomerSummary, CustomerTab } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'
import { usePos } from '../../context/PosContext'
import { CustomerKpiGrid } from '../../dashboards/customers/CustomerKpiGrid'
import { CustomerTrendPanel } from '../../dashboards/customers/CustomerTrendPanel'
import { CustomerSegmentsPanel } from '../../dashboards/customers/CustomerSegmentsPanel'
import { TopOutletsPanel } from '../../dashboards/customers/TopOutletsPanel'
import { GrowthInsightsPanel } from '../../dashboards/customers/GrowthInsightsPanel'
import { CustomerQuickActions } from '../../dashboards/customers/CustomerQuickActions'
import { RecentCustomersPanel } from '../../dashboards/customers/RecentCustomersPanel'
import { CustomerDetailDrawer, InsightDetailDrawer } from '../../dashboards/customers/CustomerDetailDrawer'
import { CustomerEmptyState, KpiSkeleton, PanelSkeleton } from '../../dashboards/customers/parts'
import { useCustomerDirectory } from '../../dashboards/customers/useCustomerDirectory'
import type { OutletMetric, SegmentMode } from '../../dashboards/customers/constants'
import '../../dashboards/customers/customers.css'

type Suggestion = CustomersBoard['suggestions']['items'][number]
type OpenPanel = { kind: 'customer'; customer: CustomerSummary } | { kind: 'insight'; item: Suggestion } | null

/** Today, and the day N days before it, in the browser's calendar. */
function rangeEndingToday(days: number): { from: string; to: string } {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - (days - 1))

  const iso = (d: Date) =>
    [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')

  return { from: iso(start), to: iso(end) }
}

export default function Customers() {
  const { filters, update, query } = useDashboardFilters()
  const { can } = usePos()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<CustomersBoard>('v1/dashboards/customers', query)

  // Presentation state. Nothing here is a business rule.
  const [tab, setTab] = useState<CustomerTab>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('last_visit')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [segmentMode, setSegmentMode] = useState<SegmentMode>('revenue')
  const [outletMetric, setOutletMetric] = useState<OutletMetric>('customers')
  const [panel, setPanel] = useState<OpenPanel>(null)

  const directory = useCustomerDirectory(query, { tab, search, sort, order, page }, board.data !== null)

  const data = board.data
  const inactiveDays = data?.rules.inactive_days ?? directory.meta?.rules.inactive_days ?? 60
  const retailHref = withFilters('/retail', filters, { panel: 'recent' })

  const spanDays = useMemo(() => {
    const from = new Date(`${filters.from}T00:00:00`).getTime()
    const to = new Date(`${filters.to}T00:00:00`).getTime()
    if (Number.isNaN(from) || Number.isNaN(to)) return 1

    return Math.max(1, Math.round((to - from) / 86400000) + 1)
  }, [filters.from, filters.to])

  const refresh = useCallback(() => {
    board.refresh()
    directory.refresh()
  }, [board, directory])

  /** A KPI card, or a suggestion, sending the roster somewhere. */
  const drill = useCallback((next: CustomerTab, nextSort?: string) => {
    setTab(next)
    setPage(1)
    if (nextSort) {
      setSort(nextSort)
      setOrder('desc')
    }
  }, [])

  const reviewSegment = useCallback(
    (item: Suggestion) => {
      // The two segments a suggestion can be about map onto roster tabs; the
      // identification warning is about bills, not about a group of customers,
      // so it has nothing to open.
      if (item.segment === 'at_risk') return () => { drill('inactive'); setPanel(null) }
      if (item.segment === 'one_time') return () => { drill('all', 'visits'); setOrder('asc'); setPanel(null) }

      return null
    },
    [drill],
  )

  const shell = (children: React.ReactNode) => (
    <PosDashboardShell
      title="Customers & Growth"
      description="Turn everyday visits into repeat trade — measured, not guessed."
      activeDashboard="customers"
      visibleTabs={tabs}
      filterControls={<DashboardFilterBar filters={filters} update={update} showTerminal={false} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={{ label: 'Open POS', to: '/' }}
      onRefresh={refresh}
      refreshing={board.refreshing}
      metrics={[]}
    >
      {children}
    </PosDashboardShell>
  )

  if (board.loading) {
    return shell(
      <div className="cg-page" aria-busy="true">
        <KpiSkeleton />
        <div className="cg-analytics">
          <div className="pos-panel cg-analytics__trend"><PanelSkeleton chart lines={2} /></div>
          <div className="pos-panel cg-analytics__rail"><PanelSkeleton lines={5} /></div>
          <div className="pos-panel cg-analytics__segments"><PanelSkeleton lines={4} /></div>
          <div className="pos-panel cg-analytics__outlets"><PanelSkeleton lines={4} /></div>
        </div>
        <div className="pos-panel"><PanelSkeleton lines={6} /></div>
      </div>,
    )
  }

  if (board.error) {
    return shell(
      <div className="pos-state" role="alert">
        <h2>Customer analytics could not be loaded</h2>
        <p>{board.error}</p>
        <button type="button" className="pos-button pos-button--primary" onClick={refresh}>
          Try again
        </button>
      </div>,
    )
  }

  if (!data) return shell(null)

  const nothingAtAll = data.coverage.bills === 0 && data.segments.total === 0

  if (nothingAtAll) {
    return shell(
      <CustomerEmptyState
        title="No customer activity in this period"
        actions={
          <>
            <button
              type="button"
              className="pos-button pos-button--secondary"
              onClick={() => update(rangeEndingToday(30))}
            >
              Try the last 30 days
            </button>
            {filters.locationId !== null && (
              <button
                type="button"
                className="pos-button pos-button--secondary"
                onClick={() => update({ locationId: null })}
              >
                Show every outlet
              </button>
            )}
            <Link className="pos-button pos-button--primary" to="/">
              Open the till
            </Link>
          </>
        }
      >
        Nothing was sold in this window, at least not at the outlets selected. Widen the dates, choose every outlet, or
        take a sale — this board fills in as soon as a bill carries a customer.
      </CustomerEmptyState>,
    )
  }

  return shell(
    <div className="cg-page">
      {/* Identification health, stated up front rather than as a footnote: it
          is the denominator under every other figure on the screen. */}
      <section className="cg-banner">
        <span className="cg-banner__icon" aria-hidden>
          <TrendingUp size={20} strokeWidth={2} />
        </span>
        <div className="cg-banner__text">
          <strong>More customers you know by name, more repeat trade.</strong>
          <span>
            {data.coverage.bills === 0
              ? 'No bills in this period yet.'
              : `${count(data.coverage.identified_bills)} of ${count(data.coverage.bills)} bills carried a customer. The other ${count(data.coverage.anonymous_bills)} were anonymous counter sales and are excluded from everything below.`}
          </span>
        </div>
        <div className="cg-banner__figure">
          <strong>{percent(data.coverage.identified_pc, 0)}</strong>
          <small>Bills with a customer</small>
        </div>
      </section>

      <CustomerKpiGrid board={data} activeTab={tab} activeSort={sort} onDrill={drill} />

      <div className="cg-analytics">
        <div className="cg-analytics__trend">
          <CustomerTrendPanel
            board={data}
            spanDays={spanDays}
            onRange={(days) => update(rangeEndingToday(days))}
          />
        </div>

        <div className="cg-analytics__rail">
          <GrowthInsightsPanel board={data} onOpen={(item) => setPanel({ kind: 'insight', item })} />
        </div>

        <div className="cg-analytics__segments">
          <CustomerSegmentsPanel board={data} mode={segmentMode} onMode={setSegmentMode} />
        </div>

        <div className="cg-analytics__outlets">
          <TopOutletsPanel
            board={data}
            metric={outletMetric}
            onMetric={setOutletMetric}
            selectedOutlet={filters.locationId}
            onSelectOutlet={(locationId) => update({ locationId })}
          />
        </div>
      </div>

      <CustomerQuickActions can={can} retailHref={retailHref} />

      <RecentCustomersPanel
        rows={directory.rows}
        meta={directory.meta}
        loading={directory.loading}
        stale={directory.stale}
        error={directory.error}
        tab={tab}
        search={search}
        sort={sort}
        order={order}
        page={page}
        inactiveDays={inactiveDays}
        onTab={(next) => { setTab(next); setPage(1) }}
        onSearch={(value) => { setSearch(value); setPage(1) }}
        onSort={(value) => { setSort(value); setPage(1) }}
        onOrder={(value) => { setOrder(value); setPage(1) }}
        onPage={setPage}
        onOpen={(customer) => setPanel({ kind: 'customer', customer })}
        onRetry={directory.refresh}
      />

      <div className="pos-grid-equal">
        <VisitRecency board={data} />
        <Combinations board={data} />
      </div>

      <LoyaltyAndOffers board={data} />

      <p className="pos-note">{data.basis}</p>

      {panel?.kind === 'customer' && (
        <CustomerDetailDrawer
          customer={panel.customer}
          inactiveDays={inactiveDays}
          retailHref={retailHref}
          onClose={() => setPanel(null)}
        />
      )}

      {panel?.kind === 'insight' && (
        <InsightDetailDrawer
          item={panel.item}
          segments={data.segments}
          onClose={() => setPanel(null)}
          onReview={reviewSegment(panel.item)}
        />
      )}
    </div>,
  )
}
