/**
 * What a table's status means, in one place.
 *
 * Every screen that paints a table reads this map rather than testing the
 * status string itself. The rule it enforces is the accessibility one: a status
 * is never a colour on its own — it always carries a word and an icon, because
 * a green square and an amber square are the same square to a great many
 * people, and a floor plan that can only be read in colour is a floor plan half
 * the staff cannot read.
 */

import {
  CalendarClock,
  CircleDashed,
  Sparkles,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { FloorPlanFloor, FloorPlanTable, TableStatus } from '../../services/types'

export interface TableStatusConfig {
  /** The word on the badge. Never omitted. */
  label: string
  /** Modifier appended to the CSS block: .floor-table--available and so on. */
  modifier: string
  icon: LucideIcon
  /** Read out after the table number in the accessible label. */
  sentence: string
}

export const TABLE_STATUS: Record<TableStatus, TableStatusConfig> = {
  FREE: {
    label: 'Available',
    modifier: 'available',
    icon: CircleDashed,
    sentence: 'available',
  },
  OCCUPIED: {
    label: 'Occupied',
    modifier: 'occupied',
    icon: Users,
    sentence: 'occupied',
  },
  RESERVED: {
    label: 'Reserved',
    modifier: 'reserved',
    icon: CalendarClock,
    sentence: 'reserved',
  },
  CLEANING: {
    label: 'Cleaning',
    modifier: 'cleaning',
    icon: Sparkles,
    sentence: 'being cleaned',
  },
  OUT_OF_SERVICE: {
    label: 'Out of service',
    modifier: 'out-of-service',
    icon: Wrench,
    sentence: 'out of service',
  },
}

/** The order the legend and the filters use. Busiest first is not it — this is the life of a table. */
export const STATUS_ORDER: TableStatus[] = ['FREE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'OUT_OF_SERVICE']

export function statusOf(status: TableStatus): TableStatusConfig {
  return TABLE_STATUS[status] ?? TABLE_STATUS.FREE
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export interface Occupancy {
  total: number
  occupied: number
  available: number
  reserved: number
  cleaning: number
  outOfService: number
  /** Guests currently seated. */
  covers: number
  percent: number
}

/**
 * How full the floor is.
 *
 * Occupancy counts tables with a party at them and nothing else. A table being
 * wiped down is not occupied — it is unavailable, which is a different number
 * and is reported separately. Rolling them together flatters the figure and
 * hides the one a manager acts on.
 */
export function occupancyOf(tables: FloorPlanTable[]): Occupancy {
  let occupied = 0
  let reserved = 0
  let cleaning = 0
  let outOfService = 0
  let covers = 0

  for (const table of tables) {
    switch (table.status) {
      case 'OCCUPIED':
        occupied++
        covers += table.covers ?? 0
        break
      case 'RESERVED':
        reserved++
        break
      case 'CLEANING':
        cleaning++
        break
      case 'OUT_OF_SERVICE':
        outOfService++
        break
    }
  }

  const total = tables.length

  return {
    total,
    occupied,
    reserved,
    cleaning,
    outOfService,
    covers,
    available: total - occupied - reserved - cleaning - outOfService,
    percent: total > 0 ? Math.round((occupied / total) * 100) : 0,
  }
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export interface Zone {
  /** The zone name, or '' for tables nobody has put in a zone. */
  id: string
  name: string
  tableCount: number
}

/**
 * The zones on a floor, in the order their tables appear.
 *
 * A zone is a label on a table rather than a record of its own, so this is
 * derived rather than fetched: a shop that invents "Terrace" on a Tuesday gets
 * a Terrace filter on Tuesday.
 */
export function zonesOf(tables: FloorPlanTable[]): Zone[] {
  const seen = new Map<string, Zone>()

  for (const table of tables) {
    const name = table.zone_name?.trim() ?? ''
    const id = name.toLowerCase()
    const existing = seen.get(id)
    if (existing) existing.tableCount++
    else seen.set(id, { id, name: name === '' ? 'Unzoned' : name, tableCount: 1 })
  }

  return [...seen.values()].sort((a, b) => {
    // Unzoned last: it is a gap in the setup, not a part of the room.
    if (a.id === '') return 1
    if (b.id === '') return -1
    return a.name.localeCompare(b.name)
  })
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Minutes since an instant, or null when there is no instant to count from.
 *
 * Returns null rather than 0 for a missing timestamp, so "seated a moment ago"
 * and "we do not know when this was seated" do not render identically.
 */
export function minutesSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const started = new Date(iso).getTime()
  if (Number.isNaN(started)) return null

  return Math.max(0, Math.floor((now - started) / 60000))
}

/** 42m, 1h 20m, 3h. Short enough to sit inside a table on the plan. */
export function shortDuration(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** The same, said in full, for a screen reader and a tooltip. */
export function longDuration(minutes: number | null): string {
  if (minutes === null) return 'an unknown length of time'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourText = `${hours} hour${hours === 1 ? '' : 's'}`

  return rest === 0 ? hourText : `${hourText} ${rest} minute${rest === 1 ? '' : 's'}`
}

/** 11:42 AM. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'

  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(at)
}

/** 19 Sep 2026, 12:24 PM. */
export function stamp(at: Date | null): string {
  if (!at) return '—'

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at)
}

/**
 * How long a party may sit before the floor is nudged about them.
 *
 * Not a rule and not a warning — a table over the turn time is shown with a
 * quiet marker, never a flashing one. The number is a house default because POS
 * has no per-outlet setting for it; when one exists this is where it is read.
 */
export const TURN_TIME_MINUTES = 90

/** A booking this close is the one the floor is about to have to seat. */
export const RESERVATION_SOON_MINUTES = 30

export function isOverdue(table: FloorPlanTable, now = Date.now()): boolean {
  if (table.status !== 'OCCUPIED') return false
  const minutes = minutesSince(table.opened_at, now)

  return minutes !== null && minutes > TURN_TIME_MINUTES
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/**
 * Does this table answer to what was typed.
 *
 * Deliberately broad: a captain types "Ramesh" as readily as "12", and a
 * manager looking for an order types the order number. Everything the row
 * already knows is searchable; nothing extra is fetched to make it so.
 */
export function tableMatches(table: FloorPlanTable, floor: FloorPlanFloor, needle: string): boolean {
  const query = needle.trim().toLowerCase()
  if (query === '') return true

  const haystack = [
    table.table_code,
    table.table_name,
    table.zone_name,
    table.waiter_name,
    floor.floor_name,
    floor.floor_code,
    table.cart_id === null ? null : `#${table.cart_id}`,
    table.cart_id === null ? null : String(table.cart_id),
    table.reservation?.guest_name,
    table.reservation?.guest_mobile,
    table.reservation?.reservation_no,
    statusOf(table.status).label,
  ]

  return haystack.some((value) => value != null && value.toLowerCase().includes(query))
}

/** What goes inside the table on the plan: short, because it has to fit. */
export function tableLabel(table: FloorPlanTable): string {
  return table.table_name?.trim() || table.table_code
}

/**
 * What the table is called in a heading or a sentence.
 *
 * "Table 6" rather than "6" when the code is only a number, because a lone
 * numeral is a heading that reads as a quantity. A table already named Booth 3
 * is left alone.
 */
export function tableTitle(table: FloorPlanTable): string {
  const label = tableLabel(table)

  return /^\d+$/.test(label) ? `Table ${label}` : label
}

/**
 * What a screen reader says about a table.
 *
 * "Table 6, Main Dining, occupied, four seats, occupied for 42 minutes" —
 * everything the sighted eye takes from the colour, the icon and the position,
 * said in one sentence.
 */
export function tableAriaLabel(table: FloorPlanTable, now = Date.now()): string {
  const parts = [tableTitle(table)]

  if (table.zone_name) parts.push(table.zone_name)
  parts.push(statusOf(table.status).sentence)
  parts.push(`${table.seats} seat${table.seats === 1 ? '' : 's'}`)

  if (table.status === 'OCCUPIED') {
    const minutes = minutesSince(table.opened_at, now)
    if (minutes !== null) parts.push(`occupied for ${longDuration(minutes)}`)
    if (table.covers) parts.push(`${table.covers} guest${table.covers === 1 ? '' : 's'}`)
  }
  if (table.status === 'RESERVED' && table.reservation) {
    parts.push(`held for ${table.reservation.guest_name ?? 'a booking'} at ${clockTime(table.reservation.reserved_for)}`)
  }
  if (table.status === 'OUT_OF_SERVICE' && table.service_note) {
    parts.push(table.service_note)
  }

  return parts.join(', ')
}
