/**
 * Controls & Alerts — the exceptions, and nothing else.
 *
 * EVERY ROW IS A RULE. Each one is a threshold or a state read straight off the
 * board: a closed drawer that is out and unsigned, a sale another product
 * refused, a shift nobody closed. None of it is inferred, scored or predicted.
 * POS has no AI configured, and a control centre that dressed a count up as an
 * insight would be untrustworthy in the one place it must not be.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, CircleAlert, Info, ShieldCheck, TriangleAlert } from 'lucide-react'
import { count, sinceLabel } from '../format'
import { ControlCard } from './primitives'
import type { AlertSeverity, ControlAlert } from './derive'

const ICONS: Record<AlertSeverity, typeof Info> = {
  critical: CircleAlert,
  warning: TriangleAlert,
  info: Info,
  success: CheckCircle2,
}

const SEVERITY_WORD: Record<AlertSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'For information',
  success: 'All clear',
}

export function ControlAlertRow({ alert, onFocusSession }: { alert: ControlAlert; onFocusSession: (id: number) => void }) {
  const Icon = ICONS[alert.severity]

  const body = (
    <>
      <span className="cc-alert__icon" aria-hidden>
        <Icon size={15} />
      </span>
      <span className="cc-alert__body">
        <span className="cc-alert__title" title={alert.title}>
          <span className="pos-visually-hidden">{SEVERITY_WORD[alert.severity]}: </span>
          {alert.title}
        </span>
        <span className="cc-alert__detail" title={alert.detail}>
          {alert.detail}
        </span>
      </span>
      <time className="cc-alert__time" dateTime={alert.at ?? undefined}>
        {alert.at ? sinceLabel(alert.at) : 'Now'}
      </time>
    </>
  )

  const className = `cc-alert cc-alert--${alert.severity}`

  if (alert.action?.kind === 'route') {
    return (
      <Link className={className} to={alert.action.to}>
        {body}
      </Link>
    )
  }

  if (alert.action?.kind === 'anchor') {
    return (
      <a className={className} href={`#${alert.action.id}`}>
        {body}
      </a>
    )
  }

  if (alert.action?.kind === 'session') {
    const sessionId = alert.action.sessionId

    return (
      <button type="button" className={className} onClick={() => onFocusSession(sessionId)}>
        {body}
      </button>
    )
  }

  return <div className={className}>{body}</div>
}

const PREVIEW = 5

export function ControlsAlertsCard({
  alerts,
  onFocusSession,
}: {
  alerts: ControlAlert[]
  onFocusSession: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? alerts : alerts.slice(0, PREVIEW)
  const critical = alerts.filter((alert) => alert.severity === 'critical').length

  return (
    <ControlCard
      title="Controls & alerts"
      icon={<ShieldCheck size={15} />}
      flush
      tools={
        <>
          {critical > 0 && (
            <span className="cc-pill cc-pill--danger">
              {count(critical)} critical
            </span>
          )}
          {alerts.length > PREVIEW && (
            <button type="button" className="cc-link" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
              {expanded ? 'Show fewer' : `View all ${count(alerts.length)} →`}
            </button>
          )}
        </>
      }
    >
      <div className="cc-alerts">
        {visible.map((alert) => (
          <ControlAlertRow key={alert.id} alert={alert} onFocusSession={onFocusSession} />
        ))}
      </div>
    </ControlCard>
  )
}
