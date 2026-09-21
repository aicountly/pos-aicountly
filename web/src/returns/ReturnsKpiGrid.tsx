/**
 * The four figures the counter is judged on.
 *
 * DIRECTION IS NOT SENTIMENT. More returns is worse; a smaller refund bill is
 * better; a higher exchange rate is better because the sale was kept. So each
 * card says which way is good, and the colour follows THAT rather than the
 * arrow. A screen that paints every downward arrow red teaches people to
 * ignore the colour.
 *
 * The words carry the meaning on their own — "12% less than the previous 30
 * days" reads the same in greyscale.
 */

import { ArrowDownRight, ArrowRight, ArrowUpRight, IndianRupee, PackageOpen, Repeat2, RotateCcw } from 'lucide-react'
import { count, decimal, money, percent } from '../dashboards/format'
import type { ReturnsSummary } from './types'

type Direction = 'up' | 'down' | 'flat'

interface Delta {
  direction: Direction
  /** True when this movement is the good one FOR THIS METRIC. Null when flat. */
  good: boolean | null
  label: string
  /** "vs" or "as", so the two halves read as one sentence either way. */
  preposition: string
}

/**
 * How this window compares with the one before it.
 *
 * Null when there is nothing to compare against: a percentage change from zero
 * is infinite, and "up ∞%" is not a fact about a shop.
 */
function delta(current: number | null, previous: number | null, betterWhen: 'lower' | 'higher'): Delta | null {
  if (current === null || previous === null || !Number.isFinite(previous) || previous === 0) return null

  const change = ((current - previous) / previous) * 100
  const direction: Direction = Math.abs(change) < 0.5 ? 'flat' : change > 0 ? 'up' : 'down'
  if (direction === 'flat') return { direction, good: null, label: 'About the same', preposition: 'as' }

  const good = (direction === 'up') === (betterWhen === 'higher')

  return {
    direction,
    good,
    label: `${percent(Math.abs(change), 0)} ${direction === 'up' ? 'more' : 'less'}`,
    preposition: 'vs',
  }
}

function DeltaLine({ value, windowLabel }: { value: Delta | null; windowLabel: string }) {
  if (!value) {
    return <span className="returns-kpi__delta returns-kpi__delta--none">No comparable figure for the previous period</span>
  }

  const Icon = value.direction === 'up' ? ArrowUpRight : value.direction === 'down' ? ArrowDownRight : ArrowRight
  const tone = value.good === null ? '' : value.good ? ' returns-kpi__delta--good' : ' returns-kpi__delta--bad'

  return (
    <span className={`returns-kpi__delta${tone}`}>
      <Icon size={14} aria-hidden />
      {value.label} <small>{`${value.preposition} ${windowLabel}`}</small>
    </span>
  )
}

function KpiCard({
  tone,
  icon,
  label,
  value,
  explanation,
  children,
}: {
  tone: 'purple' | 'green' | 'orange' | 'blue'
  icon: React.ReactNode
  label: string
  value: string
  explanation: string
  children: React.ReactNode
}) {
  return (
    <article className="returns-kpi">
      <span className={`returns-kpi__icon returns-kpi__icon--${tone}`} aria-hidden>
        {icon}
      </span>

      <div className="returns-kpi__body">
        <h3 className="returns-kpi__label">
          {label}
          <span className="returns-kpi__help" title={explanation} aria-hidden>
            ?
          </span>
          <span className="pos-visually-hidden">. {explanation}</span>
        </h3>
        <strong className="returns-kpi__value">{value}</strong>
        {children}
      </div>
    </article>
  )
}

function SkeletonCard() {
  return (
    <article className="returns-kpi returns-kpi--loading" aria-hidden>
      <span className="returns-skeleton returns-skeleton--icon" />
      <div className="returns-kpi__body">
        <span className="returns-skeleton returns-skeleton--label" />
        <span className="returns-skeleton returns-skeleton--value" />
        <span className="returns-skeleton returns-skeleton--line" />
      </div>
    </article>
  )
}

export function ReturnsKpiGrid({ summary, loading }: { summary: ReturnsSummary | null; loading: boolean }) {
  if (loading || !summary) {
    return (
      <section className="returns-kpis" aria-label="Returns key figures" aria-busy={loading}>
        {[0, 1, 2, 3].map((index) => (
          <SkeletonCard key={index} />
        ))}
      </section>
    )
  }

  const { kpis, comparison, comparison_window: previous } = summary
  const windowLabel = `the previous ${previous.days} day${previous.days === 1 ? '' : 's'}`

  return (
    <section className="returns-kpis" aria-label="Returns key figures">
      <KpiCard
        tone="purple"
        icon={<RotateCcw size={19} />}
        label="Total returns"
        value={count(kpis.total_returns)}
        explanation={`Returns taken between ${summary.window.from} and ${summary.window.to}, on the filters in force. Fewer is better.`}
      >
        <DeltaLine value={delta(kpis.total_returns, comparison.total_returns, 'lower')} windowLabel={windowLabel} />
      </KpiCard>

      <KpiCard
        tone="green"
        icon={<IndianRupee size={19} />}
        label="Return value"
        value={money(kpis.return_value)}
        explanation="What was credited back across those returns. A smaller bill is the better outcome, so a fall is shown as good."
      >
        <DeltaLine value={delta(kpis.return_value, comparison.return_value, 'lower')} windowLabel={windowLabel} />
      </KpiCard>

      <KpiCard
        tone="orange"
        icon={<PackageOpen size={19} />}
        label="Items returned"
        value={decimal(kpis.items_returned, 2)}
        explanation="Total quantity across every returned line, whether or not it went back on the shelf."
      >
        <DeltaLine value={delta(kpis.items_returned, comparison.items_returned, 'lower')} windowLabel={windowLabel} />
      </KpiCard>

      <KpiCard
        tone="blue"
        icon={<Repeat2 size={19} />}
        label="Exchange rate"
        value={kpis.exchange_ratio_pc === null ? '—' : percent(kpis.exchange_ratio_pc, 0)}
        explanation="Share of returns settled as an exchange rather than money back — the sale that was kept. Higher is better."
      >
        {kpis.exchange_ratio_pc === null ? (
          <span className="returns-kpi__delta returns-kpi__delta--none">No returns in this period</span>
        ) : (
          <DeltaLine
            value={delta(kpis.exchange_ratio_pc, comparison.exchange_ratio_pc, 'higher')}
            windowLabel={windowLabel}
          />
        )}
      </KpiCard>
    </section>
  )
}
