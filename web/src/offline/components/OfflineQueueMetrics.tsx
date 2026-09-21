/**
 * The five cards.
 *
 * Four of them are buttons, because a number a cashier cannot act on is
 * decoration: pressing Failed filters the table to the failed rows. The fifth,
 * Last Offline, is a fact rather than a filter, so it is not a button — a
 * control that looks pressable and does nothing is worse than a plain card.
 */

import { AlertTriangle, CheckCircle2, Clock, FileText, XCircle } from 'lucide-react'
import type { QueueCounts } from '../model'
import type { QueueTab } from '../tabs'
import { dayContextLabel, timeLabel } from './badges'

export interface MetricsProps {
  counts: QueueCounts
  lastOfflineAt: number | null
  activeTab: QueueTab
  onFilter: (tab: QueueTab) => void
  loading: boolean
}

export function OfflineQueueMetrics({ counts, lastOfflineAt, activeTab, onFilter, loading }: MetricsProps) {
  const cards: {
    tab: QueueTab | null
    tone: string
    icon: typeof FileText
    value: string
    label: string
    hint: string
  }[] = [
    {
      tab: 'all',
      tone: 'q-kpi--blue',
      icon: FileText,
      value: String(counts.queued),
      label: 'Queued Transactions',
      hint: 'Waiting to be posted',
    },
    {
      tab: 'ready',
      tone: 'q-kpi--green',
      icon: CheckCircle2,
      value: String(counts.ready),
      label: 'Ready to Post',
      hint: 'Valid data',
    },
    {
      tab: 'attention',
      tone: 'q-kpi--amber',
      icon: AlertTriangle,
      value: String(counts.attention),
      label: 'Need Attention',
      hint: 'Fix before posting',
    },
    {
      tab: 'failed',
      tone: 'q-kpi--red',
      icon: XCircle,
      value: String(counts.failed),
      label: 'Failed',
      hint: 'Tap to retry',
    },
    {
      tab: null,
      tone: 'q-kpi--purple',
      icon: Clock,
      value: lastOfflineAt ? timeLabel(lastOfflineAt) : '—',
      label: 'Last Offline',
      hint: dayContextLabel(lastOfflineAt),
    },
  ]

  return (
    <section className="q-kpis" aria-label="Offline queue summary">
      {cards.map((card) => {
        const Icon = card.icon
        const body = (
          <>
            <span className={`q-kpi__icon`} aria-hidden>
              <Icon size={20} />
            </span>
            <span className="q-kpi__body">
              <span className={card.tab === null ? 'q-kpi__value q-kpi__value--time' : 'q-kpi__value'}>
                {loading && card.tab !== null ? <span className="q-skel" style={{ width: 28, display: 'block' }} /> : card.value}
              </span>
              <span className="q-kpi__label">{card.label}</span>
              <span className="q-kpi__hint">{card.hint}</span>
            </span>
          </>
        )

        if (card.tab === null) {
          return (
            <div className={`q-kpi ${card.tone}`} key={card.label}>
              {body}
            </div>
          )
        }

        return (
          <button
            type="button"
            key={card.label}
            className={`q-kpi ${card.tone}`}
            onClick={() => onFilter(card.tab as QueueTab)}
            aria-pressed={activeTab === card.tab}
          >
            {body}
          </button>
        )
      })}
    </section>
  )
}
