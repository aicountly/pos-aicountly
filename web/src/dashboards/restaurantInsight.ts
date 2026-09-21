/**
 * Restaurant Operations: the board reduced to the figures a manager reasons
 * with, and the rules that read them.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PANELS. Two reasons, and the second
 * is the important one.
 *
 *   1. Six panels want the same derived numbers — occupancy, tickets late,
 *      value sitting unsettled on the floor. Deriving them once means the
 *      insight strip cannot disagree with the card above it.
 *   2. THERE IS NO AI HERE, AND THIS IS THE SEAM WHERE THERE COULD BE. Every
 *      signal below is a threshold crossing computed in this browser from
 *      figures the server counted. Nothing is predicted, nothing is scored and
 *      no model is called, which is why every signal the UI renders carries a
 *      "Rule-based alert" badge rather than an AI one. `getRestaurantOperationalInsight`
 *      takes metrics and returns a signal, so a server-side intelligence
 *      endpoint can replace the body without any panel changing.
 *
 * TODO(api): when POS gains a model integration through Console's central key
 * arrangement, add `kind: 'ai'` signals from that endpoint ALONGSIDE these and
 * badge them as such. It must not relabel these: a threshold crossing stays a
 * threshold crossing, and an "AI" badge on a count is how people stop believing
 * the badge anywhere in the product.
 */

import type { RestaurantBoard } from './types'

/**
 * The operational picture, in plain numbers.
 *
 * Every field is counted by the server or derived from rows it sent. Nothing is
 * defaulted to a flattering value: where POS cannot answer, the field is null
 * and the screen says so rather than showing a zero.
 */
export interface RestaurantOperationalMetrics {
  totalTables: number
  occupiedTables: number
  availableTables: number
  billingTables: number
  cleaningTables: number
  /** Null when there are no tables at all — 0 of 0 is not "empty", it is "none". */
  occupancyPc: number | null
  covers: number

  activeOrders: number
  kitchenTickets: number
  readyTickets: number
  lateTickets: number
  servedTickets: number

  averageServeSeconds: number | null
  serveChangePc: number | null
  serveSampled: number

  salesNet: number
  salesOrders: number
  salesChangePc: number | null
  salesComparisonLabel: string

  unsettledBills: number
  unsettledValue: number
  menuUnavailable: number

  serviceOpen: boolean
  /** False when the restaurant module has not been set up at all. */
  configured: boolean
}

/** The four states a table can be in, as the floor plan already names them. */
export const TABLE_STATE_ORDER = ['occupied', 'available', 'billing', 'cleaning'] as const

export type TableState = (typeof TABLE_STATE_ORDER)[number]

export const TABLE_STATE_LABEL: Record<TableState, string> = {
  occupied: 'Seated',
  available: 'Free',
  billing: 'Billing',
  cleaning: 'Clearing',
}

/**
 * Tint per table state, matching the floor plan's own cards.
 *
 * Decoration only. Every legend row and every chart row carries the state in
 * words beside the count.
 */
export const TABLE_STATE_COLOUR: Record<TableState, string> = {
  occupied: '#25b003',
  available: '#cbd5cd',
  billing: '#e0a93b',
  cleaning: '#7aa0d8',
}

/**
 * The board, reduced.
 *
 * Table states are counted from `floors` rather than asked for separately: the
 * server already sent every table with its state, and a second count over the
 * same rows is a second number to disagree with the first.
 */
export function restaurantMetrics(board: RestaurantBoard): RestaurantOperationalMetrics {
  const states: Record<TableState, number> = { occupied: 0, available: 0, billing: 0, cleaning: 0 }

  for (const floor of board.floors) {
    for (const table of floor.tables) {
      if (table.state in states) states[table.state] += 1
    }
  }

  const totalTables = board.kpis.tables_total
  const seated = board.kpis.tables_occupied

  return {
    totalTables,
    occupiedTables: states.occupied,
    availableTables: states.available,
    billingTables: states.billing,
    cleaningTables: states.cleaning,
    occupancyPc: totalTables > 0 ? Math.round((seated / totalTables) * 100) : null,
    covers: board.kpis.covers,

    activeOrders: board.kpis.open_orders,
    kitchenTickets: board.kpis.tickets_pending,
    readyTickets: board.kpis.orders_ready,
    lateTickets: board.kpis.tickets_overdue,
    servedTickets: board.kpis.tickets_served,

    averageServeSeconds: board.serve.available ? board.serve.average_seconds : null,
    serveChangePc: board.serve.change_pc,
    serveSampled: board.serve.sampled,

    salesNet: board.sales.net,
    salesOrders: board.sales.orders,
    salesChangePc: board.sales.change_pc,
    salesComparisonLabel: board.sales.previous.label,

    unsettledBills: board.kpis.unsettled_bills,
    unsettledValue: board.kpis.unsettled_value,
    menuUnavailable: board.menu.unavailable,

    serviceOpen: board.service.state === 'open',
    configured: board.setup.configured,
  }
}

export type SignalSeverity = 'success' | 'info' | 'warning' | 'danger'

export interface RestaurantSignal {
  id: string
  severity: SignalSeverity
  /** Always 'rule' today. An intelligence endpoint would answer 'ai'. */
  kind: 'rule' | 'ai'
  title: string
  explanation: string
  /** Where the affected items actually are. Never a screen invented for the alert. */
  evidenceHref?: string
  evidenceLabel?: string
}

/** The thresholds, in one place, so they can be read and argued with. */
const THRESHOLDS = {
  /** A floor above this needs a waiting list started, not discovered. */
  busyOccupancyPc: 80,
  /** More than a couple of plates under the pass is a service problem, not a kitchen one. */
  platesWaiting: 3,
  /** Below this sample an average serve time is one slow table, not a trend. */
  serveSample: 5,
  /** A rise smaller than this is noise between two services. */
  serveRisePc: 20,
}

const SEVERITY_RANK: Record<SignalSeverity, number> = { danger: 0, warning: 1, info: 2, success: 3 }

/**
 * Everything crossing a threshold right now, worst first.
 *
 * A count of zero produces NO signal. "0 tickets are late" is not news and a
 * board that lists every quiet thing trains people to stop reading it.
 */
export function restaurantSignals(metrics: RestaurantOperationalMetrics): RestaurantSignal[] {
  const signals: RestaurantSignal[] = []

  if (metrics.lateTickets > 0) {
    signals.push({
      id: 'late-tickets',
      kind: 'rule',
      severity: metrics.lateTickets > 2 ? 'danger' : 'warning',
      title: `${plural(metrics.lateTickets, 'ticket is', 'tickets are')} past the station's own time`,
      explanation:
        'Each station has its own late-after time, and these are beyond it. Redistribute them or tell the floor before the table asks.',
      evidenceHref: '/kitchen',
      evidenceLabel: 'Open the kitchen screen',
    })
  }

  if (metrics.readyTickets >= THRESHOLDS.platesWaiting) {
    signals.push({
      id: 'ready-waiting',
      kind: 'rule',
      severity: 'warning',
      title: `${plural(metrics.readyTickets, 'plate is', 'plates are')} cooked and waiting to go out`,
      explanation:
        'Food is sitting under the pass. This is a service problem rather than a kitchen one — it needs someone to run it, not more cooking.',
      evidenceHref: '/kitchen',
      evidenceLabel: 'Open the kitchen screen',
    })
  }

  if (metrics.occupancyPc !== null && metrics.occupancyPc >= THRESHOLDS.busyOccupancyPc && metrics.totalTables > 0) {
    signals.push({
      id: 'occupancy',
      kind: 'rule',
      severity: 'info',
      title: `The floor is ${metrics.occupancyPc}% full`,
      explanation:
        metrics.availableTables > 0
          ? `${plural(metrics.availableTables, 'table is', 'tables are')} still free. Start the waiting list now rather than when the last one goes.`
          : 'Every table is taken. Anyone arriving now is waiting, so start the list and say how long.',
      evidenceHref: '/floor',
      evidenceLabel: 'Open the floor screen',
    })
  }

  if (
    metrics.serveChangePc !== null &&
    metrics.serveChangePc >= THRESHOLDS.serveRisePc &&
    metrics.serveSampled >= THRESHOLDS.serveSample
  ) {
    signals.push({
      id: 'serve-time',
      kind: 'rule',
      severity: 'warning',
      title: `Tickets are taking ${Math.round(metrics.serveChangePc)}% longer than the period before`,
      explanation: `Measured over ${plural(metrics.serveSampled, 'ticket', 'tickets')} marked served. A rise this size is usually one station falling behind rather than the whole kitchen.`,
      evidenceHref: '/kitchen',
      evidenceLabel: 'Open the kitchen screen',
    })
  }

  if (metrics.unsettledBills > 0 && metrics.unsettledValue > 0) {
    signals.push({
      id: 'unsettled',
      kind: 'rule',
      severity: 'info',
      title: `${plural(metrics.unsettledBills, 'table is', 'tables are')} carrying an unsettled bill`,
      explanation:
        'Open orders on the floor right now, whatever the date filter says. They stay open until someone settles them.',
      evidenceHref: '/floor',
      evidenceLabel: 'Open the floor screen',
    })
  }

  if (metrics.menuUnavailable > 0) {
    signals.push({
      id: 'menu-off',
      kind: 'rule',
      severity: 'info',
      title: `${plural(metrics.menuUnavailable, 'menu item is', 'menu items are')} off`,
      explanation: 'The kitchen has marked these finished or paused. Tell the floor before a guest orders one.',
    })
  }

  // Nothing crossed. Say so once, and only when there is a service to say it
  // about — "everything is fine" on an empty restaurant is not a finding.
  if (signals.length === 0 && (metrics.activeOrders > 0 || metrics.occupiedTables > 0)) {
    signals.push({
      id: 'steady',
      kind: 'rule',
      severity: 'success',
      title: 'Service is steady',
      explanation:
        'Nothing is late, nothing is waiting under the pass and the floor has room. No threshold has been crossed — nothing is being hidden.',
    })
  }

  return signals.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

/**
 * The one thing to say, if anything.
 *
 * This is the seam an intelligence endpoint would replace: it takes metrics and
 * answers a signal, and no panel that renders it knows where the signal came
 * from beyond the `kind` field it carries.
 */
export function getRestaurantOperationalInsight(
  metrics: RestaurantOperationalMetrics,
): RestaurantSignal | null {
  // TODO(api): call the POS intelligence endpoint here when one exists, fall
  // back to these rules when it is unreachable, and keep the `kind` field
  // honest about which of the two answered.
  return restaurantSignals(metrics)[0] ?? null
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}
