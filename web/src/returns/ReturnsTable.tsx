/**
 * The register itself.
 *
 * Dense on purpose: this is a counter tool read on a monitor, and a row that
 * needs three lines is a row a supervisor has to scroll past. What is NOT
 * sacrificed for density:
 *
 *  - every row is reachable and openable from the keyboard, through the return
 *    number, which is a real button rather than a div with a click handler;
 *  - sortable headers say which way they are sorted with `aria-sort`, not only
 *    with an arrow;
 *  - the status is a word, never only a colour;
 *  - a wide table scrolls inside its own box rather than pushing the page
 *    sideways.
 */

import { MoreVertical, ArrowDown, ArrowUp } from 'lucide-react'
import { StatusBadge } from '../dashboards/shell'
import { count, decimal, money } from '../dashboards/format'
import { MenuButton, type MenuAction } from './Menu'
import {
  CHANNEL_TERMS,
  labelFor,
  REASON_TERMS,
  RESOLUTION_TERMS,
  resolutionKind,
  STATUS_TERMS,
  termFor,
} from './vocabulary'
import type { ReturnRow } from './types'

const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function stamp(iso: string): string {
  const parsed = new Date(iso)

  return Number.isNaN(parsed.getTime()) ? iso : DATE_TIME.format(parsed)
}

function SortableHeader({
  label,
  column,
  sort,
  order,
  onSort,
  numeric = false,
}: {
  label: string
  column: string
  sort: string
  order: 'asc' | 'desc'
  onSort: (column: string) => void
  numeric?: boolean
}) {
  const active = sort === column
  const Icon = order === 'asc' ? ArrowUp : ArrowDown

  return (
    <th
      scope="col"
      className={numeric ? 'is-number' : undefined}
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="returns-sort" onClick={() => onSort(column)}>
        {label}
        {active && <Icon size={12} aria-hidden />}
      </button>
    </th>
  )
}

function SkeletonRows({ rows, columns }: { rows: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden>
          {Array.from({ length: columns }, (_, column) => (
            <td key={column}>
              <span className="returns-skeleton returns-skeleton--cell" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export function ReturnsTable({
  rows,
  loading,
  firstIndex,
  sort,
  order,
  onSort,
  onOpen,
  rowActions,
}: {
  rows: ReturnRow[]
  loading: boolean
  /** The 1-based position of the first row, so the # column continues across pages. */
  firstIndex: number
  sort: string
  order: 'asc' | 'desc'
  onSort: (column: string) => void
  onOpen: (row: ReturnRow) => void
  rowActions: (row: ReturnRow) => MenuAction[]
}) {
  return (
    <div className="returns-tablewrap">
      <table className="returns-table">
        <thead>
          <tr>
            <th scope="col" className="is-number returns-table__index">
              #
            </th>
            <SortableHeader label="Return no." column="return_no" sort={sort} order={order} onSort={onSort} />
            <SortableHeader label="Date &amp; time" column="return_date" sort={sort} order={order} onSort={onSort} />
            <th scope="col">Bill no.</th>
            <th scope="col">Customer</th>
            <th scope="col" className="is-number">
              Items
            </th>
            <th scope="col">Type</th>
            <SortableHeader
              label="Amount"
              column="refund_amount"
              sort={sort}
              order={order}
              onSort={onSort}
              numeric
            />
            <th scope="col">Reason</th>
            <th scope="col">Settled as</th>
            <SortableHeader label="Status" column="status" sort={sort} order={order} onSort={onSort} />
            <th scope="col">Till</th>
            <th scope="col">
              <span className="pos-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {loading ? (
            <SkeletonRows rows={6} columns={13} />
          ) : (
            rows.map((row, index) => {
              const status = termFor(STATUS_TERMS, row.status)
              const resolution = RESOLUTION_TERMS[row.resolution]
              const kind = resolutionKind(row.resolution)

              return (
                <tr key={row.return_id} onClick={() => onOpen(row)}>
                  <td className="is-number returns-table__index">{firstIndex + index}</td>

                  <td>
                    <button
                      type="button"
                      className="returns-table__open"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpen(row)
                      }}
                    >
                      {row.return_no}
                    </button>
                  </td>

                  <td className="returns-table__stamp">{stamp(row.created_at)}</td>

                  <td>{row.books_invoice_no ?? <span className="pos-muted">Not linked</span>}</td>

                  <td className="returns-table__customer">
                    {row.customer_name ?? <span className="pos-muted">Walk-in</span>}
                    {row.order_kind && (
                      <small className="pos-muted">{labelFor(CHANNEL_TERMS, row.order_kind)}</small>
                    )}
                  </td>

                  <td className="is-number">{decimal(row.item_qty, 2)}</td>

                  <td>
                    <span className={kind === 'exchange' ? 'returns-type returns-type--exchange' : 'returns-type'}>
                      {kind === 'exchange' ? 'Exchange' : 'Refund'}
                    </span>
                  </td>

                  <td className="is-number">
                    <strong>{money(row.refund_amount)}</strong>
                  </td>

                  <td>{row.reason_code ? labelFor(REASON_TERMS, row.reason_code) : <span className="pos-muted">Not stated</span>}</td>

                  <td>{resolution ? resolution.label : row.resolution}</td>

                  <td>
                    <StatusBadge tone={status.tone ?? 'neutral'}>{status.label}</StatusBadge>
                  </td>

                  <td>{row.terminal_code ?? <span className="pos-muted">—</span>}</td>

                  <td className="returns-table__actions" onClick={(event) => event.stopPropagation()}>
                    <MenuButton
                      icon={<MoreVertical size={16} aria-hidden />}
                      className="returns-icon-button"
                      ariaLabel={`Actions for ${row.return_no}`}
                      actions={rowActions(row)}
                    />
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

export function ReturnsPagination({
  total,
  page,
  pageSize,
  pageSizes,
  loading,
  onPage,
  onPageSize,
}: {
  total: number
  page: number
  pageSize: number
  pageSizes: number[]
  loading: boolean
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)

  return (
    <div className="returns-pagination">
      <p className="pos-muted" role="status" aria-live="polite">
        {loading ? 'Loading returns…' : `Showing ${count(first)}–${count(last)} of ${count(total)}`}
      </p>

      <div className="returns-pagination__controls">
        <label className="returns-pagesize">
          <span>Rows</span>
          <select value={pageSize} onChange={(event) => onPageSize(Number.parseInt(event.target.value, 10))}>
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="returns-button returns-button--secondary"
          disabled={page <= 1 || loading}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <span className="returns-pagination__page num">
          Page {count(page)} of {count(pages)}
        </span>
        <button
          type="button"
          className="returns-button returns-button--secondary"
          disabled={page >= pages || loading}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}
