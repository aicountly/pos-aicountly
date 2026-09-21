/**
 * Everything the Shift Report asks the API for.
 *
 * Kept apart from the components on purpose: a card that fetches is a card that
 * cannot be rendered from a fixture, and the reconcile dialog in particular has
 * to be testable without a till.
 */

import { api, type ListResponse } from '../services/api'
import type { DenominationEntry, RiskDetailRow, RiskKind, ShiftReport } from './types'

export interface ShiftReportQuery {
  locationId: number | null
  date: string
  sessionId: number | null
}

function params(query: ShiftReportQuery): Record<string, string | number | null> {
  return {
    location_id: query.locationId,
    date: query.date,
    session_id: query.sessionId,
  }
}

/** The whole board, in one round trip. */
export async function fetchShiftReport(query: ShiftReportQuery, signal?: AbortSignal): Promise<ShiftReport> {
  const response = await api.one<ShiftReport>('v1/shift-report', params(query), signal)

  return response.data
}

/** The audit trail, paged. Asked for separately because it grows without limit. */
export async function fetchShiftEvents(
  sessionId: number,
  kind: string,
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<ListResponse<import('./types').ShiftEvent>> {
  return api.list<import('./types').ShiftEvent>(
    'v1/shift-report/events',
    { session_id: sessionId, kind: kind === 'all' ? null : kind, limit, offset },
    signal,
  )
}

/** The rows behind one risk tile, fetched when somebody opens it and not before. */
export async function fetchRiskDetail(
  sessionId: number,
  kind: RiskKind,
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<ListResponse<RiskDetailRow>> {
  return api.list<RiskDetailRow>(
    'v1/shift-report/risk',
    { session_id: sessionId, kind, limit, offset },
    signal,
  )
}

export interface ReconcileInput {
  countedCash: number
  denominations: DenominationEntry[]
  varianceReason?: string
}

/**
 * Count the drawer and close the shift.
 *
 * The same endpoint the till has always used, with the denomination sheet
 * alongside the figure. It is safe to press twice: a shift that is already
 * closed answers 409 rather than closing again, which is the behaviour this
 * dialog relies on instead of inventing an idempotency key of its own.
 */
export async function reconcileShift(sessionId: number, input: ReconcileInput): Promise<void> {
  await api.post(`v1/shifts/${sessionId}/close`, {
    counted_cash: input.countedCash,
    denominations: input.denominations.filter((row) => row.quantity > 0),
    variance_reason: input.varianceReason?.trim() ? input.varianceReason.trim() : undefined,
  })
}
