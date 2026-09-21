/**
 * The drawer, counted.
 *
 * The table is the SHEET — what notes and coins were actually in the drawer —
 * and the panel beside it is the COMPARISON, which is the authoritative one:
 * counted against expected, and the difference between them.
 *
 * WHAT IS DELIBERATELY NOT HERE: an expected quantity per denomination. POS
 * knows what the drawer should hold; it cannot know which notes it should hold
 * it in, because nobody records that a ₹500 sale was paid with two ₹200s and a
 * ₹100. Inventing that column would put a made-up figure on a cash record,
 * which is the one place in this product it must never appear. The comparison
 * that is real sits on the right, where the eye lands anyway.
 */

import { Banknote, Calculator, Layers, TrendingDown } from 'lucide-react'
import { moneyExact } from '../format'
import { clockLabel } from '../format'
import type { DenominationBlock, VarianceState } from '../types'

function figureModifier(state: VarianceState): string {
  switch (state) {
    case 'balanced':
      return 'shift-cash__figure shift-cash__figure--good'
    case 'within_tolerance':
      return 'shift-cash__figure shift-cash__figure--warn'
    case 'out_of_tolerance':
      return 'shift-cash__figure shift-cash__figure--danger'
    default:
      return 'shift-cash__figure'
  }
}

function varianceWords(block: DenominationBlock): string {
  if (block.variance === null) return 'Nothing counted yet'
  if (block.variance_state === 'balanced') return 'The drawer balances'

  return `${moneyExact(Math.abs(block.variance))} ${block.variance < 0 ? 'short' : 'over'}`
}

export function CashReconciliationCard({
  denominations,
  timezone,
}: {
  denominations: DenominationBlock
  timezone: string
}) {
  const counted = denominations.rows.filter((row) => row.quantity !== null && row.quantity > 0)
  const sheetTotal = denominations.counted_total

  return (
    <section className="shift-card" aria-label="Cash reconciliation">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <Banknote size={14} />
            </span>
            Cash Reconciliation
          </h2>
          <p>
            {denominations.has_sheet
              ? 'Counted cash against expected, through the denomination breakdown'
              : 'Counted cash against expected'}
          </p>
        </div>
      </div>

      <div className="shift-cash">
        <div style={{ minWidth: 0 }}>
          {denominations.has_sheet ? (
            <div className="shift-scroll">
              <table className="shift-table">
                <caption className="pos-visually-hidden">
                  The notes and coins this drawer was counted in, and what each came to.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Denomination</th>
                    <th scope="col" className="is-number">Counted</th>
                    <th scope="col" className="is-number">Amount</th>
                    <th scope="col" className="is-number">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {counted.map((row) => (
                    <tr key={row.denomination}>
                      <th scope="row">₹{row.label}</th>
                      <td className="is-number">{row.quantity}</td>
                      <td className="is-number">{moneyExact(row.amount ?? 0)}</td>
                      <td className="is-number is-muted">{row.share_pc === null ? '—' : `${row.share_pc}%`}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total counted</td>
                    <td className="is-number">{counted.reduce((sum, row) => sum + (row.quantity ?? 0), 0)}</td>
                    <td className="is-number">{moneyExact(sheetTotal ?? 0)}</td>
                    <td className="is-number">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="shift-card__note" style={{ marginTop: 0 }}>
              {denominations.counted === null
                ? 'This drawer has not been counted yet. Reconcile the shift to record the notes and coins in it.'
                : 'This drawer was closed with a total rather than a note-by-note count, so there is no sheet to show. '
                  + 'The comparison beside this is the one that matters.'}
            </p>
          )}

          <p className="shift-card__note">
            {denominations.note}
            {denominations.counted_at && denominations.counted_by
              ? ` Counted at ${clockLabel(denominations.counted_at, timezone)} by ${denominations.counted_by.label}.`
              : ''}
          </p>
        </div>

        <aside className="shift-cash__summary" aria-label="Drawer comparison">
          <div className="shift-cash__figure">
            <small>
              <Banknote size={11} aria-hidden style={{ verticalAlign: '-1px', marginRight: 4 }} />
              Total Counted
            </small>
            <strong>{denominations.counted === null ? 'Not counted' : moneyExact(denominations.counted)}</strong>
          </div>

          <div className="shift-cash__figure">
            <small>
              <Calculator size={11} aria-hidden style={{ verticalAlign: '-1px', marginRight: 4 }} />
              Expected Cash
            </small>
            <strong>{moneyExact(denominations.expected)}</strong>
          </div>

          <div className={figureModifier(denominations.variance_state)}>
            <small>
              <TrendingDown size={11} aria-hidden style={{ verticalAlign: '-1px', marginRight: 4 }} />
              Variance
            </small>
            <strong>{denominations.variance === null ? '—' : moneyExact(denominations.variance)}</strong>
            {/* Never colour alone: the words say which way and whether it matters. */}
            <small style={{ marginTop: 3 }}>{varianceWords(denominations)}</small>
          </div>

          {sheetTotal !== null && denominations.counted !== null && Math.abs(sheetTotal - denominations.counted) > 0.01 && (
            <div className="shift-cash__figure shift-cash__figure--warn">
              <small>
                <Layers size={11} aria-hidden style={{ verticalAlign: '-1px', marginRight: 4 }} />
                Sheet disagrees
              </small>
              <strong>{moneyExact(sheetTotal)}</strong>
              <small style={{ marginTop: 3 }}>The notes and coins do not add up to the figure the shift closed on.</small>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
