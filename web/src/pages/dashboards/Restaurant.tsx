/**
 * Restaurant Operations — the manager's command centre.
 *
 * Read top to bottom it answers, in order: is the room busy, is the kitchen
 * coping, what is on the board, what needs walking over to, and what can I do
 * about it without hunting through a menu.
 *
 * TWO CLOCKS RUN ON THIS SCREEN AND THEY ARE LABELLED. Tables, tickets and open
 * orders are LIVE — they are what is true now, whatever the date filter says,
 * because an order on the floor is open until it is settled. Takings, serve
 * time and served tickets are WINDOWED by the filter, because those are history.
 * A board that mixed the two silently would let a manager filter to last Tuesday
 * and conclude the kitchen was empty.
 */

import { useMemo, useState } from 'react'
import { Clock, Coffee, IndianRupee, ReceiptText, Star, UtensilsCrossed } from 'lucide-react'
import { count, duration, money, percent } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards } from '../../dashboards/registry'
import { DashboardBody, Panel, PosDashboardShell, type MetricProps } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  DelayAttention,
  FloorPlan,
  KitchenBoard,
  MenuAvailability,
  OrderChannels,
  UnsettledBills,
} from '../../dashboards/panels/restaurant'
import {
  AicountlyInsightStrip,
  GuestFeedbackNote,
  OperationalAttention,
  OrderFlowPanel,
  RestaurantBoardSkeleton,
  RestaurantQuickActions,
  RestaurantServiceState,
  RestaurantSessionPanel,
  RestaurantSetupPanel,
  TableStatusPanel,
  TodaysOrdersPanel,
} from '../../dashboards/panels/restaurantOps'
import { getRestaurantOperationalInsight, restaurantMetrics } from '../../dashboards/restaurantInsight'
import type { RestaurantBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

/**
 * How often the board re-asks.
 *
 * Slow on purpose. A floor changes over minutes, not seconds, and this runs on
 * tills that are often a cheap tablet on shop broadband. Polling reuses the
 * board fetch rather than adding a socket — see useBoard.
 */
const LIVE_REFRESH_MS = 45_000

export default function Restaurant() {
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<RestaurantBoard>('v1/dashboards/restaurant', query, true, LIVE_REFRESH_MS)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const data = board.data

  const metrics = useMemo(() => (data ? restaurantMetrics(data) : null), [data])
  const signal = useMemo(() => (metrics ? getRestaurantOperationalInsight(metrics) : null), [metrics])

  // Placeholders belong to loading only. A skeleton row above an error message
  // reads as figures that are still on their way, which is the opposite of what
  // happened.
  //
  // No KPI row until there is a restaurant to have KPIs about. Six zeroes over
  // an outlet that has never had a table is not a quiet service, it is a
  // misleading one, and the setup checklist below says so instead.
  const cards: MetricProps[] =
    data && metrics && data.setup.configured
      ? [
          {
            id: 'tables',
            label: 'Tables occupied',
            value: `${count(data.kpis.tables_occupied)} / ${count(data.kpis.tables_total)}`,
            context:
              metrics.occupancyPc === null
                ? 'No tables set up yet'
                : `${percent(metrics.occupancyPc, 0)} occupancy · ${count(metrics.covers)} covers`,
            progress:
              metrics.occupancyPc === null
                ? null
                : { value: metrics.occupancyPc, label: `${metrics.occupancyPc}% of tables seated` },
            tone: 'green',
            icon: <Coffee size={19} />,
            hint: 'Tables with an open dine-in session right now. Live — the date filter does not change it.',
            href: '/floor',
          },
          {
            id: 'orders',
            label: 'Active orders',
            value: count(data.kpis.open_orders),
            context: `${count(data.kpis.tickets_pending)} in the kitchen · ${count(data.kpis.orders_ready)} ready to serve`,
            tone: 'blue',
            icon: <ReceiptText size={19} />,
            hint: 'Restaurant orders started and not yet settled, whatever the date filter says.',
            href: '/floor',
          },
          {
            id: 'serve',
            label: 'Avg serve time',
            value: data.serve.available ? duration(data.serve.average_seconds) : null,
            context: data.serve.available
              ? `Over ${count(data.serve.sampled)} ticket${data.serve.sampled === 1 ? '' : 's'} served`
              : 'No ticket was marked served in this period',
            comparison: serveComparison(data.serve),
            tone: 'orange',
            icon: <Clock size={19} />,
            hint: data.serve.basis,
            href: '/kitchen',
          },
          {
            id: 'sales',
            label: "Today's sales",
            value: money(data.sales.net),
            context: `${count(data.sales.orders)} settled order${data.sales.orders === 1 ? '' : 's'} in this period`,
            comparison: salesComparison(data.sales),
            tone: 'purple',
            icon: <IndianRupee size={19} />,
            hint: data.sales.basis,
          },
          {
            id: 'rating',
            label: 'Guest rating',
            // Never a zero and never a placeholder score: POS collects no
            // feedback at all, and a figure here would be invented.
            value: null,
            context: 'Not collected in POS',
            tone: 'cyan',
            icon: <Star size={19} />,
            hint: data.rating.note,
          },
        ]
      : []

  return (
    <PosDashboardShell
      title="Restaurant Operations"
      description="From table to kitchen. A seamless dining experience."
      headerIcon={<UtensilsCrossed size={21} />}
      activeDashboard="restaurant"
      visibleTabs={tabs}
      filterControls={
        <DashboardFilterBar filters={filters} update={update} showTerminal={false} showComparison={false} />
      }
      freshnessLabel={
        <>
          <Freshness at={board.fetchedAt} refreshing={board.refreshing} /> · live figures re-check every{' '}
          {Math.round(LIVE_REFRESH_MS / 1000)}s
        </>
      }
      statusControl={data ? <RestaurantServiceState service={data.service} /> : null}
      primaryAction={{ label: 'Open table', to: '/floor' }}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metrics={cards}
      metricsSkeleton={board.loading ? 5 : 0}
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        skeleton={<RestaurantBoardSkeleton />}
        onRetry={board.refresh}
      >
        {data && metrics && (
          <>
            {/* Nothing has been set up here at all — which is a different
                problem from a quiet service, and gets a different screen. */}
            {!data.setup.configured ? (
              <RestaurantSetupPanel setup={data.setup} />
            ) : (
              <>
                <OperationalAttention metrics={metrics} />

                <div className="pos-grid-ops">
                  <OrderFlowPanel board={data} />
                  <TableStatusPanel metrics={metrics} />
                  <TodaysOrdersPanel board={data} />
                </div>

                {signal && signal.id !== dismissed && (
                  <AicountlyInsightStrip signal={signal} onDismiss={() => setDismissed(signal.id)} />
                )}

                <RestaurantQuickActions />

                <RestaurantSessionPanel board={data} metrics={metrics} />

                <div className="pos-grid-main">
                  <FloorPlan board={data} />
                  <DelayAttention board={data} />
                </div>

                <KitchenBoard board={data} />

                <div className="pos-grid-main">
                  <OrderChannels board={data} />
                  <MenuAvailability board={data} />
                </div>

                <div className="pos-grid-equal">
                  <UnsettledBills board={data} />
                  <Panel
                    title="Guest experience"
                    description="What guests thought of the service."
                  >
                    <GuestFeedbackNote rating={data.rating} />
                  </Panel>
                </div>
              </>
            )}
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}

/**
 * Faster is better, so a fall is good news and is coloured as such.
 *
 * The arrow still points the way the figure actually moved — it is the colour
 * that follows the meaning, not the arrow.
 */
function serveComparison(serve: RestaurantBoard['serve']): MetricProps['comparison'] {
  if (!serve.available || serve.change_pc === null) return null

  const change = serve.change_pc
  if (Math.abs(change) < 0.5) {
    return { label: `about the same ${serve.previous.label}`, direction: 'flat', tone: 'neutral' }
  }

  return {
    label: `${percent(Math.abs(change), 0)} ${change > 0 ? 'slower' : 'faster'} ${serve.previous.label}`,
    direction: change > 0 ? 'up' : 'down',
    tone: change > 0 ? 'bad' : 'good',
  }
}

function salesComparison(sales: RestaurantBoard['sales']): MetricProps['comparison'] {
  if (sales.change_pc === null) return null

  const change = sales.change_pc
  if (Math.abs(change) < 0.5) {
    return { label: `about the same ${sales.previous.label}`, direction: 'flat', tone: 'neutral' }
  }

  return {
    label: `${change > 0 ? 'up' : 'down'} ${percent(Math.abs(change), 0)} ${sales.previous.label}`,
    direction: change > 0 ? 'up' : 'down',
    tone: change > 0 ? 'good' : 'bad',
  }
}
