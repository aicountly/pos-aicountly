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

import { useId, useMemo } from 'react'
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
  { id: 'overview', label: 'Business Overview', path: '/overview', permissions: ['reports.view'], modes: [] },
  {
    id: 'retail',
    label: 'Retail Operations',
    path: '/retail',
    permissions: ['reports.view', 'sell'],
    modes: ['retail', 'quick_service', 'hybrid'],
  },
  {
    id: 'restaurant',
    label: 'Restaurant Operations',
    path: '/restaurant',
    permissions: ['reports.view', 'table.open', 'kds.operate'],
    modes: ['restaurant', 'quick_service', 'hybrid'],
  },
  { id: 'customers', label: 'Customers & Growth', path: '/customers', permissions: ['reports.view'], modes: [] },
  {
    id: 'controls',
    label: 'Cash, Shifts & Controls',
    path: '/controls',
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
    }).map(({ id, label, path }) => ({ id, label, path }))
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

const RANGES: Array<{ id: string; label: string; days: number }> = [
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: 'Last 7 days', days: 6 },
  { id: '30d', label: 'Last 30 days', days: 29 },
]

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)

  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
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
  comparisonAs = 'select',
}: {
  filters: DashboardFilters
  update: (patch: Partial<DashboardFilters>) => void
  showTerminal?: boolean
  showComparison?: boolean
  /** A switch on the operations boards, a select where two comparisons matter. */
  comparisonAs?: 'select' | 'toggle'
}) {
  const id = useId()
  const { session } = usePos()
  const locations = session?.locations ?? []
  const terminals = (session?.terminals ?? []).filter(
    (t) => filters.locationId === null || t.location_id === filters.locationId,
  )

  const active = activeRangeId(filters)

  return (
    <>
      <label className="pos-field">
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
        <label className="pos-field">
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

      <label className="pos-field">
        <span>From</span>
        <input
          type="date"
          value={filters.from}
          max={filters.to}
          onChange={(e) => e.target.value && update({ from: e.target.value })}
        />
      </label>

      <label className="pos-field">
        <span>To</span>
        <input
          type="date"
          value={filters.to}
          min={filters.from}
          onChange={(e) => e.target.value && update({ to: e.target.value })}
        />
      </label>

      <div className="pos-field">
        <span id={`${id}-quick`}>Quick range</span>
        <div className="pos-segmented" role="group" aria-labelledby={`${id}-quick`}>
          {RANGES.map((range) => (
            <button
              key={range.id}
              type="button"
              aria-pressed={active === range.id}
              onClick={() => {
                const to = todayString()
                update({ from: shift(to, -range.days), to })
              }}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {/*
       * Two shapes of the same control.
       *
       * The switch is for boards where "against the period before" is the only
       * comparison a manager reaches for; the select is for boards where the
       * same days last week is a real question. Both write the same filter, and
       * neither invents the window — Window::comparison decides that, and the
       * label here says out loud which one it will be.
       */}
      {showComparison && comparisonAs === 'toggle' && (
        <div className="pos-field">
          <span>Compare</span>
          <label className="pos-switch">
            <input
              type="checkbox"
              checked={filters.compare !== 'none'}
              onChange={(e) => update({ compare: e.target.checked ? 'previous' : 'none' })}
            />
            <span className="pos-switch__track" aria-hidden />
            <span>{previousWindowLabel(filters)}</span>
          </label>
        </div>
      )}

      {showComparison && comparisonAs === 'select' && (
        <label className="pos-field">
          <span>Compare with</span>
          <select
            value={filters.compare}
            onChange={(e) => update({ compare: e.target.value as ComparisonMode })}
          >
            <option value="none">No comparison</option>
            <option value="previous">The period before</option>
            <option value="same_weekday">The same days last week</option>
          </select>
        </label>
      )}
    </>
  )
}

/** Inclusive span: 2026-03-01..2026-03-01 is one day. */
function spanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 1

  return Math.max(1, Math.round((b - a) / 86_400_000) + 1)
}

/**
 * What the switch will compare against, said before it is switched on.
 *
 * It mirrors `compare=previous` on the server exactly — the same number of
 * days immediately before this window — so the label cannot drift away from
 * the figures.
 */
function previousWindowLabel(filters: DashboardFilters): string {
  const days = spanDays(filters.from, filters.to)

  return days === 1 ? 'with the day before' : `with the previous ${days} days`
}

/**
 * Which preset, if any, the current dates are.
 *
 * The old version only ever matched Today, so Last 7 days and Last 30 days
 * never lit up however they were reached.
 */
function activeRangeId(filters: DashboardFilters): string | null {
  const today = todayString()
  if (filters.to !== today) return null

  return RANGES.find((range) => filters.from === shift(today, -range.days))?.id ?? null
}

function todayString(): string {
  const now = new Date()

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}
