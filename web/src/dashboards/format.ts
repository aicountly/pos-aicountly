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
): { label: string; direction: 'up' | 'down' | 'flat' } | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null

  const change = ((current - previous) / previous) * 100
  const direction = Math.abs(change) < 0.5 ? 'flat' : change > 0 ? 'up' : 'down'
  const words = direction === 'flat' ? 'about the same' : `${direction === 'up' ? 'up' : 'down'} ${percent(Math.abs(change), 0)}`

  return { label: `${words} ${label ?? 'vs the comparison period'}`, direction }
}

/** A person's uuid, shortened for a table cell without pretending it is a name. */
export function actor(uuid: string | null | undefined): string {
  if (!uuid) return '—'

  return uuid.length > 14 ? `${uuid.slice(0, 8)}…` : uuid
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
