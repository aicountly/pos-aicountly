/**
 * The control strip.
 *
 * Outlet, counter and dates are SERVER filters: they live in the URL, go to the
 * endpoint, and change what is fetched. The three under "More filters" are
 * CLIENT filters over the board that was fetched — the controls endpoint takes
 * no cashier, shift-status or variance parameter, so narrowing by them here
 * would otherwise mean inventing query parameters the API ignores. They are in
 * the URL too, so a narrowed view is still a link someone can send.
 *
 * That distinction is stated on screen rather than hidden, because a filter
 * that silently applies to only part of the data is how a manager comes to
 * believe a figure that is not there.
 */

import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Filter, X } from 'lucide-react'
import { usePos } from '../../context/PosContext'
import { actor } from '../format'
import type { DashboardFilters } from '../useDashboard'

export interface AdvancedFilters {
  /** A `pos_register_sessions.status` value, or '' for all. */
  shiftStatus: string
  /** An `opened_by` uuid, or '' for all. */
  cashier: string
  variance: '' | 'short' | 'over' | 'balanced' | 'uncounted'
}

export const EMPTY_ADVANCED: AdvancedFilters = { shiftStatus: '', cashier: '', variance: '' }

const VARIANCE_OPTIONS: Array<{ value: AdvancedFilters['variance']; label: string }> = [
  { value: '', label: 'Any variance' },
  { value: 'short', label: 'Short' },
  { value: 'over', label: 'Over' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'uncounted', label: 'Not counted' },
]

const SHIFT_STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'OPEN', label: 'Open' },
  { value: 'CLOSING', label: 'Closing' },
  { value: 'CLOSED', label: 'Closed' },
]

function isVariance(value: string): value is AdvancedFilters['variance'] {
  return value === '' || value === 'short' || value === 'over' || value === 'balanced' || value === 'uncounted'
}

export function useAdvancedFilters() {
  const [params, setParams] = useSearchParams()

  const advanced = useMemo<AdvancedFilters>(() => {
    const variance = params.get('variance') ?? ''

    return {
      shiftStatus: params.get('shift_status') ?? '',
      cashier: params.get('cashier') ?? '',
      variance: isVariance(variance) ? variance : '',
    }
  }, [params])

  const setAdvanced = useCallback(
    (patch: Partial<AdvancedFilters>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          const set = (key: string, value: string | undefined) => {
            if (value === undefined) return
            if (value === '') next.delete(key)
            else next.set(key, value)
          }

          set('shift_status', patch.shiftStatus)
          set('cashier', patch.cashier)
          set('variance', patch.variance)

          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const activeCount = useMemo(
    () => [advanced.shiftStatus, advanced.cashier, advanced.variance].filter((value) => value !== '').length,
    [advanced],
  )

  return { advanced, setAdvanced, activeCount }
}

// ---------------------------------------------------------------------------
// Quick ranges
// ---------------------------------------------------------------------------

function iso(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

function daysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)

  return iso(date)
}

function monthStart(): string {
  const now = new Date()

  return iso(new Date(now.getFullYear(), now.getMonth(), 1))
}

export type QuickRangeId = 'today' | '7d' | '30d' | 'month' | 'custom'

const QUICK_RANGES: Array<{ id: Exclude<QuickRangeId, 'custom'>; label: string; from: () => string; to: () => string }> = [
  { id: 'today', label: 'Today', from: () => daysAgo(0), to: () => daysAgo(0) },
  { id: '7d', label: 'Last 7 days', from: () => daysAgo(6), to: () => daysAgo(0) },
  { id: '30d', label: 'Last 30 days', from: () => daysAgo(29), to: () => daysAgo(0) },
  { id: 'month', label: 'This month', from: monthStart, to: () => daysAgo(0) },
]

/** The dates a preset stands for, so another widget can apply the same range. */
export function applyQuickRange(id: Exclude<QuickRangeId, 'custom'>): { from: string; to: string } {
  const range = QUICK_RANGES.find((option) => option.id === id) ?? QUICK_RANGES[0]

  return { from: range.from(), to: range.to() }
}

/** Which preset the current dates correspond to, if any. */
export function activeQuickRange(filters: DashboardFilters): QuickRangeId {
  for (const range of QUICK_RANGES) {
    if (filters.from === range.from() && filters.to === range.to()) return range.id
  }

  return 'custom'
}

/** "Today", or the span in words, for the figures that need saying which period they are. */
export function periodLabel(filters: DashboardFilters): string {
  const range = activeQuickRange(filters)
  const found = QUICK_RANGES.find((option) => option.id === range)
  if (found) return found.label

  const format = (value: string) =>
    new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })

  return filters.from === filters.to ? format(filters.from) : `${format(filters.from)} – ${format(filters.to)}`
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

export function CashControlsFilters({
  filters,
  update,
  advanced,
  setAdvanced,
  advancedCount,
  cashiers,
  open,
  onToggle,
}: {
  filters: DashboardFilters
  update: (patch: Partial<DashboardFilters>) => void
  advanced: AdvancedFilters
  setAdvanced: (patch: Partial<AdvancedFilters>) => void
  advancedCount: number
  /** The cashiers who actually appear in the loaded board. */
  cashiers: string[]
  open: boolean
  onToggle: () => void
}) {
  const { session } = usePos()
  const locations = session?.locations ?? []
  const terminals = (session?.terminals ?? []).filter(
    (terminal) => filters.locationId === null || terminal.location_id === filters.locationId,
  )
  const active = activeQuickRange(filters)

  return (
    <section className="cc-filters" aria-label="Filters">
      <div className="cc-filters__row">
        <label className="cc-field">
          <span>Outlet</span>
          <select
            value={filters.locationId ?? ''}
            onChange={(event) => update({ locationId: event.target.value === '' ? null : Number(event.target.value) })}
          >
            <option value="">All outlets</option>
            {locations.map((location) => (
              <option key={location.location_id} value={location.location_id}>
                {location.display_name ?? location.location_code}
              </option>
            ))}
          </select>
        </label>

        <label className="cc-field">
          <span>Counter</span>
          <select
            value={filters.terminalId ?? ''}
            onChange={(event) => update({ terminalId: event.target.value === '' ? null : Number(event.target.value) })}
          >
            <option value="">All counters</option>
            {terminals.map((terminal) => (
              <option key={terminal.terminal_id} value={terminal.terminal_id}>
                {terminal.display_name ?? terminal.terminal_code}
              </option>
            ))}
          </select>
        </label>

        <label className="cc-field">
          <span>From</span>
          <input
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(event) => event.target.value && update({ from: event.target.value })}
          />
        </label>

        <label className="cc-field">
          <span>To</span>
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(event) => event.target.value && update({ to: event.target.value })}
          />
        </label>

        <div className="cc-field">
          <span id="cc-range-label">Quick range</span>
          <div className="cc-ranges" role="group" aria-labelledby="cc-range-label">
            {QUICK_RANGES.map((range) => (
              <button
                key={range.id}
                type="button"
                className="cc-range"
                aria-pressed={active === range.id}
                onClick={() => update({ from: range.from(), to: range.to() })}
              >
                {range.label}
              </button>
            ))}
            {/* Not a preset — it is what the dates say when no preset matches,
                and pressing it puts the focus where a custom range is typed. */}
            <button
              type="button"
              className="cc-range"
              aria-pressed={active === 'custom'}
              onClick={() => {
                const field = document.querySelector<HTMLInputElement>('.cc-filters input[type="date"]')
                field?.focus()
              }}
            >
              Custom
            </button>
          </div>
        </div>

        <div className="cc-filters__spacer">
          <button type="button" className="cc-more" aria-expanded={open} aria-controls="cc-advanced" onClick={onToggle}>
            <Filter size={14} aria-hidden />
            More filters
            {advancedCount > 0 && <span className="cc-pill cc-pill--success">{advancedCount}</span>}
          </button>
        </div>
      </div>

      {open && (
        <div className="cc-advanced" id="cc-advanced">
          <label className="cc-field">
            <span>Shift status</span>
            <select value={advanced.shiftStatus} onChange={(event) => setAdvanced({ shiftStatus: event.target.value })}>
              {SHIFT_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="cc-field">
            <span>Cashier</span>
            <select value={advanced.cashier} onChange={(event) => setAdvanced({ cashier: event.target.value })}>
              <option value="">Any cashier</option>
              {cashiers.map((uuid) => (
                <option key={uuid} value={uuid}>
                  {actor(uuid)}
                </option>
              ))}
            </select>
          </label>

          <label className="cc-field">
            <span>Variance</span>
            <select
              value={advanced.variance}
              onChange={(event) => isVariance(event.target.value) && setAdvanced({ variance: event.target.value })}
            >
              {VARIANCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {advancedCount > 0 && (
            <button
              type="button"
              className="pos-button pos-button--quiet pos-button--small"
              onClick={() => setAdvanced(EMPTY_ADVANCED)}
            >
              <X size={14} aria-hidden /> Clear
            </button>
          )}

          <p className="cc-advanced__note">
            These three narrow the shift register below on the board already loaded. Outlet, counter and dates are sent
            to the server and change what is fetched.
          </p>
        </div>
      )}
    </section>
  )
}
