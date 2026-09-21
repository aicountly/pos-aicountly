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

import type { OverviewBoard } from './types'
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
