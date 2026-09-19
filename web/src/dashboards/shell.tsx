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

export interface MetricProps {
  id: string
  label: string
  value: string | null
  /** The one line that says what the number is, under it. */
  context?: string
  comparison?: { label: string; direction: 'up' | 'down' | 'flat' } | null
  /** Where the metric drills into. A metric with no detail view is not a button. */
  href?: string
  onOpen?: () => void
}

export function MetricCard({ label, value, context, comparison, href, onOpen }: MetricProps) {
  const body = (
    <>
      <span className="pos-metric__label">{label}</span>
      <strong className="pos-metric__value">{value ?? '—'}</strong>
      {comparison && (
        <span
          className={`pos-metric__comparison${
            comparison.direction === 'flat' ? '' : ` pos-metric__comparison--${comparison.direction}`
          }`}
        >
          {/* The arrow is redundant with the words, on purpose. */}
          {comparison.direction === 'up' ? '▲' : comparison.direction === 'down' ? '▼' : '■'}{' '}
          {comparison.label}
        </span>
      )}
      {context && <span className="pos-muted">{context}</span>}
    </>
  )

  const description = `${label}: ${value ?? 'Unavailable'}${comparison ? `, ${comparison.label}` : ''}`

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
  children,
}: {
  loading: boolean
  error: string | null
  empty?: boolean
  emptyTitle?: string
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) {
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
 * The switcher between the five boards.
 *
 * Extracted so a board that lays its own page out — Controls does — keeps the
 * same switcher rather than drawing a second one that drifts. The shell below
 * renders this; nothing else about it changed.
 */
export function DashboardTabs({ tabs, active }: { tabs: DashboardTab[]; active: string }) {
  return (
    <nav className="pos-dashboard-nav" aria-label="POS dashboards">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.path}
          className="pos-dashboard-nav__item"
          aria-current={active === tab.id ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
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
  children,
}: {
  title: string
  description: string
  activeDashboard: string
  visibleTabs: DashboardTab[]
  contextControls?: ReactNode
  filterControls?: ReactNode
  freshnessLabel: ReactNode
  primaryAction?: { label: string; to?: string; onClick?: () => void; disabled?: boolean } | null
  secondaryActions?: ReactNode
  onRefresh: () => void
  refreshing: boolean
  metrics: MetricProps[]
  children: ReactNode
}) {
  const activeLabel = visibleTabs.find((tab) => tab.id === activeDashboard)?.label

  return (
    <main className="pos-workspace">
      <header className="pos-page-header">
        <div style={{ minWidth: 0 }}>
          <p className="pos-eyebrow">AICOUNTLY POS</p>
          <h1>{title}</h1>
          <p className="pos-description">{description}</p>
        </div>

        <div className="pos-actions">
          {secondaryActions}
          <button
            type="button"
            className="pos-button pos-button--secondary"
            onClick={onRefresh}
            disabled={refreshing}
          >
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

      <DashboardTabs tabs={visibleTabs} active={activeDashboard} />

      <div className="pos-filterbar">
        <div className="pos-filterbar__controls">{filterControls}</div>
        <span className="pos-muted" role="status" aria-live="polite">
          {freshnessLabel}
        </span>
      </div>

      {metrics.length > 0 && (
        <section className="pos-metrics" aria-label={`${activeLabel ?? title} key metrics`}>
          {metrics.map((metric) => (
            <MetricCard key={metric.id} {...metric} />
          ))}
        </section>
      )}

      <div className="pos-dashboard-content">{children}</div>
    </main>
  )
}
