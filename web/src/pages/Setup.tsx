/**
 * Setting the shop up.
 *
 * An OUTLET here is a POS profile, not a branch: the branch is Manage's, and
 * bo_id points at it. What is configured here is what a till needs to know to
 * sell at that branch — which warehouse the stock leaves, which cash account
 * the money lands in, and whether the place runs tables.
 *
 * The screen is arranged around one question: what is stopping this shop from
 * taking a sale? The five cards say what exists, the checklist says what is
 * missing, and the warnings say what exists but will not work. All three are
 * computed from the same lists the tables below are showing — there is no
 * summary endpoint behind them and no number on this page that cannot be
 * traced to a row.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  MonitorSmartphone,
  PlayCircle,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Store,
  Table2,
  X,
} from 'lucide-react'
import { usePos } from '../context/PosContext'
import { fetchCompanyInfo } from '../services/manage'
import type { BranchOption } from '../services/manage'
import { revokeDevice, setOutletActive, setTillActive, summarise, useSetupData } from '../setup/data'
import type { Section as WorkspaceSection } from '../setup/data'
import { DeviceDrawer } from '../setup/DeviceDrawer'
import { FloorsDrawer } from '../setup/FloorsDrawer'
import { OutletDrawer } from '../setup/OutletDrawer'
import { SettingsDrawer } from '../setup/SettingsDrawer'
import { TillDrawer } from '../setup/TillDrawer'
import {
  DeviceList,
  DevicesEmpty,
  NoResults,
  OutletList,
  OutletsEmpty,
  SetupGuide,
  TillList,
  TillsEmpty,
} from '../setup/panels'
import type { SetupDevice, SetupOutlet, SetupTill } from '../setup/types'
import { deviceName, outletName, tillName } from '../setup/types'
import {
  ConfirmDialog,
  Drawer,
  SkeletonCards,
  SkeletonRows,
  StorefrontMark,
  ToastProvider,
  useToast,
} from '../setup/ui'
import '../setup/styles.css'

const SECTIONS: WorkspaceSection[] = ['outlets', 'tills', 'devices']

const HINT_KEY = 'pos.setup.hintDismissed'

type DrawerState =
  | { kind: 'none' }
  | { kind: 'guide' }
  | { kind: 'outlet'; outlet: SetupOutlet | null }
  | { kind: 'till'; till: SetupTill | null; outletId?: number | null }
  | { kind: 'device'; tillId?: number | null }
  | { kind: 'floors' }
  | { kind: 'settings' }

type ConfirmState =
  | { kind: 'none' }
  | { kind: 'revoke'; device: SetupDevice }
  | { kind: 'outlet-off'; outlet: SetupOutlet }
  | { kind: 'till-off'; till: SetupTill }

export default function Setup() {
  return (
    <ToastProvider>
      <SetupScreen />
    </ToastProvider>
  )
}

function SetupScreen() {
  const { can, scope, reload: reloadSession } = usePos()
  const toast = useToast()
  const canManage = can('terminal.manage')
  const canSettings = can('settings.manage')

  const { bundle, loading, error, partial, devicesDenied, reload } = useSetupData(Boolean(scope))
  const summary = useMemo(() => summarise(bundle), [bundle])

  const [params, setParams] = useSearchParams()
  const raw = params.get('section')
  const section: WorkspaceSection = SECTIONS.includes(raw as WorkspaceSection) ? (raw as WorkspaceSection) : 'outlets'

  const [term, setTerm] = useState('')
  // React schedules the filtered list at a lower priority than the keystroke,
  // which is the debounce this screen needs: the search is local, so there is
  // no request to hold back, only a re-render.
  const deferredTerm = useDeferredValue(term)

  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'none' })
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: 'none' })
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [showAllWarnings, setShowAllWarnings] = useState(false)
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(HINT_KEY) === '1'
    } catch {
      return false
    }
  })

  // Branch names for the outlet list. Manage owns them; this is a read, and a
  // failure here costs the outlet list a name, not the page.
  const [branches, setBranches] = useState<BranchOption[] | null>(null)
  useEffect(() => {
    if (!scope) return
    const controller = new AbortController()
    fetchCompanyInfo(scope.cmp_id, controller.signal)
      .then((info) => !controller.signal.aborted && setBranches(info.branches))
      .catch(() => undefined)
    return () => controller.abort()
  }, [scope])

  const goto = useCallback(
    (next: WorkspaceSection) => {
      setTerm('')
      const updated = new URLSearchParams(params)
      updated.set('section', next)
      // Replace, not push: flipping tabs should not fill the Back button with
      // a trail nobody wants to walk back along.
      setParams(updated, { replace: true })
    },
    [params, setParams],
  )

  const closeDrawer = useCallback(() => setDrawer({ kind: 'none' }), [])

  /** After anything is written: refresh the page AND the shell's own session. */
  const refreshAll = useCallback(async () => {
    await reload()
    await reloadSession()
  }, [reload, reloadSession])

  // ------------------------------------------------------------- filtering
  const needle = deferredTerm.trim().toLowerCase()
  const matches = (...fields: (string | null | undefined)[]) =>
    needle === '' || fields.some((field) => (field ?? '').toLowerCase().includes(needle))

  const visibleOutlets = useMemo(
    () =>
      bundle.outlets.filter((outlet) =>
        matches(
          outlet.display_name,
          outlet.location_code,
          outlet.pos_mode,
          branches?.find((branch) => branch.boId === outlet.bo_id)?.name,
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle.outlets, needle, branches],
  )

  const visibleTills = useMemo(
    () =>
      bundle.tills.filter((till) =>
        matches(
          till.display_name,
          till.terminal_code,
          till.terminal_kind,
          bundle.outlets.find((outlet) => outlet.location_id === till.location_id)?.display_name,
          till.location_code,
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle.tills, bundle.outlets, needle],
  )

  const visibleDevices = useMemo(
    () =>
      bundle.devices.filter((device) => {
        const till = bundle.tills.find((row) => row.terminal_id === device.terminal_id)
        const outlet = till ? bundle.outlets.find((row) => row.location_id === till.location_id) : undefined
        return matches(device.device_label, device.device_uuid, till?.terminal_code, till?.display_name, outlet?.display_name)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle.devices, bundle.tills, bundle.outlets, needle],
  )

  // ----------------------------------------------------------- destructive
  async function runConfirm(reason: string) {
    if (confirm.kind === 'none') return
    setConfirmBusy(true)
    try {
      if (confirm.kind === 'revoke') {
        await revokeDevice(confirm.device.device_id, reason)
        toast.success('Device access revoked.', `${deviceName(confirm.device)} can no longer post sales.`)
      } else if (confirm.kind === 'outlet-off') {
        const { outlet } = confirm
        const turningOn = outlet.is_active === false
        await setOutletActive(outlet, turningOn)
        toast.success(turningOn ? 'Outlet switched back on.' : 'Outlet switched off.', outletName(outlet))
      } else if (confirm.kind === 'till-off') {
        const { till } = confirm
        const turningOn = till.is_active === false
        await setTillActive(till.terminal_id, turningOn)
        toast.success(turningOn ? 'Till switched back on.' : 'Till switched off.', tillName(till))
      }
      setConfirm({ kind: 'none' })
      await refreshAll()
    } catch (e) {
      toast.failure('That did not go through.', e instanceof Error ? e.message : 'Please try again in a moment.')
    } finally {
      setConfirmBusy(false)
    }
  }

  /*
   * Both directions confirm, and the dialog says which one it is.
   *
   * Switching an outlet off is the closest thing this screen has to a delete —
   * there is no delete, because sales, shifts and returns point at it — so it
   * is worth a sentence explaining that nothing is being thrown away. Switching
   * one back on gets a much shorter one.
   */

  // ------------------------------------------------------------- rendering
  if (error !== null) {
    return (
      <div className="pos-workspace pos-setup">
        <SetupHeader summary={summary} loading={false} onGuide={() => setDrawer({ kind: 'guide' })} />
        <div className="pos-state" role="alert">
          <AlertTriangle size={26} aria-hidden style={{ color: 'var(--danger)' }} />
          <h2>We couldn’t load your POS setup</h2>
          <p>{error}</p>
          <button type="button" className="pos-button pos-button--primary" onClick={() => void reload()} style={{ marginTop: 14 }}>
            <RefreshCw size={15} aria-hidden /> Retry
          </button>
        </div>
      </div>
    )
  }

  const listLabel = section === 'outlets' ? 'outlets' : section === 'tills' ? 'tills' : 'devices'

  return (
    <div className="pos-workspace pos-setup">
      <SetupHeader summary={summary} loading={loading} onGuide={() => setDrawer({ kind: 'guide' })} />

      {loading ? (
        <SkeletonCards />
      ) : (
        <section className="setup-overview" aria-label="POS configuration overview">
          <CategoryCard
            accent="green"
            icon={<Store size={22} aria-hidden />}
            title="Outlets"
            body="Add and manage shops, restaurants or counters."
            chips={[
              { tone: 'green', text: `${summary.outletCount} outlet${summary.outletCount === 1 ? '' : 's'}` },
              ...(summary.warnings.some((w) => w.id.startsWith('warehouse-'))
                ? [{ tone: 'warning' as const, text: 'Stock source missing' }]
                : []),
            ]}
            onClick={() => goto('outlets')}
          />
          <CategoryCard
            accent="blue"
            icon={<MonitorSmartphone size={22} aria-hidden />}
            title="Tills"
            body="Create tills for billing. Assign devices and printers."
            chips={[{ tone: 'blue', text: `${summary.tillCount} till${summary.tillCount === 1 ? '' : 's'}` }]}
            onClick={() => goto('tills')}
          />
          <CategoryCard
            accent="purple"
            icon={<ShieldCheck size={22} aria-hidden />}
            title="Paired devices"
            body="Pair devices using secure one-time codes."
            chips={[
              { tone: 'purple', text: `${summary.deviceCount} device${summary.deviceCount === 1 ? '' : 's'}` },
              ...(summary.revokedDeviceCount > 0
                ? [{ tone: 'neutral' as const, text: `${summary.revokedDeviceCount} revoked` }]
                : []),
            ]}
            onClick={() => goto('devices')}
          />
          <CategoryCard
            accent="orange"
            icon={<Table2 size={22} aria-hidden />}
            title="Floors & Tables"
            body={
              summary.tableServiceOutlets.length === 0
                ? 'Available for restaurant outlets.'
                : 'Manage floors, tables and sections for restaurants.'
            }
            chips={
              summary.tableServiceOutlets.length === 0
                ? [{ tone: 'neutral', text: 'Not needed yet' }]
                : [
                    {
                      tone: 'orange',
                      text:
                        summary.tableCount > 0
                          ? `${summary.floorCount} floors · ${summary.tableCount} tables`
                          : `${summary.floorCount} floor${summary.floorCount === 1 ? '' : 's'}`,
                    },
                  ]
            }
            onClick={() => setDrawer({ kind: 'floors' })}
          />
          <CategoryCard
            accent="rose"
            icon={<SettingsIcon size={22} aria-hidden />}
            title="Other settings"
            body="Numbering, discounts, offline behaviour and more."
            chips={[{ tone: 'neutral', text: canSettings ? 'View settings' : 'Read only' }]}
            onClick={() => setDrawer({ kind: 'settings' })}
          />
        </section>
      )}

      {!loading && summary.warnings.length > 0 && (
        <section className="setup-warnings" aria-label="Things that need attention">
          {(showAllWarnings ? summary.warnings : summary.warnings.slice(0, 3)).map((warning) => (
            <div key={warning.id} className="setup-warning">
              <AlertTriangle size={16} aria-hidden style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--warning)' }} />
              <span style={{ minWidth: 0 }}>{warning.text}</span>
              {warning.action && canManage && (
                <button
                  type="button"
                  className="setup-warning__action"
                  onClick={() => {
                    const { action } = warning
                    if (!action) return
                    if (action.openFloors) setDrawer({ kind: 'floors' })
                    else if (action.outletId !== undefined) {
                      const outlet = bundle.outlets.find((row) => row.location_id === action.outletId)
                      if (outlet) setDrawer({ kind: 'outlet', outlet })
                    } else if (action.tillId !== undefined) setDrawer({ kind: 'device', tillId: action.tillId })
                    else if (action.section) goto(action.section)
                  }}
                >
                  {warning.action.label}
                </button>
              )}
            </div>
          ))}
          {summary.warnings.length > 3 && (
            <button
              type="button"
              className="pos-button pos-button--quiet pos-button--small"
              onClick={() => setShowAllWarnings((value) => !value)}
              style={{ justifySelf: 'start' }}
            >
              {showAllWarnings ? 'Show fewer' : `Show ${summary.warnings.length - 3} more`}
            </button>
          )}
        </section>
      )}

      <section className="setup-workspace">
        <div className="setup-workspace__toolbar">
          <div className="setup-tabs" role="tablist" aria-label="Setup sections">
            {SECTIONS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`setup-tab-${id}`}
                aria-selected={section === id}
                aria-controls="setup-tabpanel"
                tabIndex={section === id ? 0 : -1}
                className="setup-tab"
                onClick={() => goto(id)}
                onKeyDown={(event) => {
                  // Left/Right moves between tabs, which is what a tablist
                  // promises the moment role="tablist" is on it.
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
                  event.preventDefault()
                  const index = SECTIONS.indexOf(section)
                  const next = event.key === 'ArrowRight' ? index + 1 : index - 1
                  const target = SECTIONS[(next + SECTIONS.length) % SECTIONS.length]
                  goto(target)
                  document.getElementById(`setup-tab-${target}`)?.focus()
                }}
              >
                {id === 'outlets' ? 'Outlets' : id === 'tills' ? 'Tills' : 'Paired devices'}
                {!loading && (
                  <span className="setup-tab__count">
                    {id === 'outlets' ? bundle.outlets.length : id === 'tills' ? bundle.tills.length : bundle.devices.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="setup-workspace__actions">
            <label className="setup-search">
              <span className="pos-visually-hidden">Search {listLabel}</span>
              <Search size={15} aria-hidden />
              <input
                type="search"
                value={term}
                placeholder={`Search ${listLabel}…`}
                onChange={(event) => setTerm(event.target.value)}
              />
            </label>

            {section === 'outlets' && (
              <button
                type="button"
                className="pos-button pos-button--primary"
                disabled={!canManage}
                title={canManage ? undefined : 'Your role cannot change POS setup'}
                onClick={() => setDrawer({ kind: 'outlet', outlet: null })}
              >
                <Plus size={15} aria-hidden /> Add outlet
              </button>
            )}
            {section === 'tills' && (
              <button
                type="button"
                className="pos-button pos-button--primary"
                disabled={!canManage || summary.outletCount === 0}
                title={summary.outletCount === 0 ? 'Create an outlet first' : undefined}
                onClick={() => setDrawer({ kind: 'till', till: null })}
              >
                <Plus size={15} aria-hidden /> Add till
              </button>
            )}
            {section === 'devices' && (
              <button
                type="button"
                className="pos-button pos-button--primary"
                disabled={!canManage || summary.tillCount === 0}
                title={summary.tillCount === 0 ? 'Create a till first' : undefined}
                onClick={() => setDrawer({ kind: 'device' })}
              >
                <Plus size={15} aria-hidden /> Pair device
              </button>
            )}
          </div>
        </div>

        <div className="setup-workspace__grid">
          <div
            className="setup-panel"
            id="setup-tabpanel"
            role="tabpanel"
            aria-labelledby={`setup-tab-${section}`}
            tabIndex={-1}
          >
            {loading ? (
              <>
                <span className="pos-visually-hidden" role="status">
                  Loading POS setup
                </span>
                <SkeletonRows />
              </>
            ) : section === 'outlets' ? (
              bundle.outlets.length === 0 ? (
                <OutletsEmpty
                  canManage={canManage}
                  onAdd={() => setDrawer({ kind: 'outlet', outlet: null })}
                  onGuide={() => setDrawer({ kind: 'guide' })}
                />
              ) : visibleOutlets.length === 0 ? (
                <NoResults term={term.trim()} noun="outlets" onClear={() => setTerm('')} />
              ) : (
                <OutletList
                  outlets={visibleOutlets}
                  tills={bundle.tills}
                  devices={bundle.devices}
                  warehouses={bundle.warehouses}
                  branches={branches}
                  canManage={canManage}
                  onEdit={(outlet) => setDrawer({ kind: 'outlet', outlet })}
                  onAddTill={(outlet) => setDrawer({ kind: 'till', till: null, outletId: outlet.location_id })}
                  onFloors={() => setDrawer({ kind: 'floors' })}
                  onToggleActive={(outlet) => setConfirm({ kind: 'outlet-off', outlet })}
                />
              )
            ) : section === 'tills' ? (
              bundle.tills.length === 0 ? (
                <TillsEmpty
                  canManage={canManage}
                  hasOutlet={summary.outletCount > 0}
                  onAdd={() => setDrawer({ kind: 'till', till: null })}
                  onAddOutlet={() => setDrawer({ kind: 'outlet', outlet: null })}
                />
              ) : visibleTills.length === 0 ? (
                <NoResults term={term.trim()} noun="tills" onClear={() => setTerm('')} />
              ) : (
                <TillList
                  tills={visibleTills}
                  outlets={bundle.outlets}
                  devices={bundle.devices}
                  canManage={canManage}
                  onEdit={(till) => setDrawer({ kind: 'till', till })}
                  onPair={(till) => setDrawer({ kind: 'device', tillId: till.terminal_id })}
                  onToggleActive={(till) => setConfirm({ kind: 'till-off', till })}
                />
              )
            ) : devicesDenied ? (
              <div className="pos-state pos-state--inline">
                <h2>Devices are not yours to see</h2>
                <p>
                  Listing paired devices needs the “Set up terminals and outlets” permission. The server decides that,
                  not this screen.
                </p>
              </div>
            ) : partial.devices !== null ? (
              <div className="pos-state pos-state--inline" role="alert">
                <h2>Devices could not be loaded</h2>
                <p>{partial.devices}</p>
                <button type="button" className="pos-button pos-button--secondary" onClick={() => void reload()}>
                  <RefreshCw size={15} aria-hidden /> Retry
                </button>
              </div>
            ) : bundle.devices.length === 0 ? (
              <DevicesEmpty
                canManage={canManage}
                hasTill={summary.tillCount > 0}
                onPair={() => setDrawer({ kind: 'device' })}
                onAddTill={() => setDrawer({ kind: 'till', till: null })}
              />
            ) : visibleDevices.length === 0 ? (
              <NoResults term={term.trim()} noun="devices" onClear={() => setTerm('')} />
            ) : (
              <DeviceList
                devices={visibleDevices}
                tills={bundle.tills}
                outlets={bundle.outlets}
                canManage={canManage}
                onRevoke={(device) => setConfirm({ kind: 'revoke', device })}
              />
            )}
          </div>

          <aside className="setup-panel setup-checklist setup-checklist-slot" aria-label="Quick setup checklist">
            {summary.nextAction && !loading && (
              <div className="setup-next">
                <span className="setup-next__label">Next step</span>
                <div>
                  <strong>{summary.nextAction.title}</strong>
                  <p>{summary.nextAction.detail}</p>
                </div>
                <button
                  type="button"
                  className="pos-button pos-button--primary pos-button--small"
                  disabled={!canManage}
                  onClick={() => openStep(summary.nextAction!.stepId)}
                >
                  {summary.nextAction.cta} <ArrowRight size={14} aria-hidden />
                </button>
              </div>
            )}

            <h2>Quick setup checklist</h2>
            <p className="setup-checklist__summary">
              {loading
                ? 'Checking what is already configured…'
                : summary.complete
                  ? 'Every required step is done.'
                  : `${summary.progress.done} of ${summary.progress.total} required steps complete · ${summary.progress.pc}%`}
            </p>

            <div className="setup-flow">
              {summary.steps.map((step) => {
                const label =
                  step.state === 'done'
                    ? 'Complete'
                    : step.state === 'not-required'
                      ? 'Not required'
                      : step.state === 'optional'
                        ? 'Optional'
                        : 'Incomplete'

                return (
                  <button
                    key={step.id}
                    type="button"
                    className="setup-step"
                    onClick={() => openStep(step.id)}
                    aria-label={`${step.title}. ${label}.`}
                  >
                    <span className={`setup-step__icon setup-step__icon--${step.accent}`} aria-hidden>
                      {step.id === 'outlet' && <Store size={17} />}
                      {step.id === 'till' && <MonitorSmartphone size={17} />}
                      {step.id === 'device' && <ShieldCheck size={17} />}
                      {step.id === 'floors' && <Table2 size={17} />}
                      {step.id === 'settings' && <SettingsIcon size={17} />}
                    </span>
                    <span className="setup-step__text">
                      <strong>{step.title}</strong>
                      <span>{step.description}</span>
                    </span>
                    <span
                      className={`setup-step__status${
                        step.state === 'done'
                          ? ' setup-step__status--done'
                          : step.state === 'todo'
                            ? ''
                            : ' setup-step__status--optional'
                      }`}
                      aria-hidden
                    >
                      {step.state === 'done' && <Check size={13} strokeWidth={3} />}
                    </span>
                  </button>
                )
              })}
            </div>

            {!hintDismissed && !loading && (
              <div className="setup-hint">
                <Rocket size={17} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
                <div className="setup-hint__body">
                  <strong>
                    {!summary.complete
                      ? 'Get up and running in under 5 minutes!'
                      : summary.warnings.length === 0
                        ? 'Setup complete'
                        : 'Setup complete — worth a look'}
                  </strong>
                  <span>
                    {!summary.complete
                      ? 'Follow the checklist to complete your setup.'
                      : summary.warnings.length === 0
                        ? 'Your POS is ready for day-to-day operations.'
                        : `Your POS can trade. ${summary.warnings.length} thing${
                            summary.warnings.length === 1 ? '' : 's'
                          } above will not work until fixed.`}
                  </span>
                </div>
                <button
                  type="button"
                  className="setup-hint__close"
                  aria-label="Dismiss this tip"
                  onClick={() => {
                    setHintDismissed(true)
                    try {
                      window.localStorage.setItem(HINT_KEY, '1')
                    } catch {
                      // A browser with storage off just sees the tip again.
                    }
                  }}
                >
                  <X size={15} aria-hidden />
                </button>
              </div>
            )}

            {partial.warehouses !== null && (
              <p className="setup-field__help" style={{ marginTop: 12 }}>
                Warehouse names are unavailable — Inventory could not be reached. Everything else on this page is
                current.
              </p>
            )}
          </aside>
        </div>
      </section>

      {/* ------------------------------------------------------------ drawers */}
      {drawer.kind === 'guide' && (
        <Drawer
          title="How POS setup works"
          description="What each step is for, and which product owns what."
          onClose={closeDrawer}
        >
          <SetupGuide
            onClose={closeDrawer}
            onStart={() => setDrawer({ kind: 'outlet', outlet: null })}
          />
        </Drawer>
      )}

      {drawer.kind === 'outlet' && (
        <OutletDrawer
          outlet={drawer.outlet}
          outlets={bundle.outlets}
          warehouses={bundle.warehouses}
          warehouseError={partial.warehouses}
          onRetryWarehouses={() => void reload()}
          onClose={closeDrawer}
          onSaved={() => {
            closeDrawer()
            void refreshAll()
          }}
        />
      )}

      {drawer.kind === 'till' && (
        <TillDrawer
          till={drawer.till}
          tills={bundle.tills}
          outlets={bundle.outlets}
          defaultOutletId={drawer.outletId}
          onClose={closeDrawer}
          onSaved={() => {
            closeDrawer()
            void refreshAll()
          }}
        />
      )}

      {drawer.kind === 'device' && (
        <DeviceDrawer
          outlets={bundle.outlets}
          tills={bundle.tills}
          defaultTillId={drawer.tillId}
          onClose={closeDrawer}
          onPaired={() => {
            closeDrawer()
            void refreshAll()
          }}
        />
      )}

      {drawer.kind === 'floors' && (
        <FloorsDrawer
          outlets={bundle.outlets}
          floors={bundle.floors}
          tablesByFloor={bundle.tablesByFloor}
          canManage={canManage}
          onClose={closeDrawer}
          onChanged={() => void reload()}
        />
      )}

      {drawer.kind === 'settings' && <SettingsDrawer canManage={canSettings} onClose={closeDrawer} />}

      {/* ------------------------------------------------------- confirmations */}
      {confirm.kind === 'revoke' && (
        <ConfirmDialog
          title="Revoke this device?"
          confirmLabel="Revoke device"
          tone="danger"
          reasonLabel="Why is it being revoked? The reason is kept."
          busy={confirmBusy}
          onConfirm={(reason) => void runConfirm(reason)}
          onCancel={() => setConfirm({ kind: 'none' })}
        >
          <p>
            <strong>{deviceName(confirm.device)}</strong> stops being able to post sales immediately, including anything
            it is still holding offline. Pairing it again issues a new code.
          </p>
        </ConfirmDialog>
      )}

      {confirm.kind === 'outlet-off' && (
        <ConfirmDialog
          title={confirm.outlet.is_active === false ? 'Switch this outlet back on?' : 'Switch this outlet off?'}
          confirmLabel={confirm.outlet.is_active === false ? 'Switch on' : 'Switch off'}
          tone={confirm.outlet.is_active === false ? 'default' : 'danger'}
          busy={confirmBusy}
          onConfirm={() => void runConfirm('')}
          onCancel={() => setConfirm({ kind: 'none' })}
        >
          <p>
            {confirm.outlet.is_active === false ? (
              <>
                <strong>{outletName(confirm.outlet)}</strong> becomes available for signing on again.
              </>
            ) : (
              <>
                <strong>{outletName(confirm.outlet)}</strong> disappears from the till sign-on and its tills stop being
                offered. Nothing already sold there is touched — sales, shifts and returns stay exactly as they are,
                which is why an outlet is switched off rather than deleted.
              </>
            )}
          </p>
        </ConfirmDialog>
      )}

      {confirm.kind === 'till-off' && (
        <ConfirmDialog
          title={confirm.till.is_active === false ? 'Switch this till back on?' : 'Switch this till off?'}
          confirmLabel={confirm.till.is_active === false ? 'Switch on' : 'Switch off'}
          tone={confirm.till.is_active === false ? 'default' : 'danger'}
          busy={confirmBusy}
          onConfirm={() => void runConfirm('')}
          onCancel={() => setConfirm({ kind: 'none' })}
        >
          <p>
            {confirm.till.is_active === false ? (
              <>
                <strong>{tillName(confirm.till)}</strong> can be signed on to again.
              </>
            ) : (
              <>
                <strong>{tillName(confirm.till)}</strong> stops being offered at sign-on.
                {confirm.till.open_session_id
                  ? ' It currently has an OPEN SHIFT — close that first, or the drawer will not be counted.'
                  : ' Its past shifts and sales are untouched.'}
              </>
            )}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )

  function openStep(id: 'outlet' | 'till' | 'device' | 'floors' | 'settings') {
    if (id === 'outlet') {
      goto('outlets')
      if (canManage && summary.outletCount === 0) setDrawer({ kind: 'outlet', outlet: null })
    } else if (id === 'till') {
      goto('tills')
      if (canManage && summary.tillCount === 0 && summary.outletCount > 0) setDrawer({ kind: 'till', till: null })
    } else if (id === 'device') {
      goto('devices')
      if (canManage && summary.deviceCount === 0 && summary.tillCount > 0) setDrawer({ kind: 'device' })
    } else if (id === 'floors') {
      setDrawer({ kind: 'floors' })
    } else {
      setDrawer({ kind: 'settings' })
    }
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SetupHeader({
  summary,
  loading,
  onGuide,
}: {
  summary: ReturnType<typeof summarise>
  loading: boolean
  onGuide: () => void
}) {
  return (
    <section className="setup-heading">
      <div className="setup-heading__intro">
        <span className="setup-heading__icon" aria-hidden>
          <SettingsIcon size={28} />
        </span>
        <div className="setup-heading__text">
          <h1>Setup</h1>
          <p className="pos-description">
            Configure your POS the way your business works. Manage outlets, tills, devices and more.
          </p>

          {!loading && (
            <div className="setup-progress">
              <div
                className="setup-progress__track"
                role="progressbar"
                aria-valuenow={summary.progress.pc}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="POS setup progress"
              >
                <div className="setup-progress__fill" style={{ width: `${summary.progress.pc}%` }} />
              </div>
              <span className="setup-progress__label">
                {!summary.complete
                  ? `POS setup ${summary.progress.pc}% complete`
                  : summary.warnings.length === 0
                    ? 'Setup complete'
                    : `Setup complete · ${summary.warnings.length} to review`}
              </span>
            </div>
          )}
        </div>
      </div>

      <aside className="setup-guide">
        <span className="setup-guide__visual" aria-hidden>
          <StorefrontMark size={80} />
        </span>
        <span className="setup-guide__content">
          <strong>
            {!summary.complete
              ? 'Start by setting up your outlets'
              : summary.warnings.length === 0
                ? 'Your POS is ready to trade'
                : 'Ready to trade, with a few things to review'}
          </strong>
          <span>
            {!summary.complete
              ? 'Create outlets, assign floors, tills and devices to start taking sales in minutes.'
              : summary.warnings.length === 0
                ? 'Everything required is configured. Open the guide any time to see how the pieces fit together.'
                : 'Every required step is done. The notes above are things that will not work until they are fixed.'}
          </span>
        </span>
        <button type="button" className="pos-button pos-button--primary" onClick={onGuide}>
          <PlayCircle size={15} aria-hidden /> Watch Setup Guide
        </button>
      </aside>
    </section>
  )
}

// ---------------------------------------------------------------------------
// One category card
// ---------------------------------------------------------------------------

function CategoryCard({
  accent,
  icon,
  title,
  body,
  chips,
  onClick,
}: {
  accent: 'green' | 'blue' | 'purple' | 'orange' | 'rose'
  icon: React.ReactNode
  title: string
  body: string
  chips: { tone: 'green' | 'blue' | 'purple' | 'orange' | 'rose' | 'neutral' | 'warning'; text: string }[]
  onClick: () => void
}) {
  return (
    <button type="button" className={`setup-card setup-card--${accent}`} onClick={onClick}>
      <span className="setup-card__icon" aria-hidden>
        {icon}
      </span>
      <span className="setup-card__title">
        {title}
        <ArrowRight size={17} className="setup-card__arrow" aria-hidden />
      </span>
      <span className="setup-card__body">{body}</span>
      <span className="setup-card__chips">
        {chips.map((chip) => (
          <span key={chip.text} className={`setup-chip setup-chip--${chip.tone}`}>
            {chip.text}
          </span>
        ))}
      </span>
    </button>
  )
}
