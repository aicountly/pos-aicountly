/**
 * Everything the Offline Queue screen knows, in one place.
 *
 * It reads THREE things and merges them:
 *
 *   the device outbox     IndexedDB, this browser, sales not yet acknowledged
 *   the server queue      what arrived and has not posted
 *   the server's posted   today's acknowledgements, so the screen can show that
 *                         the day actually balanced rather than only what broke
 *
 * The device is read first and never blocks on the network: a till with no
 * connection must still be able to see what it is holding. The server calls are
 * allowed to fail, and their failure is reported as its own thing rather than
 * emptying the screen — "we could not ask the server" is a different sentence
 * from "there is nothing queued", and confusing them is how a cashier ends up
 * believing a sale vanished.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import type { OfflineSubmission } from '../services/types'
import { outboxAll } from './db'
import { countQueue, toQueueRecords, type QueueCounts, type QueueRecord } from './model'
import { drainOutbox, reconcile, subscribeSync, type SyncOutcome, type SyncProgress } from './sync'
import { readLastSyncAt, writeLastSyncAt } from './preferences'

/** How many settled rows to ask for. Beyond this the day belongs in a report. */
const SERVER_PAGE = 100

export interface OfflineQueueApi {
  records: QueueRecord[]
  counts: QueueCounts
  /** First load only. A refresh must not blank the table under the cashier. */
  loading: boolean
  refreshing: boolean
  /** The device store itself failed. Rare and serious. */
  error: string | null
  /** The server could not be asked. Common, and not the same thing. */
  serverError: string | null
  lastSyncAt: number | null
  lastOfflineAt: number | null
  progress: SyncProgress
  reload: (options?: { quiet?: boolean }) => Promise<void>
  post: (uuids: string[]) => Promise<SyncOutcome>
  retryServer: (submissionId: number) => Promise<void>
  abandonServer: (submissionId: number, note: string) => Promise<void>
}

export function useOfflineQueue(canReadServer: boolean): OfflineQueueApi {
  const [records, setRecords] = useState<QueueRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(readLastSyncAt)
  const [lastOfflineAt, setLastOfflineAt] = useState<number | null>(null)
  const [progress, setProgress] = useState<SyncProgress>({ active: false, done: 0, total: 0, label: '' })

  const alive = useRef(true)
  const loadingRef = useRef(false)
  // Set when a reload is asked for while one is already running. Dropping that
  // request outright is a real bug, not a harmless guard: the first load runs
  // before the session has arrived, so `canReadServer` is still false and only
  // the device side is read. The reload that fires once permissions land is the
  // one that fetches the server's half of the queue — lose it and the screen
  // shows nothing from the server until someone presses Refresh.
  const againRef = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => subscribeSync((state) => alive.current && setProgress(state)), [])

  const reload = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      // Two refreshes at once paint the older answer last, so they are run one
      // at a time — but a request that arrives mid-flight is remembered and run
      // afterwards rather than thrown away.
      if (loadingRef.current) {
        againRef.current = true
        return
      }
      loadingRef.current = true
      if (!options.quiet) setRefreshing(true)

      try {
        // The device first, and on its own, so a dead network cannot stop a
        // till from seeing what it is carrying.
        let local: Awaited<ReturnType<typeof outboxAll>> = []
        try {
          local = await outboxAll()
          setError(null)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'This device could not open its local queue.')
        }

        let server: OfflineSubmission[] = []

        if (canReadServer) {
          try {
            // Two reads: what is stuck, and what settled. The endpoint excludes
            // POSTED unless asked, which is why this is not one call.
            const [stuck, settled] = await Promise.all([
              api.list<OfflineSubmission>('v1/offline/queue', { limit: SERVER_PAGE }),
              api.list<OfflineSubmission>('v1/offline/queue', { limit: SERVER_PAGE, status: 'POSTED' }),
            ])
            server = [...stuck.data, ...settled.data]
            setServerError(null)

            // Settle the two sides before anything is rendered, so the cashier
            // never sees a sale "waiting" that the books already took.
            const settledLocally = await reconcile(server)
            if (settledLocally.posted > 0 || settledLocally.acknowledged > 0) {
              local = await outboxAll()
            }
          } catch (e) {
            setServerError(e instanceof Error ? e.message : 'Could not reach the server to check the queue.')
          }
        } else {
          setServerError(null)
        }

        if (!alive.current) return

        setRecords(toQueueRecords(local, server))

        const queuedTimes = local.map((sale) => sale.queuedAt).filter((t): t is number => Number.isFinite(t))
        setLastOfflineAt(queuedTimes.length > 0 ? Math.max(...queuedTimes) : null)
      } finally {
        loadingRef.current = false
        if (alive.current) {
          setRefreshing(false)
          setLoading(false)
        }

        if (againRef.current && alive.current) {
          againRef.current = false
          void reloadRef.current?.({ quiet: true })
        }
      }
    },
    [canReadServer],
  )

  // The callback has to be able to call the latest version of itself without
  // making itself a dependency of itself.
  const reloadRef = useRef<typeof reload | null>(null)
  reloadRef.current = reload

  useEffect(() => {
    void reload({ quiet: true })
  }, [reload])

  const post = useCallback(
    async (uuids: string[]): Promise<SyncOutcome> => {
      const outcome = await drainOutbox(uuids.length > 0 ? { only: uuids } : {})
      if (outcome.posted > 0) {
        const now = Date.now()
        writeLastSyncAt(now)
        if (alive.current) setLastSyncAt(now)
      }
      await reload({ quiet: true })
      return outcome
    },
    [reload],
  )

  const retryServer = useCallback(
    async (submissionId: number) => {
      await api.post(`v1/offline/${submissionId}/retry`, {})
      const now = Date.now()
      writeLastSyncAt(now)
      if (alive.current) setLastSyncAt(now)
      await reload({ quiet: true })
    },
    [reload],
  )

  const abandonServer = useCallback(
    async (submissionId: number, note: string) => {
      await api.post(`v1/offline/${submissionId}/abandon`, { note })
      await reload({ quiet: true })
    },
    [reload],
  )

  const counts = useMemo(() => countQueue(records), [records])

  return {
    records,
    counts,
    loading,
    refreshing,
    error,
    serverError,
    lastSyncAt,
    lastOfflineAt,
    progress,
    reload,
    post,
    retryServer,
    abandonServer,
  }
}
