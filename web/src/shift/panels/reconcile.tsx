/**
 * Reconciling a shift, in three deliberate steps.
 *
 * PRESSING THE BUTTON DOES NOT CLOSE THE TILL. Closing a drawer is the one
 * irreversible thing on this screen — the shift cannot be reopened and the
 * variance is signed for by whoever confirmed it — so the button opens this,
 * and this asks three questions in order: what should be in the drawer, what is
 * actually in it, and what to do about the difference.
 *
 * THE COUNT IS ENTERED AS NOTES AND COINS, not as a total someone worked out on
 * a calculator. The sheet is the evidence a disputed drawer is argued from, and
 * the total is derived from it rather than typed beside it.
 *
 * IT CANNOT BE SUBMITTED TWICE. The button disables while the request is in
 * flight, and a shift that is already closed is refused by the server rather
 * than closed again — so a double click, a slow network and an impatient second
 * press all end in the same place.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { Note, Overlay } from './states'
import { reconcileShift } from '../api'
import { moneyExact, safeNumber } from '../format'
import type { DenominationEntry, ShiftCash, ShiftDetail, ShiftReportPolicy } from '../types'

type Step = 'review' | 'count' | 'confirm'

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'review', label: '1. Review expected' },
  { id: 'count', label: '2. Count the drawer' },
  { id: 'confirm', label: '3. Confirm and sign' },
]

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={tone ? `shift-cash__figure ${tone}` : 'shift-cash__figure'}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  )
}

export function ReconcileShiftDialog({
  shift,
  cash,
  policy,
  onClose,
  onDone,
}: {
  shift: ShiftDetail
  cash: ShiftCash
  policy: ShiftReportPolicy
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [step, setStep] = useState<Step>('review')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sheet = useMemo<DenominationEntry[]>(
    () =>
      policy.denominations.map((denomination) => ({
        denomination,
        quantity: Math.max(0, Math.trunc(Number(quantities[String(denomination)] ?? '') || 0)),
      })),
    [policy.denominations, quantities],
  )

  const counted = useMemo(
    () => Math.round(sheet.reduce((sum, row) => sum + row.denomination * row.quantity, 0) * 100) / 100,
    [sheet],
  )

  const variance = Math.round((counted - safeNumber(cash.expected)) * 100) / 100
  const outOfTolerance = Math.abs(variance) > policy.variance_tolerance + 0.0001
  const balances = Math.abs(variance) < 0.005
  const anyCounted = sheet.some((row) => row.quantity > 0)

  // A variance always needs saying why, and one outside the tolerance needs
  // somebody who may sign for it. Both are enforced by the server; saying so
  // here means nobody counts a drawer twice to find that out.
  const needsReason = !balances && policy.requires_reason_on_variance
  const blockedByPermission = outOfTolerance && !policy.can_approve_variance
  const canSubmit =
    !submitting && anyCounted && (!needsReason || reason.trim().length > 0) && !blockedByPermission

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)

    try {
      await reconcileShift(shift.session_id, {
        countedCash: counted,
        denominations: sheet,
        varianceReason: balances ? undefined : reason,
      })
      onDone(
        balances
          ? 'Shift reconciled. The drawer balanced.'
          : `Shift reconciled with a ${moneyExact(Math.abs(variance))} ${variance < 0 ? 'shortage' : 'overage'}, signed for.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The shift could not be reconciled.')
      setSubmitting(false)
    }
  }

  return (
    <Overlay
      variant="dialog"
      labelledBy="reconcile-dialog"
      title="Reconcile shift"
      description={`${shift.terminal.code} • ${shift.terminal.name} · ${shift.cashier.label}`}
      onClose={submitting ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="shift-button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>

          <span style={{ display: 'flex', gap: 8 }}>
            {step !== 'review' && (
              <button
                type="button"
                className="shift-button"
                onClick={() => setStep(step === 'confirm' ? 'count' : 'review')}
                disabled={submitting}
              >
                Back
              </button>
            )}

            {step === 'confirm' ? (
              <button type="button" className="shift-button shift-button--primary" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Loader2 size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
                {submitting ? 'Reconciling…' : 'Reconcile shift'}
              </button>
            ) : (
              <button
                type="button"
                className="shift-button shift-button--primary"
                onClick={() => setStep(step === 'review' ? 'count' : 'confirm')}
                disabled={step === 'count' && !anyCounted}
              >
                Continue
              </button>
            )}
          </span>
        </>
      }
    >
      <ol className="shift-steps" aria-label="Reconciliation steps">
        {STEPS.map((item, index) => {
          const done = STEPS.findIndex((s) => s.id === step) > index

          return (
            <li
              key={item.id}
              className={done ? 'shift-steps__item shift-steps__item--done' : 'shift-steps__item'}
              aria-current={item.id === step ? 'step' : undefined}
            >
              {done && <CheckCircle2 size={12} aria-hidden />}
              {item.label}
            </li>
          )
        })}
      </ol>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <Note tone="danger" title="That did not go through.">
            {error}
          </Note>
        </div>
      )}

      {step === 'review' && (
        <>
          <div className="shift-review">
            <Figure label="Opening float" value={moneyExact(cash.opening)} />
            <Figure label="Cash taken on sales" value={moneyExact(cash.cash_sales)} />
            <Figure label="Paid in" value={moneyExact(cash.cash_in)} />
            <Figure label="Refunds, payouts and drops" value={moneyExact(-(cash.cash_refunds + cash.cash_payouts + cash.cash_drops))} />
            <Figure label="Expected in the drawer" value={moneyExact(cash.expected)} />
          </div>

          <Note tone="info" title="How that figure is worked out">
            {cash.formula}. {cash.note}
          </Note>

          {Math.abs(cash.expected - cash.running_expected) > 0.01 && (
            <div style={{ marginTop: 12 }}>
              <Note tone="warning" title="The till and the events disagree">
                The till has been running a total of {moneyExact(cash.running_expected)} while the drawer events add up to{' '}
                {moneyExact(cash.expected)}. Count the drawer and record what is in it — the difference is worth raising.
              </Note>
            </div>
          )}
        </>
      )}

      {step === 'count' && (
        <>
          <p className="shift-card__note" style={{ margin: '0 0 12px' }}>
            Count the drawer and enter how many of each. The total is added up from what you type, so there is nothing
            to work out on a calculator.
          </p>

          <div className="shift-count">
            {policy.denominations.map((denomination) => {
              const key = String(denomination)
              const quantity = Math.max(0, Math.trunc(Number(quantities[key] ?? '') || 0))

              return (
                <label className="shift-count__row" key={key}>
                  <span>
                    <span className="shift-count__face">₹{denomination}</span>
                    <span className="shift-count__amount">{quantity > 0 ? moneyExact(denomination * quantity) : '—'}</span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={quantities[key] ?? ''}
                    placeholder="0"
                    aria-label={`How many ${denomination} rupee notes or coins`}
                    onChange={(event) => setQuantities((current) => ({ ...current, [key]: event.target.value }))}
                  />
                </label>
              )
            })}
          </div>

          <div className="shift-review" style={{ marginTop: 14, marginBottom: 0 }}>
            <Figure label="Counted" value={moneyExact(counted)} />
            <Figure label="Expected" value={moneyExact(cash.expected)} />
            <Figure
              label="Variance"
              value={moneyExact(variance)}
              tone={
                balances
                  ? 'shift-cash__figure--good'
                  : outOfTolerance
                    ? 'shift-cash__figure--danger'
                    : 'shift-cash__figure--warn'
              }
            />
          </div>
        </>
      )}

      {step === 'confirm' && (
        <>
          <div className="shift-review">
            <Figure label="Counted" value={moneyExact(counted)} />
            <Figure label="Expected" value={moneyExact(cash.expected)} />
            <Figure
              label="Variance"
              value={moneyExact(variance)}
              tone={
                balances
                  ? 'shift-cash__figure--good'
                  : outOfTolerance
                    ? 'shift-cash__figure--danger'
                    : 'shift-cash__figure--warn'
              }
            />
          </div>

          {balances ? (
            <Note tone="success" title="The drawer balances">
              Counting {moneyExact(counted)} against an expected {moneyExact(cash.expected)}. Confirming closes this shift.
            </Note>
          ) : (
            <Note tone={outOfTolerance ? 'danger' : 'warning'} title={`The drawer is ${variance < 0 ? 'short' : 'over'} by ${moneyExact(Math.abs(variance))}`}>
              {outOfTolerance
                ? `That is beyond the ${moneyExact(policy.variance_tolerance)} this shop allows, so it is signed for by whoever confirms it.`
                : `That is inside the ${moneyExact(policy.variance_tolerance)} this shop allows, and it is still recorded.`}
            </Note>
          )}

          {needsReason && (
            <label className="shift-field" style={{ marginTop: 14 }}>
              <span>What happened? (required)</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Short-changed a customer at 3pm and could not recover it."
                required
              />
            </label>
          )}

          {blockedByPermission && (
            <div style={{ marginTop: 14 }}>
              <Note tone="danger" title="A manager has to approve this close">
                <AlertTriangle size={13} aria-hidden style={{ verticalAlign: '-2px', marginRight: 4 }} />
                This drawer is out by more than the shop allows, and signing for that needs the
                shift.approve_variance permission. Ask a manager to confirm it at this till.
              </Note>
            </div>
          )}

          <p className="shift-card__note">
            Confirming closes the shift and records the count, the variance and your name against it. A closed shift
            cannot be reopened, and pressing this twice cannot close it twice.
          </p>
        </>
      )}
    </Overlay>
  )
}
