/**
 * One kitchen ticket.
 *
 * The card is ordered the way a cook reads it: WHAT and WHERE at the top, HOW
 * LONG beside it, the food in the middle at a size that survives three metres
 * and steam, then the one button that moves it on.
 *
 * Exceptions are loud but local. An allergy note gets its own red block and is
 * never truncated; an urgent ticket gets a red edge and the word "Urgent". The
 * card itself does not turn red, because when every card is red none of them
 * is — the time badge carries lateness, and it carries it in minutes as well
 * as in colour.
 */

import { memo, useEffect, useRef, useState } from 'react'
import {
  Ban,
  Bell,
  Clock,
  EllipsisVertical,
  Flame,
  Play,
  TriangleAlert,
} from 'lucide-react'
import type { KotStatus } from '../../services/types'
import type { KitchenTicket as Ticket, SlaBand } from '../types'
import { PRIORITY_LABEL, ageing, handoffVerb, minutesLabel, readyVerb, ticketWhere } from '../derive'

const BAND_WORD: Record<SlaBand, string> = {
  fresh: 'on time',
  steady: 'on time',
  due: 'nearing target',
  late: 'past target',
}

function TicketMenu({
  ticket,
  canOperate,
  canCancel,
  busy,
  onAdvance,
  onCancel,
}: {
  ticket: Ticket
  canOperate: boolean
  canCancel: boolean
  busy: boolean
  onAdvance: (to: KotStatus) => void
  onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)

    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  // Only what this ticket can actually do, from where it is. There is no
  // "move back": the API's flow goes one way, and offering a button the server
  // would refuse is worse than not offering it.
  const steps: { to: KotStatus; label: string }[] = []
  if (ticket.status === 'NEW' || ticket.status === 'ACCEPTED') {
    steps.push({ to: 'PREPARING', label: 'Start cooking' }, { to: 'READY', label: readyVerb(ticket) })
  } else if (ticket.status === 'PREPARING') {
    steps.push({ to: 'READY', label: readyVerb(ticket) })
  } else if (ticket.status === 'READY') {
    steps.push({ to: 'SERVED', label: handoffVerb(ticket) })
  }

  return (
    <div className="kds-ticket__menu" ref={wrap}>
      <button
        type="button"
        className="kds-iconbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ticket ${ticket.ticketNo}`}
        onClick={() => setOpen((value) => !value)}
      >
        <EllipsisVertical size={17} aria-hidden />
      </button>

      {open && (
        <div className="kds-menu" role="menu">
          {steps.map((step) => (
            <button
              key={step.to}
              type="button"
              role="menuitem"
              disabled={!canOperate || busy}
              onClick={() => {
                setOpen(false)
                onAdvance(step.to)
              }}
            >
              {step.label}
            </button>
          ))}

          {canCancel && ticket.status !== 'SERVED' && (
            <button
              type="button"
              role="menuitem"
              className="kds-menu__danger"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                onCancel()
              }}
            >
              <Ban size={15} aria-hidden />
              Cancel ticket…
            </button>
          )}

          {steps.length === 0 && !canCancel && (
            <p className="kds-menu__note">Nothing more to do with this ticket.</p>
          )}
          {!canOperate && steps.length > 0 && (
            <p className="kds-menu__note">Your role cannot advance kitchen tickets.</p>
          )}
        </div>
      )}
    </div>
  )
}

export interface TicketCardProps {
  ticket: Ticket
  nowMs: number
  fetchedAt: number
  warnPc: number
  busy: boolean
  arrived: boolean
  canOperate: boolean
  canCancel: boolean
  onAdvance: (ticket: Ticket, to: KotStatus) => void
  onCancel: (ticket: Ticket) => void
}

export const KitchenTicketCard = memo(function KitchenTicketCard({
  ticket,
  nowMs,
  fetchedAt,
  warnPc,
  busy,
  arrived,
  canOperate,
  canCancel,
  onAdvance,
  onCancel,
}: TicketCardProps) {
  const age = ageing(ticket, nowMs, fetchedAt, warnPc)
  const served = ticket.lane === 'served'
  const urgent = ticket.priority === 'rush' || ticket.priority === 'high'

  const classes = ['kds-ticket']
  if (served) classes.push('kds-ticket--served')
  if (!served && age.band === 'late') classes.push('kds-ticket--late')
  if (!served && ticket.priority === 'rush') classes.push('kds-ticket--urgent')
  if (arrived) classes.push('kds-ticket--arrived')

  const overdue = age.band === 'late' && !served
  const timeLabel = overdue ? `+${minutesLabel(age.overdueSeconds)}` : minutesLabel(age.seconds)

  return (
    <article className={classes.join(' ')} aria-label={`Ticket ${ticket.ticketNo}, ${ticket.status.toLowerCase()}`}>
      <div className="kds-ticket__top">
        <div className="kds-ticket__ident">
          <strong className="kds-ticket__id">#{ticket.ticketNo}</strong>
          <span className="kds-ticket__where">{ticketWhere(ticket)}</span>
        </div>

        <div className="kds-ticket__right">
          <span
            className={`kds-time kds-time--${served ? 'fresh' : age.band}`}
            title={
              overdue
                ? `${minutesLabel(age.seconds)} on a ${Math.round(ticket.targetSeconds / 60)} minute target — ${minutesLabel(age.overdueSeconds)} over. Fired ${new Date(ticket.firedAt).toLocaleTimeString()}.`
                : `Fired ${new Date(ticket.firedAt).toLocaleTimeString()} · target ${Math.round(ticket.targetSeconds / 60)} min`
            }
          >
            <Clock size={12} aria-hidden />
            {timeLabel}
            {/* The colour is reinforcement. This is the status. */}
            <span className="pos-visually-hidden">
              {overdue ? ` over a ${Math.round(ticket.targetSeconds / 60)} minute target` : ''},{' '}
              {served ? 'served' : BAND_WORD[age.band]}
            </span>
          </span>

          {!served && (
            <TicketMenu
              ticket={ticket}
              canOperate={canOperate}
              canCancel={canCancel}
              busy={busy}
              onAdvance={(to) => onAdvance(ticket, to)}
              onCancel={() => onCancel(ticket)}
            />
          )}
        </div>
      </div>

      <div className="kds-ticket__tags">
        {served ? (
          <span className="kds-tag kds-tag--success">Served</span>
        ) : (
          <span className={urgent ? 'kds-tag kds-tag--danger' : 'kds-tag'}>
            {ticket.priority === 'rush' && <Flame size={11} aria-hidden />}
            {PRIORITY_LABEL[ticket.priority]}
          </span>
        )}

        {ticket.stationName && <span className="kds-tag kds-tag--info">{ticket.stationName}</span>}
        {ticket.kind !== 'new' && (
          <span className="kds-tag kds-tag--warning">{ticket.kind === 'addon' ? 'Add-on' : 'Amended'}</span>
        )}
        {ticket.customerName && <span className="kds-tag">{ticket.customerName}</span>}
      </div>

      {ticket.allergyNotes.length > 0 && (
        <p className="kds-ticket__allergy">
          <TriangleAlert size={15} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Allergy: {ticket.allergyNotes.join(' · ')}</span>
        </p>
      )}

      <ul className="kds-ticket__items">
        {ticket.lines.map((line) => (
          <li key={line.kot_line_id} className="kds-ticket__item">
            <span className="kds-ticket__qty" aria-hidden>
              {line.quantity}
            </span>
            <span className="kds-ticket__name">
              <span className="pos-visually-hidden">{line.quantity} × </span>
              {line.display_name}
              {line.modifiers.length > 0 && (
                <span className="kds-ticket__mods">{line.modifiers.map((m) => m.option_name).join(' · ')}</span>
              )}
              {line.instructions && <span className="kds-ticket__instruction">{line.instructions}</span>}
            </span>
          </li>
        ))}
        {ticket.lines.length === 0 && (
          <li className="kds-ticket__item">
            <span className="kds-ticket__qty" aria-hidden>
              {ticket.lineCount}
            </span>
            <span className="kds-ticket__name">
              {ticket.lineCount} item{ticket.lineCount === 1 ? '' : 's'} on this ticket
            </span>
          </li>
        )}
      </ul>

      {ticket.notes && (
        <p className="kds-ticket__note">
          <Bell size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{ticket.notes}</span>
        </p>
      )}

      {ticket.lane === 'preparing' && (
        <div
          className="kds-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(age.ratio * 100))}
          aria-label={`${minutesLabel(age.seconds)} of a ${Math.round(ticket.targetSeconds / 60)} minute target`}
        >
          <div
            className={`kds-progress__fill kds-progress__fill--${age.band}`}
            style={{ width: `${Math.min(100, Math.round(age.ratio * 100))}%` }}
          />
        </div>
      )}

      {served ? (
        <div className="kds-ticket__foot">
          <span className="kds-tag">{minutesLabel(ticket.prepSecondsAtFetch)} to cook</span>
          {ticket.servedAt && (
            <span className="kds-ticket__served-at">
              {new Date(ticket.servedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      ) : (
        ticket.nextStatus && (
          <button
            type="button"
            className={`kds-action kds-action--${
              ticket.lane === 'new' ? 'start' : ticket.lane === 'preparing' ? 'ready' : 'serve'
            }`}
            disabled={busy || !canOperate}
            onClick={() => ticket.nextStatus && onAdvance(ticket, ticket.nextStatus)}
            title={canOperate ? undefined : 'Your role cannot advance kitchen tickets'}
          >
            {busy ? (
              'Working…'
            ) : ticket.lane === 'new' ? (
              <>
                <Play size={15} aria-hidden /> Start cooking
              </>
            ) : ticket.lane === 'preparing' ? (
              <>
                <Bell size={15} aria-hidden /> {readyVerb(ticket)}
              </>
            ) : (
              <>
                <Bell size={15} aria-hidden /> {handoffVerb(ticket)}
              </>
            )}
          </button>
        )
      )}
    </article>
  )
})
