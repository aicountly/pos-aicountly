/**
 * The Business Overview panels.
 *
 * Every one of them drills somewhere: a manager who cannot get from a number to
 * the rows behind it stops believing the number.
 */

import { Link } from 'react-router-dom'
import { ProgressRing, ShareBars, TrendChart, type SeriesPoint } from '../charts'
import { count, decimal, money, percent } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { OverviewBoard } from '../types'
import type { DashboardFilters } from '../useDashboard'
import { withFilters } from '../registry'
import { AttentionRow } from './common'

export function SalesPerformance({
  board,
  filters,
}: {
  board: OverviewBoard
  filters: DashboardFilters
}) {
  const comparisonLabel = board.window.comparison?.label ?? null
  const points: SeriesPoint[] = board.series.points.map((point) => ({
    label: point.bucket.length === 10 ? point.bucket.slice(5) : point.bucket,
    value: point.net,
    comparison: board.series.comparison_by_bucket?.[point.bucket] ?? null,
  }))

  return (
    <Panel
      title="Sales performance"
      description={
        board.series.bucket === 'hour'
          ? `By hour, in the outlet's own timezone (${board.window.timezone}).`
          : 'By business day, in the outlet’s own timezone.'
      }
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/retail', filters)}>
          See the bills
        </Link>
      }
    >
      <TrendChart
        points={points}
        valueLabel="Net sales"
        comparisonLabel={comparisonLabel}
        format={(v) => money(v)}
        caption={`Net sales ${board.window.from} to ${board.window.to}`}
      />
      <p className="pos-note">{board.metric_basis.net_sales}</p>
    </Panel>
  )
}

export function OutletPerformance({
  board,
  filters,
  onOutlet,
}: {
  board: OverviewBoard
  filters: DashboardFilters
  onOutlet: (locationId: number) => void
}) {
  const withTargets = board.outlets.filter((outlet) => outlet.target !== null)
  const single = board.outlets.length === 1 ? board.outlets[0] : null

  return (
    <Panel
      title="Outlet performance"
      description={
        withTargets.length === 0
          ? 'No outlet has a daily target set, so no target column is shown.'
          : `${withTargets.length} of ${board.outlets.length} outlets have a target set.`
      }
    >
      {board.outlets.length === 0 ? (
        <Unavailable muted title="No outlets yet">
          Set an outlet up under Setup before this board has anything to compare.
        </Unavailable>
      ) : (
        <>
          {single && single.target !== null && (
            <div style={{ marginBottom: 18 }}>
              <ProgressRing
                achieved={single.net}
                target={single.target}
                format={(v) => money(v)}
                label={`${single.display_name} against target`}
              />
            </div>
          )}

          <div className="pos-table-wrap">
            <table className="pos-table">
              <thead>
                <tr>
                  <th scope="col">Outlet</th>
                  <th scope="col" className="is-number">Net sales</th>
                  <th scope="col" className="is-number">Bills</th>
                  <th scope="col" className="is-number">Average bill</th>
                  {withTargets.length > 0 && <th scope="col" className="is-number">Of target</th>}
                  <th scope="col">Exceptions</th>
                  <th scope="col"><span className="pos-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {board.outlets.map((outlet) => (
                  <tr key={outlet.location_id}>
                    <th scope="row" style={{ fontWeight: 600 }}>
                      {outlet.display_name}
                      <span className="pos-muted" style={{ display: 'block', fontWeight: 400 }}>
                        {outlet.pos_mode.replace(/_/g, ' ')}
                      </span>
                    </th>
                    <td className="is-number">{money(outlet.net)}</td>
                    <td className="is-number">{count(outlet.bills)}</td>
                    <td className="is-number">{money(outlet.average_bill)}</td>
                    {withTargets.length > 0 && (
                      <td className="is-number">
                        {outlet.target_pc === null ? (
                          <span className="pos-muted">No target</span>
                        ) : (
                          percent(outlet.target_pc, 0)
                        )}
                      </td>
                    )}
                    <td>
                      {outlet.exceptions === 0 ? (
                        <span className="pos-muted">None</span>
                      ) : (
                        <StatusBadge tone="warning">{count(outlet.exceptions)} stuck</StatusBadge>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="pos-button pos-button--quiet pos-button--small"
                        onClick={() => onOutlet(outlet.location_id)}
                      >
                        Focus
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="pos-note">
        <Link className="pos-link" to={withFilters('/controls', filters)}>
          Open cash and controls
        </Link>{' '}
        to see the shifts behind these figures.
      </p>
    </Panel>
  )
}

export function TopItems({ board, filters }: { board: OverviewBoard; filters: DashboardFilters }) {
  const anyReturns = board.top_items.some((item) => item.returned_qty > 0)

  return (
    <Panel
      title="What sold"
      description="By value, on this POS. Quantity is in the item's own selling unit."
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/customers', filters)}>
          What sells together
        </Link>
      }
    >
      {board.top_items.length === 0 ? (
        <Unavailable muted title="Nothing sold in this period">
          Choose another period, or open a till and take a sale.
        </Unavailable>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="is-number">Quantity</th>
                <th scope="col" className="is-number">Net sales</th>
                {anyReturns && <th scope="col" className="is-number">Came back</th>}
              </tr>
            </thead>
            <tbody>
              {board.top_items.map((item) => (
                <tr key={`${item.item_id ?? 'x'}-${item.display_name}`}>
                  <th scope="row" style={{ fontWeight: 500 }}>{item.display_name}</th>
                  <td className="is-number">{decimal(item.qty, 2)}</td>
                  <td className="is-number">{money(item.amount)}</td>
                  {anyReturns && (
                    <td className="is-number">
                      {item.returned_qty > 0 ? decimal(item.returned_qty, 2) : <span className="pos-muted">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {board.margin.available ? (
        <div className="pos-stack pos-stack--tight" style={{ marginTop: 18 }}>
          <div className="pos-split">
            <span>Sale value before tax</span>
            <strong>{money(board.margin.revenue)}</strong>
          </div>
          <div className="pos-split">
            <span>Inventory cost of what went out</span>
            <strong>{money(board.margin.cost)}</strong>
          </div>
          <div className="pos-split pos-split--total">
            <span>Gross margin</span>
            <strong>
              {money(board.margin.gross_margin)}
              {board.margin.margin_pc !== null && (
                <span className="pos-muted"> · {percent(board.margin.margin_pc, 1)}</span>
              )}
            </strong>
          </div>
          <p className="pos-note">{board.margin.note}</p>
          <p className="pos-note">{board.margin.revenue_basis}</p>
        </div>
      ) : (
        <div style={{ marginTop: 18 }}>
          <Unavailable muted title="Gross margin is not shown">
            {board.margin.note}
          </Unavailable>
        </div>
      )}
    </Panel>
  )
}

export function OperationalAttention({
  board,
  filters,
}: {
  board: OverviewBoard
  filters: DashboardFilters
}) {
  const a = board.attention
  const total =
    a.posting_failed + a.posting_blocked + a.offline_pending + a.cash_variances + a.late_tickets + a.held_bills

  return (
    <Panel
      title="Needs a person"
      description={total === 0 ? 'Nothing is waiting.' : `${count(total)} item${total === 1 ? '' : 's'} waiting.`}
    >
      <div className="pos-stack pos-stack--tight">
        <AttentionRow
          label="Refused by Books or Inventory"
          description="A business reason. Retrying will not help until it is fixed."
          value={a.posting_blocked}
          tone="danger"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        <AttentionRow
          label="Not yet reached Books or Inventory"
          description="A transport failure. Safe to retry on the same key."
          value={a.posting_failed}
          tone="warning"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        <AttentionRow
          label="In flight — outcome unknown"
          description="Sent, no answer yet. Not the same as failed."
          value={a.posting_in_flight}
          tone="info"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        <AttentionRow
          label="Offline sales still to post"
          description="Taken on a till that had no connection."
          value={a.offline_pending}
          tone="warning"
          href="/offline"
        />
        <AttentionRow
          label="Drawers out and unsigned"
          value={a.cash_variances}
          tone="danger"
          href={withFilters('/controls', filters, { panel: 'shifts' })}
        />
        <AttentionRow
          label="Kitchen tickets past their station time"
          value={a.late_tickets}
          tone="warning"
          href={withFilters('/restaurant', filters, { panel: 'delays' })}
        />
        <AttentionRow
          label="Bills on hold"
          value={a.held_bills}
          tone="info"
          href={withFilters('/retail', filters, { panel: 'held' })}
        />
      </div>
      <p className="pos-note">{board.metric_basis.source}</p>
    </Panel>
  )
}

export function TenderMixPanel({ board, filters }: { board: OverviewBoard; filters: DashboardFilters }) {
  return (
    <Panel
      title="Tender mix"
      description="What the shop was paid with, and what that actually proves."
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to={withFilters('/controls', filters)}>
          Reconcile
        </Link>
      }
    >
      <ShareBars
        rows={board.tenders.map((line) => ({
          key: line.payment_mode,
          label: line.display_name,
          value: line.amount,
          note: `${count(line.count)} tender${line.count === 1 ? '' : 's'} · ${line.settlement_label}`,
          tone: line.settlement_state === 'collected' ? 'brand' : 'muted',
        }))}
        format={(v) => money(v)}
        emptyLabel="No tenders recorded in this period."
      />
      {board.tenders.some((line) => line.settlement_state === 'recorded') && (
        <p className="pos-note">
          Anything other than cash is <strong>recorded, not confirmed</strong>: a cashier typed it from an external
          terminal slip. POS integrates no payment provider, so it cannot say the money was collected.
        </p>
      )}
    </Panel>
  )
}
