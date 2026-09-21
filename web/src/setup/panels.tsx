/**
 * The three lists in the workspace, their empty states, and the setup guide.
 *
 * One table per entity rather than one generic table with a column config: the
 * columns differ, the row actions differ, and the empty state of each has to
 * say something specific enough to act on. A shared abstraction here would be
 * three configs and a switch.
 *
 * Each cell carries `data-label`, which is what the stylesheet turns into the
 * field name when the table becomes a stack of cards under 720px.
 */

import type { ReactNode } from 'react'
import {
  AlertTriangle,
  Boxes,
  MonitorSmartphone,
  Pencil,
  Plus,
  PlayCircle,
  Power,
  Search,
  ShieldOff,
  Store,
  Table2,
} from 'lucide-react'
import type { BranchOption } from '../services/manage'
import type { SetupDevice, SetupOutlet, SetupTill, Warehouse } from './types'
import { POS_MODE_LABELS, TERMINAL_KIND_LABELS, deviceName, isTableService, outletName, tillName } from './types'
import { RowMenu, Storefront } from './ui'

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  children,
  actions,
  icon,
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="setup-empty">
      <div className="setup-empty__visual">
        {icon ?? <Storefront />}
        <span className="setup-empty__badge" aria-hidden>
          <Plus size={16} strokeWidth={3} />
        </span>
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {actions}
    </div>
  )
}

export function NoResults({ term, noun, onClear }: { term: string; noun: string; onClear: () => void }) {
  return (
    <div className="setup-empty">
      <div className="setup-empty__visual" style={{ color: 'var(--muted)' }}>
        <Search size={54} strokeWidth={1.4} aria-hidden />
      </div>
      <h2>No {noun} match “{term}”</h2>
      <p>Check the spelling, or clear the search to see everything again.</p>
      <button type="button" className="pos-button pos-button--secondary" onClick={onClear}>
        Clear search
      </button>
    </div>
  )
}

function StatusChip({ tone, children }: { tone: 'success' | 'neutral' | 'warning' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={`pos-badge pos-badge--${tone}`}>{children}</span>
}

function branchLabel(boId: number, branches: BranchOption[] | null): string {
  const found = branches?.find((branch) => branch.boId === boId)
  if (found) return found.name
  // Manage is the authority and may be unreachable; showing the reference is
  // honest, showing a made-up name would not be.
  return boId > 0 ? `Branch #${boId}` : 'Not set'
}

// ---------------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------------

export function OutletList({
  outlets,
  tills,
  devices,
  warehouses,
  branches,
  canManage,
  onEdit,
  onAddTill,
  onFloors,
  onToggleActive,
}: {
  outlets: SetupOutlet[]
  tills: SetupTill[]
  devices: SetupDevice[]
  warehouses: Warehouse[]
  branches: BranchOption[] | null
  canManage: boolean
  onEdit: (outlet: SetupOutlet) => void
  onAddTill: (outlet: SetupOutlet) => void
  onFloors: () => void
  onToggleActive: (outlet: SetupOutlet) => void
}) {
  return (
    <div className="pos-table-wrap setup-list">
      <table className="pos-table setup-list__table">
        <caption className="pos-visually-hidden">Outlets configured for this company</caption>
        <thead>
          <tr>
            <th scope="col">Outlet</th>
            <th scope="col">Branch</th>
            <th scope="col">Stock leaves from</th>
            <th scope="col">Tills</th>
            <th scope="col">Devices</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="pos-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {outlets.map((outlet) => {
            const outletTills = tills.filter((till) => till.location_id === outlet.location_id)
            const tillIds = new Set(outletTills.map((till) => till.terminal_id))
            const paired = devices.filter((device) => device.status === 'ACTIVE' && tillIds.has(device.terminal_id))
            const warehouse = warehouses.find((row) => row.id === outlet.default_warehouse_id) ?? null
            const inactive = outlet.is_active === false

            return (
              <tr key={outlet.location_id}>
                <td data-label="Outlet">
                  <span className="setup-entity">
                    <strong>{outletName(outlet)}</strong>
                    <span>
                      <span className="setup-code">{outlet.location_code}</span>
                      {POS_MODE_LABELS[outlet.pos_mode] ?? outlet.pos_mode}
                    </span>
                  </span>
                </td>
                <td data-label="Branch">{branchLabel(outlet.bo_id, branches)}</td>
                <td data-label="Stock leaves from">
                  {outlet.default_warehouse_id === null || outlet.default_warehouse_id === undefined ? (
                    <StatusChip tone="warning">Not set</StatusChip>
                  ) : warehouse ? (
                    <span className="setup-entity">
                      <strong style={{ fontSize: 12.8, fontWeight: 650 }}>{warehouse.name}</strong>
                      {warehouse.code && <span>{warehouse.code}</span>}
                    </span>
                  ) : (
                    // Inventory did not answer, or no longer has it. Say which
                    // one it is rather than rendering a bare number as a name.
                    <span style={{ color: 'var(--muted)' }}>Warehouse #{outlet.default_warehouse_id}</span>
                  )}
                </td>
                <td data-label="Tills" className="is-number">
                  {outletTills.length}
                </td>
                <td data-label="Devices" className="is-number">
                  {paired.length}
                </td>
                <td data-label="Status">
                  {inactive ? (
                    <StatusChip tone="neutral">Inactive</StatusChip>
                  ) : !outlet.default_warehouse_id ? (
                    <StatusChip tone="warning">Incomplete</StatusChip>
                  ) : (
                    <StatusChip tone="success">Active</StatusChip>
                  )}
                </td>
                <td data-label="">
                  <div className="setup-rowactions">
                    {canManage && (
                      <button
                        type="button"
                        className="pos-button pos-button--secondary pos-button--small"
                        onClick={() => onEdit(outlet)}
                      >
                        <Pencil size={13} aria-hidden /> Edit
                      </button>
                    )}
                    <RowMenu label={`More actions for ${outletName(outlet)}`}>
                      {(close) => (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="setup-menu__item"
                            onClick={() => {
                              close()
                              onEdit(outlet)
                            }}
                          >
                            <Pencil size={14} aria-hidden /> {canManage ? 'Edit outlet' : 'View outlet'}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="setup-menu__item"
                            disabled={!canManage || inactive}
                            onClick={() => {
                              close()
                              onAddTill(outlet)
                            }}
                          >
                            <Plus size={14} aria-hidden /> Add a till here
                          </button>
                          {isTableService(outlet.pos_mode) && (
                            <button
                              type="button"
                              role="menuitem"
                              className="setup-menu__item"
                              onClick={() => {
                                close()
                                onFloors()
                              }}
                            >
                              <Table2 size={14} aria-hidden /> Floors and tables
                            </button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            className={inactive ? 'setup-menu__item' : 'setup-menu__item setup-menu__item--danger'}
                            disabled={!canManage}
                            onClick={() => {
                              close()
                              onToggleActive(outlet)
                            }}
                          >
                            <Power size={14} aria-hidden /> {inactive ? 'Switch back on' : 'Switch off'}
                          </button>
                        </>
                      )}
                    </RowMenu>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function OutletsEmpty({ canManage, onAdd, onGuide }: { canManage: boolean; onAdd: () => void; onGuide: () => void }) {
  return (
    <EmptyState
      title="No outlets yet"
      actions={
        <>
          <button
            type="button"
            className="pos-button pos-button--primary"
            onClick={onAdd}
            disabled={!canManage}
            style={{ minHeight: 46, paddingInline: 22 }}
          >
            <Plus size={16} aria-hidden /> Add your first outlet
          </button>
          <div className="setup-empty__divider">
            <span>or</span>
          </div>
          <div className="setup-empty__actions">
            <button type="button" className="pos-button pos-button--secondary" onClick={onGuide}>
              <PlayCircle size={15} aria-hidden /> See how setup works
            </button>
          </div>
        </>
      }
    >
      An outlet is a selling place — a shop, a restaurant, or a counter inside another business. Nothing else in POS can
      be set up until one exists.
    </EmptyState>
  )
}

// ---------------------------------------------------------------------------
// Tills
// ---------------------------------------------------------------------------

export function TillList({
  tills,
  outlets,
  devices,
  canManage,
  onEdit,
  onPair,
  onToggleActive,
}: {
  tills: SetupTill[]
  outlets: SetupOutlet[]
  devices: SetupDevice[]
  canManage: boolean
  onEdit: (till: SetupTill) => void
  onPair: (till: SetupTill) => void
  onToggleActive: (till: SetupTill) => void
}) {
  return (
    <div className="pos-table-wrap setup-list">
      <table className="pos-table setup-list__table">
        <caption className="pos-visually-hidden">Tills configured for this company</caption>
        <thead>
          <tr>
            <th scope="col">Till</th>
            <th scope="col">Outlet</th>
            <th scope="col">Receipt printer</th>
            <th scope="col">Devices</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="pos-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tills.map((till) => {
            const outlet = outlets.find((row) => row.location_id === till.location_id) ?? null
            const paired = devices.filter((device) => device.status === 'ACTIVE' && device.terminal_id === till.terminal_id)
            const inactive = till.is_active === false

            return (
              <tr key={till.terminal_id}>
                <td data-label="Till">
                  <span className="setup-entity">
                    <strong>{tillName(till)}</strong>
                    <span>
                      <span className="setup-code">{till.terminal_code}</span>
                      {TERMINAL_KIND_LABELS[till.terminal_kind] ?? till.terminal_kind}
                    </span>
                  </span>
                </td>
                <td data-label="Outlet">{outlet ? outletName(outlet) : till.location_code ?? `#${till.location_id}`}</td>
                <td data-label="Receipt printer">
                  {till.receipt_printer ?? <span style={{ color: 'var(--muted)' }}>Not set</span>}
                </td>
                <td data-label="Devices">
                  {paired.length === 0 ? (
                    <StatusChip tone="warning">None paired</StatusChip>
                  ) : (
                    <span className="is-number">{paired.length}</span>
                  )}
                </td>
                <td data-label="Status">
                  {inactive ? (
                    <StatusChip tone="neutral">Inactive</StatusChip>
                  ) : till.open_session_id ? (
                    <StatusChip tone="info">Shift open</StatusChip>
                  ) : (
                    <StatusChip tone="success">Active</StatusChip>
                  )}
                </td>
                <td data-label="">
                  <div className="setup-rowactions">
                    {canManage && (
                      <button
                        type="button"
                        className="pos-button pos-button--secondary pos-button--small"
                        onClick={() => onEdit(till)}
                      >
                        <Pencil size={13} aria-hidden /> Edit
                      </button>
                    )}
                    <RowMenu label={`More actions for ${tillName(till)}`}>
                      {(close) => (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="setup-menu__item"
                            onClick={() => {
                              close()
                              onEdit(till)
                            }}
                          >
                            <Pencil size={14} aria-hidden /> {canManage ? 'Edit till' : 'View till'}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="setup-menu__item"
                            disabled={!canManage || inactive}
                            onClick={() => {
                              close()
                              onPair(till)
                            }}
                          >
                            <MonitorSmartphone size={14} aria-hidden /> Pair a device
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className={inactive ? 'setup-menu__item' : 'setup-menu__item setup-menu__item--danger'}
                            disabled={!canManage}
                            onClick={() => {
                              close()
                              onToggleActive(till)
                            }}
                          >
                            <Power size={14} aria-hidden /> {inactive ? 'Switch back on' : 'Switch off'}
                          </button>
                        </>
                      )}
                    </RowMenu>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function TillsEmpty({
  canManage,
  hasOutlet,
  onAdd,
  onAddOutlet,
}: {
  canManage: boolean
  hasOutlet: boolean
  onAdd: () => void
  onAddOutlet: () => void
}) {
  return (
    <EmptyState
      title={hasOutlet ? 'No tills yet' : 'An outlet comes first'}
      icon={<MonitorSmartphone size={64} strokeWidth={1.3} aria-hidden />}
      actions={
        hasOutlet ? (
          <button
            type="button"
            className="pos-button pos-button--primary"
            onClick={onAdd}
            disabled={!canManage}
            style={{ minHeight: 46, paddingInline: 22 }}
          >
            <Plus size={16} aria-hidden /> Add your first till
          </button>
        ) : (
          <button type="button" className="pos-button pos-button--primary" onClick={onAddOutlet} disabled={!canManage}>
            <Store size={16} aria-hidden /> Add an outlet
          </button>
        )
      }
    >
      {hasOutlet
        ? 'A till is where a shift opens and a bill is raised. Create one and assign it to an outlet to start selling.'
        : 'A till stands inside an outlet, so there has to be an outlet for it to stand in first.'}
    </EmptyState>
  )
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export function DeviceList({
  devices,
  tills,
  outlets,
  canManage,
  onRevoke,
}: {
  devices: SetupDevice[]
  tills: SetupTill[]
  outlets: SetupOutlet[]
  canManage: boolean
  onRevoke: (device: SetupDevice) => void
}) {
  return (
    <div className="pos-table-wrap setup-list">
      <table className="pos-table setup-list__table">
        <caption className="pos-visually-hidden">Devices authorised to operate a till</caption>
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col">Till</th>
            <th scope="col">Outlet</th>
            <th scope="col">Paired on</th>
            <th scope="col">Last seen</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="pos-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const till = tills.find((row) => row.terminal_id === device.terminal_id) ?? null
            const outlet = till ? outlets.find((row) => row.location_id === till.location_id) ?? null : null
            const revoked = device.status !== 'ACTIVE'

            return (
              <tr key={device.device_id}>
                <td data-label="Device">
                  <span className="setup-entity">
                    <strong>{deviceName(device)}</strong>
                    <span>{device.device_uuid.slice(0, 8)}</span>
                  </span>
                </td>
                <td data-label="Till">{till ? tillName(till) : `#${device.terminal_id}`}</td>
                <td data-label="Outlet">{outlet ? outletName(outlet) : '—'}</td>
                <td data-label="Paired on">
                  {device.created_at
                    ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(
                        new Date(device.created_at),
                      )
                    : '—'}
                </td>
                <td data-label="Last seen">
                  {/* POS does not write last_seen_at — see docs/DASHBOARDS.md.
                      A paired device is not a device that is switched on, and
                      this column says so rather than showing a green dot. */}
                  {device.last_seen_at ? (
                    new Date(device.last_seen_at).toLocaleString()
                  ) : (
                    <span style={{ color: 'var(--muted)' }} title="POS has no device heartbeat to report">
                      Not reported
                    </span>
                  )}
                </td>
                <td data-label="Status">
                  {revoked ? (
                    <StatusChip tone="danger">Revoked</StatusChip>
                  ) : (
                    <StatusChip tone="success">Paired</StatusChip>
                  )}
                </td>
                <td data-label="">
                  <div className="setup-rowactions">
                    {revoked ? (
                      <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{device.revoked_reason ?? '—'}</span>
                    ) : (
                      canManage && (
                        <button
                          type="button"
                          className="pos-button pos-button--secondary pos-button--small"
                          onClick={() => onRevoke(device)}
                        >
                          <ShieldOff size={13} aria-hidden /> Revoke
                        </button>
                      )
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function DevicesEmpty({
  canManage,
  hasTill,
  onPair,
  onAddTill,
}: {
  canManage: boolean
  hasTill: boolean
  onPair: () => void
  onAddTill: () => void
}) {
  return (
    <EmptyState
      title={hasTill ? 'No devices paired' : 'A till comes first'}
      icon={<MonitorSmartphone size={64} strokeWidth={1.3} aria-hidden />}
      actions={
        hasTill ? (
          <button
            type="button"
            className="pos-button pos-button--primary"
            onClick={onPair}
            disabled={!canManage}
            style={{ minHeight: 46, paddingInline: 22 }}
          >
            <Plus size={16} aria-hidden /> Pair your first device
          </button>
        ) : (
          <button type="button" className="pos-button pos-button--primary" onClick={onAddTill} disabled={!canManage}>
            <Plus size={16} aria-hidden /> Add a till
          </button>
        )
      }
    >
      {hasTill
        ? 'Pairing issues a one-time code that lets a machine keep selling on that till while the connection is down. Only a hash of it is kept.'
        : 'A device is authorised against a till, so there has to be a till to authorise it against.'}
    </EmptyState>
  )
}

// ---------------------------------------------------------------------------
// The setup guide
// ---------------------------------------------------------------------------

const GUIDE = [
  {
    icon: Store,
    title: 'Create an outlet',
    body: 'A selling place — a shop, a restaurant, or a counter inside another business. It points at a branch in Manage and at a warehouse in Inventory; POS keeps the references and neither product’s data.',
  },
  {
    icon: Boxes,
    title: 'Point it at a warehouse',
    body: 'Every sale tells Inventory which warehouse the goods left. Without one, a bill can be raised but the stock movement has nowhere to go.',
  },
  {
    icon: Plus,
    title: 'Add a till',
    body: 'A till is what a shift opens on. Its code appears on the shift report and every sale is attributed to it.',
  },
  {
    icon: MonitorSmartphone,
    title: 'Pair the machine',
    body: 'Pairing issues a one-time code so this browser can keep selling while it is cut off. The code is shown once; only its hash is stored.',
  },
  {
    icon: Table2,
    title: 'Restaurants: add floors and tables',
    body: 'A restaurant outlet needs at least one floor before anyone can be seated, and tables on it before the floor plan is any use.',
  },
]

export function SetupGuide({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  return (
    <div className="setup-drawer__form">
      <div className="setup-drawer__body">
        <p className="setup-field__help" style={{ marginBottom: 18, fontSize: 12.5 }}>
          Five steps, in order. Each one is the thing the next depends on, which is why the checklist will not let you
          skip ahead — there is nothing to skip to.
        </p>

        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 14 }}>
          {GUIDE.map((step, index) => {
            const Icon = step.icon
            return (
              <li key={step.title} style={{ display: 'grid', gridTemplateColumns: '40px minmax(0,1fr)', gap: 12 }}>
                <span className="setup-step__icon setup-step__icon--green" aria-hidden>
                  <Icon size={17} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ display: 'block', fontSize: 13.5 }}>
                    {index + 1}. {step.title}
                  </strong>
                  <span style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.6 }}>{step.body}</span>
                </span>
              </li>
            )
          })}
        </ol>

        <p className="pos-unavailable pos-unavailable--muted" style={{ marginTop: 20 }}>
          <AlertTriangle size={16} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
          <span>
            Company, branch and financial year are set in Aicountly Manage; items, stock and warehouses in Aicountly
            Inventory. POS reads both live and keeps no copy of either, so a change made there is true here on the next
            request.
          </span>
        </p>
      </div>

      <footer className="setup-drawer__footer">
        <button type="button" className="pos-button pos-button--secondary" onClick={onClose}>
          Close
        </button>
        <button type="button" className="pos-button pos-button--primary" onClick={onStart}>
          <Store size={15} aria-hidden /> Start with an outlet
        </button>
      </footer>
    </div>
  )
}
