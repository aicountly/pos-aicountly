/**
 * The floor.
 *
 * This is the operator's picture of the whole restaurant: which rooms are busy,
 * which tables are free, who is sitting where, how long they have been there and
 * what to do next. It replaces a screen that could only list tables and seat
 * them.
 *
 * Three rules shape it.
 *
 *   The server owns the truth. A table's state is whatever the floor plan
 *   endpoint says it is; nothing here marks a table vacant because a dialog
 *   closed, and every change goes through the endpoint that also writes the
 *   audit entry.
 *
 *   Freshness is never implied. The plan refreshes on an interval, says when it
 *   was last true, and says plainly when it is looking at something it cannot
 *   currently confirm.
 *
 *   A floor plan is optional. A counter shop has none and needs none; this
 *   screen invites the setup and blocks nothing on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Building2,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Undo2,
} from 'lucide-react'
import { usePos } from '../context/PosContext'
import { api } from '../services/api'
import type { FloorKind, FloorPlanFloor, TableStatus } from '../services/types'
import { Notice } from '../ui'
import { FloorEmptyState } from './floor/FloorEmptyState'
import { FloorHealth, FloorLegend } from './floor/FloorLegend'
import { FloorMap, neighbourOf, placeTables, pointToPlan, type PlacedTable } from './floor/FloorMap'
import { FloorSummaryCards } from './floor/FloorSummaryCards'
import { FloorZoneRail } from './floor/FloorZoneRail'
import { TableInspector, type InspectorActions } from './floor/TableInspector'
import { TableListView, type ListRow } from './floor/TableListView'
import {
  AddFloorDialog,
  FloorSettingsDialog,
  MergeDialog,
  MoveDialog,
  ReserveDialog,
  SeatDialog,
  ServiceStateDialog,
  TableDialog,
  type NewFloor,
  type TableDraft,
} from './floor/dialogs'
import { ConfirmDialog, OpenPill, ToastStack, useMediaQuery, useToasts } from './floor/parts'
import { printPreBill } from './floor/printBill'
import {
  isOverdue,
  RESERVATION_SOON_MINUTES,
  occupancyOf,
  stamp,
  tableLabel,
  tableMatches,
  zonesOf,
} from './floor/status'
import { useFloorPlan, useMinuteClock } from './floor/useFloorPlan'
import { useLayoutEditor } from './floor/useLayoutEditor'
import './floor/floor.css'

type Dialog =
  | { kind: 'add-floor' }
  | { kind: 'floor-settings' }
  | { kind: 'retire-floor' }
  | { kind: 'add-table' }
  | { kind: 'edit-table'; table: PlacedTable }
  | { kind: 'seat'; table: PlacedTable }
  | { kind: 'move'; table: PlacedTable }
  | { kind: 'merge'; table: PlacedTable }
  | { kind: 'reserve'; table: PlacedTable }
  | { kind: 'cancel-booking'; table: PlacedTable }
  | { kind: 'service'; table: PlacedTable; state: 'CLEANING' | 'OUT_OF_SERVICE' }
  | { kind: 'clear'; table: PlacedTable }
  | { kind: 'discard-layout' }
  | null

const clamp = (value: number) => Math.max(0, Math.min(10000, value))

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function Floor() {
  const { can, terminal, terminalId, session } = usePos()
  const navigate = useNavigate()

  const locationId = terminal?.location_id ?? null
  const plan = useFloorPlan(locationId)
  const now = useMinuteClock()
  const { toasts, push, dismiss } = useToasts()
  const editor = useLayoutEditor()

  const [selectedFloorId, setSelectedFloorId] = useState<number | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null)
  const [zone, setZone] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<TableStatus | null>(null)
  const [query, setQuery] = useState('')
  const [needle, setNeedle] = useState('')
  const [zoom, setZoom] = useState(1)
  const [view, setView] = useState<'live' | 'table'>('live')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)

  // Below this the inspector is a drawer over the plan, so it opens by choosing
  // a table rather than sitting there covering half the room.
  const narrow = useMediaQuery('(max-width: 1100px)')

  const searchRef = useRef<HTMLInputElement | null>(null)
  const planRef = useRef<HTMLDivElement | null>(null)
  const dragFrom = useRef<{ id: number; dx: number; dy: number } | null>(null)

  const permissions = useMemo(
    () => ({
      seat: can('table.open'),
      transfer: can('table.transfer'),
      merge: can('table.merge'),
      manage: can('terminal.manage'),
      sell: can('sell'),
    }),
    [can],
  )

  // Typing filters the plan, but not on every keystroke: a hundred tables
  // re-testing themselves per character is work nobody sees.
  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query), 180)

    return () => window.clearTimeout(timer)
  }, [query])

  // ------------------------------------------------------------------
  // What is on screen
  // ------------------------------------------------------------------

  const floors = plan.floors

  // A selection survives a refresh; it only changes when the floor it named has
  // gone, which is the one case where keeping it would show the wrong room.
  useEffect(() => {
    if (floors.length === 0) return
    if (selectedFloorId !== null && floors.some((floor) => floor.floor_id === selectedFloorId)) return
    setSelectedFloorId(floors[0].floor_id)
  }, [floors, selectedFloorId])

  const floor: FloorPlanFloor | null = useMemo(
    () => floors.find((candidate) => candidate.floor_id === selectedFloorId) ?? floors[0] ?? null,
    [floors, selectedFloorId],
  )

  const placed = useMemo<PlacedTable[]>(
    () => (editor.active ? editor.tables : placeTables(floor?.tables ?? [])),
    [editor.active, editor.tables, floor],
  )

  const zones = useMemo(() => zonesOf(floor?.tables ?? []), [floor])
  const occupancy = useMemo(() => occupancyOf(floor?.tables ?? []), [floor])

  const matches = useCallback(
    (table: PlacedTable): boolean => {
      if (!floor) return false
      if (zone !== null && (table.zone_name?.trim().toLowerCase() ?? '') !== zone) return false
      if (statusFilter !== null && table.status !== statusFilter) return false

      return tableMatches(table, floor, needle)
    },
    [floor, zone, statusFilter, needle],
  )

  // Filtered-out tables are dimmed rather than removed: a waiter narrowing to
  // the bar still needs to see where the bar is in the room.
  const dimmedIds = useMemo(() => {
    const dimmed = new Set<number>()
    for (const table of placed) if (!matches(table)) dimmed.add(table.table_id)

    return dimmed
  }, [placed, matches])

  const visibleTables = useMemo(() => placed.filter((table) => !dimmedIds.has(table.table_id)), [placed, dimmedIds])

  const selected = useMemo(
    () => placed.find((table) => table.table_id === selectedTableId) ?? null,
    [placed, selectedTableId],
  )

  const showInspector = narrow ? inspectorOpen && selected !== null : inspectorOpen

  // The selection is dropped when its table leaves the floor, and kept through
  // every other refresh — including the one that changes its status under you.
  useEffect(() => {
    if (selectedTableId === null) return
    if (placed.some((table) => table.table_id === selectedTableId)) return
    setSelectedTableId(null)
  }, [placed, selectedTableId])

  const listRows = useMemo<ListRow[]>(() => {
    if (!floor) return []

    return placed.filter(matches).map((table) => ({ table, floor }))
  }, [placed, matches, floor])

  const dueSoon = useMemo(
    () =>
      (floor?.tables ?? []).filter((table) => {
        if (!table.reservation) return false
        const minutes = (new Date(table.reservation.reserved_for).getTime() - now) / 60000

        return minutes >= 0 && minutes <= RESERVATION_SOON_MINUTES
      }).length,
    [floor, now],
  )

  const overdue = useMemo(
    () => (floor?.tables ?? []).filter((table) => isOverdue(table, now)).length,
    [floor, now],
  )

  const outletName =
    session?.locations.find((location) => location.location_id === locationId)?.display_name ??
    terminal?.display_name ??
    'This outlet'

  // ------------------------------------------------------------------
  // Doing things
  // ------------------------------------------------------------------

  const run = useCallback(
    async (work: () => Promise<void>, done?: { title: string; detail?: string }) => {
      setBusy(true)
      try {
        await work()
        setDialog(null)
        if (done) push('success', done.title, done.detail)
        await plan.reloadNow()
      } catch (error) {
        push('danger', 'That did not go through', message(error, 'Try it again in a moment.'))
      } finally {
        setBusy(false)
      }
    },
    [plan, push],
  )

  const openOrder = useCallback(
    (table: PlacedTable) => {
      if (!table.cart_id) {
        push('warning', 'No bill on that table yet', 'Add the first item from the till.')
        return
      }
      // The till is where an order is worked on. It opens the table's own bill
      // rather than starting a second one beside it.
      navigate(`/?cart=${table.cart_id}`)
    },
    [navigate, push],
  )

  const actions: InspectorActions = useMemo(
    () => ({
      startOrder: (table) => setDialog({ kind: 'seat', table }),
      viewOrder: openOrder,
      addItems: openOrder,
      printBill: (table) => {
        if (!table.cart_id || !floor) return
        setBusy(true)
        printPreBill(table.cart_id, {
          tableLabel: tableLabel(table),
          floorName: floor.floor_name,
          outletName,
          serverName: table.waiter_name,
          covers: table.covers,
        })
          .then(() => push('success', 'Pre-bill sent to the printer'))
          .catch((error) => push('danger', 'Could not print that bill', message(error, 'The bill could not be read.')))
          .finally(() => setBusy(false))
      },
      clearTable: (table) => setDialog({ kind: 'clear', table }),
      moveTable: (table) => setDialog({ kind: 'move', table }),
      mergeTable: (table) => setDialog({ kind: 'merge', table }),
      reserve: (table) => setDialog({ kind: 'reserve', table }),
      seatReservation: (table) =>
        run(
          async () => {
            await api.post(`v1/reservations/${table.reservation?.reservation_id}/seat`, {
              terminal_id: terminalId,
            })
          },
          { title: 'Guests seated', detail: `${tableLabel(table)} is now occupied.` },
        ),
      cancelReservation: (table) => setDialog({ kind: 'cancel-booking', table }),
      markCleaning: (table) => setDialog({ kind: 'service', table, state: 'CLEANING' }),
      markReady: (table) =>
        run(
          async () => {
            await api.post(`v1/tables/${table.table_id}/service-state`, { service_state: 'READY' })
          },
          { title: 'Table ready', detail: `${tableLabel(table)} is back on the floor.` },
        ),
      takeOutOfService: (table) => setDialog({ kind: 'service', table, state: 'OUT_OF_SERVICE' }),
      editTable: (table) => setDialog({ kind: 'edit-table', table }),
    }),
    [openOrder, run, terminalId, floor, outletName, push],
  )

  /** What Enter does on the selected table: the one thing the floor would do next. */
  const primaryAction = useCallback(() => {
    if (!selected) return
    switch (selected.status) {
      case 'FREE':
        if (permissions.seat) actions.startOrder(selected)
        break
      case 'OCCUPIED':
        if (permissions.sell) actions.viewOrder(selected)
        break
      case 'RESERVED':
        if (permissions.seat) actions.seatReservation(selected)
        break
      case 'CLEANING':
        if (permissions.seat) actions.markReady(selected)
        break
      case 'OUT_OF_SERVICE':
        if (permissions.manage) actions.markReady(selected)
        break
    }
  }, [selected, permissions, actions])

  const select = useCallback((tableId: number) => {
    setSelectedTableId(tableId)
    setInspectorOpen(true)
  }, [])

  // ------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      if (event.key === 'Escape') {
        if (typing) {
          setQuery('')
          searchRef.current?.blur()
        } else if (selectedTableId !== null) {
          setSelectedTableId(null)
        }
        return
      }

      if (typing || dialog) return

      if (event.key === 'Enter' && selectedTableId !== null) {
        event.preventDefault()
        primaryAction()
        return
      }

      const directions: Record<string, 'up' | 'down' | 'left' | 'right'> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      }
      const direction = directions[event.key]
      if (!direction || view !== 'live') return

      // In the editor the arrows nudge the table; on the live plan they walk the
      // selection across the room.
      if (editor.active && selectedTableId !== null) {
        event.preventDefault()
        const table = placed.find((candidate) => candidate.table_id === selectedTableId)
        if (!table) return
        const step = event.shiftKey ? 400 : 100
        editor.moveTo(
          table.table_id,
          clamp(table.x + (direction === 'left' ? -step : direction === 'right' ? step : 0)),
          clamp(table.y + (direction === 'up' ? -step : direction === 'down' ? step : 0)),
        )
        editor.commit()
        return
      }

      const next = neighbourOf(visibleTables.length > 0 ? visibleTables : placed, selectedTableId, direction)
      if (next === null) return
      event.preventDefault()
      select(next)
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-table-id="${next}"]`)?.focus()
      })
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialog, editor, placed, primaryAction, select, selectedTableId, view, visibleTables])

  // ------------------------------------------------------------------
  // Dragging, in the editor only
  // ------------------------------------------------------------------

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, tableId: number) => {
      if (!editor.active || !planRef.current) return
      event.preventDefault()

      const table = editor.tables.find((candidate) => candidate.table_id === tableId)
      if (!table) return

      const point = pointToPlan(planRef.current, event.clientX, event.clientY)
      dragFrom.current = { id: tableId, dx: point.x - table.x, dy: point.y - table.y }
      setDraggingId(tableId)
      select(tableId)
    },
    [editor, select],
  )

  useEffect(() => {
    if (draggingId === null) return

    const onMove = (event: PointerEvent) => {
      const drag = dragFrom.current
      if (!drag || !planRef.current) return
      const point = pointToPlan(planRef.current, event.clientX, event.clientY)
      editor.moveTo(drag.id, clamp(point.x - drag.dx), clamp(point.y - drag.dy))
    }

    const onUp = () => {
      editor.commit()
      dragFrom.current = null
      setDraggingId(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [draggingId, editor])

  // Unsaved arrangement, and a browser about to throw it away.
  useEffect(() => {
    if (!editor.dirty) return

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', warn)

    return () => window.removeEventListener('beforeunload', warn)
  }, [editor.dirty])

  // ------------------------------------------------------------------
  // Floor and layout writes
  // ------------------------------------------------------------------

  const createFloor = (input: NewFloor) =>
    run(async () => {
      const response = await api.post<{ floor_id: number }>('v1/floors', {
        location_id: locationId,
        floor_name: input.floor_name,
        description: input.description || null,
        floor_kind: input.floor_kind,
        zone_name: input.zone_name || null,
        table_count: input.table_count,
        seats: input.seats,
      })
      // The floor just made is the one to be looking at.
      setSelectedFloorId(response.data.floor_id)
      setZone(null)
      setSelectedTableId(null)
    }, { title: 'Floor created', detail: `${input.floor_name} is ready to lay out.` })

  const saveFloor = (input: { floor_name: string; description: string; floor_kind: FloorKind; is_open: boolean }) => {
    if (!floor) return

    return run(
      async () => {
        await api.put(`v1/floors/${floor.floor_id}`, {
          floor_name: input.floor_name,
          description: input.description || null,
          floor_kind: input.floor_kind,
          is_open: input.is_open,
        })
      },
      { title: 'Floor saved' },
    )
  }

  const retireFloor = () => {
    if (!floor) return

    return run(
      async () => {
        await api.del(`v1/floors/${floor.floor_id}`)
        setSelectedFloorId(null)
        setSelectedTableId(null)
      },
      { title: 'Floor retired', detail: 'Its history is kept; it is no longer on the floor screen.' },
    )
  }

  const saveTable = (draft: TableDraft, tableId: number | null) => {
    if (!floor) return

    return run(
      async () => {
        if (tableId === null) {
          await api.post('v1/tables', { floor_id: floor.floor_id, ...draft, table_name: draft.table_name || null })
        } else {
          await api.put(`v1/tables/${tableId}`, { ...draft, table_name: draft.table_name || null })
        }
      },
      { title: tableId === null ? 'Table added' : 'Table saved' },
    )
  }

  const saveLayout = () => {
    if (!floor) return

    return run(
      async () => {
        await api.put(`v1/floors/${floor.floor_id}/layout`, editor.payload())
        editor.cancel()
      },
      { title: 'Layout saved', detail: 'Every till sees the new arrangement on its next refresh.' },
    )
  }

  const leaveEditor = () => {
    if (editor.dirty) setDialog({ kind: 'discard-layout' })
    else editor.cancel()
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (plan.loading) return <FloorSkeleton />

  if (floors.length === 0) {
    return (
      <div className="pos-workspace floor-screen">
        <PageHeader
          canManage={permissions.manage}
          hasFloor={false}
          onAddFloor={() => setDialog({ kind: 'add-floor' })}
          onSettings={() => setDialog({ kind: 'floor-settings' })}
        />

        {plan.error ? (
          <Notice
            tone="danger"
            title="We could not load the floor right now."
            action={
              <button type="button" className="pos-button pos-button--secondary" onClick={() => void plan.refresh()}>
                <RefreshCw size={14} aria-hidden />
                Try again
              </button>
            }
          >
            {plan.error}
          </Notice>
        ) : (
          <FloorEmptyState canCreate={permissions.manage} onCreate={() => setDialog({ kind: 'add-floor' })} />
        )}

        {dialog?.kind === 'add-floor' && (
          <AddFloorDialog busy={busy} onSubmit={createFloor} onClose={() => setDialog(null)} />
        )}
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    )
  }

  return (
    <div className="pos-workspace floor-screen">
      <PageHeader
        canManage={permissions.manage}
        hasFloor={floor !== null}
        onAddFloor={() => setDialog({ kind: 'add-floor' })}
        onSettings={() => setDialog({ kind: 'floor-settings' })}
      />

      {plan.offline && (
        <Notice tone="warning" title="Offline — showing the latest floor status this terminal has">
          Table changes will not go through until the connection is back, and what is on screen may already have moved
          on.
        </Notice>
      )}

      {plan.error && !plan.offline && (
        <Notice
          tone="danger"
          title="The floor did not refresh"
          action={
            <button type="button" className="pos-button pos-button--secondary" onClick={() => void plan.refresh()}>
              <RefreshCw size={14} aria-hidden />
              Try again
            </button>
          }
        >
          {plan.error} Showing the last status that came through
          {plan.updatedAt ? `, from ${stamp(plan.updatedAt)}` : ''}.
        </Notice>
      )}

      <FloorSummaryCards
        floors={floors}
        selectedId={floor?.floor_id ?? null}
        canAdd={permissions.manage}
        onSelect={(id) => {
          if (editor.dirty) {
            setDialog({ kind: 'discard-layout' })
            return
          }
          editor.cancel()
          setSelectedFloorId(id)
          setSelectedTableId(null)
          setZone(null)
        }}
        onAdd={() => setDialog({ kind: 'add-floor' })}
      />

      {floor && <FloorHealth counts={occupancy} dueSoon={dueSoon} overdue={overdue} />}

      {floor && (
        <section className="floor-workspace">
          <header className="floor-workspace__head">
            <div className="floor-workspace__title">
              <span className="floor-head__icon" aria-hidden>
                <Building2 size={20} />
              </span>
              <div className="floor-workspace__names">
                <h2>
                  {floor.floor_name}
                  <OpenPill open={floor.is_open} />
                </h2>
                <p>{floor.description ?? `${floor.tables.length} tables across ${zones.length || 1} zone(s)`}</p>
              </div>
            </div>

            <div className="floor-workspace__controls">
              <div className="floor-search">
                <Search size={15} aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search tables…"
                  aria-label="Search this floor"
                />
                <kbd aria-hidden>/</kbd>
              </div>

              <div className={plan.stale ? 'floor-updated floor-updated--stale' : 'floor-updated'} role="status">
                <span>{plan.refreshing ? 'Refreshing…' : 'Last updated'}</span>
                <strong>{stamp(plan.updatedAt)}</strong>
              </div>

              {permissions.manage && !editor.active && (
                <button
                  type="button"
                  className="pos-button pos-button--secondary"
                  onClick={() => {
                    setView('live')
                    editor.begin(placeTables(floor.tables))
                  }}
                >
                  <Pencil size={15} aria-hidden />
                  Edit layout
                </button>
              )}

              {!editor.active && (
                <div className="floor-modes" role="group" aria-label="View">
                  <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
                    <List size={15} aria-hidden />
                    Table view
                  </button>
                  <button type="button" aria-pressed={view === 'live'} onClick={() => setView('live')}>
                    <LayoutGrid size={15} aria-hidden />
                    Live view
                  </button>
                </div>
              )}
            </div>
          </header>

          {editor.active && (
            <div className="floor-editbar">
              <div className="floor-editbar__note">
                <Pencil size={15} aria-hidden />
                <strong>Editing {floor.floor_name}</strong>
                <span>
                  {editor.dirty ? 'Unsaved changes — drag tables, or nudge with the arrow keys.' : 'Drag tables to arrange the room.'}
                </span>
              </div>

              <div className="floor-editbar__tools">
                <button
                  type="button"
                  className="pos-button pos-button--secondary pos-button--small"
                  onClick={() => setDialog({ kind: 'add-table' })}
                >
                  <Plus size={14} aria-hidden />
                  Add table
                </button>
                <button
                  type="button"
                  className="pos-button pos-button--secondary pos-button--small"
                  onClick={() => selected && setDialog({ kind: 'edit-table', table: selected })}
                  disabled={!selected}
                >
                  <Pencil size={14} aria-hidden />
                  Table &amp; zone
                </button>
                <button
                  type="button"
                  className="pos-button pos-button--secondary pos-button--small"
                  onClick={() => selected && editor.toggleRemoved(selected.table_id)}
                  disabled={!selected}
                >
                  <Trash2 size={14} aria-hidden />
                  {selected && editor.removed.has(selected.table_id) ? 'Keep table' : 'Remove'}
                </button>
                <button
                  type="button"
                  className="pos-button pos-button--quiet pos-button--small"
                  onClick={editor.undo}
                  disabled={!editor.canUndo}
                  aria-label="Undo"
                >
                  <Undo2 size={14} aria-hidden />
                  Undo
                </button>
                <button
                  type="button"
                  className="pos-button pos-button--quiet pos-button--small"
                  onClick={editor.redo}
                  disabled={!editor.canRedo}
                  aria-label="Redo"
                >
                  <Redo2 size={14} aria-hidden />
                  Redo
                </button>
                <button type="button" className="pos-button pos-button--secondary pos-button--small" onClick={leaveEditor}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="pos-button pos-button--primary pos-button--small"
                  onClick={saveLayout}
                  disabled={busy || !editor.dirty}
                >
                  {busy ? 'Saving…' : 'Save layout'}
                </button>
              </div>
            </div>
          )}

          {view === 'table' && !editor.active ? (
            <TableListView
              rows={listRows}
              selectedId={selectedTableId}
              now={now}
              canSell={permissions.sell}
              onSelect={select}
              onOpenOrder={(row) => openOrder(row.table)}
              onStartOrder={(row) => setDialog({ kind: 'seat', table: row.table })}
            />
          ) : (
            <div className={showInspector ? 'floor-body' : 'floor-body floor-body--wide'}>
              <FloorZoneRail zones={zones} total={floor.tables.length} selected={zone} onSelect={setZone} />

              <main className="floor-plan-shell">
                {floor.tables.length === 0 ? (
                  <div className="pos-state pos-state--inline">
                    <h2>No tables on this floor yet</h2>
                    <p>
                      {permissions.manage
                        ? 'Add the first table, then drag it where it sits in the room.'
                        : 'A manager needs to add tables to this floor.'}
                    </p>
                    {permissions.manage && (
                      <button
                        type="button"
                        className="pos-button pos-button--primary"
                        onClick={() => setDialog({ kind: 'add-table' })}
                      >
                        <Plus size={15} aria-hidden />
                        Add a table
                      </button>
                    )}
                  </div>
                ) : (
                  <FloorMap
                    planRef={planRef}
                    tables={placed}
                    dimmedIds={dimmedIds}
                    removingIds={editor.removed}
                    selectedId={selectedTableId}
                    zoom={zoom}
                    editing={editor.active}
                    draggingId={draggingId}
                    now={now}
                    onSelect={select}
                    onActivate={(id) => {
                      select(id)
                      window.requestAnimationFrame(primaryAction)
                    }}
                    onDragStart={startDrag}
                  />
                )}
              </main>

              {showInspector && narrow && (
                <button
                  type="button"
                  className="floor-inspector-scrim"
                  aria-label="Close table details"
                  onClick={() => setInspectorOpen(false)}
                />
              )}

              {showInspector && (
                <TableInspector
                  table={selected}
                  floor={floor}
                  now={now}
                  busy={busy}
                  can={permissions}
                  actions={actions}
                  onClose={() => {
                    setSelectedTableId(null)
                    setInspectorOpen(false)
                  }}
                />
              )}
            </div>
          )}

          {view === 'live' && (
            <FloorLegend
              counts={occupancy}
              active={statusFilter}
              onToggle={setStatusFilter}
              zoom={zoom}
              onZoom={setZoom}
              onFit={() => {
                setZoom(1)
                planRef.current?.parentElement?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
              }}
            />
          )}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Dialogs                                                          */}
      {/* ---------------------------------------------------------------- */}

      {dialog?.kind === 'add-floor' && (
        <AddFloorDialog busy={busy} onSubmit={createFloor} onClose={() => setDialog(null)} />
      )}

      {dialog?.kind === 'floor-settings' && floor && (
        <FloorSettingsDialog
          floor={floor}
          busy={busy}
          canDelete={permissions.manage}
          onSubmit={saveFloor}
          onDelete={() => setDialog({ kind: 'retire-floor' })}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'retire-floor' && floor && (
        <ConfirmDialog
          title={`Retire ${floor.floor_name}?`}
          body={`Its ${floor.tables.length} table${floor.tables.length === 1 ? '' : 's'} come off the floor screen. Bills and sessions already recorded against them are kept — nothing is deleted.`}
          confirmLabel="Retire floor"
          busy={busy}
          onConfirm={retireFloor}
          onClose={() => setDialog({ kind: 'floor-settings' })}
        />
      )}

      {(dialog?.kind === 'add-table' || dialog?.kind === 'edit-table') && (
        <TableDialog
          table={dialog.kind === 'edit-table' ? dialog.table : null}
          zones={zones.filter((z) => z.id !== '').map((z) => z.name)}
          busy={busy}
          onSubmit={(draft) => saveTable(draft, dialog.kind === 'edit-table' ? dialog.table.table_id : null)}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'seat' && (
        <SeatDialog
          table={dialog.table}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            run(
              async () => {
                await api.post(`v1/tables/${dialog.table.table_id}/open`, {
                  covers: input.covers,
                  terminal_id: terminalId,
                  customer_name: input.customer_name || null,
                  customer_mobile: input.customer_mobile || null,
                })
              },
              { title: 'Table seated', detail: `A bill is open on ${tableLabel(dialog.table)}.` },
            )
          }
        />
      )}

      {dialog?.kind === 'move' && (
        <MoveDialog
          table={dialog.table}
          floors={floors}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(targetId) =>
            run(
              async () => {
                await api.post(`v1/table-sessions/${dialog.table.table_session_id}/transfer`, { table_id: targetId })
                setSelectedTableId(targetId)
              },
              { title: 'Party moved' },
            )
          }
        />
      )}

      {dialog?.kind === 'merge' && (
        <MergeDialog
          table={dialog.table}
          floors={floors}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(targetSessionId) =>
            run(
              async () => {
                await api.post(`v1/table-sessions/${dialog.table.table_session_id}/merge`, {
                  into_table_session_id: targetSessionId,
                })
              },
              { title: 'Bills merged', detail: 'There is one bill for both tables now.' },
            )
          }
        />
      )}

      {dialog?.kind === 'reserve' && (
        <ReserveDialog
          table={dialog.table}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            run(
              async () => {
                await api.post('v1/reservations', { table_id: dialog.table.table_id, ...input })
              },
              { title: 'Table booked', detail: `${tableLabel(dialog.table)} is held for ${input.guest_name || 'the party'}.` },
            )
          }
        />
      )}

      {dialog?.kind === 'cancel-booking' && (
        <ConfirmDialog
          title="Cancel this booking?"
          body={`${dialog.table.reservation?.guest_name ?? 'The party'} will lose ${tableLabel(dialog.table)}, and it goes straight back on the floor.`}
          confirmLabel="Cancel booking"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(
              async () => {
                await api.post(`v1/reservations/${dialog.table.reservation?.reservation_id}/cancel`, {})
              },
              { title: 'Booking cancelled' },
            )
          }
        />
      )}

      {dialog?.kind === 'service' && (
        <ServiceStateDialog
          table={dialog.table}
          state={dialog.state}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(note) =>
            run(
              async () => {
                await api.post(`v1/tables/${dialog.table.table_id}/service-state`, {
                  service_state: dialog.state,
                  note: note || null,
                })
              },
              {
                title: dialog.state === 'CLEANING' ? 'Marked for cleaning' : 'Taken out of service',
                detail: `${tableLabel(dialog.table)} is off the floor until it is restored.`,
              },
            )
          }
        />
      )}

      {dialog?.kind === 'clear' && (
        <ConfirmDialog
          title={`Clear ${tableLabel(dialog.table)}?`}
          body="The party is finished with the table. An unpaid bill will stop this — settle it at the till first."
          confirmLabel="Mark vacant"
          tone="primary"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(
              async () => {
                await api.post(`v1/table-sessions/${dialog.table.table_session_id}/close`, {})
              },
              { title: 'Table cleared' },
            )
          }
        />
      )}

      {dialog?.kind === 'discard-layout' && (
        <ConfirmDialog
          title="Leave without saving the layout?"
          body="The tables go back to where they were before you started arranging them."
          confirmLabel="Discard changes"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            editor.cancel()
            setDialog(null)
          }}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function PageHeader({
  canManage,
  hasFloor,
  onAddFloor,
  onSettings,
}: {
  canManage: boolean
  hasFloor: boolean
  onAddFloor: () => void
  onSettings: () => void
}) {
  return (
    <header className="floor-head">
      <div className="floor-head__title">
        <span className="floor-head__icon" aria-hidden>
          <Building2 size={21} />
        </span>
        <div>
          <h1>Floors</h1>
          <p>
            Create and manage your restaurant floors, tables and zones. Click a table to see its status or start an
            order.
          </p>
        </div>
      </div>

      {canManage && (
        <div className="floor-head__actions">
          {hasFloor && (
            <button type="button" className="pos-button pos-button--secondary" onClick={onSettings}>
              <Settings2 size={15} aria-hidden />
              Floor settings
            </button>
          )}
          <button type="button" className="pos-button pos-button--primary" onClick={onAddFloor}>
            <Plus size={16} aria-hidden />
            Add new floor
          </button>
        </div>
      )}
    </header>
  )
}

/**
 * The first paint, before anything has arrived.
 *
 * Shaped like the screen it is about to become rather than a spinner in the
 * middle of nothing, so the page does not jump when the floors land.
 */
function FloorSkeleton() {
  return (
    <div className="pos-workspace floor-screen" aria-busy="true" aria-live="polite">
      <span className="pos-visually-hidden">Loading the floor…</span>

      <header className="floor-head">
        <div className="floor-head__title">
          <span className="floor-head__icon" aria-hidden>
            <Building2 size={21} />
          </span>
          <div>
            <h1>Floors</h1>
            <p>Create and manage your restaurant floors, tables and zones.</p>
          </div>
        </div>
      </header>

      <div className="floor-cards" aria-hidden>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="floor-skeleton floor-skeleton--card" />
        ))}
      </div>

      <section className="floor-workspace" aria-hidden>
        <div className="floor-skeleton floor-skeleton--plan" />
      </section>
    </div>
  )
}
