/**
 * The shapes the POS API returns.
 *
 * Note what is NOT here: there is no Item type with a name, a price and a stock
 * figure that this app keeps. Items are fetched when they are needed and are
 * typed as CatalogItem — a view of Inventory's answer, held in component state
 * for as long as the screen is open, and never written anywhere.
 */

export interface PosSession {
  user: { uuid: string; display_name: string; kind: string }
  company: { cmp_id: number; fy_id: number; bo_id: number }
  permissions: string[]
  locations: Location[]
  terminals: Terminal[]
  settings: PosSettings
}

export interface Location {
  location_id: number
  location_code: string
  display_name: string | null
  pos_mode: 'retail' | 'restaurant' | 'quick_service' | 'hybrid'
  vertical_preset: string | null
  bo_id: number
  default_warehouse_id: number | null
  default_cash_account_id: number | null
  currency_code: string
  service_charge_pc: number
  tips_enabled: boolean
  allow_negative_override: boolean
}

export interface Terminal {
  terminal_id: number
  terminal_uuid: string
  location_id: number
  terminal_code: string
  display_name: string | null
  terminal_kind: string
  receipt_printer: string | null
  default_payment_modes: string[]
  open_session_id?: number | null
}

export interface PosSettings {
  cashier_discount_limit_pc: number
  require_reason_on_void: boolean
  require_reason_on_return: boolean
  offline_grace_minutes: number
  cache_warn_after_minutes: number
  return_prefix: string
  kot_prefix: string
}

export interface RegisterSession {
  session_id: number
  session_uuid: string
  terminal_id: number
  status: 'OPEN' | 'CLOSING' | 'CLOSED'
  opened_by: string
  closed_by: string | null
  opened_at: string
  closed_at: string | null
  opening_float: number
  expected_cash: number
  counted_cash: number | null
  variance: number | null
  variance_reason: string | null
}

export interface CartLine {
  line_id: number
  line_no: number
  item_id: number | null
  menu_item_id: number | null
  unit_id: number | null
  warehouse_id: number | null
  batch_id: number | null
  display_name: string
  instructions: string | null
  modifiers: CartModifier[]
  serials: string[]
  quantity: number
  rate: number
  discount_pc: number
  discount_amount: number
  estimated_tax_pc: number
  line_amount: number
  kitchen_status: string | null
  kot_id: number | null
}

export interface CartModifier {
  option_id: number | null
  group_name: string | null
  option_name: string
  price_delta: number
}

export interface CartPayment {
  payment_id: number
  payment_mode: PaymentMode
  amount: number
  tendered: number | null
  change_given: number
  reference: string | null
  books_account_id: number | null
}

export type PaymentMode = 'cash' | 'card' | 'upi' | 'bank' | 'customer_credit' | 'gift_card' | 'other'

export interface Cart {
  cart_id: number
  cart_uuid: string
  status: 'OPEN' | 'HELD' | 'COMPLETED' | 'VOID'
  order_kind: string
  token_no: string | null
  hold_label: string | null
  customer_account_id: number | null
  customer_name: string | null
  customer_mobile: string | null
  table_session_id: number | null
  subtotal_amount: number
  discount_amount: number
  service_charge_amount: number
  tip_amount: number
  estimated_tax_amount: number
  total_amount: number
  paid_amount: number
  balance_due: number
  /** References, not copies: the invoice lives in Books, the movement in Inventory. */
  books_voucher_id: number | null
  books_voucher_uuid: string | null
  books_voucher_no: string | null
  inventory_document_uuid: string | null
  offline_created: boolean
  device_uuid: string | null
  created_at: string
  lines: CartLine[]
  payments: CartPayment[]
  commands?: IntegrationCommand[]
  warning?: string
}

export interface IntegrationCommand {
  command_id: number
  target_service: string
  command_type: string
  status: 'PENDING' | 'POSTING' | 'COMPLETED' | 'FAILED' | 'BLOCKED'
  attempts: number
  last_error: string | null
  external_reference: Record<string, unknown> | null
  last_attempt_at: string | null
  completed_at: string | null
}

/** Inventory's answer about an item, held for as long as a screen is open. */
export interface CatalogItem {
  item_id: number
  item_name: string
  item_code: string
  item_sku?: string | null
  unit_id: number | null
  sale_rate: number | null
  tax_rate: number | null
  tax_cat_id: number | null
}

/** Books' answer about a customer. Same rule: read when needed, never stored. */
export interface CatalogCustomer {
  acc_id: number
  acc_name: string
  mobile?: string | null
  gstin?: string | null
}

export interface MenuItem {
  menu_item_id: number
  item_id: number | null
  category_id: number | null
  category_name: string | null
  category_colour: string | null
  display_name: string
  short_name: string | null
  description: string | null
  menu_price: number | null
  tax_cat_id: number | null
  station_id: number | null
  station_name: string | null
  availability: 'AVAILABLE' | 'SOLD_OUT' | 'HIDDEN'
  availability_note: string | null
  in_service_hours: boolean
  prep_minutes: number | null
}

export interface MenuCategory {
  category_id: number
  category_code: string
  category_name: string
  colour: string | null
  sort_order: number
}

export interface MenuResponse {
  channel: string
  categories: MenuCategory[]
  items: MenuItem[]
}

export interface FloorPlanTable {
  table_id: number
  table_code: string
  table_name: string | null
  seats: number
  layout_x: number | null
  layout_y: number | null
  table_session_id: number | null
  status: 'FREE' | 'OCCUPIED' | 'CLOSED' | 'MERGED'
  covers: number | null
  waiter_uuid: string | null
  opened_at: string | null
  cart_id: number | null
  running_total: number | null
  open_kots: number
}

export interface FloorPlanFloor {
  floor_id: number
  floor_code: string
  floor_name: string
  tables: FloorPlanTable[]
}

export interface KotLine {
  kot_line_id: number
  line_no: number
  item_id: number | null
  display_name: string
  quantity: number
  modifiers: CartModifier[]
  instructions: string | null
  allergy_note: string | null
  status: string
}

export type KotStatus = 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED'

/**
 * A kitchen ticket as the KDS endpoint returns it.
 *
 * Everything after `lines` is context the kitchen screen needs and the ticket
 * itself does not own: the order kind and the customer belong to the cart, the
 * table to the table session, the late threshold to the station. The API joins
 * them so one screen is one round trip. They are optional because an older API
 * build answers without them and the screen must still render.
 */
export interface Kot {
  kot_id: number
  kot_no: string
  kot_kind: 'new' | 'addon' | 'amend' | 'void'
  station_id: number | null
  station_name: string | null
  station_code?: string | null
  station_kind?: string | null
  location_id?: number | null
  location_name?: string | null
  location_code?: string | null
  table_code: string | null
  table_name?: string | null
  covers?: number | null
  token_no: string | null
  customer_name?: string | null
  order_kind?: string | null
  status: KotStatus
  priority: string
  fired_at: string
  accepted_at?: string | null
  ready_at?: string | null
  served_at?: string | null
  notes: string | null
  offline_created?: boolean
  /** Fired → now, or fired → ready once the kitchen is done with it. */
  waiting_minutes?: number
  is_late?: boolean
  /** Seconds since firing. Keeps running after READY; `prep_seconds` does not. */
  elapsed_seconds?: number
  /** Fired → ready, frozen the moment the ticket is ready. The kitchen's own time. */
  prep_seconds?: number
  /** This ticket's station threshold, in seconds. Not a global one. */
  target_seconds?: number
  late_after_minutes?: number
  overdue_by_seconds?: number
  line_count?: number
  next_status?: KotStatus | null
  lines: KotLine[]
}

/** What one station is carrying right now. */
export interface KdsStation {
  station_id: number
  station_code: string
  station_name: string
  station_kind: string
  location_id: number
  late_after_minutes: number
  live: number
  late: number
}

/**
 * Today's kitchen performance, counted by the server over this POS's tickets.
 *
 * Null is a real answer: nothing finished yet is not the same as finished
 * instantly, and an average over no tickets is not zero.
 */
export interface KdsMetrics {
  completed: number
  avg_prep_seconds: number | null
  median_prep_seconds: number | null
  on_time: number
  on_time_pc: number | null
  trading_day_start: string
  timezone: string
}

export interface KdsDisplay {
  kots: Kot[]
  served?: Kot[]
  stations?: KdsStation[]
  metrics?: KdsMetrics | null
}

/**
 * The sale a return came off, and the till it was taken on.
 *
 * READ, NOT COPIED. Every field here belongs to the cart or the terminal and is
 * joined at read time, so a customer renamed in Books or a till renamed in Setup
 * is renamed on last month's returns too. Null throughout when the return was
 * taken against an invoice this POS never raised.
 */
export interface ReturnContext {
  customer_name: string | null
  customer_mobile: string | null
  channel: string | null
  token_no: string | null
  sale_total: number | null
  sale_subtotal: number | null
  sale_discount: number | null
  sale_tax: number | null
  sale_date: string | null
  terminal_code: string | null
  terminal_name: string | null
  /** The replacement sale, when this return was settled as an exchange. */
  exchange_sale: { cart_id: number; status: string; total_amount: number; invoice_no: string | null } | null
}

export interface PosReturn {
  return_id: number
  return_uuid: string
  return_no: string
  return_date: string
  status: 'DRAFT' | 'APPROVED' | 'RECEIVED' | 'SETTLED' | 'CANCELLED'
  resolution: string
  restock: boolean
  reason_code: string | null
  reason_note: string | null
  refund_amount: number
  customer_account_id: number | null
  cart_id: number | null
  exchange_cart_id: number | null
  terminal_id: number | null
  session_id: number | null
  books_invoice_id: number | null
  books_invoice_no: string | null
  books_invoice_uuid: string | null
  books_credit_note_uuid: string | null
  inventory_document_uuid: string | null
  created_by: string
  approved_by: string | null
  created_at: string
  updated_at: string
  lines: ReturnLine[]
  commands?: IntegrationCommand[]
  context?: ReturnContext
}

export interface ReturnLine {
  line_id: number
  line_no: number
  cart_line_id: number | null
  item_id: number | null
  unit_id: number | null
  warehouse_id: number | null
  batch_id: number | null
  display_name: string | null
  return_qty: number
  rate: number
  line_amount: number
  condition_code: string
}

export interface OfflineSubmission {
  submission_id: number
  client_uuid: string
  device_uuid: string
  terminal_id: number | null
  status: 'RECEIVED' | 'POSTED' | 'CONFLICT' | 'ABANDONED'
  cart_id: number | null
  conflict_kind: string | null
  conflict_detail: string | null
  attempts: number
  last_error: string | null
  client_created_at: string
  received_at: string
  posted_at: string | null
  resolved_by: string | null
}

export interface ShiftReport {
  session: RegisterSession
  sales: { bills: number; net: number; discount: number; tax: number; voids: number; refunds: number }
  tenders: { payment_mode: string; amount: number; count: number }[]
  drawer: { event_kind: string; amount: number; count: number }[]
  expected_cash: number
  counted_cash: number | null
  variance: number | null
}

export interface Dashboard {
  window: { from: string; to: string }
  sales: { bills: number; net: number; discount: number; estimated_tax: number; average_bill: number }
  tenders: { payment_mode: string; amount: number; count: number }[]
  by_order_kind: { order_kind: string; bills: number; net: number }[]
  hourly: { hour: number; bills: number; net: number }[]
  top_items: { display_name: string; item_id: number | null; qty: number; amount: number }[]
  exceptions: { voids: number; no_sales: number; overrides: number; refunds: number }
  needs_attention: { stuck_commands: number; pending_offline: number }
  source_note: string
}
