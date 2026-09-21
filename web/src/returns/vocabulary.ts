/**
 * The words this screen puts on the server's codes.
 *
 * Every map here is a PRESENTATION of an enum the API already defines. Adding a
 * code to a map does not create it; a code the server sends that is not in a map
 * is shown, humanised, rather than hidden — a screen that silently drops a row
 * because it did not recognise its status is worse than one that says
 * "store_credit" in plain words.
 */

import type { BadgeTone } from '../dashboards/shell'
import { titleCase } from '../dashboards/format'
import type { ReturnResolution, ReturnStatus } from './types'

export interface Term {
  label: string
  /** The one line that says what it means, where the label cannot say it alone. */
  description?: string
  tone?: BadgeTone
}

/**
 * Status colours follow what the status MEANS, matching the rest of the POS:
 * anything waiting on a person is amber, anything finished is green, anything
 * stopped is neutral. Colour never carries the meaning on its own — every badge
 * has the word in it.
 */
export const STATUS_TERMS: Record<ReturnStatus, Term> = {
  DRAFT: { label: 'Draft', tone: 'warning', description: 'Taken at the counter, waiting for approval' },
  APPROVED: { label: 'Approved', tone: 'info', description: 'Approved; the goods have not been booked in yet' },
  RECEIVED: { label: 'Goods received', tone: 'info', description: 'Back in stock; the credit note is still to be raised' },
  SETTLED: { label: 'Completed', tone: 'success', description: 'Credit note raised and the customer settled' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', description: 'Abandoned at the counter' },
}

/** The statuses that are still waiting on somebody. Drives the Pending tab. */
export const PENDING_STATUSES: ReturnStatus[] = ['DRAFT', 'APPROVED', 'RECEIVED']

export const RESOLUTION_TERMS: Record<ReturnResolution, Term & { kind: 'refund' | 'exchange' }> = {
  refund_cash: { label: 'Cash refund', kind: 'refund', tone: 'success', description: 'Cash handed back out of the drawer' },
  refund_original: {
    label: 'Original mode',
    kind: 'refund',
    tone: 'success',
    description: 'Refunded the way it was paid, on the external terminal',
  },
  credit_note: { label: 'Credit note', kind: 'refund', tone: 'info', description: 'Left as a credit against the account' },
  store_credit: { label: 'Store credit', kind: 'refund', tone: 'info', description: 'Held as credit to spend in the shop' },
  exchange: { label: 'Exchange', kind: 'exchange', tone: 'info', description: 'Replaced with other goods' },
}

/** Everything that gives money or credit back. The Refunds tab, and what it counts. */
export const REFUND_RESOLUTIONS: ReturnResolution[] = ['refund_cash', 'refund_original', 'credit_note', 'store_credit']

export const CONDITION_TERMS: Record<string, Term> = {
  good: { label: 'Resaleable', description: 'Goes back on the shelf' },
  damaged: { label: 'Damaged', description: 'Received, but not resaleable' },
  expired: { label: 'Expired', description: 'Received and written off' },
  wrong_item: { label: 'Wrong item', description: 'Not what was billed' },
}

/**
 * Where the sale came from.
 *
 * These are the order kinds the till records, not a channel list invented for a
 * chart. `unlinked` is the server's word for a return taken against a paper
 * invoice, which genuinely has no channel.
 */
export const CHANNEL_TERMS: Record<string, Term> = {
  retail: { label: 'In-store' },
  dine_in: { label: 'Dine-in' },
  takeaway: { label: 'Takeaway' },
  delivery: { label: 'Delivery' },
  pickup: { label: 'Pickup' },
  qr_order: { label: 'QR order' },
  kiosk: { label: 'Kiosk' },
  unlinked: { label: 'No linked sale', description: 'Taken against an invoice this till did not raise' },
}

/**
 * The reasons a cashier may pick.
 *
 * `unspecified` is read-only: it is what the server calls a return whose reason
 * nobody recorded, and it is offered nowhere as a choice.
 */
export const REASON_TERMS: Record<string, Term> = {
  size_fit: { label: 'Size or fit issue' },
  damaged: { label: 'Damaged item' },
  changed_mind: { label: 'Customer changed mind' },
  wrong_item: { label: 'Wrong item billed' },
  defective: { label: 'Defective product' },
  expired: { label: 'Expired or near expiry' },
  not_as_described: { label: 'Not as described' },
  other: { label: 'Other' },
  unspecified: { label: 'Not stated', description: 'No reason was recorded against this return' },
}

/** What the new-return flow offers, in the order a counter asks them. */
export const REASON_CHOICES = [
  'size_fit',
  'damaged',
  'defective',
  'wrong_item',
  'changed_mind',
  'expired',
  'not_as_described',
  'other',
] as const

/**
 * The donut and dot colours.
 *
 * Six hues, assigned by position rather than by meaning: a reason has no
 * inherent colour, and the legend beside the chart carries the label. The chart
 * is never the only way to read the figures.
 */
export const SLICE_COLOURS = ['#3478e5', '#dc4c54', '#f49a27', '#25b003', '#7448ea', '#78869a']

export function termFor(map: Record<string, Term>, code: string | null | undefined): Term {
  if (!code) return { label: '—' }

  return map[code] ?? { label: titleCase(code) }
}

export function labelFor(map: Record<string, Term>, code: string | null | undefined): string {
  return termFor(map, code).label
}

/** Refund or exchange, in one word, for the type column and the tabs. */
export function resolutionKind(resolution: ReturnResolution): 'refund' | 'exchange' {
  return RESOLUTION_TERMS[resolution]?.kind ?? 'refund'
}
