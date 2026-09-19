/**
 * The shared furniture every POS dashboard is built from.
 *
 * One shell, five bodies. What is shared is the page header, the switcher, the
 * filter bar, the freshness line and the metric row; what differs is the panels
 * underneath, and those are real components per board rather than one chart
 * rendered five times under different headings.
 */

import { Component, useEffect, useId, useRef, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'

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
  /**
   * How it moved, and whether that is good news.
   *
   * `direction` is the MOVEMENT and drives the arrow. `tone` is the MEANING and
   * drives the colour, and defaults to up-is-good. They are two facts because
   * on Returns they disagree: refunds rising is an increase and a problem, and
   * a card that renders a red ▼ beside "+28.4%" is a card that reads as
   * "down plus twenty-eight percent" and stops a reader in their tracks.
   */
  comparison?: { label: string; direction: 'up' | 'down' | 'flat'; tone?: 'good' | 'bad' | 'neutral' } | null
  /** Where the metric drills into. A metric with no detail view is not a button. */
  href?: string
  onOpen?: () => void

  /** A small mark beside the label. Decoration — the label is the label. */
  icon?: ReactNode
  /** Which tint the icon tile and the spark take. */
  tone?: 'brand' | 'info' | 'danger' | 'warning' | 'neutral'
  /** The shape of the recent history, drawn small. Never the only statement of it. */
  spark?: ReactNode
  /** A meter, for a metric that is a fraction of something. */
  progress?: { value: number; max: number; label: string } | null
  /**
   * What this figure actually counts.
   *
   * On the title attribute AND in the accessible name, because a definition
   * that only a mouse can reach is a definition most of the shop never sees.
   */
  hint?: string
}

/** Up is good unless the caller says otherwise. */
function comparisonTone(comparison: NonNullable<MetricProps['comparison']>): 'good' | 'bad' | 'neutral' {
  if (comparison.tone) return comparison.tone
  if (comparison.direction === 'flat') return 'neutral'

  return comparison.direction === 'up' ? 'good' : 'bad'
}

/**
 * One headline figure.
 *
 * The order is fixed across all five boards: what it is, what it is, how it
 * moved, what it counts. The icon, the spark and the meter are additions to
 * that order and never replacements for part of it — a card whose movement is
 * only in the sparkline is a card that says nothing to a screen reader, and
 * removing the context line to make room for a picture is the same mistake with
 * better art.
 */
export function MetricCard({
  label,
  value,
  context,
  comparison,
  href,
  onOpen,
  icon,
  tone = 'brand',
  spark,
  progress,
  hint,
}: MetricProps) {
  const body = (
    <>
      <span className="pos-metric__head">
        <span className="pos-metric__label">{label}</span>
        {icon && (
          <span className={`pos-metric__icon pos-metric__icon--${tone}`} aria-hidden>
            {icon}
          </span>
        )}
      </span>

      <strong className="pos-metric__value">{value ?? '—'}</strong>

      <span className="pos-metric__foot">
        {comparison && (
          <span
            className={`pos-metric__comparison${
              comparisonTone(comparison) === 'neutral' ? '' : ` pos-metric__comparison--${comparisonTone(comparison)}`
            }`}
          >
            {/* The arrow is redundant with the words, on purpose. */}
            {comparison.direction === 'up' ? '▲' : comparison.direction === 'down' ? '▼' : '■'}{' '}
            {comparison.label}
          </span>
        )}
        {context && <span className="pos-muted pos-metric__context">{context}</span>}
      </span>

      {progress && (
        <span className="pos-metric__meter">
          <span
            className={`pos-metric__meter-fill pos-metric__meter-fill--${tone}`}
            style={{ width: `${progress.max > 0 ? Math.min(100, Math.max(0, (progress.value / progress.max) * 100)) : 0}%` }}
          />
        </span>
      )}

      {spark && <span className="pos-metric__spark">{spark}</span>}
    </>
  )

  const description = [
    `${label}: ${value ?? 'Unavailable'}`,
    comparison ? comparison.label : null,
    progress ? progress.label : null,
    hint,
  ]
    .filter(Boolean)
    .join('. ')

  if (href) {
    return (
      <Link className="pos-metric" to={href} title={hint} aria-label={`${description}. View details`}>
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
      title={hint}
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
  metric?: string | null
  detail?: string | null
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
/**
 * A panel that could not load, without taking the page with it.
 *
 * One widget failing is one widget failing. The rest of the board is still
 * true, so it stays on screen and this sits in the hole.
 */
export function PanelError({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="pos-panel-error" role="alert">
      <strong>{title}</strong>
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
 * One panel failing is one panel failing.
 *
 * A board is eight panels over one response. A panel that throws while
 * rendering — an unexpected null in a row the server has never sent before,
 * a chart handed a NaN — takes the whole React tree down with it and the
 * manager gets a blank page instead of the seven panels that were fine. This
 * catches the throw at the panel, leaves the other seven standing, and says
 * plainly which one is missing rather than quietly rendering nothing.
 *
 * A class component because that is the only thing React lets catch a render
 * error; there is no hook for it.
 */
export class PanelBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Left on the console on purpose: this is a bug in this panel, and the
    // person who has to fix it needs the stack, not a swallowed exception.
    console.error(`Panel "${this.props.title}" failed to render`, error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <section className="pos-panel" aria-label={this.props.title}>
        <header className="pos-panel__header">
          <h2>{this.props.title}</h2>
        </header>
        <div className="pos-panel__body">
          <PanelError
            title="This panel could not be drawn"
            message="The rest of the board is unaffected. Refreshing may clear it; if it does not, the figures behind it need a look."
            onRetry={() => this.setState({ failed: false })}
          />
        </div>
      </section>
    )
  }
}

/**
 * The shape of a card, while its figures are on their way.
 *
 * Shaped like what is coming rather than a spinner in a box, so the page does
 * not jump when the numbers land. It is `aria-hidden` and the live region in
 * DashboardBody does the announcing — a screen reader being read eleven
 * "loading" boxes learns nothing from the tenth.
 */
export function CardSkeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <div className="pos-skeleton" style={height ? { minHeight: height } : undefined} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="pos-skeleton__line" />
      ))}
    </div>
  )
}

/**
 * Loading, error, empty — or the dashboard.
 *
 * `empty` is only ever true when the request SUCCEEDED and returned nothing. A
 * failed request lands on the error branch, because "no sales today" and "we
 * could not ask" must never render as the same screen. Zero is a third thing
 * again and is not this component's business: a board that took ₹0 has data and
 * renders its panels.
 */
export function DashboardBody({
  loading,
  error,
  empty,
  emptyTitle = 'No activity in this period',
  emptyBody = 'Choose another period, or open the operation this board is about.',
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
  /** The shape of what is coming. Without one, a plain status line. */
  skeleton?: ReactNode
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) {
    if (skeleton) {
      return (
        <>
          <p className="pos-visually-hidden" role="status" aria-live="polite">
            Loading the dashboard
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
      <div className="pos-state pos-state--empty">
        <span className="pos-state__mark" aria-hidden>
          <svg viewBox="0 0 48 48" width="52" height="52">
            <rect x="5" y="27" width="8" height="14" rx="2.5" fill="#d8ece0" />
            <rect x="18" y="20" width="8" height="21" rx="2.5" fill="#c3e4cf" />
            <rect x="31" y="11" width="8" height="30" rx="2.5" fill="#a9d8ba" />
          </svg>
        </span>
        <h2>{emptyTitle}</h2>
        <p>{emptyBody}</p>
        {emptyActions && <div className="pos-actions pos-actions--centred">{emptyActions}</div>}
      </div>
    )
  }

  return <>{children}</>
}

/**
 * A side panel for the detail behind a number.
 *
 * ESC closes it, focus moves into it when it opens and returns to whatever
 * opened it when it closes, and the page behind it does not scroll. None of
 * that is decoration: a drawer that traps nothing and returns nothing loses
 * a keyboard user at the bottom of the document.
 */
export function DashboardDrawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const headingId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    panel.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      returnTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="pos-drawer" role="presentation">
      <button type="button" className="pos-drawer__scrim" aria-label="Close this panel" onClick={onClose} />
      <div
        className="pos-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={panel}
      >
        <header className="pos-drawer__header">
          <div style={{ minWidth: 0 }}>
            <h2 id={headingId}>{title}</h2>
            {description && <p className="pos-muted">{description}</p>}
          </div>
          <button type="button" className="pos-drawer__close" onClick={onClose} aria-label="Close this panel">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="pos-drawer__body">{children}</div>
        {footer && <footer className="pos-drawer__footer">{footer}</footer>}
      </div>
    </div>
  )
}

export interface DashboardTab {
  id: string
  label: string
  path: string
  /** A mark beside the label. The label is still the label. */
  icon?: ReactNode
}

export function PosDashboardShell({
  title,
  description,
  activeDashboard,
  visibleTabs,
  contextControls,
  filterControls,
  freshnessLabel,
  heroAside,
  primaryAction,
  secondaryActions,
  onRefresh,
  refreshing,
  metrics,
  metricsLoading = false,
  children,
}: {
  title: string
  description: string
  activeDashboard: string
  visibleTabs: DashboardTab[]
  contextControls?: ReactNode
  filterControls?: ReactNode
  freshnessLabel: ReactNode
  /** The quiet graphic in the top right. Never allowed to outrank the figures. */
  heroAside?: ReactNode
  primaryAction?: { label: string; to?: string; onClick?: () => void; disabled?: boolean } | null
  secondaryActions?: ReactNode
  onRefresh: () => void
  refreshing: boolean
  metrics: MetricProps[]
  /** Draw the metric row as placeholders rather than as nothing. */
  metricsLoading?: boolean
  children: ReactNode
}) {
  const activeLabel = visibleTabs.find((tab) => tab.id === activeDashboard)?.label

  return (
    <main className="pos-workspace">
      <header className="pos-page-header">
        <div className="pos-page-header__titles">
          <p className="pos-eyebrow">AICOUNTLY POS</p>
          <h1>{title}</h1>
          <p className="pos-description">{description}</p>
        </div>

        <div className="pos-page-header__side">
          {heroAside}

          <div className="pos-actions">
            {secondaryActions}
            <button
              type="button"
              className="pos-button pos-button--secondary"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <span className={refreshing ? 'pos-spinner' : 'pos-spinner pos-spinner--idle'} aria-hidden />
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
            {tab.icon && (
              <span className="pos-dashboard-nav__icon" aria-hidden>
                {tab.icon}
              </span>
            )}
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="pos-filterbar">
        <div className="pos-filterbar__controls">{filterControls}</div>
        <div className="pos-filterbar__meta">
          <span className="pos-muted pos-freshness" role="status" aria-live="polite">
            {freshnessLabel}
          </span>
          <button
            type="button"
            className="pos-iconbutton"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={refreshing ? 'Refreshing the dashboard' : 'Refresh the dashboard'}
            title="Refresh (R)"
          >
            <span className={refreshing ? 'pos-spinner' : 'pos-spinner pos-spinner--idle'} aria-hidden />
          </button>
        </div>
      </div>

      {metricsLoading ? (
        <section className="pos-metrics" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="pos-metric pos-metric--placeholder">
              <CardSkeleton lines={3} />
            </div>
          ))}
        </section>
      ) : (
        metrics.length > 0 && (
          <section
            className="pos-metrics"
            aria-label={`${activeLabel ?? title} key metrics`}
            /* Five cards on this board, six on Controls and Restaurant. The
               count drives the track count so the last card is never left
               alone on a row of its own. */
            style={{ '--pos-metric-count': metrics.length } as CSSProperties}
          >
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
