/**
 * Everything the kitchen has finished in the window the server carries.
 *
 * Deliberately not "all history": this is the KDS endpoint's served list, and
 * it says so. A full ticket history is a report over a date range and belongs
 * on the Restaurant board, which counts it in the database rather than over
 * whatever happens to be in a browser.
 */

import type { KitchenTicket } from '../types'
import { minutesLabel, ticketWhere } from '../derive'
import { Drawer } from './Drawer'

export function KitchenHistoryDrawer({
  tickets,
  onClose,
}: {
  tickets: KitchenTicket[]
  onClose: () => void
}) {
  return (
    <Drawer
      title="Recently served"
      description={
        tickets.length === 0
          ? 'Nothing has been served in this window.'
          : `The last ${tickets.length} ticket${tickets.length === 1 ? '' : 's'} the kitchen completed.`
      }
      onClose={onClose}
    >
      <div className="kds-history">
        {tickets.map((ticket) => (
          <article key={ticket.id} className="kds-ticket kds-ticket--served">
            <div className="kds-ticket__top">
              <div style={{ minWidth: 0 }}>
                <strong className="kds-ticket__id">#{ticket.ticketNo}</strong>
                <span className="kds-ticket__where">{ticketWhere(ticket)}</span>
              </div>
              <span className="kds-ticket__served-at">
                {ticket.servedAt
                  ? new Date(ticket.servedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </span>
            </div>

            <div className="kds-ticket__tags">
              <span className="kds-tag kds-tag--success">Served</span>
              <span className="kds-tag">{minutesLabel(ticket.prepSecondsAtFetch)} to cook</span>
              {ticket.stationName && <span className="kds-tag kds-tag--info">{ticket.stationName}</span>}
            </div>

            <ul className="kds-ticket__items">
              {ticket.lines.map((line) => (
                <li key={line.kot_line_id} className="kds-ticket__item">
                  <span className="kds-ticket__qty" aria-hidden>
                    {line.quantity}
                  </span>
                  <span className="kds-ticket__name">
                    <span className="pos-visually-hidden">{line.quantity} × </span>
                    {line.display_name}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </Drawer>
  )
}
