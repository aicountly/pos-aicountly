/**
 * One shape for a queued transaction, whichever side of the line it is stuck on.
 *
 * WHY THIS FILE EXISTS. A sale that has not reached the books can be in one of
 * two places, and they fail differently:
 *
 *   ON THIS TILL    it is in the browser's outbox. Nothing has seen it but this
 *                   machine. What it needs is a connection.
 *   ON THE SERVER   it arrived, and something stopped it going into the books —
 *                   a closed period, a customer that no longer exists. What it
 *                   needs is a person.
 *
 * The old screen showed those as two tables and left the cashier to work out
 * which was which. They are the same question ("is my money in?") so they are
 * one list here, keyed on the uuid the device minted. When both sides hold the
 * same uuid, THE SERVER WINS on status — it is the authority — and the device's
 * copy is used only to fill in the things the server's queue endpoint does not
 * return (amount, customer, line count), because those live in the payload.
 *
 * Nothing here computes money that the books will later disagree with: the
 * amount shown is the sum of the tenders the cashier took, which is what the
 * device recorded, labelled as such.
 */

import type { OfflineSubmission } from '../services/types'
import type { OutboxSale } from './db'

// ---------------------------------------------------------------------------
// The vocabulary the screen speaks
// ---------------------------------------------------------------------------

/**
 * What the cashier is told, which is deliberately NOT the raw database status.
 *
 * READY and FAILED are both QUEUED in the outbox; the difference is whether we
 * have tried. That distinction is the whole reason a cashier can tell "the shop
 * is offline" from "this one sale is in trouble".
 */
export type QueueStatus = 'READY' | 'POSTING' | 'FAILED' | 'NEEDS_ATTENTION' | 'POSTED' | 'ABANDONED'

export type QueueType = 'SALE' | 'RETURN' | 'PAYMENT' | 'ORDER'

export type QueueOrigin = 'device' | 'server'

export interface ValidationIssue {
  code: string
  problem: string
  resolution: string
}

export interface QueueRecord {
  /** The uuid the device minted. The idempotency key, and the join between sides. */
  clientUuid: string
  origin: QueueOrigin
  submissionId: number | null

  type: QueueType
  reference: string
  customer: string
  /** Null when this till never held the payload — another terminal's sale. */
  amount: number | null
  lines: number | null

  createdAt: string
  status: QueueStatus
  attempts: number
  lastAttemptAt: string | null

  lastErrorMessage: string | null
  lastErrorCode: string | null

  terminalId: number | null
  deviceUuid: string | null
  sessionId: number | null

  serverReference: number | null
  serverAcknowledgedAt: string | null

  /** Set when the payload itself cannot post. Blocks it from any bulk send. */
  validation: ValidationIssue | null

  /** True when this device still owes the server this sale. */
  sendableFromHere: boolean
}

// ---------------------------------------------------------------------------
// Reading a device payload
// ---------------------------------------------------------------------------

/** What the cashier actually took. Tenders, not a re-derived invoice total. */
export function saleAmount(sale: OutboxSale): number {
  return (sale.payments ?? []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
}

function saleLineTotal(sale: OutboxSale): number {
  return (sale.lines ?? []).reduce((sum, line) => {
    const gross = (Number(line.quantity) || 0) * (Number(line.rate) || 0)
    return sum + gross - (Number(line.discount_amount) || 0)
  }, 0)
}

/**
 * What KIND of document this is — not which counter it came from.
 *
 * order_kind ('retail', 'dine_in', 'delivery') is a CHANNEL, and an earlier
 * cut of this used it to label dine-in bills as "Order". That is wrong: a
 * table's bill is a sale, and calling it something else made the Type column
 * disagree with the books it posts into. The channel is already visible in the
 * Customer / Table column, which is where it belongs.
 */
export function saleType(sale: OutboxSale): QueueType {
  if (saleAmount(sale) < 0) return 'RETURN'
  // No items but money taken is a receipt against an account, not a sale.
  if ((sale.lines ?? []).length === 0 && (sale.payments ?? []).length > 0) return 'PAYMENT'
  return 'SALE'
}

/**
 * A short, stable handle for a sale that has no invoice number yet.
 *
 * It has none because numbers come from the series on the server, and a device
 * that minted its own would collide with another till the moment both came
 * back. So the screen shows the device's own uuid, shortened — enough for a
 * cashier to read one out over the phone, and it matches what support sees.
 */
export function shortUuid(uuid: string): string {
  // The TAIL, not the head. A v4 uuid's leading characters carry the version
  // and variant nibbles nearby and read alike at a glance; the last six are
  // plain random and make two handles easy to tell apart when one is being
  // read out over a phone.
  const hex = uuid.replace(/-/g, '')
  return `OFF-${(hex.length >= 6 ? hex.slice(-6) : hex).toUpperCase()}`
}

/**
 * The handle shown in the Reference column.
 *
 * Always the device's own uuid, never the table token: the token is already in
 * the Customer / Table column beside it, and a row reading "T5 … Table T5" uses
 * a column to say nothing. It is also NOT an invoice number, because this sale
 * does not have one yet — numbers come from the series on the server
 * (Domain/NumberSeries.php), and a device that invented one would collide with
 * every other till the moment they all reconnected. Once it posts, the row is
 * the server's and shows the real reference.
 */
function saleReference(sale: OutboxSale): string {
  return shortUuid(sale.client_uuid)
}

function saleCustomer(sale: OutboxSale): string {
  const name = sale.customer_name?.trim()
  if (name) return name
  if (sale.token_no?.trim() && sale.order_kind !== 'retail') return `Table ${sale.token_no.trim()}`
  return 'Walk-in Customer'
}

// ---------------------------------------------------------------------------
// Validation — the gate in front of every bulk send
// ---------------------------------------------------------------------------

/**
 * Can this payload post at all?
 *
 * Checked BEFORE anything is sent, because a payload the server is certain to
 * refuse should not consume a retry, and should not sit in "Failed" pretending
 * a better connection would fix it. Anything that fails here is Needs
 * Attention: a person has to look at it.
 *
 * These mirror the server's own refusals (CheckoutService::buildOfflineCart
 * rejects a sale with no lines) rather than inventing new rules — a UI that
 * validates more strictly than the server blocks sales the books would accept.
 */
export function validateSale(sale: OutboxSale): ValidationIssue | null {
  if (!sale.client_uuid) {
    return {
      code: 'no_uuid',
      problem: 'This record has no identifier, so it cannot be sent safely.',
      resolution: 'Export the diagnostics from the menu on this row and send them to support. Do not re-key the sale until support has checked whether it already posted.',
    }
  }

  if ((sale.lines ?? []).length === 0) {
    return {
      code: 'no_lines',
      problem: 'There are no items on this sale, so there is nothing to bill.',
      resolution: 'This is almost always an interrupted checkout. Check the shift report for a matching takeaway, then ring the sale again if it is genuinely missing.',
    }
  }

  if ((sale.payments ?? []).length === 0) {
    return {
      code: 'no_payment',
      problem: 'No payment was recorded against this sale.',
      resolution: 'Confirm with the cashier how it was paid, then ring it again with the correct tender. This one cannot post without a payment.',
    }
  }

  if (!Number.isFinite(saleAmount(sale))) {
    return {
      code: 'bad_amount',
      problem: 'The amount on this sale is not a number.',
      resolution: 'The record is damaged. Export the diagnostics and send them to support before re-keying it.',
    }
  }

  if (Number.isNaN(Date.parse(sale.client_created_at))) {
    return {
      code: 'bad_date',
      problem: 'This sale has no usable date, so the books cannot decide which period it belongs to.',
      resolution: 'Export the diagnostics and send them to support. They can place it in the right period by hand.',
    }
  }

  // A tender that does not cover the items is not automatically wrong — a
  // deposit or a part payment is legitimate — so this warns rather than blocks
  // only when the gap is large enough to be a mistake rather than a rounding.
  const gap = saleLineTotal(sale) - saleAmount(sale)
  if (sale.order_kind === 'retail' && gap > 0.5) {
    return {
      code: 'short_paid',
      problem: `The items come to more than the payment taken — ${gap.toFixed(2)} is unaccounted for.`,
      resolution: 'Check the receipt against the till. If part payment was intended this is fine and support can release it; otherwise ring the balance.',
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Turning both sides into one list
// ---------------------------------------------------------------------------

/**
 * How many times we let the machine try on its own before it stops and asks.
 *
 * Retrying forever is how a real failure hides: the row keeps saying "will try
 * again" and nobody ever looks at it. After this many attempts the sale is
 * moved in front of a person, and manual retry still works.
 */
export const MAX_AUTO_ATTEMPTS = 6

function deviceStatus(sale: OutboxSale, validation: ValidationIssue | null): QueueStatus {
  if (validation) return 'NEEDS_ATTENTION'
  if (sale.status === 'SENDING') return 'POSTING'
  if (sale.status === 'CONFLICT') return 'NEEDS_ATTENTION'
  if (sale.attempts >= MAX_AUTO_ATTEMPTS && sale.lastError) return 'NEEDS_ATTENTION'
  if (sale.attempts > 0 && sale.lastError) return 'FAILED'
  return 'READY'
}

function serverStatus(row: OfflineSubmission): QueueStatus {
  switch (row.status) {
    case 'POSTED':
      return 'POSTED'
    case 'ABANDONED':
      return 'ABANDONED'
    case 'CONFLICT':
      return 'NEEDS_ATTENTION'
    default:
      // RECEIVED: the server holds it and will try again. If it has already
      // failed at least once, say so rather than implying it is on its way.
      return row.last_error ? 'FAILED' : 'POSTING'
  }
}

function fromDevice(sale: OutboxSale): QueueRecord {
  const validation = validateSale(sale)

  return {
    clientUuid: sale.client_uuid,
    origin: 'device',
    submissionId: null,
    type: saleType(sale),
    reference: saleReference(sale),
    customer: saleCustomer(sale),
    amount: saleAmount(sale),
    lines: (sale.lines ?? []).length,
    createdAt: sale.client_created_at,
    status: deviceStatus(sale, validation),
    attempts: sale.attempts ?? 0,
    lastAttemptAt: sale.lastAttemptAt ? new Date(sale.lastAttemptAt).toISOString() : null,
    lastErrorMessage: sale.lastError ?? null,
    lastErrorCode: sale.lastErrorCode ?? null,
    terminalId: sale.terminal_id,
    deviceUuid: sale.device_uuid,
    sessionId: sale.session_id,
    serverReference: sale.serverReference ?? null,
    serverAcknowledgedAt: sale.serverAcknowledgedAt ?? null,
    validation,
    sendableFromHere: sale.status === 'QUEUED' || sale.status === 'SENDING',
  }
}

/**
 * Merge the two sides.
 *
 * The server's row is the one that is kept when both exist, because it knows
 * things the device cannot: whether the books took it, and why not. The
 * device's copy is read for the payload facts the server's queue endpoint does
 * not return.
 */
export function toQueueRecords(local: OutboxSale[], server: OfflineSubmission[]): QueueRecord[] {
  const byUuid = new Map<string, OutboxSale>()
  for (const sale of local) byUuid.set(sale.client_uuid, sale)

  const records: QueueRecord[] = []
  const claimed = new Set<string>()

  for (const row of server) {
    const twin = row.client_uuid ? byUuid.get(row.client_uuid) : undefined
    if (twin) claimed.add(twin.client_uuid)

    records.push({
      clientUuid: row.client_uuid,
      origin: 'server',
      submissionId: row.submission_id,
      type: twin ? saleType(twin) : 'SALE',
      reference: row.cart_id ? `#${row.cart_id}` : twin ? saleReference(twin) : shortUuid(row.client_uuid ?? ''),
      // A sale taken on another till is not in this browser, so there is no
      // payload to read a name out of. Saying so is better than inventing one.
      customer: twin ? saleCustomer(twin) : 'Not captured on this till',
      amount: twin ? saleAmount(twin) : null,
      lines: twin ? (twin.lines ?? []).length : null,
      createdAt: row.client_created_at,
      status: serverStatus(row),
      attempts: row.attempts ?? 0,
      lastAttemptAt: row.received_at ?? null,
      lastErrorMessage: row.conflict_detail ?? row.last_error ?? null,
      lastErrorCode: row.conflict_kind ?? null,
      terminalId: row.terminal_id,
      deviceUuid: row.device_uuid,
      sessionId: null,
      serverReference: row.cart_id,
      serverAcknowledgedAt: row.posted_at ?? row.received_at ?? null,
      validation: null,
      // The server has it. Sending it again from here would be pointless, not
      // dangerous — the uuid makes it idempotent — but pointless is enough.
      sendableFromHere: false,
    })
  }

  for (const sale of local) {
    if (claimed.has(sale.client_uuid)) continue
    if (sale.status === 'DONE') continue
    records.push(fromDevice(sale))
  }

  // Newest first, which is the order a cashier looks for a sale they just took.
  return records.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
}

// ---------------------------------------------------------------------------
// Saying what went wrong, in words
// ---------------------------------------------------------------------------

export interface Explanation {
  problem: string
  resolution: string
}

/**
 * Turn whatever came back into something a cashier can act on.
 *
 * The server's own message is never thrown away — it is shown under Technical
 * details, where support reads it. What goes at the top is a sentence about the
 * shop, not about HTTP. "422" tells a cashier nothing; "the customer account is
 * closed" tells them who to call.
 */
export function explainFailure(record: QueueRecord): Explanation {
  if (record.validation) {
    return { problem: record.validation.problem, resolution: record.validation.resolution }
  }

  if (record.status === 'POSTED') {
    return {
      problem: 'Nothing is wrong with this one — the books have it.',
      resolution: 'No action needed. It is kept here so the day can be reconciled against the till.',
    }
  }

  if (record.status === 'ABANDONED') {
    return {
      problem: 'Someone decided this sale will never be posted, and recorded why.',
      resolution: 'Nothing further happens automatically. If that was a mistake, the sale has to be rung again — the note on it is kept for the audit.',
    }
  }

  const raw = `${record.lastErrorCode ?? ''} ${record.lastErrorMessage ?? ''}`.toLowerCase()

  if (!record.lastErrorMessage) {
    if (record.status === 'READY') {
      return {
        problem: 'Nothing is wrong. This sale is waiting for a connection.',
        resolution: 'It will post by itself when the shop is back online. You can also press Post to send it now.',
      }
    }
    return {
      problem: 'The server has this sale and has not finished posting it.',
      resolution: 'Give it a moment, then refresh. If it stays here, press Retry.',
    }
  }

  const known: { match: RegExp; problem: string; resolution: string }[] = [
    {
      match: /period|closed|locked|financial year|fy /,
      problem: 'The accounting period this sale belongs to is closed, so the books will not take it.',
      resolution: 'Ask whoever closes the books to reopen that period, then press Retry. Nothing about the sale needs changing.',
    },
    {
      match: /customer|contact|account.*(inactive|closed|blocked)|party/,
      problem: 'The customer account on this sale is no longer usable — it has been closed, merged or blocked.',
      resolution: 'Open the sale in Books and point it at the current customer record, then press Retry.',
    },
    {
      match: /credit limit|outstanding|overdue/,
      problem: 'This customer is over their credit limit, so the sale cannot go on account.',
      resolution: 'Either collect payment and re-ring it as a paid sale, or have the credit limit raised, then press Retry.',
    },
    {
      match: /stock|inventory|quantity|batch|serial|warehouse/,
      problem: 'Inventory will not release the stock on this sale — usually the batch, serial or warehouse no longer matches what is on hand.',
      resolution: 'Check the item in Inventory. Once the stock lines up, press Retry.',
    },
    {
      match: /tax|gst|hsn/,
      problem: 'The tax on this sale does not match what the item is set up with now.',
      resolution: 'Have the item’s tax category corrected, then press Retry. The sale itself is fine.',
    },
    {
      match: /duplicate|already exists|unique/,
      problem: 'The server already has this sale, so it was not taken a second time.',
      resolution: 'This is the protection working. Refresh the screen — it should show as posted. Nothing was billed twice.',
    },
    {
      match: /timeout|timed out|unreachable|network|502|503|504|gateway|connection/,
      problem: 'The server could not be reached while this was being sent. The sale is safe on this till.',
      resolution: 'It will go automatically when the connection is back. Nothing has been lost and nothing was billed twice.',
    },
    {
      match: /permission|forbidden|403|not allowed/,
      problem: 'This till is not allowed to post that kind of sale.',
      resolution: 'A manager needs to grant the permission, then press Retry.',
    },
    {
      match: /shift|session|register/,
      problem: 'The shift this sale was taken in has already been closed off.',
      resolution: 'A manager has to reopen the shift or move the sale to the current one, then press Retry.',
    },
  ]

  for (const entry of known) {
    if (entry.match.test(raw)) return { problem: entry.problem, resolution: entry.resolution }
  }

  // Unrecognised. Say that honestly rather than guessing, and point at the one
  // place the actual words are — never "something went wrong" and nothing else.
  return {
    problem: 'The books refused this sale, and the reason is not one this screen recognises.',
    resolution: 'Open Technical details below and send that text to support. Pressing Retry without changing anything will be refused again.',
  }
}

// ---------------------------------------------------------------------------
// Counts, for the cards and the tabs
// ---------------------------------------------------------------------------

export interface QueueCounts {
  queued: number
  ready: number
  attention: number
  failed: number
  posting: number
  postedToday: number
}

function isToday(iso: string | null): boolean {
  if (!iso) return false
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return false
  const now = new Date()
  return (
    when.getDate() === now.getDate() &&
    when.getMonth() === now.getMonth() &&
    when.getFullYear() === now.getFullYear()
  )
}

export function countQueue(records: QueueRecord[]): QueueCounts {
  const ready = records.filter((r) => r.status === 'READY').length
  const attention = records.filter((r) => r.status === 'NEEDS_ATTENTION').length
  const failed = records.filter((r) => r.status === 'FAILED').length
  const posting = records.filter((r) => r.status === 'POSTING').length

  return {
    // Everything that has not reached the books. Posted and abandoned are
    // settled, one happily and one not, so neither is "queued".
    queued: ready + attention + failed + posting,
    ready,
    attention,
    failed,
    posting,
    postedToday: records.filter((r) => r.status === 'POSTED' && isToday(r.serverAcknowledgedAt ?? r.createdAt)).length,
  }
}
