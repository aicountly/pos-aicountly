/**
 * The pieces the Setup screen needs that the product did not already have: a
 * drawer, a confirmation, a toast, a skeleton and one small illustration.
 *
 * They live here rather than in src/ui/index.tsx because that file is the
 * till's primitives — deliberately tiny, inline-styled and shared with screens
 * that must not grow a portal or a focus trap by accident. Everything below is
 * styled from setup/styles.css and is used by this screen only.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * A right-hand drawer, and the four things that make one usable without a
 * mouse: focus moves in on open, Tab cannot leave, Escape closes, and focus
 * returns to whatever opened it. Losing any one of those strands a keyboard
 * user behind an invisible dialog.
 */
export function Drawer({
  title,
  description,
  onClose,
  wide = false,
  footer,
  children,
}: {
  title: string
  description?: ReactNode
  onClose: () => void
  wide?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const headingId = useId()

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null

    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panelRef.current)?.focus()
    })

    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = overflow
      // The trigger may have been unmounted by the change that closed this.
      if (returnTo.current?.isConnected) returnTo.current.focus()
    }
  }, [])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    )
    if (items.length === 0) return

    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="setup-drawer-backdrop"
      // The backdrop closes the drawer, but only when the backdrop itself is
      // what was pressed — a drag that ends outside the panel should not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={wide ? 'setup-drawer setup-drawer--wide' : 'setup-drawer'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="setup-drawer__header">
          <div style={{ minWidth: 0 }}>
            <h2 id={headingId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="setup-iconbutton" onClick={onClose} aria-label="Close">
            <X size={17} aria-hidden />
          </button>
        </header>
        {children}
        {footer && <footer className="setup-drawer__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * Used for the three things on this screen that are hard to take back: revoking
 * a device, switching an outlet off and switching a till off. An ordinary edit
 * never asks.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = 'default',
  reasonLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  tone?: 'default' | 'danger'
  /** When given, the reason is required and is sent with the action. */
  reasonLabel?: string
  busy?: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const headingId = useId()
  const fieldId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panelRef.current)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (returnTo.current?.isConnected) returnTo.current.focus()
    }
  }, [])

  const blocked = busy || (reasonLabel !== undefined && reason.trim() === '')

  return createPortal(
    <div className="setup-confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={panelRef}
        className="setup-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <h2 id={headingId}>{title}</h2>
        <div>{children}</div>

        {reasonLabel !== undefined && (
          <div style={{ marginTop: 14 }}>
            <label htmlFor={fieldId}>{reasonLabel}</label>
            <input
              id={fieldId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Lost at the counter"
              autoComplete="off"
            />
          </div>
        )}

        <div className="setup-confirm__actions">
          <button type="button" className="pos-button pos-button--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pos-button pos-button--primary"
            style={tone === 'danger' ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
            onClick={() => onConfirm(reason.trim())}
            disabled={blocked}
          >
            {busy && <Loader2 size={14} className="setup-spin" aria-hidden />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

type ToastTone = 'success' | 'danger' | 'warning'

interface Toast {
  id: number
  tone: ToastTone
  title: string
  detail?: string
}

interface ToastApi {
  success: (title: string, detail?: string) => void
  failure: (title: string, detail?: string) => void
  warn: (title: string, detail?: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const ICONS = { success: CheckCircle2, danger: AlertTriangle, warning: Info } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef<number[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, title: string, detail?: string) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, tone, title, detail }])
      // Failures stay until they are read; a confirmation does not need to.
      if (tone !== 'danger') {
        timers.current.push(window.setTimeout(() => dismiss(id), 5000))
      }
    },
    [dismiss],
  )

  useEffect(() => () => timers.current.forEach(window.clearTimeout), [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, detail) => push('success', title, detail),
      failure: (title, detail) => push('danger', title, detail),
      warn: (title, detail) => push('warning', title, detail),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        // Polite, not assertive: a saved outlet should not interrupt whatever
        // the screen reader is in the middle of saying.
        <div className="setup-toasts" role="status" aria-live="polite">
          {toasts.map((toast) => {
            const Icon = ICONS[toast.tone]
            return (
              <div key={toast.id} className={`setup-toast setup-toast--${toast.tone}`}>
                <Icon size={17} className="setup-toast__icon" aria-hidden />
                <div className="setup-toast__body">
                  <strong>{toast.title}</strong>
                  {toast.detail && <span>{toast.detail}</span>}
                </div>
                <button type="button" className="setup-iconbutton" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
                  <X size={15} aria-hidden />
                </button>
              </div>
            )
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}

// ---------------------------------------------------------------------------
// Form field
// ---------------------------------------------------------------------------

/**
 * A label, a control and — when there is one — an error the control points at.
 *
 * `aria-describedby` is wired here rather than at each call site because a
 * validation message a screen reader never reaches is a validation message
 * that does not exist.
 */
export function Field({
  label,
  required = false,
  hint,
  error,
  children,
}: {
  label: string
  required?: boolean
  hint?: ReactNode
  error?: string | null
  children: (props: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': boolean }) => ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className="setup-field">
      <label htmlFor={id}>
        {label}
        {required && (
          <>
            {' '}
            <span className="setup-field__req" aria-hidden>
              *
            </span>
            <span className="pos-visually-hidden">(required)</span>
          </>
        )}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}
      {error && (
        <p className="setup-field__error" id={errorId}>
          {error}
        </p>
      )}
      {hint && (
        <p className="setup-field__help" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="setup-section">
      <div className="setup-section__head">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

export function SkeletonLine({ width = '100%', height = 12 }: { width?: string | number; height?: number }) {
  return <div className="setup-skeleton" style={{ width, height }} aria-hidden />
}

export function SkeletonCards({ count = 5 }: { count?: number }) {
  return (
    <div className="setup-overview" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="setup-skeleton-card">
          <div className="setup-skeleton" style={{ width: 46, height: 46, borderRadius: 13 }} />
          <SkeletonLine width="55%" height={14} />
          <SkeletonLine width="90%" />
          <SkeletonLine width="70%" />
          <SkeletonLine width={92} height={22} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div style={{ padding: 16, display: 'grid', gap: 18 }} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 80px', gap: 14 }}>
          <SkeletonLine height={16} />
          <SkeletonLine height={16} />
          <SkeletonLine height={16} />
          <SkeletonLine height={16} />
          <SkeletonLine height={16} />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The storefront
// ---------------------------------------------------------------------------

/**
 * Drawn inline rather than shipped as an image: it is forty lines of SVG, it
 * inherits the theme, and it costs no request. The alternative was an
 * illustration dependency for one empty state.
 */
export function Storefront({ size = 112 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.78} viewBox="0 0 120 94" fill="none" role="img" aria-label="A shopfront">
      <rect x="14" y="36" width="92" height="50" rx="6" fill="#fff" stroke="currentColor" strokeWidth="2.5" />
      <path d="M10 36 18 16h84l8 20z" fill="var(--brand-soft, #edf8e9)" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M31 16v20M48 16v20M65 16v20M82 16v20" stroke="currentColor" strokeWidth="2.2" opacity="0.55" />
      <rect x="27" y="50" width="26" height="20" rx="3" fill="var(--brand-soft, #edf8e9)" stroke="currentColor" strokeWidth="2.2" />
      <path d="M68 86V56a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v30" fill="#fff" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="74" cy="70" r="2.2" fill="currentColor" />
      <path d="M6 86h108" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

/** The same shop, small, for the guided banner. */
export function StorefrontMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 64 48" fill="none" aria-hidden>
      <rect x="8" y="19" width="48" height="25" rx="4" fill="#fff" stroke="currentColor" strokeWidth="2.4" />
      <path d="M5 19 10 7h44l5 12z" fill="#fff" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M18 7v12M32 7v12M46 7v12" stroke="currentColor" strokeWidth="2" opacity="0.5" />
      <rect x="35" y="27" width="14" height="17" rx="2.5" fill="var(--brand-soft, #edf8e9)" stroke="currentColor" strokeWidth="2.2" />
      <path d="M15 28h11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M15 34h8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Overflow menu
// ---------------------------------------------------------------------------

/**
 * The row menu. Closes on Escape, on a click away and on choosing something,
 * because a popover left open over the next row is a misclick waiting.
 */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return

    const onAway = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onAway)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onAway)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="setup-menu" ref={boxRef}>
      <button
        type="button"
        className="setup-iconbutton"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="3" r="1.5" fill="currentColor" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="13" r="1.5" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="setup-menu__list" role="menu">
          {children(close)}
        </div>
      )}
    </div>
  )
}
