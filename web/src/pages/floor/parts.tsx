/**
 * The small pieces the floor screen shares: a status pill, a modal, a toast
 * stack and a labelled field.
 *
 * These are here rather than in src/ui because they are the floor's own shapes —
 * a modal that traps focus and a toast that announces itself. When a second
 * screen needs them they move up; inventing a product-wide dialog system for one
 * page would be the wrong order to do that in.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { statusOf } from './status'
import type { TableStatus } from '../../services/types'

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

/**
 * Whether a media query currently holds.
 *
 * The layout below 1100px turns the inspector into a drawer over the plan, and
 * a drawer has to be opened by choosing a table rather than being there from
 * the start — which is a behaviour decision, not something CSS can make.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)

    onChange()
    list.addEventListener('change', onChange)

    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

export function StatusPill({ status, compact = false }: { status: TableStatus; compact?: boolean }) {
  const config = statusOf(status)
  const Icon = config.icon

  return (
    <span className={`floor-pill floor-pill--${config.modifier}`}>
      <Icon size={12} aria-hidden />
      {compact ? null : config.label}
    </span>
  )
}

export function OpenPill({ open }: { open: boolean }) {
  return <span className={`floor-pill floor-pill--${open ? 'open' : 'closed'}`}>{open ? 'Open' : 'Closed'}</span>
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * A dialog that behaves like one.
 *
 * Escape closes it, focus starts inside it and cannot tab out of it, and the
 * page behind it does not scroll. A POS is operated at speed with a keyboard;
 * a dialog that loses the keyboard is a dialog that stops the queue.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
  labelledBy,
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  labelledBy?: string
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const headingId = useId()
  const id = labelledBy ?? headingId

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // The first field, or the panel itself when the dialog is all prose.
    const focusable = panel.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    )
    focusable?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return

      const stops = [...panel.current.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )]
      if (stops.length === 0) return

      const first = stops[0]
      const last = stops[stops.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="floor-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        className={wide ? 'floor-dialog floor-dialog--wide' : 'floor-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <header className="floor-dialog__head">
          <div>
            <h2 id={id}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="floor-dialog__close" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="floor-dialog__body">{children}</div>

        {footer && <footer className="floor-dialog__foot">{footer}</footer>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className={error ? 'floor-field floor-field--error' : 'floor-field'}>
      <span>{label}</span>
      {children}
      {(error || hint) && <small>{error ?? hint}</small>}
    </label>
  )
}

/** A row of one-press choices, for the short closed lists: shape, floor kind. */
export function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="floor-field">
      <span>{label}</span>
      <div className="floor-choices" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="floor-choice"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export type ToastTone = 'success' | 'warning' | 'danger'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  detail?: string
}

let toastSeq = 0

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, title: string, detail?: string) => {
      const id = ++toastSeq
      setToasts((current) => [...current.slice(-3), { id, tone, title, detail }])

      // Failures stay until they are read. A success that has already happened
      // does not need to keep saying so.
      if (tone === 'success') window.setTimeout(() => dismiss(id), 4200)
    },
    [dismiss],
  )

  return { toasts, push, dismiss }
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null

  const icons = { success: CheckCircle2, warning: AlertTriangle, danger: AlertTriangle }
  const colours = { success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)' }

  return (
    <div className="floor-toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => {
        const Icon = icons[toast.tone] ?? Info

        return (
          <div
            key={toast.id}
            className={`floor-toast floor-toast--${toast.tone}`}
            role={toast.tone === 'success' ? 'status' : 'alert'}
          >
            <Icon size={16} aria-hidden style={{ color: colours[toast.tone], flex: '0 0 auto', marginTop: 1 }} />
            <div className="floor-toast__body">
              <strong>{toast.title}</strong>
              {toast.detail && <span>{toast.detail}</span>}
            </div>
            <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * A confirmation for the things that cannot be taken back.
 *
 * Used for retiring a floor or a table and for cancelling a booking, and for
 * nothing else — a confirmation on a harmless action teaches people to press
 * through confirmations.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button
            type="button"
            className="pos-button pos-button--primary"
            style={tone === 'danger' ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--muted)' }}>{body}</p>
    </Modal>
  )
}
