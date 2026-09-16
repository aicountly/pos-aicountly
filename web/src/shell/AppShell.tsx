import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  ChefHat,
  CloudOff,
  LayoutDashboard,
  LogOut,
  Monitor,
  RotateCcw,
  ScanLine,
  Settings as SettingsIcon,
  Table2,
  UploadCloud,
} from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { AppLauncher } from '../components/AppLauncher'
import { usePos } from '../context/PosContext'
import { outboxPending } from '../offline/db'
import { drainOutbox, onReconnect } from '../offline/sync'
import { CompanyPicker } from './CompanyPicker'
import { TerminalPicker } from './TerminalPicker'

const NAV = [
  { to: '/', label: 'Till', icon: ScanLine, exact: true, permission: 'sell' },
  { to: '/floor', label: 'Floor', icon: Table2, permission: 'table.open' },
  { to: '/kitchen', label: 'Kitchen', icon: ChefHat, permission: 'kds.operate' },
  { to: '/returns', label: 'Returns', icon: RotateCcw, permission: 'return.create' },
  { to: '/offline', label: 'Offline queue', icon: CloudOff, permission: 'reports.view' },
  { to: '/reports', label: 'Reports', icon: LayoutDashboard, permission: 'reports.view' },
  { to: '/setup', label: 'Setup', icon: SettingsIcon, permission: 'terminal.manage' },
] as const

/**
 * The connection indicator.
 *
 * A till has to say, at a glance and at all times, whether it is talking to the
 * server and how much it is carrying that has not got there yet. A cashier who
 * cannot tell is a cashier who finds out at close-out.
 */
function ConnectionState() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [queued, setQueued] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setQueued((await outboxPending()).length)
  }, [])

  const sync = useCallback(async () => {
    setSyncing(true)
    try {
      const outcome = await drainOutbox()
      setNote(outcome.message)
    } finally {
      setSyncing(false)
      await refresh()
    }
  }, [refresh])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(refresh, 5000)

    const goOnline = () => {
      setOnline(true)
      void sync()
    }
    const goOffline = () => setOnline(false)

    const stopReconnect = onReconnect(goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.clearInterval(id)
      stopReconnect()
      window.removeEventListener('offline', goOffline)
    }
  }, [refresh, sync])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span
        title={note ?? undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.2rem 0.5rem',
          borderRadius: '999px',
          fontSize: '0.78rem',
          fontWeight: 600,
          background: online ? 'var(--ok-bg, #052e16)' : 'var(--warn-bg, #451a03)',
          color: online ? 'var(--ok-fg, #4ade80)' : 'var(--warn-fg, #fbbf24)',
        }}
      >
        {online ? <Monitor size={13} aria-hidden /> : <CloudOff size={13} aria-hidden />}
        {online ? 'Online' : 'Offline — still selling'}
      </span>

      {queued > 0 && (
        <button
          type="button"
          onClick={() => void sync()}
          disabled={syncing || !online}
          title={online ? 'Send these up now' : 'Waiting for the connection'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.2rem 0.5rem',
            borderRadius: '999px',
            fontSize: '0.78rem',
            fontWeight: 600,
            border: '1px solid var(--border-strong)',
            background: 'transparent',
            color: 'var(--muted)',
            cursor: online && !syncing ? 'pointer' : 'default',
          }}
        >
          <UploadCloud size={13} aria-hidden />
          {syncing ? 'Sending…' : `${queued} to send`}
        </button>
      )}
    </div>
  )
}

export function AppShell() {
  const { signOut } = useAuth()
  const { session, can, scope } = usePos()

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 'var(--sidebar-w)',
          flexShrink: 0,
          borderRight: '1px solid var(--border)',
          background: 'var(--surface-2)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em' }}>AICOUNTLY</div>
          <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>POS</div>
        </div>

        <nav style={{ padding: '0.5rem', flex: 1, overflowY: 'auto' }}>
          {NAV.filter((entry) => !('permission' in entry) || can(entry.permission as string)).map((entry) => {
            const Icon = entry.icon
            return (
              <NavLink
                key={entry.to}
                to={entry.to}
                end={'exact' in entry ? entry.exact : false}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  padding: '0.5rem 0.65rem',
                  marginBottom: '0.15rem',
                  borderRadius: 'var(--radius-sm)',
                  color: isActive ? 'var(--fg)' : 'var(--muted)',
                  background: isActive ? 'var(--surface)' : 'transparent',
                  fontWeight: isActive ? 600 : 400,
                  textDecoration: 'none',
                })}
              >
                <Icon size={16} aria-hidden />
                {entry.label}
              </NavLink>
            )
          })}
        </nav>

        <div style={{ padding: '0.75rem', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.82rem', marginBottom: '0.5rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {session?.user.display_name ?? '—'}
          </div>
          <button
            type="button"
            onClick={signOut}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              width: '100%',
              padding: '0.4rem 0.5rem',
              background: 'transparent',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              color: 'var(--muted)',
            }}
          >
            <LogOut size={14} aria-hidden /> Log out
          </button>
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            height: 'var(--header-h)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 1rem',
            gap: '1rem',
            background: 'var(--surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
            <CompanyPicker />
            <TerminalPicker />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ConnectionState />
            {scope && (
              <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }} className="num">
                FY {scope.fy_id}
              </span>
            )}
            <AppLauncher />
          </div>
        </header>

        <main style={{ flex: 1, padding: '1.25rem', minWidth: 0, background: 'var(--bg)' }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
