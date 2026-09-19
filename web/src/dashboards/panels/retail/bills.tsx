/**
 * What is on the counter, and what has just left it.
 *
 * Both tables were on this board before the operations layout landed and both
 * stay: a held bill nobody resumes is money that never gets counted, and the
 * three separate outcomes of a sale are the only place a shop finds out that a
 * week of takings never reached Inventory.
 */

import { Link } from 'react-router-dom'
import { count, dateTime, duration, money } from '../../format'
import { ContextualEmpty, Panel, StatusBadge } from '../../shell'
import type { RetailBoard } from '../../types'
import { IntegrationBadge, TenderStateBadge } from '../common'

export function HeldBills({ board }: { board: RetailBoard }) {
  return (
    <Panel
      title="Bills on hold"
      description="Shown whatever the date filter says — a bill held yesterday is still on the counter today."
    >
      {board.held_bills.length === 0 ? (
        <ContextualEmpty title="Nothing on hold">
          Every bill that was started has been finished or voided. Nothing is waiting on a counter.
        </ContextualEmpty>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col" className="is-number">Items</th>
                <th scope="col" className="is-number">Value</th>
                <th scope="col" className="is-number">Held for</th>
                <th scope="col">Counter</th>
                <th scope="col"><span className="pos-visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {board.held_bills.map((bill) => (
                <tr key={bill.cart_id}>
                  <th scope="row" style={{ fontWeight: 600 }}>{bill.reference}</th>
                  <td>{bill.customer_name ?? <span className="pos-muted">Walk-in</span>}</td>
                  <td className="is-number">{count(bill.items)}</td>
                  <td className="is-number">{money(bill.total_amount)}</td>
                  <td className="is-number">{duration(bill.held_seconds)}</td>
                  <td>{bill.terminal_code ?? <span className="pos-muted">—</span>}</td>
                  <td>
                    {/* The till owns resuming a bill, and settles the race between
                        two cashiers with a row lock when it does. This is a link
                        to that screen, not a second way to resume. */}
                    <Link className="pos-button pos-button--quiet pos-button--small" to={`/?cart=${bill.cart_id}`}>
                      Open on the till
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

export function RecentTransactions({ board }: { board: RetailBoard }) {
  return (
    <Panel
      title="Recent bills"
      description="Payment, Books and Inventory are three separate outcomes and are shown as three."
    >
      {board.recent.length === 0 ? (
        <ContextualEmpty
          title="No retail activity for this period"
          action={
            <Link className="pos-button pos-button--secondary pos-button--small" to="/">
              Start a sale
            </Link>
          }
        >
          Try another date range, or open the till and ring one up.
        </ContextualEmpty>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th scope="col">Bill</th>
                <th scope="col">Time</th>
                <th scope="col">Customer</th>
                <th scope="col">Counter</th>
                <th scope="col" className="is-number">Total</th>
                <th scope="col">Tender</th>
                <th scope="col">Books</th>
                <th scope="col">Inventory</th>
              </tr>
            </thead>
            <tbody>
              {board.recent.map((row) => (
                <tr key={row.cart_id}>
                  <th scope="row" style={{ fontWeight: 600 }}>
                    {row.books_voucher_no ?? `#${row.cart_id}`}
                    {row.status === 'VOID' && (
                      <>
                        {' '}
                        <StatusBadge tone="danger">Voided</StatusBadge>
                      </>
                    )}
                  </th>
                  <td>{dateTime(row.created_at)}</td>
                  <td>{row.customer_name ?? <span className="pos-muted">Walk-in</span>}</td>
                  <td>{row.terminal_code ?? <span className="pos-muted">—</span>}</td>
                  <td className="is-number">{money(row.total_amount)}</td>
                  <td>
                    <TenderStateBadge state={row.tender_state} />
                    {row.tenders.length > 0 && (
                      <span className="pos-muted" style={{ display: 'block', fontSize: 11.5 }}>
                        {row.tenders.join(' + ')}
                      </span>
                    )}
                  </td>
                  <td><IntegrationBadge state={row.books} /></td>
                  <td><IntegrationBadge state={row.inventory} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
