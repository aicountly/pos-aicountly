/**
 * What needs a person: the counted exceptions, and the alert feed.
 */

import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CircleAlert, Info } from 'lucide-react'
import { sinceLabel, titleCase } from '../../format'
import { EmptyState, Panel } from '../../shell'
import type { RetailAlert, RetailBoard } from '../../types'
import type { DashboardFilters } from '../../useDashboard'
import { withFilters } from '../../registry'
import { AttentionRow } from '../common'

export function RetailAttention({ board, filters }: { board: RetailBoard; filters: DashboardFilters }) {
  return (
    <Panel title="Needs a person" description="Counted over the chosen period.">
      <div className="pos-stack pos-stack--tight">
        <AttentionRow
          label="Bills voided before payment"
          value={board.attention.voids}
          tone="warning"
          href={withFilters('/controls', filters, { panel: 'approvals' })}
        />
        <AttentionRow
          label="Sales stuck between products"
          description="Not reached Books or Inventory."
          value={board.attention.stuck}
          tone="danger"
          href={withFilters('/controls', filters, { panel: 'posting' })}
        />
        {board.attention.approvals.map((approval) => (
          <AttentionRow
            key={approval.event_kind}
            label={titleCase(approval.event_kind)}
            value={approval.count}
            tone="info"
            href={withFilters('/controls', filters, { panel: 'approvals' })}
          />
        ))}
      </div>
    </Panel>
  )
}

const ALERT_ICON = {
  critical: CircleAlert,
  warning: AlertTriangle,
  info: Info,
} as const

const ALERT_WORD = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'For information',
} as const

/**
 * The alert feed.
 *
 * Every row is a threshold this POS crossed in its own rows, or what Inventory
 * answered on this request — never a device reporting on itself, because no
 * device in this product does. The severity word is in the row's accessible
 * name as well as its colour, and the time is the time of the thing, not the
 * time the page was drawn.
 */
function AlertRow({ alert }: { alert: RetailAlert }) {
  const Icon = ALERT_ICON[alert.severity] ?? Info

  const body = (
    <>
      <span className="pos-alert__icon" aria-hidden>
        <Icon />
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="pos-alert__title">{alert.title}</span>
        <span className="pos-alert__context">{alert.context}</span>
      </span>
      <time className="pos-alert__at" dateTime={alert.at ?? undefined}>
        {alert.at === null ? '—' : sinceLabel(alert.at)}
      </time>
    </>
  )

  const label = `${ALERT_WORD[alert.severity] ?? 'Alert'}: ${alert.title}. ${alert.context}`

  if (alert.href) {
    return (
      <Link className={`pos-alert pos-alert--${alert.severity}`} to={alert.href} aria-label={label}>
        {body}
      </Link>
    )
  }

  return (
    <div className={`pos-alert pos-alert--${alert.severity}`} role="listitem" aria-label={label}>
      {body}
    </div>
  )
}

export function OperationalAlerts({ board, filters }: { board: RetailBoard; filters: DashboardFilters }) {
  const alerts = board.alerts
  const hidden = alerts.total - alerts.items.length

  return (
    <Panel
      title="Operational alerts"
      action={
        hidden > 0 && (
          <Link
            className="pos-button pos-button--quiet pos-button--small"
            to={withFilters('/controls', filters, { panel: 'posting' })}
          >
            View all {alerts.total} <ArrowRight size={13} aria-hidden />
          </Link>
        )
      }
    >
      {alerts.items.length === 0 ? (
        <EmptyState title="All clear">
          No operational alert needs attention. Nothing is being hidden — no threshold has been crossed.
        </EmptyState>
      ) : (
        <>
          <div className="pos-alerts" role="list">
            {alerts.items.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
          <p className="pos-note">{alerts.note}</p>
        </>
      )}
    </Panel>
  )
}
