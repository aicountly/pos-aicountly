/**
 * The customer roster: one page of it, from the server.
 *
 * WHY NOT FILTER IN THE BROWSER. Because the roster grows forever. Fetching
 * every customer so JavaScript can match a search box works for the first few
 * hundred and then quietly becomes the slowest thing on the screen. Search,
 * tab, sort and page are all query parameters here, and the browser holds
 * CUSTOMER_PAGE_SIZE rows.
 *
 * WHAT IT BORROWS FROM useBoard. The same two protections, for the same reason:
 * an AbortController plus a generation counter so a response for the previous
 * company or the previous search can never land, and a scope change that clears
 * what is on screen rather than leaving one company's customers under another
 * company's name.
 *
 * WHAT IT ADDS. `stale` — true while a refetch caused by typing is in flight.
 * The rows stay on screen and go quiet rather than being replaced by a skeleton
 * on every keystroke, which is the difference between a list that feels
 * responsive and one that flickers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, getScope, type QueryParams } from '../../services/api'
import type { CustomerDirectoryMeta, CustomerSummary, CustomerTab } from '../types'
import { CUSTOMER_PAGE_SIZE, CUSTOMER_SEARCH_DEBOUNCE_MS } from './constants'

export interface DirectoryRequest {
  tab: CustomerTab
  search: string
  sort: string
  order: 'asc' | 'desc'
  page: number
}

export interface DirectoryState {
  rows: CustomerSummary[]
  meta: CustomerDirectoryMeta | null
  loading: boolean
  stale: boolean
  error: string | null
  refresh: () => void
}

/** A value that only catches up once the typing stops. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    if (value === settled) return
    const timer = window.setTimeout(() => setSettled(value), delay)

    return () => window.clearTimeout(timer)
  }, [value, delay, settled])

  return settled
}

export function useCustomerDirectory(
  base: QueryParams,
  request: DirectoryRequest,
  enabled = true,
): DirectoryState {
  const scope = getScope()
  const scopeKey = scope ? `${scope.cmp_id}:${scope.fy_id}:${scope.bo_id}` : 'none'

  const search = useDebounced(request.search.trim(), CUSTOMER_SEARCH_DEBOUNCE_MS)

  const query = useMemo<QueryParams>(
    () => ({
      ...base,
      tab: request.tab,
      q: search === '' ? null : search,
      sort: request.sort,
      order: request.order,
      limit: CUSTOMER_PAGE_SIZE,
      offset: Math.max(0, request.page - 1) * CUSTOMER_PAGE_SIZE,
    }),
    [base, request.tab, request.sort, request.order, request.page, search],
  )
  const queryKey = JSON.stringify(query)

  const [rows, setRows] = useState<CustomerSummary[]>([])
  const [meta, setMeta] = useState<CustomerDirectoryMeta | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)

  const generation = useRef(0)
  const lastScope = useRef(scopeKey)
  const loaded = useRef(false)

  // During render, before the effect runs — see useBoard. A hook that only
  // aborts still leaves the previous company's rows painted.
  if (lastScope.current !== scopeKey) {
    lastScope.current = scopeKey
    generation.current += 1
    loaded.current = false
    if (rows.length > 0) setRows([])
    if (meta !== null) setMeta(null)
    if (error !== null) setError(null)
  }

  const refresh = useCallback(() => setToken((n) => n + 1), [])

  useEffect(() => {
    if (!enabled || !scope) {
      setLoading(false)

      return
    }

    const mine = ++generation.current
    const controller = new AbortController()

    // Only the very first load of a scope blanks the list. Everything after
    // that — a new tab, a search, a page — dims the rows already there.
    if (loaded.current) setStale(true)
    else setLoading(true)
    setError(null)

    api
      .list<CustomerSummary>('v1/dashboards/customers/directory', query, controller.signal)
      .then((response) => {
        if (mine !== generation.current) return
        setRows(response.data)
        setMeta(response.meta as unknown as CustomerDirectoryMeta)
        loaded.current = true
      })
      .catch((err: Error) => {
        if (mine !== generation.current || controller.signal.aborted) return
        setRows([])
        setMeta(null)
        setError(err.message)
      })
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
        setStale(false)
      })

    return () => controller.abort()
    // `query` is compared by its serialisation: a fresh object with identical
    // contents must not refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, scopeKey, token, enabled])

  return { rows, meta, loading, stale, error, refresh }
}
