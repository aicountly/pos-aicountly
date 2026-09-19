/**
 * The furniture the Controls command centre is built from.
 *
 * Small, unopinionated pieces: a card, a pill, the three states a widget can be
 * in, and a skeleton that mirrors the layout rather than a spinner that hides
 * it. Everything else on this board is a real widget with a real question to
 * answer.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { CircleAlert, Inbox, RefreshCw, TriangleAlert } from 'lucide-react'
import { trackEvent } from '../../utils/analytics'

export type PillTone = 'success' | 'info' | 'warning' | 'danger' | 'purple' | 'neutral'

/**
 * A status, in words.
 *
 * The dot is decoration. Nothing on this board says anything with colour alone
 * — the same rule the rest of POS follows, for the same reason.
 */
export function Pill({ tone = 'neutral', dot = false, children }: { tone?: PillTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`cc-pill cc-pill--${tone}`}>
      {dot && <span className="cc-pill__dot" aria-hidden />}
      {children}
    </span>
  )
}

export function ControlCard({
  id,
  title,
  icon,
  tools,
  flush = false,
  labelledBy,
  className,
  children,
}: {
  id?: string
  title: string
  icon?: ReactNode
  tools?: ReactNode
  flush?: boolean
  labelledBy?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} className={className ? `cc-card ${className}` : 'cc-card'} aria-label={labelledBy ? undefined : title}>
      <header className="cc-card__header">
        <div className="cc-card__title">
          {icon && (
            <span className="cc-card__icon" aria-hidden>
              {icon}
            </span>
          )}
          <h2>{title}</h2>
        </div>
        {tools && <div className="cc-card__tools">{tools}</div>}
      </header>
      <div className={flush ? 'cc-card__body cc-card__body--flush' : 'cc-card__body'}>{children}</div>
    </section>
  )
}

/**
 * A widget that succeeded and has nothing to show.
 *
 * Deliberately not the same component as the error state: "no cash moved today"
 * and "we could not ask" are different facts and a screen that renders them
 * identically is lying about one of them.
 */
export function WidgetEmptyState({
  title,
  children,
  tone = 'neutral',
  action,
}: {
  title: string
  children?: ReactNode
  tone?: 'neutral' | 'success'
  action?: ReactNode
}) {
  return (
    <div className={tone === 'success' ? 'cc-state cc-state--success' : 'cc-state'}>
      <span className="cc-state__icon" aria-hidden>
        <Inbox size={18} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function WidgetErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="cc-state cc-state--danger" role="alert">
      <span className="cc-state__icon" aria-hidden>
        <TriangleAlert size={18} />
      </span>
      <strong>{title}</strong>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="pos-button pos-button--secondary pos-button--small" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden /> Try again
        </button>
      )}
    </div>
  )
}

/**
 * One widget failing must not take the board with it.
 *
 * A close-out screen is read under time pressure; a manager who loses the whole
 * page because one card met an unexpected shape has lost the shift register,
 * the alerts and the drawer total as well. This catches the render, keeps the
 * rest of the board on screen, and reports through the analytics channel the
 * app already has.
 *
 * Retry re-mounts the subtree by changing its key: clearing the error alone
 * would replay the same render against the same props and fail identically.
 */
export class WidgetBoundary extends Component<
  { title: string; children: ReactNode },
  { error: Error | null; attempt: number }
> {
  state: { error: Error | null; attempt: number } = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Controls widget failed: ${this.props.title}`, error, info.componentStack)
    trackEvent('pos_widget_error', { widget: this.props.title, message: error.message })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="cc-card">
          <WidgetErrorState
            title={`Unable to load ${this.props.title.toLowerCase()}`}
            message={this.state.error.message}
            onRetry={() => this.setState((current) => ({ error: null, attempt: current.attempt + 1 }))}
          />
        </div>
      )
    }

    // A Fragment, not a wrapper element: the card has to stay a direct child
    // of the grid it is laid out by.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}

export function Skeleton({ width, height = 12, radius }: { width?: number | string; height?: number; radius?: number }) {
  return (
    <span
      className="cc-skeleton"
      style={{ display: 'block', width: width ?? '100%', height, borderRadius: radius }}
      aria-hidden
    />
  )
}

function SkeletonCard({ rows = 5 }: { rows?: number }) {
  return (
    <div className="cc-card">
      <div className="cc-card__header">
        <Skeleton width={150} height={13} />
      </div>
      <div className="cc-skeleton-rows">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={14} width={index % 3 === 0 ? '92%' : '100%'} />
        ))}
      </div>
    </div>
  )
}

/**
 * The first load, with the shape of the answer already on screen.
 *
 * A skeleton that matches the layout means the page does not jump when the
 * figures land, and a manager watching it knows which widget they are waiting
 * for.
 */
export function ControlsSkeleton() {
  return (
    <div aria-hidden>
      <div className="cc-kpis">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="cc-kpi">
            <Skeleton width={46} height={46} radius={13} />
            <div className="cc-kpi__body" style={{ width: '100%', display: 'grid', gap: 8 }}>
              <Skeleton width="60%" height={10} />
              <Skeleton width="80%" height={20} />
              <Skeleton width="45%" height={9} />
            </div>
          </div>
        ))}
      </div>

      <div className="cc-grid-primary">
        <SkeletonCard rows={6} />
        <SkeletonCard rows={5} />
        <SkeletonCard rows={4} />
      </div>

      <div className="cc-grid-secondary">
        <SkeletonCard rows={5} />
        <SkeletonCard rows={4} />
        <SkeletonCard rows={3} />
      </div>
    </div>
  )
}

/** A board-wide failure, rendered as a card rather than a bare sentence. */
export function BoardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="cc-card" role="alert">
      <div className="cc-state cc-state--danger" style={{ padding: '40px 20px' }}>
        <span className="cc-state__icon" aria-hidden>
          <CircleAlert size={18} />
        </span>
        <strong>This board could not be loaded</strong>
        <p>{message}</p>
        <button type="button" className="pos-button pos-button--primary pos-button--small" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden /> Try again
        </button>
      </div>
    </div>
  )
}
