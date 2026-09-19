/**
 * The home screen's view model.
 *
 * Every function here is pure and takes what the API already returned. Nothing
 * in this file fetches, and nothing in it invents: where POS cannot answer a
 * question the answer is `unknown` or an explicit note, never a zero and never
 * a green tick. That rule is the whole reason this file exists separately from
 * the components — it is the part worth reading twice.
 *
 * The three facts this screen is built to answer, in order:
 *   1. Can this counter sell right now?
 *   2. What is in the way?
 *   3. What happened today?
 */

import type { Location, RegisterSession, Terminal } from '../services/types'
import type { InsightItem, OverviewBoard, RetailBoard } from '../dashboards/types'
import { money } from '../dashboards/format'

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'neutral'

/** Which hero the page shows. The order below is the order they unlock in. */
export type HeroKind = 'setup' | 'choose-till' | 'ready' | 'live'

export function greetingFor(now: Date): string {
  const hour = now.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'

  return 'Good evening'
}

export function heroKind(input: {
  terminals: Terminal[]
  terminalId: number | null
  shift: RegisterSession | null
}): HeroKind {
  if (input.terminals.length === 0) return 'setup'

  // The chosen till is remembered per BROWSER and the company is not: a till id
  // left over from another company, or from one that has since been removed,
  // is not a till this screen may claim to be standing at.
  const chosen = input.terminals.some((terminal) => terminal.terminal_id === input.terminalId)
  if (!chosen) return 'choose-till'

  if (input.shift === null || input.shift.status !== 'OPEN') return 'ready'

  return 'live'
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

export type HealthId =
  | 'application'
  | 'sync'
  | 'payments'
  | 'receipt_printer'
  | 'cash_drawer'
  | 'kitchen_display'

export interface HealthRow {
  id: HealthId
  label: string
  status: string
  tone: Tone
  /** The sentence that stops the row being read as something it is not. */
  note?: string
}

export interface HealthInput {
  online: boolean
  syncing: boolean
  /** Sales this browser is still holding, from IndexedDB. */
  queuedLocal: number
  /** Offline sales the server has taken but not posted. Null when not asked. */
  pendingServer: number | null
  lastSyncedAt: Date | null
  terminal: Terminal | null
  devices: RetailBoard['devices'] | null
  outletMode: Location['pos_mode'] | null
}

const NOT_VERIFIED = 'What the till is configured with. A browser cannot check whether it is plugged in.'

/**
 * Peripheral state across the tills in view.
 *
 * With one till chosen, that till answers. With none chosen the question is
 * about the shop, so the answer counts tills rather than picking one.
 */
function peripheral(
  devices: RetailBoard['devices'] | null,
  terminal: Terminal | null,
  kind: string,
): { status: string; tone: Tone } {
  if (!devices) return { status: 'Unknown', tone: 'neutral' }

  const rows = terminal
    ? devices.terminals.filter((t) => t.terminal_id === terminal.terminal_id)
    : devices.terminals

  if (rows.length === 0) return { status: 'No till', tone: 'neutral' }

  const configured = rows.filter((t) =>
    t.peripherals.some((p) => p.kind === kind && p.state === 'configured'),
  ).length

  if (rows.length === 1) {
    return configured === 1 ? { status: 'Configured', tone: 'ok' } : { status: 'Not configured', tone: 'warn' }
  }
  if (configured === rows.length) return { status: `All ${rows.length} tills`, tone: 'ok' }
  if (configured === 0) return { status: `None of ${rows.length} tills`, tone: 'warn' }

  return { status: `${configured} of ${rows.length} tills`, tone: 'info' }
}

export function buildHealth(input: HealthInput): {
  rows: HealthRow[]
  attention: number
  summary: { label: string; tone: Tone }
} {
  const rows: HealthRow[] = []

  rows.push(
    input.online
      ? { id: 'application', label: 'POS application', status: 'Online', tone: 'ok' }
      : {
          id: 'application',
          label: 'POS application',
          status: 'Offline',
          tone: 'warn',
          note: 'The till keeps selling. Sales are held here and sent up when the line is back.',
        },
  )

  rows.push({ id: 'sync', label: 'Data sync', ...syncState(input) })

  // POS integrates no payment provider, so there is no gateway to report on.
  // Saying "Operational" here would be the single most misleading word on the
  // screen: it would claim a collection nobody has confirmed.
  rows.push({
    id: 'payments',
    label: 'Payments',
    status: 'Recorded only',
    tone: 'neutral',
    note: 'POS integrates no payment provider. Card and UPI are references a cashier typed from the terminal slip.',
  })

  const printer = input.terminal
    ? input.terminal.receipt_printer
      ? { status: 'Configured', tone: 'ok' as Tone }
      : { status: 'Not configured', tone: 'warn' as Tone }
    : peripheral(input.devices, null, 'receipt_printer')

  rows.push({ id: 'receipt_printer', label: 'Receipt printer', ...printer, note: NOT_VERIFIED })
  rows.push({
    id: 'cash_drawer',
    label: 'Cash drawer',
    ...peripheral(input.devices, input.terminal, 'cash_drawer'),
    note: NOT_VERIFIED,
  })

  const servesFood =
    input.outletMode === 'restaurant' || input.outletMode === 'quick_service' || input.outletMode === 'hybrid'

  rows.push({
    id: 'kitchen_display',
    label: 'Kitchen display',
    ...(servesFood
      ? peripheral(input.devices, input.terminal, 'kot_printers')
      : { status: 'Not used here', tone: 'neutral' as Tone }),
    note: servesFood ? NOT_VERIFIED : 'This outlet does not run kitchen tickets.',
  })

  const attention = rows.filter((row) => row.tone === 'warn' || row.tone === 'bad').length
  const unknown = rows.filter((row) => row.status === 'Unknown').length

  return {
    rows,
    attention,
    // "All systems operational" over a row POS could not read would be the
    // most reassuring false sentence on the page.
    summary:
      attention > 0
        ? { label: `${attention} need${attention === 1 ? 's' : ''} attention`, tone: 'warn' }
        : unknown > 0
          ? { label: 'Some checks unavailable', tone: 'neutral' }
          : { label: 'All systems operational', tone: 'ok' },
  }
}

function syncState(input: HealthInput): { status: string; tone: Tone; note?: string } {
  if (input.syncing) return { status: 'Syncing…', tone: 'info' }

  const waiting = input.queuedLocal + Math.max(0, input.pendingServer ?? 0)

  if (!input.online) {
    return waiting > 0
      ? { status: `${waiting} waiting`, tone: 'warn', note: 'Held on this till until the connection is back.' }
      : { status: 'Waiting for the connection', tone: 'warn' }
  }
  if (input.queuedLocal > 0) {
    return {
      status: `${input.queuedLocal} to send`,
      tone: 'warn',
      note: 'Sales this till took offline. Each carries an id, so sending twice cannot bill twice.',
    }
  }
  if ((input.pendingServer ?? 0) > 0) {
    return { status: `${input.pendingServer} not posted`, tone: 'warn', note: 'Received here, not yet in Books or Inventory.' }
  }

  return {
    status: 'Synced',
    tone: 'ok',
    note: input.lastSyncedAt ? `Figures read at ${input.lastSyncedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.` : undefined,
  }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string
  title: string
  body: string
  tone: Tone
  action?: { label: string; to: string }
}

export interface SuggestionInput {
  serverInsights: InsightItem[] | null
  tillsExist: boolean
  outletsExist: boolean
  shiftOpen: boolean
  queuedLocal: number
  pendingServer: number | null
  pendingReturns: number | null
  heldBills: number
  heldValue: number
  printerConfigured: boolean | null
  can: (permission: string) => boolean
}

/**
 * What to do next, computed from what is on this screen.
 *
 * Every item is a threshold crossing over rows POS owns. None is a prediction,
 * none is model-generated, and the card says so — an "AI" badge over a count is
 * how people stop believing the badge anywhere.
 */
export function buildSuggestions(input: SuggestionInput): Suggestion[] {
  const items: Suggestion[] = []

  if (input.queuedLocal > 0) {
    items.push({
      id: 'offline-queue',
      title: `${input.queuedLocal} sale${input.queuedLocal === 1 ? '' : 's'} waiting to sync`,
      body: 'Taken while this till was offline and still held on this device.',
      tone: 'warn',
      action: input.can('offline.resolve') || input.can('reports.view') ? { label: 'Review', to: '/offline' } : undefined,
    })
  }

  if (!input.tillsExist) {
    items.push({
      id: 'setup-till',
      title: input.outletsExist ? 'Complete till setup' : 'Set up your first outlet',
      body: input.outletsExist
        ? 'Add the counter this browser stands at to start selling.'
        : 'An outlet and its first till are what a sale is recorded against.',
      tone: 'info',
      action: input.can('terminal.manage') ? { label: 'Set up', to: '/setup' } : undefined,
    })
  } else if (!input.shiftOpen) {
    items.push({
      id: 'open-shift',
      title: 'Open a shift to begin selling',
      body: 'Counting the drawer now is what makes the close-out mean something.',
      tone: 'info',
      action: { label: 'Open', to: '/till' },
    })
  }

  for (const insight of input.serverInsights ?? []) {
    items.push({
      id: insight.id,
      title: insight.title,
      body: insight.explanation,
      tone: toneFromSeverity(insight.severity),
      action:
        insight.evidence_href && input.can('reports.view')
          ? { label: 'View', to: insight.evidence_href }
          : undefined,
    })
  }

  if (input.heldBills > 0) {
    items.push({
      id: 'held-bills',
      title: `${input.heldBills} held sale${input.heldBills === 1 ? '' : 's'} on the counter`,
      body: `Put aside and not yet paid — ${money(input.heldValue)} in total.`,
      tone: 'info',
      action: input.can('sell') ? { label: 'Reopen', to: '/till' } : undefined,
    })
  }

  if ((input.pendingReturns ?? 0) > 0) {
    items.push({
      id: 'pending-returns',
      title: `${input.pendingReturns} return${input.pendingReturns === 1 ? '' : 's'} waiting on someone`,
      body: 'Brought back and not yet approved or settled.',
      tone: 'warn',
      action: input.can('return.create') ? { label: 'Review', to: '/returns' } : undefined,
    })
  }

  if (input.tillsExist && input.printerConfigured === false) {
    items.push({
      id: 'printer',
      title: 'This till has no receipt printer set',
      body: 'Sales can still be taken; there is nothing configured to print them on.',
      tone: 'info',
      action: input.can('terminal.manage') ? { label: 'Set up', to: '/setup' } : undefined,
    })
  }

  return items.slice(0, 4)
}

function toneFromSeverity(severity: InsightItem['severity']): Tone {
  if (severity === 'danger') return 'bad'
  if (severity === 'warning') return 'warn'
  if (severity === 'success') return 'ok'

  return 'info'
}

// ---------------------------------------------------------------------------
// Outlet readiness
// ---------------------------------------------------------------------------

export interface OutletRow {
  id: number
  name: string
  mode: string
  ready: boolean
  /** Why it is not ready, or what it took today. */
  note: string
  tills: number
}

/**
 * Whether an outlet can take money.
 *
 * ONE condition decides it: a till. That is the condition the application
 * itself enforces — Till.tsx will not sell without one — and inventing further
 * mandatory setup here would put outlets into a "not ready" state the rest of
 * the product does not recognise. Anything else worth saying is said in the
 * note instead.
 */
export function buildOutlets(
  locations: Location[],
  terminals: Terminal[],
  board: OverviewBoard | null,
): OutletRow[] {
  return locations.map((location) => {
    const tills = terminals.filter((t) => t.location_id === location.location_id).length
    const takings = board?.outlets.find((o) => o.location_id === location.location_id) ?? null

    const gaps: string[] = []
    if (tills === 0) gaps.push('No till yet')
    if (location.default_warehouse_id === null) gaps.push('stock source not set')

    return {
      id: location.location_id,
      name: location.display_name ?? location.location_code,
      mode: location.pos_mode.replace(/_/g, ' '),
      ready: tills > 0,
      note:
        gaps.length > 0
          ? gaps.join(' · ')
          : takings
            ? `${tills} till${tills === 1 ? '' : 's'} · ${money(takings.net)} today`
            : `${tills} till${tills === 1 ? '' : 's'} ready`,
      tills,
    }
  })
}

// ---------------------------------------------------------------------------
// Shifts on now
// ---------------------------------------------------------------------------

export interface ShiftRow {
  id: number
  till: string
  outlet: string
  who: string
  openedAt: string
  expectedCash: number
  busy: boolean
}

export function buildShifts(board: RetailBoard | null, meUuid: string | null, myName: string | null): ShiftRow[] {
  if (!board) return []

  return board.counters
    .filter((counter) => counter.shift !== null)
    .map((counter) => {
      const shift = counter.shift!

      return {
        id: shift.session_id,
        till: counter.display_name,
        outlet: counter.location_name,
        who: meUuid && shift.opened_by === meUuid && myName ? myName : shortActor(shift.opened_by),
        openedAt: shift.opened_at,
        expectedCash: shift.expected_cash,
        busy: counter.state === 'busy',
      }
    })
}

/** A uuid, shortened, without pretending it is a name. */
function shortActor(uuid: string | null): string {
  if (!uuid) return 'Unknown'

  return uuid.length > 10 ? `User ${uuid.slice(0, 6)}` : uuid
}

export function initialsFor(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2)

  return `${words[0][0]}${words[words.length - 1][0]}`
}

// ---------------------------------------------------------------------------
// The sales series
// ---------------------------------------------------------------------------

export interface TrendPoint {
  label: string
  value: number
  comparison?: number | null
}

export type TrendPeriod = 'today' | 'week' | 'month'

/** "09:00" from the server becomes "9am", which is how a counter reads a clock. */
export function hourLabel(bucket: string): string {
  const hour = Number.parseInt(bucket.slice(0, 2), 10)
  if (!Number.isFinite(hour)) return bucket
  if (hour === 0) return '12am'
  if (hour === 12) return '12pm'

  return hour < 12 ? `${hour}am` : `${hour - 12}pm`
}

function dayLabel(bucket: string): string {
  const parsed = new Date(`${bucket}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return bucket

  return parsed.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

/**
 * The line to draw.
 *
 * Hours between the first sale and now that took nothing are filled with zero,
 * because a quiet hour is a fact about the day and a line that skips it implies
 * the shop was shut. Hours that have not happened yet are NOT filled: a flat
 * run to midnight would read as trade collapsing.
 */
export function buildTrend(
  series: OverviewBoard['series'] | null,
  now: Date,
): TrendPoint[] {
  if (!series || series.points.length === 0) return []

  const byBucket = new Map(series.points.map((point) => [point.bucket, point.net]))
  const comparison = series.comparison_by_bucket ?? null

  if (series.bucket === 'day') {
    return series.points.map((point) => ({
      label: dayLabel(point.bucket),
      value: point.net,
      comparison: comparison?.[point.bucket] ?? null,
    }))
  }

  const hours = series.points
    .map((point) => Number.parseInt(point.bucket.slice(0, 2), 10))
    .filter((hour) => Number.isFinite(hour))

  // A bucket this browser could not read is still a figure the shop took, so
  // the points are drawn as they came rather than dropped.
  if (hours.length === 0) {
    return series.points.map((point) => ({ label: point.bucket, value: point.net, comparison: comparison?.[point.bucket] ?? null }))
  }

  const first = Math.min(...hours)
  const last = Math.max(Math.max(...hours), now.getHours())
  const points: TrendPoint[] = []

  for (let hour = first; hour <= last; hour++) {
    const bucket = `${String(hour).padStart(2, '0')}:00`
    points.push({
      label: hourLabel(bucket),
      value: byBucket.get(bucket) ?? 0,
      comparison: comparison?.[bucket] ?? null,
    })
  }

  return points
}

/** The window a period asks the board for, as the API's own date strings. */
export function windowFor(period: TrendPeriod, now: Date): { from: string; to: string } {
  const to = isoDate(now)
  if (period === 'today') return { from: to, to }

  const start = new Date(now)
  if (period === 'week') start.setDate(start.getDate() - 6)
  else start.setDate(start.getDate() - 29)

  return { from: isoDate(start), to }
}

export function isoDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}
