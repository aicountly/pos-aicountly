/**
 * The side panel the register opens things in.
 *
 * Built here rather than pulled in, for the same reason the charts were: one
 * dialog is a hundred lines, and a modal library is a dependency a till loads
 * on every shift.
 *
 * WHAT MAKES IT A DIALOG AND NOT A DIV:
 *  - focus moves into it when it opens and returns to whatever opened it when
 *    it closes, so a keyboard user is not dropped at the top of the document;
 *  - Tab is trapped inside it, because a dialog you can Tab out of is a dialog
 *    that reads the page behind it to a screen reader;
 *  - Escape closes it, and so does the scrim;
 *  - the page behind it cannot scroll, which on a touch screen is the
 *    difference between a panel and a trapdoor.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Drawer({
  open,
  title,
  eyebrow,
  badge,
  actions,
  footer,
  size = 'standard',
  onClose,
  children,
}: {
  open: boolean
  title: ReactNode
  eyebrow?: ReactNode
  badge?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  /** `wide` for a workflow, `standard` for a record. */
  size?: 'standard' | 'wide'
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)

  const close = useCallback(() => onClose(), [onClose])

  useEffect(() => {
    if (!open) return undefined

    returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const panel = panelRef.current
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE)
    firstFocusable?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()

        return
      }
      if (event.key !== 'Tab' || !panel) return

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      returnFocusTo.current?.focus()
    }
  }, [open, close])

  if (!open) return null

  return createPortal(
    <div className="returns-drawer-root pos-workspace returns-workspace">
      <button type="button" className="returns-drawer__scrim" aria-label="Close this panel" onClick={close} />

      <div
        className={size === 'wide' ? 'returns-drawer returns-drawer--wide' : 'returns-drawer'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <header className="returns-drawer__header">
          <div className="returns-drawer__heading">
            {eyebrow && <p className="returns-drawer__eyebrow">{eyebrow}</p>}
            <div className="returns-drawer__title">
              <h2 id={titleId}>{title}</h2>
              {badge}
            </div>
          </div>

          <div className="returns-drawer__tools">
            {actions}
            <button type="button" className="returns-icon-button" onClick={close} aria-label="Close this panel">
              <X size={17} aria-hidden />
            </button>
          </div>
        </header>

        <div className="returns-drawer__body">{children}</div>

        {footer && <footer className="returns-drawer__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
