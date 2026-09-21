/**
 * What this screen remembers.
 *
 * Kept in localStorage under the same `pos.*` key convention the company scope
 * and the till already use, and for the same reason: a kitchen display is a
 * PHYSICAL SCREEN on a wall. It does not move, nobody signs into it twice a
 * day, and whoever set its density and turned its buzzer off should not have
 * to do it again after a refresh.
 *
 * Deliberately not sent to the server. There is no POS preferences endpoint,
 * and inventing one to store a font size would put a per-device display
 * setting into company data where it does not belong.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KitchenPreferences } from './types'

const KEY = 'pos.kitchen'

export const DEFAULT_PREFERENCES: KitchenPreferences = {
  density: 'comfortable',
  autoRefresh: true,
  sound: true,
  volume: 0.5,
  newOrderAlert: true,
  showServed: true,
  servedCount: 5,
  slaWarnPc: 80,
  defaultStationId: null,
}

export const SERVED_COUNTS = [3, 5, 10] as const
export const SLA_THRESHOLDS = [70, 80, 90] as const

/** Anything stored by an older build, or edited by hand, is repaired not trusted. */
function coerce(raw: unknown): KitchenPreferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFERENCES
  const stored = raw as Partial<KitchenPreferences>

  const servedCount = Number(stored.servedCount)
  const slaWarnPc = Number(stored.slaWarnPc)
  const volume = Number(stored.volume)

  return {
    density: stored.density === 'compact' ? 'compact' : 'comfortable',
    autoRefresh: stored.autoRefresh !== false,
    sound: stored.sound !== false,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_PREFERENCES.volume,
    newOrderAlert: stored.newOrderAlert !== false,
    showServed: stored.showServed !== false,
    servedCount: (SERVED_COUNTS as readonly number[]).includes(servedCount)
      ? servedCount
      : DEFAULT_PREFERENCES.servedCount,
    slaWarnPc: (SLA_THRESHOLDS as readonly number[]).includes(slaWarnPc) ? slaWarnPc : DEFAULT_PREFERENCES.slaWarnPc,
    defaultStationId:
      typeof stored.defaultStationId === 'number' && Number.isFinite(stored.defaultStationId)
        ? stored.defaultStationId
        : null,
  }
}

function read(): KitchenPreferences {
  try {
    const raw = window.localStorage.getItem(KEY)

    return raw ? coerce(JSON.parse(raw)) : DEFAULT_PREFERENCES
  } catch {
    // A browser with storage disabled still works; it just forgets.
    return DEFAULT_PREFERENCES
  }
}

export interface PreferencesApi {
  preferences: KitchenPreferences
  update: (patch: Partial<KitchenPreferences>) => void
  reset: () => void
}

export function useKitchenPreferences(): PreferencesApi {
  const [preferences, setPreferences] = useState<KitchenPreferences>(read)

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(preferences))
    } catch {
      // as above
    }
  }, [preferences])

  const update = useCallback((patch: Partial<KitchenPreferences>) => {
    setPreferences((current) => coerce({ ...current, ...patch }))
  }, [])

  const reset = useCallback(() => setPreferences(DEFAULT_PREFERENCES), [])

  return useMemo(() => ({ preferences, update, reset }), [preferences, update, reset])
}
