/**
 * The four keys a kitchen actually presses.
 *
 * N, P, R, A — new, preparing, ready, all. Single letters with no modifier,
 * because the hands using them are holding something.
 *
 * The guard is the whole point: a single-letter shortcut with no modifier will
 * fire while someone is typing unless it is told not to. Searching for "prawn"
 * would otherwise jump the board to Preparing, then Ready, then Preparing
 * again on the way through the word.
 */

import { useEffect } from 'react'
import type { StatusFilter } from './types'

const KEYS: Record<string, StatusFilter> = { n: 'new', p: 'preparing', r: 'ready', a: 'all' }

export function useKitchenShortcuts(onSelect: (status: StatusFilter) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Anything with a modifier belongs to the browser or the operating
      // system, not to us.
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return

      const next = KEYS[event.key.toLowerCase()]
      if (!next) return

      event.preventDefault()
      onSelect(next)
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [onSelect])
}
