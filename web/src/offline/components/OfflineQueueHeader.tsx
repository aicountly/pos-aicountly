/**
 * The page header: what the connection is doing, and the one button that sends.
 *
 * The connection pill says FOUR different things because a till fails in four
 * different ways, and collapsing them into "offline" is what made the old
 * screen useless: a cashier could not tell a dead router from a server that was
 * up but refusing. Each state names what is happening and what follows from it.
 */

import { useEffect, useRef, useState } from 'react'
import { CloudOff, CloudUpload, Download, Loader2, MoreVertical, RefreshCw } from 'lucide-react'
import type { ConnectivityState } from '../useConnectivity'
import type { SyncProgress } from '../sync'

export interface HeaderProps {
  connectivity: ConnectivityState
  checking: boolean
  progress: SyncProgress
  queuedCount: number
  readyCount: number
  failedCount: number
  autoSync: boolean
  refreshing: boolean
  canPostAll: boolean
  onRefresh: () => void
  onPostAll: () => void
  onRetryFailed: () => void
  onExportDiagnostics: () => void
  onLearnMore: () => void
}

function pill(props: HeaderProps): { tone: string; title: string; detail: string } {
  const { connectivity, progress, queuedCount, autoSync } = props

  if (progress.active) {
    return {
      tone: 'q-conn--syncing',
      title: 'Syncing transactions',
      detail: progress.total > 0 ? `Posting ${progress.done} of ${progress.total}…` : 'Sending…',
    }
  }

  if (connectivity === 'OFFLINE') {
    return {
      tone: 'q-conn--offline',
      title: "You're Offline",
      detail: 'Transactions are being saved safely on this device.',
    }
  }

  if (connectivity === 'DEGRADED') {
    return {
      tone: 'q-conn--degraded',
      title: 'Server Not Answering',
      detail: 'This device has a network, but the server cannot be reached.',
    }
  }

  if (queuedCount > 0) {
    return {
      tone: '',
      title: 'Connection Restored',
      detail: autoSync ? 'Auto posting in progress…' : 'Auto posting is off — post when ready.',
    }
  }

  return { tone: '', title: 'Connected', detail: 'Everything this till took has been posted.' }
}

export function OfflineQueueHeader(props: HeaderProps) {
  const { connectivity, checking, progress, readyCount, failedCount, refreshing, canPostAll } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const state = pill(props)
  const offline = connectivity === 'OFFLINE'

  return (
    <header className="q-header">
      <div className="q-heading">
        <span className={offline ? 'q-heading__icon q-heading__icon--offline' : 'q-heading__icon'} aria-hidden>
          <CloudOff size={24} />
        </span>

        <div>
          <h1>Offline Queue</h1>
          <p>
            Transactions captured while offline. They will be automatically posted when connection is restored.
          </p>
        </div>
      </div>

      <div className="q-header__actions">
        {/* role=status so a screen reader is told when the line comes back,
            without the focus being stolen from whatever is being typed. */}
        <div className={`q-conn ${state.tone}`} role="status" aria-live="polite">
          <span className="q-conn__dot" aria-hidden />
          <div>
            <strong>{state.title}</strong>
            <small>{state.detail}</small>
          </div>
        </div>

        <button
          type="button"
          className="q-iconbtn"
          onClick={props.onRefresh}
          disabled={refreshing || checking}
          aria-label="Refresh the offline queue"
          title="Refresh"
        >
          <RefreshCw size={17} aria-hidden className={refreshing ? 'q-spin' : undefined} />
        </button>

        <button type="button" className="q-btn q-btn--primary" onClick={props.onPostAll} disabled={!canPostAll}>
          {progress.active ? <Loader2 size={15} aria-hidden className="q-spin" /> : <CloudUpload size={15} aria-hidden />}
          {progress.active ? 'Posting…' : 'Post All Now'}
        </button>

        <div className="q-menu-anchor" ref={menuRef}>
          <button
            type="button"
            className="q-iconbtn"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="More offline queue options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreVertical size={17} aria-hidden />
          </button>

          {menuOpen && (
            <ul className="q-menu" role="menu">
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    props.onRetryFailed()
                  }}
                  disabled={failedCount === 0 || connectivity !== 'ONLINE'}
                >
                  <RefreshCw size={14} aria-hidden /> Retry failed ({failedCount})
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    props.onExportDiagnostics()
                  }}
                >
                  <Download size={14} aria-hidden /> Export diagnostics
                </button>
              </li>
              <li role="none" aria-hidden>
                <div className="q-menu__sep" />
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    props.onLearnMore()
                  }}
                >
                  How the offline queue works
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>

      {/* Said out loud for a screen reader only: the pill above is visual. */}
      <span className="q-sr-only" aria-live="polite">
        {readyCount > 0 && connectivity === 'ONLINE' ? `${readyCount} transactions are ready to post.` : ''}
      </span>
    </header>
  )
}
