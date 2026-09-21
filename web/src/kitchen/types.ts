/**
 * The kitchen screen's own vocabulary.
 *
 * A KitchenTicket is a VIEW of the API's Kot, not a second copy of it: the
 * fields here are either renamed for the screen or derived from timestamps the
 * server sent. Nothing on it is written back — a ticket changes by asking the
 * server to advance it and taking the answer.
 */

import type { KdsMetrics, KdsStation, Kot, KotLine } from '../services/types'

export type { KdsMetrics, KdsStation }

/** The four columns a kitchen actually works in. */
export type Lane = 'new' | 'preparing' | 'ready' | 'served'

export type StatusFilter = 'all' | Lane | 'delayed'

/**
 * How a ticket is doing against its own station's threshold.
 *
 * Four bands, not two, because "nine minutes into a twelve-minute target" is
 * the moment a kitchen can still save a ticket, and a screen that only goes
 * red at the end tells them when it is too late.
 */
export type SlaBand = 'fresh' | 'steady' | 'due' | 'late'

export type OrderKind = 'dine_in' | 'takeaway' | 'delivery' | 'pickup' | 'qr_order' | 'kiosk' | 'retail'

export interface KitchenTicket {
  id: number
  ticketNo: string
  /** 'new' | 'addon' | 'amend' | 'void' — an addon is a second round, not a missed ticket. */
  kind: Kot['kot_kind']
  lane: Lane
  status: Kot['status']
  priority: 'low' | 'normal' | 'high' | 'rush'
  orderKind: OrderKind | null
  tableCode: string | null
  tokenNo: string | null
  customerName: string | null
  covers: number | null
  stationId: number | null
  stationName: string | null
  locationId: number | null
  locationName: string | null
  firedAt: string
  readyAt: string | null
  servedAt: string | null
  /**
   * Fired → ready, frozen once the kitchen is done. Seconds, as at `fetchedAt`.
   * The screen adds the drift since; it does not ask the server every second.
   */
  prepSecondsAtFetch: number
  /** True once the clock has stopped — READY and SERVED tickets do not age. */
  clockStopped: boolean
  /** This ticket's station threshold in seconds. Never a global number. */
  targetSeconds: number
  notes: string | null
  lines: KotLine[]
  lineCount: number
  /** Every allergy note on the ticket, hoisted so the card can shout about it. */
  allergyNotes: string[]
  /** Every kitchen instruction on the ticket, same reason. */
  instructions: string[]
  /** The status this ticket moves to next, or null when it is finished. */
  nextStatus: Kot['status'] | null
}

/** A ticket with its clock read at one instant. */
export interface TicketAgeing {
  seconds: number
  minutes: number
  band: SlaBand
  /** 0–1.3, clamped. What the progress bar draws. */
  ratio: number
  overdueSeconds: number
}

export interface KitchenFilters {
  status: StatusFilter
  locationId: number | null
  stationId: number | null
  orderKind: string
  search: string
}

export interface KitchenPreferences {
  density: 'comfortable' | 'compact'
  autoRefresh: boolean
  sound: boolean
  volume: number
  newOrderAlert: boolean
  showServed: boolean
  servedCount: number
  /** Percentage of the target at which a ticket starts warning. */
  slaWarnPc: number
  defaultStationId: number | null
}

export interface KitchenHealth {
  level: 'healthy' | 'busy' | 'critical' | 'idle'
  title: string
  detail: string
}
