/**
 * Everything the board works out for itself.
 *
 * Pure functions over the ticket collection, so the screen holds ONE list and
 * derives the four columns, the counts and the chips from it. Two lists that
 * are supposed to agree eventually do not.
 *
 * What is NOT derived here: today's average prep time and today's on-time
 * percentage. Those are counted by PostgreSQL over every ticket of the
 * session, and a browser holding the last two hundred cannot honestly compute
 * them. Where the server has not answered, the figure reads as unavailable
 * rather than as a number the screen made up.
 */

import type { KitchenFilters, KitchenHealth, KitchenTicket, OrderKind, SlaBand, TicketAgeing } from './types'

export const ORDER_KIND_LABEL: Record<OrderKind, string> = {
  dine_in: 'Dine in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  pickup: 'Pickup',
  qr_order: 'QR order',
  kiosk: 'Kiosk',
  retail: 'Counter',
}

export const PRIORITY_LABEL: Record<KitchenTicket['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  rush: 'Urgent',
}

/** What the ticket's own button says, which depends on where the food goes. */
export function readyVerb(ticket: KitchenTicket): string {
  switch (ticket.orderKind) {
    case 'delivery':
      return 'Ready for rider'
    case 'takeaway':
    case 'pickup':
      return 'Ready for pickup'
    default:
      return 'Ready to serve'
  }
}

export function handoffVerb(ticket: KitchenTicket): string {
  switch (ticket.orderKind) {
    case 'delivery':
      return 'Handed to rider'
    case 'takeaway':
    case 'pickup':
      return 'Collected'
    default:
      return 'Mark as served'
  }
}

/** "Dine in · Table T3", "Takeaway · Token 42", "Delivery" — the line under the number. */
export function ticketWhere(ticket: KitchenTicket): string {
  const parts: string[] = []
  if (ticket.orderKind) parts.push(ORDER_KIND_LABEL[ticket.orderKind])
  if (ticket.tableCode) parts.push(`Table ${ticket.tableCode}`)
  else if (ticket.tokenNo) parts.push(`Token ${ticket.tokenNo}`)
  if (parts.length === 0 && ticket.stationName) parts.push(ticket.stationName)

  return parts.join(' · ') || 'Kitchen ticket'
}

/**
 * The ticket's clock, read at one instant.
 *
 * `nowMs` and `fetchedAt` are passed in rather than read from the wall clock
 * so every card on a render agrees, and so the whole board can be re-timed by
 * changing one number.
 *
 * A READY or SERVED ticket does not age: the kitchen has done its part, and
 * leaving the clock running turns a waiter who was slow to the pass into a
 * kitchen failure.
 */
export function ageing(ticket: KitchenTicket, nowMs: number, fetchedAt: number, warnPc: number): TicketAgeing {
  const drift = ticket.clockStopped ? 0 : Math.max(0, Math.round((nowMs - fetchedAt) / 1000))
  const seconds = ticket.prepSecondsAtFetch + drift
  const target = ticket.targetSeconds > 0 ? ticket.targetSeconds : 900
  const ratio = seconds / target

  // The warning point is a preference because kitchens differ on how much
  // rope they want; the late point never is, because it is the station's.
  const warn = Math.min(0.95, Math.max(0.4, warnPc / 100))

  const band: SlaBand = ratio > 1 ? 'late' : ratio >= warn ? 'due' : ratio >= warn * 0.7 ? 'steady' : 'fresh'

  return {
    seconds,
    minutes: Math.floor(seconds / 60),
    band,
    ratio: Math.min(1.3, ratio),
    overdueSeconds: Math.max(0, seconds - target),
  }
}

/** True when a ticket the kitchen still owns has passed its station's threshold. */
export function isDelayed(ticket: KitchenTicket, nowMs: number, fetchedAt: number, warnPc: number): boolean {
  if (ticket.lane === 'served') return false

  return ageing(ticket, nowMs, fetchedAt, warnPc).band === 'late'
}

/**
 * "8 min", "1h 04m" — minutes, because that is the unit a kitchen talks in.
 *
 * Under a minute reads "<1 min" rather than "0 min": a ticket fired twenty
 * seconds ago has not taken no time, and a badge that says zero on a live
 * ticket looks like a broken clock.
 */
export function minutesLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60))
  if (total === 0) return '<1 min'
  if (total < 60) return `${total} min`

  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

function haystack(ticket: KitchenTicket): string {
  return [
    ticket.ticketNo,
    ticket.tableCode,
    ticket.tokenNo,
    ticket.customerName,
    ticket.stationName,
    ticket.locationName,
    ticket.orderKind ? ORDER_KIND_LABEL[ticket.orderKind] : null,
    ticket.notes,
    ...ticket.lines.map((line) => line.display_name),
    ...ticket.lines.flatMap((line) => line.modifiers.map((modifier) => modifier.option_name)),
    ...ticket.instructions,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * The tickets this screen is currently about.
 *
 * Outlet and station are NOT applied here — those are asked of the server, so
 * that the metrics beside the board are counted over the same set. What is
 * left is the narrowing a person does with the chips and the search box.
 */
export function applyFilters(
  tickets: KitchenTicket[],
  filters: KitchenFilters,
  nowMs: number,
  fetchedAt: number,
  warnPc: number,
): KitchenTicket[] {
  const query = filters.search.trim().toLowerCase()

  return tickets.filter((ticket) => {
    if (filters.orderKind !== 'all' && ticket.orderKind !== filters.orderKind) return false

    if (filters.status === 'delayed' && !isDelayed(ticket, nowMs, fetchedAt, warnPc)) return false
    if (filters.status !== 'all' && filters.status !== 'delayed' && ticket.lane !== filters.status) return false

    if (query && !haystack(ticket).includes(query)) return false

    return true
  })
}

export interface LaneGroups {
  new: KitchenTicket[]
  preparing: KitchenTicket[]
  ready: KitchenTicket[]
  served: KitchenTicket[]
}

/**
 * The four columns.
 *
 * Live lanes run oldest first — a kitchen works a queue, and a screen that
 * sorts any other way loses tickets at the bottom. Served runs newest first,
 * because the only question asked of that column is "what just went out?".
 */
export function groupByLane(tickets: KitchenTicket[], servedLimit: number): LaneGroups {
  const groups: LaneGroups = { new: [], preparing: [], ready: [], served: [] }

  for (const ticket of tickets) groups[ticket.lane].push(ticket)

  const oldestFirst = (a: KitchenTicket, b: KitchenTicket) =>
    new Date(a.firedAt).getTime() - new Date(b.firedAt).getTime()

  groups.new.sort(oldestFirst)
  groups.preparing.sort(oldestFirst)
  groups.ready.sort(oldestFirst)
  groups.served.sort((a, b) => new Date(b.servedAt ?? b.firedAt).getTime() - new Date(a.servedAt ?? a.firedAt).getTime())
  groups.served = groups.served.slice(0, Math.max(0, servedLimit))

  return groups
}

export interface LaneCounts {
  all: number
  new: number
  preparing: number
  ready: number
  served: number
  delayed: number
  /** Live tickets only — served ones are not work outstanding. */
  active: number
}

/**
 * The chip counts.
 *
 * Counted over the tickets BEFORE the status chips are applied, or pressing
 * "New" would leave every other chip reading zero and there would be no way
 * back.
 */
export function laneCounts(tickets: KitchenTicket[], nowMs: number, fetchedAt: number, warnPc: number): LaneCounts {
  const counts: LaneCounts = { all: 0, new: 0, preparing: 0, ready: 0, served: 0, delayed: 0, active: 0 }

  for (const ticket of tickets) {
    counts[ticket.lane] += 1
    if (ticket.lane !== 'served') counts.active += 1
    if (isDelayed(ticket, nowMs, fetchedAt, warnPc)) counts.delayed += 1
  }

  counts.all = counts.active

  return counts
}

/**
 * The strip along the bottom.
 *
 * Says what the numbers actually support and nothing more. There is no model
 * behind this and it does not pretend there is: it is three thresholds over
 * counts the kitchen can see for itself on the same screen.
 */
export function kitchenHealth(counts: LaneCounts, nearingSla: number): KitchenHealth {
  if (counts.delayed > 0) {
    return {
      level: 'critical',
      title: `${counts.delayed} ticket${counts.delayed === 1 ? '' : 's'} past target`,
      detail:
        counts.delayed === 1
          ? 'One ticket has passed its station’s prep target. Clear it first.'
          : 'These tickets have passed their station’s prep target. Clear the oldest first.',
    }
  }

  if (counts.active === 0) {
    return {
      level: 'idle',
      title: 'Kitchen queue clear',
      detail: 'Nothing is waiting. New tickets appear here the moment they are fired.',
    }
  }

  if (nearingSla > 0 || counts.active >= 12) {
    return {
      level: 'busy',
      title: 'Kitchen load increasing',
      detail:
        nearingSla > 0
          ? `${counts.active} live · ${nearingSla} nearing target. Nothing is late yet.`
          : `${counts.active} tickets live. Nothing is late yet.`,
    }
  }

  return {
    level: 'healthy',
    title: 'Kitchen running smoothly',
    detail: `${counts.active} live · ${counts.preparing} preparing · ${counts.ready} ready to go out.`,
  }
}

/** How many live tickets are inside the warning band but not yet late. */
export function nearingSlaCount(tickets: KitchenTicket[], nowMs: number, fetchedAt: number, warnPc: number): number {
  return tickets.filter((ticket) => ticket.lane !== 'served' && ageing(ticket, nowMs, fetchedAt, warnPc).band === 'due')
    .length
}
