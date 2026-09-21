/**
 * The Shift Report's filters, and fetching a shift with them.
 *
 * FILTERS LIVE IN THE URL, the same as the dashboards. A manager who picks an
 * outlet, a date and a shift and then sends the link has sent what they were
 * looking at — which is what the Share action on this screen copies — and the
 * back button undoes a filter change, which component state does not give you.
 *
 * STALE DATA IS THE BUG THIS FILE EXISTS TO PREVENT. Changing the shift while a
 * request is in flight has one acceptable outcome: the old shift's figures
 * never reach the screen. An AbortController alone is not enough, because an
 * abort does not stop a promise that has already resolved — so every request
 * carries a generation number and a late answer is discarded rather than
 * painted over the shift somebody is now reading.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getScope } from '../services/api'
import { fetchRiskDetail, fetchShiftEvents, fetchShiftReport, type ShiftReportQuery } from './api'
import type { EventKind, RiskDetailRow, RiskKind, ShiftEvent, ShiftReport } from './types'

export function today(): string {
  const now = new Date()

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

function readInt(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number.parseInt(raw, 10)

  return Number.isFinite(value) && value > 0 ? value : null
}

export interface ShiftFilters extends ShiftReportQuery {
  update: (patch: Partial<ShiftReportQuery>) => void
}

export function useShiftFilters(): ShiftFilters {
  const [params, setParams] = useSearchParams()

  const date = useMemo(() => {
    const raw = params.get('date')

    return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today()
  }, [params])

  const locationId = useMemo(() => readInt(params.get('location_id')), [params])
  const sessionId = useMemo(() => readInt(params.get('session_id')), [params])

  const update = useCallback(
    (patch: Partial<ShiftReportQuery>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          const set = (key: string, value: string | number | null | undefined) => {
            if (value === null || value === undefined || value === '') next.delete(key)
            else next.set(key, String(value))
          }

          // A shift belongs to one outlet on one date, so changing either of
          // those cannot leave the old shift selected — it would silently
          // re-open the filters on a shift that is not in them.
          if ('locationId' in patch) {
            set('location_id', patch.locationId ?? null)
            next.delete('session_id')
          }
          if ('date' in patch) {
            set('date', patch.date ?? null)
            next.delete('session_id')
          }
          if ('sessionId' in patch) set('session_id', patch.sessionId ?? null)

          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  return { date, locationId, sessionId, update }
}

export interface ShiftReportState {
  data: ShiftReport | null
  loading: boolean
  refreshing: boolean
  error: string | null
  fetchedAt: Date | null
  refresh: () => void
}

/**
 * Fetch the board.
 *
 * `refreshing` is separate from `loading` on purpose: the first load of a new
 * shift must blank the screen, because the previous shift's figures under the
 * new shift's heading are worse than nothing. A manual refresh of the same
 * shift must not, because somebody is reading it.
 */
export function useShiftReport(query: ShiftReportQuery): ShiftReportState {
  const scope = getScope()
  const scopeKey = scope ? `${scope.cmp_id}:${scope.fy_id}:${scope.bo_id}` : 'none'
  const queryKey = `${query.locationId ?? ''}|${query.date}|${query.sessionId ?? ''}`

  const [data, setData] = useState<ShiftReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [token, setToken] = useState(0)

  const generation = useRef(0)
  const lastKey = useRef(`${scopeKey}|${queryKey}`)

  // Cleared during render, before the effect runs, so there is no frame in
  // which one shift's takings sit under another shift's heading.
  if (lastKey.current !== `${scopeKey}|${queryKey}`) {
    lastKey.current = `${scopeKey}|${queryKey}`
    generation.current += 1
    if (data !== null) setData(null)
    if (error !== null) setError(null)
    setFetchedAt(null)
  }

  const refresh = useCallback(() => setToken((n) => n + 1), [])

  useEffect(() => {
    if (!scope) {
      setLoading(false)

      return
    }

    const mine = ++generation.current
    const controller = new AbortController()

    // Read from the closure rather than from a setState updater: an updater
    // must be pure, and React calls it twice in development to prove it.
    if (data === null) setLoading(true)
    else setRefreshing(true)
    setError(null)

    fetchShiftReport(query, controller.signal)
      .then((report) => {
        if (mine !== generation.current) return
        setData(report)
        setFetchedAt(new Date())
      })
      .catch((err: Error) => {
        if (mine !== generation.current || controller.signal.aborted) return
        setData(null)
        setError(err.message)
      })
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
        setRefreshing(false)
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, scopeKey, token])

  return { data, loading, refreshing, error, fetchedAt, refresh }
}

export const EVENTS_PER_PAGE = 12

export interface EventsState {
  items: ShiftEvent[]
  kinds: EventKind[]
  total: number
  offset: number
  loading: boolean
  error: string | null
  setKind: (kind: string) => void
  kind: string
  setOffset: (offset: number) => void
}

/**
 * The audit trail, a page at a time.
 *
 * Seeded from the board's own first page so the card has something to draw on
 * the first paint, and re-fetched from there whenever the filter or the page
 * changes. A shift with four hundred events sends twelve of them.
 */
export function useShiftEvents(
  sessionId: number | null,
  seed: { items: ShiftEvent[]; total: number; kinds: EventKind[] },
): EventsState {
  const [kind, setKindState] = useState('all')
  const [offset, setOffsetState] = useState(0)
  const [page, setPage] = useState<{ items: ShiftEvent[]; total: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  // A new shift resets the trail: its page 2 is not this shift's page 2.
  const lastSession = useRef(sessionId)
  if (lastSession.current !== sessionId) {
    lastSession.current = sessionId
    generation.current += 1
    if (kind !== 'all') setKindState('all')
    if (offset !== 0) setOffsetState(0)
    if (page !== null) setPage(null)
    if (error !== null) setError(null)
  }

  const untouched = kind === 'all' && offset === 0 && page === null

  useEffect(() => {
    if (sessionId === null || untouched) return

    const mine = ++generation.current
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchShiftEvents(sessionId, kind, EVENTS_PER_PAGE, offset, controller.signal)
      .then((response) => {
        if (mine !== generation.current) return
        setPage({ items: response.data, total: response.meta.total })
      })
      .catch((err: Error) => {
        if (mine !== generation.current || controller.signal.aborted) return
        setError(err.message)
      })
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
      })

    return () => controller.abort()
  }, [sessionId, kind, offset, untouched])

  const setKind = useCallback((next: string) => {
    setKindState(next)
    setOffsetState(0)
  }, [])

  return {
    items: page?.items ?? seed.items,
    total: page?.total ?? seed.total,
    kinds: seed.kinds,
    kind,
    offset,
    loading,
    error,
    setKind,
    setOffset: setOffsetState,
  }
}

export const RISK_ROWS_PER_PAGE = 20

export interface RiskDetailState {
  rows: RiskDetailRow[]
  total: number
  note: string | null
  loading: boolean
  error: string | null
  offset: number
  setOffset: (offset: number) => void
  retry: () => void
}

/** The rows behind one risk tile. Nothing is fetched until a tile is opened. */
export function useRiskDetail(sessionId: number | null, kind: RiskKind | null): RiskDetailState {
  const [rows, setRows] = useState<RiskDetailRow[]>([])
  const [total, setTotal] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [token, setToken] = useState(0)
  const generation = useRef(0)

  const lastKind = useRef(kind)
  if (lastKind.current !== kind) {
    lastKind.current = kind
    generation.current += 1
    if (offset !== 0) setOffset(0)
    if (rows.length > 0) setRows([])
    if (error !== null) setError(null)
  }

  useEffect(() => {
    if (sessionId === null || kind === null) return

    const mine = ++generation.current
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchRiskDetail(sessionId, kind, RISK_ROWS_PER_PAGE, offset, controller.signal)
      .then((response) => {
        if (mine !== generation.current) return
        setRows(response.data)
        setTotal(response.meta.total)
        setNote(typeof response.meta.note === 'string' ? response.meta.note : null)
      })
      .catch((err: Error) => {
        if (mine !== generation.current || controller.signal.aborted) return
        setError(err.message)
      })
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
      })

    return () => controller.abort()
  }, [sessionId, kind, offset, token])

  return {
    rows,
    total,
    note,
    loading,
    error,
    offset,
    setOffset,
    retry: useCallback(() => setToken((n) => n + 1), []),
  }
}
