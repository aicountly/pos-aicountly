/**
 * The drawer a cashier lands in when they press Review.
 *
 * ITS JOB IS TO ANSWER ONE QUESTION: what do I do about this? So it opens with
 * the sale in plain terms, then what is wrong in a sentence about the shop, then
 * the thing to do about it. The API's own words are kept — under Technical
 * details, collapsed, where support reads them. A cashier is never shown a
 * status code as the explanation, and the raw message is never thrown away.
 *
 * Abandoning lives here rather than on the row because it is the one action on
 * this screen that ends a sale's life. It needs a reason, the reason is audited
 * by the API (Audit::record 'offline.abandoned'), and it is only ever offered
 * on a sale the server already holds — the device's copy is not something a
 * person may quietly discard.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Ban, CheckCircle2, RefreshCw, X } from 'lucide-react'
import { money } from '../../ui'
import { explainFailure, type QueueRecord } from '../model'
import { QueueStatusBadge, QueueTypeBadge, dayLabel, timeLabel } from './badges'

export interface ReviewDrawerProps {
  record: QueueRecord
  currency: string
  canResolve: boolean
  online: boolean
  busy: boolean
  onClose: () => void
  onRetry: (record: QueueRecord) => void
  onAbandon: (record: QueueRecord, note: string) => void
  onExport: (record: QueueRecord) => void
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, summary, [tabindex]:not([tabindex="-1"])'

export function TransactionReviewDrawer({
  record,
  currency,
  canResolve,
  online,
  busy,
  onClose,
  onRetry,
  onAbandon,
  onExport,
}: ReviewDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const [abandoning, setAbandoning] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null

    // Focus the panel itself rather than the first control: a drawer that
    // opens with Retry focused is a drawer that posts on a stray Enter.
    panelRef.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }

      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previousOverflow
      restoreTo.current?.focus?.()
    }
  }, [onClose])

  const explanation = explainFailure(record)
  const settled = record.status === 'POSTED'
  const mayAbandon =
    canResolve && record.origin === 'server' && record.status !== 'POSTED' && record.status !== 'ABANDONED'
  const mayRetry = record.status === 'READY' || record.status === 'FAILED' || record.status === 'NEEDS_ATTENTION'

  const technical = [
    `Transaction ID   ${record.clientUuid || '—'}`,
    `Device           ${record.deviceUuid ?? '—'}`,
    `Submission       ${record.submissionId ?? 'not received by the server yet'}`,
    `Server reference ${record.serverReference !== null ? `#${record.serverReference}` : '—'}`,
    `Terminal         ${record.terminalId !== null ? `#${record.terminalId}` : '—'}`,
    `Shift            ${record.sessionId !== null ? `#${record.sessionId}` : '—'}`,
    `Held by          ${record.origin === 'device' ? 'this till' : 'the server'}`,
    `Attempts         ${record.attempts}`,
    `Last attempt     ${record.lastAttemptAt ? `${dayLabel(record.lastAttemptAt)} ${timeLabel(record.lastAttemptAt)}` : '—'}`,
    `Error code       ${record.lastErrorCode ?? '—'}`,
    `Server message   ${record.lastErrorMessage ?? '—'}`,
  ].join('\n')

  return (
    <>
      <button type="button" className="q-scrim" aria-label="Close transaction details" onClick={onClose} />

      <div
        className="q-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="q-drawer-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="q-drawer__head">
          <div>
            <h2 id="q-drawer-title">{record.reference}</h2>
            <p>
              {dayLabel(record.createdAt)} &middot; {timeLabel(record.createdAt)}
            </p>
          </div>
          <button type="button" className="q-iconbtn" onClick={onClose} aria-label="Close">
            <X size={17} aria-hidden />
          </button>
        </div>

        <div className="q-drawer__body">
          <section className="q-section">
            <h3>Transaction details</h3>
            <dl className="q-kv">
              <div>
                <dt>Type</dt>
                <dd>
                  <QueueTypeBadge type={record.type} />
                </dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{record.amount === null ? 'Not held on this till' : money(record.amount, currency)}</dd>
              </div>
              <div>
                <dt>Customer / Table</dt>
                <dd>{record.customer}</dd>
              </div>
              <div>
                <dt>Items</dt>
                <dd>{record.lines === null ? '—' : record.lines}</dd>
              </div>
              <div>
                <dt>Terminal</dt>
                <dd>{record.terminalId !== null ? `POS-${String(record.terminalId).padStart(2, '0')}` : '—'}</dd>
              </div>
              <div>
                <dt>Retry attempts</dt>
                <dd>{record.attempts}</dd>
              </div>
            </dl>
          </section>

          <section className="q-section">
            <h3>Posting status</h3>
            <QueueStatusBadge status={record.status} />
            {record.serverAcknowledgedAt && (
              <p style={{ margin: '8px 0 0', color: 'var(--q-muted)', fontSize: 12.5 }}>
                Server acknowledged at {timeLabel(record.serverAcknowledgedAt)} on{' '}
                {dayLabel(record.serverAcknowledgedAt)}.
              </p>
            )}
          </section>

          <section className="q-section">
            <h3>{settled ? 'What happened' : 'What needs your attention?'}</h3>
            <div className={settled ? 'q-explain q-explain--ok' : 'q-explain'}>
              <p>
                {settled ? (
                  <CheckCircle2 size={14} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />
                ) : (
                  <AlertTriangle size={14} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />
                )}
                {explanation.problem}
              </p>
              <p>
                <strong>What to do: </strong>
                {explanation.resolution}
              </p>
            </div>
          </section>

          <details className="q-details">
            <summary>Technical details</summary>
            <pre className="q-details__body">{technical}</pre>
          </details>

          {abandoning && (
            <section className="q-section">
              <h3>Abandon this transaction</h3>
              <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--q-muted)', lineHeight: 1.55 }}>
                This sale will never reach the books. The reason is recorded against your name and kept for the
                audit. It cannot be undone from this screen.
              </p>
              <textarea
                className="q-textarea"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why is this being abandoned?"
                aria-label="Reason for abandoning this transaction"
              />
            </section>
          )}
        </div>

        <div className="q-drawer__foot">
          <button type="button" className="q-btn" onClick={() => onExport(record)}>
            Export diagnostics
          </button>

          {mayAbandon && !abandoning && (
            <button type="button" className="q-btn q-btn--danger" onClick={() => setAbandoning(true)}>
              <Ban size={14} aria-hidden /> Abandon…
            </button>
          )}

          {abandoning && (
            <>
              <button
                type="button"
                className="q-btn"
                onClick={() => {
                  setAbandoning(false)
                  setNote('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="q-btn q-btn--danger"
                disabled={note.trim().length < 4 || busy}
                onClick={() => onAbandon(record, note.trim())}
              >
                Confirm abandon
              </button>
            </>
          )}

          {!abandoning && (
            <>
              <button type="button" className="q-btn" onClick={onClose}>
                Close
              </button>
              {mayRetry && (
                <button
                  type="button"
                  className="q-btn q-btn--primary"
                  disabled={!online || busy || record.validation !== null}
                  title={
                    record.validation !== null
                      ? 'This one cannot be retried until the problem above is fixed.'
                      : !online
                        ? 'Waiting for the connection'
                        : undefined
                  }
                  onClick={() => onRetry(record)}
                >
                  <RefreshCw size={14} aria-hidden /> {busy ? 'Working…' : 'Retry now'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
