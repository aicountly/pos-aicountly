/**
 * The kitchen display.
 *
 * Deliberately large and deliberately plain: this screen is read across a hot
 * room by someone holding a pan, and a ticket that cannot be read at three
 * metres is a ticket that gets cooked wrong. Tickets are oldest first, because
 * a kitchen works a queue, and a late ticket is marked against ITS OWN
 * station's threshold — a bar ticket is late after four minutes and a tandoor
 * ticket is not.
 *
 * WHAT THIS FILE DOES. It holds the screen's state — the filters, the
 * preferences, the drawers — and composes the parts. It does not talk to the
 * API: that is `kitchen/service.ts`, and it is the only thing that does. It
 * does not work out counts or ageing: that is `kitchen/derive.ts`, which is
 * pure and testable. One canonical collection of tickets lives in
 * `useKitchenBoard`, and every column, count and chip on this page is derived
 * from it, because two lists that are supposed to agree eventually do not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CloudOff, TriangleAlert } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { Unavailable } from '../dashboards/shell'
import { CancelTicketDialog } from '../kitchen/components/CancelTicketDialog'
import { KitchenBoard, KitchenColumn } from '../kitchen/components/KitchenBoard'
import { KitchenEmptyState } from '../kitchen/components/KitchenEmptyState'
import { KitchenHeader } from '../kitchen/components/KitchenHeader'
import { KitchenHealthBar } from '../kitchen/components/KitchenHealthBar'
import { KitchenHistoryDrawer } from '../kitchen/components/KitchenHistoryDrawer'
import { KitchenMetrics } from '../kitchen/components/KitchenMetrics'
import { KitchenSettingsDrawer } from '../kitchen/components/KitchenSettingsDrawer'
import { StationLoad, KitchenToolbar } from '../kitchen/components/KitchenToolbar'
import { Toasts, type Toast } from '../kitchen/components/Toasts'
import {
  applyFilters,
  groupByLane,
  kitchenHealth,
  laneCounts,
  minutesLabel,
  nearingSlaCount,
} from '../kitchen/derive'
import { useKitchenPreferences } from '../kitchen/preferences'
import { useFullscreen } from '../kitchen/useFullscreen'
import { useKitchenBoard } from '../kitchen/useKitchenBoard'
import { useKitchenShortcuts } from '../kitchen/useKitchenShortcuts'
import { useNow } from '../kitchen/useNow'
import type { KitchenFilters, KitchenTicket, Lane, StatusFilter } from '../kitchen/types'
import type { KotStatus } from '../services/types'
import '../kitchen/kitchen.css'

/** Which columns a chip leaves standing. "All" is the four-lane board. */
const LANES_FOR: Record<StatusFilter, Lane[]> = {
  all: ['new', 'preparing', 'ready', 'served'],
  new: ['new'],
  preparing: ['preparing'],
  ready: ['ready'],
  served: ['served'],
  delayed: ['new', 'preparing', 'ready'],
}

function BoardSkeleton() {
  return (
    <div className="kds-board" aria-busy="true" aria-label="Loading tickets">
      {(['new', 'preparing', 'ready', 'served'] as Lane[]).map((lane) => (
        <section key={lane} className={`kds-col kds-col--${lane}`}>
          <header className="kds-col__head">
            <span className="kds-skeleton" style={{ width: 130, height: 16 }} />
            <span className="kds-skeleton" style={{ width: 28, height: 28, borderRadius: 999 }} />
          </header>
          <div className="kds-col__body">
            {[0, 1].map((n) => (
              <div key={n} className="kds-ticket">
                <span className="kds-skeleton" style={{ width: '55%', height: 17 }} />
                <span className="kds-skeleton" style={{ width: '40%', height: 11 }} />
                <span className="kds-skeleton" style={{ width: '100%', height: 13 }} />
                <span className="kds-skeleton" style={{ width: '82%', height: 13 }} />
                <span className="kds-skeleton" style={{ width: '100%', height: 40, borderRadius: 10 }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function Kitchen() {
  const { session, can } = usePos()
  const page = useRef<HTMLElement>(null)

  const { preferences, update, reset } = useKitchenPreferences()
  const { fullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen(page)

  const canOperate = can('kds.operate')
  const canCancel = can('kot.cancel')

  const [filters, setFilters] = useState<KitchenFilters>(() => ({
    status: 'all',
    locationId: null,
    stationId: preferences.defaultStationId,
    orderKind: 'all',
    search: '',
  }))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [cancelling, setCancelling] = useState<KitchenTicket | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const nowMs = useNow()

  const board = useKitchenBoard({
    locationId: filters.locationId,
    stationId: filters.stationId,
    // More than the column shows, so "View all" opens on something already in
    // hand rather than firing a second request at a busy kitchen.
    servedLimit: Math.max(preferences.servedCount, 20),
    autoRefresh: preferences.autoRefresh,
    alert: preferences.sound && preferences.newOrderAlert,
    volume: preferences.volume,
    enabled: canOperate,
  })

  const toastTimers = useRef<number[]>([])

  const say = useCallback((message: string, tone: Toast['tone']) => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, tone, message }])
    toastTimers.current.push(
      window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4_500),
    )
  }, [])

  useEffect(() => () => toastTimers.current.forEach((id) => window.clearTimeout(id)), [])

  const change = useCallback((patch: Partial<KitchenFilters>) => setFilters((current) => ({ ...current, ...patch })), [])

  useKitchenShortcuts(useCallback((status: StatusFilter) => setFilters((current) => ({ ...current, status })), []))

  /**
   * A preference change that the board has to follow.
   *
   * Choosing the station this screen opens on should move it there now, not on
   * the next reload: on a display fixed above the tandoor, the setting and the
   * board disagreeing is the setting looking broken.
   */
  const changePreference = useCallback(
    (patch: Parameters<typeof update>[0]) => {
      update(patch)
      if ('defaultStationId' in patch) change({ stationId: patch.defaultStationId ?? null })
    },
    [update, change],
  )

  const toggleSound = useCallback(() => update({ sound: !preferences.sound }), [update, preferences.sound])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openHistory = useCallback(() => setHistoryOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeHistory = useCallback(() => setHistoryOpen(false), [])
  const closeCancel = useCallback(() => setCancelling(null), [])

  const advance = useCallback(
    (ticket: KitchenTicket, to: KotStatus) => {
      void board
        .advance(ticket, to)
        .then((message) => say(message, 'ok'))
        .catch((error: Error) => say(error.message, 'bad'))
    },
    [board, say],
  )

  const confirmCancel = useCallback(
    (reason: string) => {
      const ticket = cancelling
      if (!ticket) return

      void board
        .cancel(ticket, reason)
        .then((message) => {
          setCancelling(null)
          say(message, 'ok')
        })
        .catch((error: Error) => say(error.message, 'bad'))
    },
    [board, cancelling, say],
  )

  // ---------------------------------------------------------------------
  // Everything below is derived. One list in, four columns out.
  // ---------------------------------------------------------------------

  const warnPc = preferences.slaWarnPc

  const counts = useMemo(
    () => laneCounts(board.tickets, nowMs, board.fetchedAt, warnPc),
    [board.tickets, board.fetchedAt, nowMs, warnPc],
  )

  const visible = useMemo(
    () => applyFilters(board.tickets, filters, nowMs, board.fetchedAt, warnPc),
    [board.tickets, filters, nowMs, board.fetchedAt, warnPc],
  )

  const groups = useMemo(
    () => groupByLane(visible, preferences.servedCount),
    [visible, preferences.servedCount],
  )

  const nearing = useMemo(
    () => nearingSlaCount(board.tickets, nowMs, board.fetchedAt, warnPc),
    [board.tickets, nowMs, board.fetchedAt, warnPc],
  )

  const health = useMemo(() => kitchenHealth(counts, nearing), [counts, nearing])

  const servedTickets = useMemo(
    () =>
      board.tickets
        .filter((ticket) => ticket.lane === 'served')
        .sort((a, b) => new Date(b.servedAt ?? b.firedAt).getTime() - new Date(a.servedAt ?? a.firedAt).getTime()),
    [board.tickets],
  )

  const lanes = useMemo(() => {
    const base = LANES_FOR[filters.status]

    return preferences.showServed ? base : base.filter((lane) => lane !== 'served')
  }, [filters.status, preferences.showServed])

  const outlets = useMemo(() => session?.locations ?? [], [session])

  const context = useMemo(() => {
    const parts: string[] = []
    const outlet = outlets.find((location) => location.location_id === filters.locationId)
    parts.push(outlet ? (outlet.display_name ?? outlet.location_code) : 'All outlets')

    const station = board.stations.find((row) => row.station_id === filters.stationId)
    parts.push(station ? station.station_name : 'All stations')

    if (board.fetchedAt > 0) {
      const ago = Math.max(0, Math.round((nowMs - board.fetchedAt) / 1000))
      parts.push(ago < 60 ? 'Synced just now' : `Synced ${minutesLabel(ago)} ago`)
    }

    return parts
  }, [outlets, filters.locationId, filters.stationId, board.stations, board.fetchedAt, nowMs])

  const lastServedSecondsAgo = useMemo(() => {
    const latest = servedTickets[0]
    if (!latest?.servedAt) return null
    const at = new Date(latest.servedAt).getTime()
    if (Number.isNaN(at)) return null

    return Math.max(0, Math.round((nowMs - at) / 1000))
  }, [servedTickets, nowMs])

  // "Nothing waiting" is only ever shown when the request SUCCEEDED and there
  // was nothing. A failed refresh keeps whatever is on screen — a kitchen
  // losing its tickets because a cPanel server hiccuped is the worst outcome on
  // this page, and "we could not ask" must never render as "all clear".
  const answered = !board.loading && !board.error
  const kitchenClear = answered && counts.active === 0
  // A clear queue is not an empty screen: the served column stays beside it.
  const keepServed = kitchenClear && preferences.showServed && groups.served.length > 0
  const nothingMatches = answered && !kitchenClear && visible.length === 0

  if (!canOperate) {
    return (
      <main className="pos-workspace">
        <Unavailable title="The kitchen screen is not yours to work">
          Working kitchen tickets needs the <strong>kds.operate</strong> permission, which this role does not carry.
          Ask whoever manages POS roles for your company if that is wrong.
        </Unavailable>
      </main>
    )
  }

  return (
    <main
      className={`pos-workspace kds${preferences.density === 'compact' ? ' kds--compact' : ''}`}
      ref={page}
      aria-label="Kitchen display"
    >
      <KitchenHeader
        context={context}
        soundOn={preferences.sound}
        onToggleSound={toggleSound}
        fullscreen={fullscreen}
        fullscreenSupported={fullscreenSupported}
        onToggleFullscreen={toggleFullscreen}
        onOpenSettings={openSettings}
        onRefresh={board.refresh}
        refreshing={board.refreshing}
      />

      <KitchenMetrics
        active={counts.active}
        preparing={counts.preparing}
        ready={counts.ready}
        delayed={counts.delayed}
        metrics={board.metrics}
        loading={board.loading}
      />

      {!board.online && (
        <p className="kds-notice kds-notice--warning">
          <span className="kds-notice__body">
            <CloudOff size={15} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />
            <strong>Offline — kitchen updates may be delayed.</strong>
            These tickets are the last the screen received. Nothing has been lost, and advancing one will wait for the
            connection rather than being dropped.
          </span>
        </p>
      )}

      {board.error && (
        <p className="kds-notice kds-notice--danger" role="alert">
          <span className="kds-notice__body">
            <strong>Kitchen orders could not be refreshed.</strong>
            {board.error}
            {board.tickets.length > 0 && ' The tickets below are the last ones received.'}
          </span>
          <span className="kds-notice__actions">
            <button type="button" className="kds-btn" onClick={board.refresh}>
              Retry
            </button>
          </span>
        </p>
      )}

      {!board.error && board.stale && board.online && (
        <p className="kds-notice kds-notice--warning">
          <span className="kds-notice__body">
            <TriangleAlert size={15} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />
            <strong>This board has not refreshed recently.</strong>
            The ticket clocks are still running locally, but what is on screen may be out of date.
          </span>
          <span className="kds-notice__actions">
            <button type="button" className="kds-btn" onClick={board.refresh}>
              Refresh now
            </button>
          </span>
        </p>
      )}

      {board.partial && !board.loading && (
        <p className="kds-notice kds-notice--info">
          <span className="kds-notice__body">
            <strong>This API build does not report kitchen performance.</strong>
            The board and its counts are live; today’s average prep time and on-time figure read as unavailable rather
            than being guessed from the tickets on screen.
          </span>
        </p>
      )}

      <KitchenToolbar
        filters={filters}
        counts={counts}
        outlets={outlets}
        stations={board.stations}
        onChange={change}
      />

      <StationLoad
        stations={board.stations}
        activeStationId={filters.stationId}
        onSelect={(stationId) => change({ stationId })}
      />

      {board.loading ? (
        <BoardSkeleton />
      ) : board.error && board.tickets.length === 0 ? null : kitchenClear ? (
        <div className={keepServed ? 'kds-board kds-board--idle' : undefined}>
          <KitchenEmptyState
            stationsUp={board.stations.length > 0}
            stationCount={board.stations.length}
            lastServedSecondsAgo={lastServedSecondsAgo}
          />
          {keepServed && (
            <KitchenColumn
              lane="served"
              tickets={groups.served}
              nowMs={nowMs}
              fetchedAt={board.fetchedAt}
              warnPc={warnPc}
              pending={board.pending}
              arrived={board.arrived}
              canOperate={canOperate}
              canCancel={canCancel}
              onAdvance={advance}
              onCancel={setCancelling}
              onOpenHistory={openHistory}
              servedTotal={servedTickets.length}
            />
          )}
        </div>
      ) : nothingMatches ? (
        <div className="kds-empty">
          <h2>No ticket matches this filter</h2>
          <p>
            {counts.active} ticket{counts.active === 1 ? ' is' : 's are'} live. Clear the search, or press{' '}
            <strong>A</strong> for the whole board.
          </p>
          <div className="kds-empty__checks" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="kds-btn"
              onClick={() => change({ status: 'all', orderKind: 'all', search: '' })}
            >
              Show every ticket
            </button>
          </div>
        </div>
      ) : (
        <KitchenBoard
          groups={groups}
          lanes={lanes}
          nowMs={nowMs}
          fetchedAt={board.fetchedAt}
          warnPc={warnPc}
          pending={board.pending}
          arrived={board.arrived}
          canOperate={canOperate}
          canCancel={canCancel}
          onAdvance={advance}
          onCancel={setCancelling}
          onOpenHistory={openHistory}
          servedTotal={servedTickets.length}
        />
      )}

      <KitchenHealthBar health={health} reportHref={can('reports.view') ? '/restaurant' : null} />

      {settingsOpen && (
        <KitchenSettingsDrawer
          preferences={preferences}
          stations={board.stations}
          soundSupported={typeof window !== 'undefined' && 'AudioContext' in window}
          onChange={changePreference}
          onReset={reset}
          onClose={closeSettings}
        />
      )}

      {historyOpen && <KitchenHistoryDrawer tickets={servedTickets} onClose={closeHistory} />}

      {cancelling && (
        <CancelTicketDialog
          ticket={cancelling}
          busy={board.pending.has(cancelling.id)}
          onConfirm={confirmCancel}
          onClose={closeCancel}
        />
      )}

      <Toasts toasts={toasts} />
    </main>
  )
}
