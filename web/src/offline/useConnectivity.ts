/**
 * Is this till actually talking to the server?
 *
 * WHY navigator.onLine IS NOT ENOUGH. It answers one question — does this
 * machine have a network interface that thinks it is connected — and a till
 * fails in ways that sail straight past it: the shop's router is up but the
 * line is down, the captive portal at the mall has logged the tablet out, the
 * API is up but its database is not. In every one of those navigator.onLine
 * says true and every sale posted on the strength of it fails.
 *
 * So `false` from the browser is trusted absolutely (no interface, no hope) and
 * `true` is treated as a claim to be checked, against /api/health — which this
 * product already publishes and which reports readiness, not just liveness. Its
 * `usable` field is false when PHP is serving but the database behind it is
 * not: precisely the state that looks online and cannot take a sale.
 *
 * The probe is unauthenticated on purpose. Going through the API client would
 * mint a session key, and a health check that can fail on expired auth is a
 * health check that lies about the network.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiBaseUrl } from '../config'

export type ConnectivityState = 'ONLINE' | 'OFFLINE' | 'DEGRADED'

export interface Connectivity {
  state: ConnectivityState
  browserOnline: boolean
  /** null until the first probe answers. */
  apiReachable: boolean | null
  lastHealthyAt: number | null
  checking: boolean
  /** Probe now. Returns whether the API is usable. */
  check: () => Promise<boolean>
}

/** Long enough for a tired shop connection, short enough not to look hung. */
const PROBE_TIMEOUT_MS = 6000
const PROBE_INTERVAL_MS = 30_000

async function probe(): Promise<boolean> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(`${getApiBaseUrl()}/health`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return false

    const body = (await response.json()) as { usable?: boolean; status?: string }
    // `usable` is the honest field. Fall back to `status` only for a deployment
    // old enough not to publish it yet.
    if (typeof body.usable === 'boolean') return body.usable
    return body.status === 'ok'
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

export function useConnectivity(): Connectivity {
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine)
  const [apiReachable, setApiReachable] = useState<boolean | null>(null)
  const [lastHealthyAt, setLastHealthyAt] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)

  // A probe in flight when the component unmounts must not set state, and two
  // probes must not race each other into a stale answer.
  const alive = useRef(true)
  const inFlight = useRef<Promise<boolean> | null>(null)

  const check = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current

    if (!navigator.onLine) {
      setBrowserOnline(false)
      setApiReachable(false)
      return false
    }

    setChecking(true)
    const run = probe()
      .then((ok) => {
        if (!alive.current) return ok
        setApiReachable(ok)
        if (ok) setLastHealthyAt(Date.now())
        return ok
      })
      .finally(() => {
        if (alive.current) setChecking(false)
        inFlight.current = null
      })

    inFlight.current = run
    return run
  }, [])

  useEffect(() => {
    alive.current = true
    void check()

    const goOnline = () => {
      setBrowserOnline(true)
      // The interface came back; whether the API did is a separate question.
      void check()
    }
    const goOffline = () => {
      setBrowserOnline(false)
      setApiReachable(false)
    }

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    // Polling a till that is asleep in a back office helps nobody, so the
    // interval only runs while the screen is actually being looked at.
    const tick = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const id = window.setInterval(tick, PROBE_INTERVAL_MS)
    document.addEventListener('visibilitychange', tick)

    return () => {
      alive.current = false
      window.clearInterval(id)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [check])

  const state: ConnectivityState = !browserOnline
    ? 'OFFLINE'
    : apiReachable === false
      ? 'DEGRADED'
      : 'ONLINE'

  return { state, browserOnline, apiReachable, lastHealthyAt, checking, check }
}
