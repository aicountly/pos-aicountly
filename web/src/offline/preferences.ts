/**
 * Device preferences for the offline queue.
 *
 * localStorage is right for these and wrong for the queue itself: these are two
 * small booleans about how this one machine behaves, losing them costs nothing,
 * and they have to be readable synchronously during the first render. The sales
 * live in IndexedDB — see offline/db.ts for why that distinction matters.
 *
 * They are kept in their own module so the shell's connection indicator and the
 * Offline Queue screen read the SAME switch. When they each had their own idea
 * of it, turning Auto Sync off on this page did not stop the header draining
 * the outbox the moment the line came back.
 */

const AUTO_SYNC_KEY = 'pos.offline.autoSync'
const LAST_SYNC_KEY = 'pos.offline.lastSync'

export function readAutoSync(): boolean {
  try {
    // Absent means on: a till that has never been configured should still
    // deliver its sales by itself.
    return window.localStorage.getItem(AUTO_SYNC_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeAutoSync(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_SYNC_KEY, enabled ? 'on' : 'off')
  } catch {
    // A browser with storage off still syncs; it just forgets the preference.
  }
}

export function readLastSyncAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_SYNC_KEY)
    const value = raw ? Number(raw) : Number.NaN
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export function writeLastSyncAt(when: number): void {
  try {
    window.localStorage.setItem(LAST_SYNC_KEY, String(when))
  } catch {
    // as above
  }
}
