import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  BarChart3,
  ChefHat,
  ChevronDown,
  CloudOff,
  Coins,
  LayoutDashboard,
  LogOut,
  Menu,
  RotateCcw,
  ScanLine,
  Settings as SettingsIcon,
  ShoppingCart,
  Sparkles,
  Store,
  Table2,
  UploadCloud,
  Users,
  UtensilsCrossed,
  Wifi,
} from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { AppLauncher } from '../components/AppLauncher'
import { usePos } from '../context/PosContext'
import { outboxPending } from '../offline/db'
import { drainOutbox, onReconnect } from '../offline/sync'
import { readAutoSync } from '../offline/preferences'
import { CompanyPicker } from './CompanyPicker'
import { TerminalPicker } from './TerminalPicker'
import './shell.css'

/**
 * The left navigation, in two groups.
 *
 * `permissions` is ANY-of, matching the backend: a cashier without reports.view
 * still opens Retail Operations, and the endpoint scopes them to their own till
 * rather than the UI showing them a board the server would refuse.
 *
 * `modes` is the outlet kind. A retail-only shop has no tables and no kitchen,
 * so those entries are absent rather than present and empty — and a
 * restaurant-only outlet does not carry a Retail Operations link it has no use
 * for. Hiding is presentation only; the API decides.
 */
type OutletMode = 'retail' | 'restaurant' | 'quick_service' | 'hybrid'

interface NavEntry {
  to: string
  label: string
  icon: typeof ScanLine
  exact?: boolean
  permissions: string[]
  modes?: OutletMode[]
}

const DASHBOARD_NAV: NavEntry[] = [
  { to: '/overview', label: 'Business Overview', icon: BarChart3, permissions: ['reports.view'] },
  {
    to: '/retail',
    label: 'Retail Operations',
    icon: Store,
    permissions: ['reports.view', 'sell'],
    modes: ['retail', 'quick_service', 'hybrid'],
  },
  {
    to: '/restaurant',
    label: 'Restaurant Operations',
    icon: UtensilsCrossed,
    permissions: ['reports.view', 'table.open', 'kds.operate'],
    modes: ['restaurant', 'quick_service', 'hybrid'],
  },
  { to: '/customers', label: 'Customers & Growth', icon: Users, permissions: ['reports.view'] },
  {
    to: '/controls',
    label: 'Cash, Shifts & Controls',
    icon: Coins,
    permissions: ['reports.view', 'shift.close', 'shift.open'],
  },
]

const WORK_NAV: NavEntry[] = [
  // No permission: the home screen is the landing page and shows each person
  // what they may see, rather than being hidden from anyone.
  { to: '/', label: 'Home', icon: LayoutDashboard, exact: true, permissions: [] },
  { to: '/till', label: 'Till', icon: ScanLine, permissions: ['sell'] },
  {
    to: '/floor',
    label: 'Floor',
    icon: Table2,
    permissions: ['table.open'],
    modes: ['restaurant', 'quick_service', 'hybrid'],
  },
  {
    to: '/kitchen',
    label: 'Kitchen',
    icon: ChefHat,
    permissions: ['kds.operate'],
    modes: ['restaurant', 'quick_service', 'hybrid'],
  },
  { to: '/returns', label: 'Returns', icon: RotateCcw, permissions: ['return.create'] },
  { to: '/offline', label: 'Offline Queue', icon: CloudOff, permissions: ['reports.view', 'offline.resolve'] },
  { to: '/reports', label: 'Shift report', icon: ShoppingCart, permissions: ['reports.view'] },
  { to: '/setup', label: 'Setup', icon: SettingsIcon, permissions: ['terminal.manage'] },
]

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
      // The Offline Queue screen owns this switch; the header has to obey it
      // too, or turning auto-posting off there does nothing the moment the
      // connection returns. Pressing the pill still sends by hand.
      if (readAutoSync()) void sync()
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
    <div className="shell-connection">
      <span
        className={online ? 'shell-pill shell-pill--ok' : 'shell-pill shell-pill--warn'}
        title={note ?? undefined}
        role="status"
      >
        {online ? <Wifi size={13} aria-hidden /> : <CloudOff size={13} aria-hidden />}
        {online ? 'Online' : 'Offline — finalising is unavailable'}
      </span>

      {queued > 0 && (
        <button
          type="button"
          className="shell-pill shell-pill--action"
          onClick={() => void sync()}
          disabled={syncing || !online}
          title={online ? 'Send these up now' : 'Waiting for the connection'}
        >
          <UploadCloud size={13} aria-hidden />
          {syncing ? 'Sending…' : `${queued} to send`}
        </button>
      )}
    </div>
  )
}

function NavGroup({
  label,
  entries,
  onNavigate,
}: {
  label: string
  entries: NavEntry[]
  onNavigate: () => void
}) {
  if (entries.length === 0) return null

  return (
    <div className="shell-navgroup">
      <p className="shell-navgroup__label">{label}</p>
      {entries.map((entry) => {
        const Icon = entry.icon

        return (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.exact ?? false}
            className={({ isActive }) => (isActive ? 'shell-nav__item shell-nav__item--active' : 'shell-nav__item')}
            onClick={onNavigate}
          >
            <Icon size={16} aria-hidden />
            <span>{entry.label}</span>
          </NavLink>
        )
      })}
    </div>
  )
}

/**
 * Who is signed in, and what POS calls them.
 *
 * The role underneath the name is the POS permission profile they were
 * assigned — a real row, from `v1/session`, not a label inferred from what
 * they happen to be allowed to do. Someone with no profile (an owner, whose
 * access comes from Manage) gets the label Manage gives them, and someone with
 * neither gets no second line rather than an invented one.
 */
function SignedInAs() {
  const { signOut } = useAuth()
  const { session } = usePos()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    const onClick = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  if (!session) return null

  const name = session.user.display_name
  const roles = session.user.roles ?? []
  const role = roles.length === 0 ? null : roles.join(' · ')

  const initials =
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?'

  return (
    <div className="shell-who" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className="shell-who__trigger"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
      >
        <span className="shell-who__avatar" aria-hidden>
          {initials}
        </span>
        <span className="shell-who__text">
          <span className="shell-who__name">{name}</span>
          {role && <span className="shell-who__role">{role}</span>}
        </span>
        <ChevronDown size={14} aria-hidden />
      </button>

      {open && (
        <div className="shell-who__menu" id={menuId} role="menu">
          <p className="shell-who__menu-head">
            <strong>{name}</strong>
            <span>{role ?? 'No POS role assigned'}</span>
          </p>
          <button type="button" role="menuitem" className="shell-who__menu-item" onClick={signOut}>
            <LogOut size={14} aria-hidden /> Log out
          </button>
        </div>
      )}
    </div>
  )
}

export function AppShell() {
  const { signOut } = useAuth()
  const { session, can, scope } = usePos()
  const [navOpen, setNavOpen] = useState(false)

  const modes = useMemo(
    () => new Set((session?.locations ?? []).map((location) => location.pos_mode as OutletMode)),
    [session],
  )

  const visible = useCallback(
    (entries: NavEntry[]) =>
      entries.filter((entry) => {
        // An empty list means everyone.
        if (entry.permissions.length > 0 && !entry.permissions.some((permission) => can(permission))) return false
        if (!entry.modes) return true
        // A company with no outlets configured yet sees everything, or a new
        // shop has nowhere to start.
        if (modes.size === 0) return true

        return entry.modes.some((mode) => modes.has(mode))
      }),
    [can, modes],
  )

  const closeNav = useCallback(() => setNavOpen(false), [])

  return (
    <div className="shell">
      <aside className={navOpen ? 'shell-sidebar shell-sidebar--open' : 'shell-sidebar'}>
        <div className="shell-brand">
          {/* The approved POS mark, shipped with the app. Not redrawn. */}
          <img src="/apps/pos.png" alt="" width={28} height={28} aria-hidden />
          <span>
            <strong>Aicountly</strong>
            <span>POS</span>
          </span>
        </div>

        <nav className="shell-nav" aria-label="Main">
          <NavGroup label="Dashboards" entries={visible(DASHBOARD_NAV)} onNavigate={closeNav} />
          <NavGroup label="Work" entries={visible(WORK_NAV)} onNavigate={closeNav} />
        </nav>

        {/* A standing note about what the boards are for, not an alert. It
            carries no count and no badge, because a number here would be a
            number nobody asked this component to fetch. */}
        <aside className="shell-promo" aria-label="About the dashboards">
          <Sparkles size={15} aria-hidden />
          <div>
            <strong>Smarter retail happens here.</strong>
            <p>Live counters, checkout timing and rule-based alerts, read straight from your own tills.</p>
          </div>
        </aside>

        <div className="shell-user">
          <span className="shell-user__name">{session?.user.display_name ?? '—'}</span>
          <button type="button" className="shell-signout" onClick={signOut}>
            <LogOut size={14} aria-hidden /> Log out
          </button>
        </div>
      </aside>

      {navOpen && <button type="button" className="shell-scrim" aria-label="Close the menu" onClick={closeNav} />}

      <div className="shell-main">
        <header className="shell-header">
          <div className="shell-header__left">
            <button
              type="button"
              className="shell-menu"
              onClick={() => setNavOpen((open) => !open)}
              aria-expanded={navOpen}
              aria-label={navOpen ? 'Close the menu' : 'Open the menu'}
            >
              <Menu size={18} aria-hidden />
            </button>
            <CompanyPicker />
            <TerminalPicker />
          </div>

          <div className="shell-header__right">
            <ConnectionState />
            {scope && <span className="shell-fy num">FY {scope.fy_id}</span>}
            <AppLauncher />
            <SignedInAs />
          </div>
        </header>

        <main className="shell-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
