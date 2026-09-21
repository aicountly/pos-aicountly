/**
 * The one dropdown this screen uses, for the More menu and the row actions.
 *
 * A real menu, not a div that appears: `role="menu"`, arrow keys move between
 * items, Home and End jump, Escape closes and puts focus back on the trigger,
 * and a click anywhere else dismisses it. An action nobody may perform is not
 * rendered at all — the caller filters the list — and an action that is
 * temporarily unavailable is disabled WITH the reason on it, because a greyed
 * button that will not say why is the most annoying thing in any till.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export interface MenuAction {
  key: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  /** Why it is disabled, or what it will do. Shown under the label. */
  hint?: string
}

export function MenuButton({
  label,
  icon,
  actions,
  align = 'end',
  className = 'returns-button returns-button--secondary',
  ariaLabel,
}: {
  label?: ReactNode
  icon?: ReactNode
  actions: MenuAction[]
  align?: 'start' | 'end'
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const close = useCallback((returnFocus = true) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return undefined

    itemRefs.current[0]?.focus()

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)

    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((element): element is HTMLButtonElement => element !== null)
    if (items.length === 0) return

    const index = items.indexOf(document.activeElement as HTMLButtonElement)

    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1 + items.length) % items.length].focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length].focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0].focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1].focus()
    }
  }

  return (
    <div className="returns-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {label}
        {label !== undefined && <ChevronDown size={14} aria-hidden />}
      </button>

      {open && (
        <div
          className={align === 'start' ? 'returns-menu__list returns-menu__list--start' : 'returns-menu__list'}
          role="menu"
          onKeyDown={onMenuKeyDown}
        >
          {actions.map((action, index) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className="returns-menu__item"
              disabled={action.disabled}
              title={action.disabled ? action.hint : undefined}
              ref={(element) => {
                itemRefs.current[index] = element
              }}
              onClick={() => {
                close(false)
                action.onSelect()
              }}
            >
              {action.icon && <span className="returns-menu__icon">{action.icon}</span>}
              <span className="returns-menu__text">
                {action.label}
                {action.hint && <small>{action.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
