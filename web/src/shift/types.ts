/**
 * The shapes `v1/shift-report` returns.
 *
 * Written to mirror the PHP exactly, including every place it returns null on
 * purpose. `counted: number | null` and `quantity: number | null` are
 * load-bearing: a type that collapsed them to a number would let this screen
 * render "₹0.00" where the server said "nobody has counted it yet", which is
 * the one mistake a reconciliation screen must never make.
 */

export interface ShiftPerson {
  uuid: string
  /** The person's name where POS can know it, their shortened uuid where it cannot. */
  label: string
  is_you: boolean
  resolved: boolean
}

export type ShiftStatus = 'OPEN' | 'CLOSING' | 'CLOSED'
export type ShiftState = 'open' | 'closing' | 'closed' | 'reconciled' | 'variance'
export type VarianceState = 'uncounted' | 'balanced' | 'within_tolerance' | 'out_of_tolerance'
export type RiskTone = 'success' | 'warning' | 'danger'
export type EventSeverity = 'normal' | 'review' | 'exception'

export interface OutletOption {
  location_id: number
  location_code: string
  display_name: string
  pos_mode: string
}

export interface ShiftOption {
  session_id: number
  label: string
  status: ShiftStatus
  terminal_code: string
  terminal_name: string
  opened_at: string | null
  closed_at: string | null
  reconciled: boolean
}

export interface ShiftReportContext {
  date: string
  location_id: number | null
  session_id: number | null
  timezone: string
  day_start_minutes: number
  outlets: OutletOption[]
  shifts: ShiftOption[]
  scope_note: string
}

export interface ShiftDetail {
  session_id: number
  session_uuid: string
  status: ShiftStatus
  state: ShiftState
  state_label: string
  date: string
  started_at: string | null
  ended_at: string | null
  duration_minutes: number
  reconciled: boolean
  reconciled_at: string | null
  variance_reason: string | null
  cashier: ShiftPerson
  closed_by: ShiftPerson | null
  approved_by: ShiftPerson | null
  terminal: { terminal_id: number; code: string; name: string }
  outlet: { location_id: number; code: string; name: string }
  notes: string | null
}

export interface ShiftMetrics {
  bills: number
  net_sales: number
  gross_sales: number
  average_bill: number
  discounts: number
  refunds: number
  voids: number
}

export type MetricKey = keyof ShiftMetrics

export interface ShiftComparison {
  label: string
  session_id: number
  opened_at: string | null
  metrics: ShiftMetrics
  bills_pct: number | null
  net_sales_pct: number | null
  average_bill_pct: number | null
  discounts_pct: number | null
  refunds_pct: number | null
  voids_pct: number | null
}

export interface ShiftCash {
  opening: number
  cash_sales: number
  cash_in: number
  cash_refunds: number
  cash_payouts: number
  cash_drops: number
  expected: number
  running_expected: number
  counted: number | null
  variance: number | null
  variance_state: VarianceState
  tolerance: number
  formula: string
  note: string
}

export interface TenderSlice {
  payment_mode: string
  display_name: string
  amount: number
  count: number
  change_given: number
  percentage: number
  settlement_state: 'collected' | 'recorded'
  settlement_label: string
  evidence: string
}

export interface HourPoint {
  time: string
  label: string
  orders: number
  net_sales: number
  gross_sales: number
  discounts: number
  average_bill: number
  voids: number
  refunds: number
}

/** The metrics the hourly chart will plot, and how each is read. */
export type TrendMetric = 'net_sales' | 'gross_sales' | 'orders' | 'average_bill'

export interface ChannelRow {
  channel: string
  label: string
  orders: number
  net: number
  percentage: number
}

export interface ChannelBlock {
  total_orders: number
  rows: ChannelRow[]
}

export type RiskKind = 'voids' | 'no_sale' | 'override' | 'refund' | 'approval' | 'suspicious'

export interface RiskTile {
  kind: RiskKind
  label: string
  count: number
  tone: RiskTone
  action_label: string
  note: string
}

export interface SuspiciousItem {
  id: string
  title: string
  detail: string
  severity: 'warning' | 'danger'
  rule: string
}

export interface RiskBlock {
  tiles: RiskTile[]
  suspicious: { items: SuspiciousItem[]; kind?: string; note: string }
}

export interface DenominationRow {
  denomination: number
  label: string
  /** Null where this denomination was not part of the count. */
  quantity: number | null
  amount: number | null
  share_pc: number | null
}

export interface DenominationBlock {
  rows: DenominationRow[]
  has_sheet: boolean
  counted_total: number | null
  counted: number | null
  expected: number
  variance: number | null
  variance_state: VarianceState
  counted_at: string | null
  counted_by: ShiftPerson | null
  note: string
}

export interface ShiftEvent {
  id: string
  at: string | null
  code: string
  category: string
  title: string
  detail: string | null
  amount: number | null
  severity: EventSeverity
  actor: ShiftPerson
  approved_by: ShiftPerson | null
  cart_id: number | null
}

export interface EventKind {
  key: string
  label: string
  count: number
}

export interface EventBlock {
  items: ShiftEvent[]
  total: number
  kinds: EventKind[]
}

export interface ShiftReportPolicy {
  variance_tolerance: number
  no_sale_review_threshold: number
  denominations: number[]
  requires_reason_on_variance: boolean
  can_view: boolean
  can_reconcile: boolean
  can_approve_variance: boolean
  can_view_audit: boolean
  sees_every_till: boolean
}

export interface ShiftReport {
  context: ShiftReportContext
  shift: ShiftDetail | null
  metrics: ShiftMetrics
  comparison: ShiftComparison | null
  cash: ShiftCash | null
  payment_mix: TenderSlice[]
  hourly_sales: HourPoint[]
  channels: ChannelBlock
  risk: RiskBlock
  denominations: DenominationBlock | null
  events: EventBlock
  policy: ShiftReportPolicy
  source_note: string
  generated_at: string
}

/** One row behind a risk tile, in the drawer that opens from it. */
export interface RiskDetailRow {
  id: string
  at: string | null
  reference: string
  amount: number | null
  actor: ShiftPerson | null
  reason: string | null
  approved_by: ShiftPerson | null
  status: string
  detail: string | null
}

/** One line of a drawer count, as the reconcile dialog collects it. */
export interface DenominationEntry {
  denomination: number
  quantity: number
}
