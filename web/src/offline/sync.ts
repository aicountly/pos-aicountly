/**
 * Draining the outbox.
 *
 * This is the ONLY thing this app sends upward that was made while offline, and
 * it is a list of sales, not a copy of anything. It runs when the browser says
 * the network is back and when the cashier presses Post — never on a timer that
 * would keep firing at a shop with no broadband.
 *
 * THE FOUR RULES. Everything below exists to hold one of them.
 *
 *  1. A sale is never dropped because sending it failed. It is forgotten in
 *     exactly one circumstance: the server said POSTED. That is the difference
 *     between a queue and a shredder.
 *  2. A sale is never sent twice into the books. Every sale carries the uuid the
 *     device minted before the first attempt, and pos_offline_submissions has
 *     UNIQUE (cmp_id, client_uuid) — so a retry after a timeout that actually
 *     succeeded comes back as a duplicate with the original's status, not as a
 *     second invoice.
 *  3. Only one drain runs at a time. The header listens for `online`, this page
 *     does too, and a cashier can press Post All — without the lock below those
 *     are three concurrent loops over the same rows.
 *  4. A failure that will never fix itself stops being retried and starts being
 *     shown to a person. Retrying forever is how a real problem stays invisible.
 */

import { api, ApiError } from '../services/api'
import type { OfflineSubmission } from '../services/types'
import { outboxForget, outboxPending, outboxUpdate, type OutboxSale } from './db'
import { MAX_AUTO_ATTEMPTS, validateSale } from './model'

/** Sales per request. Small enough to show honest progress, large enough not to chat. */
const CHUNK_SIZE = 5

/** First wait after a failed attempt; doubles each time, to the cap below. */
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 15 * 60_000

export interface SyncProgress {
  active: boolean
  done: number
  total: number
  /** Ready to put straight in front of a cashier. */
  label: string
}

export interface SyncResult {
  client_uuid: string
  reference: string
  status: 'POSTED' | 'CONFLICT' | 'RECEIVED' | 'FAILED'
  duplicate: boolean
  cart_id: number | null
  message: string | null
}

export interface SyncOutcome {
  sent: number
  posted: number
  conflicted: number
  stillQueued: number
  /** Held back on purpose: invalid payloads, backoff, or the attempt ceiling. */
  skipped: number
  /** True when another drain already had the lock and this call did nothing. */
  busy: boolean
  message: string
  results: SyncResult[]
}

interface SubmitResult {
  accepted: number
  duplicate: number
  failed: number
  conflicted: number
  pending: number
  results: { client_uuid: string; status: string; duplicate: boolean; cart_id: number | null; message: string | null }[]
}

// ---------------------------------------------------------------------------
// The lock, and who is watching
// ---------------------------------------------------------------------------

let draining = false
let progress: SyncProgress = { active: false, done: 0, total: 0, label: '' }

const watchers = new Set<(state: SyncProgress) => void>()

function publish(next: SyncProgress): void {
  progress = next
  for (const watcher of watchers) watcher(progress)
}

/** Subscribe to sync progress. Returns the unsubscribe. */
export function subscribeSync(watcher: (state: SyncProgress) => void): () => void {
  watchers.add(watcher)
  watcher(progress)
  return () => {
    watchers.delete(watcher)
  }
}

export function syncProgress(): SyncProgress {
  return progress
}

export function isSyncing(): boolean {
  return draining
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

export interface DrainOptions {
  /**
   * Send only these uuids. A person pressed a button, so the backoff and the
   * attempt ceiling are ignored — they are there to stop the MACHINE from
   * hammering, not to stop a cashier who is standing there.
   */
  only?: string[]
}

function idle(): SyncOutcome {
  return { sent: 0, posted: 0, conflicted: 0, stillQueued: 0, skipped: 0, busy: false, message: '', results: [] }
}

function backoffFor(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)
}

function reference(sale: OutboxSale): string {
  return sale.token_no?.trim() || `OFF-${sale.client_uuid.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

export async function drainOutbox(options: DrainOptions = {}): Promise<SyncOutcome> {
  // Rule 3. A second caller does NOT queue behind the first — it returns and
  // says so, because the first one is already sending exactly these rows.
  if (draining) {
    return { ...idle(), busy: true, message: 'Already sending. Nothing was sent twice.' }
  }

  const manual = Array.isArray(options.only) && options.only.length > 0
  const wanted = manual ? new Set(options.only) : null

  const pending = await outboxPending()
  const candidates = wanted ? pending.filter((sale) => wanted.has(sale.client_uuid)) : pending

  if (candidates.length === 0) {
    return { ...idle(), message: 'Nothing waiting to go up.' }
  }

  // Rule 4, first half: anything whose payload cannot post is taken out of the
  // automatic path for good and put in front of a person. Doing this before the
  // first send means a broken record never burns an attempt.
  const sendable: OutboxSale[] = []
  let skipped = 0
  const now = Date.now()

  for (const sale of candidates) {
    const invalid = validateSale(sale)
    if (invalid) {
      await outboxUpdate(sale.client_uuid, {
        status: 'CONFLICT',
        lastError: invalid.problem,
        lastErrorCode: invalid.code,
      })
      skipped++
      continue
    }

    if (!manual) {
      if (sale.attempts >= MAX_AUTO_ATTEMPTS) {
        skipped++
        continue
      }
      const since = sale.lastAttemptAt ? now - sale.lastAttemptAt : Number.POSITIVE_INFINITY
      if (since < backoffFor(sale.attempts)) {
        skipped++
        continue
      }
    }

    sendable.push(sale)
  }

  if (sendable.length === 0) {
    return {
      ...idle(),
      skipped,
      message:
        skipped > 0
          ? `${skipped} ${skipped === 1 ? 'sale needs' : 'sales need'} someone to look at ${skipped === 1 ? 'it' : 'them'} before ${skipped === 1 ? 'it' : 'they'} can go.`
          : 'Nothing waiting to go up.',
    }
  }

  draining = true
  publish({ active: true, done: 0, total: sendable.length, label: `Posting 0 of ${sendable.length}…` })

  const results: SyncResult[] = []
  let posted = 0
  let conflicted = 0
  let stillQueued = 0
  let done = 0
  let transportFailure: string | null = null

  try {
    for (let offset = 0; offset < sendable.length; offset += CHUNK_SIZE) {
      const chunk = sendable.slice(offset, offset + CHUNK_SIZE)
      const attemptedAt = Date.now()

      for (const sale of chunk) {
        await outboxUpdate(sale.client_uuid, {
          status: 'SENDING',
          attempts: (sale.attempts ?? 0) + 1,
          lastAttemptAt: attemptedAt,
        })
      }

      let body: SubmitResult
      try {
        const response = await api.post<SubmitResult>('v1/offline/submit', { sales: chunk.map(toPayload) })
        body = response.data
      } catch (e) {
        // Rule 1. The send failed, so every sale in this chunk goes back in the
        // queue exactly as it was. We do NOT know whether the server saw them —
        // that is precisely why they carry a uuid, and why sending them again
        // later cannot double-bill.
        const message = e instanceof Error ? e.message : 'Could not reach the server'
        const code = e instanceof ApiError ? `${e.status} ${e.code}` : 'network'

        for (const sale of chunk) {
          await outboxUpdate(sale.client_uuid, { status: 'QUEUED', lastError: message, lastErrorCode: code })
          results.push({
            client_uuid: sale.client_uuid,
            reference: reference(sale),
            status: 'FAILED',
            duplicate: false,
            cart_id: null,
            message,
          })
          stillQueued++
        }

        // No point walking the rest of the list into the same dead connection.
        transportFailure = message
        break
      }

      for (const result of body.results ?? []) {
        const sale = chunk.find((s) => s.client_uuid === result.client_uuid)
        const handle = sale ? reference(sale) : result.client_uuid

        if (result.status === 'POSTED') {
          // Rule 1's one exception. Acknowledged, so it is safe to forget —
          // and the acknowledgement is written down first, so a crash between
          // the two lines leaves a record that says where it went.
          await outboxUpdate(result.client_uuid, {
            serverReference: result.cart_id,
            serverAcknowledgedAt: new Date().toISOString(),
          })
          await outboxForget(result.client_uuid)
          posted++
        } else if (result.status === 'CONFLICT') {
          await outboxUpdate(result.client_uuid, {
            status: 'CONFLICT',
            lastError: result.message,
            lastErrorCode: 'rejected',
          })
          conflicted++
        } else {
          // The server has it but has not posted it. It owns the retry now.
          await outboxUpdate(result.client_uuid, {
            status: 'ACKNOWLEDGED',
            lastError: result.message,
            lastErrorCode: 'received',
          })
          stillQueued++
        }

        results.push({
          client_uuid: result.client_uuid,
          reference: handle,
          status: (result.status as SyncResult['status']) ?? 'RECEIVED',
          duplicate: Boolean(result.duplicate),
          cart_id: result.cart_id,
          message: result.message,
        })
      }

      done += chunk.length
      publish({
        active: true,
        done: Math.min(done, sendable.length),
        total: sendable.length,
        label: `Posting ${Math.min(done, sendable.length)} of ${sendable.length}…`,
      })
    }
  } finally {
    draining = false
    publish({ active: false, done: 0, total: 0, label: '' })
  }

  return {
    sent: done,
    posted,
    conflicted,
    stillQueued,
    skipped,
    busy: false,
    message: transportFailure
      ? 'Still offline — the sales are safe on this till and will go when the connection is back.'
      : describe(posted, conflicted, stillQueued, skipped),
    results,
  }
}

function describe(posted: number, conflicted: number, stillQueued: number, skipped: number): string {
  const parts: string[] = []
  if (posted > 0) parts.push(`${posted} transaction${posted === 1 ? '' : 's'} posted`)
  if (conflicted > 0) parts.push(`${conflicted} need${conflicted === 1 ? 's' : ''} attention`)
  if (stillQueued > 0) parts.push(`${stillQueued} still with the server`)
  if (skipped > 0) parts.push(`${skipped} held back`)

  return parts.length === 0 ? 'Nothing to send.' : parts.join(', ') + '.'
}

/** Strip the local bookkeeping fields; the server has no use for them. */
function toPayload(sale: OutboxSale): Record<string, unknown> {
  const {
    queuedAt: _queuedAt,
    attempts: _attempts,
    lastError: _lastError,
    status: _status,
    lastAttemptAt: _lastAttemptAt,
    lastErrorCode: _lastErrorCode,
    serverReference: _serverReference,
    serverAcknowledgedAt: _serverAcknowledgedAt,
    ...payload
  } = sale

  return payload
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Settle the device's copy against what the server actually holds.
 *
 * THE CASE THIS EXISTS FOR. The till sends a sale, the server posts it, and the
 * response is lost on the way back — the shop's connection dropped, the tab was
 * closed, the browser was killed. The device still has the sale marked QUEUED
 * and believes it owes it. Without this, the cashier sees a sale "waiting" that
 * is already in the books, and the only way to find out is to send it again.
 *
 * So whenever the server's queue is read, the two sides are compared:
 *
 *   server says POSTED   the device's copy is forgotten. This is the same rule
 *                        as everywhere else — acknowledged, therefore safe.
 *   server has it at all the device stops being the sender and says so, so the
 *                        automatic drain leaves it alone. The payload is kept
 *                        until it posts; a few kilobytes against a lost sale.
 *
 * Returns how many rows it settled, so the screen can say it out loud rather
 * than silently changing counts under the cashier.
 */
export async function reconcile(serverRows: OfflineSubmission[]): Promise<{ posted: number; acknowledged: number }> {
  if (serverRows.length === 0) return { posted: 0, acknowledged: 0 }

  const byUuid = new Map(serverRows.filter((row) => row.client_uuid).map((row) => [row.client_uuid, row]))
  const local = await outboxPending()

  let posted = 0
  let acknowledged = 0

  for (const sale of local) {
    const row = byUuid.get(sale.client_uuid)
    if (!row) continue

    if (row.status === 'POSTED') {
      await outboxUpdate(sale.client_uuid, {
        serverReference: row.cart_id,
        serverAcknowledgedAt: row.posted_at ?? new Date().toISOString(),
      })
      await outboxForget(sale.client_uuid)
      posted++
    } else {
      await outboxUpdate(sale.client_uuid, {
        status: row.status === 'CONFLICT' ? 'CONFLICT' : 'ACKNOWLEDGED',
        lastError: row.conflict_detail ?? row.last_error ?? sale.lastError,
        lastErrorCode: row.conflict_kind ?? 'received',
      })
      acknowledged++
    }
  }

  return { posted, acknowledged }
}

/**
 * Drain when the connection comes back.
 *
 * Returns the unsubscribe so a component can stop listening on unmount.
 */
export function onReconnect(handler: () => void): () => void {
  window.addEventListener('online', handler)
  return () => window.removeEventListener('online', handler)
}
