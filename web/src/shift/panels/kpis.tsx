/**
 * The six figures a manager reads first.
 *
 * DIRECTION IS NOT THE SAME AS GOOD NEWS, and this strip is where that matters
 * most. Refunds down 42% is a fall and a win; discounts up 8% is a rise and a
 * cost. Each card therefore carries which way is better, and the arrow (the
 * direction) and the colour (the verdict) are decided separately. A strip that
 * painted every arrow-up green would tell a manager a shift with more voids
 * went well.
 *
 * Nothing here is communicated by colour alone: every delta also says "Up 12%
 * vs. previous shift" in words, which is what a screen reader reads out and
 * what prints on paper.
 */

import { Ban, BarChart3, IndianRupee, Receipt, Tag, Undo2 } from 'lucide-react'
import { Sparkline } from './charts'
import { delta, metricValue, safeNumber } from '../format'
import type { HourPoint, ShiftComparison, ShiftMetrics } from '../types'

interface KpiDefinition {
  id: keyof ShiftMetrics
  label: string
  icon: typeof Receipt
  kind: 'money' | 'count'
  /** Whether a rise in this figure is good news. */
  higherIsBetter: boolean
  comparison: keyof ShiftComparison
  series: (point: HourPoint) => number
}

const KPIS: KpiDefinition[] = [
  { id: 'bills', label: 'Bills', icon: Receipt, kind: 'count', higherIsBetter: true, comparison: 'bills_pct', series: (p) => p.orders },
  { id: 'net_sales', label: 'Net Sales / Taken', icon: IndianRupee, kind: 'money', higherIsBetter: true, comparison: 'net_sales_pct', series: (p) => p.net_sales },
  { id: 'average_bill', label: 'Average Bill', icon: BarChart3, kind: 'money', higherIsBetter: true, comparison: 'average_bill_pct', series: (p) => p.average_bill },
  { id: 'discounts', label: 'Discount Given', icon: Tag, kind: 'money', higherIsBetter: false, comparison: 'discounts_pct', series: (p) => p.discounts },
  { id: 'refunds', label: 'Refunds', icon: Undo2, kind: 'money', higherIsBetter: false, comparison: 'refunds_pct', series: (p) => p.refunds },
  { id: 'voids', label: 'Voids', icon: Ban, kind: 'count', higherIsBetter: false, comparison: 'voids_pct', series: (p) => p.voids },
]

export function ShiftKpiCard({
  definition,
  value,
  comparison,
  hourly,
}: {
  definition: KpiDefinition
  value: number
  comparison: ShiftComparison | null
  hourly: HourPoint[]
}) {
  const Icon = definition.icon
  const raw = comparison ? (comparison[definition.comparison] as number | null) : null
  const change = delta(raw, definition.higherIsBetter, comparison?.label ?? 'vs. previous shift')
  const points = hourly.map(definition.series)

  return (
    <article className="shift-kpi">
      <div className="shift-kpi__top">
        <span className="shift-kpi__icon" aria-hidden>
          <Icon size={15} />
        </span>
        <span className="shift-kpi__label">{definition.label}</span>
      </div>

      <strong className="shift-kpi__value">{metricValue(definition.kind, value)}</strong>

      <div className="shift-kpi__foot">
        <div style={{ minWidth: 0 }}>
          {change ? (
            <>
              <span className={`shift-kpi__delta shift-kpi__delta--${change.tone}`} aria-hidden>
                {change.label}
              </span>
              <span className="pos-visually-hidden">{change.description}</span>
              <span className="shift-kpi__since">{comparison?.label ?? 'vs. previous shift'}</span>
            </>
          ) : (
            <span className="shift-kpi__since">
              {comparison ? 'Nothing to compare against' : 'No previous shift on this till'}
            </span>
          )}
        </div>

        {points.length > 1 && (
          <Sparkline points={points} tone={change?.tone === 'bad' ? 'bad' : change?.tone === 'flat' ? 'flat' : 'good'} />
        )}
      </div>
    </article>
  )
}

export function ShiftKpiGrid({
  metrics,
  comparison,
  hourly,
}: {
  metrics: ShiftMetrics
  comparison: ShiftComparison | null
  hourly: HourPoint[]
}) {
  return (
    <section className="shift-kpis" aria-label="Shift key figures">
      {KPIS.map((definition) => (
        <ShiftKpiCard
          key={definition.id}
          definition={definition}
          // Zero is a value, not a missing figure: a shift that voided nothing
          // reads 0, never a dash.
          value={safeNumber(metrics[definition.id])}
          comparison={comparison}
          hourly={hourly}
        />
      ))}
    </section>
  )
}
