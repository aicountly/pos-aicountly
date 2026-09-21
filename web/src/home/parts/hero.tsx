/**
 * The hero — the one part of this page that changes what it is.
 *
 * A POS home screen answers "can this counter sell right now?" before it
 * answers anything else, so the hero is the answer to that question and the
 * next action toward yes. It has four shapes and they unlock in order:
 *
 *   setup        no till exists          → create the outlet and its first till
 *   choose-till  tills exist, none here  → say which counter this browser is
 *   ready        till chosen, no shift   → count the drawer and open
 *   live         a shift is open         → sell, and what the shift is holding
 *
 * The onboarding copy is NOT repeated anywhere else once setup is done, and the
 * plain notice this replaced is gone rather than stacked above it.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BookOpen,
  Building2,
  ChevronRight,
  Clock,
  Plus,
  ScanLine,
  ShieldCheck,
  Store,
  Zap,
} from 'lucide-react'
import type { Location, RegisterSession, Terminal } from '../../services/types'
import { clock, money } from '../../dashboards/format'
import type { HealthRow, HeroKind } from '../model'
import { Pill } from './states'

/** A cash register, drawn here so the page depends on no image file. */
function TerminalArt() {
  return (
    <div className="home-terminal" aria-hidden>
      <svg viewBox="0 0 220 180" role="presentation" focusable="false">
        <defs>
          <linearGradient id="home-screen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="var(--home-brand-soft)" />
          </linearGradient>
        </defs>

        {/* drawer */}
        <rect x="18" y="128" width="184" height="36" rx="9" fill="#ffffff" stroke="var(--home-border-strong)" />
        <rect x="86" y="143" width="48" height="6" rx="3" fill="var(--home-border-strong)" />

        {/* stand */}
        <path d="M96 112h28v18H96z" fill="var(--home-border-strong)" opacity="0.5" />

        {/* screen */}
        <rect x="42" y="16" width="136" height="98" rx="12" fill="url(#home-screen)" stroke="var(--home-brand-line)" />
        <rect x="54" y="30" width="112" height="14" rx="7" fill="var(--home-brand)" opacity="0.22" />
        <rect x="54" y="52" width="74" height="8" rx="4" fill="var(--home-border-strong)" opacity="0.7" />
        <rect x="54" y="66" width="92" height="8" rx="4" fill="var(--home-border-strong)" opacity="0.45" />
        <rect x="54" y="84" width="46" height="16" rx="8" fill="var(--home-brand)" opacity="0.85" />
        <rect x="108" y="84" width="58" height="16" rx="8" fill="var(--home-border-strong)" opacity="0.35" />

        {/* receipt */}
        <path
          d="M186 54h20v44l-5-4-5 4-5-4-5 4z"
          fill="#ffffff"
          stroke="var(--home-border-strong)"
          strokeLinejoin="round"
        />
        <rect x="191" y="62" width="10" height="4" rx="2" fill="var(--home-border-strong)" opacity="0.7" />
        <rect x="191" y="71" width="10" height="4" rx="2" fill="var(--home-border-strong)" opacity="0.45" />
      </svg>
    </div>
  )
}

const BENEFITS: Array<{ icon: typeof Zap; title: string; note: string }> = [
  { icon: Zap, title: 'Quick setup', note: 'Selling in minutes' },
  { icon: ShieldCheck, title: 'Secure & reliable', note: 'Every sale is attributed' },
  { icon: Building2, title: 'Multi-outlet ready', note: 'Scale as you grow' },
  { icon: BookOpen, title: 'Guided setup', note: 'Step by step' },
]

function Benefits() {
  return (
    <div className="home-hero__benefits">
      {BENEFITS.map((benefit) => {
        const Icon = benefit.icon

        return (
          <div className="home-benefit" key={benefit.title}>
            <span className="home-benefit__icon" aria-hidden>
              <Icon size={17} />
            </span>
            <div style={{ minWidth: 0 }}>
              <strong>{benefit.title}</strong>
              <small>{benefit.note}</small>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Shell({
  eyebrow,
  eyebrowIcon,
  heading,
  highlight,
  children,
  benefits = false,
}: {
  eyebrow: string
  eyebrowIcon?: ReactNode
  heading: string
  highlight: string
  children: ReactNode
  benefits?: boolean
}) {
  return (
    <section className="home-hero" aria-label="What to do next">
      <div className="home-hero__content">
        <span className="home-eyebrow">
          {eyebrowIcon}
          {eyebrow}
        </span>
        <h2>
          {heading} <em>{highlight}</em>
        </h2>
        {children}
      </div>

      <div className="home-hero__visual">
        <TerminalArt />
      </div>

      {benefits && <Benefits />}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function HomeHero({
  kind,
  terminals,
  locations,
  terminal,
  shift,
  queued,
  online,
  health,
  can,
  onChooseTill,
}: {
  kind: HeroKind
  terminals: Terminal[]
  locations: Location[]
  terminal: Terminal | null
  shift: RegisterSession | null
  queued: number
  online: boolean
  health: HealthRow[]
  can: (permission: string) => boolean
  onChooseTill: (id: number) => void
}) {
  const outletName = (id: number | undefined) => {
    const outlet = locations.find((l) => l.location_id === id)

    return outlet?.display_name ?? outlet?.location_code ?? 'this outlet'
  }

  // ------------------------------------------------------------------
  // Nothing to sell from yet
  // ------------------------------------------------------------------

  if (kind === 'setup') {
    const outletsExist = locations.length > 0
    const mayManage = can('terminal.manage')

    return (
      <Shell
        eyebrow="Get started"
        heading={outletsExist ? 'Your till is' : 'Your outlet is'}
        highlight={outletsExist ? 'not configured yet' : 'not set up yet'}
        benefits
      >
        <p className="home-hero__lede">
          A till is the counter this browser is standing at — the drawer, the shift and the receipts are all recorded
          against one, so selling cannot start until there is one.
          {!mayManage && ' Ask whoever administers POS to add one in Setup.'}
        </p>

        {mayManage && (
          <>
            {/* Setup reads ?section=, so each button lands on the panel it is
                about rather than on the page and a second click. */}
            <div className="home-hero__actions">
              <Link
                className="home-btn home-btn--primary"
                to={outletsExist ? '/setup?section=tills' : '/setup?section=outlets'}
              >
                <Plus size={16} aria-hidden />
                {outletsExist ? 'Set up first till' : 'Create outlet'}
                <ArrowRight size={15} aria-hidden />
              </Link>
              {outletsExist && (
                <Link className="home-btn" to="/setup?section=outlets">
                  <Store size={15} aria-hidden /> Add another outlet
                </Link>
              )}
            </div>

            {/* Not a link to a guide that does not exist — the three steps, here. */}
            <details className="home-guide">
              <summary>
                <BookOpen size={15} aria-hidden /> How setup works
              </summary>
              <ol>
                <li>Add an outlet — the shop, and where its stock and cash belong.</li>
                <li>Add a till to it, and choose that till at the top of this page.</li>
                <li>Open a shift by counting the drawer. The first sale can go through.</li>
              </ol>
            </details>
          </>
        )}
      </Shell>
    )
  }

  // ------------------------------------------------------------------
  // Tills exist, but this browser is not one of them yet
  // ------------------------------------------------------------------

  if (kind === 'choose-till') {
    return (
      <Shell eyebrow="Nearly there" heading="Which till is" highlight="this browser?">
        <p className="home-hero__lede">
          Everything a till does — the drawer, the shift, the receipts — is recorded against it. Choose once and this
          machine remembers; a till is a physical counter and does not move.
        </p>

        <div className="home-hero__tills">
          {terminals.slice(0, 4).map((till) => (
            <button key={till.terminal_id} type="button" className="home-hero__till" onClick={() => onChooseTill(till.terminal_id)}>
              <span style={{ minWidth: 0 }}>
                <strong>{till.display_name ?? till.terminal_code}</strong>
                <small>
                  {outletName(till.location_id)}
                  {till.open_session_id ? ' · shift open' : ''}
                </small>
              </span>
              <ChevronRight size={16} aria-hidden />
            </button>
          ))}
          {terminals.length > 4 && (
            <p className="home-note">
              {terminals.length - 4} more — all of them are in the Till picker at the top of the page.
            </p>
          )}
        </div>
      </Shell>
    )
  }

  // ------------------------------------------------------------------
  // A till, no shift
  // ------------------------------------------------------------------

  if (kind === 'ready') {
    const tillName = terminal?.display_name ?? terminal?.terminal_code ?? 'This till'

    return (
      <Shell eyebrow="Ready to start" heading="Your counter is" highlight="ready">
        <p className="home-hero__lede">
          {tillName} at {outletName(terminal?.location_id)} is configured and waiting. Open a shift — count what is in
          the drawer first, because that is what makes the close-out mean something.
        </p>

        <div className="home-hero__actions">
          <Link className="home-btn home-btn--primary" to="/till">
            {can('shift.open') ? 'Open shift' : 'Go to the till'}
            <ArrowRight size={15} aria-hidden />
          </Link>
          {can('terminal.manage') && (
            <Link className="home-btn" to="/setup?section=devices">
              <ScanLine size={15} aria-hidden /> Till & devices
            </Link>
          )}
          {can('reports.view') && (
            <Link className="home-btn" to="/reports">
              <Clock size={15} aria-hidden /> Shift report
            </Link>
          )}
        </div>

        {!can('shift.open') && (
          <p className="home-note" style={{ marginTop: 12 }}>
            Opening a shift is not one of your permissions — a manager opens the till, and you sell on it.
          </p>
        )}
      </Shell>
    )
  }

  // ------------------------------------------------------------------
  // Selling
  // ------------------------------------------------------------------

  const tillName = terminal?.display_name ?? terminal?.terminal_code ?? 'This till'
  const chips = health.filter((row) =>
    ['receipt_printer', 'cash_drawer', 'kitchen_display', 'payments'].includes(row.id),
  )

  return (
    <Shell eyebrow="Live shift" heading="Your store is" highlight="ready for business">
      <p className="home-hero__lede">
        {tillName} at {outletName(terminal?.location_id)} is open and taking money.
        {!online && ' This till is offline — sales are held here and go up on their own when the line is back.'}
      </p>

      <dl className="home-hero__facts">
        <Fact label="Opened">{clock(shift?.opened_at)}</Fact>
        <Fact label="Opened with">{money(shift?.opening_float ?? 0)}</Fact>
        <Fact label="Drawer should hold">{money(shift?.expected_cash ?? 0)}</Fact>
        <Fact label="Waiting to sync">{queued === 0 ? 'Nothing' : `${queued} sale${queued === 1 ? '' : 's'}`}</Fact>
      </dl>

      <div className="home-hero__chips">
        {chips.map((row) => (
          <Pill key={row.id} tone={row.tone}>
            {row.label}: {row.status}
          </Pill>
        ))}
      </div>

      <div className="home-hero__actions">
        <Link className="home-btn home-btn--primary" to="/till">
          <ScanLine size={16} aria-hidden /> Open POS
          <ArrowRight size={15} aria-hidden />
        </Link>
        {can('reports.view') && (
          <Link className="home-btn" to="/reports">
            <Clock size={15} aria-hidden /> View shift
          </Link>
        )}
        {(can('reports.view') || can('shift.close')) && (
          <Link className="home-btn" to="/controls">
            Cash controls
          </Link>
        )}
        {(can('reports.view') || can('sell')) && (
          <Link className="home-btn" to="/retail">
            Today's orders
          </Link>
        )}
      </div>
    </Shell>
  )
}
