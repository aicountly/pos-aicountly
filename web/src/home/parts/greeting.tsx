/**
 * The greeting, and the clock beside it.
 *
 * THE CLOCK IS ITS OWN COMPONENT ON PURPOSE. It holds the only per-minute state
 * on this screen, so a tick re-renders a date and a time and nothing else — not
 * the charts, not the hero, not five cards of figures. It also schedules to the
 * next minute BOUNDARY rather than every sixty seconds from mount, so the
 * displayed minute changes when the minute does.
 */

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { greetingFor } from '../model'

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer = 0

    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date())
        schedule()
      }, 60_000 - (Date.now() % 60_000) + 50)
    }

    schedule()

    return () => window.clearTimeout(timer)
  }, [])

  return now
}

export function HomeGreeting({ name, subtitle }: { name: string; subtitle: string }) {
  const now = useMinuteClock()

  return (
    <section className="home-welcome" aria-label="Today">
      <div className="home-welcome__copy">
        <span className="home-welcome__mark" aria-hidden>
          <Sparkles size={21} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h1>
            {greetingFor(now)}, {name}!
          </h1>
          <p>{subtitle}</p>
        </div>
      </div>

      <div className="home-welcome__meta">
        <div className="home-clock">
          <span>
            {now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
          </span>
          <strong>
            <time dateTime={now.toISOString()}>
              {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </time>
          </strong>
        </div>
        <p className="home-strapline">
          Smarter POS.
          <br />
          Stronger businesses.
        </p>
      </div>
    </section>
  )
}
