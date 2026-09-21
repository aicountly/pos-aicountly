/**
 * Floors and tables.
 *
 * Until now the Floor screen told people to "add a floor and its tables under
 * Setup" and Setup had nowhere to do it — `POST v1/floors` and `POST v1/tables`
 * existed with no way to reach them, so a restaurant could be configured only
 * by someone with curl. This is that missing screen; the operational floor plan
 * stays where it is and is not duplicated here.
 */

import { useState } from 'react'
import { Loader2, Plus, Table2 } from 'lucide-react'
import { createFloor, createTable } from './data'
import type { SetupFloor, SetupOutlet } from './types'
import { isTableService, outletName } from './types'
import { Drawer, Field, Section, useToast } from './ui'

export function FloorsDrawer({
  outlets,
  floors,
  tablesByFloor,
  canManage,
  onClose,
  onChanged,
}: {
  outlets: SetupOutlet[]
  floors: SetupFloor[]
  tablesByFloor: Map<number, number>
  canManage: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const sellable = outlets.filter((outlet) => outlet.is_active !== false)
  // Tables belong to a floor and a floor belongs to an outlet; a counter-only
  // shop can still have one, but it is the table-service outlets that need it.
  const suggested = sellable.filter((outlet) => isTableService(outlet.pos_mode) || outlet.pos_mode === 'quick_service')

  const [locationId, setLocationId] = useState<number | null>(suggested[0]?.location_id ?? sellable[0]?.location_id ?? null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [addingTablesTo, setAddingTablesTo] = useState<number | null>(null)

  async function addFloor(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return

    const found: Record<string, string> = {}
    if (locationId === null) found.outlet = 'Choose the outlet this floor is in.'
    if (code.trim() === '') found.code = 'Give the floor a short code.'
    if (name.trim() === '') found.name = 'Give the floor a name.'
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setBusy(true)
    try {
      await createFloor({
        location_id: locationId as number,
        floor_code: code.trim().toUpperCase(),
        floor_name: name.trim(),
      })
      toast.success('Floor created.', `${name.trim()} is ready for tables.`)
      setCode('')
      setName('')
      onChanged()
    } catch (error) {
      toast.failure(
        'Could not create that floor.',
        error instanceof Error ? error.message : 'Please try again in a moment.',
      )
    } finally {
      setBusy(false)
    }
  }

  const byOutlet = sellable
    .map((outlet) => ({ outlet, rows: floors.filter((floor) => floor.location_id === outlet.location_id && floor.is_active !== false) }))
    .filter((group) => group.rows.length > 0)

  return (
    <Drawer
      title="Floors and tables"
      description="Floors and their tables are POS' own — the dining room, not the branch."
      onClose={onClose}
      wide
      footer={
        <button type="button" className="pos-button pos-button--secondary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="setup-drawer__form">
        <div className="setup-drawer__body">
          {canManage && (
            <Section title="Add a floor" description="Ground floor, terrace, private dining — whatever the staff call it.">
              <form onSubmit={addFloor} noValidate>
                <Field label="Outlet" required error={errors.outlet}>
                  {(props) => (
                    <select
                      {...props}
                      value={locationId ?? ''}
                      onChange={(event) => setLocationId(event.target.value === '' ? null : Number(event.target.value))}
                    >
                      <option value="">Choose an outlet</option>
                      {sellable.map((outlet) => (
                        <option key={outlet.location_id} value={outlet.location_id}>
                          {outletName(outlet)}
                          {isTableService(outlet.pos_mode) ? '' : ' (counter)'}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <div className="setup-grid2">
                  <Field label="Floor code" required error={errors.code}>
                    {(props) => (
                      <input
                        {...props}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        placeholder="GF"
                        autoComplete="off"
                        maxLength={16}
                      />
                    )}
                  </Field>
                  <Field label="Floor name" required error={errors.name}>
                    {(props) => (
                      <input
                        {...props}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Ground floor"
                        autoComplete="off"
                        maxLength={80}
                      />
                    )}
                  </Field>
                </div>

                <button type="submit" className="pos-button pos-button--primary" disabled={busy}>
                  {busy ? <Loader2 size={15} className="setup-spin" aria-hidden /> : <Plus size={15} aria-hidden />}
                  Add floor
                </button>
              </form>
            </Section>
          )}

          <Section
            title="Floors"
            description={
              floors.length === 0
                ? 'No floors yet. A table-service outlet needs at least one before anyone can be seated.'
                : 'Tables are what the floor plan seats people at.'
            }
          >
            {byOutlet.length === 0 && (
              <p className="pos-unavailable pos-unavailable--muted">
                <Table2 size={16} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
                <span>
                  Nothing set up yet. Retail counters do not need floors — this only matters where people sit down.
                </span>
              </p>
            )}

            {byOutlet.map((group) => (
              <div key={group.outlet.location_id} style={{ marginBottom: 18 }}>
                <p className="setup-field__label" style={{ marginBottom: 8 }}>
                  {outletName(group.outlet)}
                </p>

                {group.rows.map((floor) => {
                  const tables = tablesByFloor.get(floor.floor_id) ?? 0
                  return (
                    <div
                      key={floor.floor_id}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        padding: 12,
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13.5 }}>{floor.floor_name}</strong>
                        <span className="setup-code">{floor.floor_code}</span>
                        <span className={`setup-chip ${tables === 0 ? 'setup-chip--warning' : 'setup-chip--orange'}`}>
                          {tables === 0 ? 'No tables yet' : `${tables} table${tables === 1 ? '' : 's'}`}
                        </span>
                        {canManage && (
                          <button
                            type="button"
                            className="pos-button pos-button--secondary pos-button--small"
                            style={{ marginLeft: 'auto' }}
                            onClick={() => setAddingTablesTo(addingTablesTo === floor.floor_id ? null : floor.floor_id)}
                            aria-expanded={addingTablesTo === floor.floor_id}
                          >
                            <Plus size={13} aria-hidden /> Add table
                          </button>
                        )}
                      </div>

                      {addingTablesTo === floor.floor_id && (
                        <AddTableForm
                          floorId={floor.floor_id}
                          onAdded={() => {
                            onChanged()
                          }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </Section>

          {!canManage && (
            <p className="setup-field__help">
              Your role can see this setup but not change it. Ask someone with “Set up terminals and outlets”.
            </p>
          )}
        </div>
      </div>
    </Drawer>
  )
}

function AddTableForm({ floorId, onAdded }: { floorId: number; onAdded: () => void }) {
  const toast = useToast()
  const [code, setCode] = useState('')
  const [seats, setSeats] = useState('4')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (code.trim() === '') {
      setError('Give the table a code, like T1.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await createTable({
        floor_id: floorId,
        table_code: code.trim().toUpperCase(),
        table_name: null,
        seats: Math.max(1, Number(seats) || 2),
      })
      toast.success('Table added.', `${code.trim().toUpperCase()} is on the floor plan.`)
      setCode('')
      onAdded()
    } catch (e) {
      toast.failure('Could not add that table.', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }} noValidate>
      <div style={{ flex: '1 1 8rem' }}>
        <label className="setup-field__label" htmlFor={`table-code-${floorId}`}>
          Table code
        </label>
        <input
          id={`table-code-${floorId}`}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="T1"
          autoComplete="off"
          maxLength={16}
          aria-invalid={Boolean(error)}
        />
        {error && <p className="setup-field__error">{error}</p>}
      </div>
      <div style={{ flex: '0 1 6rem' }}>
        <label className="setup-field__label" htmlFor={`table-seats-${floorId}`}>
          Seats
        </label>
        <input
          id={`table-seats-${floorId}`}
          type="number"
          min={1}
          max={40}
          value={seats}
          onChange={(event) => setSeats(event.target.value)}
        />
      </div>
      <button type="submit" className="pos-button pos-button--primary" style={{ marginTop: 24 }} disabled={busy}>
        {busy ? <Loader2 size={15} className="setup-spin" aria-hidden /> : <Plus size={15} aria-hidden />}
        Add
      </button>
    </form>
  )
}
