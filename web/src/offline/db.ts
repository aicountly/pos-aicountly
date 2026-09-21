/**
 * The device-local cache, and the outbound queue of sales made while offline.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * This cache is a CONVENIENCE COPY on one physical till. It is:
 *
 *   non-authoritative   nothing in here is ever the answer to "what is true".
 *                       Prices, items and stock are Inventory's and Books'.
 *                       When the network is up, the app asks them.
 *   disposable          it can be deleted at any moment with no loss. The only
 *                       thing that must survive is the OUTBOX — sales this till
 *                       took and the server has not acknowledged.
 *   per-device          it is never merged with another till's cache, never
 *                       uploaded as a catalogue, and never read by the server.
 *
 * It is NOT database synchronisation and must not become it. There is no
 * two-way reconciliation, no conflict merge on master data, and no path by
 * which something typed into this cache becomes the truth elsewhere. The one
 * thing that travels UP is a sale, and it travels as a command with a uuid the
 * device minted, which the server treats idempotently.
 *
 * If you find yourself adding a "push local changes to item master" function,
 * stop: that is the thing this architecture exists to avoid.
 */

const DB_NAME = 'aicountly-pos'
const DB_VERSION = 1

const STORE_CACHE = 'cache'
const STORE_OUTBOX = 'outbox'

export interface CachedEntry<T> {
  key: string
  value: T
  /** When this copy was taken, so the UI can say how stale it is. */
  cachedAt: number
}

export interface OutboxSale {
  /** Minted here, on this device, before the sale is attempted. The idempotency key. */
  client_uuid: string
  device_uuid: string
  terminal_id: number | null
  session_id: number | null
  client_created_at: string
  order_kind: string
  customer_name?: string | null
  customer_mobile?: string | null
  customer_account_id?: number | null
  token_no?: string | null
  discount_amount?: number
  service_charge_amount?: number
  tip_amount?: number
  lines: OutboxLine[]
  payments: OutboxPayment[]
  /** Local bookkeeping — never sent. */
  queuedAt: number
  attempts: number
  lastError: string | null
  /**
   * QUEUED       this till still owes the server this sale.
   * SENDING      in flight right now.
   * DONE         legacy; nothing writes it any more.
   * CONFLICT     the server refused it and a person has to act.
   * ACKNOWLEDGED the server HAS it (RECEIVED/CONFLICT/ABANDONED on its side),
   *              so this device is no longer the one that has to deliver it.
   *              The payload stays here anyway until it posts — belt and
   *              braces, because the cost of keeping it is a few kilobytes and
   *              the cost of being wrong is a lost sale.
   */
  status: 'QUEUED' | 'SENDING' | 'DONE' | 'CONFLICT' | 'ACKNOWLEDGED'

  // ---------------------------------------------------------------------
  // Added after the first release, so every one of these is OPTIONAL: rows
  // written by an older build are already sitting in people's browsers and
  // must keep reading back cleanly. Nothing here is sent either — see
  // toPayload() in sync.ts, which strips the lot.
  // ---------------------------------------------------------------------

  /** When the last send was attempted, for the backoff and for the drawer. */
  lastAttemptAt?: number | null
  /** A machine-readable hint for the failure, used to explain it in words. */
  lastErrorCode?: string | null
  /** The server's own id for this sale, kept once it acknowledges. */
  serverReference?: number | null
  /** When the server said it had it. */
  serverAcknowledgedAt?: string | null
}

export interface OutboxLine {
  item_id: number | null
  menu_item_id?: number | null
  unit_id?: number | null
  warehouse_id?: number | null
  batch_id?: number | null
  display_name: string
  quantity: number
  rate: number
  discount_pc?: number
  discount_amount?: number
  estimated_tax_pc?: number
  tax_cat_id?: number | null
  instructions?: string | null
}

export interface OutboxPayment {
  payment_mode: string
  amount: number
  tendered?: number | null
  change_given?: number
  reference?: string | null
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        // Keyed on the uuid the device minted, so the same sale cannot be
        // queued twice even if the checkout screen is submitted twice.
        db.createObjectStore(STORE_OUTBOX, { keyPath: 'client_uuid' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the local store'))
  })

  return dbPromise
}

function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const request = work(tx.objectStore(store))
        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error ?? new Error('Local store failed'))
      }),
  )
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

export async function cachePut<T>(key: string, value: T): Promise<void> {
  try {
    await run(STORE_CACHE, 'readwrite', (s) => s.put({ key, value, cachedAt: Date.now() } satisfies CachedEntry<T>))
  } catch {
    // A till with no IndexedDB still sells — it just cannot sell offline. That
    // is a smaller failure than refusing to start.
  }
}

export async function cacheGet<T>(key: string): Promise<CachedEntry<T> | null> {
  try {
    const entry = await run<CachedEntry<T> | undefined>(STORE_CACHE, 'readonly', (s) => s.get(key))
    return entry ?? null
  } catch {
    return null
  }
}

/** Throw the whole cache away. Safe by construction: nothing here is authoritative. */
export async function cacheClear(): Promise<void> {
  try {
    await run(STORE_CACHE, 'readwrite', (s) => s.clear())
  } catch {
    // nothing to do
  }
}

// ---------------------------------------------------------------------------
// The outbox — the only thing in here that matters
// ---------------------------------------------------------------------------

export async function outboxAdd(sale: OutboxSale): Promise<void> {
  await run(STORE_OUTBOX, 'readwrite', (s) => s.put(sale))
}

export async function outboxAll(): Promise<OutboxSale[]> {
  try {
    const all = await run<OutboxSale[]>(STORE_OUTBOX, 'readonly', (s) => s.getAll())
    return all ?? []
  } catch {
    return []
  }
}

export async function outboxPending(): Promise<OutboxSale[]> {
  return (await outboxAll()).filter((s) => s.status === 'QUEUED' || s.status === 'SENDING')
}

export async function outboxGet(clientUuid: string): Promise<OutboxSale | null> {
  try {
    const row = await run<OutboxSale | undefined>(STORE_OUTBOX, 'readonly', (s) => s.get(clientUuid))
    return row ?? null
  } catch {
    return null
  }
}

export async function outboxUpdate(clientUuid: string, patch: Partial<OutboxSale>): Promise<void> {
  const existing = await run<OutboxSale | undefined>(STORE_OUTBOX, 'readonly', (s) => s.get(clientUuid))
  if (!existing) return
  await run(STORE_OUTBOX, 'readwrite', (s) => s.put({ ...existing, ...patch }))
}

/**
 * Forget a sale the server has confirmed.
 *
 * ONLY called on an acknowledged POSTED or a recognised duplicate. A sale is
 * never dropped because sending it failed — that is the difference between a
 * queue and a shredder.
 */
export async function outboxForget(clientUuid: string): Promise<void> {
  await run(STORE_OUTBOX, 'readwrite', (s) => s.delete(clientUuid))
}

/** A device identity that survives a reload, so retries carry the same one. */
export function deviceUuid(): string {
  const KEY = 'pos.device_uuid'
  try {
    const existing = window.localStorage.getItem(KEY)
    if (existing) return existing
    const minted = crypto.randomUUID()
    window.localStorage.setItem(KEY, minted)
    return minted
  } catch {
    return crypto.randomUUID()
  }
}
