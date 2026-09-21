/**
 * The two badges the queue table lives on, and the date helpers beside them.
 *
 * Both badges carry WORDS, never a colour on its own. A till is read under shop
 * lighting, often by someone colour-blind, and "the red one" is not a status.
 */

import { AlertTriangle, Ban, CheckCircle2, CreditCard, RotateCcw, ShoppingCart, UtensilsCrossed } from 'lucide-react'
import type { QueueStatus, QueueType } from '../model'

const TYPE_LABEL: Record<QueueType, string> = {
  SALE: 'Sale',
  RETURN: 'Return',
  PAYMENT: 'Payment',
  ORDER: 'Order',
}

const TYPE_ICON: Record<QueueType, typeof ShoppingCart> = {
  SALE: ShoppingCart,
  RETURN: RotateCcw,
  PAYMENT: CreditCard,
  ORDER: UtensilsCrossed,
}

const TYPE_CLASS: Record<QueueType, string> = {
  SALE: 'q-badge--sale',
  RETURN: 'q-badge--return',
  PAYMENT: 'q-badge--payment',
  ORDER: 'q-badge--order',
}

export function QueueTypeBadge({ type }: { type: QueueType }) {
  const Icon = TYPE_ICON[type]

  return (
    <span className={`q-badge ${TYPE_CLASS[type]}`}>
      <Icon size={12} aria-hidden />
      {TYPE_LABEL[type]}
    </span>
  )
}

export const STATUS_LABEL: Record<QueueStatus, string> = {
  READY: 'Ready to Post',
  POSTING: 'Posting…',
  FAILED: 'Failed',
  NEEDS_ATTENTION: 'Needs Attention',
  POSTED: 'Posted',
  ABANDONED: 'Abandoned',
}

const STATUS_CLASS: Record<QueueStatus, string> = {
  READY: 'q-status--ready',
  POSTING: 'q-status--posting',
  FAILED: 'q-status--failed',
  NEEDS_ATTENTION: 'q-status--attention',
  POSTED: 'q-status--posted',
  ABANDONED: 'q-status--abandoned',
}

export function QueueStatusBadge({ status }: { status: QueueStatus }) {
  return (
    <span className={`q-badge q-status ${STATUS_CLASS[status]}`}>
      {status === 'POSTED' ? (
        <CheckCircle2 size={12} aria-hidden />
      ) : status === 'NEEDS_ATTENTION' ? (
        <AlertTriangle size={12} aria-hidden />
      ) : status === 'ABANDONED' ? (
        <Ban size={12} aria-hidden />
      ) : (
        <span className="q-dot" aria-hidden />
      )}
      {STATUS_LABEL[status]}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * "19 Sep 2026" and "04:12 PM", built by hand rather than by Intl.
 *
 * WHY NOT Intl. Both formats are read off a till a hundred times a shift and
 * have to look identical on every machine in the shop. Intl does not guarantee
 * that: en-IN renders September as "Sept" on a recent ICU and "Sep" on an older
 * one, and lower-cases the meridiem to "pm", so two tills bought a year apart
 * show the same sale differently. These two functions are the one place in this
 * feature where a fixed format is worth more than locale awareness — the
 * MONEY on this screen still goes through Intl, where the locale genuinely
 * matters.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayLabel(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined) return '\u2014'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '\u2014'

  return `${String(when.getDate()).padStart(2, '0')} ${MONTHS[when.getMonth()]} ${when.getFullYear()}`
}

/** "04:12 PM" */
export function timeLabel(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '\u2014'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '\u2014'

  const hours = when.getHours()
  const meridiem = hours >= 12 ? 'PM' : 'AM'
  const twelve = hours % 12 === 0 ? 12 : hours % 12

  return `${String(twelve).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} ${meridiem}`
}

/** "Today, 19 Sep 2026" — the card under the clock on Last Offline. */
export function dayContextLabel(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return 'No offline activity'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'No offline activity'

  const now = new Date()
  const sameDay =
    when.getDate() === now.getDate() && when.getMonth() === now.getMonth() && when.getFullYear() === now.getFullYear()

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const wasYesterday =
    when.getDate() === yesterday.getDate() &&
    when.getMonth() === yesterday.getMonth() &&
    when.getFullYear() === yesterday.getFullYear()

  const prefix = sameDay ? 'Today' : wasYesterday ? 'Yesterday' : ''
  const day = dayLabel(when)

  return prefix ? `${prefix}, ${day}` : day
}
