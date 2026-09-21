/**
 * The five figures a counter is judged on.
 *
 * A card drills in only where a screen exists AND this person may open it; the
 * rest are plain cards rather than buttons that lead to a 403. A figure that is
 * still loading is a skeleton, never a zero — "₹0" and "we have not asked yet"
 * are different claims about the day.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  IndianRupee,
  ReceiptText,
  RotateCcw,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { count, money } from '../../dashboards/format'
import type { KpiFigures } from '../useHomeData'

type Tint = 'green' | 'blue' | 'violet' | 'teal' | 'amber'

interface Change {
  label: string
  direction: 'up' | 'down' | 'flat'
}

function ChangeLine({ change, fallback }: { change: Change | null; fallback: ReactNode }) {
  if (!change) return <span className="home-kpi__change">{fallback}</span>

  return (
    <span
      className={`home-kpi__change${change.direction === 'flat' ? '' : ` home-kpi__change--${change.direction === 'up' ? 'up' : 'down'}`}`}
    >
      {/* The arrow repeats what the words say, on purpose: colour is never the
          only thing carrying a direction. */}
      <span aria-hidden>{change.direction === 'up' ? '▲' : change.direction === 'down' ? '▼' : '■'}</span>
      {change.label}
    </span>
  )
}

function Kpi({
  icon: Icon,
  tint,
  label,
  value,
  change,
  loading,
  to,
}: {
  icon: LucideIcon
  tint: Tint
  label: string
  value: string | null
  change: ReactNode
  loading: boolean
  to?: string
}) {
  const body = (
    <>
      <span className={`home-kpi__icon home-kpi__icon--${tint}`} aria-hidden>
        <Icon size={20} />
      </span>
      <span className="home-kpi__body">
        {/* The title carries the label a narrow card has had to clip. */}
        <span className="home-kpi__label" title={label}>
          {label}
        </span>
        {loading ? (
          <>
            <span className="home-skeleton home-skeleton--value" style={{ marginTop: 6 }} />
            <span className="home-skeleton home-skeleton--line" style={{ marginTop: 8, width: '78%' }} />
          </>
        ) : (
          <>
            <strong className="home-kpi__value">{value ?? '—'}</strong>
            {change}
          </>
        )}
      </span>
    </>
  )

  if (to && !loading) {
    return (
      <Link className="home-kpi" to={to}>
        {body}
      </Link>
    )
  }

  return (
    <article className="home-kpi" aria-busy={loading || undefined}>
      {body}
    </article>
  )
}

export function HomeKpis({
  figures,
  loading,
  restricted,
  tills,
  returns,
  can,
}: {
  figures: KpiFigures
  loading: boolean
  restricted: boolean
  tills: number
  /** Returns come from their own endpoint, so they load and fail on their own. */
  returns: { loading: boolean; allowed: boolean; failed: boolean }
  can: (permission: string) => boolean
}) {
  const scopeNote =
    figures.basis === 'own-counters' ? <small>your counters, today</small> : <small>no comparison for yesterday</small>

  const reports = can('reports.view')
  const sellBoard = reports || can('sell')
  const shiftBoard = reports || can('shift.close') || can('shift.open')

  return (
    <section className="home-kpis" aria-label="Today at a glance">
      <Kpi
        icon={IndianRupee}
        tint="green"
        label="Today's Sales"
        value={restricted ? null : money(figures.sales)}
        change={<ChangeLine change={figures.salesChange} fallback={restricted ? <small>not shown for your role</small> : scopeNote} />}
        loading={loading}
        to={reports ? '/overview' : undefined}
      />
      <Kpi
        icon={ShoppingCart}
        tint="blue"
        label="Orders"
        value={restricted ? null : count(figures.orders)}
        change={<ChangeLine change={figures.ordersChange} fallback={restricted ? <small>not shown for your role</small> : scopeNote} />}
        loading={loading}
        to={sellBoard ? '/retail' : undefined}
      />
      <Kpi
        icon={ReceiptText}
        tint="violet"
        label="Average Bill Value"
        value={restricted ? null : money(figures.averageBill)}
        change={<ChangeLine change={figures.averageChange} fallback={restricted ? <small>not shown for your role</small> : scopeNote} />}
        loading={loading}
        to={reports ? '/overview' : undefined}
      />
      <Kpi
        icon={Users}
        tint="teal"
        label="Active Shifts"
        value={figures.activeShifts === null ? null : count(figures.activeShifts)}
        change={
          <span className="home-kpi__change">
            <small>{tills === 0 ? 'no tills set up yet' : `across ${count(tills)} till${tills === 1 ? '' : 's'}`}</small>
          </span>
        }
        loading={loading}
        to={shiftBoard ? '/controls' : undefined}
      />
      <Kpi
        icon={RotateCcw}
        tint="amber"
        label="Pending Returns"
        value={returns.allowed && !returns.failed && figures.pendingReturns !== null ? count(figures.pendingReturns) : null}
        change={
          <span className="home-kpi__change">
            <small>
              {!returns.allowed
                ? 'not shown for your role'
                : returns.failed
                  ? 'could not be counted'
                  : 'not yet settled'}
            </small>
          </span>
        }
        loading={returns.loading}
        to={returns.allowed ? '/returns' : undefined}
      />
    </section>
  )
}
