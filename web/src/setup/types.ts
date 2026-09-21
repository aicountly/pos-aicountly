/**
 * The shapes the Setup screen reads.
 *
 * `Location` and `Terminal` in services/types.ts are the SESSION's view of an
 * outlet and a till — the subset a cashier's screen needs, which deliberately
 * leaves out `is_active` because the session only ever returns active rows.
 * The admin endpoints return the whole row, so the two extra fields are stated
 * here rather than loosened there; widening the session type would let a
 * till screen believe it had been told whether an outlet was switched off.
 */

import type { Location, PosSettings, Terminal } from '../services/types'

/** `GET v1/locations` — SELECT * FROM pos_location_profiles. */
export interface SetupOutlet extends Location {
  is_active?: boolean
  walk_in_account_id?: number | null
  created_at?: string | null
}

/** `GET v1/terminals` — the row, plus its outlet's code and any open shift. */
export interface SetupTill extends Terminal {
  is_active?: boolean
  location_code?: string | null
}

/**
 * `GET v1/devices`.
 *
 * `last_seen_at` is in the table and is NEVER WRITTEN by this product — see
 * docs/DASHBOARDS.md, "No device connection status". It is carried here so the
 * screen can say so out loud rather than quietly rendering a green dot.
 */
export interface SetupDevice {
  device_id: number
  terminal_id: number
  device_uuid: string
  device_label: string | null
  /** ACTIVE | REVOKED */
  status: string
  last_seen_at: string | null
  registered_by?: string | null
  revoked_at?: string | null
  revoked_reason: string | null
  created_at?: string | null
}

/** `GET v1/floors`. */
export interface SetupFloor {
  floor_id: number
  location_id: number
  floor_code: string
  floor_name: string
  sort_order?: number
  is_active?: boolean
}

/**
 * One Inventory warehouse, normalised.
 *
 * POS holds `warehouse_id` and nothing else — the name and code below are
 * fetched to be shown and are never written down, exactly like the item name
 * on the till. See docs/ARCHITECTURE.md.
 */
export interface Warehouse {
  id: number
  name: string
  code: string | null
  isActive: boolean | null
}

export type { PosSettings }

/** Which POS modes seat people at tables, and therefore need a floor. */
export const TABLE_SERVICE_MODES = ['restaurant', 'hybrid'] as const

export function isTableService(mode: string): boolean {
  return (TABLE_SERVICE_MODES as readonly string[]).includes(mode)
}

export function outletName(outlet: { display_name: string | null; location_code: string }): string {
  return outlet.display_name?.trim() || outlet.location_code
}

export function tillName(till: { display_name: string | null; terminal_code: string }): string {
  return till.display_name?.trim() || till.terminal_code
}

export function deviceName(device: SetupDevice): string {
  return device.device_label?.trim() || `Device ${device.device_uuid.slice(0, 8)}`
}

export const POS_MODE_LABELS: Record<string, string> = {
  retail: 'Retail counter',
  restaurant: 'Restaurant',
  quick_service: 'Quick service',
  hybrid: 'Both',
}

export const TERMINAL_KIND_LABELS: Record<string, string> = {
  counter: 'Counter',
  kiosk: 'Kiosk',
  waiter_tablet: 'Waiter tablet',
  kds: 'Kitchen display',
  customer_display: 'Customer display',
}
