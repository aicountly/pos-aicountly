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
import { RefreshCw } from 'lucide-react'

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

/**
 * The tint a metric card carries.
 *
 * Decoration that groups related figures — never the meaning. Every card still
 * states its label, its figure and its direction in words, so a row that is all
 * one colour to a viewer who cannot separate the hues reads exactly the same.
 */
export type MetricTone = 'plain' | 'green' | 'blue' | 'orange' | 'purple' | 'cyan'

export interface MetricProps {
  id: string
  label: string
  value: string | null
  /** The one line that says what the number is, under it. */
  context?: ReactNode
  /**
   * `direction` is which way the figure moved; `tone` is whether that is good
   * news. They are separate because they disagree: sales up is good and serve
   * time up is not, and colouring by direction alone paints a slower kitchen
   * green.
   */
  comparison?: {
    label: string
    direction: 'up' | 'down' | 'flat'
    tone?: 'good' | 'bad' | 'neutral'
  } | null
  /** Where the metric drills into. A metric with no detail view is not a button. */
  href?: string
  onOpen?: () => void
  tone?: MetricTone
  icon?: ReactNode
  /** A share of something whole, 0-100. `label` is what the bar means, in words. */
  progress?: { value: number; label: string } | null
  /** The sentence that says exactly what this figure counts. Reaches AT and the pointer. */
  hint?: string
}

export function MetricCard({
  label,
  value,
  context,
  comparison,
  href,
  onOpen,
  tone = 'plain',
  icon,
  progress,
  hint,
}: MetricProps) {
  const body = (
    <>
      <span className="pos-metric__head">
        {icon && (
          <span className="pos-metric__icon" aria-hidden>
            {icon}
          </span>
        )}
        <span className="pos-metric__label">{label}</span>
      </span>
      <strong className="pos-metric__value">{value ?? '—'}</strong>
      {comparison && (
        <span className={`pos-metric__comparison${comparisonModifier(comparison)}`}>
          {/* The arrow is redundant with the words, on purpose. */}
          {comparison.direction === 'up' ? '▲' : comparison.direction === 'down' ? '▼' : '■'}{' '}
          {comparison.label}
        </span>
      )}
      {context && <span className="pos-muted pos-metric__context">{context}</span>}
      {progress && (
        /* The figure beside it is the data; this is the same share drawn. */
        <span className="pos-metric__progress" aria-hidden>
          <span style={{ width: `${Math.max(0, Math.min(100, progress.value))}%` }} />
        </span>
      )}
    </>
  )

  const description = [
    `${label}: ${value ?? 'Unavailable'}`,
    comparison?.label,
    progress?.label,
    hint,
  ]
    .filter(Boolean)
    .join('. ')

  const className = `pos-metric${tone === 'plain' ? '' : ` pos-metric--${tone}`}`

  if (href) {
    return (
      <Link className={className} to={href} title={hint} aria-label={`${description}. View details`}>
        {body}
      </Link>
    )
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onOpen}
      disabled={!onOpen}
      title={hint}
      aria-label={onOpen ? `${description}. View details` : description}
    >
      {body}
    </button>
  )
}

/** Good news is green and bad news is red, whichever way the arrow points. */
function comparisonModifier(comparison: NonNullable<MetricProps['comparison']>): string {
  if (comparison.tone === 'neutral' || comparison.direction === 'flat') return ''
  if (comparison.tone) return ` pos-metric__comparison--${comparison.tone === 'good' ? 'up' : 'down'}`

  return ` pos-metric__comparison--${comparison.direction}`
}

/**
 * A metric card with no figure in it yet.
 *
 * Shaped like the card it becomes so the row does not jump when the numbers
 * land. `aria-hidden` because the live region on the body already says the
 * board is loading, and eight "loading" announcements is worse than one.
 */
export function MetricSkeleton() {
  return (
    <div className="pos-metric pos-metric--skeleton" aria-hidden>
      <span className="pos-skeleton pos-skeleton--label" />
      <span className="pos-skeleton pos-skeleton--value" />
      <span className="pos-skeleton pos-skeleton--line" />
    </div>
  )
}

/** A block standing in for a panel that has not loaded. */
export function PanelSkeleton({ rows = 3, height = 34 }: { rows?: number; height?: number }) {
  return (
    <div className="pos-stack pos-stack--tight" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="pos-skeleton" style={{ height, borderRadius: 10 }} />
      ))}
    </div>
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
  emptyBody,
  emptyActions,
  skeleton,
  onRetry,
  children,
}: {
  loading: boolean
  error: string | null
  empty?: boolean
  emptyTitle?: string
  emptyBody?: ReactNode
  emptyActions?: ReactNode
  /** The shape of the board, drawn empty, so the page does not jump when it lands. */
  skeleton?: ReactNode
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) {
    if (skeleton) {
      return (
        <>
          <p className="pos-visually-hidden" role="status" aria-live="polite">
            Loading dashboard…
          </p>
          {skeleton}
        </>
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
        <p>{emptyBody ?? 'Choose another period, or open the operation this board is about.'}</p>
        {emptyActions && <div className="pos-actions pos-actions--centred">{emptyActions}</div>}
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

export function PosDashboardShell({
  title,
  description,
  headerIcon,
  activeDashboard,
  visibleTabs,
  contextControls,
  filterControls,
  freshnessLabel,
  statusControl,
  primaryAction,
  secondaryActions,
  onRefresh,
  refreshing,
  metrics,
  metricsSkeleton = 0,
  children,
}: {
  title: string
  description: string
  /** A mark beside the title. Decoration, so it never carries a meaning of its own. */
  headerIcon?: ReactNode
  activeDashboard: string
  visibleTabs: DashboardTab[]
  contextControls?: ReactNode
  filterControls?: ReactNode
  freshnessLabel: ReactNode
  /** An operational state that belongs beside the actions rather than in them. */
  statusControl?: ReactNode
  primaryAction?: { label: string; to?: string; onClick?: () => void; disabled?: boolean } | null
  secondaryActions?: ReactNode
  onRefresh: () => void
  refreshing: boolean
  metrics: MetricProps[]
  /** How many placeholder cards to hold the row open with while the figures load. */
  metricsSkeleton?: number
  children: ReactNode
}) {
  const activeLabel = visibleTabs.find((tab) => tab.id === activeDashboard)?.label

  return (
    <main className="pos-workspace">
      <header className="pos-page-header">
        <div className="pos-page-header__identity">
          {headerIcon && (
            <span className="pos-page-header__mark" aria-hidden>
              {headerIcon}
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <p className="pos-eyebrow">AICOUNTLY POS</p>
            <h1>{title}</h1>
            <p className="pos-description">{description}</p>
          </div>
        </div>

        <div className="pos-actions">
          {statusControl}
          {secondaryActions}
          <button
            type="button"
            className="pos-button pos-button--secondary"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={15} className={refreshing ? 'pos-spin' : undefined} aria-hidden />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {primaryAction &&
            (primaryAction.to ? (
              <Link className="pos-button pos-button--primary" to={primaryAction.to}>
                {primaryAction.label}
              </Link>
            ) : (
              <button
                type="button"
                className="pos-button pos-button--primary"
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
              >
                {primaryAction.label}
              </button>
            ))}
        </div>
      </header>

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
        <span className="pos-muted" role="status" aria-live="polite">
          {freshnessLabel}
        </span>
      </div>

      {metrics.length > 0 ? (
        <section className="pos-metrics" aria-label={`${activeLabel ?? title} key metrics`}>
          {metrics.map((metric) => (
            <MetricCard key={metric.id} {...metric} />
          ))}
        </section>
      ) : (
        metricsSkeleton > 0 && (
          <section className="pos-metrics" aria-hidden>
            {Array.from({ length: metricsSkeleton }, (_, index) => (
              <MetricSkeleton key={index} />
            ))}
          </section>
        )
      )}

      <div className="pos-dashboard-content">{children}</div>
    </main>
  )
}
