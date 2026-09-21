/**
 * Formatting for the Shift Report.
 *
 * Money is formatted, never computed. Every authoritative figure on this screen
 * was summed by PostgreSQL over NUMERIC columns and arrives finished; these
 * functions put a currency symbol and Indian digit grouping on it.
 *
 * TIMES ARE THE OUTLET'S, NOT THE READER'S. A manager in Dubai looking at a
 * Mumbai shift has to see the hours that shift was worked, so every clock here
 * takes the outlet's timezone rather than the browser's. Getting this wrong
 * moves a 9am open to 7:30am and makes the whole report unreadable to the one
 * person it is for.
 */

import { moneyExact } from '../dashboards/format'

export { money, moneyExact, count, percent } from '../dashboards/format'

export function safeNumber(value: number | null | undefined): number {
  const parsed = Number(value ?? 0)

  return Number.isFinite(parsed) ? parsed : 0
}

/** "8h 00m", "45m". A shift that has not run yet is 0m, not a dash. */
export function durationLabel(minutes: number | null | undefined): string {
  const total = Math.max(0, Math.round(safeNumber(minutes)))
  if (total < 60) return `${total}m`

  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

function zoned(timeZone: string | undefined): Intl.DateTimeFormatOptions {
  return timeZone ? { timeZone } : {}
}

/** "09:00 AM", in the outlet's clock. */
export function clockLabel(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'

  // en-IN renders the day period lower case; on a cash record it is AM and PM.
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...zoned(timeZone),
  })
    .format(at)
    .replace(/\b(am|pm)\b/gi, (period) => period.toUpperCase())
}

/** "Mon, 26 May 2026". Takes a business date (YYYY-MM-DD), which has no zone. */
export function businessDateLabel(date: string | null | undefined): string {
  if (!date) return '—'
  const at = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(at.getTime())) return date

  // en-GB rather than en-IN for this one label: both are day-month-year, but
  // en-IN puts a second comma in front of the year ("Tue, 26 May, 2026").
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at)
}

/** "26 May 2026, 05:02 PM" — the freshness line. */
export function stampLabel(iso: string | Date | null | undefined, timeZone?: string): string {
  if (!iso) return '—'
  const at = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...zoned(timeZone),
  })
    .format(at)
    .replace(/\b(am|pm)\b/gi, (period) => period.toUpperCase())
}

export type DeltaTone = 'good' | 'bad' | 'flat'

export interface Delta {
  direction: 'up' | 'down' | 'flat'
  tone: DeltaTone
  label: string
  /** The whole thing in words, for a screen reader and for the print copy. */
  description: string
}

/**
 * A percentage change, and whether it is good news.
 *
 * DIRECTION AND TONE ARE SEPARATE, which is the whole point. Refunds falling
 * 42% is a fall and a win; discounts rising 8% is a rise and a cost. A screen
 * that painted every arrow-up green would tell a manager that a shift with more
 * voids went well.
 *
 * Null means there is nothing to compare against — no previous shift, or one
 * that took nothing. "Up ∞%" is not a fact about a shop.
 */
export function delta(pct: number | null | undefined, higherIsBetter: boolean, label: string): Delta | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null

  const rounded = Math.round(pct * 10) / 10
  const direction = Math.abs(rounded) < 0.05 ? 'flat' : rounded > 0 ? 'up' : 'down'
  const tone: DeltaTone =
    direction === 'flat' ? 'flat' : (direction === 'up') === higherIsBetter ? 'good' : 'bad'

  const figure = `${Math.abs(rounded).toFixed(Math.abs(rounded) % 1 === 0 ? 0 : 1)}%`
  const text = direction === 'flat' ? 'No change' : `${direction === 'up' ? 'Up' : 'Down'} ${figure}`

  return {
    direction,
    tone,
    label: direction === 'flat' ? 'No change' : `${direction === 'up' ? '↑' : '↓'} ${figure}`,
    description: `${text} ${label}`,
  }
}

/** The KPI value, formatted the way that KPI is read. */
export function metricValue(kind: 'money' | 'count', value: number | null | undefined): string {
  return kind === 'money' ? moneyExact(safeNumber(value)) : new Intl.NumberFormat('en-IN').format(safeNumber(value))
}

/** The rounded form, for a chart centre or an axis where the paise are noise. */
export function compactMoney(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(safeNumber(value))
}
