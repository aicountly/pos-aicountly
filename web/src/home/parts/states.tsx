/**
 * The small pieces every widget on this page shares.
 *
 * Four states, and they are not interchangeable. "Nothing happened", "we could
 * not ask", "you may not see this" and "still loading" are four different facts
 * and a screen that renders any two of them identically is lying about one.
 */

import type { ReactNode } from 'react'
import { Inbox, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import type { Tone } from '../model'

/** A status, in words. The dot is decoration; the text is the status. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`home-chip home-chip--${tone === 'neutral' ? 'neutral' : tone}`}>
      <span className="home-chip__dot" aria-hidden />
      {children}
    </span>
  )
}

export function WidgetEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="home-empty">
      <Inbox size={22} aria-hidden />
      <strong>{title}</strong>
      {children && <small>{children}</small>}
    </div>
  )
}

export function WidgetFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="home-failed" role="alert">
      <span style={{ display: 'flex', gap: 8 }}>
        <TriangleAlert size={16} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
        <span>{message}</span>
      </span>
      <button type="button" className="home-btn home-btn--small" onClick={onRetry}>
        <RefreshCw size={13} aria-hidden /> Try again
      </button>
    </div>
  )
}

/** Not an empty state: the figure exists, this person may not see it. */
export function WidgetRestricted({ children }: { children: ReactNode }) {
  return (
    <div className="home-empty">
      <Lock size={20} aria-hidden />
      <strong>Not shown for your role</strong>
      <small>{children}</small>
    </div>
  )
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="home-rows" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="home-skeleton home-skeleton--row" />
      ))}
    </div>
  )
}

/**
 * The page before the session has answered.
 *
 * It matches the real layout block for block, so nothing jumps when the
 * figures land. It matters more here than on a report: the hero decides what
 * it is from the session, and rendering the setup hero for the half second
 * before the session arrives would tell a shop with four tills that it has
 * none.
 */
export function HomePageSkeleton() {
  return (
    <div className="pos-home" role="status" aria-busy="true" aria-label="Loading your counter">
      <div className="pos-home__section home-welcome">
        <div className="home-welcome__copy">
          <span className="home-skeleton" style={{ width: 42, height: 42, borderRadius: 12 }} />
          <div style={{ flex: 1 }}>
            <div className="home-skeleton" style={{ height: 22, width: 220 }} />
            <div className="home-skeleton home-skeleton--line" style={{ width: 280, marginTop: 8 }} />
          </div>
        </div>
      </div>

      <div className="pos-home__section home-kpis">
        {[0, 1, 2, 3, 4].map((card) => (
          <article className="home-kpi" key={card}>
            <span className="home-skeleton" style={{ width: 42, height: 42, borderRadius: 12, flex: '0 0 42px' }} />
            <span className="home-kpi__body" style={{ width: '100%' }}>
              <span className="home-skeleton home-skeleton--line" style={{ width: '70%' }} />
              <span className="home-skeleton home-skeleton--value" style={{ marginTop: 8 }} />
              <span className="home-skeleton home-skeleton--line" style={{ width: '55%', marginTop: 8 }} />
            </span>
          </article>
        ))}
      </div>

      <div className="pos-home__section home-primary">
        <div className="home-skeleton" style={{ minHeight: 330, borderRadius: 20 }} />
        <div className="home-skeleton" style={{ minHeight: 330, borderRadius: 16 }} />
      </div>

      <div className="pos-home__section home-secondary">
        <div className="home-skeleton home-trend-card" style={{ minHeight: 300, borderRadius: 16 }} />
        <div className="home-skeleton home-top-card" style={{ minHeight: 300, borderRadius: 16 }} />
        <div className="home-column">
          <div className="home-skeleton" style={{ minHeight: 142, borderRadius: 16 }} />
          <div className="home-skeleton" style={{ minHeight: 142, borderRadius: 16 }} />
        </div>
        <div className="home-skeleton home-suggestions-card" style={{ minHeight: 300, borderRadius: 16 }} />
      </div>
    </div>
  )
}
