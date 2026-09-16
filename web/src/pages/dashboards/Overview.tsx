/**
 * Business Overview — the first screen an owner opens.
 */

import { Link } from 'react-router-dom'
import { usePos } from '../../context/PosContext'
import { compare, count, money } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards, withFilters } from '../../dashboards/registry'
import { DashboardBody, InsightCard, Panel, PosDashboardShell } from '../../dashboards/shell'
import { Freshness, InsightList } from '../../dashboards/panels/common'
import {
  OperationalAttention,
  OutletPerformance,
  SalesPerformance,
  TenderMixPanel,
  TopItems,
} from '../../dashboards/panels/overview'
import type { OverviewBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

export default function Overview() {
  const { can } = usePos()
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<OverviewBoard>('v1/dashboards/overview', query)

  const data = board.data
  const previous = data?.comparison ?? null

  const dayStart = data?.window.day_start_minutes ?? 0
  const dayStartLabel =
    dayStart > 0
      ? `, trading day starting ${String(Math.floor(dayStart / 60)).padStart(2, '0')}:${String(dayStart % 60).padStart(2, '0')}`
      : ''

  return (
    <PosDashboardShell
      title="Business Overview"
      description="What the shop took, where, and what is waiting for someone."
      activeDashboard="overview"
      visibleTabs={tabs}
      filterControls={<DashboardFilterBar filters={filters} update={update} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={{ label: 'Open POS', to: '/' }}
      secondaryActions={
        can('reports.view') ? (
          <Link className="pos-button pos-button--secondary" to={withFilters('/controls', filters)}>
            Review exceptions
          </Link>
        ) : null
      }
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metrics={
        data
          ? [
              {
                id: 'net',
                label: 'Net sales',
                value: money(data.sales.net),
                context: 'Tax-inclusive counter takings, discounts deducted',
                comparison: compare(data.sales.net, previous?.net, previous?.label),
                href: withFilters('/retail', filters),
              },
              {
                id: 'bills',
                label: 'Completed bills',
                value: count(data.sales.bills),
                context: 'Voided bills excluded',
                comparison: compare(data.sales.bills, previous?.bills, previous?.label),
                href: withFilters('/retail', filters),
              },
              {
                id: 'average',
                label: 'Average bill',
                value: money(data.sales.average_bill),
                context: 'Net sales ÷ completed bills',
                comparison: compare(data.sales.average_bill, previous?.average_bill, previous?.label),
              },
              {
                id: 'returns',
                label: 'Returns',
                value: money(data.sales.returns_value),
                context: `${count(data.sales.returns_count)} raised in this period, whatever date the sale was`,
                href: '/returns',
              },
              {
                id: 'counters',
                label: 'Counters open',
                value: `${count(data.sales.open_shifts)} / ${count(data.sales.active_tills)}`,
                context: 'Shifts open now, out of active tills',
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
        onRetry={board.refresh}
      >
        {data && (
          <>
            <div className="pos-grid-main">
              <SalesPerformance board={data} filters={filters} />
              <Panel title="Daily brief" description="Deterministic alerts from this POS' own rows.">
                <InsightList
                  block={data.insights}
                  emptyTitle="Nothing crossed a threshold"
                  emptyBody="No sale is stuck, no drawer is out and no ticket is late in this period."
                  renderItem={(item) => <InsightCard key={item.id} insight={item} />}
                />
              </Panel>
            </div>

            <div className="pos-grid-main">
              <OutletPerformance board={data} filters={filters} onOutlet={(locationId) => update({ locationId })} />
              <TenderMixPanel board={data} filters={filters} />
            </div>

            <div className="pos-grid-main">
              <TopItems board={data} filters={filters} />
              <OperationalAttention board={data} filters={filters} />
            </div>

            <p className="pos-note">
              Showing {data.window.from} to {data.window.to} in {data.window.timezone}
              {dayStartLabel}. {data.window.scope_note}
            </p>
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
