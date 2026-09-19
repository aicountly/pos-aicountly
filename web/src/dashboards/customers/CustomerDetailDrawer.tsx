/**
 * The side panel, for a customer or for a suggestion.
 *
 * IT FETCHES NOTHING. Everything shown about a customer is already in the row
 * that was clicked, so opening the panel costs no round trip and closing it
 * loses nothing. When POS grows a real customer profile — bills, loyalty, notes
 * — this is where that fetch goes, behind the open, not before it.
 *
 * The panel is a dialog: Escape closes it, the backdrop closes it, focus moves
 * into it on open and the heading names it.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, X } from 'lucide-react'
import { count, dateOnly, daysSince, money, percent } from '../format'
import { StatusBadge, Unavailable } from '../shell'
import type { CustomersBoard, CustomerSummary } from '../types'
import { CustomerAvatar, CustomerTypeBadge, customerLabel } from './parts'

type Suggestion = CustomersBoard['suggestions']['items'][number]

function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Move focus in, so the next Tab is inside the panel rather than back in
    // the table behind it.
    panel.current?.focus()

    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="cg-drawer-root">
      <div className="cg-drawer__scrim" onClick={onClose} aria-hidden />
      <div
        className="cg-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="cg-drawer__head">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close this panel">
            <X size={17} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="cg-drawer__body">{children}</div>
        {footer && <footer className="cg-drawer__foot">{footer}</footer>}
      </div>
    </div>
  )
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="cg-fact">
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {note && <small>{note}</small>}
      </dd>
    </div>
  )
}

export function CustomerDetailDrawer({
  customer,
  inactiveDays,
  retailHref,
  onClose,
}: {
  customer: CustomerSummary
  inactiveDays: number
  retailHref: string
  onClose: () => void
}) {
  const quiet = daysSince(customer.last_at)
  const lapsed = quiet !== null && quiet >= inactiveDays

  return (
    <Drawer
      title={customerLabel(customer)}
      onClose={onClose}
      footer={
        <Link className="pos-button pos-button--secondary pos-button--small" to={retailHref}>
          Counter activity <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
        </Link>
      }
    >
      <div className="cg-drawer__identity">
        <CustomerAvatar name={customer.name} />
        <div>
          <strong>{customerLabel(customer)}</strong>
          <span className="pos-muted">Books account #{customer.account_id}</span>
        </div>
        <CustomerTypeBadge type={customer.customer_type} />
      </div>

      <dl className="cg-facts">
        <Fact
          label="Mobile"
          value={customer.mobile_masked ?? 'None on file'}
          note={customer.mobile_masked ? 'Last four digits. The whole number is on the till.' : undefined}
        />
        <Fact label="First bought here" value={dateOnly(customer.first_at)} />
        <Fact
          label="Last visit"
          value={dateOnly(customer.last_at)}
          note={quiet === null ? undefined : `${count(quiet)} day${quiet === 1 ? '' : 's'} ago`}
        />
        <Fact label="Outlet last bought at" value={customer.outlet_name ?? 'Unknown'} />
        <Fact label="Visits" value={count(customer.visits)} note="Completed bills on this POS" />
        <Fact label="Total spent" value={money(customer.spend)} />
        <Fact label="Average bill" value={money(customer.average_bill)} />
        <Fact
          label="In the chosen period"
          value={`${count(customer.window_visits)} visit${customer.window_visits === 1 ? '' : 's'}`}
          note={money(customer.window_spend)}
        />
      </dl>

      {lapsed && (
        <Unavailable title="This customer has gone quiet">
          No bill for {count(quiet)} days, past the {inactiveDays}-day mark this board counts as lapsed.
        </Unavailable>
      )}

      <Unavailable muted title="What POS cannot show here">
        There is no loyalty balance, no tag and no note against a customer in POS, and no bill-by-bill history on this
        panel — the individual bills are on the counter activity board. POS holds no email address either.
      </Unavailable>
    </Drawer>
  )
}

export function InsightDetailDrawer({
  item,
  segments,
  onClose,
  onReview,
}: {
  item: Suggestion
  segments: CustomersBoard['segments']
  onClose: () => void
  onReview: (() => void) | null
}) {
  const segment = segments.segments.find((s) => s.key === item.segment) ?? null

  return (
    <Drawer
      title={item.title}
      onClose={onClose}
      footer={
        onReview && (
          <button type="button" className="pos-button pos-button--primary pos-button--small" onClick={onReview}>
            {item.action_label ?? 'Review these customers'}
          </button>
        )
      }
    >
      <div className="cg-drawer__identity">
        <StatusBadge tone="neutral">Rule-based alert</StatusBadge>
        <span className="pos-muted">{item.period_label}</span>
      </div>

      <p className="cg-drawer__lede">{item.explanation}</p>

      <dl className="cg-facts">
        <Fact label="What fired this" value={item.definition} />
        <Fact
          label="Customers behind it"
          value={count(item.supporting_customers)}
          note={
            segment && segment.share_pc !== null
              ? `${percent(segment.share_pc, 0)} of identified customers`
              : undefined
          }
        />
        {segment && <Fact label="Their spend on this POS" value={money(segment.spend)} />}
      </dl>

      <Unavailable muted title="This is a threshold check, not a prediction">
        It counted rows and compared the count with a number. Nothing here estimates what a customer will do next, and
        POS has no model configured to try.
      </Unavailable>
    </Drawer>
  )
}
