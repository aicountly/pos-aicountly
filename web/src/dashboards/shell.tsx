/**
 * The shared furniture every POS dashboard is built from.
 *
 * One shell, five bodies. What is shared is the page header, the switcher, the
 * filter bar, the freshness line and the metric row; what differs is the panels
 * underneath, and those are real components per board rather than one chart
 * rendered five times under different headings.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const TONES: readonly BadgeTone[] = ['neutral', 'success', 'warning', 'danger', 'info']

/**
 * A status, in words.
 *
 * The dot is decoration; the text inside is the status. Nothing in this product
 * communicates state with colour alone, because roughly one man in twelve
 * cannot tell the green one from the red one.
 */
export function StatusBadge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: BadgeTone
  dot?: boolean
  children: ReactNode
}) {
  const safeTone = TONES.includes(tone) ? tone : 'neutral'

  return (
    <span className={`pos-badge pos-badge--${safeTone}`}>
      {dot && <span className="pos-dot" aria-hidden />}
      {children}
    </span>
  )
}

export type MetricTone = 'green' | 'blue' | 'orange' | 'purple' | 'red'

/**
 * A trend badge on a metric card.
 *
 * `direction` is which way the number went. `intent` is whether that is good
 * news, and the two are NOT the same thing: checkout taking twelve per cent
 * longer is a down arrow's worth of bad, and one fewer void is a down arrow's
 * worth of good. Colouring every rise green is how a dashboard congratulates a
 * shop on its void rate.
 */
export interface MetricTrend {
  /** The two or three characters in the badge. */
  label: string
  direction: 'up' | 'down' | 'flat'
  intent: 'good' | 'bad' | 'neutral'
  /** The whole sentence, for the tooltip and the accessible name. */
  describe?: string
}

export interface MetricProps {
  id: string
  label: string
  value: string | null
  /** The one line that says what the number is, under it. */
  context?: string
  comparison?: { label: string; direction: 'up' | 'down' | 'flat' } | null
  /** The compact badge the operations boards use instead of `comparison`. */
  trend?: MetricTrend | null
  tone?: MetricTone
  icon?: ReactNode
  /** A sparkline or a ratio meter, on the bottom right. Decoration only. */
  figure?: ReactNode
  /** Where the metric drills into. A metric with no detail view is not a button. */
  href?: string
  onOpen?: () => void
}

const ARROW = { up: '▲', down: '▼', flat: '■' } as const

export function MetricCard({
  label,
  value,
  context,
  comparison,
  trend,
  tone,
  icon,
  figure,
  href,
  onOpen,
}: MetricProps) {
  const body = (
    <>
      {(icon || trend) && (
        <span className="pos-metric__top">
          {icon ? (
            <span className={`pos-metric__icon${tone ? ` pos-metric__icon--${tone}` : ''}`} aria-hidden>
              {icon}
            </span>
          ) : (
            <span />
          )}
          {trend && (
            <span className={`pos-trend pos-trend--${trend.intent}`} title={trend.describe}>
              {/* The arrow says which way; the class says whether that is good.
                  The words in the label say both, for a reader who sees
                  neither. */}
              <span aria-hidden>{ARROW[trend.direction]}</span> {trend.label}
            </span>
          )}
        </span>
      )}

      <span className="pos-metric__label">{label}</span>
      <strong className="pos-metric__value">{value ?? '—'}</strong>

      {comparison && !trend && (
        <span
          className={`pos-metric__comparison${
            comparison.direction === 'flat' ? '' : ` pos-metric__comparison--${comparison.direction}`
          }`}
        >
          {/* The arrow is redundant with the words, on purpose. */}
          {ARROW[comparison.direction]} {comparison.label}
        </span>
      )}

      {(context || figure) && (
        <span className="pos-metric__bottom">
          {context ? <span className="pos-muted">{context}</span> : <span />}
          {figure}
        </span>
      )}
    </>
  )

  const trailer = trend?.describe ?? trend?.label ?? comparison?.label
  const description = `${label}: ${value ?? 'Unavailable'}${trailer ? `, ${trailer}` : ''}${context ? `. ${context}` : ''}`

  if (href) {
    return (
      <Link className="pos-metric" to={href} aria-label={`${description}. View details`}>
        {body}
      </Link>
    )
  }

  return (
    <button
      type="button"
      className="pos-metric"
      onClick={onOpen}
      disabled={!onOpen}
      aria-label={onOpen ? `${description}. View details` : description}
    >
      {body}
    </button>
  )
}

export function Panel({
  title,
  description,
  action,
  flush = false,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section className="pos-panel" aria-label={title}>
      <header className="pos-panel__header">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {description && <p className="pos-muted">{description}</p>}
        </div>
        {action}
      </header>
      <div className={flush ? 'pos-panel__body pos-panel__body--flush' : 'pos-panel__body'}>{children}</div>
    </section>
  )
}

export interface Insight {
  id: string
  kind: 'rule' | 'ai'
  severity?: 'info' | 'success' | 'warning' | 'danger'
  title: string
  explanation: string
  period_label: string
  evidence_href?: string | null
  action_label?: string | null
}

/**
 * One suggestion or alert.
 *
 * The badge says which it is. A threshold crossing is a rule-based alert and is
 * labelled as one — putting an "AI" badge on a count is how people stop
 * believing the badge anywhere.
 */
export function InsightCard({ insight, onAction }: { insight: Insight; onAction?: () => void }) {
  const severity = insight.severity ?? 'info'
  const tone: BadgeTone = insight.kind === 'ai' ? 'info' : severity === 'info' ? 'neutral' : severity

  return (
    <article
      className={`pos-insight${severity === 'warning' || severity === 'danger' ? ` pos-insight--${severity}` : ''}`}
    >
      <div className="pos-inline">
        <StatusBadge tone={tone}>{insight.kind === 'ai' ? 'AI suggestion' : 'Rule-based alert'}</StatusBadge>
        <span className="pos-muted">{insight.period_label}</span>
      </div>
      <h3>{insight.title}</h3>
      <p>{insight.explanation}</p>
      {(insight.evidence_href || onAction) && (
        <div className="pos-actions">
          {insight.evidence_href && (
            <Link className="pos-button pos-button--quiet pos-button--small" to={insight.evidence_href}>
              View evidence
            </Link>
          )}
          {onAction && insight.action_label && (
            <button type="button" className="pos-button pos-button--secondary pos-button--small" onClick={onAction}>
              {insight.action_label}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * Something POS genuinely cannot answer.
 *
 * Deliberately not styled like an empty state. "There is no loyalty scheme" and
 * "no customer has any points" are different facts, and a screen that renders
 * them identically is lying about one of them.
 */
export function Unavailable({
  title,
  children,
  muted = false,
}: {
  title?: string
  children: ReactNode
  muted?: boolean
}) {
  return (
    <div className={muted ? 'pos-unavailable pos-unavailable--muted' : 'pos-unavailable'} role="note">
      <div>
        {title && <strong style={{ display: 'block', marginBottom: 4 }}>{title}</strong>}
        {children}
      </div>
    </div>
  )
}

/**
 * A widget that could not load, without taking the board down with it.
 *
 * One panel's endpoint failing is not the dashboard failing. The counter table
 * going quiet while the sales curve is fine should cost the manager the counter
 * table, not the screen they were reading.
 */
export function WidgetError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="pos-widget-error" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="pos-button pos-button--secondary pos-button--small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

/**
 * An empty widget that reads as a next step rather than a fault.
 *
 * "No counters set up yet" across half a screen tells a new shop it is broken.
 * The same fact, in the panel it belongs to and with the button that fixes it,
 * tells them what to do.
 */
export function ContextualEmpty({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="pos-empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="pos-actions">{action}</div>}
    </div>
  )
}

/**
 * The shape of a panel that has not arrived.
 *
 * Deliberately the same height and rhythm as the thing it stands in for, so
 * the page does not jump when the data lands. `aria-hidden` with a polite
 * status line beside it: a screen reader wants "loading", not eleven grey bars.
 */
export function WidgetSkeleton({ rows = 4, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div className="pos-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="pos-skeleton__bar"
          style={{ height, width: `${[100, 82, 91, 68, 76, 88][i % 6]}%` }}
        />
      ))}
    </div>
  )
}

/** A whole panel, still loading, with its real heading already in place. */
export function PanelSkeleton({ title, rows = 4, height = 14 }: { title: string; rows?: number; height?: number }) {
  return (
    <section className="pos-panel" aria-label={`${title}, loading`} aria-busy="true">
      <header className="pos-panel__header">
        <h2>{title}</h2>
      </header>
      <div className="pos-panel__body">
        <WidgetSkeleton rows={rows} height={height} />
      </div>
    </section>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pos-state pos-state--inline">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  )
}

/**
 * Loading, error, empty — or the dashboard.
 *
 * `empty` is only ever true when the request SUCCEEDED and returned nothing. A
 * failed request lands on the error branch, because "no sales today" and "we
 * could not ask" must never render as the same screen.
 */
export function DashboardBody({
  loading,
  error,
  empty,
  emptyTitle = 'No activity in this period',
  onRetry,
  skeleton,
  children,
}: {
  loading: boolean
  error: string | null
  empty?: boolean
  emptyTitle?: string
  onRetry: () => void
  /**
   * The placeholder layout to draw while the first request is in flight.
   *
   * A board that passes one gets its own shape back rather than the words
   * "Loading dashboard", so nothing jumps when the figures land.
   */
  skeleton?: ReactNode
  children: ReactNode
}) {
  if (loading) {
    if (skeleton) {
      return (
        <div aria-busy="true">
          <p className="pos-visually-hidden" role="status" aria-live="polite">
            Loading the retail board…
          </p>
          {skeleton}
        </div>
      )
    }

    return (
      <div className="pos-state" role="status" aria-live="polite">
        Loading dashboard…
      </div>
    )
  }

  if (error) {
    return (
      <div className="pos-state" role="alert">
        <h2>Dashboard could not be loaded</h2>
        <p>{error}</p>
        <button type="button" className="pos-button pos-button--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }

  if (empty) {
    return (
      <div className="pos-state">
        <h2>{emptyTitle}</h2>
        <p>Choose another period, or open the operation this board is about.</p>
      </div>
    )
  }

  return <>{children}</>
}

export interface DashboardTab {
  id: string
  label: string
  path: string
}

/**
 * The counter mark beside an operations heading.
 *
 * A line drawing rather than a filled illustration, at a weight that reads as
 * a deliberate mark and not as three grey boxes behind the text. It is
 * `aria-hidden` and carries no information; it goes away entirely below
 * 1100px, where the space belongs to the heading.
 */
function CounterMark() {
  return (
    <svg className="pos-hero__art" viewBox="0 0 132 96" aria-hidden focusable="false">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4">
        {/* The terminal */}
        <rect x="14" y="26" width="62" height="46" rx="7" />
        <rect x="23" y="35" width="44" height="19" rx="3" className="pos-hero__art--screen" />
        <path d="M24 62h15M46 62h9" />
        {/* The receipt coming out of it */}
        <path d="M86 20h28v56l-7-5-7 5-7-5-7 5z" />
        <path d="M94 33h12M94 43h12M94 53h7" strokeWidth="2" />
        {/* The bag */}
        <path d="M30 76h34l-4 14H34z" />
        <path d="M40 76v-5a5 5 0 0 1 10 0v5" strokeWidth="2" />
      </g>
    </svg>
  )
}

export function PosDashboardShell({
  title,
  description,
  activeDashboard,
  visibleTabs,
  contextControls,
  filterControls,
  freshnessLabel,
  primaryAction,
  secondaryActions,
  onRefresh,
  refreshing,
  metrics,
  metricsLoading = false,
  metricSkeletons = 5,
  heroArt = false,
  heroQuote,
  pulse,
  children,
}: {
  title: string
  description: string
  activeDashboard: string
  visibleTabs: DashboardTab[]
  contextControls?: ReactNode
  filterControls?: ReactNode
  freshnessLabel: ReactNode
  primaryAction?: { label: string; to?: string; onClick?: () => void; disabled?: boolean; title?: string } | null
  secondaryActions?: ReactNode
  onRefresh: () => void
  refreshing: boolean
  metrics: MetricProps[]
  /** Draw the KPI row as placeholders rather than collapsing it to nothing. */
  metricsLoading?: boolean
  metricSkeletons?: number
  /** The faint counter illustration behind the heading. */
  heroArt?: boolean
  heroQuote?: ReactNode
  /** The intelligence strip between the heading and the switcher. */
  pulse?: ReactNode
  children: ReactNode
}) {
  const activeLabel = visibleTabs.find((tab) => tab.id === activeDashboard)?.label

  return (
    <main className="pos-workspace">
      <header className={heroArt ? 'pos-page-header pos-page-header--hero' : 'pos-page-header'}>
        <div className="pos-page-header__copy">
          <p className="pos-eyebrow">AICOUNTLY POS</p>
          <h1>{title}</h1>
          <p className="pos-description">{description}</p>
        </div>

        {(heroArt || heroQuote) && (
          <div className="pos-hero__aside">
            {heroArt && <CounterMark />}
            {heroQuote && <p className="pos-hero__quote">{heroQuote}</p>}
          </div>
        )}

        <div className="pos-actions">
          {secondaryActions}
          <button
            type="button"
            className="pos-button pos-button--secondary"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshMark spinning={refreshing} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {primaryAction &&
            (primaryAction.to && !primaryAction.disabled ? (
              <Link className="pos-button pos-button--primary" to={primaryAction.to} title={primaryAction.title}>
                <PlayMark />
                {primaryAction.label}
              </Link>
            ) : (
              <button
                type="button"
                className="pos-button pos-button--primary"
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
                title={primaryAction.title}
              >
                <PlayMark />
                {primaryAction.label}
              </button>
            ))}
        </div>
      </header>

      {pulse}

      {contextControls && <div className="pos-context">{contextControls}</div>}

      <nav className="pos-dashboard-nav" aria-label="POS dashboards">
        {visibleTabs.map((tab) => (
          <Link
            key={tab.id}
            to={tab.path}
            className="pos-dashboard-nav__item"
            aria-current={activeDashboard === tab.id ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="pos-filterbar">
        <div className="pos-filterbar__controls">{filterControls}</div>
        <span className="pos-muted pos-filterbar__freshness" role="status" aria-live="polite">
          {freshnessLabel}
        </span>
      </div>

      {metricsLoading ? (
        <section className="pos-metrics" aria-label={`${activeLabel ?? title} key metrics, loading`} aria-busy="true">
          {Array.from({ length: metricSkeletons }, (_, i) => (
            <div key={i} className="pos-metric pos-metric--skeleton">
              <WidgetSkeleton rows={3} height={16} />
            </div>
          ))}
        </section>
      ) : (
        metrics.length > 0 && (
          <section className="pos-metrics" aria-label={`${activeLabel ?? title} key metrics`}>
            {metrics.map((metric) => (
              <MetricCard key={metric.id} {...metric} />
            ))}
          </section>
        )
      )}

      <div className="pos-dashboard-content">{children}</div>
    </main>
  )
}

/** Two glyphs the header buttons use. Inline, because two icons is not a dependency. */
function RefreshMark({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? 'pos-glyph pos-glyph--spin' : 'pos-glyph'}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
    >
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M13.8 2.2v3.2h-3.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlayMark() {
  return (
    <svg className="pos-glyph" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M5.4 3.6 12 8l-6.6 4.4z" fill="currentColor" />
    </svg>
  )
}
