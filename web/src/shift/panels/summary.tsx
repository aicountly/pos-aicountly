/**
 * The shift in one card: who worked it, on what, and whether the drawer agrees.
 *
 * THE VARIANCE IS THE POINT OF THIS CARD, and it is coloured by the shop's own
 * tolerance rather than by a threshold in a stylesheet. Exactly zero balances
 * and reads green; inside the tolerance the shop has already said it can live
 * with it, so it is amber and still shown rather than hidden; outside it,
 * somebody has to do something and it is red. A drawer nobody has counted has
 * no variance at all — not a zero.
 */

import {
  Banknote,
  Calculator,
  CheckCircle2,
  Clock3,
  Layers,
  Monitor,
  TrendingDown,
  TrendingUp,
  UserRound,
} from 'lucide-react'
import { StatusBadge, type BadgeTone } from '../../dashboards/shell'
import { clockLabel, durationLabel, moneyExact } from '../format'
import type { ShiftCash, ShiftDetail, ShiftState, VarianceState } from '../types'

const STATE_TONE: Record<ShiftState, BadgeTone> = {
  open: 'info',
  closing: 'warning',
  closed: 'warning',
  reconciled: 'success',
  variance: 'danger',
}

export function ShiftStatusBadge({ shift }: { shift: ShiftDetail }) {
  return <StatusBadge tone={STATE_TONE[shift.state] ?? 'neutral'} dot>{shift.state_label}</StatusBadge>
}

/** What the variance means, in the one word the card colours itself by. */
function varianceClass(state: VarianceState): string {
  switch (state) {
    case 'balanced':
      return 'is-good'
    case 'within_tolerance':
      return 'is-warning'
    case 'out_of_tolerance':
      return 'is-danger'
    default:
      return ''
  }
}

function varianceWords(cash: ShiftCash): string {
  if (cash.variance === null) return 'Not counted yet'
  if (cash.variance_state === 'balanced') return 'The drawer balances'
  const direction = cash.variance < 0 ? 'short' : 'over'

  return cash.variance_state === 'within_tolerance'
    ? `${moneyExact(Math.abs(cash.variance))} ${direction}, inside the tolerance`
    : `${moneyExact(Math.abs(cash.variance))} ${direction}, outside the tolerance`
}

function Fact({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: typeof UserRound
  label: string
  value: string
  tone?: string
  hint?: string
}) {
  return (
    <div className="shift-fact">
      <span className="shift-fact__icon" aria-hidden>
        <Icon size={15} />
      </span>
      <div className="shift-fact__body">
        <small>{label}</small>
        <strong className={tone}>{value}</strong>
        {hint && <span className="pos-visually-hidden">{hint}</span>}
      </div>
    </div>
  )
}

export function ShiftSummaryCard({
  shift,
  cash,
  timezone,
}: {
  shift: ShiftDetail
  cash: ShiftCash
  timezone: string
}) {
  const reconciled = shift.reconciled
  const outOfTolerance = cash.variance_state === 'out_of_tolerance'

  const badgeModifier = reconciled
    ? outOfTolerance
      ? 'shift-summary__badge shift-summary__badge--danger'
      : 'shift-summary__badge shift-summary__badge--ok'
    : 'shift-summary__badge'

  const markModifier = reconciled
    ? outOfTolerance
      ? 'shift-summary__mark shift-summary__mark--danger'
      : 'shift-summary__mark'
    : 'shift-summary__mark shift-summary__mark--warn'

  const Variance = (cash.variance ?? 0) < 0 ? TrendingDown : TrendingUp

  return (
    <section className="shift-card" aria-label="Shift summary">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <Banknote size={14} />
            </span>
            Shift Summary
            <ShiftStatusBadge shift={shift} />
          </h2>
          <p>Key details and reconciliation status for this shift.</p>
        </div>

        <div className="shift-summary__state">
          <div className={badgeModifier}>
            <span className={markModifier} aria-hidden>
              {reconciled ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}
            </span>
            <div style={{ minWidth: 0 }}>
              <strong>{reconciled ? (outOfTolerance ? 'Reconciled with a variance' : 'Reconciled') : 'Not reconciled'}</strong>
              <small>
                {reconciled
                  ? outOfTolerance
                    ? `Closed and signed for. ${varianceWords(cash)}.`
                    : 'Shift closed and reconciled successfully'
                  : shift.status === 'CLOSED'
                    ? 'Closed, but the drawer has not been counted'
                    : 'The till is still open — figures are still moving'}
              </small>
            </div>
          </div>

          <div className="shift-summary__duration">
            <small>Duration</small>
            <strong>{durationLabel(shift.duration_minutes)}</strong>
            <span>
              {clockLabel(shift.started_at, timezone)} – {shift.ended_at ? clockLabel(shift.ended_at, timezone) : 'now'}
            </span>
          </div>
        </div>
      </div>

      <div className="shift-facts">
        <Fact
          icon={UserRound}
          label="Cashier"
          value={shift.cashier.label}
          hint={shift.cashier.resolved ? undefined : 'POS holds this person as a reference, not a name.'}
        />
        <Fact icon={Monitor} label="Terminal / Till" value={`${shift.terminal.code} • ${shift.terminal.name}`} />
        <Fact icon={Layers} label="Opening Cash" value={moneyExact(cash.opening)} />
        <Fact icon={Calculator} label="Expected Cash" value={moneyExact(cash.expected)} hint={cash.formula} />
        <Fact
          icon={Banknote}
          label="Actual Cash"
          value={cash.counted === null ? 'Not counted' : moneyExact(cash.counted)}
          tone={cash.counted === null ? 'is-warning' : undefined}
        />
        <Fact
          icon={Variance}
          label="Cash Variance"
          value={cash.variance === null ? '—' : moneyExact(cash.variance)}
          tone={varianceClass(cash.variance_state)}
          hint={varianceWords(cash)}
        />
      </div>

      {shift.variance_reason && (
        <p className="shift-card__note">
          <strong>Why:</strong> “{shift.variance_reason}”
          {shift.approved_by ? ` — signed by ${shift.approved_by.label}` : ''}
        </p>
      )}
    </section>
  )
}
