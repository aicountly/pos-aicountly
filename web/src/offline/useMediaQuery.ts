import { useEffect, useState } from 'react'

/** Matches a media query and re-renders when it changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(list.matches)
    list.addEventListener('change', listener)

    return () => list.removeEventListener('change', listener)
  }, [query])

  return matches
}
