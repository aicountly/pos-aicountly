/**
 * The cash sheets: a drawer movement, and a drawer count.
 *
 * BOTH POST TO ENDPOINTS THAT ALREADY EXIST.
 *
 *   Cash in / out / safe drop / petty withdrawal → POST v1/shifts/{id}/drawer
 *   Count and close                              → POST v1/shifts/{id}/close
 *
 * Nothing is faked and nothing is approved here. The server decides: it refuses
 * a drawer event without a reason, it refuses a close whose drawer does not
 * balance unless a reason is given, and it refuses that close outright unless
 * the person holds shift.approve_variance. Every one of those answers is shown
 * as it arrives rather than being pre-empted by the form — the UI's job is to
 * stop the obviously-invalid submission, not to guess the server's ruling.
 *
 * DOUBLE SUBMISSION IS THE FAILURE MODE THAT COSTS MONEY. Submit is disabled
 * for the whole round trip, because two identical cash-out events are two real
 * withdrawals in the ledger.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { api } from '../../services/api'
import { moneyExact } from '../format'
import type { ControlsBoard } from '../types'

export type CashActionKind = 'reconcile' | 'cash_in' | 'cash_out' | 'safe_drop' | 'petty_withdrawal'

type Shift = ControlsBoard['shifts'][number]

const MOVEMENT_COPY: Record<Exclude<CashActionKind, 'reconcile'>, { title: string; blurb: string; verb: string }> = {
  cash_in: {
    title: 'Cash in',
    blurb: 'Money added to the drawer — a float top-up, or change brought from the safe.',
    verb: 'Record cash in',
  },
  cash_out: {
    title: 'Cash withdrawal',
    blurb: 'Money taken out of the drawer and not spent — a bank run, or cash moved to another till.',
    verb: 'Record withdrawal',
  },
  safe_drop: {
    title: 'Cash deposit',
    blurb: 'Money dropped into the safe so the drawer is not holding more than it should.',
    verb: 'Record deposit',
  },
  petty_withdrawal: {
    title: 'Petty expense',
    blurb: 'Money spent out of the drawer — cleaning supplies, a delivery charge, staff tea.',
    verb: 'Record expense',
  },
}

// ---------------------------------------------------------------------------
// The sheet shell
// ---------------------------------------------------------------------------

function Sheet({
  variant,
  title,
  blurb,
  onClose,
  footer,
  children,
}: {
  variant: 'drawer' | 'modal'
  title: string
  blurb?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)

    // Focus the first control rather than the panel, so the sheet is usable
    // from the keyboard the moment it opens.
    const first = panel.current?.querySelector<HTMLElement>('select, input, textarea, button')
    first?.focus()

    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <button type="button" className="cc-scrim" aria-label="Close" onClick={onClose} />
      <div
        ref={panel}
        className={`cc-sheet cc-sheet--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="cc-sheet__header">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {blurb && <p>{blurb}</p>}
          </div>
          <button type="button" className="cc-icon-button" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="cc-sheet__body">{children}</div>
        {footer && <div className="cc-sheet__footer">{footer}</div>}
      </div>
    </>
  )
}

function NoShift({ onClose, canOpenTill }: { onClose: () => void; canOpenTill: boolean }) {
  return (
    <>
      <p className="cc-hint">
        A drawer action has to belong to an open shift. There is no open shift in the outlet and counter currently
        selected.
      </p>
      {canOpenTill && (
        <p style={{ marginTop: 12 }}>
          <Link className="pos-button pos-button--primary pos-button--small" to="/" onClick={onClose}>
            Open a till
          </Link>
        </p>
      )}
    </>
  )
}

function ShiftPicker({
  shifts,
  value,
  onChange,
}: {
  shifts: Shift[]
  value: number | null
  onChange: (id: number) => void
}) {
  if (shifts.length <= 1) {
    const only = shifts[0]

    return (
      <div className="cc-total">
        <span>
          {only?.terminal_name ?? only?.terminal_code ?? `Shift #${only?.session_id}`}
          {only?.location_name ? ` · ${only.location_name}` : ''}
        </span>
        <strong>{moneyExact(only?.expected_cash ?? 0)}</strong>
      </div>
    )
  }

  return (
    <label>
      <span>Shift</span>
      <select value={value ?? ''} onChange={(event) => onChange(Number(event.target.value))}>
        {shifts.map((shift) => (
          <option key={shift.session_id} value={shift.session_id}>
            {shift.terminal_name ?? shift.terminal_code ?? `Shift #${shift.session_id}`} — expected{' '}
            {moneyExact(shift.expected_cash)}
          </option>
        ))}
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const DENOMINATIONS = [500, 200, 100, 50, 20, 10] as const

export function CashActionSheet({
  kind,
  shifts,
  defaultSessionId,
  canOpenTill,
  onClose,
  onDone,
}: {
  kind: CashActionKind
  /** Shifts a movement or a close can legally be recorded against. */
  shifts: Shift[]
  defaultSessionId: number | null
  canOpenTill: boolean
  onClose: () => void
  onDone: (message: string) => void
}) {
  const eligible = useMemo(
    () => (kind === 'reconcile' ? shifts.filter((shift) => shift.status !== 'CLOSED') : shifts.filter((shift) => shift.status === 'OPEN')),
    [shifts, kind],
  )

  const [sessionId, setSessionId] = useState<number | null>(
    eligible.some((shift) => shift.session_id === defaultSessionId) ? defaultSessionId : (eligible[0]?.session_id ?? null),
  )
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [otherCash, setOtherCash] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shift = eligible.find((row) => row.session_id === sessionId) ?? null

  const countedTotal = useMemo(() => {
    const notesTotal = DENOMINATIONS.reduce((sum, face) => sum + face * (Number.parseInt(notes[face] ?? '', 10) || 0), 0)
    const other = Number.parseFloat(otherCash)

    return notesTotal + (Number.isFinite(other) ? other : 0)
  }, [notes, otherCash])

  const expected = shift?.expected_cash ?? 0
  const variance = Math.round((countedTotal - expected) * 100) / 100
  const outOfBalance = Math.abs(variance) > 0.005

  const parsedAmount = Number.parseFloat(amount)
  const movementValid = Number.isFinite(parsedAmount) && parsedAmount > 0 && reason.trim() !== ''
  const reconcileValid = countedTotal >= 0 && (!outOfBalance || reason.trim() !== '')

  async function submit() {
    if (!shift || busy) return
    setBusy(true)
    setError(null)

    try {
      if (kind === 'reconcile') {
        await api.post(`v1/shifts/${shift.session_id}/close`, {
          counted_cash: countedTotal,
          variance_reason: reason.trim() === '' ? undefined : reason.trim(),
        })
        onDone(
          outOfBalance
            ? `Shift closed. The drawer was ${moneyExact(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'} and the reason is on the record.`
            : 'Shift closed. The drawer balanced.',
        )
      } else {
        await api.post(`v1/shifts/${shift.session_id}/drawer`, {
          event_kind: kind,
          amount: parsedAmount,
          reason: reason.trim(),
        })
        onDone(`${MOVEMENT_COPY[kind].title} recorded: ${moneyExact(parsedAmount)}.`)
      }
      onClose()
    } catch (caught) {
      // The server's message is the useful one — it names the open cart, the
      // missing permission or the reason it wants.
      setError(caught instanceof Error ? caught.message : 'That could not be recorded. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (kind === 'reconcile') {
    return (
      <Sheet
        variant="drawer"
        title="Reconcile cash"
        blurb="Count the drawer, then close the shift on what you counted."
        onClose={onClose}
        footer={
          eligible.length > 0 ? (
            <>
              <button type="button" className="pos-button pos-button--secondary pos-button--small" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="pos-button pos-button--primary pos-button--small"
                onClick={() => void submit()}
                disabled={busy || !reconcileValid || shift === null}
              >
                {busy ? 'Closing…' : 'Close the shift'}
              </button>
            </>
          ) : undefined
        }
      >
        {eligible.length === 0 ? (
          <NoShift onClose={onClose} canOpenTill={canOpenTill} />
        ) : (
          <div className="cc-form">
            <ShiftPicker shifts={eligible} value={sessionId} onChange={setSessionId} />

            <div className="cc-total">
              <span>Expected in the drawer</span>
              <strong>{moneyExact(expected)}</strong>
            </div>

            <div>
              <span style={{ display: 'block', marginBottom: 7, color: '#475569', fontSize: 11.5, fontWeight: 700 }}>
                Count what is there
              </span>
              <div className="cc-denoms">
                {DENOMINATIONS.map((face) => {
                  const pieces = Number.parseInt(notes[face] ?? '', 10) || 0

                  return (
                    <div className="cc-denom" key={face}>
                      <span className="cc-denom__face">₹{face}</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={notes[face] ?? ''}
                        placeholder="0"
                        aria-label={`Number of ${face} rupee notes`}
                        onChange={(event) => setNotes((current) => ({ ...current, [face]: event.target.value }))}
                      />
                      <span className="cc-denom__line">{moneyExact(face * pieces)}</span>
                    </div>
                  )
                })}

                <div className="cc-denom">
                  <span className="cc-denom__face">Coins</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={otherCash}
                    placeholder="0.00"
                    aria-label="Coins and anything else, as a total"
                    onChange={(event) => setOtherCash(event.target.value)}
                  />
                  <span className="cc-denom__line">{moneyExact(Number.parseFloat(otherCash) || 0)}</span>
                </div>
              </div>
            </div>

            <div className="cc-total cc-total--emphasis">
              <span>Counted</span>
              <strong>{moneyExact(countedTotal)}</strong>
            </div>

            <div className="cc-total">
              <span>Difference</span>
              <strong className={!outOfBalance ? 'cc-amount-level' : variance < 0 ? 'cc-amount-short' : 'cc-amount-over'}>
                {moneyExact(variance)} {!outOfBalance ? '· balances' : variance < 0 ? '· short' : '· over'}
              </strong>
            </div>

            <label>
              <span>{outOfBalance ? 'What happened? (required)' : 'Note (optional)'}</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={outOfBalance ? 'Say what accounts for the difference' : 'Anything worth recording'}
              />
              <p className="cc-hint">
                A drawer that does not balance cannot be closed without a reason, and closing it needs the
                shift.approve_variance permission. The server decides both.
              </p>
            </label>

            {error && <p className="cc-error">{error}</p>}
          </div>
        )}
      </Sheet>
    )
  }

  const copy = MOVEMENT_COPY[kind]

  return (
    <Sheet
      variant="modal"
      title={copy.title}
      blurb={copy.blurb}
      onClose={onClose}
      footer={
        eligible.length > 0 ? (
          <>
            <button type="button" className="pos-button pos-button--secondary pos-button--small" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="pos-button pos-button--primary pos-button--small"
              onClick={() => void submit()}
              disabled={busy || !movementValid || shift === null}
            >
              {busy ? 'Recording…' : copy.verb}
            </button>
          </>
        ) : undefined
      }
    >
      {eligible.length === 0 ? (
        <NoShift onClose={onClose} canOpenTill={canOpenTill} />
      ) : (
        <div className="cc-form">
          <ShiftPicker shifts={eligible} value={sessionId} onChange={setSessionId} />

          <label>
            <span>Amount</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={amount}
              placeholder="0.00"
              onChange={(event) => setAmount(event.target.value)}
            />
            {amount !== '' && !(Number.isFinite(parsedAmount) && parsedAmount > 0) && (
              <p className="cc-error">Enter an amount greater than zero.</p>
            )}
          </label>

          <label>
            <span>Reason (required)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why the money moved"
            />
            <p className="cc-hint">
              Recorded against you, this till and this shift, and kept on the audit trail. The server refuses a drawer
              event without one.
            </p>
          </label>

          {shift && (
            <div className="cc-total">
              <span>Expected after this</span>
              <strong>
                {moneyExact(
                  shift.expected_cash + (kind === 'cash_in' ? 1 : -1) * (Number.isFinite(parsedAmount) ? parsedAmount : 0),
                )}
              </strong>
            </div>
          )}

          {error && <p className="cc-error">{error}</p>}
        </div>
      )}
    </Sheet>
  )
}
