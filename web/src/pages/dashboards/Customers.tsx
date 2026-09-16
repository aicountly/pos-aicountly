/**
 * Customers & Growth — repeat trade, measured only where it can be.
 */

import { count, money, percent } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards } from '../../dashboards/registry'
import { DashboardBody, PosDashboardShell } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  Combinations,
  CoverageNote,
  GrowthSuggestions,
  LoyaltyAndOffers,
  NewVsReturning,
  Segments,
  VisitRecency,
} from '../../dashboards/panels/customers'
import type { CustomersBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

export default function Customers() {
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<CustomersBoard>('v1/dashboards/customers', query)

  const data = board.data

  return (
    <PosDashboardShell
      title="Customers & Growth"
      description="Turn everyday visits into repeat trade — measured, not guessed."
      activeDashboard="customers"
      visibleTabs={tabs}
      filterControls={<DashboardFilterBar filters={filters} update={update} showTerminal={false} showComparison={false} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={{ label: 'Open POS', to: '/' }}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metrics={
        data
          ? [
              {
                id: 'identified',
                label: 'Identified customers',
                value: count(data.kpis.identified_customers),
                context: `From ${count(data.coverage.identified_bills)} of ${count(data.coverage.bills)} bills`,
              },
              {
                id: 'new',
                label: 'New to this POS',
                value: count(data.kpis.new_customers),
                context: 'Their first bill here fell in this period',
              },
              {
                id: 'repeat',
                label: 'Repeat rate',
                value: percent(data.kpis.repeat_rate_pc, 0),
                context: 'Identified customers who bought more than once in this period',
              },
              {
                id: 'basket',
                label: 'Identified average bill',
                value: money(data.kpis.identified_average_bill),
                context: 'Anonymous sales excluded',
              },
              {
                id: 'coverage',
                label: 'Bills with a customer',
                value: percent(data.coverage.identified_pc, 0),
                context: 'How much of the trade this board can see',
              },
            ]
          : []
      }
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        empty={data !== null && data.coverage.bills === 0 && data.segments.total === 0}
        emptyTitle="No sales in this period"
        onRetry={board.refresh}
      >
        {data && (
          <>
            <CoverageNote board={data} />

            <div className="pos-grid-main">
              <NewVsReturning board={data} />
              <GrowthSuggestions board={data} />
            </div>

            <div className="pos-grid-equal">
              <Segments board={data} />
              <VisitRecency board={data} />
            </div>

            <div className="pos-grid-main">
              <Combinations board={data} />
              <LoyaltyAndOffers board={data} />
            </div>

            <p className="pos-note">{data.basis}</p>
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
