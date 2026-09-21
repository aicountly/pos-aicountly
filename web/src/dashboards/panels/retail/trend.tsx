/**
 * The shape of the day.
 *
 * Columns rather than a line, and deliberately: this is an hour-by-hour
 * comparison — "was three o'clock bigger than two" — and a bar answers that
 * at a glance where a line asks the reader to follow a slope. ColumnChart
 * carries its own readout under the pointer and its own keyboard traversal,
 * so the figure behind each bar is reachable without a mouse.
 *
 * The metric selector offers only what the server said it has. Gross margin is
 * not on the list: unit cost belongs to Inventory, and a margin drawn from the
 * counter price alone would be a guess.
 */

import { useMemo, useState } from 'react'
import { ColumnChart } from '../../charts'
import { compactMoney, count, decimal, money } from '../../format'
import { EmptyState, Panel } from '../../shell'
import type { RetailBoard, RetailTrendMetric } from '../../types'

const FORMATTERS: Record<RetailTrendMetric, (value: number) => string> = {
  sales: (value) => compactMoney(value),
  bills: (value) => count(Math.round(value)),
  average_bill: (value) => compactMoney(value),
  items: (value) => decimal(value, 0),
}

/** The long form, for the readout under the pointer where there is room for it. */
const EXACT: Record<RetailTrendMetric, (value: number) => string> = {
  sales: (value) => money(value),
  bills: (value) => `${count(Math.round(value))} bill${Math.round(value) === 1 ? '' : 's'}`,
  average_bill: (value) => money(value),
  items: (value) => `${decimal(value, 2)} items`,
}

export function HourlySalesTrend({ board }: { board: RetailBoard }) {
  const [metric, setMetric] = useState<RetailTrendMetric>('sales')

  const trend = board.trend
  const hourly = trend.bucket === 'hour'
  const chosen = trend.metrics.find((option) => option.key === metric) ?? trend.metrics[0]
  const key = chosen?.key ?? 'sales'

  const points = useMemo(
    () =>
      trend.points.map((point) => ({
        key: point.bucket,
        label: point.label,
        value: point[key] as number,
        // Only the money series has a comparison behind it, so the second bar
        // appears on that series and on no other. A comparison drawn from a
        // figure the server did not send would be a drawn guess.
        comparison: key === 'sales' ? point.comparison_sales : null,
        secondary: `${count(point.bills)} bill${point.bills === 1 ? '' : 's'}`,
        tooltipLabel: hourly ? `${point.label} — ${point.bucket}` : point.label,
      })),
    [trend.points, key, hourly],
  )

  return (
    <Panel
      title={hourly ? 'Hourly sales trend' : 'Daily sales trend'}
      action={
        trend.points.length > 0 && (
          <label className="pos-field">
            <span className="pos-visually-hidden">Metric to plot</span>
            <select
              className="pos-select"
              value={metric}
              onChange={(event) => setMetric(event.target.value as RetailTrendMetric)}
            >
              {trend.metrics.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      {trend.points.length === 0 ? (
        <EmptyState title="No sales trend available">
          {hourly
            ? 'Hourly activity appears here once a bill has been completed on this day.'
            : 'Daily activity appears here once bills have been completed in this range.'}
        </EmptyState>
      ) : (
        <>
          <ColumnChart
            points={points}
            valueLabel={chosen?.label ?? 'Sales'}
            comparisonLabel={key === 'sales' ? trend.comparison_label : null}
            format={key === 'sales' || key === 'average_bill' ? FORMATTERS[key] : EXACT[key]}
            height={232}
            caption={`${chosen?.label ?? 'Sales'} by ${hourly ? 'hour' : 'day'}`}
          />
          <p className="pos-note">{trend.basis}</p>
        </>
      )}
    </Panel>
  )
}
