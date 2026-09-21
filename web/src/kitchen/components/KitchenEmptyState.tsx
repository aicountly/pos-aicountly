/**
 * Nothing waiting.
 *
 * The old screen said exactly this and then left the rest of the page blank,
 * which is the one thing an operational display must not do: a kitchen looking
 * at an empty screen cannot tell a quiet moment from a broken feed.
 *
 * So this replaces the BOARD and nothing else. The figures, the chips, the
 * station load and the health strip all stay on screen, and the three checks
 * under the heading say plainly what "clear" is being claimed — the queue, the
 * delays and the stations — rather than leaving it to be inferred from white
 * space.
 */

import { CircleCheck } from 'lucide-react'
import { minutesLabel } from '../derive'

export function KitchenEmptyState({
  stationsUp,
  stationCount,
  lastServedSecondsAgo,
}: {
  stationsUp: boolean
  stationCount: number
  lastServedSecondsAgo: number | null
}) {
  return (
    <div className="kds-empty">
      <span className="kds-empty__mark" aria-hidden>
        <CircleCheck size={30} />
      </span>

      <h2>Nothing waiting</h2>
      <p>Every ticket is served. New orders appear here the moment they are fired.</p>

      <div className="kds-empty__checks">
        <span className="kds-empty__check">
          <CircleCheck size={13} aria-hidden /> Kitchen queue clear
        </span>
        <span className="kds-empty__check">
          <CircleCheck size={13} aria-hidden /> No delayed orders
        </span>
        {stationsUp && (
          <span className="kds-empty__check">
            <CircleCheck size={13} aria-hidden />
            {stationCount === 1 ? 'Station operational' : `All ${stationCount} stations operational`}
          </span>
        )}
      </div>

      {lastServedSecondsAgo !== null && (
        <p style={{ marginTop: 14 }}>Last ticket served {minutesLabel(lastServedSecondsAgo)} ago.</p>
      )}
    </div>
  )
}
