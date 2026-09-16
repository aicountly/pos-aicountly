/**
 * Draining the outbox.
 *
 * This is the ONLY thing this app sends upward that was made while offline, and
 * it is a list of sales, not a copy of anything. It runs when the browser says
 * the network is back and when the cashier presses Sync — never on a timer that
 * would keep firing at a shop with no broadband.
 */

import { api } from '../services/api'
import { outboxForget, outboxPending, outboxUpdate, type OutboxSale } from './db'

export interface SyncOutcome {
  sent: number
  posted: number
  conflicted: number
  stillQueued: number
  message: string
}

interface SubmitResult {
  accepted: number
  duplicate: number
  failed: number
  conflicted: number
  pending: number
  results: { client_uuid: string; status: string; duplicate: boolean; cart_id: number | null; message: string | null }[]
}

export async function drainOutbox(): Promise<SyncOutcome> {
  const pending = await outboxPending()
  if (pending.length === 0) {
    return { sent: 0, posted: 0, conflicted: 0, stillQueued: 0, message: 'Nothing waiting to go up.' }
  }

  for (const sale of pending) {
    await outboxUpdate(sale.client_uuid, { status: 'SENDING', attempts: sale.attempts + 1 })
  }

  let response: SubmitResult
  try {
    const body = await api.post<SubmitResult>('v1/offline/submit', { sales: pending.map(toPayload) })
    response = body.data
  } catch (e) {
    // The send itself failed. Everything goes back in the queue, untouched —
    // the sales are still ours to deliver.
    for (const sale of pending) {
      await outboxUpdate(sale.client_uuid, {
        status: 'QUEUED',
        lastError: e instanceof Error ? e.message : 'Could not reach the server',
      })
    }
    return {
      sent: 0,
      posted: 0,
      conflicted: 0,
      stillQueued: pending.length,
      message: 'Still offline — nothing was sent. The sales are safe on this till.',
    }
  }

  let posted = 0
  let conflicted = 0
  let stillQueued = 0

  for (const result of response.results) {
    if (result.status === 'POSTED') {
      // Acknowledged. Only now is it safe to forget.
      await outboxForget(result.client_uuid)
      posted++
    } else if (result.status === 'CONFLICT') {
      await outboxUpdate(result.client_uuid, { status: 'CONFLICT', lastError: result.message })
      conflicted++
    } else {
      await outboxUpdate(result.client_uuid, { status: 'QUEUED', lastError: result.message })
      stillQueued++
    }
  }

  return {
    sent: pending.length,
    posted,
    conflicted,
    stillQueued,
    message: describe(posted, conflicted, stillQueued),
  }
}

function describe(posted: number, conflicted: number, stillQueued: number): string {
  const parts: string[] = []
  if (posted > 0) parts.push(`${posted} sale${posted === 1 ? '' : 's'} went through`)
  if (conflicted > 0) parts.push(`${conflicted} needs someone to look at ${conflicted === 1 ? 'it' : 'them'}`)
  if (stillQueued > 0) parts.push(`${stillQueued} still waiting`)

  return parts.length === 0 ? 'Nothing to send.' : parts.join(', ') + '.'
}

/** Strip the local bookkeeping fields; the server has no use for them. */
function toPayload(sale: OutboxSale): Record<string, unknown> {
  const { queuedAt: _queuedAt, attempts: _attempts, lastError: _lastError, status: _status, ...payload } = sale
  return payload
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
