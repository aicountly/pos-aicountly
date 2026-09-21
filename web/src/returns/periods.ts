/**
 * The windows this screen offers, and how to recognise the one you are in.
 *
 * The range itself is two dates in the URL, so a custom window is as much a
 * first-class state as a preset — the presets are shortcuts to a range, never a
 * separate mode the rest of the page has to know about.
 */

import { daysAgo, today } from './useReturnsRegister'

export interface Period {
  id: string
  label: string
  range: () => { from: string; to: string }
}

function isoDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

export const PERIODS: Period[] = [
  { id: '7d', label: 'Last 7 days', range: () => ({ from: daysAgo(6), to: today() }) },
  { id: '30d', label: 'Last 30 days', range: () => ({ from: daysAgo(29), to: today() }) },
  {
    id: 'this_month',
    label: 'This month',
    range: () => {
      const now = new Date()

      return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: today() }
    },
  },
  {
    id: 'last_month',
    label: 'Last month',
    range: () => {
      const now = new Date()

      return {
        from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
      }
    },
  },
  { id: '90d', label: 'Last 90 days', range: () => ({ from: daysAgo(89), to: today() }) },
]

/** Which preset the current range is, or null when somebody picked their own dates. */
export function periodFor(from: string, to: string): Period | null {
  return (
    PERIODS.find((period) => {
      const range = period.range()

      return range.from === from && range.to === to
    }) ?? null
  )
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
const DAY_FORMAT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })

export function formatDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`)

  return Number.isNaN(parsed.getTime()) ? iso : DATE_FORMAT.format(parsed)
}

export function formatDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`)

  return Number.isNaN(parsed.getTime()) ? iso : DAY_FORMAT.format(parsed)
}

export function formatRange(from: string, to: string): string {
  return from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`
}
