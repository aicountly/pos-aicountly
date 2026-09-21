/**
 * The five figures along the top.
 *
 * Two kinds of number, and the difference matters. The first three are COUNTED
 * FROM THE BOARD IN VIEW — they are the same tickets, totalled — so they are
 * always true and always agree with the columns underneath.
 *
 * The last two are today's performance across every ticket of the session,
 * which a browser holding the most recent two hundred cannot honestly work
 * out. They come from the server, and where the server has not answered they
 * read as unavailable. A made-up average is worse than no average: a kitchen
 * that is judged on it will notice, and then it will trust none of them.
 */

import { memo, type ReactNode } from 'react'
import { CircleCheck, Flame, Timer, UtensilsCrossed } from 'lucide-react'
import type { KdsMetrics } from '../types'
import { minutesLabel } from '../derive'

type Tone = 'blue' | 'amber' | 'green' | 'red'

function Kpi({
  icon,
  tone,
  value,
  label,
  context,
}: {
  icon: ReactNode
  tone: Tone
  value: string
  label: string
  context?: string
}) {
  return (
    <article className="kds-kpi">
      <span className={`kds-kpi__icon kds-kpi__icon--${tone}`} aria-hidden>
        {icon}
      </span>
      <div className="kds-kpi__body">
        <strong className="kds-kpi__value">{value}</strong>
        <span className="kds-kpi__label">{label}</span>
        {context && <span className="kds-kpi__context">{context}</span>}
      </div>
    </article>
  )
}

export const KitchenMetrics = memo(function KitchenMetrics({
  active,
  preparing,
  ready,
  delayed,
  metrics,
  loading,
}: {
  active: number
  preparing: number
  ready: number
  delayed: number
  metrics: KdsMetrics | null
  loading: boolean
}) {
  if (loading) {
    return (
      <section className="kds-kpis" aria-label="Kitchen figures" aria-busy="true">
        {[0, 1, 2, 3, 4].map((n) => (
          <div key={n} className="kds-kpi">
            <span className="kds-skeleton" style={{ width: 42, height: 42, borderRadius: 12, flex: '0 0 auto' }} />
            <div className="kds-kpi__body" style={{ width: '100%' }}>
              <span className="kds-skeleton" style={{ display: 'block', width: '52%', height: 22 }} />
              <span className="kds-skeleton" style={{ display: 'block', width: '78%', height: 11, marginTop: 8 }} />
            </div>
          </div>
        ))}
      </section>
    )
  }

  const onTime = metrics?.on_time_pc
  const avgPrep = metrics?.avg_prep_seconds

  return (
    <section className="kds-kpis" aria-label="Kitchen figures">
      <Kpi
        icon={<UtensilsCrossed size={19} />}
        tone="blue"
        value={String(active)}
        label="Total active orders"
        context={delayed > 0 ? `${delayed} past target` : 'Nothing past target'}
      />
      <Kpi
        icon={<Flame size={19} />}
        tone="amber"
        value={String(preparing)}
        label="Preparing"
        context="On the line now"
      />
      <Kpi
        icon={<CircleCheck size={19} />}
        tone="green"
        value={String(ready)}
        label="Ready for pickup"
        context={ready > 0 ? 'Waiting on the pass' : 'Pass is clear'}
      />
      <Kpi
        icon={<Timer size={19} />}
        tone="blue"
        value={avgPrep === null || avgPrep === undefined ? '—' : minutesLabel(avgPrep)}
        label="Avg. prep time"
        context={
          metrics === null
            ? 'Not reported by this API'
            : metrics.completed === 0
              ? 'No ticket finished yet today'
              : `Fired to ready · ${metrics.completed} today`
        }
      />
      <Kpi
        icon={<CircleCheck size={19} />}
        tone={onTime === null || onTime === undefined ? 'blue' : onTime >= 90 ? 'green' : onTime >= 75 ? 'amber' : 'red'}
        value={onTime === null || onTime === undefined ? '—' : `${onTime}%`}
        label="On time today"
        context={
          metrics === null
            ? 'Not reported by this API'
            : metrics.completed === 0
              ? 'Measured against each station’s target'
              : `${metrics.on_time} of ${metrics.completed} within target`
        }
      />
    </section>
  )
})
