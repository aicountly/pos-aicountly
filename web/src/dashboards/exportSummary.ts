/**
 * The Business Overview, as a spreadsheet.
 *
 * EXACTLY WHAT IS ON THE SCREEN, AND NOTHING THAT IS NOT. The file is built
 * from the board object the page is already rendering, so there is no second
 * query, no second definition of net sales and no chance of a file that
 * disagrees with the screen it was exported from. The window, the outlet, the
 * till and the comparison are written into the head of the file, because a
 * figure without its filters is a figure somebody will misread next quarter.
 *
 * CSV rather than XLSX or PDF: this product ships no spreadsheet or PDF
 * library, and pulling one in to serialise six small tables would cost every
 * till on shop broadband a download it never uses. A CSV opens in Excel, in
 * Sheets and in Books.
 */

import type { ControlsBoard, OverviewBoard, RetailBoard } from './types'
import type { DashboardFilters } from './useDashboard'

/** One CSV field. Quotes are doubled, and anything risky is quoted. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function row(...values: Array<string | number | null | undefined>): string {
  return values.map(cell).join(',')
}

export function buildOverviewCsv(board: OverviewBoard, filters: DashboardFilters): string {
  const lines: string[] = []

  lines.push(row('Aicountly POS — Business Overview'))
  lines.push(row('From', board.window.from, 'To', board.window.to))
  lines.push(row('Timezone', board.window.timezone, 'Day starts at (minutes)', board.window.day_start_minutes))
  lines.push(row('Outlet', filters.locationId === null ? 'All outlets' : String(filters.locationId)))
  lines.push(row('Counter', filters.terminalId === null ? 'All counters' : String(filters.terminalId)))
  lines.push(row('Comparison', board.window.comparison?.label ?? 'None'))
  lines.push(row('Generated at', board.window.generated_at))
  lines.push(row('Basis', board.metric_basis.net_sales))
  lines.push(row('Scope', board.window.scope_note))
  lines.push('')

  lines.push(row('Headline figures'))
  lines.push(row('Measure', 'Value', 'Comparison window'))
  lines.push(row('Net sales', board.sales.net, board.comparison?.net ?? ''))
  lines.push(row('Completed bills', board.sales.bills, board.comparison?.bills ?? ''))
  lines.push(row('Average bill', board.sales.average_bill, board.comparison?.average_bill ?? ''))
  lines.push(row('Returns value', board.sales.returns_value, board.comparison?.returns_value ?? ''))
  lines.push(row('Returns count', board.sales.returns_count, board.comparison?.returns_count ?? ''))
  lines.push(row('Discount given', board.sales.discount, ''))
  lines.push(row('Bills carrying a discount', board.sales.discounted_bills, board.comparison?.discounted_bills ?? ''))
  lines.push(row('Shifts open now', board.sales.open_shifts, ''))
  lines.push(row('Active tills', board.sales.active_tills, ''))
  lines.push('')

  lines.push(row(board.series.bucket === 'hour' ? 'Sales by hour' : 'Sales by day'))
  lines.push(row('Bucket', 'Bills', 'Net sales', 'Returns', 'Comparison net sales'))
  for (const point of board.series.points) {
    lines.push(
      row(point.bucket, point.bills, point.net, point.returns, board.series.comparison_by_bucket?.[point.bucket] ?? ''),
    )
  }
  lines.push('')

  lines.push(row('Outlets'))
  lines.push(row('Outlet', 'Kind', 'Bills', 'Net sales', 'Average bill', 'Target', 'Percent of target', 'Stuck with Books or Inventory'))
  for (const outlet of board.outlets) {
    lines.push(
      row(
        outlet.display_name,
        outlet.pos_mode,
        outlet.bills,
        outlet.net,
        outlet.average_bill,
        outlet.target ?? '',
        outlet.target_pc ?? '',
        outlet.exceptions,
      ),
    )
  }
  lines.push('')

  lines.push(row('Payment mix'))
  lines.push(row('Method', 'Tenders', 'Amount', 'Settlement'))
  for (const tender of board.tenders) {
    lines.push(row(tender.display_name, tender.count, tender.amount, tender.settlement_label))
  }
  lines.push('')

  lines.push(row('Top items'))
  lines.push(row('Item', 'Quantity', 'Net sales', 'Quantity returned'))
  for (const item of board.top_items) {
    lines.push(row(item.display_name, item.qty, item.amount, item.returned_qty))
  }
  lines.push('')

  lines.push(row('Returns and voids'))
  // The kind column is not decoration: a void's value is the bill that never
  // happened, and summing this column across both kinds is wrong.
  lines.push(row('Kind', 'Reason', 'Count', 'Value', 'Value is money that moved'))
  for (const line of [...board.returns_voids.returns, ...board.returns_voids.voids]) {
    lines.push(row(line.kind, line.display_name, line.count, line.amount, line.amount_is_money ? 'yes' : 'no'))
  }
  lines.push('')

  lines.push(row('Rule-based alerts'))
  lines.push(row('Severity', 'Alert', 'Figure', 'Detail', 'Period'))
  for (const insight of board.insights.items) {
    lines.push(row(insight.severity ?? 'info', insight.title, insight.metric ?? '', insight.detail ?? '', insight.period_label))
  }
  lines.push('')
  lines.push(row(board.insights.ai.note))

  return lines.join('\r\n')
}

/**
 * Hand the file to the browser.
 *
 * A Blob and an object URL, revoked straight after: a data: URL of a long CSV
 * trips the URL length limit in some browsers and silently produces a truncated
 * file, which is worse than no export at all.
 */
export function downloadOverviewCsv(board: OverviewBoard, filters: DashboardFilters): void {
  // The BOM is what makes Excel on Windows read ₹ and the rest of the UTF-8
  // correctly instead of as mojibake.
  const blob = new Blob(['﻿', buildOverviewCsv(board, filters)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = `aicountly-pos-overview-${board.window.from}-to-${board.window.to}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * Retail Operations, as a spreadsheet.
 *
 * Same rules as the board above: built from the object the page is already
 * rendering, so there is no second query and no second definition of anything.
 * The head of the file carries the window, the outlet, the till and the
 * comparison, because a figure without its filters is a figure somebody will
 * misread next quarter.
 *
 * The two things this board deliberately cannot measure are written into the
 * file as well. A CSV that quietly omitted them would read as though the
 * columns had simply not been exported.
 */
export function buildRetailCsv(board: RetailBoard, filters: DashboardFilters): string {
  const lines: string[] = []

  lines.push(row('Aicountly POS — Retail Operations'))
  lines.push(row('From', board.window.from, 'To', board.window.to))
  lines.push(row('Timezone', board.window.timezone, 'Day starts at (minutes)', board.window.day_start_minutes))
  lines.push(row('Outlet', filters.locationId === null ? 'All outlets' : String(filters.locationId)))
  lines.push(row('Counter', filters.terminalId === null ? 'All counters' : String(filters.terminalId)))
  lines.push(row('Comparison', board.window.comparison?.label ?? 'None'))
  lines.push(row('Generated at', board.window.generated_at))
  lines.push(row('Scope', board.window.scope_note))
  lines.push('')

  lines.push(row('Headline figures'))
  lines.push(row('Measure', 'Value', 'Comparison window'))
  lines.push(row('Active counters', board.kpis.active_counters, ''))
  lines.push(row('Tills in scope', board.kpis.total_counters, ''))
  lines.push(row('Completed bills', board.kpis.bills, board.comparison?.bills ?? ''))
  lines.push(row('Net taken', board.kpis.net, board.comparison?.net ?? ''))
  lines.push(row('Bills on hold (all dates)', board.kpis.held_bills, ''))
  lines.push(row('Value on hold (all dates)', board.kpis.held_value, ''))
  lines.push(
    row(
      'Median checkout (seconds)',
      board.kpis.checkout.available ? board.kpis.checkout.median_seconds : 'Not measurable',
      board.comparison?.checkout.available ? board.comparison.checkout.median_seconds : '',
    ),
  )
  lines.push(row('Needs attention', board.kpis.exceptions, ''))
  lines.push(row('Needs attention (this window only)', board.kpis.exceptions_windowed, board.comparison?.exceptions_windowed ?? ''))
  lines.push('')

  lines.push(row('Counter status'))
  lines.push(row('Counter', 'Name', 'Outlet', 'Status', 'On counter', 'Bills', 'Bills per hour', 'Taken', 'Voids', 'Shift opened by', 'Shift opened at'))
  for (const counter of board.counters) {
    lines.push(
      row(
        counter.terminal_code,
        counter.display_name,
        counter.location_name,
        counter.state,
        counter.open_carts,
        counter.bills,
        counter.bills_per_hour ?? '',
        counter.net,
        counter.voids,
        counter.shift?.opened_by ?? '',
        counter.shift?.opened_at ?? '',
      ),
    )
  }
  lines.push('')

  lines.push(row(board.trend.bucket === 'hour' ? 'Sales by hour' : 'Sales by day'))
  lines.push(row('Bucket', 'Bills', 'Sales', 'Items', 'Average bill', 'Voids', 'Median checkout (seconds)', 'Comparison sales'))
  for (const point of board.trend.points) {
    lines.push(
      row(
        point.bucket,
        point.bills,
        point.sales,
        point.items,
        point.average_bill,
        point.voids,
        point.checkout_seconds ?? '',
        point.comparison_sales ?? '',
      ),
    )
  }
  lines.push('')

  lines.push(row('Checkout health'))
  lines.push(row('Measure', 'Value', 'Note'))
  // Written out rather than omitted: a missing row reads as a column that was
  // not exported, and this one is a column that does not exist.
  lines.push(row('Average waiting time', 'Not measured', board.checkout_health.wait.note))
  lines.push(row('Median checkout (seconds)', board.checkout_health.checkout.median_seconds ?? '', ''))
  lines.push(row('Slowest 1 in 10 (seconds)', board.checkout_health.checkout.p90_seconds ?? '', ''))
  lines.push(row('Carts opened', board.checkout_health.completion.started, ''))
  lines.push(row('Paid for', board.checkout_health.completion.completed, ''))
  lines.push(row('Voided before payment', board.checkout_health.completion.voided, ''))
  lines.push(row('Still on a counter', board.checkout_health.on_counter.carts, ''))
  lines.push(row('Verdict', board.checkout_health.status, board.checkout_health.summary))
  lines.push('')

  lines.push(row('Top selling categories'))
  if (board.categories.available) {
    lines.push(row('Category', 'Sales value', 'Quantity', 'Bills', 'Share of grouped sales (%)'))
    for (const category of board.categories.rows) {
      lines.push(row(category.label, category.amount, category.qty, category.bills, category.share_pc ?? ''))
    }
    lines.push(row('Grouped share of the period (%)', board.categories.coverage_pc ?? ''))
    lines.push(row('Ungrouped value', board.categories.uncategorised))
    lines.push(row('Source', board.categories.source))
  } else {
    lines.push(row('Not available', board.categories.note))
  }
  lines.push('')

  lines.push(row('Operational alerts'))
  lines.push(row('Severity', 'Alert', 'Context', 'At'))
  for (const alert of board.alerts.items) {
    lines.push(row(alert.severity, alert.title, alert.context, alert.at ?? ''))
  }
  lines.push(row(board.alerts.note))
  lines.push('')

  lines.push(row('Shift readiness'))
  if (board.readiness.available) {
    lines.push(row('Check', 'Ready', 'Of', 'Note'))
    for (const check of board.readiness.checks) {
      lines.push(row(check.label, check.ready, check.of, check.note))
    }
    lines.push(row('Overall (%)', board.readiness.percent ?? ''))
  } else {
    lines.push(row('Not available', board.readiness.note))
  }
  lines.push('')

  lines.push(row('Rule-based alerts'))
  lines.push(row('Severity', 'Alert', 'Figure', 'Detail', 'Period'))
  for (const insight of board.pulse.items) {
    lines.push(row(insight.severity ?? 'info', insight.title, insight.metric ?? '', insight.detail ?? '', insight.period_label))
  }
  lines.push('')
  lines.push(row(board.pulse.ai.note))

  return lines.join('\r\n')
}

export function downloadRetailCsv(board: RetailBoard, filters: DashboardFilters): void {
  const blob = new Blob(['\ufeff', buildRetailCsv(board, filters)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = `aicountly-pos-retail-${board.window.from}-to-${board.window.to}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Cash, Shifts & Controls
// ---------------------------------------------------------------------------

/**
 * The close-out, as a spreadsheet.
 *
 * Same contract as the overview above: built from the board the page is already
 * rendering, so the file cannot disagree with the screen it came from, and the
 * window, outlet and counter are written into its head because a variance
 * without its filters is a variance somebody will argue about in a month.
 *
 * Counted cash and variance are written as blanks where the server sent null.
 * A zero would say a drawer nobody has opened balances.
 */
export function buildControlsCsv(board: ControlsBoard, filters: DashboardFilters): string {
  const lines: string[] = []

  lines.push(row('Aicountly POS — Cash, Shifts & Controls'))
  lines.push(row('From', board.window.from, 'To', board.window.to))
  lines.push(row('Timezone', board.window.timezone, 'Day starts at (minutes)', board.window.day_start_minutes))
  lines.push(row('Outlet', filters.locationId === null ? 'All outlets' : String(filters.locationId)))
  lines.push(row('Counter', filters.terminalId === null ? 'All counters' : String(filters.terminalId)))
  lines.push(row('Generated at', board.window.generated_at))
  lines.push(row('Scope', board.window.scope_note))
  lines.push('')

  lines.push(row('The drawer'))
  lines.push(row('Measure', 'Amount'))
  lines.push(row('Opening float', board.cash.opening_float))
  lines.push(row('Cash taken on sales', board.cash.cash_sales))
  lines.push(row('Cash paid in', board.cash.cash_in))
  lines.push(row('Cash refunds', board.cash.cash_refunds))
  lines.push(row('Cash paid out', board.cash.cash_payouts))
  lines.push(row('Safe drops', board.cash.cash_drops))
  lines.push(row('Expected cash', board.cash.expected_cash))
  lines.push(row('Counted cash', board.cash.counted_cash ?? ''))
  lines.push(row('Variance', board.cash.variance ?? ''))
  lines.push(row('Shifts', board.cash.shifts, 'Counted', board.cash.counted_shifts, 'Still open', board.cash.open_shifts))
  lines.push(row('Basis', board.formula.expected_cash))
  lines.push('')

  lines.push(row('Shifts'))
  lines.push(
    row('Shift', 'Status', 'Review', 'Counter', 'Outlet', 'Opened by', 'Opened at', 'Closed at',
      'Opening float', 'Expected', 'Counted', 'Variance', 'Reason', 'Bills', 'Net'),
  )
  for (const shift of board.shifts) {
    lines.push(
      row(
        shift.session_id,
        shift.status,
        shift.review_state,
        shift.terminal_name ?? shift.terminal_code ?? '',
        shift.location_name ?? '',
        shift.opened_by,
        shift.opened_at,
        shift.closed_at ?? '',
        shift.opening_float,
        shift.expected_cash,
        shift.counted_cash ?? '',
        shift.variance ?? '',
        shift.variance_reason ?? '',
        shift.bills,
        shift.net,
      ),
    )
  }
  lines.push('')

  lines.push(row('Payment modes'))
  lines.push(row('Mode', 'Amount', 'Tenders', 'Settlement', 'Evidence'))
  for (const line of board.tenders.lines) {
    lines.push(row(line.display_name, line.amount, line.count, line.settlement_label, line.evidence))
  }
  lines.push(row(board.tenders.provider.note))
  lines.push('')

  lines.push(row('Cash movements'))
  lines.push(row('Event', 'When', 'What', 'Direction', 'Amount', 'Counter', 'By', 'Approved by', 'Reason'))
  for (const movement of board.movements) {
    lines.push(
      row(
        movement.event_id,
        movement.created_at,
        movement.label,
        movement.direction,
        movement.amount,
        movement.terminal_code ?? '',
        movement.actor_uuid,
        movement.approved_by ?? '',
        movement.reason ?? '',
      ),
    )
  }
  lines.push('')

  lines.push(row('Approvals'))
  lines.push(row('What', 'Recorded', 'Unsigned'))
  for (const approval of board.approvals.summary) {
    lines.push(row(approval.display_name, approval.count, approval.unapproved))
  }

  return lines.join('\r\n')
}

export function downloadControlsCsv(board: ControlsBoard, filters: DashboardFilters): void {
  // The BOM is what makes Excel on Windows read ₹ correctly instead of mojibake.
  const blob = new Blob(['\ufeff', buildControlsCsv(board, filters)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = `aicountly-pos-cash-controls-${board.window.from}-to-${board.window.to}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
