/**
 * The filter state, and the one function that applies it.
 *
 * Only fields that BOTH sides of the queue actually carry are offered. A filter
 * for the cashier would look complete and quietly hide every sale that arrived
 * from another till, because the server's queue endpoint does not return a
 * cashier — and a filter that silently drops rows on a screen about missing
 * money is worse than no filter at all. See the note in OfflineQueueSide.
 */

import type { QueueRecord, QueueStatus, QueueType } from './model'

export type DateWindow = 'today' | 'yesterday' | 'week' | 'all'

export interface QueueFilterState {
  types: QueueType[]
  statuses: QueueStatus[]
  terminalId: number | null
  window: DateWindow
  minAttempts: number
}

export const EMPTY_FILTERS: QueueFilterState = {
  types: [],
  statuses: [],
  terminalId: null,
  window: 'all',
  minAttempts: 0,
}

export function activeFilterCount(filters: QueueFilterState): number {
  let count = 0
  if (filters.types.length > 0) count++
  if (filters.statuses.length > 0) count++
  if (filters.terminalId !== null) count++
  if (filters.window !== 'all') count++
  if (filters.minAttempts > 0) count++
  return count
}

function startOfDay(offsetDays = 0): number {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - offsetDays)
  return day.getTime()
}

function inWindow(iso: string, window: DateWindow): boolean {
  if (window === 'all') return true
  const when = Date.parse(iso)
  // An unreadable date is kept rather than hidden. On a screen about money that
  // has not arrived, a row disappearing is the worse failure.
  if (Number.isNaN(when)) return true

  switch (window) {
    case 'today':
      return when >= startOfDay(0)
    case 'yesterday':
      return when >= startOfDay(1) && when < startOfDay(0)
    case 'week':
      return when >= startOfDay(6)
    default:
      return true
  }
}

export function applyFilters(records: QueueRecord[], filters: QueueFilterState): QueueRecord[] {
  const { types, statuses, terminalId, window, minAttempts } = filters
  if (
    types.length === 0 &&
    statuses.length === 0 &&
    terminalId === null &&
    window === 'all' &&
    minAttempts === 0
  ) {
    return records
  }

  return records.filter((record) => {
    if (types.length > 0 && !types.includes(record.type)) return false
    if (statuses.length > 0 && !statuses.includes(record.status)) return false
    if (terminalId !== null && record.terminalId !== terminalId) return false
    if (minAttempts > 0 && record.attempts < minAttempts) return false
    if (!inWindow(record.createdAt, window)) return false
    return true
  })
}

/**
 * Free-text search across the things a cashier would actually type.
 *
 * The uuid is searchable because it is what support asks for, and the only
 * handle an offline sale has before the server gives it a number.
 */
export function applySearch(records: QueueRecord[], query: string): QueueRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return records

  return records.filter((record) => {
    const haystack = [
      record.reference,
      record.customer,
      record.type,
      record.status.replace(/_/g, ' '),
      record.clientUuid,
      record.serverReference !== null ? `#${record.serverReference}` : '',
      record.amount !== null ? record.amount.toFixed(2) : '',
      record.terminalId !== null ? `pos-${String(record.terminalId).padStart(2, '0')}` : '',
    ]
      .join(' ')
      .toLowerCase()

    return haystack.includes(needle)
  })
}
