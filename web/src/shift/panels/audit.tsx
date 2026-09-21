/**
 * Everything that happened on this shift, in the order it happened.
 *
 * PAGED, NOT DOWNLOADED. A Saturday shift has hundreds of events; twelve of
 * them fit on the card and the rest are a page away. The first page arrives
 * with the board, so the card has something to draw on the first paint and
 * only re-asks the server when somebody filters or turns a page.
 *
 * SALE TENDERS ARE ABSENT ON PURPOSE. Every cash sale is a drawer event, and
 * four hundred of them would bury the six movements somebody is looking for.
 * They are in the tender mix and the cash summary, which is where they answer
 * a question.
 */

import { Clock3 } from 'lucide-react'
import { Note } from './states'
import { EVENTS_PER_PAGE, type EventsState } from '../useShiftReport'
import { clockLabel, moneyExact } from '../format'
import type { EventSeverity } from '../types'

const SEVERITY_WORDS: Record<EventSeverity, string> = {
  normal: 'Normal',
  review: 'Worth a look',
  exception: 'Exception',
}

export function ShiftAuditTrail({ events, timezone }: { events: EventsState; timezone: string }) {
  const page = Math.floor(events.offset / EVENTS_PER_PAGE) + 1
  const pages = Math.max(1, Math.ceil(events.total / EVENTS_PER_PAGE))

  return (
    <section className="shift-card" aria-label="Shift events and audit trail">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <Clock3 size={14} />
            </span>
            Shift Events &amp; Audit Trail
          </h2>
          <p>Key events from this shift</p>
        </div>

        <label>
          <span className="pos-visually-hidden">Filter the trail</span>
          <select className="shift-control" value={events.kind} onChange={(event) => events.setKind(event.target.value)}>
            {events.kinds.map((kind) => (
              <option key={kind.key} value={kind.key} disabled={kind.count === 0 && kind.key !== 'all'}>
                {kind.label}
                {kind.key === 'all' ? '' : ` (${kind.count})`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {events.error ? (
        <div style={{ marginTop: 12 }}>
          <Note tone="danger" title="Unable to load the trail.">
            {events.error}
          </Note>
        </div>
      ) : events.items.length === 0 ? (
        <p className="shift-card__note">
          {events.kind === 'all'
            ? 'Nothing has been recorded on this shift yet.'
            : 'Nothing of that kind happened on this shift.'}
        </p>
      ) : (
        <div className="shift-scroll" style={{ marginTop: 12, opacity: events.loading ? 0.55 : 1 }}>
          <table className="shift-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Details</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {events.items.map((event) => (
                <tr key={event.id}>
                  <td className="is-muted" style={{ whiteSpace: 'nowrap' }}>
                    {clockLabel(event.at, timezone)}
                  </td>
                  <td>
                    <span className="shift-table__lead">
                      {/* The dot is decoration; the word beside it in the
                          accessible name is the severity. */}
                      <span className={`shift-dot shift-dot--${event.severity}`} aria-hidden />
                      {event.title}
                      <span className="pos-visually-hidden"> — {SEVERITY_WORDS[event.severity]}</span>
                    </span>
                  </td>
                  <td className="is-muted">
                    {event.amount !== null && <strong style={{ color: 'var(--pos-text)' }}>{moneyExact(event.amount)}</strong>}
                    {event.amount !== null && event.detail ? ' · ' : ''}
                    {event.detail ?? (event.amount === null ? '—' : '')}
                    {/* The reason a cashier typed often names the order already;
                        printing it again reads as two different orders. */}
                    {event.cart_id !== null && !(event.detail ?? '').includes(`#${event.cart_id}`) && (
                      <> · order #{event.cart_id}</>
                    )}
                  </td>
                  <td>
                    <span title={event.actor.resolved ? undefined : event.actor.uuid}>{event.actor.label}</span>
                    {event.approved_by && (
                      <span className="is-muted" style={{ display: 'block', fontSize: 10.5 }}>
                        approved by {event.approved_by.label}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {events.total > EVENTS_PER_PAGE && (
        <div className="shift-pager">
          <span role="status" aria-live="polite">
            {events.loading ? 'Loading…' : `${events.total} events · page ${page} of ${pages}`}
          </span>
          <span className="shift-pager__buttons">
            <button
              type="button"
              className="shift-button"
              onClick={() => events.setOffset(Math.max(0, events.offset - EVENTS_PER_PAGE))}
              disabled={events.offset === 0 || events.loading}
            >
              Previous
            </button>
            <button
              type="button"
              className="shift-button"
              onClick={() => events.setOffset(events.offset + EVENTS_PER_PAGE)}
              disabled={page >= pages || events.loading}
            >
              Next
            </button>
          </span>
        </div>
      )}
    </section>
  )
}
