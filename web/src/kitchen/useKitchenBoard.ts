/**
 * The board's state, and the only place it changes.
 *
 * One canonical collection of tickets. The four columns, the chip counts and
 * the KPI strip are all derived from it — there is no second list of "ready"
 * tickets that has to be kept in step, because that is the bug this screen
 * would otherwise ship with.
 *
 * REFRESH POLICY. The app has one way of talking to this API and it is polling,
 * so this polls; it does not open a websocket beside it. The cycle is slow
 * enough not to hammer a shop's connection and fast enough that a cook is not
 * looking at a screen from a minute ago, and the ticket clocks tick locally in
 * between so the ageing stays live without a single extra request. A hidden tab
 * does not poll at all: a kitchen screen is left open for twelve hours, and a
 * display nobody is looking at should not keep a cPanel server busy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../services/api'
import { onReconnect } from '../offline/sync'
import type { KotStatus } from '../services/types'
import { advanceTicket, cancelTicket, fetchKitchen, type KitchenSnapshot } from './service'
import { playNewTicketChime } from './sound'
import type { KitchenTicket } from './types'

const POLL_MS = 10_000
/** After this long without an answer the screen says so rather than looking live. */
const STALE_MS = 45_000

export interface BoardOptions {
  locationId: number | null
  stationId: number | null
  servedLimit: number
  autoRefresh: boolean
  /** Chime on arrival. Off unless BOTH the sound switch and the alert are on. */
  alert: boolean
  volume: number
  enabled: boolean
}

export interface BoardApi {
  tickets: KitchenTicket[]
  stations: KitchenSnapshot['stations']
  metrics: KitchenSnapshot['metrics']
  fetchedAt: number
  loading: boolean
  refreshing: boolean
  error: string | null
  /** True when the API answered without the KDS extras — an older server. */
  partial: boolean
  stale: boolean
  online: boolean
  /** Ticket ids with a request in flight, so a button cannot be pressed twice. */
  pending: ReadonlySet<number>
  /** Ticket ids that have just arrived, for the one-shot highlight. */
  arrived: ReadonlySet<number>
  refresh: () => void
  advance: (ticket: KitchenTicket, to: KotStatus) => Promise<string>
  cancel: (ticket: KitchenTicket, reason: string) => Promise<string>
}

export function useKitchenBoard(options: BoardOptions): BoardApi {
  const { locationId, stationId, servedLimit, autoRefresh, alert, volume, enabled } = options

  const [snapshot, setSnapshot] = useState<KitchenSnapshot>({
    tickets: [],
    stations: [],
    metrics: null,
    fetchedAt: 0,
    partial: false,
  })
  const [loading, setLoading] = useState(enabled)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [pending, setPending] = useState<ReadonlySet<number>>(() => new Set())
  const [arrived, setArrived] = useState<ReadonlySet<number>>(() => new Set())

  // Read inside the fetch without making it a dependency: turning the sound
  // down must not cancel an in-flight request and start another.
  const alertRef = useRef({ alert, volume })
  useEffect(() => {
    alertRef.current = { alert, volume }
  }, [alert, volume])

  // The ids we have already seen. Seeded by the FIRST answer rather than
  // starting empty, or opening the screen onto a busy service would chime
  // twenty times and highlight the entire board.
  const seen = useRef<Set<number> | null>(null)
  const arrivalTimers = useRef<number[]>([])
  const inFlight = useRef<AbortController | null>(null)

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller

      if (mode === 'initial') setLoading(true)
      else setRefreshing(true)

      try {
        const next = await fetchKitchen({ locationId, stationId, servedLimit }, controller.signal)
        if (controller.signal.aborted) return

        const known = seen.current
        const live = next.tickets.filter((ticket) => ticket.lane !== 'served')

        if (known === null) {
          seen.current = new Set(live.map((ticket) => ticket.id))
        } else {
          const fresh = live.filter((ticket) => !known.has(ticket.id))
          for (const ticket of live) known.add(ticket.id)

          if (fresh.length > 0) {
            if (alertRef.current.alert) playNewTicketChime(alertRef.current.volume)

            const ids = fresh.map((ticket) => ticket.id)
            setArrived((current) => new Set([...current, ...ids]))
            // The highlight is a nudge, not a state. It clears itself so a
            // ticket nobody touched does not glow for the rest of service.
            const timer = window.setTimeout(() => {
              setArrived((current) => {
                const remaining = new Set(current)
                for (const id of ids) remaining.delete(id)

                return remaining
              })
              // A wall display runs for days; a timer list that only ever grows
              // is a slow leak.
              arrivalTimers.current = arrivalTimers.current.filter((id) => id !== timer)
            }, 8_000)
            arrivalTimers.current.push(timer)
          }
        }

        setSnapshot(next)
        setError(null)
      } catch (e) {
        if (controller.signal.aborted) return
        // 403 is the server refusing this person the kitchen screen, which is
        // not a refresh failure and must not be retried into a loop.
        setError(
          e instanceof ApiError && e.status === 403
            ? 'You do not have permission to work the kitchen screen.'
            : e instanceof Error
              ? e.message
              : 'Kitchen orders could not be refreshed.',
        )
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [locationId, stationId, servedLimit],
  )

  // The outlet or station changed, so the answer in hand is about a different
  // kitchen. Start again rather than showing the old board under a new heading,
  // and forget which tickets were known — every ticket of a station this screen
  // has not been watching is new to it, and chiming for all of them is not.
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    seen.current = null
    void load('initial')
  }, [enabled, load])

  useEffect(() => {
    if (!enabled || !autoRefresh) return

    const id = window.setInterval(() => {
      if (document.hidden || !navigator.onLine) return
      void load('refresh')
    }, POLL_MS)

    return () => window.clearInterval(id)
  }, [enabled, autoRefresh, load])

  // Coming back to the screen, and coming back onto the network, are both
  // moments where what is on the board is provably out of date.
  useEffect(() => {
    if (!enabled) return

    const wake = () => {
      if (!document.hidden) void load('refresh')
    }
    const goOnline = () => {
      setOnline(true)
      void load('refresh')
    }
    const goOffline = () => setOnline(false)

    const stopReconnect = onReconnect(goOnline)
    window.addEventListener('offline', goOffline)
    document.addEventListener('visibilitychange', wake)

    return () => {
      stopReconnect()
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [enabled, load])

  useEffect(
    () => () => {
      inFlight.current?.abort()
      for (const id of arrivalTimers.current) window.clearTimeout(id)
    },
    [],
  )

  /**
   * Refresh without blanking the board.
   *
   * Pressing Refresh, or Retry after a failure, must never replace a screen of
   * live tickets with a skeleton: a kitchen loses its place, and if the retry
   * also fails it has lost the tickets it could still read.
   */
  const refresh = useCallback(() => {
    void load('refresh')
  }, [load])

  const hold = useCallback((id: number, held: boolean) => {
    setPending((current) => {
      const next = new Set(current)
      if (held) next.add(id)
      else next.delete(id)

      return next
    })
  }, [])

  /**
   * Move a ticket along, showing it moved before the server has said so.
   *
   * The optimism is worth it — a cook pressing Start on a hot line should see
   * the card move now — but it is paid for honestly: a failure puts THAT
   * TICKET back exactly as it was and says why. A screen that leaves a ticket
   * in the wrong column after a failed write is worse than one that was slow.
   *
   * One ticket, not the whole collection. Restoring a snapshot captured before
   * the request would also undo any refresh that landed while it was in
   * flight — and a rollback that silently deletes tickets fired in the last
   * ten seconds is a worse bug than the one it is fixing.
   */
  const advance = useCallback(
    async (ticket: KitchenTicket, to: KotStatus): Promise<string> => {
      hold(ticket.id, true)

      setSnapshot((current) => ({
        ...current,
        tickets: current.tickets.map((row) =>
          row.id === ticket.id
            ? {
                ...row,
                status: to,
                lane: to === 'PREPARING' ? 'preparing' : to === 'READY' ? 'ready' : 'served',
                clockStopped: to === 'READY' || to === 'SERVED',
                nextStatus: to === 'PREPARING' ? 'READY' : to === 'READY' ? 'SERVED' : null,
                servedAt: to === 'SERVED' ? new Date().toISOString() : row.servedAt,
              }
            : row,
        ),
      }))

      try {
        const updated = await advanceTicket(ticket.id, to, Date.now())
        setSnapshot((current) => ({
          ...current,
          tickets: current.tickets.map((row) => (row.id === ticket.id ? updated : row)),
        }))
        // The counters beside the board are the server's to recount.
        void load('refresh')

        return `Ticket ${ticket.ticketNo} moved to ${to.toLowerCase()}.`
      } catch (e) {
        setSnapshot((current) => ({
          ...current,
          tickets: current.tickets.map((row) => (row.id === ticket.id ? ticket : row)),
        }))
        throw new Error(
          e instanceof ApiError && e.status === 409
            ? `${e.message} Another screen may have moved it.`
            : e instanceof Error
              ? e.message
              : 'Could not update that ticket. Please retry.',
        )
      } finally {
        hold(ticket.id, false)
      }
    },
    [hold, load],
  )

  const cancel = useCallback(
    async (ticket: KitchenTicket, reason: string): Promise<string> => {
      hold(ticket.id, true)
      try {
        await cancelTicket(ticket.id, reason)
        setSnapshot((current) => ({
          ...current,
          tickets: current.tickets.filter((row) => row.id !== ticket.id),
        }))
        void load('refresh')

        return `Ticket ${ticket.ticketNo} cancelled.`
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : 'Could not cancel that ticket. Please retry.')
      } finally {
        hold(ticket.id, false)
      }
    },
    [hold, load],
  )

  const stale = snapshot.fetchedAt > 0 && Date.now() - snapshot.fetchedAt > STALE_MS

  return useMemo(
    () => ({
      tickets: snapshot.tickets,
      stations: snapshot.stations,
      metrics: snapshot.metrics,
      fetchedAt: snapshot.fetchedAt,
      loading,
      refreshing,
      error,
      partial: snapshot.partial,
      stale,
      online,
      pending,
      arrived,
      refresh,
      advance,
      cancel,
    }),
    [snapshot, loading, refreshing, error, stale, online, pending, arrived, refresh, advance, cancel],
  )
}
