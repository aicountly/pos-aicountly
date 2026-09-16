import { useCallback, useEffect, useState } from 'react'
import { Copy, MonitorSmartphone, Plus, ShieldOff, Store } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { api } from '../services/api'
import type { Location, Terminal } from '../services/types'
import { Button, Card, DataTable, Field, Input, Notice, Select, StatusBadge } from '../ui'

interface Device {
  device_id: number
  terminal_id: number
  device_uuid: string
  device_label: string | null
  status: string
  last_seen_at: string | null
  revoked_reason: string | null
}

/**
 * Setting the shop up.
 *
 * An OUTLET here is a POS profile, not a branch: the branch is Manage's, and
 * bo_id points at it. What is configured here is what a till needs to know to
 * sell at that branch — which warehouse the stock leaves, which cash account
 * the money lands in, and whether the place runs tables.
 */
export default function Setup() {
  const { session, reload } = usePos()
  const [locations, setLocations] = useState<Location[]>([])
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [l, t, d] = await Promise.all([
        api.one<{ locations: Location[] }>('v1/locations'),
        api.one<{ terminals: Terminal[] }>('v1/terminals'),
        api.one<{ devices: Device[] }>('v1/devices'),
      ])
      setLocations(l.data.locations)
      setTerminals(t.data.terminals)
      setDevices(d.data.devices)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the setup.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const addOutlet = async (form: { location_code: string; display_name: string; pos_mode: string; default_warehouse_id: string }) => {
    setBusy(true)
    try {
      await api.post('v1/locations', {
        location_code: form.location_code,
        display_name: form.display_name,
        pos_mode: form.pos_mode,
        default_warehouse_id: form.default_warehouse_id ? Number(form.default_warehouse_id) : null,
      })
      await load()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that outlet.')
    } finally {
      setBusy(false)
    }
  }

  const addTerminal = async (form: { location_id: string; terminal_code: string; display_name: string }) => {
    setBusy(true)
    try {
      await api.post('v1/terminals', {
        location_id: Number(form.location_id),
        terminal_code: form.terminal_code,
        display_name: form.display_name,
      })
      await load()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that till.')
    } finally {
      setBusy(false)
    }
  }

  const registerDevice = async (terminalId: number) => {
    const label = window.prompt('What should this device be called? (e.g. “Counter iPad”)')
    if (label === null) return
    setBusy(true)
    try {
      const response = await api.post<{ device_token: string }>('v1/devices', {
        terminal_id: terminalId,
        device_uuid: crypto.randomUUID(),
        device_label: label.trim() || null,
      })
      setToken(response.data.device_token)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not register that device.')
    } finally {
      setBusy(false)
    }
  }

  const revokeDevice = async (deviceId: number) => {
    const reason = window.prompt('Why is this device being revoked? The reason is kept.')
    if (reason === null || reason.trim() === '') return
    setBusy(true)
    try {
      await api.post(`v1/devices/${deviceId}/revoke`, { reason: reason.trim() })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke that device.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}

      {token && (
        <Notice tone="warning" title="Copy this token now">
          <p style={{ margin: '0 0 0.5rem' }}>
            It is not shown again — only its hash is stored, which is the point. If it is lost, register the device
            again.
          </p>
          <code
            style={{
              display: 'block',
              padding: '0.5rem',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-sm)',
              wordBreak: 'break-all',
            }}
          >
            {token}
          </code>
          <Button
            tone="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(token)
              setToken(null)
            }}
            style={{ marginTop: '0.5rem' }}
          >
            <Copy size={13} aria-hidden /> Copy and dismiss
          </Button>
        </Notice>
      )}

      <OutletForm onSubmit={addOutlet} busy={busy} />

      <Card title="Outlets" subtitle="A POS profile per selling place. The branch itself lives in Manage.">
        <DataTable
          rows={locations}
          rowKey={(row) => row.location_id}
          columns={[
            { key: 'code', header: 'Code', render: (row) => row.location_code },
            { key: 'name', header: 'Name', render: (row) => row.display_name ?? '—' },
            { key: 'runs_as', header: 'Runs as', render: (row) => row.pos_mode.replace(/_/g, ' ') },
            { key: 'stock_from', header: 'Stock from', render: (row) => (row.default_warehouse_id ? `Warehouse #${row.default_warehouse_id}` : 'Not set') },
            { key: 'branch', header: 'Branch', render: (row) => `#${row.bo_id}` },
          ]}
          empty="No outlets yet. Add one above."
        />
      </Card>

      {locations.length > 0 && <TerminalForm locations={locations} onSubmit={addTerminal} busy={busy} />}

      <Card title="Tills">
        <DataTable
          rows={terminals}
          rowKey={(row) => row.terminal_id}
          columns={[
            { key: 'code', header: 'Code', render: (row) => row.terminal_code },
            { key: 'name', header: 'Name', render: (row) => row.display_name ?? '—' },
            { key: 'kind', header: 'Kind', render: (row) => row.terminal_kind },
            {
              key: 'shift', header: 'Shift',
              render: (row) => <StatusBadge status={row.open_session_id ? 'OPEN' : 'CLOSED'} />,
            },
            {
              key: 'actions', header: '',
              render: (row) => (
                <Button tone="ghost" onClick={() => void registerDevice(row.terminal_id)} disabled={busy}>
                  <MonitorSmartphone size={13} aria-hidden /> Pair a device
                </Button>
              ),
            },
          ]}
          empty="No tills yet."
        />
      </Card>

      <Card
        title="Paired devices"
        subtitle="A device token lets a till post sales. Only its hash is kept — there is no way to read one back."
      >
        <DataTable
          rows={devices}
          rowKey={(row) => row.device_id}
          columns={[
            { key: 'device', header: 'Device', render: (row) => row.device_label ?? row.device_uuid.slice(0, 8) },
            { key: 'till', header: 'Till', render: (row) => `#${row.terminal_id}` },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
            { key: 'last_seen', header: 'Last seen', render: (row) => (row.last_seen_at ? new Date(row.last_seen_at).toLocaleString() : 'Never') },
            {
              key: 'actions', header: '',
              render: (row) =>
                row.status === 'ACTIVE' ? (
                  <Button tone="ghost" onClick={() => void revokeDevice(row.device_id)} disabled={busy}>
                    <ShieldOff size={13} aria-hidden /> Revoke
                  </Button>
                ) : (
                  <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{row.revoked_reason}</span>
                ),
            },
          ]}
          empty="No devices paired."
        />
      </Card>

      {session && (
        <Card title="What you can do" subtitle="Enforced by the server, not by which buttons are shown">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {session.permissions.map((permission) => (
              <span
                key={permission}
                style={{
                  padding: '0.15rem 0.5rem',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  fontSize: '0.75rem',
                  color: 'var(--muted)',
                }}
              >
                {permission}
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function OutletForm({
  onSubmit,
  busy,
}: {
  onSubmit: (form: { location_code: string; display_name: string; pos_mode: string; default_warehouse_id: string }) => Promise<void>
  busy: boolean
}) {
  const [form, setForm] = useState({ location_code: '', display_name: '', pos_mode: 'retail', default_warehouse_id: '' })

  return (
    <Card title="Add an outlet" subtitle="A shop, a restaurant, a counter inside another business">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.75rem' }}>
        <Field label="Code">
          <Input value={form.location_code} onChange={(e) => setForm({ ...form, location_code: e.target.value })} placeholder="MAIN" />
        </Field>
        <Field label="Name">
          <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="Main shop" />
        </Field>
        <Field label="Runs as" hint="Restaurant turns on floors, tables and kitchen tickets.">
          <Select value={form.pos_mode} onChange={(e) => setForm({ ...form, pos_mode: e.target.value })}>
            <option value="retail">Retail counter</option>
            <option value="restaurant">Restaurant</option>
            <option value="quick_service">Quick service</option>
            <option value="hybrid">Both</option>
          </Select>
        </Field>
        <Field label="Stock leaves from" hint="An Inventory warehouse id. Stock itself stays Inventory's.">
          <Input
            type="number"
            value={form.default_warehouse_id}
            onChange={(e) => setForm({ ...form, default_warehouse_id: e.target.value })}
            placeholder="3"
          />
        </Field>
      </div>
      <Button onClick={() => void onSubmit(form)} disabled={busy || form.location_code.trim() === ''} style={{ marginTop: '0.75rem' }}>
        <Store size={14} aria-hidden /> Add outlet
      </Button>
    </Card>
  )
}

function TerminalForm({
  locations,
  onSubmit,
  busy,
}: {
  locations: Location[]
  onSubmit: (form: { location_id: string; terminal_code: string; display_name: string }) => Promise<void>
  busy: boolean
}) {
  const [form, setForm] = useState({ location_id: String(locations[0]?.location_id ?? ''), terminal_code: '', display_name: '' })

  return (
    <Card title="Add a till">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.75rem' }}>
        <Field label="Outlet">
          <Select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
            {locations.map((location) => (
              <option key={location.location_id} value={location.location_id}>
                {location.display_name ?? location.location_code}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Code">
          <Input value={form.terminal_code} onChange={(e) => setForm({ ...form, terminal_code: e.target.value })} placeholder="T1" />
        </Field>
        <Field label="Name">
          <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="Front counter" />
        </Field>
      </div>
      <Button onClick={() => void onSubmit(form)} disabled={busy || form.terminal_code.trim() === ''} style={{ marginTop: '0.75rem' }}>
        <Plus size={14} aria-hidden /> Add till
      </Button>
    </Card>
  )
}
