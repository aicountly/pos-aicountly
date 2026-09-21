/**
 * Every form the floor screen opens.
 *
 * All of them replace a window.prompt that used to stand in for them. A prompt
 * cannot say which tables are free, cannot validate a party size, and cannot be
 * cancelled without losing what was typed — and on a touch till it is a system
 * dialog over the application, which is where a busy floor loses its place.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  Building2,
  CalendarPlus,
  Circle,
  RectangleHorizontal,
  Square,
  Trash2,
} from 'lucide-react'
import type {
  FloorKind,
  FloorPlanFloor,
  FloorPlanTable,
  TableShape,
} from '../../services/types'
import { ChoiceRow, Field, Modal } from './parts'
import { tableLabel, tableTitle } from './status'

const FLOOR_KINDS: { value: FloorKind; label: string }[] = [
  { value: 'indoor', label: 'Indoor' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'rooftop', label: 'Rooftop' },
  { value: 'private_dining', label: 'Private dining' },
  { value: 'banquet', label: 'Banquet' },
  { value: 'other', label: 'Other' },
]

const SHAPES: { value: TableShape; label: string; icon: ReactNode }[] = [
  { value: 'square', label: 'Square', icon: <Square size={14} aria-hidden /> },
  { value: 'rectangle', label: 'Rectangle', icon: <RectangleHorizontal size={14} aria-hidden /> },
  { value: 'round', label: 'Round', icon: <Circle size={14} aria-hidden /> },
]

/**
 * Quick-setup presets.
 *
 * Shortcuts through the same form, not a second kind of floor: each one only
 * fills the fields in, and the operator can change every one of them before
 * pressing Create.
 */
const TEMPLATES: { id: string; label: string; tables: number; seats: number; zone: string }[] = [
  { id: 'blank', label: 'Blank', tables: 0, seats: 4, zone: '' },
  { id: 'cafe', label: 'Café', tables: 10, seats: 2, zone: 'Main' },
  { id: 'casual', label: 'Casual dining', tables: 18, seats: 4, zone: 'Main Dining' },
  { id: 'fine', label: 'Fine dining', tables: 12, seats: 4, zone: 'Main Dining' },
  { id: 'bar', label: 'Bar', tables: 8, seats: 2, zone: 'Bar' },
]

function labelOf(floors: FloorPlanFloor[], table: FloorPlanTable): string {
  const floor = floors.find((candidate) => candidate.tables.some((t) => t.table_id === table.table_id))

  return floor ? `${tableLabel(table)} — ${floor.floor_name}` : tableLabel(table)
}

// ---------------------------------------------------------------------------
// Add a floor
// ---------------------------------------------------------------------------

export interface NewFloor {
  floor_name: string
  description: string
  floor_kind: FloorKind
  zone_name: string
  table_count: number
  seats: number
}

export function AddFloorDialog({
  busy,
  onSubmit,
  onClose,
}: {
  busy: boolean
  onSubmit: (floor: NewFloor) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<FloorKind>('indoor')
  const [zone, setZone] = useState('')
  const [tables, setTables] = useState(0)
  const [seats, setSeats] = useState(4)
  const [template, setTemplate] = useState('blank')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '') {
      setError('Give the floor a name — Ground Floor, Rooftop, and so on.')
      return
    }
    onSubmit({
      floor_name: name.trim(),
      description: description.trim(),
      floor_kind: kind,
      zone_name: zone.trim(),
      table_count: tables,
      seats,
    })
  }

  return (
    <Modal
      title="Add a floor"
      description="A floor is a room with tables in it. You can lay the tables out afterwards."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="floor-add" className="pos-button pos-button--primary" disabled={busy}>
            <Building2 size={15} aria-hidden />
            {busy ? 'Creating…' : 'Create floor'}
          </button>
        </>
      }
    >
      <form id="floor-add" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Floor name" error={error ?? undefined} hint="For example Ground Floor, First Floor or Rooftop.">
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            placeholder="Ground Floor"
            maxLength={60}
            required
          />
        </Field>

        <Field label="Description" hint="One line, shown under the floor name on this screen.">
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Main dining area with window seating and a bar section"
            maxLength={160}
          />
        </Field>

        <ChoiceRow label="Floor type" value={kind} options={FLOOR_KINDS} onChange={setKind} />

        <ChoiceRow
          label="Start from"
          value={template}
          options={TEMPLATES.map((preset) => ({ value: preset.id, label: preset.label }))}
          onChange={(id) => {
            setTemplate(id)
            const preset = TEMPLATES.find((candidate) => candidate.id === id)
            if (!preset) return
            setTables(preset.tables)
            setSeats(preset.seats)
            setZone(preset.zone)
          }}
        />

        <div className="floor-fieldrow">
          <Field label="Tables to create" hint="Optional. Add or remove them later.">
            <input
              type="number"
              min={0}
              max={120}
              value={tables}
              onChange={(event) => setTables(Math.max(0, Math.min(120, Number(event.target.value) || 0)))}
            />
          </Field>
          <Field label="Seats per table">
            <input
              type="number"
              min={1}
              max={40}
              value={seats}
              onChange={(event) => setSeats(Math.max(1, Math.min(40, Number(event.target.value) || 1)))}
            />
          </Field>
        </div>

        <Field label="Zone for those tables" hint="Optional. Zones are just names — Main Dining, Window, Bar.">
          <input value={zone} onChange={(event) => setZone(event.target.value)} placeholder="Main Dining" maxLength={40} />
        </Field>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Add or edit a table
// ---------------------------------------------------------------------------

export interface TableDraft {
  table_code: string
  table_name: string
  seats: number
  shape: TableShape
  zone_name: string
  min_covers: number | null
  max_covers: number | null
}

export function TableDialog({
  table,
  zones,
  busy,
  onSubmit,
  onClose,
}: {
  /** null creates a table; a table edits it. */
  table: FloorPlanTable | null
  zones: string[]
  busy: boolean
  onSubmit: (draft: TableDraft) => void
  onClose: () => void
}) {
  const [code, setCode] = useState(table?.table_code ?? '')
  const [name, setName] = useState(table?.table_name ?? '')
  const [seats, setSeats] = useState(table?.seats ?? 4)
  const [shape, setShape] = useState<TableShape>(table?.shape ?? 'square')
  const [zone, setZone] = useState(table?.zone_name ?? '')
  const [minCovers, setMinCovers] = useState(table?.min_covers ?? null)
  const [maxCovers, setMaxCovers] = useState(table?.max_covers ?? null)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (code.trim() === '') {
      setError('A table needs a number or a name to be called by.')
      return
    }
    if (minCovers !== null && maxCovers !== null && minCovers > maxCovers) {
      setError('The smallest party cannot be larger than the largest.')
      return
    }
    onSubmit({
      table_code: code.trim(),
      table_name: name.trim(),
      seats,
      shape,
      zone_name: zone.trim(),
      min_covers: minCovers,
      max_covers: maxCovers,
    })
  }

  return (
    <Modal
      title={table ? `Edit ${tableTitle(table)}` : 'Add a table'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="table-form" className="pos-button pos-button--primary" disabled={busy}>
            {busy ? 'Saving…' : table ? 'Save table' : 'Add table'}
          </button>
        </>
      }
    >
      <form id="table-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="floor-fieldrow">
          <Field label="Table number" error={error ?? undefined}>
            <input
              value={code}
              onChange={(event) => {
                setCode(event.target.value)
                setError(null)
              }}
              placeholder="12"
              maxLength={20}
              required
            />
          </Field>
          <Field label="Seats">
            <input
              type="number"
              min={1}
              max={40}
              value={seats}
              onChange={(event) => setSeats(Math.max(1, Math.min(40, Number(event.target.value) || 1)))}
              required
            />
          </Field>
        </div>

        <Field label="Display name" hint="Optional. Shown instead of the number — Booth 3, Chef's table.">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
        </Field>

        <ChoiceRow label="Shape" value={shape} options={SHAPES} onChange={setShape} />

        <Field label="Zone" hint="Type a new zone name to create it.">
          <input
            value={zone}
            onChange={(event) => setZone(event.target.value)}
            list="floor-zone-options"
            placeholder="Main Dining"
            maxLength={40}
          />
        </Field>
        <datalist id="floor-zone-options">
          {zones.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>

        <div className="floor-fieldrow">
          <Field label="Smallest party" hint="Optional.">
            <input
              type="number"
              min={1}
              max={99}
              value={minCovers ?? ''}
              onChange={(event) => setMinCovers(event.target.value === '' ? null : Number(event.target.value))}
            />
          </Field>
          <Field label="Largest party" hint="Optional.">
            <input
              type="number"
              min={1}
              max={99}
              value={maxCovers ?? ''}
              onChange={(event) => setMaxCovers(event.target.value === '' ? null : Number(event.target.value))}
            />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Seat a party
// ---------------------------------------------------------------------------

export function SeatDialog({
  table,
  busy,
  onSubmit,
  onClose,
}: {
  table: FloorPlanTable
  busy: boolean
  onSubmit: (input: { covers: number; customer_name: string; customer_mobile: string }) => void
  onClose: () => void
}) {
  const [covers, setCovers] = useState(table.reservation?.party_size ?? table.seats)
  const [name, setName] = useState(table.reservation?.guest_name ?? '')
  const [mobile, setMobile] = useState(table.reservation?.guest_mobile ?? '')

  return (
    <Modal
      title={`Seat ${tableTitle(table)}`}
      description="A bill opens with the table, so drinks ordered before the food have somewhere to go."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="seat-form" className="pos-button pos-button--primary" disabled={busy}>
            {busy ? 'Seating…' : 'Seat and start order'}
          </button>
        </>
      }
    >
      <form
        id="seat-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit({ covers, customer_name: name.trim(), customer_mobile: mobile.trim() })
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field
          label="How many guests"
          hint={`This table seats ${table.seats}${table.max_covers ? `, up to ${table.max_covers}` : ''}.`}
        >
          <input
            type="number"
            min={1}
            max={99}
            value={covers}
            onChange={(event) => setCovers(Math.max(1, Math.min(99, Number(event.target.value) || 1)))}
            required
          />
        </Field>

        <div className="floor-fieldrow">
          <Field label="Guest name" hint="Optional.">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </Field>
          <Field label="Mobile" hint="Optional.">
            <input value={mobile} onChange={(event) => setMobile(event.target.value)} maxLength={20} inputMode="tel" />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Book a table
// ---------------------------------------------------------------------------

/** Now, rounded up to the next quarter hour, as a datetime-local value. */
function defaultBookingTime(): string {
  const at = new Date(Date.now() + 60 * 60 * 1000)
  at.setMinutes(Math.ceil(at.getMinutes() / 15) * 15, 0, 0)
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function ReserveDialog({
  table,
  busy,
  onSubmit,
  onClose,
}: {
  table: FloorPlanTable
  busy: boolean
  onSubmit: (input: {
    guest_name: string
    guest_mobile: string
    party_size: number
    reserved_for: string
    hold_minutes: number
    notes: string
  }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [mobile, setMobile] = useState('')
  const [party, setParty] = useState(table.seats)
  const [when, setWhen] = useState(defaultBookingTime)
  const [hold, setHold] = useState(20)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Modal
      title={`Book ${tableTitle(table)}`}
      description="The table shows as reserved from two hours before the booking."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="reserve-form" className="pos-button pos-button--primary" disabled={busy}>
            <CalendarPlus size={15} aria-hidden />
            {busy ? 'Booking…' : 'Book table'}
          </button>
        </>
      }
    >
      <form
        id="reserve-form"
        onSubmit={(event) => {
          event.preventDefault()
          const at = new Date(when)
          if (Number.isNaN(at.getTime())) {
            setError('That is not a time this can book.')
            return
          }
          onSubmit({
            guest_name: name.trim(),
            guest_mobile: mobile.trim(),
            party_size: party,
            reserved_for: at.toISOString(),
            hold_minutes: hold,
            notes: notes.trim(),
          })
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div className="floor-fieldrow">
          <Field label="Guest name">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
          </Field>
          <Field label="Mobile" hint="Optional.">
            <input value={mobile} onChange={(event) => setMobile(event.target.value)} maxLength={20} inputMode="tel" />
          </Field>
        </div>

        <div className="floor-fieldrow">
          <Field label="Booked for" error={error ?? undefined}>
            <input
              type="datetime-local"
              value={when}
              onChange={(event) => {
                setWhen(event.target.value)
                setError(null)
              }}
              required
            />
          </Field>
          <Field label="Party size">
            <input
              type="number"
              min={1}
              max={99}
              value={party}
              onChange={(event) => setParty(Math.max(1, Math.min(99, Number(event.target.value) || 1)))}
              required
            />
          </Field>
        </div>

        <Field label="Hold for" hint="Minutes past the booking before the table goes back on the floor.">
          <input
            type="number"
            min={0}
            max={180}
            value={hold}
            onChange={(event) => setHold(Math.max(0, Math.min(180, Number(event.target.value) || 0)))}
          />
        </Field>

        <Field label="Note" hint="Optional. Birthday, high chair, window seat.">
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={240} />
        </Field>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Move and merge
// ---------------------------------------------------------------------------

export function MoveDialog({
  table,
  floors,
  busy,
  onSubmit,
  onClose,
}: {
  table: FloorPlanTable
  floors: FloorPlanFloor[]
  busy: boolean
  onSubmit: (targetTableId: number) => void
  onClose: () => void
}) {
  const options = useMemo(
    () =>
      floors
        .flatMap((floor) => floor.tables)
        .filter((candidate) => candidate.status === 'FREE' && candidate.table_id !== table.table_id),
    [floors, table.table_id],
  )
  const [target, setTarget] = useState<number | ''>(options[0]?.table_id ?? '')

  return (
    <Modal
      title={`Move the party at ${tableTitle(table)}`}
      description="The bill, the kitchen tickets and the covers all go with them."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pos-button pos-button--primary"
            disabled={busy || target === ''}
            onClick={() => target !== '' && onSubmit(Number(target))}
          >
            {busy ? 'Moving…' : 'Move party'}
          </button>
        </>
      }
    >
      {options.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6 }}>
          Every other table is taken. Free one first, or merge this party onto a table that is already occupied.
        </p>
      ) : (
        <Field label="Move to" hint="Only free tables are listed — an occupied one is a merge, not a move.">
          <select value={target} onChange={(event) => setTarget(Number(event.target.value))}>
            {options.map((option) => (
              <option key={option.table_id} value={option.table_id}>
                {labelOf(floors, option)} · {option.seats} seats
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  )
}

export function MergeDialog({
  table,
  floors,
  busy,
  onSubmit,
  onClose,
}: {
  table: FloorPlanTable
  floors: FloorPlanFloor[]
  busy: boolean
  onSubmit: (targetSessionId: number) => void
  onClose: () => void
}) {
  const options = useMemo(
    () =>
      floors
        .flatMap((floor) => floor.tables)
        .filter(
          (candidate) =>
            candidate.status === 'OCCUPIED' &&
            candidate.table_session_id !== null &&
            candidate.table_id !== table.table_id,
        ),
    [floors, table.table_id],
  )
  const [target, setTarget] = useState<number | ''>(options[0]?.table_session_id ?? '')

  return (
    <Modal
      title={`Put ${tableTitle(table)} onto another bill`}
      description="The lines move across, so there is one bill afterwards and no chance of charging both."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pos-button pos-button--primary"
            disabled={busy || target === ''}
            onClick={() => target !== '' && onSubmit(Number(target))}
          >
            {busy ? 'Merging…' : 'Merge bills'}
          </button>
        </>
      }
    >
      {options.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6 }}>
          No other table is occupied, so there is no bill to merge into.
        </p>
      ) : (
        <Field label="Merge into">
          <select value={target} onChange={(event) => setTarget(Number(event.target.value))}>
            {options.map((option) => (
              <option key={option.table_id} value={option.table_session_id ?? ''}>
                {labelOf(floors, option)} · {option.covers ?? option.seats} guests
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Cleaning and out of service
// ---------------------------------------------------------------------------

export function ServiceStateDialog({
  table,
  state,
  busy,
  onSubmit,
  onClose,
}: {
  table: FloorPlanTable
  state: 'CLEANING' | 'OUT_OF_SERVICE'
  busy: boolean
  onSubmit: (note: string) => void
  onClose: () => void
}) {
  const cleaning = state === 'CLEANING'
  const [note, setNote] = useState('')

  return (
    <Modal
      title={cleaning ? `Mark ${tableTitle(table)} for cleaning` : `Take ${tableTitle(table)} out of service`}
      description={
        cleaning
          ? 'It stays off the floor until somebody marks it ready.'
          : 'It cannot be seated or booked until it is restored.'
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pos-button pos-button--primary"
            style={cleaning ? undefined : { background: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={() => onSubmit(note.trim())}
            disabled={busy}
          >
            {busy ? 'Saving…' : cleaning ? 'Mark cleaning' : 'Take out of service'}
          </button>
        </>
      }
    >
      <Field
        label="Reason"
        hint={cleaning ? 'Optional. Shown on the table until it is ready.' : 'Shown to anyone who picks this table.'}
      >
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={cleaning ? 'Spill' : 'Broken leg — repair booked'}
          maxLength={120}
        />
      </Field>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Floor settings
// ---------------------------------------------------------------------------

export function FloorSettingsDialog({
  floor,
  busy,
  canDelete,
  onSubmit,
  onDelete,
  onClose,
}: {
  floor: FloorPlanFloor
  busy: boolean
  canDelete: boolean
  onSubmit: (input: { floor_name: string; description: string; floor_kind: FloorKind; is_open: boolean }) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(floor.floor_name)
  const [description, setDescription] = useState(floor.description ?? '')
  const [kind, setKind] = useState<FloorKind>(floor.floor_kind)
  const [open, setOpen] = useState(floor.is_open)

  return (
    <Modal
      title="Floor settings"
      description={`${floor.floor_code} · ${floor.tables.length} table${floor.tables.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <div
          className="floor-dialog__foot--split"
          style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
        >
          {canDelete ? (
            <button
              type="button"
              className="pos-button pos-button--secondary"
              style={{ color: 'var(--danger)', borderColor: '#f0c9c9' }}
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2 size={15} aria-hidden />
              Retire floor
            </button>
          ) : (
            <span />
          )}

          <span style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" form="floor-settings" className="pos-button pos-button--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save floor'}
            </button>
          </span>
        </div>
      }
    >
      <form
        id="floor-settings"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit({
            floor_name: name.trim(),
            description: description.trim(),
            floor_kind: kind,
            is_open: open,
          })
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field label="Floor name">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
        </Field>

        <Field label="Description">
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={160} />
        </Field>

        <ChoiceRow label="Floor type" value={kind} options={FLOOR_KINDS} onChange={setKind} />

        <ChoiceRow
          label="Service"
          value={open ? 'open' : 'closed'}
          options={[
            { value: 'open', label: 'Open for service' },
            { value: 'closed', label: 'Closed' },
          ]}
          onChange={(value) => setOpen(value === 'open')}
        />
      </form>
    </Modal>
  )
}
