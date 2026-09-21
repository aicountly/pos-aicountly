/**
 * Formatting for the dashboards.
 *
 * Money is formatted, never computed. Every authoritative total on these
 * screens was summed by PostgreSQL over NUMERIC columns and arrives as a
 * finished figure; these functions put a currency symbol and a thousands
 * separator on it. Where a percentage is derived in the browser it is for
 * drawing a bar, and the number beside the bar is the one the server sent.
 */

export function money(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value)
}

/** The exact figure, for a table cell where rounding to the rupee would hide a variance. */
export function moneyExact(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value)
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  return new Intl.NumberFormat('en-IN').format(value)
}

export function decimal(value: number | null | undefined, places = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: places }).format(value)
}

export function percent(value: number | null | undefined, places = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: places }).format(value)}%`
}

/** "2h 18m", "14m", "48s" — the units a counter actually talks in. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'

  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`

  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)

  return `${hours}h ${minutes % 60}m`
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "4 minutes ago". Relative only where the absolute time is also available. */
export function sinceLabel(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'

  return `${duration((Date.now() - then) / 1000)} ago`
}

/**
 * How this window compares with the one before it.
 *
 * Returns null when there is nothing to compare against, or when the comparison
 * window took nothing — dividing by zero produces Infinity, and "up ∞%" is not
 * a fact about a shop.
 */
export function compare(
  current: number,
  previous: number | null | undefined,
  label: string | null | undefined,
): { label: string; short: string; direction: 'up' | 'down' | 'flat' } | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null

  const change = ((current - previous) / previous) * 100
  const direction = Math.abs(change) < 0.5 ? 'flat' : change > 0 ? 'up' : 'down'
  const words = direction === 'flat' ? 'about the same' : `${direction === 'up' ? 'up' : 'down'} ${percent(Math.abs(change), 0)}`

  return {
    label: `${words} ${label ?? 'vs the comparison period'}`,
    // The chip on a KPI card has room for a figure, not a sentence. The
    // sentence is still what a screen reader is given, and still what the
    // panels that have room for it print.
    short: direction === 'flat' ? 'level' : percent(Math.abs(change), 0),
    direction,
  }
}

/** A person's uuid, shortened for a table cell without pretending it is a name. */
export function actor(uuid: string | null | undefined): string {
  if (!uuid) return '—'

  return uuid.length > 14 ? `${uuid.slice(0, 8)}…` : uuid
}

/** "18 Sep 2026" — the absolute date, with no time on it. */
export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

/** How many whole days ago, or null when there is no date to measure from. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null

  return Math.max(0, Math.floor((Date.now() - then) / 86400000))
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * A rupee figure short enough for a chart axis or a donut's middle.
 *
 * Lakhs and crores, because that is how the figure is said aloud in the shops
 * this runs in — ₹2.35Cr, not ₹23,50,00,000 squeezed under a bar.
 *
 * NEVER USED IN A TABLE, A TOOLTIP OR A TOTAL. Rounding to two significant
 * decimals loses up to ₹4,999 on a crore, which is fine for the height of a bar
 * and not fine anywhere a number is being reconciled. `money` and `moneyExact`
 * are what those cells use.
 */
export function compactMoney(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  const symbol = currency === 'INR' ? '₹' : ''
  const sign = value < 0 ? '-' : ''
  const magnitude = Math.abs(value)

  if (currency !== 'INR') return money(value, currency)
  if (magnitude >= 10000000) return `${sign}${symbol}${trim(magnitude / 10000000)}Cr`
  if (magnitude >= 100000) return `${sign}${symbol}${trim(magnitude / 100000)}L`

  return money(value, currency)
}

function trim(value: number): string {
  // 1.2, not 1.20; 12, not 12.0. A shortened figure with a trailing zero reads
  // like a precision it does not have.
  return value
    .toFixed(value >= 10 ? 1 : 2)
    .replace(/\.?0+$/, '')
}

/** "+12.4%", "-6.0%", "0%". Signed, because the sign is the whole point. */
export function signedPercent(value: number | null | undefined, places = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0%'

  return `${value > 0 ? '+' : '−'}${percent(Math.abs(value), places)}`
}

/**
 * How one figure compares with another, as a percentage change.
 *
 * Null when the base is zero or missing: a change from nothing is not a
 * percentage, and "up ∞%" is not a fact about a shop.
 */
export function changePc(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null

  return ((current - previous) / previous) * 100
}
