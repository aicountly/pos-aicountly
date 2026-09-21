/**
 * The page header: what this is, which shift, and what can be done to it.
 *
 * The filters sit in ONE ROW above everything they scope, and everything below
 * re-renders against the same shift — so the KPI strip, the charts, the risk
 * tiles and the two tables can never disagree about which shift is on screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CloudOff,
  FileText,
  Loader2,
  Mail,
  Link2,
  Printer,
  Share2,
  ShoppingCart,
  Wifi,
} from 'lucide-react'
import { businessDateLabel, clockLabel } from '../format'
import type { ShiftDetail, ShiftReportContext, ShiftReportPolicy } from '../types'

/**
 * Whether this till is talking to the server.
 *
 * The same fact the shell shows, repeated here because a manager reading a
 * reconciliation needs to know at the point of reading it whether the figures
 * in front of them can still change.
 */
function ConnectionChip() {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return (
    <span className={online ? 'shift-chip shift-chip--ok' : 'shift-chip shift-chip--warn'} role="status">
      {online ? <Wifi size={13} aria-hidden /> : <CloudOff size={13} aria-hidden />}
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

export type ShareAction = 'link' | 'email' | 'print'

/**
 * Share, without publishing anything.
 *
 * Every option here hands over a link to THIS application, which the next
 * person still has to sign in to and still has to hold `reports.view` for. POS
 * has no public-link service and this menu does not pretend to be one — a
 * shift report is a cash record, and a URL that skipped the sign-in would be a
 * cash record on the open internet.
 */
function ShareMenu({ onShare, disabled }: { onShare: (action: ShareAction) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (action: ShareAction) => {
    setOpen(false)
    onShare(action)
  }

  return (
    <div ref={wrapper} style={{ position: 'relative' }}>
      <button
        type="button"
        className="shift-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
      >
        <Share2 size={14} aria-hidden /> Share
        <ChevronDown size={13} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Share this shift report"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 20,
            display: 'grid',
            minWidth: 224,
            padding: 6,
            border: '1px solid var(--pos-border)',
            borderRadius: 12,
            background: 'var(--pos-surface)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <button type="button" role="menuitem" className="shift-button shift-button--quiet" onClick={() => choose('link')}
            style={{ justifyContent: 'flex-start', color: 'var(--pos-text)' }}>
            <Link2 size={14} aria-hidden /> Copy secure link
          </button>
          <button type="button" role="menuitem" className="shift-button shift-button--quiet" onClick={() => choose('email')}
            style={{ justifyContent: 'flex-start', color: 'var(--pos-text)' }}>
            <Mail size={14} aria-hidden /> Email the link
          </button>
          <button type="button" role="menuitem" className="shift-button shift-button--quiet" onClick={() => choose('print')}
            style={{ justifyContent: 'flex-start', color: 'var(--pos-text)' }}>
            <Printer size={14} aria-hidden /> Print or save as PDF
          </button>
          <p className="shift-card__note" style={{ margin: '4px 8px 4px', maxWidth: 210 }}>
            The link opens this shift in POS. Whoever follows it still signs in and still needs permission to see it.
          </p>
        </div>
      )}
    </div>
  )
}

export function ShiftReportHeader({
  context,
  shift,
  policy,
  date,
  locationId,
  sessionId,
  busy,
  onFilter,
  onExport,
  onShare,
  onReconcile,
}: {
  context: ShiftReportContext
  shift: ShiftDetail | null
  policy: ShiftReportPolicy
  date: string
  locationId: number | null
  sessionId: number | null
  busy: boolean
  onFilter: (patch: { locationId?: number | null; date?: string; sessionId?: number | null }) => void
  onExport: () => void
  onShare: (action: ShareAction) => void
  onReconcile: () => void
}) {
  const reconciled = shift?.reconciled ?? false
  const openable = shift !== null && !reconciled && policy.can_reconcile

  const shiftLabel = useCallback(
    (option: (typeof context.shifts)[number]) => {
      const from = clockLabel(option.opened_at, context.timezone)
      const to = option.closed_at ? clockLabel(option.closed_at, context.timezone) : 'open'

      return `${option.label} (${from} – ${to}) · ${option.terminal_code}`
    },
    [context.timezone],
  )

  return (
    <header className="shift-report__header">
      <div className="shift-report__title">
        <span className="shift-report__icon" aria-hidden>
          <ShoppingCart size={22} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h1>Shift report</h1>
          <p>Live insights, control and reconciliation for a smoother business day.</p>
        </div>
      </div>

      <div className="shift-report__controls">
        <ConnectionChip />

        <label>
          <span className="pos-visually-hidden">Outlet</span>
          <select
            className="shift-control"
            value={locationId ?? ''}
            onChange={(event) => onFilter({ locationId: event.target.value === '' ? null : Number(event.target.value) })}
          >
            <option value="">All outlets</option>
            {context.outlets.map((outlet) => (
              <option key={outlet.location_id} value={outlet.location_id}>
                {outlet.display_name}
                {shift && shift.outlet.location_id === outlet.location_id ? ` (${shift.terminal.code})` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="shift-date">
          <CalendarDays size={14} aria-hidden style={{ color: 'var(--pos-muted)' }} />
          <span aria-hidden>{businessDateLabel(date)}</span>
          <span className="pos-visually-hidden">
            Business date — the outlet's own trading day, not the calendar day
          </span>
          <input
            type="date"
            value={date}
            onChange={(event) => onFilter({ date: event.target.value })}
            onClick={(event) => {
              // Chrome only opens the picker from the calendar icon, which is
              // invisible here, so ask for it directly. Browsers without
              // showPicker keep the ordinary typing and arrow-key behaviour.
              const field = event.currentTarget as HTMLInputElement & { showPicker?: () => void }
              try {
                field.showPicker?.()
              } catch {
                // Some browsers refuse outside a user gesture they recognise;
                // the field is focused either way.
              }
            }}
          />
        </label>

        <label>
          <span className="pos-visually-hidden">Shift</span>
          <select
            className="shift-control"
            value={sessionId ?? shift?.session_id ?? ''}
            onChange={(event) => onFilter({ sessionId: event.target.value === '' ? null : Number(event.target.value) })}
            disabled={context.shifts.length === 0}
          >
            {context.shifts.length === 0 && <option value="">No shifts on this date</option>}
            {context.shifts.map((option) => (
              <option key={option.session_id} value={option.session_id}>
                {shiftLabel(option)}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="shift-button" onClick={onExport} disabled={shift === null}>
          <FileText size={14} aria-hidden /> Export PDF
        </button>

        <ShareMenu onShare={onShare} disabled={shift === null} />

        {reconciled ? (
          <span className="shift-chip shift-chip--ok" role="status">
            <CheckCircle2 size={14} aria-hidden /> Reconciled
          </span>
        ) : (
          <button
            type="button"
            className="shift-button shift-button--primary"
            onClick={onReconcile}
            disabled={!openable || busy}
            title={
              shift === null
                ? 'Choose a shift first'
                : policy.can_reconcile
                  ? undefined
                  : 'Closing a till needs the shift.close permission'
            }
          >
            {busy ? <Loader2 size={14} aria-hidden className="shift-spin" /> : <CheckCircle2 size={14} aria-hidden />}
            Reconcile shift
          </button>
        )}
      </div>
    </header>
  )
}
