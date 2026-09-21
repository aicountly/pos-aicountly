/**
 * The Cash, Shifts & Controls view models.
 *
 * One board endpoint arrives; six widgets need six different readings of it.
 * Every value below is either a figure the server sent or an arithmetic
 * regrouping of figures the server sent — there is no local store, no second
 * source and no invented field.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no "vs yesterday" here. The controls
 * endpoint does not compute a comparison window, and a trend line derived from
 * one window is a guess wearing a percentage sign. The KPI cards carry a
 * factual second line instead.
 *
 * NULL SURVIVES. `counted_cash` and `variance` are null while a drawer is
 * uncounted and stay null all the way to the screen. Collapsing either to zero
 * would report a balanced till nobody has looked in.
 */

import type { ControlsBoard } from '../types'

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

export interface ControlsKpis {
  /** Expected in the drawer, recomputed by the server from drawer events. */
  cashInHand: number
  /** Null when no tender of that mode was recorded in the period. */
  cardPayments: number | null
  cardCount: number
  upiPayments: number | null
  upiCount: number
  totalSales: number
  tenderCount: number
  openShifts: number
  totalShifts: number
  countedShifts: number
  staffOnDuty: number
}

function tenderTotal(board: ControlsBoard, mode: string): { amount: number | null; count: number } {
  const line = board.tenders.lines.find((row) => row.payment_mode.toLowerCase() === mode)

  return line ? { amount: line.amount, count: line.count } : { amount: null, count: 0 }
}

export function deriveKpis(board: ControlsBoard): ControlsKpis {
  const card = tenderTotal(board, 'card')
  const upi = tenderTotal(board, 'upi')

  // Distinct cashiers holding an open drawer right now. Custody, not headcount:
  // two tills opened by the same person is one person on duty.
  const onDuty = new Set(
    board.shifts.filter((shift) => shift.status !== 'CLOSED').map((shift) => shift.opened_by),
  )

  return {
    cashInHand: board.cash.expected_cash,
    cardPayments: card.amount,
    cardCount: card.count,
    upiPayments: upi.amount,
    upiCount: upi.count,
    totalSales: board.tenders.lines.reduce((sum, line) => sum + line.amount, 0),
    tenderCount: board.tenders.lines.reduce((sum, line) => sum + line.count, 0),
    openShifts: board.cash.open_shifts,
    totalShifts: board.cash.shifts,
    countedShifts: board.cash.counted_shifts,
    staffOnDuty: onDuty.size,
  }
}

// ---------------------------------------------------------------------------
// Payment mode mix
// ---------------------------------------------------------------------------

export interface PaymentSlice {
  key: string
  label: string
  amount: number
  count: number
  /** 0–100, computed here only to draw the wedge. The rupee figure is the server's. */
  share: number
  colour: string
  collected: boolean
  settlementLabel: string
}

/**
 * A colour per payment mode, and a stable cycle for the ones nobody has met yet.
 *
 * Modes are whatever `pos_cart_payments.payment_mode` holds, so a shop that
 * starts taking a wallet or a gift card gets a wedge without a deploy. The
 * cycle is indexed by position, so the same board always draws the same
 * colours.
 */
const MODE_COLOURS: Record<string, string> = {
  cash: '#16a34a',
  card: '#1677ff',
  upi: '#7c3aed',
  wallet: '#f59e0b',
  bank: '#0891b2',
  customer_credit: '#e11d48',
  gift_card: '#db2777',
  loyalty: '#0d9488',
  other: '#94a3b8',
}

const COLOUR_CYCLE = ['#64748b', '#0ea5e9', '#a855f7', '#f97316', '#14b8a6', '#6366f1', '#f43f5e']

export function derivePaymentMix(board: ControlsBoard): { slices: PaymentSlice[]; total: number } {
  const lines = board.tenders.lines
  const total = lines.reduce((sum, line) => sum + line.amount, 0)

  const slices = lines.map((line, index) => {
    const key = line.payment_mode.toLowerCase()

    return {
      key: line.payment_mode,
      label: line.display_name,
      amount: line.amount,
      count: line.count,
      share: total > 0 ? (line.amount / total) * 100 : 0,
      colour: MODE_COLOURS[key] ?? COLOUR_CYCLE[index % COLOUR_CYCLE.length],
      collected: line.settlement_state === 'collected',
      settlementLabel: line.settlement_label,
    }
  })

  return { slices, total }
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export interface ShiftRow {
  sessionId: number
  /** Morning / Afternoon / Evening / Night, read off the real opening time. */
  partOfDay: string
  status: string
  reviewState: ControlsBoard['shifts'][number]['review_state']
  counter: string
  location: string | null
  staff: string
  openedAt: string
  closedAt: string | null
  openingFloat: number
  expected: number
  counted: number | null
  variance: number | null
  varianceReason: string | null
  bills: number
}

function partOfDay(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'Shift'
  const hour = at.getHours()

  if (hour < 12) return 'Morning'
  if (hour < 17) return 'Afternoon'
  if (hour < 21) return 'Evening'

  return 'Night'
}

export function deriveShifts(board: ControlsBoard): ShiftRow[] {
  return board.shifts.map((shift) => ({
    sessionId: shift.session_id,
    partOfDay: partOfDay(shift.opened_at),
    status: shift.status,
    reviewState: shift.review_state,
    counter: shift.terminal_name ?? shift.terminal_code ?? `Till #${shift.terminal_id ?? '—'}`,
    location: shift.location_name,
    staff: shift.opened_by,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at,
    openingFloat: shift.opening_float,
    expected: shift.expected_cash,
    counted: shift.counted_cash,
    variance: shift.variance,
    varianceReason: shift.variance_reason,
    bills: shift.bills,
  }))
}

// ---------------------------------------------------------------------------
// Cash movements
// ---------------------------------------------------------------------------

export type MovementTone = 'success' | 'danger' | 'warning' | 'info' | 'neutral'

export interface CashTransactionRow {
  eventId: number
  reference: string
  at: string
  kind: string
  label: string
  tone: MovementTone
  direction: ControlsBoard['movements'][number]['direction']
  amount: number
  account: string
  actor: string
  approvedBy: string | null
  note: string | null
}

/**
 * The badge colour for a drawer event.
 *
 * Driven by the backend's own `event_kind`, so a kind this list has not met
 * renders neutral and keeps its server-supplied label rather than being
 * silently folded into "cash out".
 */
const MOVEMENT_TONES: Record<string, MovementTone> = {
  opening_float: 'info',
  cash_in: 'success',
  cash_out: 'danger',
  refund: 'danger',
  petty_withdrawal: 'warning',
  safe_drop: 'info',
  closing_count: 'neutral',
  no_sale_open: 'warning',
  change_given: 'neutral',
}

export function deriveTransactions(board: ControlsBoard): CashTransactionRow[] {
  return board.movements.map((movement) => ({
    eventId: movement.event_id,
    reference: `#${movement.event_id}`,
    at: movement.created_at,
    kind: movement.event_kind,
    label: movement.label,
    tone: MOVEMENT_TONES[movement.event_kind] ?? 'neutral',
    direction: movement.direction,
    amount: movement.amount,
    account: movement.terminal_code ?? '—',
    actor: movement.actor_uuid,
    approvedBy: movement.approved_by,
    note: movement.reason,
  }))
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationView {
  expected: number
  counted: number | null
  variance: number | null
  openShifts: number
  countedShifts: number
  totalShifts: number
  reconciles: boolean
  runningExpected: number
  lastAt: string | null
  lastBy: string | null
  breakdown: Array<{ label: string; amount: number; sign: '+' | '−' | '' }>
}

export function deriveReconciliation(board: ControlsBoard): ReconciliationView {
  const cash = board.cash

  // "Last reconciled" is the most recent drawer that was actually counted —
  // the newest closed shift carrying a counted figure, not merely the newest
  // closed shift.
  const lastCounted = board.shifts
    .filter((shift) => shift.counted_cash !== null && shift.closed_at !== null)
    .sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''))
    .at(-1)

  return {
    expected: cash.expected_cash,
    counted: cash.counted_cash,
    variance: cash.variance,
    openShifts: cash.open_shifts,
    countedShifts: cash.counted_shifts,
    totalShifts: cash.shifts,
    reconciles: cash.reconciles,
    runningExpected: cash.running_expected_cash,
    lastAt: lastCounted?.closed_at ?? null,
    lastBy: lastCounted?.closed_by ?? null,
    breakdown: [
      { label: 'Opening float', amount: cash.opening_float, sign: '' },
      { label: 'Cash taken on sales', amount: cash.cash_sales, sign: '+' },
      { label: 'Cash paid in', amount: cash.cash_in, sign: '+' },
      { label: 'Cash refunds', amount: cash.cash_refunds, sign: '−' },
      { label: 'Cash paid out', amount: cash.cash_payouts, sign: '−' },
      { label: 'Safe drops', amount: cash.cash_drops, sign: '−' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Controls & alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info' | 'success'

export type AlertAction =
  | { kind: 'route'; to: string }
  | { kind: 'session'; sessionId: number }
  | { kind: 'anchor'; id: string }

export interface ControlAlert {
  id: string
  severity: AlertSeverity
  title: string
  detail: string
  /** ISO timestamp, or null where the rule is about a standing state. */
  at: string | null
  action?: AlertAction
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2, success: 3 }

/**
 * The control rules.
 *
 * Every one of these is a threshold or a state read off the board. None of them
 * is a prediction, a score or a recommendation: this product has no AI
 * configured and a dashboard that implied otherwise would be lying in the one
 * place a manager most needs to trust it.
 */
export function deriveAlerts(board: ControlsBoard): ControlAlert[] {
  const alerts: ControlAlert[] = []
  const money = (value: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(value)

  // A closed drawer that is out and unsigned is the sharpest exception there is.
  for (const pending of board.approvals.pending_variances) {
    alerts.push({
      id: `variance:${pending.session_id}`,
      severity: 'critical',
      title: `Cash difference at ${pending.terminal_code ?? `shift #${pending.session_id}`}`,
      detail: `${money(Math.abs(pending.variance))} ${pending.variance < 0 ? 'short' : 'over'}, closed and not yet signed`,
      at: pending.closed_at,
      action: { kind: 'session', sessionId: pending.session_id },
    })
  }

  // The two expected-cash figures disagreeing is a bug, not a shortage, and is
  // worth a manager's attention before any counting starts.
  if (!board.cash.reconciles) {
    alerts.push({
      id: 'formula-mismatch',
      severity: 'critical',
      title: 'Expected cash figures disagree',
      detail: `Recomputed ${money(board.cash.expected_cash)} against the tills' running ${money(board.cash.running_expected_cash)}`,
      at: null,
      action: { kind: 'anchor', id: 'cc-reconciliation' },
    })
  }

  const blocked = board.posting.commands.filter((command) => command.status === 'BLOCKED')
  const failed = board.posting.commands.filter((command) => command.status === 'FAILED')

  if (blocked.length > 0) {
    alerts.push({
      id: 'posting-blocked',
      severity: 'critical',
      title: `${blocked.length} sale${blocked.length === 1 ? '' : 's'} refused by another product`,
      detail: 'Books or Inventory would not accept them. The cause has to be fixed before a retry can work.',
      at: blocked[0]?.last_attempt_at ?? blocked[0]?.created_at ?? null,
      action: { kind: 'anchor', id: 'cc-posting' },
    })
  }

  if (failed.length > 0) {
    alerts.push({
      id: 'posting-failed',
      severity: 'warning',
      title: `${failed.length} sale${failed.length === 1 ? '' : 's'} did not post`,
      detail: 'Retryable. The same idempotency key is reused, so a retry cannot double-post.',
      at: failed[0]?.last_attempt_at ?? failed[0]?.created_at ?? null,
      action: { kind: 'anchor', id: 'cc-posting' },
    })
  }

  if (board.posting.offline.length > 0) {
    alerts.push({
      id: 'offline-pending',
      severity: 'warning',
      title: `${board.posting.offline.length} offline sale${board.posting.offline.length === 1 ? '' : 's'} outstanding`,
      detail: 'Taken while a till was cut off and not yet accepted.',
      at: board.posting.offline[0]?.received_at ?? null,
      action: { kind: 'route', to: '/offline' },
    })
  }

  for (const row of board.approvals.summary) {
    if (row.unapproved === 0) continue
    alerts.push({
      id: `unsigned:${row.event_kind}`,
      severity: 'warning',
      title: `${row.display_name}: ${row.unapproved} unsigned`,
      detail: `${row.count} recorded in this period, ${row.unapproved} without an approver.`,
      at: null,
      action: { kind: 'anchor', id: 'cc-approvals' },
    })
  }

  if (board.cash.no_sale_opens > 0) {
    alerts.push({
      id: 'no-sale-opens',
      severity: 'warning',
      title: `Drawer opened without a sale ${board.cash.no_sale_opens} time${board.cash.no_sale_opens === 1 ? '' : 's'}`,
      detail: 'Each one is attributed and on the audit trail.',
      at: null,
      action: { kind: 'anchor', id: 'cc-audit' },
    })
  }

  for (const shift of board.shifts.filter((row) => row.status !== 'CLOSED').slice(0, 4)) {
    alerts.push({
      id: `open-shift:${shift.session_id}`,
      severity: 'info',
      title: 'Shift not closed',
      detail: `${shift.terminal_name ?? shift.terminal_code ?? `Shift #${shift.session_id}`}${shift.location_name ? ` · ${shift.location_name}` : ''} · still open`,
      at: shift.opened_at,
      action: { kind: 'session', sessionId: shift.session_id },
    })
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'all-clear',
      severity: 'success',
      title: 'All clear',
      detail:
        board.cash.shifts === 0
          ? 'No shift was opened in this period, so there is nothing to reconcile.'
          : 'Every drawer in this period is counted and signed, and nothing is waiting to post.',
      at: null,
    })
  }

  return alerts.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity

    return (b.at ?? '').localeCompare(a.at ?? '')
  })
}

/** The one-line exception summary above the grid. */
export interface ExceptionSummary {
  critical: number
  warning: number
  needsReconciliation: number
  openShifts: number
  clear: boolean
}

export function summariseExceptions(board: ControlsBoard, alerts: ControlAlert[]): ExceptionSummary {
  const critical = alerts.filter((alert) => alert.severity === 'critical').length
  const warning = alerts.filter((alert) => alert.severity === 'warning').length

  return {
    critical,
    warning,
    needsReconciliation: board.approvals.pending_variances.length,
    openShifts: board.cash.open_shifts,
    clear: critical === 0 && warning === 0,
  }
}
