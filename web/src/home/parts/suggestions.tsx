/**
 * Aicountly AI — what to do next.
 *
 * READ THE FOOTER BEFORE CHANGING THIS FILE. POS has no model integration
 * configured, so nothing on this card is model-generated: every item is a
 * threshold crossing over rows POS owns, and each is labelled "Rule-based" so
 * the badge still means something on the day a model does arrive. The card is
 * the seam for that day — server-side items arrive through the same list and
 * would carry their own badge.
 *
 * What is NOT here: predicted footfall, suggested staffing, trending products.
 * Nothing in this product observes a queue or forecasts a day, and a card that
 * said otherwise would be the most confidently wrong thing on the screen.
 */

import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import type { Suggestion, Tone } from '../model'
import { SkeletonRows, WidgetEmpty } from './states'

function iconClass(tone: Tone): string {
  if (tone === 'bad') return 'home-suggestion__icon home-suggestion__icon--bad'
  if (tone === 'warn') return 'home-suggestion__icon home-suggestion__icon--warn'
  if (tone === 'info') return 'home-suggestion__icon home-suggestion__icon--info'

  return 'home-suggestion__icon'
}

export function SuggestionsCard({ suggestions, loading }: { suggestions: Suggestion[]; loading: boolean }) {
  return (
    <section className="home-card home-suggestions-card" aria-label="Aicountly AI suggestions">
      <div className="home-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <Sparkles size={16} aria-hidden /> Aicountly AI
          </h2>
          <p>Smart suggestions for your business</p>
        </div>
        <span className="home-chip home-chip--brand">BETA</span>
      </div>

      <div className={suggestions.length > 0 && !loading ? 'home-card__body home-card__body--flush' : 'home-card__body'}>
        {loading ? (
          <SkeletonRows count={2} />
        ) : suggestions.length === 0 ? (
          <WidgetEmpty title="Nothing needs you right now.">
            Alerts appear here when something crosses a threshold — a stuck sale, a drawer out, a return waiting.
          </WidgetEmpty>
        ) : (
          <div className="home-suggestions">
            {suggestions.map((suggestion) => (
              <article className="home-suggestion" key={suggestion.id}>
                <span className={iconClass(suggestion.tone)} aria-hidden>
                  <Sparkles size={16} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <strong>{suggestion.title}</strong>
                  <p>{suggestion.body}</p>
                  <div className="home-suggestion__foot">
                    <span className="home-tag">Rule-based</span>
                    {suggestion.action && (
                      <Link className="home-btn home-btn--small" to={suggestion.action.to}>
                        {suggestion.action.label}
                      </Link>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <p className="home-card__foot">
        No model is connected to POS yet, so nothing here is a prediction. Each item is a rule computed from this
        company's own POS rows.
      </p>
    </section>
  )
}
