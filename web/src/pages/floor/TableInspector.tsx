/**
 * The panel beside the plan.
 *
 * It answers one question — what do I do with this table — and the answer is
 * different for each of the five states, so the panel is five panels rather
 * than one panel with everything greyed out. A waiter looking at a booked table
 * should see Seat Guests, not a disabled Print Bill.
 *
 * Every action here calls a real endpoint. Where an action needs a workflow POS
 * does not have yet, it is not drawn at all rather than drawn and inert.
 */

import type { ReactNode } from 'react'
import {
  ArrowRightLeft,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Clock3,
  Eye,
  MapPin,
  Merge,
  Pencil,
  Plus,
  Printer,
  Sparkles,
  SquareCheckBig,
  Sofa,
  Users,
  Utensils,
  Wrench,
  X,
} from 'lucide-react'
import { money } from '../../ui'
import type { FloorPlanFloor } from '../../services/types'
import type { PlacedTable } from './FloorMap'
import { StatusPill } from './parts'
import {
  clockTime,
  longDuration,
  minutesSince,
  shortDuration,
  tableTitle,
  TURN_TIME_MINUTES,
} from './status'

export interface InspectorActions {
  startOrder: (table: PlacedTable) => void
  viewOrder: (table: PlacedTable) => void
  addItems: (table: PlacedTable) => void
  printBill: (table: PlacedTable) => void
  clearTable: (table: PlacedTable) => void
  moveTable: (table: PlacedTable) => void
  mergeTable: (table: PlacedTable) => void
  reserve: (table: PlacedTable) => void
  seatReservation: (table: PlacedTable) => void
  cancelReservation: (table: PlacedTable) => void
  markCleaning: (table: PlacedTable) => void
  markReady: (table: PlacedTable) => void
  takeOutOfService: (table: PlacedTable) => void
  editTable: (table: PlacedTable) => void
}

export interface InspectorPermissions {
  seat: boolean
  transfer: boolean
  merge: boolean
  manage: boolean
  sell: boolean
}

export function TableInspector({
  table,
  floor,
  now,
  busy,
  can,
  actions,
  onClose,
}: {
  table: PlacedTable | null
  floor: FloorPlanFloor | null
  now: number
  busy: boolean
  can: InspectorPermissions
  actions: InspectorActions
  onClose: () => void
}) {
  if (!table) {
    return (
      <aside className="floor-inspector" aria-label="Table details">
        <div className="floor-inspector__idle">
          <Sofa size={26} aria-hidden style={{ color: 'var(--border-strong)' }} />
          <strong style={{ fontSize: 14 }}>No table selected</strong>
          <p>
            Pick a table on the plan to see who is sitting there, what they have ordered, and what to do next.
          </p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="floor-inspector" aria-label={`${tableTitle(table)} details`}>
      <header className="floor-inspector__head">
        <h3>{tableTitle(table)}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusPill status={table.status} />
          <button type="button" className="floor-inspector__close" onClick={onClose} aria-label="Close details">
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>

      <div className="floor-profile">
        <div className="floor-profile__thumb" aria-hidden>
          <Utensils size={24} />
        </div>
        <div className="floor-profile__facts">
          <div>
            <MapPin size={14} aria-hidden />
            <span>{table.zone_name?.trim() || floor?.floor_name || 'Unzoned'}</span>
          </div>
          <div>
            <Users size={14} aria-hidden />
            <span>
              {table.seats} seater
              {table.max_covers ? ` · up to ${table.max_covers}` : ''}
            </span>
          </div>
          <div>
            <Clock3 size={14} aria-hidden />
            <span>{occupancyLine(table, now)}</span>
          </div>
        </div>
      </div>

      <div className="floor-inspector__rule" />

      {table.status === 'OCCUPIED' && <OccupiedBody table={table} now={now} />}
      {table.status === 'RESERVED' && <ReservedBody table={table} />}
      {table.status === 'CLEANING' && <ServiceBody table={table} kind="cleaning" />}
      {table.status === 'OUT_OF_SERVICE' && <ServiceBody table={table} kind="out" />}
      {table.status === 'FREE' && <AvailableBody table={table} />}

      <Actions table={table} busy={busy} can={can} actions={actions} />
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function occupancyLine(table: PlacedTable, now: number): string {
  if (table.status === 'OCCUPIED') {
    const minutes = minutesSince(table.opened_at, now)

    return minutes === null ? 'Seated' : `Occupied for ${longDuration(minutes)}`
  }
  if (table.status === 'RESERVED' && table.reservation) {
    return `Held for ${clockTime(table.reservation.reserved_for)}`
  }
  if (table.status === 'CLEANING' || table.status === 'OUT_OF_SERVICE') {
    const minutes = minutesSince(table.service_state_at, now)

    return minutes === null ? 'Not available' : `Since ${shortDuration(minutes)} ago`
  }

  return 'Free now'
}

function OccupiedBody({ table, now }: { table: PlacedTable; now: number }) {
  const minutes = minutesSince(table.opened_at, now)
  const overdue = minutes !== null && minutes > TURN_TIME_MINUTES

  return (
    <section>
      <p className="floor-section__label">Current order</p>

      <div className="floor-order">
        <div className="floor-order__head">
          <strong>{table.cart_id ? `#ORD-${table.cart_id}` : 'No bill yet'}</strong>
          <strong>{money(table.running_total ?? 0)}</strong>
        </div>
        <span className="floor-order__items">
          {table.line_count} item{table.line_count === 1 ? '' : 's'}
          {table.bill_count > 1 ? ` · ${table.bill_count} separate bills` : ''}
          {table.open_kots > 0 ? ` · ${table.open_kots} with the kitchen` : ''}
        </span>

        <div className="floor-order__meta">
          <span>
            Server
            <strong>{table.waiter_name ?? 'Not recorded'}</strong>
          </span>
          <span>
            Guests
            <strong>{table.covers ?? table.seats}</strong>
          </span>
          <span style={{ textAlign: 'right' }}>
            Started
            <strong>{clockTime(table.opened_at)}</strong>
          </span>
        </div>
      </div>

      {overdue && (
        <p
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            margin: '10px 0 0',
            color: 'var(--warning)',
            fontSize: 12,
          }}
        >
          <Clock3 size={13} aria-hidden />
          Over the {TURN_TIME_MINUTES}-minute turn time. Worth a look in.
        </p>
      )}
    </section>
  )
}

function ReservedBody({ table }: { table: PlacedTable }) {
  const booking = table.reservation
  if (!booking) return null

  return (
    <section>
      <p className="floor-section__label">Booking</p>

      <dl className="floor-facts">
        <dt>Guest</dt>
        <dd>{booking.guest_name ?? 'Not given'}</dd>

        {booking.guest_mobile && (
          <>
            <dt>Mobile</dt>
            <dd className="num">{booking.guest_mobile}</dd>
          </>
        )}

        <dt>Due</dt>
        <dd>{clockTime(booking.reserved_for)}</dd>

        <dt>Party</dt>
        <dd>
          {booking.party_size} guest{booking.party_size === 1 ? '' : 's'}
        </dd>

        {booking.notes && (
          <>
            <dt>Note</dt>
            <dd>{booking.notes}</dd>
          </>
        )}

        <dt>Reference</dt>
        <dd className="num">{booking.reservation_no}</dd>
      </dl>
    </section>
  )
}

function ServiceBody({ table, kind }: { table: PlacedTable; kind: 'cleaning' | 'out' }) {
  return (
    <section>
      <p className="floor-section__label">{kind === 'cleaning' ? 'Being turned around' : 'Out of service'}</p>

      <dl className="floor-facts">
        <dt>Reason</dt>
        <dd>{table.service_note ?? (kind === 'cleaning' ? 'Routine clean' : 'No reason recorded')}</dd>

        <dt>Marked by</dt>
        <dd>{table.service_state_by ?? 'Not recorded'}</dd>

        <dt>Marked at</dt>
        <dd>{clockTime(table.service_state_at)}</dd>
      </dl>

      {table.reservation && (
        <p style={{ margin: '12px 0 0', color: 'var(--warning)', fontSize: 12, display: 'flex', gap: 7 }}>
          <CalendarClock size={13} aria-hidden style={{ flex: '0 0 auto', marginTop: 2 }} />
          Booked for {clockTime(table.reservation.reserved_for)} — move that party or cancel the booking.
        </p>
      )}
    </section>
  )
}

function AvailableBody({ table }: { table: PlacedTable }) {
  return (
    <section>
      <p className="floor-section__label">Ready to seat</p>

      <dl className="floor-facts">
        <dt>Capacity</dt>
        <dd>
          {table.min_covers ? `${table.min_covers}–` : ''}
          {table.max_covers ?? table.seats} guests
        </dd>

        <dt>Shape</dt>
        <dd style={{ textTransform: 'capitalize' }}>{table.shape}</dd>

        {table.reservation && (
          <>
            <dt>Next booking</dt>
            <dd>
              {clockTime(table.reservation.reserved_for)} · {table.reservation.guest_name ?? 'Booked'}
            </dd>
          </>
        )}
      </dl>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function Action({
  icon,
  label,
  onClick,
  tone = 'secondary',
  disabled,
  wide,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  tone?: 'primary' | 'secondary'
  disabled?: boolean
  wide?: boolean
}) {
  return (
    <button
      type="button"
      className={`pos-button pos-button--${tone}${wide ? ' floor-actions__wide' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {label}
    </button>
  )
}

function Actions({
  table,
  busy,
  can,
  actions,
}: {
  table: PlacedTable
  busy: boolean
  can: InspectorPermissions
  actions: InspectorActions
}) {
  const buttons: ReactNode[] = []

  if (table.status === 'FREE') {
    if (can.seat) {
      buttons.push(
        <Action
          key="start"
          tone="primary"
          wide
          icon={<Plus size={15} aria-hidden />}
          label="Start order"
          onClick={() => actions.startOrder(table)}
          disabled={busy}
        />,
      )
      buttons.push(
        <Action
          key="reserve"
          icon={<CalendarPlus size={15} aria-hidden />}
          label="Reserve"
          onClick={() => actions.reserve(table)}
          disabled={busy}
        />,
      )
      buttons.push(
        <Action
          key="clean"
          icon={<Sparkles size={15} aria-hidden />}
          label="Mark cleaning"
          onClick={() => actions.markCleaning(table)}
          disabled={busy}
        />,
      )
    }
  }

  if (table.status === 'OCCUPIED') {
    if (table.cart_id && can.sell) {
      buttons.push(
        <Action
          key="view"
          tone="primary"
          icon={<Eye size={15} aria-hidden />}
          label="View order"
          onClick={() => actions.viewOrder(table)}
          disabled={busy}
        />,
      )
      buttons.push(
        <Action
          key="add"
          icon={<Plus size={15} aria-hidden />}
          label="Add items"
          onClick={() => actions.addItems(table)}
          disabled={busy}
        />,
      )
      buttons.push(
        <Action
          key="print"
          icon={<Printer size={15} aria-hidden />}
          label="Print bill"
          onClick={() => actions.printBill(table)}
          disabled={busy}
        />,
      )
    }
    if (can.transfer) {
      buttons.push(
        <Action
          key="move"
          icon={<ArrowRightLeft size={15} aria-hidden />}
          label="Move table"
          onClick={() => actions.moveTable(table)}
          disabled={busy}
        />,
      )
    }
    if (can.merge) {
      buttons.push(
        <Action
          key="merge"
          icon={<Merge size={15} aria-hidden />}
          label="Merge table"
          onClick={() => actions.mergeTable(table)}
          disabled={busy}
        />,
      )
    }
    if (can.seat) {
      buttons.push(
        <Action
          key="clear"
          icon={<SquareCheckBig size={15} aria-hidden />}
          label="Mark as vacant"
          onClick={() => actions.clearTable(table)}
          disabled={busy}
        />,
      )
    }
  }

  if (table.status === 'RESERVED' && can.seat) {
    buttons.push(
      <Action
        key="seat"
        tone="primary"
        wide
        icon={<Users size={15} aria-hidden />}
        label="Seat guests"
        onClick={() => actions.seatReservation(table)}
        disabled={busy}
      />,
    )
    buttons.push(
      <Action
        key="rebook"
        icon={<Pencil size={15} aria-hidden />}
        label="Rebook"
        onClick={() => actions.reserve(table)}
        disabled={busy}
      />,
    )
    buttons.push(
      <Action
        key="cancel"
        icon={<CalendarX size={15} aria-hidden />}
        label="Cancel booking"
        onClick={() => actions.cancelReservation(table)}
        disabled={busy}
      />,
    )
  }

  if (table.status === 'CLEANING' && can.seat) {
    buttons.push(
      <Action
        key="ready"
        tone="primary"
        wide
        icon={<SquareCheckBig size={15} aria-hidden />}
        label="Mark ready"
        onClick={() => actions.markReady(table)}
        disabled={busy}
      />,
    )
  }

  if (table.status === 'OUT_OF_SERVICE' && can.manage) {
    buttons.push(
      <Action
        key="restore"
        tone="primary"
        wide
        icon={<SquareCheckBig size={15} aria-hidden />}
        label="Restore table"
        onClick={() => actions.markReady(table)}
        disabled={busy}
      />,
    )
  }

  // Out of service is a manager's decision and sits apart from the floor's own
  // buttons, so it is not pressed by mistake while clearing tables at speed.
  if (can.manage && table.status !== 'OUT_OF_SERVICE' && table.status !== 'OCCUPIED') {
    buttons.push(
      <Action
        key="oos"
        icon={<Wrench size={15} aria-hidden />}
        label="Out of service"
        onClick={() => actions.takeOutOfService(table)}
        disabled={busy}
      />,
    )
  }

  if (can.manage) {
    buttons.push(
      <Action
        key="edit"
        icon={<Pencil size={15} aria-hidden />}
        label="Edit table"
        onClick={() => actions.editTable(table)}
        disabled={busy}
      />,
    )
  }

  if (buttons.length === 0) {
    return (
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12.5 }}>
        You can see this table but your role does not allow changing it.
      </p>
    )
  }

  return <div className={buttons.length === 1 ? 'floor-actions floor-actions--single' : 'floor-actions'}>{buttons}</div>
}
