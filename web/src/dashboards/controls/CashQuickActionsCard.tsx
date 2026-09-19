/**
 * Quick Actions — six shortcuts into workflows that already exist.
 *
 * NOTHING HERE IS A NEW BUSINESS FLOW. Open a till and Close the shift go to
 * the screens that own those actions, because closing a drawer means counting
 * it and counting it is a form on the till. The three cash actions open the
 * drawer sheet, which posts to the same `v1/shifts/{id}/drawer` endpoint a
 * cashier uses.
 *
 * AN ACTION THE SERVER WOULD REFUSE IS NOT SHOWN. Permission decides whether a
 * tile is rendered at all, matching how the rest of POS hides what a person may
 * not do rather than teaching them to press something that 403s.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Zap } from 'lucide-react'
import { ControlCard } from './primitives'

export type QuickActionTone = 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'slate'

export interface QuickAction {
  id: string
  label: string
  tone: QuickActionTone
  icon: ReactNode
  to?: string
  onClick?: () => void
  disabled?: boolean
  /** Why it is disabled. Shown as the tooltip, never as a silent dead button. */
  hint?: string
  shortcut?: string
}

export function QuickActionButton({ action }: { action: QuickAction }) {
  const className = `cc-quick__item cc-quick__item--${action.tone}`

  const body = (
    <>
      <span aria-hidden>{action.icon}</span>
      <span>
        {action.label}
        {action.shortcut && <span className="cc-shortcut">{action.shortcut}</span>}
      </span>
    </>
  )

  if (action.to && !action.disabled) {
    return (
      <Link className={className} to={action.to} title={action.hint}>
        {body}
      </Link>
    )
  }

  return (
    <button type="button" className={className} onClick={action.onClick} disabled={action.disabled} title={action.hint}>
      {body}
    </button>
  )
}

export function CashQuickActionsCard({ actions }: { actions: QuickAction[] }) {
  return (
    <ControlCard title="Quick actions" icon={<Zap size={15} />} flush className="cc-quick-card">
      <div className="cc-quick">
        {actions.map((action) => (
          <QuickActionButton key={action.id} action={action} />
        ))}
      </div>
    </ControlCard>
  )
}
