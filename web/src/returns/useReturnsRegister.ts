/**
 * The state behind the Returns workspace: what is being looked at, and the
 * requests that answer it.
 *
 * FILTERS LIVE IN THE URL, for the same reason they do on the dashboards. A
 * supervisor who narrows to last week's exchanges and sends the link has sent
 * what they were looking at, and the back button undoes a filter change rather
 * than leaving the page.
 *
 * ONE FILTER, TWO QUESTIONS. The register asks for a page of rows; the summary
 * asks for the totals. Both are built from the same object here, so the KPIs
 * above the table can never describe a different set of returns from the table
 * itself. The only difference is the tab: a tab narrows the ROWS, and the tab
 * counts come from the summary, so switching tabs never changes the KPIs.
 *
 * STALE DATA IS THE BUG THIS FILE PREVENTS. A company switched while a request
 * is in flight must never paint the old company's returns under the new
 * company's name, so every request is aborted and generation-checked, and what
 * was already on screen is cleared the moment the scope changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getScope, type QueryParams } from '../services/api'
import { PENDING_STATUSES, REFUND_RESOLUTIONS } from './vocabulary'
import type { RegisterTab, ReturnResolution, ReturnStatus } from './types'

const PAGE_SIZE_KEY = 'pos.returns.pageSize'
const PAGE_SIZES = [10, 25, 50, 100]
const DEFAULT_PAGE_SIZE = 25
const DEFAULT_WINDOW_DAYS = 30

export interface ReturnFilters {
  from: string
  to: string
  tab: RegisterTab
  search: string
  statuses: ReturnStatus[]
  resolutions: ReturnResolution[]
  channel: string | null
  reason: string | null
  terminalId: number | null
  minAmount: string
  maxAmount: string
  page: number
  pageSize: number
  sort: string
  order: 'asc' | 'desc'
}

function isoDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

export function today(): string {
  return isoDate(new Date())
}

export function daysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)

  return isoDate(date)
}

function readDate(raw: string | null, fallback: string): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback
}

function readList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return []

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is T => (allowed as readonly string[]).includes(value))
}

function storedPageSize(): number {
  try {
    const raw = Number.parseInt(window.localStorage.getItem(PAGE_SIZE_KEY) ?? '', 10)

    return PAGE_SIZES.includes(raw) ? raw : DEFAULT_PAGE_SIZE
  } catch {
    // Storage can be disabled. The default is not a preference worth an error.
    return DEFAULT_PAGE_SIZE
  }
}

const ALL_STATUSES: ReturnStatus[] = ['DRAFT', 'APPROVED', 'RECEIVED', 'SETTLED', 'CANCELLED']
const ALL_RESOLUTIONS: ReturnResolution[] = [
  'refund_cash',
  'refund_original',
  'credit_note',
  'store_credit',
  'exchange',
]
const TABS: RegisterTab[] = ['all', 'refunds', 'exchanges', 'pending']

export { PAGE_SIZES }

/**
 * Read the filters out of the URL, and write them back.
 *
 * Everything except the page number resets paging: a filter change that left
 * you on page 7 of a 2-page result shows an empty table and looks broken.
 */
export function useReturnFilters() {
  const [params, setParams] = useSearchParams()

  const filters = useMemo<ReturnFilters>(() => {
    const from = readDate(params.get('from'), daysAgo(DEFAULT_WINDOW_DAYS - 1))
    const tab = params.get('tab')
    const order = params.get('order')
    const size = Number.parseInt(params.get('size') ?? '', 10)
    const page = Number.parseInt(params.get('page') ?? '', 10)
    const terminal = Number.parseInt(params.get('terminal_id') ?? '', 10)

    return {
      from,
      to: readDate(params.get('to'), today()),
      tab: TABS.includes(tab as RegisterTab) ? (tab as RegisterTab) : 'all',
      search: params.get('q') ?? '',
      statuses: readList(params.get('status'), ALL_STATUSES),
      resolutions: readList(params.get('resolution'), ALL_RESOLUTIONS),
      channel: params.get('channel'),
      reason: params.get('reason'),
      terminalId: Number.isFinite(terminal) && terminal > 0 ? terminal : null,
      minAmount: params.get('min') ?? '',
      maxAmount: params.get('max') ?? '',
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: PAGE_SIZES.includes(size) ? size : storedPageSize(),
      sort: params.get('sort') ?? 'return_date',
      order: order === 'asc' ? 'asc' : 'desc',
    }
  }, [params])

  const update = useCallback(
    (patch: Partial<ReturnFilters>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)

          const set = (key: string, value: string | number | null | undefined) => {
            if (value === null || value === undefined || value === '') next.delete(key)
            else next.set(key, String(value))
          }

          if ('from' in patch) set('from', patch.from)
          if ('to' in patch) set('to', patch.to)
          if ('search' in patch) set('q', patch.search)
          if ('channel' in patch) set('channel', patch.channel)
          if ('reason' in patch) set('reason', patch.reason)
          if ('terminalId' in patch) set('terminal_id', patch.terminalId)
          if ('minAmount' in patch) set('min', patch.minAmount)
          if ('maxAmount' in patch) set('max', patch.maxAmount)
          if ('sort' in patch) set('sort', patch.sort)
          if ('order' in patch) set('order', patch.order)
          if ('statuses' in patch) set('status', (patch.statuses ?? []).join(','))
          if ('resolutions' in patch) set('resolution', (patch.resolutions ?? []).join(','))

          // A tab and an explicit type filter are the same question asked twice,
          // and answering both would show an empty table nobody asked for. The
          // last one touched wins, and the other is cleared.
          if ('tab' in patch) {
            set('tab', patch.tab === 'all' ? null : patch.tab)
            next.delete('resolution')
            next.delete('status')
          } else if ('resolutions' in patch || 'statuses' in patch) {
            next.delete('tab')
          }

          if ('pageSize' in patch && patch.pageSize) {
            set('size', patch.pageSize)
            try {
              window.localStorage.setItem(PAGE_SIZE_KEY, String(patch.pageSize))
            } catch {
              // A browser with storage off still works; it just forgets.
            }
          }

          if ('page' in patch) set('page', patch.page && patch.page > 1 ? patch.page : null)
          else next.delete('page')

          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const clearAll = useCallback(() => {
    update({
      statuses: [],
      resolutions: [],
      channel: null,
      reason: null,
      terminalId: null,
      minAmount: '',
      maxAmount: '',
    })
  }, [update])

  /** How many filters the Filter button should own up to carrying. */
  const activeCount = useMemo(() => {
    let count = 0
    if (filters.statuses.length > 0) count += 1
    if (filters.resolutions.length > 0) count += 1
    if (filters.channel) count += 1
    if (filters.reason) count += 1
    if (filters.terminalId) count += 1
    if (filters.minAmount !== '' || filters.maxAmount !== '') count += 1

    return count
  }, [filters])

  /** What every query on the screen shares: the window and the narrowing. */
  const baseQuery = useMemo<QueryParams>(
    () => ({
      from: filters.from,
      to: filters.to,
      q: filters.search.trim() || null,
      status: filters.statuses.join(',') || null,
      resolution: filters.resolutions.join(',') || null,
      channel: filters.channel,
      reason_code: filters.reason,
      terminal_id: filters.terminalId,
      min_amount: filters.minAmount || null,
      max_amount: filters.maxAmount || null,
    }),
    [filters],
  )

  /** The register's own query: the base, narrowed by the tab, paged and sorted. */
  const listQuery = useMemo<QueryParams>(() => {
    const query: QueryParams = {
      ...baseQuery,
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize,
      sort: filters.sort,
      order: filters.order,
    }

    if (filters.resolutions.length === 0) {
      if (filters.tab === 'refunds') query.resolution = REFUND_RESOLUTIONS.join(',')
      if (filters.tab === 'exchanges') query.resolution = 'exchange'
    }
    if (filters.statuses.length === 0 && filters.tab === 'pending') {
      query.status = PENDING_STATUSES.join(',')
    }

    return query
  }, [baseQuery, filters])

  return { filters, update, clearAll, activeCount, baseQuery, listQuery }
}

export interface Resource<T> {
  data: T | null
  loading: boolean
  refreshing: boolean
  error: string | null
  fetchedAt: Date | null
  refresh: () => void
}

/**
 * Fetch one thing, and never let a stale answer land.
 *
 * `loading` blanks the screen; `refreshing` does not. A first load of a new
 * filter should show skeletons, but a poll or a manual refresh must not pull
 * the table out from under someone mid-read.
 */
export function useReturnsResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
): Resource<T> {
  const scope = getScope()
  const scopeKey = scope ? `${scope.cmp_id}:${scope.fy_id}:${scope.bo_id}` : 'none'

  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [token, setToken] = useState(0)

  const generation = useRef(0)
  const lastScope = useRef(scopeKey)
  const loader = useRef(load)
  loader.current = load

  // Cleared during render, before the effect runs, so there is no frame in
  // which one company's returns sit under another company's name.
  if (lastScope.current !== scopeKey) {
    lastScope.current = scopeKey
    generation.current += 1
    if (data !== null) setData(null)
    if (error !== null) setError(null)
    setFetchedAt(null)
  }

  const refresh = useCallback(() => setToken((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)

      return
    }

    const mine = ++generation.current
    const controller = new AbortController()

    setLoading((current) => current || data === null)
    if (data !== null) setRefreshing(true)
    setError(null)

    loader
      .current(controller.signal)
      .then((result) => {
        // The generation check is the one that matters: aborting does not stop
        // a promise that has already resolved.
        if (mine !== generation.current) return
        setData(result)
        setFetchedAt(new Date())
      })
      .catch((failure: Error) => {
        if (mine !== generation.current || controller.signal.aborted) return
        setData(null)
        setError(failure.message)
      })
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
        setRefreshing(false)
      })

    return () => controller.abort()
    // `data` is deliberately not a dependency: it is read to decide between
    // blanking and refreshing, and depending on it would refetch on every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scopeKey, token, enabled])

  return { data, loading, refreshing, error, fetchedAt, refresh }
}
