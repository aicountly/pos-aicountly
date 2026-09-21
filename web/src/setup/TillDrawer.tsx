/**
 * Adding and editing a till.
 *
 * A till is the thing a shift opens on and a bill is raised at, so it belongs
 * to exactly one outlet and its code is unique across the company — which is
 * why the duplicate check below looks at every till rather than the ones at
 * the chosen outlet.
 */

import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ApiError } from '../services/api'
import { saveTill } from './data'
import type { SetupOutlet, SetupTill } from './types'
import { TERMINAL_KIND_LABELS, isTableService, outletName, tillName } from './types'
import { Drawer, Field, Section, useToast } from './ui'

export function TillDrawer({
  till,
  tills,
  outlets,
  defaultOutletId,
  onClose,
  onSaved,
}: {
  till: SetupTill | null
  tills: SetupTill[]
  outlets: SetupOutlet[]
  defaultOutletId?: number | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const editing = till !== null
  const sellable = outlets.filter((outlet) => outlet.is_active !== false)

  const [locationId, setLocationId] = useState<number | null>(
    till?.location_id ?? defaultOutletId ?? sellable[0]?.location_id ?? null,
  )
  const [code, setCode] = useState(till?.terminal_code ?? '')
  const [name, setName] = useState(till?.display_name ?? '')
  const [kind, setKind] = useState(till?.terminal_kind ?? 'counter')
  const [printer, setPrinter] = useState(till?.receipt_printer ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const outlet = sellable.find((row) => row.location_id === locationId) ?? null

  const duplicate = useMemo(() => {
    const trimmed = code.trim().toUpperCase()
    if (trimmed === '') return false
    return tills.some(
      (row) => row.terminal_id !== till?.terminal_id && row.terminal_code.trim().toUpperCase() === trimmed,
    )
  }, [code, tills, till])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return

    const found: Record<string, string> = {}
    if (locationId === null) found.outlet = 'Choose the outlet this till stands in.'
    if (code.trim() === '') found.code = 'Give the till a code.'
    else if (duplicate) found.code = 'Another till already uses that code.'
    if (name.trim() === '') found.name = 'Give the till a name.'
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setSaving(true)
    try {
      await saveTill(
        {
          location_id: locationId as number,
          terminal_code: code.trim().toUpperCase(),
          display_name: name.trim(),
          terminal_kind: kind,
          receipt_printer: printer.trim() === '' ? null : printer.trim(),
        },
        till?.terminal_id,
      )
      toast.success(editing ? 'Till settings saved.' : 'Till created.', `${name.trim() || code.trim()} is ready.`)
      onSaved()
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not save the till. Please try again.'
      if (error instanceof ApiError && error.status === 409) setErrors({ code: text })
      else toast.failure(editing ? 'Could not save those changes.' : 'Could not create that till.', text)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={editing ? `Edit ${tillName(till)}` : 'Add till'}
      description={
        editing
          ? 'Change where this till stands and what it prints on.'
          : 'Create a billing till and assign it to an outlet.'
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="setup-till-form" className="pos-button pos-button--primary" disabled={saving}>
            {saving && <Loader2 size={15} className="setup-spin" aria-hidden />}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create till'}
          </button>
        </>
      }
    >
      <form id="setup-till-form" className="setup-drawer__form" onSubmit={submit} noValidate>
        <div className="setup-drawer__body">
          <Section title="Where it stands" description="A till belongs to one outlet and sells that outlet's stock.">
            <Field label="Outlet" required error={errors.outlet}>
              {(props) => (
                <select
                  {...props}
                  value={locationId ?? ''}
                  onChange={(event) => setLocationId(event.target.value === '' ? null : Number(event.target.value))}
                >
                  <option value="">Choose an outlet</option>
                  {sellable.map((row) => (
                    <option key={row.location_id} value={row.location_id}>
                      {outletName(row)} · {row.location_code}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <div className="setup-grid2">
              <Field label="Till code" required error={errors.code}>
                {(props) => (
                  <input
                    {...props}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="T1"
                    autoComplete="off"
                    maxLength={24}
                  />
                )}
              </Field>

              <Field label="Till name" required error={errors.name}>
                {(props) => (
                  <input
                    {...props}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Front counter"
                    autoComplete="off"
                    maxLength={120}
                  />
                )}
              </Field>
            </div>
          </Section>

          <Section title="Hardware" description="What this machine is, and what it prints a receipt on.">
            <Field
              label="Kind"
              hint={
                outlet && !isTableService(outlet.pos_mode) && kind === 'waiter_tablet'
                  ? 'A waiter tablet is only useful where there are tables to take orders at.'
                  : undefined
              }
            >
              {(props) => (
                <select {...props} value={kind} onChange={(event) => setKind(event.target.value)}>
                  {Object.entries(TERMINAL_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field
              label="Receipt printer"
              hint="The printer name as the machine knows it. POS cannot check whether it is switched on or has paper."
            >
              {(props) => (
                <input
                  {...props}
                  value={printer}
                  onChange={(event) => setPrinter(event.target.value)}
                  placeholder="Counter-80mm"
                  autoComplete="off"
                />
              )}
            </Field>
          </Section>

          {sellable.length === 0 && (
            <p className="setup-field__help" style={{ marginTop: 16 }}>
              There is no active outlet to put a till in yet. Create an outlet first.
            </p>
          )}
        </div>
      </form>
    </Drawer>
  )
}
