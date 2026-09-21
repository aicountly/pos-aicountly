/**
 * The floor, kept current.
 *
 * A restaurant floor changes under you — another waiter seats a table while you
 * are looking at it — so this refreshes on an interval. The interval is behind
 * this hook rather than in the page for one reason: when POS grows a socket or
 * an event stream, THIS is the only file that changes. The page already treats
 * fresh data as something that arrives rather than something it asked for.
 *
 * What it will not do is lie about freshness. A refresh that fails leaves the
 * last good floor on screen and says when it was last true; it never blanks the
 * screen, and it never lets a stale plan pass as a live one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../services/api'
import type { FloorPlanFloor } from '../../services/types'

/** Long enough not to hammer a shared server, short enough to be believed. */
const REFRESH_MS = 10000

/** After this long without a successful read, the timestamp is called out. */
const STALE_AFTER_MS = 45000

export interface FloorPlanState {
  floors: FloorPlanFloor[]
  /** True only for the very first read, when there is nothing to show yet. */
  loading: boolean
  /** True while a background refresh is in flight over data already on screen. */
  refreshing: boolean
  error: string | null
  /** When the floors on screen were last known to be true. */
  updatedAt: Date | null
  stale: boolean
  offline: boolean
  refresh: () => Promise<void>
  /** Drop straight to the server, e.g. right after changing something. */
  reloadNow: () => Promise<void>
}

export function useFloorPlan(locationId: number | null): FloorPlanState {
  const [floors, setFloors] = useState<FloorPlanFloor[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [offline, setOffline] = useState(() => !navigator.onLine)
  const [stale, setStale] = useState(false)

  // A refresh in flight when the component unmounts, or when the location
  // changes, must not set state belonging to a floor nobody is looking at.
  const live = useRef(true)
  const inFlight = useRef(false)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = useCallback(
    async (background: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      if (background) setRefreshing(true)

      try {
        const response = await api.one<{ floors: FloorPlanFloor[] }>(
          'v1/floor-plan',
          locationId ? { location_id: locationId } : undefined,
        )
        if (!live.current) return

        setFloors(response.data.floors)
        setUpdatedAt(new Date())
        setStale(false)
        setError(null)
      } catch (e) {
        if (!live.current) return
        setError(e instanceof Error ? e.message : 'We could not load the floor right now.')
      } finally {
        inFlight.current = false
        if (live.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [locationId],
  )

  const refresh = useCallback(() => load(true), [load])
  const reloadNow = useCallback(() => load(true), [load])

  // First read, and a fresh one whenever the outlet changes.
  useEffect(() => {
    setLoading(true)
    void load(false)
  }, [load])

  // The interval. Paused while the tab is hidden and while the browser says it
  // is offline: a till left open overnight should not spend the night asking.
  useEffect(() => {
    let timer = 0

    const tick = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void load(true)
    }

    const start = () => {
      window.clearInterval(timer)
      timer = window.setInterval(tick, REFRESH_MS)
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        window.clearInterval(timer)
      }
    }

    start()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  // Connection. Coming back online is worth an immediate read rather than
  // waiting out the rest of the interval.
  useEffect(() => {
    const goOnline = () => {
      setOffline(false)
      void load(true)
    }
    const goOffline = () => setOffline(true)

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [load])

  // Age the timestamp on its own clock, so "last updated" goes amber even when
  // nothing is arriving to re-render the page.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setStale(updatedAt !== null && Date.now() - updatedAt.getTime() > STALE_AFTER_MS)
    }, 5000)

    return () => window.clearInterval(timer)
  }, [updatedAt])

  return { floors, loading, refreshing, error, updatedAt, stale, offline, refresh, reloadNow }
}

/**
 * A clock that ticks once a minute, for the elapsed timers on the plan.
 *
 * Separate from the data so that "42m" becomes "43m" without a network call,
 * and so one timer drives every table rather than one per table.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)

    return () => window.clearInterval(timer)
  }, [])

  return now
}
