/**
 * Everything the home screen shows, composed from endpoints that already exist.
 *
 * NOTHING NEW WAS ADDED TO THE API FOR THIS PAGE. The five dashboards already
 * compute these figures from POS' own rows; this screen asks the same two
 * boards and joins them to the session, the till's shift and the device's
 * outbox. That is deliberate — a home screen with its own summary table would
 * be a second definition of "today's takings" to keep in step with the first.
 *
 * WHAT IS ASKED, AND WHY EACH ONE:
 *   v1/dashboards/overview  reports.view        takings, comparison, hourly
 *                                               series, top items, outlets,
 *                                               rule-based alerts
 *   v1/dashboards/retail    reports.view | sell counters and their shifts,
 *                                               held bills, configured devices
 *   v1/shifts/current       —                   is THIS browser's till open
 *   v1/returns              return.create       returns nobody has settled
 *   (IndexedDB)             —                   sales this device still holds
 *
 * A person without a permission is not shown a zero. The board is not asked,
 * and the widget says the figure is not theirs to see.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePos } from '../context/PosContext'
import { api, getScope } from '../services/api'
import type { PosReturn, RegisterSession } from '../services/types'
import type { OverviewBoard, RetailBoard } from '../dashboards/types'
import { compare } from '../dashboards/format'
import { useApi } from '../hooks/useApi'
import { useBoard } from '../dashboards/useDashboard'
import { outboxPending } from '../offline/db'
import { drainOutbox } from '../offline/sync'
import {
  buildHealth,
  buildOutlets,
  buildShifts,
  buildSuggestions,
  heroKind,
  isoDate,
  type HeroKind,
  type HealthRow,
  type OutletRow,
  type ShiftRow,
  type Suggestion,
  type Tone,
} from './model'

export interface KpiFigures {
  sales: number | null
  orders: number | null
  averageBill: number | null
  activeShifts: number | null
  pendingReturns: number | null
  salesChange: { label: string; direction: 'up' | 'down' | 'flat' } | null
  ordersChange: { label: string; direction: 'up' | 'down' | 'flat' } | null
  averageChange: { label: string; direction: 'up' | 'down' | 'flat' } | null
  /** Where the takings came from — the two boards scope their rows differently. */
  basis: 'company' | 'own-counters' | null
}

export interface HomeModel {
  ready: boolean
  loading: boolean
  greetingName: string
  hero: HeroKind
  shift: RegisterSession | null
  shiftLoading: boolean

  overview: OverviewBoard | null
  overviewLoading: boolean
  overviewError: string | null
  retail: RetailBoard | null
  retailLoading: boolean
  retailError: string | null

  kpis: KpiFigures
  kpisLoading: boolean
  kpisRestricted: boolean
  canReturns: boolean
  returnsLoading: boolean
  returnsError: string | null

  health: { rows: HealthRow[]; attention: number; summary: { label: string; tone: Tone } }
  suggestions: Suggestion[]
  outlets: OutletRow[]
  shifts: ShiftRow[]

  connection: { online: boolean; queued: number; syncing: boolean; sync: () => Promise<void> }
  fetchedAt: Date | null
  refresh: () => void
  can: (permission: string) => boolean
}

export function useHomeData(): HomeModel {
  const { session, terminalId, terminal, can } = usePos()
  const scope = getScope()

  const canReports = can('reports.view')
  const canSell = can('sell')
  const canReturns = can('return.create')

  const today = isoDate(new Date())
  const todayQuery = useMemo(() => ({ from: today, to: today, compare: 'previous' }), [today])

  const overview = useBoard<OverviewBoard>('v1/dashboards/overview', todayQuery, canReports)
  const retail = useBoard<RetailBoard>('v1/dashboards/retail', todayQuery, canReports || canSell)

  // ------------------------------------------------------------------
  // This browser's till
  // ------------------------------------------------------------------

  const shift = useApi<RegisterSession | null>(
    async (signal) => {
      const response = await api.one<{ session: RegisterSession | null }>(
        'v1/shifts/current',
        { terminal_id: terminalId },
        signal,
      )

      return response.data.session
    },
    [terminalId, scope?.cmp_id, scope?.fy_id, scope?.bo_id],
    terminalId !== null,
  )

  // ------------------------------------------------------------------
  // Returns nobody has settled
  //
  // Three counted statuses rather than one: a return that is approved but not
  // yet received is still waiting on a person, and a KPI that only counted
  // DRAFT would read zero in a shop with a queue of them.
  // ------------------------------------------------------------------

  const returns = useApi<number>(
    async (signal) => {
      const counts = await Promise.all(
        (['DRAFT', 'APPROVED', 'RECEIVED'] as const).map((status) =>
          api.list<PosReturn>('v1/returns', { status, limit: 1 }, signal),
        ),
      )

      return counts.reduce((total, response) => total + response.meta.total, 0)
    },
    [scope?.cmp_id, scope?.fy_id, scope?.bo_id],
    canReturns,
  )

  // ------------------------------------------------------------------
  // What this device is still holding
  // ------------------------------------------------------------------

  const [online, setOnline] = useState(() => navigator.onLine)
  const [queued, setQueued] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const readOutbox = useCallback(async () => {
    setQueued((await outboxPending()).length)
  }, [])

  useEffect(() => {
    void readOutbox()

    const goOnline = () => {
      setOnline(true)
      void readOutbox()
    }
    const goOffline = () => setOnline(false)

    // No interval. The header already polls the outbox every few seconds and a
    // second timer on the same store would be two pollers for one number.
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    window.addEventListener('focus', readOutbox)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('focus', readOutbox)
    }
  }, [readOutbox])

  const sync = useCallback(async () => {
    setSyncing(true)
    try {
      await drainOutbox()
    } finally {
      setSyncing(false)
      await readOutbox()
    }
  }, [readOutbox])

  // ------------------------------------------------------------------
  // Derived
  // ------------------------------------------------------------------

  const terminals = useMemo(() => session?.terminals ?? [], [session])
  const locations = useMemo(() => session?.locations ?? [], [session])

  const outletMode = useMemo(() => {
    if (terminal) {
      return locations.find((l) => l.location_id === terminal.location_id)?.pos_mode ?? null
    }

    // With no till chosen, the shop is whatever its outlets are: a company with
    // one restaurant runs kitchen tickets even before a till is picked.
    return locations.some((l) => l.pos_mode !== 'retail') ? locations[0]?.pos_mode ?? null : 'retail'
  }, [terminal, locations])

  const health = useMemo(
    () =>
      buildHealth({
        online,
        syncing,
        queuedLocal: queued,
        pendingServer: overview.data?.attention.offline_pending ?? null,
        lastSyncedAt: overview.fetchedAt ?? retail.fetchedAt,
        terminal,
        devices: retail.data?.devices ?? null,
        outletMode,
      }),
    [online, syncing, queued, overview.data, overview.fetchedAt, retail.data, retail.fetchedAt, terminal, outletMode],
  )

  const kpis = useMemo<KpiFigures>(() => {
    const board = overview.data
    const counters = retail.data

    const activeShifts = board
      ? board.sales.open_shifts
      : counters
        ? counters.counters.filter((counter) => counter.shift !== null).length
        : null

    if (board) {
      const previous = board.comparison
      // The board's own label is "vs the day before", which is three words
      // more than a KPI card has room for. The window is today against the day
      // before it, so this says the same thing in one word.
      const label = 'vs yesterday'

      return {
        sales: board.sales.net,
        orders: board.sales.bills,
        averageBill: board.sales.average_bill,
        activeShifts,
        pendingReturns: returns.data,
        salesChange: previous ? compare(board.sales.net, previous.net, label) : null,
        ordersChange: previous ? compare(board.sales.bills, previous.bills, label) : null,
        averageChange: previous ? compare(board.sales.average_bill, previous.average_bill, label) : null,
        basis: 'company',
      }
    }

    if (counters) {
      // A cashier's board is scoped to their own counters, so the figures are
      // theirs rather than the shop's, and the card says which.
      const bills = counters.kpis.bills

      return {
        sales: counters.kpis.net,
        orders: bills,
        averageBill: bills > 0 ? counters.kpis.net / bills : 0,
        activeShifts,
        pendingReturns: returns.data,
        salesChange: null,
        ordersChange: null,
        averageChange: null,
        basis: 'own-counters',
      }
    }

    return {
      sales: null,
      orders: null,
      averageBill: null,
      activeShifts,
      pendingReturns: returns.data,
      salesChange: null,
      ordersChange: null,
      averageChange: null,
      basis: null,
    }
  }, [overview.data, retail.data, returns.data])

  const printerConfigured = useMemo<boolean | null>(() => {
    if (terminal) return Boolean(terminal.receipt_printer)
    const devices = retail.data?.devices
    if (!devices || devices.terminals.length === 0) return null

    return devices.terminals.some((t) =>
      t.peripherals.some((p) => p.kind === 'receipt_printer' && p.state === 'configured'),
    )
  }, [terminal, retail.data])

  const suggestions = useMemo(
    () =>
      buildSuggestions({
        serverInsights: overview.data?.insights.items ?? null,
        tillsExist: terminals.length > 0,
        outletsExist: locations.length > 0,
        shiftOpen: shift.data !== null && shift.data.status === 'OPEN',
        queuedLocal: queued,
        pendingServer: overview.data?.attention.offline_pending ?? null,
        pendingReturns: returns.data,
        heldBills: retail.data?.kpis.held_bills ?? 0,
        heldValue: retail.data?.kpis.held_value ?? 0,
        printerConfigured,
        can,
      }),
    [overview.data, retail.data, terminals, locations, shift.data, queued, returns.data, printerConfigured, can],
  )

  const outlets = useMemo(
    () => buildOutlets(locations, terminals, overview.data),
    [locations, terminals, overview.data],
  )

  const shifts = useMemo(
    () => buildShifts(retail.data, session?.user.uuid ?? null, session?.user.display_name ?? null),
    [retail.data, session],
  )

  // Destructured, because the state objects are new every render and a refresh
  // callback that changes identity every render re-renders every widget it is
  // handed to.
  const refreshOverview = overview.refresh
  const refreshRetail = retail.refresh
  const reloadShift = shift.reload
  const reloadReturns = returns.reload

  const refresh = useCallback(() => {
    refreshOverview()
    refreshRetail()
    reloadShift()
    reloadReturns()
    void readOutbox()
  }, [refreshOverview, refreshRetail, reloadShift, reloadReturns, readOutbox])

  return {
    ready: session !== null,
    loading: session === null,
    greetingName: firstName(session?.user.display_name ?? null),
    hero: heroKind({ terminals, terminalId, shift: shift.data }),
    shift: shift.data,
    shiftLoading: shift.loading,

    overview: overview.data,
    overviewLoading: overview.loading,
    overviewError: overview.error,
    retail: retail.data,
    retailLoading: retail.loading,
    retailError: retail.error,

    kpis,
    kpisLoading: (canReports && overview.loading) || (!canReports && (canSell ? retail.loading : false)),
    kpisRestricted: !canReports && !canSell,
    canReturns,
    returnsLoading: returns.loading,
    returnsError: returns.error,

    health,
    suggestions,
    outlets,
    shifts,

    connection: { online, queued, syncing, sync },
    fetchedAt: overview.fetchedAt ?? retail.fetchedAt,
    refresh,
    can,
  }
}

/** "Priya" out of "Priya Menon" — a greeting uses the name someone is called. */
function firstName(displayName: string | null): string {
  if (!displayName) return 'there'
  const first = displayName.trim().split(/\s+/)[0]

  return first === '' ? 'there' : first
}
