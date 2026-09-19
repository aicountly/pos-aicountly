/**
 * Dashboard filters, and fetching a board with them.
 *
 * FILTERS LIVE IN THE URL. A manager who narrows to one outlet and one week and
 * then sends the link has sent what they were looking at. It also means the back
 * button undoes a filter change, which is what everyone expects it to do and
 * what component state does not give you.
 *
 * STALE DATA IS THE BUG THIS FILE EXISTS TO PREVENT. Switching company while a
 * request is in flight has exactly one acceptable outcome: the old company's
 * figures never reach the screen. Two things enforce that, and both are needed.
 *
 *   1. The in-flight request is ABORTED and its response is discarded — an
 *      AbortController per request plus a generation counter, because an abort
 *      is not instantaneous and a response can already be in the microtask queue.
 *   2. The previously loaded board is CLEARED the moment the scope changes, so
 *      the screen falls back to its loading state rather than showing one
 *      company's takings under another company's name for the length of a
 *      round trip.
 *
 * Point 2 is the one that is easy to miss: a hook that only aborts still leaves
 * the last render on screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, getScope, type QueryParams } from '../services/api'

export type ComparisonMode = 'none' | 'previous' | 'same_weekday'

export interface DashboardFilters {
  from: string
  to: string
  locationId: number | null
  terminalId: number | null
  sessionId: number | null
  compare: ComparisonMode
}

function today(): string {
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

function readDate(raw: string | null, fallback: string): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback
}

export function useDashboardFilters() {
  const [params, setParams] = useSearchParams()

  const filters = useMemo<DashboardFilters>(() => {
    const from = readDate(params.get('from'), today())
    const compare = params.get('compare')

    return {
      from,
      to: readDate(params.get('to'), from),
      locationId: readInt(params.get('location_id')),
      terminalId: readInt(params.get('terminal_id')),
      sessionId: readInt(params.get('session_id')),
      compare: compare === 'previous' || compare === 'same_weekday' ? compare : 'none',
    }
  }, [params])

  const update = useCallback(
    (patch: Partial<DashboardFilters>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)

          const set = (key: string, value: string | number | null) => {
            if (value === null || value === '' || value === 'none') next.delete(key)
            else next.set(key, String(value))
          }

          if ('from' in patch) set('from', patch.from ?? null)
          if ('to' in patch) set('to', patch.to ?? null)
          if ('locationId' in patch) {
            set('location_id', patch.locationId ?? null)
            // A till belongs to one outlet, so changing the outlet cannot leave
            // the old outlet's till selected.
            next.delete('terminal_id')
          }
          if ('terminalId' in patch) set('terminal_id', patch.terminalId ?? null)
          if ('sessionId' in patch) set('session_id', patch.sessionId ?? null)
          if ('compare' in patch) set('compare', patch.compare ?? null)

          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const query = useMemo<QueryParams>(
    () => ({
      from: filters.from,
      to: filters.to,
      location_id: filters.locationId,
      terminal_id: filters.terminalId,
      session_id: filters.sessionId,
      compare: filters.compare === 'none' ? null : filters.compare,
    }),
    [filters],
  )

  return { filters, update, query }
}

export interface BoardState<T> {
  data: T | null
  loading: boolean
  refreshing: boolean
  error: string | null
  fetchedAt: Date | null
  refresh: () => void
}

/**
 * Fetch one board.
 *
 * `refreshing` is separate from `loading`: a manual refresh must not blank a
 * screen someone is reading, but the first load of a new scope must.
 */
export function useBoard<T>(
  path: string,
  query: QueryParams,
  enabled = true,
  /**
   * Re-fetch on this interval, in milliseconds. 0 is off, which is the default
   * and what four of the five boards want.
   *
   * This reuses the existing fetch rather than adding a second live-data
   * mechanism: there is no socket and no event bus in this product, and
   * introducing one for a single board would leave two ways for the same screen
   * to be wrong. The interval is deliberately slow — a restaurant floor changes
   * over minutes, and a till on shop broadband should not be asked more often
   * than a person would press Refresh.
   */
  refreshMs = 0,
): BoardState<T> {
  const scope = getScope()
  const scopeKey = scope ? `${scope.cmp_id}:${scope.fy_id}:${scope.bo_id}` : 'none'
  const queryKey = JSON.stringify(query)

  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [token, setToken] = useState(0)

  const generation = useRef(0)
  const lastScope = useRef(scopeKey)

  // Clearing happens during render, before the effect runs, so there is no
  // frame in which the previous company's figures are on screen under the new
  // company's name.
  if (lastScope.current !== scopeKey) {
    lastScope.current = scopeKey
    generation.current += 1
    if (data !== null) setData(null)
    if (error !== null) setError(null)
    setFetchedAt(null)
  }

  const refresh = useCallback(() => setToken((n) => n + 1), [])

  useEffect(() => {
    if (!enabled || !scope) {
      setLoading(false)

      return
    }

    const mine = ++generation.current
    const controller = new AbortController()

    if (data === null) setLoading(true)
    else setRefreshing(true)
    setError(null)

    api
      .one<T>(path, query, controller.signal)
      .then((response) => {
        // The generation check is the one that matters: an abort does not stop
        // a promise that has already resolved.
        if (mine !== generation.current) return
        setData(response.data)
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
    // `query` is compared by its serialisation: a fresh object with the same
    // contents must not refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, scopeKey, token, enabled])

  // Polling, paused while the tab is in the background: a screen nobody is
  // looking at does not need a fresher copy, and a till left open overnight
  // should not spend the night asking.
  useEffect(() => {
    if (!enabled || refreshMs <= 0) return

    const tick = () => {
      if (!document.hidden) refresh()
    }

    const id = window.setInterval(tick, refreshMs)
    document.addEventListener('visibilitychange', tick)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [enabled, refreshMs, refresh])

  return { data, loading, refreshing, error, fetchedAt, refresh }
}
