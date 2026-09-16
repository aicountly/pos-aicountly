/**
 * The Customers & Growth panels.
 *
 * The caveat is on the panels, not buried in a footnote: most counter sales are
 * anonymous, and every figure here counts only the bills a cashier attached a
 * customer to. A repeat rate over 4% of bills and a repeat rate over 90% of
 * bills are different facts, and the screen keeps saying which one it is.
 */

import { BarChart, ShareBars, TrendChart } from '../charts'
import { count, money, percent } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { CustomersBoard } from '../types'

export function CoverageNote({ board }: { board: CustomersBoard }) {
  if (board.coverage.bills === 0) return null

  return (
    <Unavailable muted title="What these figures count">
      {count(board.coverage.identified_bills)} of {count(board.coverage.bills)} bills in this period had a customer on
      them ({percent(board.coverage.identified_pc, 0)}). The other {count(board.coverage.anonymous_bills)} were
      anonymous counter sales and are excluded from everything below.
    </Unavailable>
  )
}

export function NewVsReturning({ board }: { board: CustomersBoard }) {
  const points = board.trend.points.map((point) => ({
    label: point.bucket.length === 10 ? point.bucket.slice(5) : point.bucket,
    value: point.returning_bills,
    comparison: point.new_bills,
  }))

  return (
    <Panel
      title="Returning customers"
      description="Bills from someone who had bought here before, against bills from someone new."
    >
      {points.length === 0 ? (
        <Unavailable muted title="No identified bills in this period">
          Attach a customer at the till and this fills in.
        </Unavailable>
      ) : (
        <TrendChart
          points={points}
          valueLabel="Returning"
          comparisonLabel="New to this POS"
          format={(v) => count(Math.round(v))}
          caption={`Identified bills by new and returning, ${board.window.from} to ${board.window.to}`}
        />
      )}
      <p className="pos-note">
        “New” means their first bill on this POS fell in this period. They may have bought from another Aicountly
        product for years — POS cannot see that and does not claim to.
      </p>
    </Panel>
  )
}

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

export function Segments({ board }: { board: CustomersBoard }) {
  return (
    <Panel
      title="Segments"
      description={`${count(board.segments.total)} identified customers across this POS' whole history.`}
    >
      {board.segments.total === 0 ? (
        <Unavailable muted title="No identified customers yet">
          Segments appear once bills start carrying a customer.
        </Unavailable>
      ) : (
        <>
          <ShareBars
            rows={board.segments.segments.map((segment) => ({
              key: segment.key,
              label: segment.label,
              value: segment.customers,
              note: segment.definition,
              tone: segment.key === 'at_risk' ? 'warning' : segment.key === 'one_time' ? 'muted' : 'brand',
            }))}
            format={(v) => `${count(v)} customer${v === 1 ? '' : 's'}`}
          />
          <div className="pos-table-wrap" style={{ marginTop: 16 }}>
            <table className="pos-table">
              <caption>Each segment, with what it is counting</caption>
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col" className="is-number">Customers</th>
                  <th scope="col" className="is-number">Share</th>
                  <th scope="col" className="is-number">Spend on this POS</th>
                </tr>
              </thead>
              <tbody>
                {board.segments.segments.map((segment) => (
                  <tr key={segment.key}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      {segment.label}
                      <span className="pos-muted" style={{ display: 'block', fontWeight: 400 }}>
                        {segment.definition}
                      </span>
                    </th>
                    <td className="is-number">{count(segment.customers)}</td>
                    <td className="is-number">{percent(segment.share_pc, 0)}</td>
                    <td className="is-number">{money(segment.spend)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="pos-note">{board.segments.basis}</p>
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

export function GrowthSuggestions({ board }: { board: CustomersBoard }) {
  const { suggestions } = board

  return (
    <Panel
      title="Suggested follow-ups"
      description="Prepared for review. POS does not send anything."
      action={<StatusBadge tone="neutral">Rule-based</StatusBadge>}
    >
      {suggestions.items.length === 0 ? (
        <Unavailable muted title="Nothing to suggest">
          No segment is large enough, or moving enough, to be worth acting on in this period.
        </Unavailable>
      ) : (
        suggestions.items.map((item) => (
          <article key={item.id} className="pos-insight">
            <div className="pos-inline">
              <StatusBadge tone="neutral">Rule-based alert</StatusBadge>
              <span className="pos-muted">{item.period_label}</span>
            </div>
            <h3>{item.title}</h3>
            <p>{item.explanation}</p>
            <dl style={{ margin: 0, fontSize: 12.5 }}>
              <div className="pos-split">
                <dt className="pos-muted">Definition</dt>
                <dd style={{ margin: 0, textAlign: 'right', maxWidth: '60%' }}>{item.definition}</dd>
              </div>
              <div className="pos-split">
                <dt className="pos-muted">Supporting customers</dt>
                <dd style={{ margin: 0 }}>
                  <strong>{count(item.supporting_customers)}</strong>
                </dd>
              </div>
            </dl>
          </article>
        ))
      )}

      <p className="pos-note">
        <strong>{suggestions.sending.note}</strong>
      </p>
      <p className="pos-note">{suggestions.contact_details.note}</p>
      <p className="pos-note">
        <StatusBadge tone="neutral">No AI configured</StatusBadge> {suggestions.ai.note}
      </p>
    </Panel>
  )
}
