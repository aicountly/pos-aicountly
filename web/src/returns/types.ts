/**
 * The shapes `/api/v1/returns` answers with.
 *
 * Note what is NOT here, and never will be: no customer master, no item master,
 * no copy of the original invoice. A return carries the IDs of the sale, the
 * customer account and the items it is about; everything else is read from the
 * product that owns it at the moment it is needed. The customer's name on a
 * row is the CART's record of who was served, read through a join on the
 * server — not a name this screen keeps.
 */

/** DRAFT → APPROVED → RECEIVED → SETTLED, or CANCELLED. */
export type ReturnStatus = 'DRAFT' | 'APPROVED' | 'RECEIVED' | 'SETTLED' | 'CANCELLED'

/** How the customer was made whole. The server's enum, not a UI invention. */
export type ReturnResolution = 'refund_cash' | 'refund_original' | 'credit_note' | 'exchange' | 'store_credit'

/** The state goods came back in. Inventory decides where they land. */
export type ReturnCondition = 'good' | 'damaged' | 'expired' | 'wrong_item'

/** One row of the register. */
export interface ReturnRow {
  return_id: number
  return_uuid: string
  return_no: string
  return_date: string
  status: ReturnStatus
  resolution: ReturnResolution
  restock: boolean
  reason_code: string | null
  reason_note: string | null
  refund_amount: number
  customer_account_id: number | null
  cart_id: number | null
  books_invoice_no: string | null
  books_invoice_uuid: string | null
  books_credit_note_uuid: string | null
  inventory_document_uuid: string | null
  exchange_cart_id: number | null
  terminal_id: number | null
  session_id: number | null
  bo_id: number | null
  created_by: string
  approved_by: string | null
  created_at: string
  updated_at: string

  /** From the original sale, read through a join. Null when nothing links to one. */
  customer_name: string | null
  customer_mobile: string | null
  order_kind: string | null
  token_no: string | null
  sale_total: number | null
  sale_date: string | null

  /** From the terminal the return was taken on. */
  terminal_code: string | null
  terminal_name: string | null

  /** Aggregated on the server over this return's own lines. */
  line_count: number
  item_qty: number
}

export interface ReturnsWindow {
  from: string
  to: string
  days: number
}

export interface ReturnsTotals {
  total_returns: number
  return_value: number
  items_returned: number
  exchange_count: number
  refund_count: number
  pending_count: number
  settled_value: number
  /** Null when the window holds no returns at all — not zero, which would be a claim. */
  exchange_ratio_pc: number | null
}

export interface ReturnsTrendPoint {
  date: string
  return_count: number
  return_value: number
  items: number
}

export interface ReturnReasonMetric {
  reason_code: string
  return_count: number
  items: number
  amount: number
  share_pc: number
}

export interface ReturnConditionMetric {
  condition_code: string
  items: number
  amount: number
  share_pc: number
}

export interface ReturnChannelMetric {
  channel: string
  return_count: number
  amount: number
  share_pc: number
}

export interface ReturnStatusMetric {
  status: ReturnStatus
  return_count: number
  amount: number
}

export interface ReturnsSummary {
  window: ReturnsWindow
  comparison_window: ReturnsWindow
  kpis: ReturnsTotals
  comparison: ReturnsTotals
  register_counts: { all: number; refunds: number; exchanges: number; pending: number }
  trend: ReturnsTrendPoint[]
  reasons: ReturnReasonMetric[]
  comparison_reasons: ReturnReasonMetric[]
  conditions: ReturnConditionMetric[]
  channels: ReturnChannelMetric[]
  statuses: ReturnStatusMetric[]
}

/** One line of the original sale, as the new-return flow needs it. */
export interface EligibilityLine {
  line_id: number
  line_no: number
  item_id: number | null
  unit_id: number | null
  warehouse_id: number | null
  batch_id: number | null
  menu_item_id: number | null
  display_name: string | null
  quantity: number
  rate: number
  discount_amount: number
  estimated_tax_pc: number
  estimated_tax_amount: number
  line_amount: number
}

/**
 * What is still returnable, per item.
 *
 * The server computes this by the same rule it enforces on submit, so the
 * quantity the cashier is offered is the quantity that will be accepted.
 */
export interface EligibilityItem {
  item_id: number
  sold_qty: number
  returned_qty: number
  returnable_qty: number
}

export interface EligibilitySale {
  cart_id: number
  cart_uuid: string
  status: string
  order_kind: string | null
  token_no: string | null
  customer_account_id: number | null
  customer_name: string | null
  customer_mobile: string | null
  subtotal_amount: number
  discount_amount: number
  service_charge_amount: number
  tip_amount: number
  estimated_tax_amount: number
  total_amount: number
  books_voucher_id: number | null
  books_voucher_uuid: string | null
  books_voucher_no: string | null
  terminal_id: number | null
  session_id: number | null
  created_at: string
}

export interface ReturnEligibility {
  cart: EligibilitySale
  returnable: boolean
  lines: EligibilityLine[]
  items: EligibilityItem[]
  returns: Array<{
    return_id: number
    return_no: string
    return_date: string
    status: ReturnStatus
    resolution: ReturnResolution
    refund_amount: number
  }>
}

/** The body `POST /v1/returns` takes. IDs only — no names, no prices copied from a screen. */
export interface NewReturnPayload {
  cart_id: number
  terminal_id: number | null
  session_id: number | null
  customer_account_id: number | null
  resolution: ReturnResolution
  restock: boolean
  reason_code: string
  reason_note: string | null
  exchange_cart_id?: number | null
  lines: Array<{
    cart_line_id: number
    item_id: number | null
    unit_id: number | null
    warehouse_id: number | null
    batch_id: number | null
    display_name: string
    return_qty: number
    rate: number
    condition_code: ReturnCondition
  }>
}

/** Which slice of the register a tab shows. */
export type RegisterTab = 'all' | 'refunds' | 'exchanges' | 'pending'

/**
 * One line of the audit log, as `v1/audit-log` returns it.
 *
 * Read, never written from here, and never invented: a return whose audit log
 * is empty shows an empty audit log.
 */
export interface ReturnAuditEntry {
  audit_id: number
  actor_uuid: string
  actor_kind: string
  source_app: string
  action: string
  entity_type: string
  entity_id: string | null
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
  reason: string | null
  created_at: string
}
