/**
 * Restaurant Operations — tables, tickets and billing in one view.
 */

import { count, money } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards } from '../../dashboards/registry'
import { DashboardBody, PosDashboardShell } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  DelayAttention,
  FloorPlan,
  KitchenBoard,
  MenuAvailability,
  OrderChannels,
  UnsettledBills,
} from '../../dashboards/panels/restaurant'
import type { RestaurantBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

export default function Restaurant() {
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<RestaurantBoard>('v1/dashboards/restaurant', query)

  const data = board.data

  return (
    <PosDashboardShell
      title="Restaurant Operations"
      description="From table to kitchen, in one view."
      activeDashboard="restaurant"
      visibleTabs={tabs}
      filterControls={
        <DashboardFilterBar filters={filters} update={update} showTerminal={false} showComparison={false} />
      }
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={{ label: 'Open tables', to: '/floor' }}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metrics={
        data
          ? [
              {
                id: 'tables',
                label: 'Tables seated',
                value: `${count(data.kpis.tables_occupied)} / ${count(data.kpis.tables_total)}`,
                context: `${count(data.kpis.covers)} covers`,
                href: '/floor',
              },
              {
                id: 'orders',
                label: 'Open orders',
                value: count(data.kpis.open_orders),
                context: 'Started and not yet settled',
                href: '/floor',
              },
              {
                id: 'pending',
                label: 'Tickets in the kitchen',
                value: count(data.kpis.tickets_pending),
                context: 'Queued and preparing',
                href: '/kitchen',
              },
              {
                id: 'overdue',
                label: 'Running late',
                value: count(data.kpis.tickets_overdue),
                context: "Past the station's own late-after time",
                href: '/kitchen',
              },
              {
                id: 'ready',
                label: 'Ready to serve',
                value: count(data.kpis.orders_ready),
                context: 'Cooked and waiting to go out',
                href: '/kitchen',
              },
              {
                id: 'unsettled',
                label: 'Unsettled bills',
                value: count(data.kpis.unsettled_bills),
                context: `${money(data.kpis.unsettled_value)} on the floor`,
                href: '/floor',
              },
            ]
          : []
      }
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        empty={data !== null && data.kpis.tables_total === 0 && data.menu.total === 0}
        emptyTitle="No restaurant set up here"
        onRetry={board.refresh}
      >
        {data && (
          <>
            <div className="pos-grid-main">
              <FloorPlan board={data} />
              <DelayAttention board={data} />
            </div>

            <KitchenBoard board={data} />

            <div className="pos-grid-main">
              <OrderChannels board={data} />
              <MenuAvailability board={data} />
            </div>

            <UnsettledBills board={data} />
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
