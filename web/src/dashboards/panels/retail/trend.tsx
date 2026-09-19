/**
 * The shape of the day.
 *
 * One line, four metrics behind a selector, and the comparison window as a
 * dashed second line when one was asked for. Drawn by this product's own SVG
 * charts rather than a charting library, for the reason at the top of
 * charts.tsx: a till is often a cheap tablet on shop broadband.
 */

import { useMemo, useState } from 'react'
import { TrendChart } from '../../charts'
import { count, decimal, money } from '../../format'
import { ContextualEmpty, Panel } from '../../shell'
import type { RetailBoard, RetailTrendMetric } from '../../types'

const FORMATTERS: Record<RetailTrendMetric, (value: number) => string> = {
  sales: (value) => money(value),
  bills: (value) => count(Math.round(value)),
  average_bill: (value) => money(value),
  items: (value) => decimal(value, 0),
}

export function HourlySalesTrend({ board }: { board: RetailBoard }) {
  const [metric, setMetric] = useState<RetailTrendMetric>('sales')

  const trend = board.trend
  const hourly = trend.bucket === 'hour'
  const chosen = trend.metrics.find((option) => option.key === metric) ?? trend.metrics[0]
  const format = FORMATTERS[chosen?.key ?? 'sales']

  const points = useMemo(
    () =>
      trend.points.map((point) => ({
        label: point.label,
        value: point[chosen?.key ?? 'sales'] as number,
        // Only the money series has a comparison behind it, so the dashed line
        // appears on that series and on no other. A comparison drawn from a
        // figure the server did not send would be a drawn guess.
        comparison: (chosen?.key ?? 'sales') === 'sales' ? point.comparison_sales : null,
      })),
    [trend.points, chosen],
  )

  return (
    <Panel
      title={hourly ? 'Hourly sales trend' : 'Daily sales trend'}
      action={
        trend.points.length > 0 && (
          <label className="pos-field">
            <span className="pos-visually-hidden">Metric to plot</span>
            <select
              className="pos-select-compact"
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
        <ContextualEmpty title="No sales trend available">
          {hourly
            ? 'Hourly activity appears here once a bill has been completed on this day.'
            : 'Daily activity appears here once bills have been completed in this range.'}
        </ContextualEmpty>
      ) : (
        <>
          <TrendChart
            points={points}
            valueLabel={chosen?.label ?? 'Sales'}
            comparisonLabel={trend.comparison_label}
            format={format}
            height={210}
            width={440}
            interactive
            caption={`${chosen?.label ?? 'Sales'} by ${hourly ? 'hour' : 'day'}`}
          />
          <p className="pos-note">{trend.basis}</p>
        </>
      )}
    </Panel>
  )
}
