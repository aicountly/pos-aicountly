/**
 * The command header: what this screen is, and the one action it exists for.
 *
 * The primary button carries its shortcut on its face. A till is worked with
 * two hands and a scanner, and a shortcut nobody can discover is a shortcut
 * nobody uses.
 */

import { Download, FileText, RotateCcw, Settings as SettingsIcon, ScrollText, Plus } from 'lucide-react'
import { MenuButton, type MenuAction } from './Menu'

export function ReturnsHero({
  canCreate,
  offline,
  onNewReturn,
  onExport,
  onPolicy,
  onSettings,
  onAuditTrail,
}: {
  canCreate: boolean
  offline: boolean
  onNewReturn: () => void
  onExport: () => void
  onPolicy: () => void
  /** Null when this person may not change POS settings. */
  onSettings: (() => void) | null
  /** Null when this person may not see reports, which is what the audit log needs. */
  onAuditTrail: (() => void) | null
}) {
  const blockedReason = !canCreate
    ? 'You do not have permission to take a return'
    : offline
      ? 'A return needs the server: it cannot be queued offline'
      : undefined

  const actions: MenuAction[] = [
    {
      key: 'export',
      label: 'Export returns',
      icon: <Download size={15} aria-hidden />,
      onSelect: onExport,
      hint: 'Downloads the rows this filter matches, as CSV',
    },
    {
      key: 'policy',
      label: 'Return policy',
      icon: <ScrollText size={15} aria-hidden />,
      onSelect: onPolicy,
      hint: 'The rules this till actually enforces',
    },
  ]

  if (onSettings) {
    actions.push({
      key: 'settings',
      label: 'Return settings',
      icon: <SettingsIcon size={15} aria-hidden />,
      onSelect: onSettings,
    })
  }
  if (onAuditTrail) {
    actions.push({
      key: 'audit',
      label: 'Audit trail',
      icon: <FileText size={15} aria-hidden />,
      onSelect: onAuditTrail,
      hint: 'Every change to a return, in Cash, Shifts & Controls',
    })
  }

  return (
    <section className="returns-hero">
      <div className="returns-hero__copy">
        <span className="returns-hero__icon" aria-hidden>
          <RotateCcw size={22} />
        </span>

        <div className="returns-hero__words">
          <p className="pos-eyebrow">AICOUNTLY POS</p>
          <h1>Returns &amp; Exchanges</h1>
          <p className="returns-hero__subtitle">
            Turn returns into better experiences. Track, analyse and stay in control.
          </p>
        </div>
      </div>

      <div className="returns-hero__actions">
        <div className="returns-hero__buttons">
          <button
            type="button"
            className="returns-button returns-button--primary"
            onClick={onNewReturn}
            disabled={Boolean(blockedReason)}
            title={blockedReason}
          >
            <Plus size={16} aria-hidden />
            New return
            <kbd aria-hidden>F2</kbd>
            <span className="pos-visually-hidden">, shortcut F2</span>
          </button>

          <MenuButton label="More" actions={actions} />
        </div>

        {blockedReason && <p className="returns-hero__blocked">{blockedReason}.</p>}

        <button type="button" className="returns-textlink" onClick={onPolicy}>
          View return policy
        </button>
      </div>
    </section>
  )
}
