/**
 * One clock for the whole board.
 *
 * Elapsed time is the single most important thing on a kitchen screen and the
 * single easiest thing to get wrong: a timer per card is a hundred intervals
 * and a hundred re-renders, and a timer that ticks every second re-renders the
 * board sixty times a minute to change a label that only moves once.
 *
 * So there is one interval, it ticks slower than the thing it draws, and it
 * never touches the network — the server's timestamps are re-read on the
 * refresh cycle, and in between the screen does arithmetic.
 */

import { useEffect, useState } from 'react'

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)

    // A screen left on a wall is suspended when the tab is hidden and wakes up
    // showing the time it was put to sleep at. Catch up on the way back.
    const catchUp = () => {
      if (!document.hidden) setNow(Date.now())
    }
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', catchUp)
      window.removeEventListener('focus', catchUp)
    }
  }, [intervalMs])

  return now
}
