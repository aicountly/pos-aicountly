/**
 * The kitchen screen's one door to the server.
 *
 * Everything the board knows comes through here and nothing else in the
 * kitchen module imports `api`. That is the whole point: the screen is written
 * against KitchenTicket, so when the endpoints move the mapping moves with
 * them and no component changes.
 *
 * It talks to the ROUTES THAT ALREADY EXIST — `GET v1/kds`, `POST
 * v1/kots/{id}/advance`, `POST v1/kots/{id}/cancel`. No kitchen-shaped API was
 * invented to match a mockup, and nothing about stock or accounting is
 * computed here: a ticket is an instruction to cook and that is all it is.
 */

import { api } from '../services/api'
import type { KdsDisplay, KdsMetrics, KdsStation, Kot, KotStatus } from '../services/types'
import type { KitchenTicket, Lane, OrderKind } from './types'

export interface KitchenSnapshot {
  /** Live and recently-served tickets in ONE collection. Lanes are derived. */
  tickets: KitchenTicket[]
  stations: KdsStation[]
  metrics: KdsMetrics | null
  /** When this answer was received. Every clock on the screen is read from it. */
  fetchedAt: number
  /** True when the API answered without the KDS extras — an older build. */
  partial: boolean
}

const ORDER_KINDS: OrderKind[] = ['dine_in', 'takeaway', 'delivery', 'pickup', 'qr_order', 'kiosk', 'retail']

const LANE_BY_STATUS: Record<KotStatus, Lane> = {
  NEW: 'new',
  ACCEPTED: 'new',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  // Cancelled tickets never reach a lane; they are filtered out before this.
  CANCELLED: 'served',
}

const NEXT_BY_STATUS: Partial<Record<KotStatus, KotStatus>> = {
  NEW: 'PREPARING',
  ACCEPTED: 'PREPARING',
  PREPARING: 'READY',
  READY: 'SERVED',
}

function priorityOf(raw: string | null | undefined): KitchenTicket['priority'] {
  const value = (raw ?? 'normal').toLowerCase()

  return value === 'low' || value === 'high' || value === 'rush' ? value : 'normal'
}

function orderKindOf(raw: string | null | undefined): OrderKind | null {
  if (!raw) return null
  const value = raw.toLowerCase() as OrderKind

  return ORDER_KINDS.includes(value) ? value : null
}

function secondsSince(iso: string, until: number): number {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return 0

  return Math.max(0, Math.round((until - at) / 1000))
}

/**
 * One API ticket, as the screen sees it.
 *
 * Tolerant on purpose. Every enriched field is optional on the wire, so a
 * front end deployed ahead of its API still renders a usable board: the
 * station threshold falls back to fifteen minutes, which is the same default
 * the database column carries, and the clock falls back to arithmetic on
 * `fired_at`.
 */
export function toTicket(kot: Kot, fetchedAt: number): KitchenTicket {
  const stopped = kot.status === 'READY' || kot.status === 'SERVED'
  const frozenAt = kot.ready_at ?? kot.served_at

  const prepSeconds =
    typeof kot.prep_seconds === 'number'
      ? kot.prep_seconds
      : stopped && frozenAt
        ? Math.max(0, secondsSince(kot.fired_at, new Date(frozenAt).getTime()))
        : secondsSince(kot.fired_at, fetchedAt)

  const targetSeconds =
    typeof kot.target_seconds === 'number' && kot.target_seconds > 0
      ? kot.target_seconds
      : (kot.late_after_minutes ?? 15) * 60

  const lines = kot.lines ?? []

  return {
    id: kot.kot_id,
    ticketNo: kot.kot_no,
    kind: kot.kot_kind,
    lane: LANE_BY_STATUS[kot.status] ?? 'new',
    status: kot.status,
    priority: priorityOf(kot.priority),
    orderKind: orderKindOf(kot.order_kind),
    tableCode: kot.table_code,
    tokenNo: kot.token_no,
    customerName: kot.customer_name ?? null,
    covers: kot.covers ?? null,
    stationId: kot.station_id,
    stationName: kot.station_name,
    locationId: kot.location_id ?? null,
    locationName: kot.location_name ?? kot.location_code ?? null,
    firedAt: kot.fired_at,
    readyAt: kot.ready_at ?? null,
    servedAt: kot.served_at ?? null,
    prepSecondsAtFetch: prepSeconds,
    clockStopped: stopped,
    targetSeconds,
    notes: kot.notes,
    lines,
    lineCount: kot.line_count ?? lines.length,
    allergyNotes: lines.map((line) => line.allergy_note).filter((note): note is string => !!note),
    instructions: lines.map((line) => line.instructions).filter((note): note is string => !!note),
    nextStatus: kot.next_status ?? NEXT_BY_STATUS[kot.status] ?? null,
  }
}

export interface KitchenQuery {
  locationId: number | null
  stationId: number | null
  /** How many served tickets to carry, for the column and the history drawer. */
  servedLimit: number
}

/**
 * The whole board, in one request.
 *
 * `station_id` and `location_id` go to the server because the metrics beside
 * them have to be counted over the same set — a board filtered to the tandoor
 * beside an on-time figure for the whole kitchen is two different answers
 * presented as one. Status, order kind and search are narrower questions about
 * tickets already in hand and are answered without asking again.
 */
export async function fetchKitchen(query: KitchenQuery, signal?: AbortSignal): Promise<KitchenSnapshot> {
  const response = await api.one<KdsDisplay>(
    'v1/kds',
    {
      station_id: query.stationId,
      location_id: query.locationId,
      served_limit: query.servedLimit,
    },
    signal,
  )

  const fetchedAt = Date.now()
  const payload = response.data
  const live = payload.kots ?? []
  const served = payload.served ?? []

  return {
    tickets: [...live, ...served]
      .filter((kot) => kot.status !== 'CANCELLED')
      .map((kot) => toTicket(kot, fetchedAt)),
    stations: payload.stations ?? [],
    metrics: payload.metrics ?? null,
    fetchedAt,
    partial: payload.metrics === undefined,
  }
}

/**
 * Move a ticket along.
 *
 * The server owns the transition and the race: two expo screens pressing the
 * same button is a real event in a kitchen, and it is settled by whichever
 * request lands first, not by whichever finger was faster. The answer comes
 * back as the ticket, so the caller can replace its copy rather than guess.
 */
export async function advanceTicket(id: number, status: KotStatus, fetchedAt = Date.now()): Promise<KitchenTicket> {
  const response = await api.post<Kot>(`v1/kots/${id}/advance`, { status })

  return toTicket(response.data, fetchedAt)
}

/**
 * Stop a ticket the kitchen already has.
 *
 * Permissioned separately from advancing it and always with a reason, because
 * by now food may be made and someone has to answer for the wastage. The
 * server records the approval trail; this only asks.
 */
export async function cancelTicket(id: number, reason: string): Promise<void> {
  await api.post<Kot>(`v1/kots/${id}/cancel`, { reason })
}
