/**
 * The vocabulary the Customers & Growth screen uses.
 *
 * Every threshold a customer is judged by — how many visits make a regular, how
 * many quiet days make a lapsed one — comes from the server on `board.rules`
 * and is NOT duplicated here. What lives in this file is presentation: the
 * order of the tabs, the words on a badge, how long to wait before searching.
 *
 * That split is the point. When the shop configures its own lapse window, the
 * server changes and this screen follows without an edit.
 */

import type { BadgeTone } from '../shell'
import type { CustomerTab, CustomerType } from '../types'

/** Rows per page. Server-side — the browser never holds more than this. */
export const CUSTOMER_PAGE_SIZE = 25

/**
 * How long a cashier stops typing before the roster is asked for again.
 *
 * Long enough that "Sneha" is one request rather than five, short enough that
 * it never feels like waiting.
 */
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300

export const CUSTOMER_TABS: Array<{ id: CustomerTab; label: string; hint: string }> = [
  { id: 'all', label: 'All', hint: 'Everyone who bought in this period' },
  { id: 'new', label: 'New', hint: 'Their first bill on this POS fell in this period' },
  { id: 'repeat', label: 'Repeat', hint: 'More than one bill inside this period' },
  { id: 'inactive', label: 'Lapsed', hint: 'No bill for a while — measured from today, not from this period' },
]

export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  new: 'New',
  loyal: 'Regular',
  regular: 'Returning',
  at_risk: 'Slipping away',
  one_time: 'Bought once',
}

/**
 * The badge tone per standing.
 *
 * The words carry the meaning; the tone only reinforces it, which is why every
 * badge on this screen renders its label rather than a coloured dot.
 */
export const CUSTOMER_TYPE_TONE: Record<CustomerType, BadgeTone> = {
  new: 'info',
  loyal: 'success',
  regular: 'neutral',
  at_risk: 'warning',
  one_time: 'neutral',
}

export const CUSTOMER_SORTS: Array<{ id: string; label: string }> = [
  { id: 'last_visit', label: 'Last visit' },
  { id: 'spend', label: 'Total spent' },
  { id: 'visits', label: 'Total visits' },
  { id: 'name', label: 'Name' },
]

/** What "By revenue / by customers" measures a segment or an outlet by. */
export type SegmentMode = 'revenue' | 'customers'
export type OutletMetric = 'customers' | 'repeat' | 'revenue'
