/**
 * The five figures the screen opens with.
 *
 * Each card is a button only where pressing it does something — the four that
 * drill into the roster below are buttons, and the one that has nowhere to go
 * is not. A card that looks pressable and is not is worse than a flat one.
 *
 * MOVEMENT IS REAL OR ABSENT. The trend chip comes from the server's comparison
 * block, which exists only when a comparison window was actually asked for. No
 * comparison, no chip — not a grey "0%", which reads as "no change" and is a
 * different claim from "nothing to compare against".
 */

import type { ReactNode } from 'react'
import { RefreshCw, TrendingUp, UserPlus, Users, Wallet } from 'lucide-react'
import { compactMoney, compare, count, money, percent } from '../format'
import type { CustomersBoard, CustomerTab } from '../types'

type Tone = 'brand' | 'info' | 'amber' | 'violet' | 'rose'

interface Kpi {
  id: string
  label: string
  value: string
  help: string
  icon: ReactNode
  tone: Tone
  movement: { label: string; short: string; direction: 'up' | 'down' | 'flat' } | null
  /** Where pressing it takes the roster, or null when it goes nowhere. */
  drill: { tab: CustomerTab; sort?: string } | null
}

export function CustomerKpiGrid({
  board,
  activeTab,
  activeSort,
  onDrill,
}: {
  board: CustomersBoard
  activeTab: CustomerTab
  activeSort: string
  onDrill: (tab: CustomerTab, sort?: string) => void
}) {
  const { kpis, coverage, comparison } = board
  const label = comparison?.label ?? null

  const cards: Kpi[] = [
    {
      id: 'identified',
      label: 'Identified customers',
      value: count(kpis.identified_customers),
      help: `From ${count(coverage.identified_bills)} of ${count(coverage.bills)} bills in this period`,
      icon: <Users size={19} strokeWidth={2} />,
      tone: 'brand',
      movement: compare(kpis.identified_customers, comparison?.identified_customers, label),
      drill: { tab: 'all' },
    },
    {
      id: 'new',
      label: 'New to this POS',
      value: count(kpis.new_customers),
      help: 'Their first bill here fell in this period',
      icon: <UserPlus size={19} strokeWidth={2} />,
      tone: 'info',
      movement: compare(kpis.new_customers, comparison?.new_customers, label),
      drill: { tab: 'new' },
    },
    {
      id: 'repeat',
      label: 'Repeat rate',
      value: percent(kpis.repeat_rate_pc, 0),
      help: 'Identified customers who bought more than once in this period',
      icon: <RefreshCw size={19} strokeWidth={2} />,
      tone: 'brand',
      movement:
        kpis.repeat_rate_pc === null ? null : compare(kpis.repeat_rate_pc, comparison?.repeat_rate_pc, label),
      drill: { tab: 'repeat' },
    },
    {
      id: 'basket',
      label: 'Identified average bill',
      value: money(kpis.identified_average_bill),
      help: 'Anonymous counter sales excluded',
      icon: <Wallet size={19} strokeWidth={2} />,
      tone: 'amber',
      movement:
        kpis.identified_average_bill === null
          ? null
          : compare(kpis.identified_average_bill, comparison?.identified_average_bill, label),
      drill: { tab: 'all', sort: 'spend' },
    },
    {
      id: 'revenue',
      label: 'Customer revenue',
      value: compactMoney(coverage.identified_net),
      help:
        coverage.identified_net_pc === null
          ? 'Nothing was taken in this period'
          : `${percent(coverage.identified_net_pc, 0)} of the ${compactMoney(coverage.net)} these tills took`,
      icon: <TrendingUp size={19} strokeWidth={2} />,
      tone: 'violet',
      movement: compare(coverage.identified_net, comparison?.identified_net, label),
      drill: { tab: 'all', sort: 'spend' },
    },
  ]

  return (
    <section className="cg-kpis" aria-label="Customer key figures">
      {cards.map((card) => {
        // Two cards drill to the same tab under different sorts, so the tab
        // alone cannot say which one is showing — matching the sort too keeps
        // exactly one card marked.
        const pressed =
          card.drill !== null &&
          card.drill.tab === activeTab &&
          (card.drill.sort ?? 'last_visit') === activeSort

        const body = (
          <>
            <span className={`cg-kpi__icon cg-kpi__icon--${card.tone}`} aria-hidden>
              {card.icon}
            </span>
            <span className="cg-kpi__body">
              <span className="cg-kpi__label">{card.label}</span>
              <span className="cg-kpi__figure">
                <strong className="cg-kpi__value">{card.value}</strong>
                {card.movement && (
                  <span className={`cg-trend cg-trend--${card.movement.direction}`} title={card.movement.label}>
                    {/* The arrow repeats what the figure says, on purpose. The
                        full sentence is in the card's aria-label and its title. */}
                    {card.movement.direction === 'up' ? '▲' : card.movement.direction === 'down' ? '▼' : '■'}{' '}
                    {card.movement.short}
                  </span>
                )}
              </span>
              <span className="cg-kpi__help">{card.help}</span>
            </span>
          </>
        )

        const description = `${card.label}: ${card.value}. ${card.help}${
          card.movement ? `. ${card.movement.label}` : ''
        }`

        if (card.drill === null) {
          return (
            <article key={card.id} className="cg-kpi" aria-label={description}>
              {body}
            </article>
          )
        }

        const drill = card.drill

        return (
          <button
            key={card.id}
            type="button"
            className="cg-kpi cg-kpi--action"
            aria-pressed={pressed}
            aria-label={`${description}. Show these customers in the list below`}
            onClick={() => onDrill(drill.tab, drill.sort)}
          >
            {body}
          </button>
        )
      })}
    </section>
  )
}
