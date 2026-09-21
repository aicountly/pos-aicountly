/**
 * The strip along the bottom.
 *
 * Three states off three thresholds over counts already on the screen, and it
 * says which count it is reacting to. There is no model here and it does not
 * imply one: POS has no AI service, so nothing on this bar is dressed up as a
 * recommendation.
 */

import { memo } from 'react'
import { Link } from 'react-router-dom'
import { CircleCheck, TriangleAlert, Zap } from 'lucide-react'
import type { KitchenHealth } from '../types'

export const KitchenHealthBar = memo(function KitchenHealthBar({
  health,
  reportHref,
}: {
  health: KitchenHealth
  /** Null when this role cannot open the board the link goes to. */
  reportHref: string | null
}) {
  const Icon = health.level === 'critical' ? TriangleAlert : health.level === 'busy' ? Zap : CircleCheck

  return (
    <div className={`kds-health kds-health--${health.level}`} role="status" aria-live="polite">
      <div className="kds-health__body">
        <Icon size={18} aria-hidden style={{ flexShrink: 0 }} />
        <span className="kds-health__text">
          <strong>{health.title}</strong>
          <span>{health.detail}</span>
        </span>
      </div>

      {/* The kitchen's numbers for the day live on the Restaurant board, which
          counts them server-side. This links there rather than growing a
          second, thinner report on this screen — and it is absent, rather than
          present and refused, for a role that cannot open that board. */}
      {reportHref && (
        <Link className="kds-col__link" to={reportHref} style={{ textDecoration: 'none', flexShrink: 0 }}>
          View daily report →
        </Link>
      )}
    </div>
  )
})
