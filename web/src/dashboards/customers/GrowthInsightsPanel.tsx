/**
 * What to do next — and what produced the suggestion.
 *
 * THIS PANEL IS NOT CALLED "AI INSIGHTS", and the badge on it says "Rule-based"
 * rather than "Beta". POS has no model integration: these are threshold checks
 * over counts the server already made. Dressing a count in an AI badge is how
 * people stop believing the badge on the day there is a model behind it, so the
 * panel says what it is and the footnote says plainly that no model is
 * configured.
 *
 * Every row states the rule that fired it and how many customers are behind it,
 * so a merchant can decide whether "713 regulars have gone quiet" is worth a
 * print run or is four people and a rounding error.
 */

import { CalendarClock, ChevronRight, Sparkles, TriangleAlert, UserRoundX } from 'lucide-react'
import { count } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { CustomersBoard } from '../types'

type Suggestion = CustomersBoard['suggestions']['items'][number]

/** The mark beside a suggestion. Keyed by what fired it, not by mood. */
function markFor(item: Suggestion) {
  if (item.segment === 'at_risk') return { icon: <UserRoundX size={16} strokeWidth={2} />, tone: 'rose' }
  if (item.segment === 'one_time') return { icon: <TriangleAlert size={16} strokeWidth={2} />, tone: 'amber' }

  return { icon: <CalendarClock size={16} strokeWidth={2} />, tone: 'info' }
}

export function GrowthInsightsPanel({
  board,
  onOpen,
}: {
  board: CustomersBoard
  onOpen: (item: Suggestion) => void
}) {
  const { suggestions } = board

  return (
    <Panel
      title="Growth insights"
      description="Prepared for review. POS does not send anything."
      action={<StatusBadge tone="neutral">Rule-based</StatusBadge>}
      flush
    >
      {suggestions.items.length === 0 ? (
        <div className="cg-insights__empty">
          <Unavailable muted title="Nothing to suggest yet">
            No segment is large enough, or moving enough, to be worth acting on. Retention insights appear here as
            more bills carry a customer.
          </Unavailable>
        </div>
      ) : (
        <ul className="cg-insights">
          {suggestions.items.map((item) => {
            const mark = markFor(item)

            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="cg-insight"
                  onClick={() => onOpen(item)}
                  aria-label={`${item.title}. ${item.explanation} Open the detail for this suggestion.`}
                >
                  <span className={`cg-insight__icon cg-insight__icon--${mark.tone}`} aria-hidden>
                    {mark.icon}
                  </span>
                  <span className="cg-insight__text">
                    <strong>{item.title}</strong>
                    <small>{item.explanation}</small>
                    <small className="cg-insight__meta">
                      {count(item.supporting_customers)} customer{item.supporting_customers === 1 ? '' : 's'} behind
                      this · {item.period_label}
                    </small>
                  </span>
                  <ChevronRight className="cg-insight__chevron" size={16} strokeWidth={2} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="cg-insights__foot">
        <p className="pos-note">
          <StatusBadge tone="neutral">
            <Sparkles size={11} strokeWidth={2.2} aria-hidden /> No AI configured
          </StatusBadge>{' '}
          {suggestions.ai.note}
        </p>
        <p className="pos-note">{suggestions.sending.note}</p>
      </div>
    </Panel>
  )
}
