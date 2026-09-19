/**
 * The five figures a manager reads first.
 *
 * NO INVENTED TREND. The mock this board was drawn from carries "↑ 12% vs
 * yesterday" under every card. The controls endpoint computes no comparison
 * window, so there is no yesterday to compare against and each card carries a
 * factual second line instead — how many drawers are counted, how many tenders
 * make up the figure, who is on duty. A percentage nobody measured is worse
 * than no percentage at all on the one screen where the numbers have to hold up
 * in an argument.
 */

import type { ReactNode } from 'react'
import { Banknote, CreditCard, QrCode, ReceiptIndianRupee, Users } from 'lucide-react'
import { count, money } from '../format'
import type { ControlsKpis } from './derive'

type MetricTone = 'green' | 'blue' | 'purple' | 'orange' | 'slate'

export function CashMetricCard({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string
  value: string
  note: ReactNode
  tone: MetricTone
  icon: ReactNode
}) {
  return (
    <article className={`cc-kpi cc-kpi--${tone}`}>
      <span className="cc-kpi__icon" aria-hidden>
        {icon}
      </span>
      <div className="cc-kpi__body">
        <span className="cc-kpi__label">{label}</span>
        <strong className="cc-kpi__value">{value}</strong>
        <span className="cc-kpi__note">{note}</span>
      </div>
    </article>
  )
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function CashControlsKPIs({ kpis, periodLabel }: { kpis: ControlsKpis; periodLabel: string }) {
  return (
    <section className="cc-kpis" aria-label="Cash and shift key figures">
      <CashMetricCard
        tone="green"
        icon={<Banknote size={21} />}
        label="Total cash in hand"
        value={money(kpis.cashInHand)}
        note={
          kpis.openShifts > 0
            ? `Running · ${count(kpis.openShifts)} ${plural(kpis.openShifts, 'shift', 'shifts')} still open`
            : kpis.totalShifts === 0
              ? 'No shift opened in this period'
              : `${count(kpis.countedShifts)} of ${count(kpis.totalShifts)} drawers counted`
        }
      />

      <CashMetricCard
        tone="blue"
        icon={<CreditCard size={21} />}
        label="Total card payments"
        value={kpis.cardPayments === null ? '—' : money(kpis.cardPayments)}
        note={
          kpis.cardPayments === null
            ? 'No card tender in this period'
            : `${count(kpis.cardCount)} ${plural(kpis.cardCount, 'tender', 'tenders')} recorded`
        }
      />

      <CashMetricCard
        tone="purple"
        icon={<QrCode size={21} />}
        label="UPI payments"
        value={kpis.upiPayments === null ? '—' : money(kpis.upiPayments)}
        note={
          kpis.upiPayments === null
            ? 'No UPI tender in this period'
            : `${count(kpis.upiCount)} ${plural(kpis.upiCount, 'tender', 'tenders')} recorded`
        }
      />

      <CashMetricCard
        tone="orange"
        icon={<ReceiptIndianRupee size={21} />}
        label="Total sales taken"
        value={money(kpis.totalSales)}
        note={`${periodLabel} · ${count(kpis.tenderCount)} ${plural(kpis.tenderCount, 'tender', 'tenders')}`}
      />

      <CashMetricCard
        tone="slate"
        icon={<Users size={21} />}
        label="Active shifts"
        value={`${count(kpis.openShifts)} / ${count(kpis.totalShifts)}`}
        note={
          kpis.staffOnDuty === 0
            ? 'Nobody is on duty'
            : `${count(kpis.staffOnDuty)} ${plural(kpis.staffOnDuty, 'cashier', 'cashiers')} on duty`
        }
      />
    </section>
  )
}
