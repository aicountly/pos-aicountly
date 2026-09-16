import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setScope, type CompanyScope } from '../services/api'
import type { PosSession, Terminal } from '../services/types'

/**
 * The company scope, the signed-in cashier's permissions, and the till they
 * are standing at.
 *
 * The till matters more here than in any other product in the fleet: almost
 * every action is attributed to a terminal and a shift, so choosing the till
 * is part of signing on rather than a setting buried in a menu. It is
 * remembered per browser, because a till is a physical machine that does not
 * move.
 */

interface PosContextValue {
  scope: CompanyScope | null
  setCompanyScope: (scope: CompanyScope | null) => void
  session: PosSession | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>

  terminalId: number | null
  setTerminalId: (id: number | null) => void
  terminal: Terminal | null

  can: (permission: string) => boolean
}

const PosContext = createContext<PosContextValue | null>(null)

const SCOPE_KEY = 'pos.scope'
const TERMINAL_KEY = 'pos.terminal'

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function PosProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<CompanyScope | null>(() => readStored<CompanyScope>(SCOPE_KEY))
  const [terminalId, setTerminalIdState] = useState<number | null>(() => readStored<number>(TERMINAL_KEY))
  const [session, setSession] = useState<PosSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setScope(scope)
    try {
      if (scope) window.localStorage.setItem(SCOPE_KEY, JSON.stringify(scope))
      else window.localStorage.removeItem(SCOPE_KEY)
    } catch {
      // A browser with storage disabled still works; it just asks again.
    }
  }, [scope])

  useEffect(() => {
    try {
      if (terminalId) window.localStorage.setItem(TERMINAL_KEY, JSON.stringify(terminalId))
      else window.localStorage.removeItem(TERMINAL_KEY)
    } catch {
      // as above
    }
  }, [terminalId])

  const reload = useCallback(async () => {
    if (!scope) {
      setSession(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await api.one<PosSession>('v1/session')
      setSession(response.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open this company.')
      setSession(null)
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    void reload()
  }, [reload])

  const terminal = useMemo(
    () => session?.terminals.find((t) => t.terminal_id === terminalId) ?? null,
    [session, terminalId],
  )

  const can = useCallback(
    (permission: string) => session?.permissions.includes(permission) ?? false,
    [session],
  )

  const value = useMemo<PosContextValue>(
    () => ({
      scope,
      setCompanyScope: setScopeState,
      session,
      loading,
      error,
      reload,
      terminalId,
      setTerminalId: setTerminalIdState,
      terminal,
      can,
    }),
    [scope, session, loading, error, reload, terminalId, terminal, can],
  )

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>
}

export function usePos(): PosContextValue {
  const value = useContext(PosContext)
  if (!value) throw new Error('usePos must be used inside PosProvider')
  return value
}
