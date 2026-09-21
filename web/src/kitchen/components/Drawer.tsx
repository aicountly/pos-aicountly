/**
 * The right-hand drawer, used by both kitchen settings and served history.
 *
 * Written here rather than pulled from the dashboard kit because the
 * dashboards have no drawer — and it is deliberately small: a scrim, a panel,
 * Escape to close, and focus put somewhere sensible on the way in. A kitchen
 * screen is worked with a keyboard as often as a mouse, and a panel that traps
 * nothing and returns focus nowhere is a panel a cook cannot get out of.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Drawer({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      // Back where they came from, or the next Tab starts at the top of the page.
      returnTo.current?.focus()
    }
  }, [onClose])

  return (
    <>
      <button type="button" className="kds-scrim" aria-label="Close" onClick={onClose} />
      <div className="kds-drawer" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
        <header className="kds-drawer__head">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="kds-iconbtn" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="kds-drawer__body">{children}</div>

        {footer && <footer className="kds-drawer__foot">{footer}</footer>}
      </div>
    </>
  )
}
