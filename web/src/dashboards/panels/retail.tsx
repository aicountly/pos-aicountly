/**
 * The Retail Operations panels.
 *
 * The board a counter manager keeps open. Two of these panels are careful about
 * what they claim: Device health reports configuration and says so, and Stock
 * attention reports Inventory's live answer or says it could not get one.
 */

import { Link } from 'react-router-dom'
import { actor, count, dateTime, decimal, duration, money, sinceLabel, titleCase } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { RetailBoard } from '../types'
import type { DashboardFilters } from '../useDashboard'
import { withFilters } from '../registry'
import { AttentionRow, IntegrationBadge, TenderStateBadge } from './common'

export function CounterGrid({
  board,
  filters,
  onTerminal,
}: {
  board: RetailBoard
  filters: DashboardFilters
  onTerminal: (terminalId: number) => void
}) {
  return (
    <Panel
      title="Counters"
      description={`${count(board.kpis.active_counters)} of ${count(board.kpis.total_counters)} tills have a shift open.`}
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/controls', filters)}>
          Shifts and drawers
        </Link>
      }
    >
      {board.counters.length === 0 ? (
        <Unavailable muted title="No tills yet">
          Add a till under Setup before this board has counters to show.
        </Unavailable>
      ) : (
        <div className="pos-counter-grid">
          {board.counters.map((counter) => (
            <button
              key={counter.terminal_id}
              type="button"
              className={`pos-counter pos-counter--${counter.state}`}
              onClick={() => onTerminal(counter.terminal_id)}
              aria-label={`${counter.display_name}, ${
                counter.state === 'closed' ? 'no shift open' : counter.state === 'busy' ? 'serving' : 'open'
              }. Focus this counter.`}
            >
              <div className="pos-counter__title">
                <span className="pos-counter__name">{counter.display_name}</span>
                <StatusBadge
                  tone={counter.state === 'busy' ? 'warning' : counter.state === 'open' ? 'success' : 'neutral'}
                  dot
                >
                  {counter.state === 'busy' ? 'Serving' : counter.state === 'open' ? 'Open' : 'Closed'}
                </StatusBadge>
              </div>

              <div className="pos-muted" style={{ fontSize: 12, marginTop: 4 }}>
                {counter.location_name}
                {counter.shift ? ` · ${actor(counter.shift.opened_by)} since ${dateTime(counter.shift.opened_at)}` : ' · no shift open'}
              </div>

              <div className="pos-counter__figures">
                <span className="pos-counter__figure">
                  <strong>{money(counter.net)}</strong> taken
                </span>
                <span className="pos-counter__figure">
                  <strong>{count(counter.bills)}</strong> bills
                </span>
                {counter.open_carts > 0 && (
                  <span className="pos-counter__figure">
                    <strong>{count(counter.open_carts)}</strong> on the counter
                  </span>
                )}
              </div>

              <div className="pos-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                Last activity {sinceLabel(counter.last_activity)}
              </div>
            </button>
          ))}
        </div>
      )}
    </Panel>
  )
}

export function HeldBills({ board }: { board: RetailBoard }) {
  return (
    <Panel
      title="Bills on hold"
      description="Shown whatever the date filter says — a bill held yesterday is still on the counter today."
    >
      {board.held_bills.length === 0 ? (
        <Unavailable muted title="Nothing on hold">
          Every bill that was started has been finished or voided.
        </Unavailable>
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
        <Unavailable muted title="No bills in this period">
          Narrow or widen the dates, or open a till.
        </Unavailable>
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

/**
 * Peripherals.
 *
 * There is no green "Connected" dot on this panel and there cannot honestly be
 * one: a browser has no way to ask whether a receipt printer has paper or a
 * scanner is plugged in. What POS knows is what someone typed into the till's
 * setup, and that is what this shows.
 */
export function DeviceHealth({ board }: { board: RetailBoard }) {
  return (
    <Panel title="Devices" description="What each till is configured with.">
      <Unavailable title="Not verified">{board.devices.note}</Unavailable>

      <div className="pos-stack" style={{ marginTop: 14 }}>
        {board.devices.terminals.map((terminal) => (
          <div key={terminal.terminal_id}>
            <div className="pos-split">
              <strong>{terminal.display_name}</strong>
              <span className="pos-muted">
                {count(terminal.active_devices)} registered device{terminal.active_devices === 1 ? '' : 's'}
                {terminal.revoked_devices > 0 && `, ${count(terminal.revoked_devices)} revoked`}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {terminal.peripherals.map((peripheral) => (
                <StatusBadge
                  key={peripheral.kind}
                  tone={peripheral.state === 'configured' ? 'info' : 'neutral'}
                >
                  {peripheral.label}: {peripheral.state === 'configured' ? (peripheral.value ?? 'set') : 'not set up'}
                </StatusBadge>
              ))}
            </div>
          </div>
        ))}
        {board.devices.terminals.length === 0 && <p className="pos-muted">No tills to report on.</p>}
      </div>
    </Panel>
  )
}

/**
 * Low stock, read live from Inventory on this request.
 *
 * An unreachable Inventory renders as unknown, never as an empty list — the two
 * look identical in a table and only one of them means "stop reordering".
 */
export function StockAttention({ board }: { board: RetailBoard }) {
  return (
    <Panel
      title="Stock needing attention"
      description={board.stock.available ? 'Live from Inventory. Nothing here is stored in POS.' : undefined}
      action={
        <span className="pos-muted" style={{ fontSize: 12 }}>
          {board.stock.available ? `Read ${sinceLabel(board.stock.fetched_at)}` : 'Not available'}
        </span>
      }
    >
      {!board.stock.available ? (
        <Unavailable title="Stock levels are unknown right now">{board.stock.note}</Unavailable>
      ) : board.stock.items.length === 0 ? (
        <Unavailable muted title="Nothing is below its reorder level">
          Inventory answered and had nothing to flag.
        </Unavailable>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="is-number">Available</th>
                <th scope="col" className="is-number">Reorder at</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {board.stock.items.map((item, index) => (
                <tr key={`${item.item_id ?? index}`}>
                  <th scope="row" style={{ fontWeight: 500 }}>{item.display_name}</th>
                  <td className="is-number">{decimal(item.available, 2)}</td>
                  <td className="is-number">{decimal(item.reorder_level, 2)}</td>
                  <td>
                    <StatusBadge tone={(item.available ?? 0) <= 0 ? 'danger' : 'warning'}>
                      {(item.available ?? 0) <= 0 ? 'Out of stock' : 'Low stock'}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {board.stock.available && <p className="pos-note">{board.stock.source}</p>}
    </Panel>
  )
}

export function RetailAttention({ board, filters }: { board: RetailBoard; filters: DashboardFilters }) {
  return (
    <Panel title="Needs a person" description="Counted over the chosen period.">
      <div className="pos-stack pos-stack--tight">
        <AttentionRow
          label="Bills voided before payment"
          value={board.attention.voids}
          tone="warning"
          href={withFilters('/controls', filters, { panel: 'approvals' })}
        />
        <AttentionRow
          label="Sales stuck between products"
          description="Not reached Books or Inventory."
          value={board.attention.stuck}
          tone="danger"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        {board.attention.approvals.map((approval) => (
          <AttentionRow
            key={approval.event_kind}
            label={titleCase(approval.event_kind)}
            value={approval.count}
            tone="info"
            href={withFilters('/controls', filters, { panel: 'approvals' })}
          />
        ))}
      </div>
    </Panel>
  )
}
