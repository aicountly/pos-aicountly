/**
 * Cash Reconciliation — expected against counted, and the gap between them.
 *
 * NULL IS A STATE, NOT A ZERO. While any drawer in the period is uncounted the
 * counted figure and the variance are null and are rendered as "not counted
 * yet". A dash there is the honest answer; a ₹0 difference on a drawer nobody
 * has opened is a lie that reads as reassurance.
 */

import { useState } from 'react'
import { MoreHorizontal, ScaleIcon } from 'lucide-react'
import { actor, count, dateTime, moneyExact } from '../format'
import { ControlCard, Pill } from './primitives'
import type { ReconciliationView } from './derive'

export function CashReconciliationCard({
  view,
  canReconcile,
  onReconcile,
}: {
  view: ReconciliationView
  canReconcile: boolean
  onReconcile: () => void
}) {
  const [showFormula, setShowFormula] = useState(false)

  const balanced = view.variance !== null && Math.abs(view.variance) < 0.005
  const differenceClass =
    view.variance === null ? 'cc-muted' : balanced ? 'cc-amount-level' : view.variance < 0 ? 'cc-amount-short' : 'cc-amount-over'

  return (
    <ControlCard
      id="cc-reconciliation"
      title="Cash reconciliation"
      icon={<ScaleIcon size={15} />}
      flush
      tools={
        <button
          type="button"
          className="cc-icon-button"
          aria-expanded={showFormula}
          aria-label={showFormula ? 'Hide how expected cash is worked out' : 'Show how expected cash is worked out'}
          onClick={() => setShowFormula((open) => !open)}
        >
          <MoreHorizontal size={16} aria-hidden />
        </button>
      }
    >
      <dl className="cc-recon">
        {showFormula &&
          view.breakdown.map((line) => (
            <div key={line.label} className="cc-recon__line">
              <dt>{line.label}</dt>
              <dd className="cc-muted">
                {line.sign && `${line.sign} `}
                {moneyExact(line.amount)}
              </dd>
            </div>
          ))}

        <div>
          <dt>Expected cash</dt>
          <dd>{moneyExact(view.expected)}</dd>
        </div>

        <div>
          <dt>Actual cash (counted)</dt>
          <dd>{view.counted === null ? <span className="cc-muted">Not counted yet</span> : moneyExact(view.counted)}</dd>
        </div>

        <div>
          <dt>Difference</dt>
          <dd>
            {view.variance === null ? (
              <span className="cc-muted">—</span>
            ) : (
              <span className={differenceClass}>
                {moneyExact(view.variance)}
                <span className="pos-visually-hidden">
                  {balanced ? ', the drawer balances' : view.variance < 0 ? ', the drawer is short' : ', the drawer is over'}
                </span>
              </span>
            )}
          </dd>
        </div>
      </dl>

      <div style={{ padding: '11px 15px 0' }}>
        {view.variance !== null && (
          <Pill tone={balanced ? 'success' : view.variance < 0 ? 'danger' : 'warning'} dot>
            {balanced ? 'Drawer balances' : view.variance < 0 ? 'Drawer is short' : 'Drawer is over'}
          </Pill>
        )}{' '}
        {view.openShifts > 0 && (
          <Pill tone="info" dot>
            {count(view.openShifts)} still open
          </Pill>
        )}
      </div>

      <p className="cc-recon-meta">
        {view.lastAt ? (
          <>
            Last reconciled
            <br />
            {dateTime(view.lastAt)}
            <br />
            {view.lastBy ? `by ${actor(view.lastBy)}` : 'by an unrecorded user'}
          </>
        ) : (
          <>
            No reconciliation record
            <br />
            for this period yet
          </>
        )}
      </p>

      {!view.reconciles && (
        <div className="cc-callout">
          <strong>The two expected figures disagree.</strong> Recomputed from drawer events:{' '}
          {moneyExact(view.expected)}. The tills&rsquo; own running total: {moneyExact(view.runningExpected)}. They
          should be identical — worth investigating rather than picking one.
        </div>
      )}

      <div className="cc-card__footer">
        <button
          type="button"
          className="pos-button pos-button--small cc-btn-soft"
          onClick={onReconcile}
          disabled={!canReconcile}
          title={canReconcile ? undefined : 'Closing and counting a drawer needs the shift.close permission.'}
        >
          Reconcile cash
        </button>
      </div>
    </ControlCard>
  )
}
