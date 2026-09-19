/**
 * The customer roster.
 *
 * EVERY CONTROL HERE IS A QUERY PARAMETER. The tabs, the search box, the sort
 * and the page are sent to the server and it returns one page of rows. Nothing
 * is filtered in the browser, so the screen behaves the same on a shop's
 * fourth customer and its forty-thousandth.
 *
 * WHAT IS DELIBERATELY ABSENT. There are no row checkboxes and no bulk bar.
 * POS cannot send a message, apply a tag, add to a campaign or export a
 * customer list — there is no endpoint for any of it — so a checkbox column
 * would exist only to lead to a menu of things that cannot be done. The same
 * goes for an email column: POS stores no email against a bill. The Contact
 * column shows the masked mobile and says so.
 *
 * WHAT THE SEARCH MATCHES. Name, the digits of a mobile however it was typed,
 * and an exact Books account reference.
 */

import { Search, SlidersHorizontal, X } from 'lucide-react'
import { count, dateOnly, daysSince, money } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { CustomerDirectoryMeta, CustomerSummary, CustomerTab } from '../types'
import { CUSTOMER_PAGE_SIZE, CUSTOMER_SORTS, CUSTOMER_TABS } from './constants'
import { CustomerAvatar, CustomerTableSkeleton, CustomerTypeBadge, PanelError, customerLabel } from './parts'

export function RecentCustomersPanel({
  rows,
  meta,
  loading,
  stale,
  error,
  tab,
  search,
  sort,
  order,
  page,
  inactiveDays,
  onTab,
  onSearch,
  onSort,
  onOrder,
  onPage,
  onOpen,
  onRetry,
}: {
  rows: CustomerSummary[]
  meta: CustomerDirectoryMeta | null
  loading: boolean
  stale: boolean
  error: string | null
  tab: CustomerTab
  search: string
  sort: string
  order: 'asc' | 'desc'
  page: number
  inactiveDays: number
  onTab: (tab: CustomerTab) => void
  onSearch: (value: string) => void
  onSort: (value: string) => void
  onOrder: (value: 'asc' | 'desc') => void
  onPage: (page: number) => void
  onOpen: (customer: CustomerSummary) => void
  onRetry: () => void
}) {
  const total = meta?.total ?? 0
  const first = total === 0 ? 0 : (page - 1) * CUSTOMER_PAGE_SIZE + 1
  const last = Math.min(page * CUSTOMER_PAGE_SIZE, total)
  const pages = Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE))
  const activeTab = CUSTOMER_TABS.find((t) => t.id === tab)

  return (
    <Panel
      title="Customers"
      description={activeTab?.hint ?? 'Everyone who bought in this period'}
      flush
      action={
        <div className="cg-roster__tools">
          <div className="cg-search">
            <Search size={15} strokeWidth={2} aria-hidden />
            <input
              type="search"
              value={search}
              placeholder="Name, mobile or account reference"
              aria-label="Search customers by name, mobile number or account reference"
              onChange={(e) => onSearch(e.target.value)}
            />
            {search !== '' && (
              <button type="button" onClick={() => onSearch('')} aria-label="Clear the search">
                <X size={14} strokeWidth={2.2} aria-hidden />
              </button>
            )}
          </div>

          <label className="cg-select cg-select--icon">
            <span className="pos-visually-hidden">Sort customers by</span>
            <SlidersHorizontal size={14} strokeWidth={2} aria-hidden />
            <select value={sort} onChange={(e) => onSort(e.target.value)}>
              {CUSTOMER_SORTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="pos-button pos-button--small pos-button--secondary"
            onClick={() => onOrder(order === 'desc' ? 'asc' : 'desc')}
            aria-label={`Sorted ${order === 'desc' ? 'highest first' : 'lowest first'}. Reverse the order.`}
          >
            {order === 'desc' ? 'Highest first' : 'Lowest first'}
          </button>
        </div>
      }
    >
      <div className="cg-tabs" role="tablist" aria-label="Customer groups">
        {CUSTOMER_TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={tab === option.id}
            className="cg-tab"
            title={option.hint}
            onClick={() => onTab(option.id)}
          >
            {option.label}
            <span className="cg-tab__count">{meta ? count(meta.counts[option.id]) : '—'}</span>
          </button>
        ))}
      </div>

      {tab === 'inactive' && (
        <p className="cg-roster__basis">
          No bill in {inactiveDays} days, counted from today rather than from the chosen period.
        </p>
      )}

      <div className={stale ? 'cg-roster cg-roster--stale' : 'cg-roster'} aria-busy={stale}>
        {error ? (
          <div className="cg-roster__state">
            <PanelError message={error} onRetry={onRetry} />
          </div>
        ) : loading ? (
          <CustomerTableSkeleton />
        ) : rows.length === 0 ? (
          <div className="cg-roster__state">
            <Unavailable muted title={search === '' ? 'Nobody in this group' : 'No customers found'}>
              {search === ''
                ? tab === 'inactive'
                  ? 'Every identified customer has bought recently.'
                  : 'No bill in this period carried a customer in this group. Try a wider date range, or all outlets.'
                : 'Try a different name, mobile number or account reference.'}
            </Unavailable>
          </div>
        ) : (
          <>
            <div className="pos-table-wrap cg-table-wrap">
              <table className="pos-table cg-table">
                <caption className="pos-visually-hidden">
                  Customers, {first} to {last} of {count(total)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Standing</th>
                    <th scope="col" className="is-number">Visits</th>
                    <th scope="col" className="is-number">Total spent</th>
                    <th scope="col" className="is-number">Average bill</th>
                    <th scope="col">Last visit</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((customer) => {
                    const quiet = daysSince(customer.last_at)

                    return (
                      <tr key={customer.account_id}>
                        <th scope="row">
                          <button type="button" className="cg-name" onClick={() => onOpen(customer)}>
                            <CustomerAvatar name={customer.name} />
                            <span>
                              <strong>{customerLabel(customer)}</strong>
                              <small>Account #{customer.account_id}</small>
                            </span>
                          </button>
                        </th>
                        <td>
                          {customer.mobile_masked ? (
                            <span className="cg-contact">
                              <span className="cg-contact__number">{customer.mobile_masked}</span>
                              <small>Last 4 digits</small>
                            </span>
                          ) : (
                            <span className="pos-muted">No number on file</span>
                          )}
                        </td>
                        <td>
                          <CustomerTypeBadge type={customer.customer_type} />
                        </td>
                        <td className="is-number">{count(customer.visits)}</td>
                        <td className="is-number">{money(customer.spend)}</td>
                        <td className="is-number">{money(customer.average_bill)}</td>
                        <td>
                          <span className="cg-visit">
                            <span>{dateOnly(customer.last_at)}</span>
                            <small>
                              {customer.outlet_name ?? 'Outlet unknown'}
                              {quiet !== null && quiet >= inactiveDays ? ` · ${quiet} days ago` : ''}
                            </small>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* The same rows as cards, for a screen too narrow to scroll a
                seven-column table without losing the name off the left edge. */}
            <ul className="cg-cards">
              {rows.map((customer) => (
                <li key={customer.account_id}>
                  <button type="button" className="cg-card" onClick={() => onOpen(customer)}>
                    <span className="cg-card__head">
                      <CustomerAvatar name={customer.name} />
                      <span className="cg-card__title">
                        <strong>{customerLabel(customer)}</strong>
                        <small>{customer.mobile_masked ?? `Account #${customer.account_id}`}</small>
                      </span>
                      <CustomerTypeBadge type={customer.customer_type} />
                    </span>
                    <span className="cg-card__figures">
                      <span>
                        <small>Visits</small>
                        <strong>{count(customer.visits)}</strong>
                      </span>
                      <span>
                        <small>Spent</small>
                        <strong>{money(customer.spend)}</strong>
                      </span>
                      <span>
                        <small>Last visit</small>
                        <strong>{dateOnly(customer.last_at)}</strong>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {!loading && !error && total > 0 && (
        <div className="cg-pager">
          <span className="pos-muted">
            {count(first)}–{count(last)} of {count(total)}
          </span>
          <div className="pos-actions">
            <button
              type="button"
              className="pos-button pos-button--small pos-button--secondary"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
            >
              Previous
            </button>
            <span className="pos-muted">
              Page {count(page)} of {count(pages)}
            </span>
            <button
              type="button"
              className="pos-button pos-button--small pos-button--secondary"
              disabled={page >= pages}
              onClick={() => onPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {meta && (
        <div className="cg-roster__foot">
          <p className="pos-note">{meta.basis}</p>
          <p className="pos-note">
            <StatusBadge tone="neutral">Contact details masked</StatusBadge> {meta.contact.note}
          </p>
        </div>
      )}
    </Panel>
  )
}
