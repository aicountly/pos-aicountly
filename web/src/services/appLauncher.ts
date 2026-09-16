import { AICOUNTLY_APPS, CURRENT_APP_ID } from '../config/aicountlyApps'
import type { AicountlyAppDef } from '../config/aicountlyApps'
import { getAuthToken } from '../auth/tokens'
import { isSandboxHost, PORTAL_LOGIN_PRODUCTION, PORTAL_LOGIN_SANDBOX } from '../auth/hostnames'

const LOGIN_RETURN_PARAM = 'returnUrl'

/** Resolve which catalog entry matches the current SPA host. */
export function resolveCurrentAppId(hostname: string = window.location.hostname): string {
  const host = (hostname || '').replace(/^www\./i, '').toLowerCase()
  const hit = AICOUNTLY_APPS.find(
    (app) => app.prodHost === host || app.sandboxHost === host || (app.altHosts ?? []).includes(host),
  )
  return hit?.id ?? CURRENT_APP_ID
}

export function getAppById(appId: string): AicountlyAppDef | null {
  return AICOUNTLY_APPS.find((app) => app.id === appId) ?? null
}

/** Product SPA origin for the active environment (sandbox vs production). */
export function resolveAppOrigin(app: AicountlyAppDef, sandbox: boolean = isSandboxHost()): string {
  const host = sandbox ? app.sandboxHost : app.prodHost
  const protocol = host.includes('localhost') ? 'http' : 'https'
  return `${protocol}://${host}`
}

/** Manage API — still used for company/branch/logo data; icons moved to Console below. */
export const MANAGE_API_PRODUCTION = 'https://manage.aicountly.com'
export const MANAGE_API_SANDBOX = 'https://manage.gh.aicountly.com'

export function getManageApiOrigin(sandbox: boolean = isSandboxHost()): string {
  return sandbox ? MANAGE_API_SANDBOX : MANAGE_API_PRODUCTION
}

/** Central product icons live behind Console — one origin regardless of sandbox/production. */
export const CONSOLE_API_PRODUCTION = 'https://console.aicountly.org'

/**
 * Where the launcher asks for product icons.
 *
 * The fleet default is Console, and it is the same origin on sandbox and
 * production because there is one icon set for both. `VITE_CONSOLE_API_BASE_URL`
 * overrides it, and setting that variable to `off` (or `none`, or `0`) turns
 * the remote check off entirely — the grid then paints the tiles bundled with
 * this build and makes no cross-origin request at all.
 *
 * That switch exists because this is the only endpoint in the app that could
 * not be pointed anywhere. Every other one is configurable, and an installation
 * that does not run Console had no way to stop the launcher asking for it.
 */
const CONFIGURED_CONSOLE_ORIGIN = (import.meta.env.VITE_CONSOLE_API_BASE_URL ?? '').trim()
const DISABLED_VALUES = ['off', 'none', 'false', '0']

export function consoleIconsEnabled(): boolean {
  return !DISABLED_VALUES.includes(CONFIGURED_CONSOLE_ORIGIN.toLowerCase())
}

export function getConsoleApiOrigin(): string {
  if (CONFIGURED_CONSOLE_ORIGIN && consoleIconsEnabled()) {
    return CONFIGURED_CONSOLE_ORIGIN.replace(/\/$/, '')
  }

  return CONSOLE_API_PRODUCTION
}

/** Public launcher icon URL for a product (optional cache-bust version). */
export function buildProductIconUrl(appId: string, version: string | number = ''): string {
  const params = new URLSearchParams()
  if (version) params.set('t', String(version))
  const query = params.toString()
  return `${getConsoleApiOrigin()}/api/product-icons/${encodeURIComponent(appId)}${query ? `?${query}` : ''}`
}

/** Same-origin bundled tile shipped with the SPA (fast path for the app grid). */
export function buildLocalAppIconUrl(appId: string): string {
  const base = ((import.meta.env.BASE_URL as string | undefined) || '/').replace(/\/?$/, '/')
  return `${base}apps/${appId}.png`
}

/** Bundled icon timestamps — used to decide when a remote Console icon is newer. */
export async function fetchBundledIconVersions(): Promise<Record<string, number>> {
  const url = `${((import.meta.env.BASE_URL as string | undefined) || '/').replace(/\/?$/, '/')}apps/icon-bundle.json`
  try {
    const res = await fetch(url, { cache: 'force-cache' })
    if (!res.ok) return {}
    const json = await res.json()
    const items: Record<string, unknown> = (json as { items?: Record<string, unknown> })?.items ?? {}
    const map: Record<string, number> = {}
    for (const [appId, version] of Object.entries(items)) {
      map[appId] = Number(version) || 0
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Per-browser record of the icon each tile last painted successfully.
 * Persisting this lets the first paint use the URL the browser already
 * has cached from the previous visit instead of flashing bundled art.
 */
const ICON_CHOICE_STORAGE_KEY = 'aicountly.launcher.icon-choice.v1'

interface IconChoice {
  src: 'local' | 'remote'
  v: number
}

export function readIconChoices(): Record<string, IconChoice> {
  try {
    const raw = window.localStorage.getItem(ICON_CHOICE_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}

    const choices: Record<string, IconChoice> = {}
    for (const [appId, entry] of Object.entries(parsed as Record<string, { src?: string; v?: number }>)) {
      if (entry?.src === 'remote' || entry?.src === 'local') {
        choices[appId] = { src: entry.src, v: Number(entry.v) || 0 }
      }
    }
    return choices
  } catch {
    // Private mode / storage disabled — fall back to the bundled tiles.
    return {}
  }
}

/** Record the icon a tile painted, so the next load starts from that same URL. */
export function rememberIconChoice(appId: string, src: 'local' | 'remote', version: number = 0): void {
  try {
    const choices = readIconChoices()
    choices[appId] = { src: src === 'remote' ? 'remote' : 'local', v: Number(version) || 0 }
    window.localStorage.setItem(ICON_CHOICE_STORAGE_KEY, JSON.stringify(choices))
  } catch {
    // Not fatal — the tile still renders, it just re-resolves on the next load.
  }
}

/** Icon URL a tile can paint immediately, with no network round trip. */
export function resolveTileIconUrl(
  app: AicountlyAppDef,
  choices: Record<string, IconChoice> = readIconChoices(),
  sandbox: boolean = isSandboxHost(),
): string {
  const choice = choices[app.id]
  if (choice?.src === 'remote' && choice.v > 0) {
    return resolveAppIconUrl(app, sandbox, choice.v)
  }
  return buildLocalAppIconUrl(app.id)
}

/** Warm the browser cache for the tiles the grid is actually going to paint. */
export function preloadLauncherIcons(appIds: string[] = AICOUNTLY_APPS.map((app) => app.id)): void {
  const choices = readIconChoices()
  for (const appId of appIds) {
    const app = getAppById(appId)
    const img = new Image()
    img.decoding = 'async'
    img.src = app ? resolveTileIconUrl(app, choices) : buildLocalAppIconUrl(appId)
  }
}

/** Launcher tile icon — always served from Console so updates propagate to all products. */
export function resolveAppIconUrl(
  app: AicountlyAppDef,
  _sandbox: boolean = isSandboxHost(),
  version: string | number = '',
): string {
  return buildProductIconUrl(app.id, version)
}

/**
 * Cache-bust timestamps for launcher tiles (public manifest).
 *
 * WHEN THIS RUNS MATTERS MORE THAN WHAT IT RETURNS. The manifest only says
 * whether Console holds a NEWER icon than the one bundled with this build; the
 * grid paints from the bundle and from the per-browser choice either way, and
 * `listLauncherApps` will not use a remote icon until both manifests are in
 * hand. So nothing on screen waits for this, and it is fetched lazily — when
 * someone opens the launcher, which is also where the fleet integration note
 * says the pickup happens.
 *
 * It used to run on mount instead, which meant one cross-origin request on
 * every page load of every screen, for data the user had not asked to see. When
 * Console was unreachable that was a red console error per page load, for ever,
 * which is how people learn to ignore the console.
 *
 * The result is remembered for the session, and a FAILURE is remembered too,
 * for a shorter while. Retrying a down Console on every grid open produces the
 * same failure and the same noise; asking again a few minutes later is enough
 * to pick up an icon change on the day Console comes back.
 */
const MANIFEST_TTL_MS = 10 * 60 * 1000
const MANIFEST_FAILURE_TTL_MS = 5 * 60 * 1000

interface ManifestCache {
  at: number
  ok: boolean
  items: Record<string, string | number>
}

let manifestCache: ManifestCache | null = null
let manifestInFlight: Promise<Record<string, string | number>> | null = null

/** Forget the cached manifest. Exists so tests do not leak state into each other. */
export function resetProductIconManifestCache(): void {
  manifestCache = null
  manifestInFlight = null
}

export async function fetchProductIconManifest(): Promise<Record<string, string | number>> {
  if (!consoleIconsEnabled()) {
    return {}
  }

  const now = Date.now()
  if (manifestCache && now - manifestCache.at < (manifestCache.ok ? MANIFEST_TTL_MS : MANIFEST_FAILURE_TTL_MS)) {
    return manifestCache.items
  }

  // Concurrent callers share one request: the grid opening while a preload is
  // still in flight would otherwise ask twice and keep the later answer.
  if (manifestInFlight) {
    return manifestInFlight
  }

  const url = `${getConsoleApiOrigin()}/api/product-icons/manifest`

  manifestInFlight = (async (): Promise<Record<string, string | number>> => {
    try {
      // `no-cache` (not `no-store`) so the browser may revalidate and take a
      // 304 — this is only a version list and it gates no paint.
      const res = await fetch(url, { cache: 'no-cache' })
      if (!res.ok) {
        manifestCache = { at: Date.now(), ok: false, items: {} }
        noteManifestUnavailable(`${res.status} ${res.statusText}`.trim())

        return {}
      }

      const json = await res.json()
      const items: Array<{ app_id?: string; updated_at?: string | number }> =
        (json as { data?: { items?: Array<{ app_id?: string; updated_at?: string | number }> } })?.data?.items ?? []
      const map: Record<string, string | number> = {}
      for (const item of items) {
        if (item?.app_id) {
          map[item.app_id] = item.updated_at || 0
        }
      }
      manifestCache = { at: Date.now(), ok: true, items: map }

      return map
    } catch (error) {
      manifestCache = { at: Date.now(), ok: false, items: {} }
      noteManifestUnavailable(error instanceof Error ? error.message : 'network error')

      return {}
    } finally {
      manifestInFlight = null
    }
  })()

  return manifestInFlight
}

/**
 * Say once, plainly, that the icon check did not answer.
 *
 * The browser logs its own red line for the failed request and nothing in
 * JavaScript can suppress that. What this adds is the sentence that stops it
 * reading as a broken application: the launcher works, the tiles are the ones
 * shipped with this build, and the only thing missing is a newer icon.
 */
let manifestWarningShown = false

function noteManifestUnavailable(reason: string): void {
  if (manifestWarningShown) return
  manifestWarningShown = true
  // eslint-disable-next-line no-console
  console.info(
    `[app launcher] Console did not answer the product-icon manifest (${reason}). ` +
      'The launcher is using the icons bundled with this build. Set VITE_CONSOLE_API_BASE_URL=off to stop asking.',
  )
}

/** Auth callback URL on the target product. */
export function buildAuthCallbackUrl(app: AicountlyAppDef, sandbox: boolean = isSandboxHost()): string {
  const origin = resolveAppOrigin(app, sandbox)
  const base = ((import.meta.env.BASE_URL as string | undefined) || '/').replace(/\/$/, '')
  const prefix = base && base !== '/' ? base : ''
  return `${origin}${prefix}/auth/callback`
}

export interface LaunchOptions {
  sandbox?: boolean
  authToken?: string | null
  newTab?: boolean
}

/**
 * SSO launch URL — prefers local auth_token when present; otherwise portal
 * authentication_jump on sandbox (*.gh.aicountly.com) or my.aicountly.com (production).
 */
export function buildAppLaunchUrl(app: AicountlyAppDef, options: LaunchOptions = {}): string {
  const sandbox = options.sandbox ?? isSandboxHost()

  if (!app.jumpKey) {
    return resolveAppOrigin(app, sandbox)
  }

  const callbackUrl = buildAuthCallbackUrl(app, sandbox)
  const authToken = options.authToken ?? getAuthToken()

  if (authToken) {
    const sep = callbackUrl.includes('?') ? '&' : '?'
    return `${callbackUrl}${sep}auth_token=${encodeURIComponent(authToken)}`
  }

  const portal = sandbox ? PORTAL_LOGIN_SANDBOX : PORTAL_LOGIN_PRODUCTION
  const params = new URLSearchParams({ [LOGIN_RETURN_PARAM]: callbackUrl })
  return `${portal}/login/authentication_jump/${app.jumpKey}?${params.toString()}`
}

export function launchApp(app: AicountlyAppDef | null | undefined, options: LaunchOptions = {}): void {
  if (!app) return
  const url = buildAppLaunchUrl(app, options)
  if (options.newTab) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  window.location.assign(url)
}

export interface LauncherTile extends AicountlyAppDef {
  isCurrent: boolean
  launchUrl: string
  localIconUrl: string
  tileIconUrl: string
  remoteIconUrl: string
  iconVersion: number
  iconChecked: boolean
}

export function listLauncherApps(
  currentAppId: string = resolveCurrentAppId(),
  iconVersions: Record<string, string | number> = {},
  bundledVersions: Record<string, number> = {},
  iconChoices: Record<string, IconChoice> = readIconChoices(),
): LauncherTile[] {
  const sandbox = isSandboxHost()
  // Both manifests are needed before a tile can tell "no newer icon in Console"
  // apart from "not checked yet", so an unreachable Console leaves tiles alone.
  const versionsLoaded = Object.keys(bundledVersions).length > 0 && Object.keys(iconVersions).length > 0

  return AICOUNTLY_APPS.map((app) => {
    const remoteVersion = Number(iconVersions[app.id]) || 0
    const bundledVersion = Number(bundledVersions[app.id]) || 0
    const useRemote = versionsLoaded && remoteVersion > bundledVersion

    return {
      ...app,
      isCurrent: app.id === currentAppId,
      launchUrl: buildAppLaunchUrl(app),
      localIconUrl: buildLocalAppIconUrl(app.id),
      tileIconUrl: resolveTileIconUrl(app, iconChoices, sandbox),
      remoteIconUrl: useRemote ? resolveAppIconUrl(app, sandbox, remoteVersion) : '',
      iconVersion: useRemote ? remoteVersion : 0,
      iconChecked: versionsLoaded,
    }
  })
}
