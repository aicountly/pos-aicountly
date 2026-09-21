/**
 * Full screen, for a display bolted to a kitchen wall.
 *
 * The browser owns this state, not React: a viewer can leave full screen with
 * Escape, with F11, or by switching away, and none of those go through our
 * button. So the hook LISTENS for the change and reflects it, rather than
 * keeping a boolean it believes.
 *
 * Unsupported browsers — and iOS Safari, which offers the API on video
 * elements only — get a disabled button with a tooltip saying why, not a
 * button that silently does nothing.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react'

export interface FullscreenApi {
  fullscreen: boolean
  supported: boolean
  toggle: () => void
}

export function useFullscreen(target: RefObject<HTMLElement | null>): FullscreenApi {
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement))
  const [supported] = useState(
    () => typeof document !== 'undefined' && (document.fullscreenEnabled ?? false),
  )

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)

    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggle = useCallback(() => {
    if (!supported) return

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)

      return
    }

    // A rejected request is a browser policy decision, not an error worth
    // showing a cook. The button simply does not take.
    void target.current?.requestFullscreen?.().catch(() => undefined)
  }, [supported, target])

  return { fullscreen, supported, toggle }
}
