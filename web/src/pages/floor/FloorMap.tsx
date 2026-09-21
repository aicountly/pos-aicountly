/**
 * The room.
 *
 * Tables are absolutely positioned from coordinates the shop saved, in
 * hundredths of a percent, so the same layout is the same room on a 13" laptop
 * and on a 24" till screen. There is no canvas: every table is a real button,
 * which is what makes the plan keyboard-operable and screen-readable at all.
 *
 * Zoom scales the plan and the tables together — a zoom that spread the tables
 * out without growing them would not be a zoom.
 */

import { memo, useMemo, type PointerEvent as ReactPointerEvent } from 'react'
import { DoorOpen, Users } from 'lucide-react'
import type { FloorPlanTable } from '../../services/types'
import {
  isOverdue,
  minutesSince,
  shortDuration,
  statusOf,
  tableAriaLabel,
  tableLabel,
} from './status'

/** Table size on the plan at 100%, before zoom. */
const SIZES: Record<string, { w: number; h: number }> = {
  square: { w: 54, h: 54 },
  rectangle: { w: 80, h: 52 },
  round: { w: 56, h: 56 },
}

export interface PlacedTable extends FloorPlanTable {
  /** Resolved coordinates: the saved ones, or a slot worked out for a table that has none. */
  x: number
  y: number
}

/**
 * Give every table a place, including the ones nobody has dragged yet.
 *
 * A floor built on the old Setup screen has no coordinates at all. Dropping
 * those tables in one corner would read as a broken plan rather than an
 * unfinished one, so they are laid out on a grid until somebody arranges them.
 */
export function placeTables(tables: FloorPlanTable[]): PlacedTable[] {
  let unplaced = 0

  return tables.map((table) => {
    if (table.layout_x !== null && table.layout_y !== null) {
      return { ...table, x: table.layout_x, y: table.layout_y }
    }

    const slot = unplaced++
    const column = slot % 6
    const row = Math.floor(slot / 6)

    return { ...table, x: 900 + column * 1550, y: 1300 + row * 1700 }
  })
}

// ---------------------------------------------------------------------------
// One table
// ---------------------------------------------------------------------------

interface NodeProps {
  table: PlacedTable
  zoom: number
  selected: boolean
  dimmed: boolean
  removing: boolean
  dragging: boolean
  editing: boolean
  now: number
  onSelect: (tableId: number) => void
  onActivate: (tableId: number) => void
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>, tableId: number) => void
}

const TableNode = memo(function TableNode({
  table,
  zoom,
  selected,
  dimmed,
  removing,
  dragging,
  editing,
  now,
  onSelect,
  onActivate,
  onDragStart,
}: NodeProps) {
  const config = statusOf(table.status)
  const Icon = config.icon
  const size = SIZES[table.shape] ?? SIZES.square
  const width = (table.layout_w ? table.layout_w / 100 : size.w) * zoom
  const height = (table.layout_h ? table.layout_h / 100 : size.h) * zoom
  const minutes = table.status === 'OCCUPIED' ? minutesSince(table.opened_at, now) : null
  const overdue = isOverdue(table, now)

  const classes = [
    'floor-table',
    `floor-table--${table.shape}`,
    `floor-table--${config.modifier}`,
    dimmed ? 'floor-table--dimmed' : '',
    removing ? 'floor-table--removing' : '',
    dragging ? 'floor-table--dragging' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classes}
      style={{
        left: `${table.x / 100}%`,
        top: `${table.y / 100}%`,
        width,
        height,
        fontSize: Math.max(10, 13 * zoom),
      }}
      aria-pressed={selected}
      aria-label={tableAriaLabel(table, now)}
      title={tableAriaLabel(table, now)}
      data-table-id={table.table_id}
      onClick={() => onSelect(table.table_id)}
      onDoubleClick={() => onActivate(table.table_id)}
      onPointerDown={editing && onDragStart ? (event) => onDragStart(event, table.table_id) : undefined}
    >
      <span className="floor-table__code">{tableLabel(table)}</span>

      {/* The status is never colour alone: occupied shows its covers, a booked
          table its clock, and everything else its own icon. */}
      {table.status === 'OCCUPIED' ? (
        <span className="floor-table__mark">
          <Users size={11} aria-hidden />
          {table.covers ?? table.seats}
          {minutes !== null && zoom >= 0.85 ? ` · ${shortDuration(minutes)}` : ''}
        </span>
      ) : table.status === 'FREE' ? null : (
        <span className="floor-table__mark">
          <Icon size={11} aria-hidden />
        </span>
      )}

      {overdue && <span className="floor-table__overdue" aria-hidden />}
      {table.bill_count > 1 && (
        <span className="floor-table__badge" aria-hidden title="Split bill">
          <span style={{ fontSize: 9, fontWeight: 800, lineHeight: 1 }}>{table.bill_count}</span>
        </span>
      )}
    </button>
  )
})

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface FloorMapProps {
  tables: PlacedTable[]
  /** Tables the filters have pushed into the background, still shown in place. */
  dimmedIds: ReadonlySet<number>
  removingIds?: ReadonlySet<number>
  selectedId: number | null
  zoom: number
  editing?: boolean
  draggingId?: number | null
  now: number
  onSelect: (tableId: number) => void
  onActivate: (tableId: number) => void
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>, tableId: number) => void
  planRef?: React.Ref<HTMLDivElement>
}

export function FloorMap({
  tables,
  dimmedIds,
  removingIds,
  selectedId,
  zoom,
  editing = false,
  draggingId = null,
  now,
  onSelect,
  onActivate,
  onDragStart,
  planRef,
}: FloorMapProps) {
  /**
   * Zone captions, placed from the tables themselves.
   *
   * A caption at the top of its own cluster rather than at a coordinate
   * somebody typed: move the Window tables and the word Window follows them.
   */
  const captions = useMemo(() => {
    const groups = new Map<string, { name: string; x: number; y: number; count: number }>()

    for (const table of tables) {
      const name = table.zone_name?.trim()
      if (!name) continue

      const key = name.toLowerCase()
      const group = groups.get(key)
      if (group) {
        group.x += table.x
        group.y = Math.min(group.y, table.y)
        group.count++
      } else {
        groups.set(key, { name, x: table.x, y: table.y, count: 1 })
      }
    }

    return [...groups.values()].map((group) => ({
      name: group.name,
      x: group.x / group.count,
      y: Math.max(150, group.y - 1300),
    }))
  }, [tables])

  return (
    <div
      ref={planRef}
      className={editing ? 'floor-plan floor-plan--editing' : 'floor-plan'}
      style={{ width: `${zoom * 100}%` }}
      role="group"
      aria-label="Floor plan"
    >
      {captions.map((caption) => (
        <span
          key={caption.name}
          className="floor-plan__zone"
          style={{ left: `${caption.x / 100}%`, top: `${caption.y / 100}%` }}
        >
          {caption.name}
        </span>
      ))}

      {tables.map((table) => (
        <TableNode
          key={table.table_id}
          table={table}
          zoom={zoom}
          now={now}
          selected={selectedId === table.table_id}
          dimmed={dimmedIds.has(table.table_id)}
          removing={removingIds?.has(table.table_id) ?? false}
          dragging={draggingId === table.table_id}
          editing={editing}
          onSelect={onSelect}
          onActivate={onActivate}
          onDragStart={onDragStart}
        />
      ))}

      {/* Which way the room is read from. Decoration, and labelled as such to a
          screen reader rather than announced as a table. */}
      <span className="floor-plan__entrance" aria-hidden>
        <DoorOpen size={12} />
        Entrance
      </span>
    </div>
  )
}

/**
 * Move the selection with the arrow keys.
 *
 * Nearest table in the pressed direction, weighted so a table slightly off the
 * axis still wins over one far away on it — which is how a person reading the
 * plan would expect it to go.
 */
export function neighbourOf(
  tables: PlacedTable[],
  fromId: number | null,
  direction: 'up' | 'down' | 'left' | 'right',
): number | null {
  if (tables.length === 0) return null

  const from = tables.find((table) => table.table_id === fromId)
  if (!from) return tables[0].table_id

  let best: { id: number; score: number } | null = null

  for (const table of tables) {
    if (table.table_id === from.table_id) continue

    const dx = table.x - from.x
    const dy = table.y - from.y
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)

    if (along <= 0) continue

    const score = along + across * 2
    if (!best || score < best.score) best = { id: table.table_id, score }
  }

  return best?.id ?? null
}

/** Where a pointer is on the plan, in the same units the tables are saved in. */
export function pointToPlan(plan: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = plan.getBoundingClientRect()

  return {
    x: Math.max(0, Math.min(10000, Math.round(((clientX - rect.left) / rect.width) * 10000))),
    y: Math.max(0, Math.min(10000, Math.round(((clientY - rect.top) / rect.height) * 10000))),
  }
}
