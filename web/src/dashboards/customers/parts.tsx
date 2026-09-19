/**
 * The small pieces the customers screen repeats: a standing badge, a name
 * disc, the guided empty state, and the skeletons that hold a card's shape
 * while its figures are on their way.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { StatusBadge } from '../shell'
import type { CustomerSummary, CustomerType } from '../types'
import { CUSTOMER_TYPE_LABEL, CUSTOMER_TYPE_TONE } from './constants'

/**
 * What standing a customer is in.
 *
 * The word is the badge. Nothing on this screen asks anyone to know that amber
 * means slipping away, which is the same rule the rest of the product follows.
 */
export function CustomerTypeBadge({ type }: { type: CustomerType }) {
  return <StatusBadge tone={CUSTOMER_TYPE_TONE[type]}>{CUSTOMER_TYPE_LABEL[type]}</StatusBadge>
}

/** A name that may not exist. Said once, here, so every caller says it the same way. */
export function customerLabel(customer: Pick<CustomerSummary, 'name' | 'account_id'>): string {
  const name = customer.name?.trim()

  return name && name !== '' ? name : 'Unnamed customer'
}

/**
 * Initials, or a fallback mark.
 *
 * A customer with no name gets a neutral disc rather than a letter guessed out
 * of an account number.
 */
export function CustomerAvatar({ name }: { name: string | null }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span className="cg-avatar" aria-hidden>
      {initials === '' ? '—' : initials}
    </span>
  )
}

/** A shimmering placeholder of a given shape. Never a spinner, never a blank card. */
export function Shimmer({ width, height = 14, radius = 6 }: { width: string | number; height?: number; radius?: number }) {
  return <span className="cg-shimmer" style={{ width, height, borderRadius: radius }} aria-hidden />
}

export function KpiSkeleton({ cards = 5 }: { cards?: number }) {
  return (
    <div className="cg-kpis" aria-hidden>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="cg-kpi cg-kpi--loading">
          <Shimmer width={40} height={40} radius={12} />
          <div className="cg-kpi__body">
            <Shimmer width="58%" height={11} />
            <Shimmer width="42%" height={26} />
            <Shimmer width="72%" height={10} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function PanelSkeleton({ lines = 4, chart = false }: { lines?: number; chart?: boolean }) {
  return (
    <div className="cg-skeleton" aria-hidden>
      {chart && <Shimmer width="100%" height={180} radius={12} />}
      {Array.from({ length: lines }, (_, i) => (
        <Shimmer key={i} width={`${92 - i * 11}%`} height={12} />
      ))}
    </div>
  )
}

export function CustomerTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="cg-skeleton cg-skeleton--table" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="cg-skeleton__row">
          <Shimmer width={32} height={32} radius={16} />
          <Shimmer width="26%" height={13} />
          <Shimmer width="18%" height={13} />
          <Shimmer width="12%" height={13} />
          <Shimmer width="14%" height={13} />
        </div>
      ))}
    </div>
  )
}

/**
 * Nothing in this period — and what to do about it.
 *
 * The old screen said "No sales in this period" across an otherwise empty page.
 * The period is one of several reasons a merchant sees nothing here, and the
 * most common one is not the period at all: it is that nobody is attaching a
 * customer at the till. So the routes out are offered explicitly.
 */
export function CustomerEmptyState({
  title,
  children,
  actions,
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="cg-empty">
      <span className="cg-empty__mark" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="cg-empty__actions">{actions}</div>}
    </div>
  )
}

/** A widget that failed on its own, without taking the page with it. */
export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="cg-panel-error" role="alert">
      <strong>Could not load this</strong>
      <p>{message}</p>
      <button type="button" className="pos-button pos-button--small pos-button--secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

/** A link styled as one of the screen's cards. */
export function CardLink({
  to,
  tone,
  icon,
  title,
  description,
}: {
  to: string
  tone: string
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <Link className="cg-action" to={to}>
      <span className={`cg-action__icon cg-action__icon--${tone}`} aria-hidden>
        {icon}
      </span>
      <span className="cg-action__text">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </Link>
  )
}
