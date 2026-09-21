/**
 * Retail Operations — run the counters, and get from an alert to a checkout.
 */

import { count, duration, money } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards } from '../../dashboards/registry'
import { DashboardBody, PosDashboardShell } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  CounterGrid,
  DeviceHealth,
  HeldBills,
  RecentTransactions,
  RetailAttention,
  StockAttention,
} from '../../dashboards/panels/retail'
import type { RetailBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

export default function Retail() {
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<RetailBoard>('v1/dashboards/retail', query)

  const data = board.data
  const checkout = data?.kpis.checkout

  return (
    <PosDashboardShell
      title="Retail Operations"
      description="Keep every counter moving."
      activeDashboard="retail"
      visibleTabs={tabs}
      filterControls={<DashboardFilterBar filters={filters} update={update} showComparison={false} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={{ label: 'Start a sale', to: '/till' }}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metrics={
        data
          ? [
              {
                id: 'counters',
                label: 'Active counters',
                value: `${count(data.kpis.active_counters)} / ${count(data.kpis.total_counters)}`,
                context: 'Tills with a shift open',
              },
              {
                id: 'bills',
                label: 'Completed bills',
                value: count(data.kpis.bills),
                context: money(data.kpis.net) + ' taken',
              },
              {
                id: 'held',
                label: 'Bills on hold',
                value: count(data.kpis.held_bills),
                context: `${money(data.kpis.held_value)} sitting on counters`,
              },
              {
                id: 'checkout',
                label: 'Median checkout',
                value: checkout?.available ? duration(checkout.median_seconds) : null,
                context: checkout?.available
                  ? `Across ${count(checkout.sampled)} bills, cart opened to completed`
                  : 'Not enough completed bills to measure',
              },
              {
                id: 'exceptions',
                label: 'Needs attention',
                value: count(data.kpis.exceptions),
                context: 'Voids, overrides and stuck sales',
              },
            ]
          : []
      }
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        empty={data !== null && data.counters.length === 0 && data.kpis.bills === 0}
        emptyTitle="No counters set up yet"
        onRetry={board.refresh}
      >
        {data && (
          <>
            <div className="pos-grid-main">
              <CounterGrid board={data} filters={filters} onTerminal={(terminalId) => update({ terminalId })} />
              <RetailAttention board={data} filters={filters} />
            </div>

            <div className="pos-grid-main">
              <HeldBills board={data} />
              <DeviceHealth board={data} />
            </div>

            <div className="pos-grid-main">
              <RecentTransactions board={data} />
              <StockAttention board={data} />
            </div>

            {checkout?.available && <p className="pos-note">{checkout.basis}</p>}
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
