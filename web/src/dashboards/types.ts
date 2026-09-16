/**
 * The shapes the five board endpoints return.
 *
 * Written to mirror the PHP exactly, including the places it returns null on
 * purpose: `counted_cash: number | null` and `available: false` are load-bearing
 * and a type that collapsed them to a number would let a screen render "0" where
 * the server said "nobody has counted it yet".
 */

export interface WindowMeta {
  from: string
  to: string
  starts_at: string
  ends_at: string
  timezone: string
  day_start_minutes: number
  location_id: number | null
  terminal_id: number | null
  session_id: number | null
  comparison: { label: string | null; starts_at: string; ends_at: string } | null
  generated_at: string
  scope_note: string
}

export interface InsightItem {
  id: string
  kind: 'rule' | 'ai'
  severity?: 'info' | 'success' | 'warning' | 'danger'
  title: string
  explanation: string
  period_label: string
  evidence_href?: string | null
  action_label?: string | null
}

export interface InsightBlock {
  items: InsightItem[]
  ai: { available: false; reason: string; note: string }
  generated_at: string
  sufficient_data?: boolean
}

export interface TenderLine {
  payment_mode: string
  display_name: string
  amount: number
  count: number
  settlement_state: 'collected' | 'recorded'
  settlement_label: string
  evidence: string
}

// ---------------------------------------------------------------------------
// Business Overview
// ---------------------------------------------------------------------------

export interface OverviewBoard {
  window: WindowMeta
  metric_basis: { net_sales: string; returns: string; source: string }
  sales: {
    bills: number
    net: number
    discount: number
    estimated_tax: number
    average_bill: number
    returns_count: number
    returns_value: number
    active_tills: number
    open_shifts: number
  }
  comparison: { label: string | null; bills: number; net: number; average_bill: number } | null
  series: {
    bucket: 'hour' | 'day'
    points: Array<{ bucket: string; bills: number; net: number }>
    comparison_by_bucket: Record<string, number> | null
  }
  outlets: Array<{
    location_id: number
    location_code: string
    display_name: string
    pos_mode: string
    bills: number
    net: number
    average_bill: number
    target: number | null
    target_pc: number | null
    exceptions: number
  }>
  tenders: TenderLine[]
  top_items: Array<{
    item_id: number | null
    display_name: string
    qty: number
    amount: number
    returned_qty: number
  }>
  margin:
    | { available: false; reason: string; note: string }
    | {
        available: true
        revenue: number
        revenue_basis: string
        cost: number
        gross_margin: number
        margin_pc: number | null
        items_costed: number
        items_total: number
        note: string
      }
  attention: {
    posting_failed: number
    posting_blocked: number
    posting_in_flight: number
    offline_pending: number
    cash_variances: number
    late_tickets: number
    held_bills: number
  }
  insights: InsightBlock
}

// ---------------------------------------------------------------------------
// Retail Operations
// ---------------------------------------------------------------------------

export interface RetailBoard {
  window: WindowMeta
  kpis: {
    active_counters: number
    total_counters: number
    bills: number
    net: number
    held_bills: number
    held_value: number
    checkout:
      | { available: false; reason: string; note: string }
      | { available: true; median_seconds: number; sampled: number; basis: string }
    exceptions: number
  }
  counters: Array<{
    terminal_id: number
    terminal_code: string
    display_name: string
    terminal_kind: string
    location_id: number
    location_name: string
    pos_mode: string
    shift: {
      session_id: number
      status: string
      opened_by: string
      opened_at: string
      expected_cash: number
    } | null
    state: 'busy' | 'open' | 'closed'
    bills: number
    net: number
    open_carts: number
    last_activity: string | null
  }>
  held_bills: Array<{
    cart_id: number
    cart_uuid: string
    reference: string
    customer_name: string | null
    items: number
    total_amount: number
    held_seconds: number
    terminal_id: number | null
    terminal_code: string | null
    opened_by: string
  }>
  recent: Array<{
    cart_id: number
    cart_uuid: string
    created_at: string
    customer_name: string | null
    terminal_id: number | null
    terminal_code: string | null
    total_amount: number
    status: string
    order_kind: string
    tenders: string[]
    tender_state: 'collected' | 'recorded' | 'none'
    books: IntegrationState
    books_voucher_no: string | null
    inventory: IntegrationState
  }>
  devices: {
    verification: 'not_verified'
    note: string
    terminals: Array<{
      terminal_id: number
      terminal_code: string
      display_name: string
      active_devices: number
      revoked_devices: number
      peripherals: Array<{
        kind: string
        label: string
        value: string | null
        state: 'configured' | 'not_configured'
      }>
    }>
  }
  stock:
    | { available: false; reason: string; note: string; items: []; fetched_at: string }
    | {
        available: true
        items: Array<{
          item_id: number | null
          display_name: string
          available: number | null
          reorder_level: number | null
          warehouse_id: number | null
        }>
        fetched_at: string
        source: string
      }
  attention: {
    voids: number
    stuck: number
    approvals: Array<{ event_kind: string; count: number }>
  }
}

export type IntegrationState = 'posted' | 'failed' | 'blocked' | 'in_flight' | 'not_attempted'

// ---------------------------------------------------------------------------
// Restaurant Operations
// ---------------------------------------------------------------------------

export interface KitchenTicket {
  kot_id: number
  kot_no: string
  kot_kind: string
  status: string
  priority: string
  token_no: string | null
  table_code: string | null
  order_kind: string
  station_id: number | null
  station_name: string
  fired_at: string
  elapsed_seconds: number
  late_after_seconds: number
  overdue: boolean
  overdue_by_seconds: number
  line_count: number
  lines: Array<{
    display_name: string
    quantity: number
    modifiers: unknown[]
    instructions: string | null
    allergy_note: string | null
    status: string
  }>
  next_status: string | null
}

export interface RestaurantBoard {
  window: WindowMeta
  kpis: {
    tables_total: number
    tables_occupied: number
    covers: number
    open_orders: number
    tickets_pending: number
    tickets_overdue: number
    orders_ready: number
    unsettled_bills: number
    unsettled_value: number
  }
  floors: Array<{
    floor_id: number
    floor_code: string
    floor_name: string
    tables: Array<{
      table_id: number
      table_code: string
      table_name: string
      seats: number
      layout_x: number | null
      layout_y: number | null
      table_session_id: number | null
      status: string
      state: 'available' | 'occupied' | 'billing' | 'cleaning'
      covers: number | null
      waiter_uuid: string | null
      seated_seconds: number | null
      running_total: number | null
    }>
  }>
  kitchen: { queued: KitchenTicket[]; preparing: KitchenTicket[]; ready: KitchenTicket[] }
  channels: {
    total: number
    channels: Array<{ order_kind: string; display_name: string; orders: number; net: number }>
    external_connectors: number
    note: string
  }
  menu: {
    total: number
    available: number
    unavailable: number
    items: Array<{
      menu_item_id: number
      display_name: string
      availability: string
      note: string | null
      set_at: string | null
      item_id: number | null
      menu_price: number | null
    }>
    note: string
  }
  delays: {
    kind: 'rule'
    note: string
    items: Array<{
      kot_id: number
      kot_no: string
      status: string
      priority: string
      station_name: string
      table_code: string | null
      order_kind: string
      elapsed_seconds: number
      late_after_seconds: number
      overdue_by_seconds: number
    }>
  }
}

// ---------------------------------------------------------------------------
// Customers & Growth
// ---------------------------------------------------------------------------

export interface CustomersBoard {
  window: WindowMeta
  coverage: {
    bills: number
    identified_bills: number
    anonymous_bills: number
    identified_pc: number | null
    net: number
    identified_net: number
  }
  kpis: {
    identified_customers: number
    new_customers: number
    returning_customers: number
    repeat_rate_pc: number | null
    identified_average_bill: number | null
    identified_pc: number | null
  }
  trend: {
    bucket: 'hour' | 'day'
    points: Array<{ bucket: string; new_bills: number; returning_bills: number }>
  }
  recency: {
    basis: string
    points: Array<{ bucket: string; label: string; customers: number; visits: number }>
  }
  segments: {
    total: number
    segments: Array<{
      key: string
      label: string
      definition: string
      customers: number
      spend: number
      share_pc: number | null
    }>
    basis: string
  }
  combinations: {
    baskets: number
    pairs: Array<{
      left_item: number
      left_name: string
      right_item: number
      right_name: string
      together: number
      baskets: number
      share_pc: number | null
    }>
    basis: string
  }
  loyalty: { available: false; reason: string; note: string; contract_gap: string }
  offers: { available: false; reason: string; note: string }
  suggestions: {
    items: Array<
      InsightItem & { segment: string | null; definition: string; supporting_customers: number }
    >
    ai: { available: false; reason: string; note: string }
    sending: { available: false; note: string }
    contact_details: { visible: boolean; note: string }
    generated_at: string
  }
  basis: string
}

// ---------------------------------------------------------------------------
// Cash, Shifts & Controls
// ---------------------------------------------------------------------------

export interface ControlsBoard {
  window: WindowMeta
  cash: {
    opening_float: number
    cash_sales: number
    cash_in: number
    cash_refunds: number
    cash_payouts: number
    cash_drops: number
    expected_cash: number
    counted_cash: number | null
    variance: number | null
    shifts: number
    counted_shifts: number
    open_shifts: number
    no_sale_opens: number
    running_expected_cash: number
    reconciles: boolean
  }
  formula: { expected_cash: string; variance: string; note: string }
  shifts: Array<{
    session_id: number
    status: string
    terminal_id: number | null
    terminal_code: string | null
    terminal_name: string | null
    location_id: number | null
    location_name: string | null
    opened_by: string
    closed_by: string | null
    opened_at: string
    closed_at: string | null
    opening_float: number
    expected_cash: number
    counted_cash: number | null
    variance: number | null
    variance_reason: string | null
    approved_by: string | null
    bills: number
    net: number
    review_state: 'open' | 'balanced' | 'needs_review' | 'approved'
  }>
  movements: Array<{
    event_id: number
    event_kind: string
    label: string
    direction: 'in' | 'out' | 'none' | 'unclassified'
    amount: number
    reason: string | null
    actor_uuid: string
    approved_by: string | null
    books_voucher_uuid: string | null
    session_id: number
    terminal_code: string | null
    created_at: string
  }>
  tenders: {
    lines: Array<
      TenderLine & {
        change_given: number
        with_reference: number
        provider_confirmed: null
        unmatched: null
      }
    >
    refunds: Array<{ resolution: string; display_name: string; count: number; amount: number }>
    provider: { available: false; reason: string; note: string; contract_gap: string }
  }
  approvals: {
    summary: Array<{ event_kind: string; display_name: string; count: number; unapproved: number }>
    events: Array<{
      approval_id: number
      event_kind: string
      display_name: string
      requested_by: string
      approved_by: string | null
      reason: string | null
      detail: Record<string, unknown>
      cart_id: number | null
      session_id: number | null
      terminal_code: string | null
      created_at: string
    }>
    pending_variances: Array<{
      session_id: number
      terminal_code: string | null
      variance: number
      reason: string | null
      closed_at: string | null
      closed_by: string | null
    }>
  }
  posting: {
    note: string
    commands: Array<{
      command_id: number
      target_service: string
      command_type: string
      entity_type: string
      entity_id: number
      status: string
      state_label: string
      retryable: boolean
      attempts: number
      last_error: string | null
      last_attempt_at: string | null
      created_at: string
      cart_uuid: string | null
      total_amount: number | null
      books_voucher_no: string | null
      terminal_code: string | null
    }>
    offline: Array<{
      submission_id: number
      client_uuid: string
      device_uuid: string
      status: string
      retryable: boolean
      conflict_kind: string | null
      conflict_detail: string | null
      attempts: number
      last_error: string | null
      client_created_at: string
      received_at: string
      terminal_code: string | null
    }>
  }
  audit: Array<{
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
  }>
}
