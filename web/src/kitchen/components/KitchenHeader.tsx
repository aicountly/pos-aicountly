/**
 * The page header: what this screen is, what it is showing, and the controls
 * a kitchen touches without leaving the board.
 *
 * The clock is here and nowhere else. It is the only thing on the page that
 * changes every minute, so it keeps its own state and re-renders itself rather
 * than the board behind it.
 */

import { memo, useEffect, useState } from 'react'
import { ChefHat, Maximize2, Minimize2, RefreshCw, Settings, Volume2, VolumeX } from 'lucide-react'

function Clock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // Ten seconds, not one: the label is hours and minutes, so a second-by-
    // second timer would re-render fifty-nine times to change nothing.
    const id = window.setInterval(() => setNow(new Date()), 10_000)

    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="kds-clock">
      <span>{now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</span>
      <strong>
        <time dateTime={now.toISOString()}>
          {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </time>
      </strong>
    </div>
  )
}

export interface HeaderProps {
  /** Outlet · station · last synced. Absent parts are simply not shown. */
  context: string[]
  soundOn: boolean
  onToggleSound: () => void
  fullscreen: boolean
  fullscreenSupported: boolean
  onToggleFullscreen: () => void
  onOpenSettings: () => void
  onRefresh: () => void
  refreshing: boolean
}

export const KitchenHeader = memo(function KitchenHeader({
  context,
  soundOn,
  onToggleSound,
  fullscreen,
  fullscreenSupported,
  onToggleFullscreen,
  onOpenSettings,
  onRefresh,
  refreshing,
}: HeaderProps) {
  return (
    <header className="kds-head">
      <div className="kds-head__title">
        <span className="kds-head__mark" aria-hidden>
          <ChefHat size={27} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h1>Kitchen</h1>
          <p className="kds-head__sub">Live kitchen orders. Cook. Track. Serve.</p>
          {context.length > 0 && (
            <p className="kds-head__context">
              {context.map((part, index) => (
                <span key={part}>
                  {index > 0 && <span aria-hidden> · </span>}
                  {part}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>

      <div className="kds-head__actions">
        <button
          type="button"
          className="kds-btn kds-btn--icon"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh the board now"
          aria-label="Refresh the board now"
        >
          <RefreshCw size={16} aria-hidden />
        </button>

        <button type="button" className="kds-btn" onClick={onOpenSettings}>
          <Settings size={16} aria-hidden />
          Kitchen settings
        </button>

        <button
          type="button"
          className={soundOn ? 'kds-btn kds-btn--on' : 'kds-btn'}
          onClick={onToggleSound}
          aria-pressed={soundOn}
          title={soundOn ? 'New tickets chime' : 'New tickets are silent'}
        >
          {soundOn ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />}
          {soundOn ? 'Sound on' : 'Sound off'}
        </button>

        <button
          type="button"
          className="kds-btn"
          onClick={onToggleFullscreen}
          disabled={!fullscreenSupported}
          aria-pressed={fullscreen}
          title={
            fullscreenSupported
              ? fullscreen
                ? 'Leave full screen (Esc)'
                : 'Fill the screen with the board'
              : 'This browser does not offer full screen'
          }
        >
          {fullscreen ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
          {fullscreen ? 'Exit full screen' : 'Full screen'}
        </button>

        <Clock />
      </div>
    </header>
  )
})
