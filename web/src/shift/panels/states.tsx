/**
 * Loading, error, empty — and the two overlays.
 *
 * `empty` is only ever true when the request SUCCEEDED and found no shift. A
 * failed request lands on the error branch, because "nobody opened a till" and
 * "we could not ask" must never render as the same screen.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, RefreshCw, X } from 'lucide-react'

/**
 * The skeleton, in the shape of the report.
 *
 * Deliberately not a spinner: this page settles into a fixed six-up strip and
 * two grids, so holding that shape while it loads means nothing jumps when the
 * figures land.
 */
export function ReportSkeleton() {
  return (
    <div className="shift-report" role="status" aria-live="polite" aria-busy="true">
      <span className="pos-visually-hidden">Loading the shift report…</span>

      <div className="shift-kpis" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="shift-skeleton" style={{ height: 116 }} />
        ))}
      </div>

      <div className="shift-skeleton" style={{ height: 168 }} aria-hidden />

      <div className="shift-analytics" aria-hidden>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="shift-skeleton" style={{ height: 216 }} />
        ))}
      </div>

      <div className="shift-skeleton" style={{ height: 156 }} aria-hidden />

      <div className="shift-bottom" aria-hidden>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="shift-skeleton" style={{ height: 268 }} />
        ))}
      </div>
    </div>
  )
}

/**
 * Something went wrong asking.
 *
 * Contained to this screen: the shell, the sidebar and the company context
 * stay where they are, because a shift report that could not load is not a
 * reason to take the till away from anyone.
 */
export function ReportErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="shift-empty" role="alert">
      <h2>Unable to load shift report.</h2>
      <p>{message}</p>
      <button type="button" className="shift-button shift-button--primary" onClick={onRetry} style={{ marginTop: 14 }}>
        <RefreshCw size={14} aria-hidden /> Retry
      </button>
    </div>
  )
}

export function ReportEmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="shift-empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  )
}

export function Note({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  title?: string
  children: ReactNode
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle

  return (
    <div className={tone === 'info' ? 'shift-note' : `shift-note shift-note--${tone}`} role="note">
      <Icon size={15} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  )
}

/**
 * The confirmation, after something happened.
 *
 * `role="status"` rather than an alert: reconciling a shift is a success, and a
 * screen reader should hear it without being interrupted mid-sentence.
 */
export function Toast({
  tone,
  children,
  onDismiss,
}: {
  tone: 'success' | 'danger'
  children: ReactNode
  onDismiss: () => void
}) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, tone === 'success' ? 6000 : 10000)

    return () => window.clearTimeout(id)
  }, [onDismiss, tone])

  return (
    <div className={tone === 'success' ? 'shift-toast' : 'shift-toast shift-toast--danger'} role="status" aria-live="polite">
      {tone === 'success' ? <CheckCircle2 size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
      <span style={{ minWidth: 0 }}>{children}</span>
      <button type="button" className="shift-close" onClick={onDismiss} aria-label="Dismiss" style={{ width: 28, height: 28 }}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

/**
 * The shell both overlays share.
 *
 * Escape closes it, the scrim closes it, focus moves into it when it opens and
 * is held there while it is open — a modal a keyboard can tab out of behind the
 * scrim is a modal that traps a keyboard user instead of the focus.
 */
export function Overlay({
  variant,
  title,
  description,
  onClose,
  footer,
  children,
  labelledBy,
}: {
  variant: 'drawer' | 'dialog'
  title: string
  description?: ReactNode
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
  labelledBy: string
}) {
  const frame = useRef<HTMLDivElement | null>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusable = () =>
      Array.from(
        frame.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null || element === document.activeElement)

    focusable()[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()

        return
      }
      if (event.key !== 'Tab') return

      const elements = focusable()
      if (elements.length === 0) return

      const first = elements[0]
      const last = elements[elements.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === first || !frame.current?.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      restoreTo.current?.focus()
    }
  }, [onClose])

  return (
    <>
      <button type="button" className="shift-scrim" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <div
        ref={frame}
        className={variant === 'drawer' ? 'shift-drawer' : 'shift-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <header className="shift-panel__head">
          <div style={{ minWidth: 0 }}>
            <h2 id={labelledBy}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="shift-close" onClick={onClose} aria-label={`Close ${title}`}>
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="shift-panel__body">{children}</div>

        {footer && <div className="shift-panel__foot">{footer}</div>}
      </div>
    </>
  )
}
