/**
 * Customers & Growth panels that are still their own shape.
 *
 * The board's headline panels — the coverage note, the new-against-returning
 * chart, the segment breakdown and the suggestions list — now live under
 * dashboards/customers/ as components of the revamped screen. What stayed here
 * is what that revamp did not restate: visit recency, basket combinations, and
 * the panel that says plainly which things POS has no answer for.
 *
 * The caveat is on the panels, not buried in a footnote: most counter sales are
 * anonymous, and every figure here counts only the bills a cashier attached a
 * customer to. A repeat rate over 4% of bills and a repeat rate over 90% of
 * bills are different facts, and the screen keeps saying which one it is.
 */

import { BarChart } from '../charts'
import { count, percent } from '../format'
import { Panel, Unavailable } from '../shell'
import type { CustomersBoard } from '../types'

export function VisitRecency({ board }: { board: CustomersBoard }) {
  return (
    <Panel title="When customers last came in" description={board.recency.basis}>
      <BarChart
        points={board.recency.points.map((point) => ({ label: point.label, value: point.customers }))}
        valueLabel="Customers"
        format={(v) => count(Math.round(v))}
        caption="Identified customers by how long since their last visit"
      />
    </Panel>
  )
}

export function Combinations({ board }: { board: CustomersBoard }) {
  return (
    <Panel
      title="Bought together"
      description={`Across ${count(board.combinations.baskets)} bills with at least one item.`}
    >
      {board.combinations.pairs.length === 0 ? (
        <Unavailable muted title="No pair appeared twice">
          There is not enough here to call anything a combination. Nothing is being inferred from a single basket.
        </Unavailable>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th scope="col">Pair</th>
                <th scope="col" className="is-number">Bills with both</th>
                <th scope="col" className="is-number">Of all bills</th>
              </tr>
            </thead>
            <tbody>
              {board.combinations.pairs.map((pair) => (
                <tr key={`${pair.left_item}-${pair.right_item}`}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {pair.left_name} + {pair.right_name}
                  </th>
                  <td className="is-number">{count(pair.together)}</td>
                  <td className="is-number">{percent(pair.share_pc, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="pos-note">{board.combinations.basis}</p>
    </Panel>
  )
}

/**
 * Loyalty and offers.
 *
 * Both are honestly absent. The panel says there is no loyalty scheme rather
 * than showing a zero balance, because a zero reads as "nobody has any points"
 * — a completely different and much worse claim.
 */
export function LoyaltyAndOffers({ board }: { board: CustomersBoard }) {
  return (
    <Panel title="Loyalty and offers" description="What POS can and cannot tell you here.">
      <div className="pos-stack">
        <Unavailable title="There is no loyalty scheme in POS">
          {board.loyalty.note}
          <br />
          <span className="pos-muted">{board.loyalty.contract_gap}</span>
        </Unavailable>

        <Unavailable title="Offer performance cannot be measured">{board.offers.note}</Unavailable>
      </div>
    </Panel>
  )
}
