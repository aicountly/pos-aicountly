/**
 * What the Setup screen reads, and what it works out from it.
 *
 * Two halves, kept apart on purpose:
 *
 *   FETCHERS   thin wrappers over endpoints that already exist. Nothing here
 *              invents a summary endpoint; the counts are derived in the
 *              browser from lists the screen is showing anyway.
 *   DERIVATION pure functions over those lists. Every checklist tick, every
 *              percentage and every warning below can be traced to a row —
 *              there is no "looks about right" in this file, because a setup
 *              screen that says you are 80% done when you cannot yet take a
 *              sale is worse than one that says nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../services/api'
import type { PosSettings } from '../services/types'
import type { SetupDevice, SetupFloor, SetupOutlet, SetupTill, Warehouse } from './types'
import { isTableService, outletName, tillName } from './types'

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function fetchOutlets(signal?: AbortSignal): Promise<SetupOutlet[]> {
  const response = await api.one<{ locations: SetupOutlet[] }>('v1/locations', undefined, signal)
  return response.data.locations ?? []
}

export async function fetchTills(signal?: AbortSignal): Promise<SetupTill[]> {
  const response = await api.one<{ terminals: SetupTill[] }>('v1/terminals', undefined, signal)
  return response.data.terminals ?? []
}

export async function fetchDevices(signal?: AbortSignal): Promise<SetupDevice[]> {
  const response = await api.one<{ devices: SetupDevice[] }>('v1/devices', undefined, signal)
  return response.data.devices ?? []
}

export async function fetchFloors(signal?: AbortSignal): Promise<SetupFloor[]> {
  const response = await api.one<{ floors: SetupFloor[] }>('v1/floors', undefined, signal)
  return response.data.floors ?? []
}

/**
 * Tables per floor, from the floor plan.
 *
 * `v1/floors` is the authority on how many floors exist; the floor plan INNER
 * JOINs its tables, so a floor with none is absent from it. That difference is
 * not a bug to work around — it is exactly how "this floor has no tables yet"
 * is detected.
 */
export async function fetchTableCounts(signal?: AbortSignal): Promise<Map<number, number>> {
  const response = await api.one<{ floors: { floor_id: number; tables: unknown[] }[] }>(
    'v1/floor-plan',
    undefined,
    signal,
  )
  const counts = new Map<number, number>()
  for (const floor of response.data.floors ?? []) {
    counts.set(Number(floor.floor_id), Array.isArray(floor.tables) ? floor.tables.length : 0)
  }
  return counts
}

export async function fetchSettings(signal?: AbortSignal): Promise<PosSettings> {
  const response = await api.one<PosSettings>('v1/settings', undefined, signal)
  return response.data
}

// ---------------------------------------------------------------------------
// Inventory warehouses
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function firstNumber(row: Row, keys: string[]): number | null {
  for (const key of keys) {
    const raw = row[key]
    if (raw === null || raw === undefined || raw === '') continue
    const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function firstString(row: Row, keys: string[]): string | null {
  for (const key of keys) {
    const raw = row[key]
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
    if (typeof raw === 'number') return String(raw)
  }
  return null
}

function activeFlag(row: Row): boolean | null {
  for (const key of ['is_active', 'active', 'enabled']) {
    const raw = row[key]
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true
    if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false
  }
  const status = firstString(row, ['status'])
  if (status === null) return null
  return ['active', 'enabled', 'open'].includes(status.toLowerCase())
}

/**
 * Warehouses, as Inventory answers today and as it has answered before.
 *
 * The envelope and the column names are Inventory's to change, and this screen
 * is not worth breaking over a rename, so the shapes are all accepted and the
 * parsing lives in one place — the same argument as company/manageShapes.ts.
 */
export function parseWarehouses(body: unknown): Warehouse[] {
  let rows: unknown = body
  if (isRow(rows) && 'data' in rows) rows = (rows as Row).data
  if (isRow(rows)) {
    const nested = (rows as Row).warehouses ?? (rows as Row).items ?? (rows as Row).rows
    if (Array.isArray(nested)) rows = nested
  }
  if (!Array.isArray(rows)) return []

  const parsed: Warehouse[] = []
  for (const row of rows) {
    if (!isRow(row)) continue
    const id = firstNumber(row, ['warehouse_id', 'wh_id', 'id', 'store_id'])
    if (id === null) continue
    const name = firstString(row, ['warehouse_name', 'wh_name', 'name', 'display_name', 'store_name'])
    const code = firstString(row, ['warehouse_code', 'wh_code', 'code', 'short_code', 'alias'])
    parsed.push({
      id,
      // A warehouse with no name still has to be tellable apart from the next
      // one, and its code is a better handle than its primary key.
      name: name ?? code ?? `Warehouse ${id}`,
      code,
      isActive: activeFlag(row),
    })
  }

  return parsed
}

export async function fetchWarehouses(signal?: AbortSignal): Promise<Warehouse[]> {
  return parseWarehouses(await api.get<unknown>('v1/catalog/warehouses', undefined, signal))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * What `POST/PUT v1/locations` accepts.
 *
 * The controller drops any key whose value is null before it writes, so a null
 * here means "leave this alone", not "clear it". There is no way through this
 * API to unset a warehouse or a cash account once one is chosen — noted rather
 * than worked around, because working around it would mean a second endpoint.
 */
export interface OutletInput {
  location_code: string
  display_name: string
  pos_mode: string
  bo_id: number | null
  default_warehouse_id: number | null
  default_cash_account_id?: number | null
  service_charge_pc?: number
  tips_enabled?: boolean
  allow_negative_override?: boolean
  is_active?: boolean
}

export async function saveOutlet(input: OutletInput, outletId?: number): Promise<SetupOutlet> {
  const response = outletId
    ? await api.put<SetupOutlet>(`v1/locations/${outletId}`, input)
    : await api.post<SetupOutlet>('v1/locations', input)
  return response.data
}

export interface TillInput {
  location_id: number
  terminal_code: string
  display_name: string
  terminal_kind: string
  receipt_printer: string | null
  is_active?: boolean
}

export async function saveTill(input: TillInput, tillId?: number): Promise<SetupTill> {
  const response = tillId
    ? await api.put<SetupTill>(`v1/terminals/${tillId}`, input)
    : await api.post<SetupTill>('v1/terminals', input)
  return response.data
}

/**
 * Switch an outlet or a till on or off, and touch as little else as possible.
 *
 * The save endpoints take a whole row and ignore the keys that are absent, so
 * sending one field changes one field. Re-sending the rest — which is what a
 * shared save helper would do — risks writing a stale copy of the record over
 * whatever somebody changed in the meantime, for a toggle.
 *
 * `bo_id` is the exception, and it is not optional. api.ts merges the company
 * scope INTO every JSON body, so this request already carries the bo_id chosen
 * in the header — and the outlet endpoint reads bo_id from the body. Sending
 * the outlet's own branch back is what stops a manager whose header is set to
 * one branch from moving an outlet to it by switching it off.
 */
export async function setOutletActive(outlet: SetupOutlet, active: boolean): Promise<void> {
  await api.put(`v1/locations/${outlet.location_id}`, { bo_id: outlet.bo_id, is_active: active })
}

/** A till has no field the scope can collide with, so this really is one key. */
export async function setTillActive(tillId: number, active: boolean): Promise<void> {
  await api.put(`v1/terminals/${tillId}`, { is_active: active })
}

/**
 * Pair a device.
 *
 * The token comes back once and is never stored — not in this product's
 * database (only its sha256 is), not in localStorage, and not in the URL. It
 * lives in component state for as long as the drawer is open.
 */
export async function pairDevice(terminalId: number, label: string): Promise<{ device_id: number; device_token: string }> {
  const response = await api.post<{ device_id: number; device_token: string }>('v1/devices', {
    terminal_id: terminalId,
    device_uuid: crypto.randomUUID(),
    device_label: label.trim() === '' ? null : label.trim(),
  })
  return response.data
}

export async function revokeDevice(deviceId: number, reason: string): Promise<void> {
  await api.post(`v1/devices/${deviceId}/revoke`, { reason })
}

export async function createFloor(input: { location_id: number; floor_code: string; floor_name: string }): Promise<SetupFloor> {
  const response = await api.post<SetupFloor>('v1/floors', input)
  return response.data
}

export async function createTable(input: { floor_id: number; table_code: string; table_name: string | null; seats: number }): Promise<void> {
  await api.post('v1/tables', input)
}

export async function saveSettings(values: Partial<PosSettings>): Promise<PosSettings> {
  const response = await api.put<PosSettings>('v1/settings', values)
  return response.data
}

// ---------------------------------------------------------------------------
// Loading the whole screen
// ---------------------------------------------------------------------------

export interface SetupBundle {
  outlets: SetupOutlet[]
  tills: SetupTill[]
  devices: SetupDevice[]
  floors: SetupFloor[]
  tablesByFloor: Map<number, number>
  warehouses: Warehouse[]
}

const EMPTY: SetupBundle = {
  outlets: [],
  tills: [],
  devices: [],
  floors: [],
  tablesByFloor: new Map(),
  warehouses: [],
}

export interface SetupLoad {
  bundle: SetupBundle
  loading: boolean
  /** The screen itself could not be read. Outlets and tills are that screen. */
  error: string | null
  /** One dependency is down while the rest of the page is fine. */
  partial: { devices: string | null; floors: string | null; warehouses: string | null }
  /** The API refused the device list for this role, which is not a failure. */
  devicesDenied: boolean
  reload: () => Promise<void>
}

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

/**
 * Everything the screen needs, in one pass.
 *
 * Six requests in parallel rather than six waterfalls, and `allSettled` rather
 * than `all`: Inventory being unreachable must not blank the outlet list, it
 * must say that warehouse names are unavailable and leave the rest alone.
 */
export function useSetupData(enabled: boolean): SetupLoad {
  const [bundle, setBundle] = useState<SetupBundle>(EMPTY)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [devicesDenied, setDevicesDenied] = useState(false)
  const [partial, setPartial] = useState<SetupLoad['partial']>({ devices: null, floors: null, warehouses: null })

  // A screen that has been navigated away from must not keep painting: six
  // parallel requests can land well after the last one the user cared about.
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true)

    const [outlets, tills, devices, floors, tables, warehouses] = await Promise.allSettled([
      fetchOutlets(),
      fetchTills(),
      fetchDevices(),
      fetchFloors(),
      fetchTableCounts(),
      fetchWarehouses(),
    ])

    if (!live.current) return

    if (outlets.status === 'rejected' || tills.status === 'rejected') {
      setError(
        message(
          outlets.status === 'rejected' ? outlets.reason : (tills as PromiseRejectedResult).reason,
          'We could not load your POS setup.',
        ),
      )
      setLoading(false)
      return
    }

    // A role without terminal.manage may open this screen read-only; the API
    // refusing the device list is the role working, not an outage.
    const denied = devices.status === 'rejected' && devices.reason instanceof ApiError && devices.reason.status === 403
    setDevicesDenied(denied)

    setPartial({
      devices: devices.status === 'rejected' && !denied ? message(devices.reason, 'Devices are unavailable.') : null,
      floors: floors.status === 'rejected' ? message(floors.reason, 'Floors are unavailable.') : null,
      warehouses:
        warehouses.status === 'rejected'
          ? message(warehouses.reason, 'Unable to load warehouses from Inventory.')
          : null,
    })

    setBundle({
      outlets: outlets.value,
      tills: tills.value,
      devices: devices.status === 'fulfilled' ? devices.value : [],
      floors: floors.status === 'fulfilled' ? floors.value : [],
      tablesByFloor: tables.status === 'fulfilled' ? tables.value : new Map(),
      warehouses: warehouses.status === 'fulfilled' ? warehouses.value : [],
    })
    setError(null)
    setLoading(false)
  }, [enabled])

  useEffect(() => {
    void load()
  }, [load])

  return { bundle, loading, error, partial, devicesDenied, reload: load }
}

// ---------------------------------------------------------------------------
// Derivation — the checklist, the percentage, the warnings
// ---------------------------------------------------------------------------

export type Section = 'outlets' | 'tills' | 'devices'

export type StepId = 'outlet' | 'till' | 'device' | 'floors' | 'settings'

export type StepState = 'done' | 'todo' | 'optional' | 'not-required'

export interface ChecklistStep {
  id: StepId
  title: string
  description: string
  state: StepState
  accent: 'green' | 'blue' | 'purple' | 'orange' | 'rose'
}

export interface SetupWarning {
  id: string
  text: string
  action?: { label: string; section?: Section; outletId?: number; tillId?: number; openFloors?: boolean }
}

export interface NextAction {
  stepId: StepId
  title: string
  detail: string
  cta: string
}

export interface SetupSummary {
  outletCount: number
  tillCount: number
  deviceCount: number
  revokedDeviceCount: number
  floorCount: number
  tableCount: number
  /** Outlets that seat people, and therefore need a floor before service. */
  tableServiceOutlets: SetupOutlet[]
  steps: ChecklistStep[]
  progress: { done: number; total: number; pc: number }
  complete: boolean
  nextAction: NextAction | null
  warnings: SetupWarning[]
}

const active = <T extends { is_active?: boolean }>(rows: T[]): T[] => rows.filter((row) => row.is_active !== false)

/**
 * The whole of the screen's intelligence, as one pure function.
 *
 * A step is COMPLETE only when the thing it describes exists and is usable —
 * an outlet that is switched off does not tick "create an outlet", and a
 * revoked device does not tick "pair a device". A step that does not apply to
 * this business is NOT-REQUIRED, which is different from incomplete and is
 * left out of the percentage rather than counted as a failure.
 */
export function summarise(bundle: SetupBundle): SetupSummary {
  const activeOutlets = active(bundle.outlets)
  const activeTills = active(bundle.tills)
  const activeDevices = bundle.devices.filter((device) => device.status === 'ACTIVE')
  const revoked = bundle.devices.filter((device) => device.status !== 'ACTIVE')

  const outletById = new Map(bundle.outlets.map((outlet) => [outlet.location_id, outlet]))
  const tableServiceOutlets = activeOutlets.filter((outlet) => isTableService(outlet.pos_mode))
  const floorsByOutlet = new Map<number, SetupFloor[]>()
  for (const floor of bundle.floors) {
    if (floor.is_active === false) continue
    const list = floorsByOutlet.get(floor.location_id) ?? []
    list.push(floor)
    floorsByOutlet.set(floor.location_id, list)
  }

  const tableCount = [...bundle.tablesByFloor.values()].reduce((sum, n) => sum + n, 0)

  // A till only counts once it belongs to an outlet that is switched on —
  // a till on a disabled outlet cannot open a shift.
  const usableTills = activeTills.filter((till) => outletById.get(till.location_id)?.is_active !== false)
  const tillsWithoutDevice = usableTills.filter(
    (till) => !activeDevices.some((device) => device.terminal_id === till.terminal_id),
  )
  const outletsWithoutWarehouse = activeOutlets.filter((outlet) => !outlet.default_warehouse_id)
  const outletsNeedingFloor = tableServiceOutlets.filter((outlet) => (floorsByOutlet.get(outlet.location_id) ?? []).length === 0)

  const floorsState: StepState =
    tableServiceOutlets.length === 0 ? 'not-required' : outletsNeedingFloor.length === 0 ? 'done' : 'todo'

  const steps: ChecklistStep[] = [
    {
      id: 'outlet',
      title: 'Create an outlet',
      description: 'Add your shop, restaurant or counter',
      state: activeOutlets.length > 0 ? 'done' : 'todo',
      accent: 'green',
    },
    {
      id: 'till',
      title: 'Add a till',
      description: 'Configure billing till and assign location',
      state: usableTills.length > 0 ? 'done' : 'todo',
      accent: 'blue',
    },
    {
      id: 'device',
      title: 'Pair a device',
      description: 'Connect your POS device (PC, tablet, etc.)',
      state: activeDevices.length > 0 ? 'done' : 'todo',
      accent: 'purple',
    },
    {
      id: 'floors',
      title: floorsState === 'not-required' ? 'Set up floors/tables' : 'Set up floors and tables',
      description:
        floorsState === 'not-required'
          ? 'Not required — no table-service outlet'
          : 'Required for restaurant operations',
      state: floorsState,
      accent: 'orange',
    },
    {
      // Settings has real defaults and the API cannot say whether they were
      // reviewed, so this step is never ticked automatically. Marking it done
      // on a page visit would be the screen lying to the next administrator.
      id: 'settings',
      title: 'Configure other settings',
      description: 'Receipts, numbering, discounts and returns',
      state: 'optional',
      accent: 'rose',
    },
  ]

  const counted = steps.filter((step) => step.state === 'done' || step.state === 'todo')
  const done = counted.filter((step) => step.state === 'done').length
  const total = counted.length
  const pc = total === 0 ? 100 : Math.round((done / total) * 100)

  // -------------------------------------------------------------- next action
  let nextAction: NextAction | null = null
  const firstTodo = steps.find((step) => step.state === 'todo')

  if (firstTodo?.id === 'outlet') {
    nextAction = {
      stepId: 'outlet',
      title: 'Create your first outlet',
      detail: 'An outlet is a selling place — a shop, a restaurant or a counter inside another business.',
      cta: 'Add outlet',
    }
  } else if (firstTodo?.id === 'till') {
    const target = activeOutlets[0]
    nextAction = {
      stepId: 'till',
      title: target ? `Add a till to ${outletName(target)}` : 'Add a till',
      detail: 'A till is where a shift opens and a bill is raised. Nothing can be sold until one exists.',
      cta: 'Add till',
    }
  } else if (firstTodo?.id === 'device') {
    const target = usableTills[0]
    nextAction = {
      stepId: 'device',
      title: target ? `Pair a device with ${tillName(target)}` : 'Pair a device',
      detail: 'Pairing issues a one-time token so this machine can keep selling while it is offline.',
      cta: 'Pair device',
    }
  } else if (firstTodo?.id === 'floors') {
    const target = outletsNeedingFloor[0]
    nextAction = {
      stepId: 'floors',
      title: target ? `Set up floors for ${outletName(target)}` : 'Set up floors and tables',
      detail: 'A table-service outlet needs at least one floor before anyone can be seated.',
      cta: 'Add floor',
    }
  }

  // ----------------------------------------------------------------- warnings
  const warnings: SetupWarning[] = []

  for (const outlet of outletsWithoutWarehouse) {
    warnings.push({
      id: `warehouse-${outlet.location_id}`,
      text: `${outletName(outlet)} has no stock source. A sale here cannot tell Inventory which warehouse the goods left.`,
      action: { label: 'Choose warehouse', section: 'outlets', outletId: outlet.location_id },
    })
  }

  for (const outlet of outletsNeedingFloor) {
    warnings.push({
      id: `floor-${outlet.location_id}`,
      text: `${outletName(outlet)} runs table service but has no floor, so nobody can be seated.`,
      action: { label: 'Add a floor', openFloors: true },
    })
  }

  for (const till of tillsWithoutDevice) {
    warnings.push({
      id: `device-${till.terminal_id}`,
      text: `${tillName(till)} has no paired device, so it cannot sell while the connection is down.`,
      action: { label: 'Pair a device', section: 'devices', tillId: till.terminal_id },
    })
  }

  for (const [floorId, count] of bundle.tablesByFloor) {
    if (count > 0) continue
    const floor = bundle.floors.find((row) => row.floor_id === floorId)
    if (!floor) continue
    warnings.push({
      id: `tables-${floorId}`,
      text: `${floor.floor_name} has no tables yet.`,
      action: { label: 'Add tables', openFloors: true },
    })
  }
  // A floor absent from the floor plan has no tables at all — the plan inner
  // joins them — so the loop above cannot see it and this one does.
  for (const floor of bundle.floors) {
    if (floor.is_active === false) continue
    if (bundle.tablesByFloor.has(floor.floor_id)) continue
    warnings.push({
      id: `tables-${floor.floor_id}`,
      text: `${floor.floor_name} has no tables yet.`,
      action: { label: 'Add tables', openFloors: true },
    })
  }

  for (const outlet of bundle.outlets) {
    if (outlet.is_active !== false) continue
    const stranded = bundle.tills.filter((till) => till.location_id === outlet.location_id && till.is_active !== false)
    if (stranded.length === 0) continue
    warnings.push({
      id: `inactive-${outlet.location_id}`,
      text: `${outletName(outlet)} is switched off, but ${stranded.length} till${stranded.length === 1 ? '' : 's'} still point${stranded.length === 1 ? 's' : ''} at it.`,
      action: { label: 'Review tills', section: 'tills' },
    })
  }

  return {
    outletCount: activeOutlets.length,
    tillCount: usableTills.length,
    deviceCount: activeDevices.length,
    revokedDeviceCount: revoked.length,
    floorCount: bundle.floors.filter((floor) => floor.is_active !== false).length,
    tableCount,
    tableServiceOutlets,
    steps,
    progress: { done, total, pc },
    complete: done === total,
    nextAction,
    warnings,
  }
}
