/**
 * Every table as a row.
 *
 * The plan answers "where"; this answers "which". A manager checking who has
 * been sitting longest, or which tables are still owed a bill, reads a column
 * rather than a room — so this is a real table with a sticky head and real
 * sorting, not the plan with the pictures taken away.
 */

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Eye, Plus } from 'lucide-react'
import { money } from '../../ui'
import type { FloorPlanFloor, TableStatus } from '../../services/types'
import type { PlacedTable } from './FloorMap'
import { StatusPill } from './parts'
import { clockTime, minutesSince, shortDuration, tableLabel } from './status'

export interface ListRow {
  /** Carries its place on the plan too, so a row and a table are the same object. */
  table: PlacedTable
  floor: FloorPlanFloor
}

type SortKey = 'table' | 'status' | 'capacity' | 'duration' | 'amount' | 'reservation'

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: 'table', label: 'Table' },
  { key: null, label: 'Floor' },
  { key: null, label: 'Zone' },
  { key: 'capacity', label: 'Capacity', numeric: true },
  { key: 'status', label: 'Status' },
  { key: null, label: 'Guests', numeric: true },
  { key: null, label: 'Order' },
  { key: 'amount', label: 'Amount', numeric: true },
  { key: null, label: 'Server' },
  { key: null, label: 'Since' },
  { key: 'duration', label: 'Duration', numeric: true },
  { key: 'reservation', label: 'Next booking' },
  { key: null, label: 'Actions' },
]

const STATUS_RANK: Record<TableStatus, number> = {
  OCCUPIED: 0,
  RESERVED: 1,
  CLEANING: 2,
  OUT_OF_SERVICE: 3,
  FREE: 4,
}

export function TableListView({
  rows,
  selectedId,
  now,
  canSell,
  onSelect,
  onOpenOrder,
  onStartOrder,
}: {
  rows: ListRow[]
  selectedId: number | null
  now: number
  canSell: boolean
  onSelect: (tableId: number) => void
  onOpenOrder: (row: ListRow) => void
  onStartOrder: (row: ListRow) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'table', direction: 'asc' })

  const sorted = useMemo(() => {
    const factor = sort.direction === 'asc' ? 1 : -1

    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case 'status':
          return (STATUS_RANK[a.table.status] - STATUS_RANK[b.table.status]) * factor
        case 'capacity':
          return (a.table.seats - b.table.seats) * factor
        case 'amount':
          return ((a.table.running_total ?? -1) - (b.table.running_total ?? -1)) * factor
        case 'duration':
          return ((minutesSince(a.table.opened_at, now) ?? -1) - (minutesSince(b.table.opened_at, now) ?? -1)) * factor
        case 'reservation':
          return (
            (new Date(a.table.reservation?.reserved_for ?? '9999-12-31').getTime() -
              new Date(b.table.reservation?.reserved_for ?? '9999-12-31').getTime()) *
            factor
          )
        default:
          return (
            tableLabel(a.table).localeCompare(tableLabel(b.table), undefined, { numeric: true, sensitivity: 'base' }) *
            factor
          )
      }
    })
  }, [rows, sort, now])

  const toggle = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'table' ? 'asc' : 'desc' },
    )

  if (rows.length === 0) {
    return (
      <div style={{ padding: '46px 20px', textAlign: 'center', color: 'var(--muted)' }}>
        <strong style={{ display: 'block', fontSize: 14, color: 'var(--fg)' }}>No tables match</strong>
        <p style={{ margin: '6px 0 0', fontSize: 13 }}>Clear the search or the status filter to see the whole floor.</p>
      </div>
    )
  }

  return (
    <div className="floor-tableview">
      <div className="floor-tableview__scroll">
        <table>
          <caption className="pos-visually-hidden">
            Tables with their status, party, order and next booking. Sortable by table, status, capacity, amount,
            duration and booking.
          </caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  style={column.numeric ? { textAlign: 'right' } : undefined}
                  aria-sort={
                    column.key && sort.key === column.key
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  {column.key ? (
                    <button type="button" onClick={() => toggle(column.key as SortKey)}>
                      {column.label}
                      {sort.key === column.key ? (
                        sort.direction === 'asc' ? (
                          <ArrowUp size={12} aria-hidden />
                        ) : (
                          <ArrowDown size={12} aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDown size={12} aria-hidden style={{ opacity: 0.45 }} />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {sorted.map(({ table, floor }) => {
              const minutes = minutesSince(table.opened_at, now)

              return (
                <tr
                  key={table.table_id}
                  aria-selected={table.table_id === selectedId}
                  onClick={() => onSelect(table.table_id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <strong>{tableLabel(table)}</strong>
                  </td>
                  <td>{floor.floor_name}</td>
                  <td>{table.zone_name?.trim() || '—'}</td>
                  <td className="num">{table.seats}</td>
                  <td>
                    <StatusPill status={table.status} />
                  </td>
                  <td className="num">{table.status === 'OCCUPIED' ? (table.covers ?? table.seats) : '—'}</td>
                  <td>{table.cart_id ? `#ORD-${table.cart_id}` : '—'}</td>
                  <td className="num">{table.running_total === null ? '—' : money(table.running_total)}</td>
                  <td>{table.waiter_name ?? '—'}</td>
                  <td>{table.opened_at ? clockTime(table.opened_at) : '—'}</td>
                  <td className="num">{shortDuration(minutes)}</td>
                  <td>
                    {table.reservation
                      ? `${clockTime(table.reservation.reserved_for)} · ${table.reservation.guest_name ?? 'Booked'}`
                      : '—'}
                  </td>
                  <td>
                    {table.status === 'OCCUPIED' && table.cart_id && canSell ? (
                      <button
                        type="button"
                        className="floor-rowlink"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenOrder({ table, floor })
                        }}
                      >
                        <Eye size={13} aria-hidden style={{ verticalAlign: -2, marginRight: 4 }} />
                        Open order
                      </button>
                    ) : table.status === 'FREE' ? (
                      <button
                        type="button"
                        className="floor-rowlink"
                        onClick={(event) => {
                          event.stopPropagation()
                          onStartOrder({ table, floor })
                        }}
                      >
                        <Plus size={13} aria-hidden style={{ verticalAlign: -2, marginRight: 4 }} />
                        Seat
                      </button>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
