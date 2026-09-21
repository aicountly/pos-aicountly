/**
 * Stopping a ticket the kitchen already has.
 *
 * A reason is required, not encouraged. By the time a ticket is on this screen
 * the food may be made, and the server writes the reason to the approval trail
 * beside the lines that were being cooked — a cancel with no reason is a cost
 * nobody can account for later, and the API refuses one.
 *
 * A real dialog rather than window.prompt: a prompt cannot say what is being
 * cancelled, is suppressed outright in some embedded browsers, and cannot be
 * styled to look like it belongs to this application.
 */

import { useEffect, useRef, useState } from 'react'
import { Ban } from 'lucide-react'
import type { KitchenTicket } from '../types'
import { ticketWhere } from '../derive'

export function CancelTicketDialog({
  ticket,
  busy,
  onConfirm,
  onClose,
}: {
  ticket: KitchenTicket
  busy: boolean
  onConfirm: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    field.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      returnTo.current?.focus()
    }
  }, [onClose])

  const trimmed = reason.trim()
  const invalid = touched && trimmed === ''

  return (
    <>
      <button type="button" className="kds-scrim" aria-label="Keep the ticket" onClick={onClose} />
      <div className="kds-dialog" role="dialog" aria-modal="true" aria-labelledby="kds-cancel-title">
        <h2 id="kds-cancel-title">Stop ticket #{ticket.ticketNo}?</h2>
        <p>
          {ticketWhere(ticket)} · {ticket.lineCount} item{ticket.lineCount === 1 ? '' : 's'}.
          {ticket.lane === 'preparing' || ticket.lane === 'ready'
            ? ' This ticket has already been cooked or started, so the wastage is recorded against the reason you give.'
            : ' The kitchen will stop on this ticket and the reason is recorded.'}
        </p>

        <label className="kds-dialog__field">
          <span>Reason</span>
          <textarea
            ref={field}
            value={reason}
            rows={3}
            aria-invalid={invalid}
            aria-describedby={invalid ? 'kds-cancel-error' : undefined}
            placeholder="Guest cancelled, wrong table, item unavailable…"
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          {invalid && (
            <span id="kds-cancel-error" className="kds-dialog__error">
              Say why the kitchen should stop, so it goes on the record.
            </span>
          )}
        </label>

        <div className="kds-dialog__actions">
          <button type="button" className="kds-btn" onClick={onClose}>
            Keep cooking
          </button>
          <button
            type="button"
            className="kds-action kds-action--start"
            style={{ width: 'auto' }}
            disabled={busy || trimmed === ''}
            onClick={() => {
              setTouched(true)
              if (trimmed !== '') onConfirm(trimmed)
            }}
          >
            <Ban size={15} aria-hidden />
            {busy ? 'Stopping…' : 'Stop this ticket'}
          </button>
        </div>
      </div>
    </>
  )
}
