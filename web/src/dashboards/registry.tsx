/**
 * Which dashboards this person, at this outlet, may open — and the filter bar
 * they all share.
 *
 * VISIBILITY IS TWO QUESTIONS, NOT ONE.
 *
 *   What may they do?   Permissions, from the server. A cashier has no
 *                       reports.view, so Business Overview and Customers are
 *                       not theirs.
 *   What is this shop?  pos_mode on the outlet. A retail-only shop has no
 *                       tables and no kitchen, so Restaurant Operations is not
 *                       a tab that is empty — it is a tab that is absent.
 *
 * Hiding a tab is presentation and nothing more. Each endpoint asserts its own
 * permission and scopes its own rows, so a person who types the URL of a board
 * they may not see gets a 403, not a blank page.
 */

import { useMemo } from 'react'
import { BarChart3, Coins, Store, Users, UtensilsCrossed } from 'lucide-react'
import { usePos } from '../context/PosContext'
import type { Location } from '../services/types'
import type { DashboardTab } from './shell'
import type { ComparisonMode, DashboardFilters } from './useDashboard'

export const DASHBOARDS: Array<
  DashboardTab & {
    /** Any one of these is enough to open it. */
    permissions: string[]
    /** Which kinds of outlet this board is about. Empty means all of them. */
    modes: Array<Location['pos_mode']>
  }
> = [
  {
    id: 'overview',
    label: 'Business Overview',
    path: '/overview',
    icon: <BarChart3 size={15} />,
    permissions: ['reports.view'],
    modes: [],
  },
  {
    id: 'retail',
    label: 'Retail Operations',
    path: '/retail',
    icon: <Store size={15} />,
    permissions: ['reports.view', 'sell'],
    modes: ['retail', 'quick_service', 'hybrid'],
  },
  {
    id: 'restaurant',
    label: 'Restaurant Operations',
    path: '/restaurant',
    icon: <UtensilsCrossed size={15} />,
    permissions: ['reports.view', 'table.open', 'kds.operate'],
    modes: ['restaurant', 'quick_service', 'hybrid'],
  },
  {
    id: 'customers',
    label: 'Customers & Growth',
    path: '/customers',
    icon: <Users size={15} />,
    permissions: ['reports.view'],
    modes: [],
  },
  {
    id: 'controls',
    label: 'Cash, Shifts & Controls',
    path: '/controls',
    icon: <Coins size={15} />,
    permissions: ['reports.view', 'shift.close', 'shift.open'],
    modes: [],
  },
]

/**
 * The tabs to draw.
 *
 * With one outlet chosen, that outlet's mode decides. With none chosen the
 * company may run both kinds of shop, so a board is shown if ANY outlet is of a
 * kind it applies to — a restaurant group's manager looking across outlets still
 * needs the kitchen board.
 */
export function useVisibleDashboards(locationId: number | null): DashboardTab[] {
  const { can, session } = usePos()
  const locations = session?.locations ?? []

  return useMemo(() => {
    const inScope = locationId === null ? locations : locations.filter((l) => l.location_id === locationId)
    const modes = new Set(inScope.map((l) => l.pos_mode))

    return DASHBOARDS.filter((dashboard) => {
      if (!dashboard.permissions.some((permission) => can(permission))) return false
      if (dashboard.modes.length === 0) return true
      // No outlets configured yet: show everything rather than an empty shell
      // that gives a new shop nowhere to start.
      if (modes.size === 0) return true

      return dashboard.modes.some((mode) => modes.has(mode))
    }).map(({ id, label, path, icon }) => ({ id, label, path, icon }))
  }, [can, locations, locationId])
}

/** Carry the current filters onto another board's URL, so a drill-down keeps them. */
export function withFilters(path: string, filters: DashboardFilters, extra?: Record<string, string>): string {
  const params = new URLSearchParams()
  params.set('from', filters.from)
  if (filters.to !== filters.from) params.set('to', filters.to)
  if (filters.locationId) params.set('location_id', String(filters.locationId))
  if (filters.terminalId) params.set('terminal_id', String(filters.terminalId))
  if (filters.compare !== 'none') params.set('compare', filters.compare)
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value)

  return `${path}?${params.toString()}`
}

/**
 * The four spans a shop actually asks for.
 *
 * Each one computes its own dates from today rather than from whatever is in
 * the boxes, and the bar works out afterwards which of them the boxes now
 * match. That way typing 1st–30th by hand lights "This month" up, and pressing
 * "This month" on the 12th does not silently mean "to the 30th" — it means to
 * today, which is the only day there are figures for.
 */
const RANGES: Array<{ id: string; label: string; resolve: () => { from: string; to: string } }> = [
  { id: 'today', label: 'Today', resolve: () => ({ from: todayString(), to: todayString() }) },
  { id: '7d', label: 'Last 7 days', resolve: () => ({ from: shift(todayString(), -6), to: todayString() }) },
  { id: '30d', label: 'Last 30 days', resolve: () => ({ from: shift(todayString(), -29), to: todayString() }) },
  { id: 'month', label: 'This month', resolve: () => ({ from: `${todayString().slice(0, 7)}-01`, to: todayString() }) },
]

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)

  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}

/** Which quick range, if any, the two date boxes currently describe. */
function matchingRange(from: string, to: string): string | null {
  return RANGES.find((range) => {
    const resolved = range.resolve()

    return resolved.from === from && resolved.to === to
  })?.id ?? null
}

/**
 * The filter bar every board shows.
 *
 * `showTerminal` is off for boards where a till is not the unit of analysis;
 * the rest is identical everywhere, deliberately, so a manager moving between
 * boards is not relearning the controls.
 */
export function DashboardFilterBar({
  filters,
  update,
  showTerminal = true,
  showComparison = true,
}: {
  filters: DashboardFilters
  update: (patch: Partial<DashboardFilters>) => void
  showTerminal?: boolean
  showComparison?: boolean
}) {
  const { session } = usePos()
  const locations = session?.locations ?? []
  const terminals = (session?.terminals ?? []).filter(
    (t) => filters.locationId === null || t.location_id === filters.locationId,
  )

  const activeRange = matchingRange(filters.from, filters.to)

  return (
    <>
      <label className="pos-field pos-field--outlet">
        <span>Outlet</span>
        <select
          value={filters.locationId ?? ''}
          onChange={(e) => update({ locationId: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">All outlets</option>
          {locations.map((location) => (
            <option key={location.location_id} value={location.location_id}>
              {location.display_name ?? location.location_code}
            </option>
          ))}
        </select>
      </label>

      {showTerminal && (
        <label className="pos-field pos-field--counter">
          <span>Counter</span>
          <select
            value={filters.terminalId ?? ''}
            onChange={(e) => update({ terminalId: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">All counters</option>
            {terminals.map((terminal) => (
              <option key={terminal.terminal_id} value={terminal.terminal_id}>
                {terminal.display_name ?? terminal.terminal_code}
              </option>
            ))}
          </select>
        </label>
      )}

      {/*
        A backwards range is never submitted.
        `max`/`min` stop the picker offering one, and the handlers drag the other
        end along when a date is typed instead of picked — because a typed date
        ignores both attributes, and a window whose end precedes its start is a
        query the server has to reject.
      */}
      <label className="pos-field pos-field--from">
        <span>From</span>
        <input
          type="date"
          value={filters.from}
          max={filters.to}
          onChange={(e) => {
            const from = e.target.value
            if (!from) return
            update(from > filters.to ? { from, to: from } : { from })
          }}
        />
      </label>

      <label className="pos-field pos-field--to">
        <span>To</span>
        <input
          type="date"
          value={filters.to}
          min={filters.from}
          onChange={(e) => {
            const to = e.target.value
            if (!to) return
            update(to < filters.from ? { from: to, to } : { to })
          }}
        />
      </label>

      <div className="pos-field pos-field--range">
        <span>Quick range</span>
        <div className="pos-chipset" role="group" aria-label="Quick date ranges">
          {RANGES.map((range) => (
            <button
              key={range.id}
              type="button"
              className="pos-chip"
              aria-pressed={activeRange === range.id}
              onClick={() => update(range.resolve())}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {showComparison && (
        <label className="pos-field pos-field--compare">
          <span>Compare with</span>
          <select value={filters.compare} onChange={(e) => update({ compare: e.target.value as ComparisonMode })}>
            {/*
              Two comparisons, because the server computes two. A longer list
              here would be a list of windows nothing behind this screen knows
              how to build.
            */}
            <option value="none">No comparison</option>
            <option value="previous">The period before</option>
            <option value="same_weekday">The same days last week</option>
          </select>
        </label>
      )}
    </>
  )
}

function todayString(): string {
  const now = new Date()

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}
