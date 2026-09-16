/**
 * The Restaurant Operations panels.
 *
 * The floor plan and the kitchen board are the two screens a restaurant
 * actually runs on, so both are built properly here rather than as tables with
 * a coloured column.
 */

import { Link } from 'react-router-dom'
import { ShareBars } from '../charts'
import { count, dateTime, decimal, duration, money, titleCase } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { KitchenTicket, RestaurantBoard } from '../types'

const TABLE_STATE_LABEL: Record<string, string> = {
  available: 'Free',
  occupied: 'Seated',
  billing: 'Billing',
  cleaning: 'Clearing',
}

/**
 * The room.
 *
 * Each table states its condition in words as well as by tint, and the legend
 * below names all four — a floor plan that means something only in colour is
 * unusable to a captain who cannot separate the greens from the ambers.
 */
export function FloorPlan({ board }: { board: RestaurantBoard }) {
  return (
    <Panel
      title="Floor"
      description={`${count(board.kpis.tables_occupied)} of ${count(board.kpis.tables_total)} tables seated · ${count(board.kpis.covers)} covers.`}
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to="/floor">
          Open the floor screen
        </Link>
      }
    >
      {board.floors.length === 0 ? (
        <Unavailable muted title="No floor plan yet">
          Add a floor and its tables under Setup.
        </Unavailable>
      ) : (
        board.floors.map((floor) => (
          <div key={floor.floor_id} style={{ marginBottom: 18 }}>
            <h3>{floor.floor_name}</h3>
            <div className="pos-table-grid">
              {floor.tables.map((table) => (
                <Link
                  key={table.table_id}
                  to={table.table_session_id ? `/floor?session=${table.table_session_id}` : '/floor'}
                  className={`pos-tablecard pos-tablecard--${table.state}`}
                  aria-label={`Table ${table.table_code}, ${TABLE_STATE_LABEL[table.state]}${
                    table.covers ? `, ${table.covers} covers` : ''
                  }`}
                >
                  <span className="pos-tablecard__code">{table.table_code}</span>
                  <StatusBadge
                    tone={
                      table.state === 'available'
                        ? 'neutral'
                        : table.state === 'billing'
                          ? 'warning'
                          : table.state === 'cleaning'
                            ? 'info'
                            : 'success'
                    }
                  >
                    {TABLE_STATE_LABEL[table.state]}
                  </StatusBadge>
                  <span className="pos-tablecard__meta">
                    {table.table_session_id ? (
                      <>
                        {count(table.covers ?? 0)} of {count(table.seats)} seats
                        <br />
                        {duration(table.seated_seconds)} seated
                        {table.running_total !== null && table.running_total > 0 && (
                          <>
                            <br />
                            {money(table.running_total)} on the bill
                          </>
                        )}
                      </>
                    ) : (
                      <>Seats {count(table.seats)}</>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="pos-legend">
        {(['available', 'occupied', 'billing', 'cleaning'] as const).map((state) => (
          <span key={state} className="pos-legend__item">
            <span
              className="pos-legend__swatch pos-legend__swatch--square"
              style={{
                background:
                  state === 'available'
                    ? '#eef2ef'
                    : state === 'occupied'
                      ? 'var(--pos-soft-green)'
                      : state === 'billing'
                        ? '#fffaf0'
                        : '#f5f8fd',
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)',
              }}
              aria-hidden
            />
            {TABLE_STATE_LABEL[state]}
          </span>
        ))}
      </div>
    </Panel>
  )
}

function Ticket({ ticket }: { ticket: KitchenTicket }) {
  return (
    <article className={`pos-ticket${ticket.overdue ? ' pos-ticket--overdue' : ''}`}>
      <div className="pos-ticket__head">
        <span className="pos-ticket__no">{ticket.kot_no}</span>
        <span className="pos-muted" style={{ fontSize: 11.5 }}>
          {ticket.table_code ? `Table ${ticket.table_code}` : titleCase(ticket.order_kind)}
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <StatusBadge tone={ticket.overdue ? 'danger' : 'neutral'}>
          {duration(ticket.elapsed_seconds)}
          {ticket.overdue ? ` · ${duration(ticket.overdue_by_seconds)} late` : ''}
        </StatusBadge>
        <StatusBadge tone="info">{ticket.station_name}</StatusBadge>
        {ticket.priority !== 'normal' && <StatusBadge tone="warning">{titleCase(ticket.priority)}</StatusBadge>}
        {ticket.kot_kind !== 'new' && <StatusBadge tone="neutral">{titleCase(ticket.kot_kind)}</StatusBadge>}
      </div>

      <ul className="pos-ticket__lines">
        {ticket.lines.map((line, index) => (
          <li key={index}>
            <span className="pos-ticket__qty">{decimal(line.quantity, 0)}×</span>
            <span>
              {line.display_name}
              {line.instructions && (
                <span className="pos-muted" style={{ display: 'block' }}>
                  {line.instructions}
                </span>
              )}
              {line.allergy_note && (
                <span className="pos-ticket__note" style={{ display: 'block' }}>
                  Allergy: {line.allergy_note}
                </span>
              )}
            </span>
          </li>
        ))}
        {ticket.lines.length === 0 && <li className="pos-muted">{count(ticket.line_count)} items</li>}
      </ul>
    </article>
  )
}

/**
 * The kitchen board.
 *
 * Read-only here. State transitions belong on the kitchen screen, where the
 * concurrency check lives — two expo screens advancing the same ticket is a
 * real race and it is settled by the server, not by whichever button was
 * pressed first.
 */
export function KitchenBoard({ board }: { board: RestaurantBoard }) {
  const columns: Array<{ key: keyof RestaurantBoard['kitchen']; label: string }> = [
    { key: 'queued', label: 'Queued' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' },
  ]

  const empty = columns.every((column) => board.kitchen[column.key].length === 0)

  return (
    <Panel
      title="Kitchen"
      description="Live tickets. Advancing one is done on the kitchen screen, where the transition is guarded."
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to="/kitchen">
          Open the kitchen screen
        </Link>
      }
    >
      {empty ? (
        <Unavailable muted title="No tickets out">
          Every ticket has been served or cancelled.
        </Unavailable>
      ) : (
        <div className="pos-kitchen-board">
          {columns.map((column) => (
            <section key={column.key} className="pos-kitchen-column" aria-label={`${column.label} tickets`}>
              <header className="pos-kitchen-column__head">
                <span>{column.label}</span>
                <span>{count(board.kitchen[column.key].length)}</span>
              </header>
              {board.kitchen[column.key].map((ticket) => (
                <Ticket key={ticket.kot_id} ticket={ticket} />
              ))}
              {board.kitchen[column.key].length === 0 && <p className="pos-muted">Nothing here.</p>}
            </section>
          ))}
        </div>
      )}
    </Panel>
  )
}

export function OrderChannels({ board }: { board: RestaurantBoard }) {
  return (
    <Panel title="Order channels" description="Where the orders came from in this period.">
      <ShareBars
        rows={board.channels.channels.map((channel) => ({
          key: channel.order_kind,
          label: channel.display_name,
          value: channel.orders,
          note: `${money(channel.net)} taken`,
        }))}
        format={(v) => `${count(v)} order${v === 1 ? '' : 's'}`}
        emptyLabel="No restaurant orders in this period."
      />
      <p className="pos-note">{board.channels.note}</p>
    </Panel>
  )
}

export function MenuAvailability({ board }: { board: RestaurantBoard }) {
  return (
    <Panel
      title="Menu availability"
      description={`${count(board.menu.available)} of ${count(board.menu.total)} items available.`}
    >
      {board.menu.total === 0 ? (
        <Unavailable muted title="No menu yet">
          Build the menu under Setup to see availability here.
        </Unavailable>
      ) : board.menu.items.length === 0 ? (
        <Unavailable muted title="Everything is on">
          Nothing has been marked sold out or paused.
        </Unavailable>
      ) : (
        <div className="pos-stack pos-stack--tight">
          {board.menu.items.map((item) => (
            <div key={item.menu_item_id} className="pos-split">
              <span style={{ minWidth: 0 }}>
                <strong>{item.display_name}</strong>
                {item.note && (
                  <span className="pos-muted" style={{ display: 'block' }}>
                    “{item.note}”
                  </span>
                )}
                {item.set_at && (
                  <span className="pos-muted" style={{ display: 'block', fontSize: 11.5 }}>
                    Set {dateTime(item.set_at)}
                  </span>
                )}
              </span>
              <StatusBadge tone={item.availability === 'SOLD_OUT' ? 'danger' : 'warning'}>
                {titleCase(item.availability)}
              </StatusBadge>
            </div>
          ))}
        </div>
      )}
      <p className="pos-note">{board.menu.note}</p>
    </Panel>
  )
}

export function DelayAttention({ board }: { board: RestaurantBoard }) {
  return (
    <Panel
      title="Running late"
      description="Against each station's own late-after time."
      action={<StatusBadge tone="neutral">Rule-based alert</StatusBadge>}
    >
      {board.delays.items.length === 0 ? (
        <Unavailable muted title="Nothing is late">
          Every open ticket is inside its station's time.
        </Unavailable>
      ) : (
        <div className="pos-stack pos-stack--tight">
          {board.delays.items.map((item) => (
            <div key={item.kot_id} className="pos-split">
              <span style={{ minWidth: 0 }}>
                <strong>{item.kot_no}</strong>
                <span className="pos-muted" style={{ display: 'block' }}>
                  {item.table_code ? `Table ${item.table_code}` : titleCase(item.order_kind)} · {item.station_name} ·{' '}
                  {titleCase(item.status)}
                </span>
              </span>
              <StatusBadge tone="danger">{duration(item.overdue_by_seconds)} late</StatusBadge>
            </div>
          ))}
        </div>
      )}
      <p className="pos-note">{board.delays.note}</p>
    </Panel>
  )
}

export function UnsettledBills({ board }: { board: RestaurantBoard }) {
  return (
    <Panel title="Still to settle" description="Open orders on the floor right now.">
      <div className="pos-stack pos-stack--tight">
        <div className="pos-split">
          <span>Open orders</span>
          <strong>{count(board.kpis.open_orders)}</strong>
        </div>
        <div className="pos-split">
          <span>On a table</span>
          <strong>{count(board.kpis.unsettled_bills)}</strong>
        </div>
        <div className="pos-split pos-split--total pos-split--emphasis">
          <span>Value on the floor</span>
          <strong>{money(board.kpis.unsettled_value)}</strong>
        </div>
      </div>
      <p className="pos-note">
        Not windowed by date: an order on the floor is open whatever the filter says. Settle one from{' '}
        <Link className="pos-link" to="/floor">
          the floor screen
        </Link>
        .
      </p>
    </Panel>
  )
}

