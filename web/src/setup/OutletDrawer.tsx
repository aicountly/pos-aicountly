/**
 * Adding and editing a POS outlet.
 *
 * The four fields the old inline form had — code, name, runs as, stock leaves
 * from — are all still here and still post to the same endpoint. What changed
 * is the last one: it was a number box labelled "An Inventory warehouse id",
 * which asked an administrator to know that the back store is 3. It is now a
 * search over Inventory's own list, and the id is what goes in the payload.
 *
 * Branch is new to this form and is NOT new to the record: bo_id was always
 * stored, but the old form never sent one, so every outlet silently landed on
 * whichever branch the header happened to be set to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Boxes, Check, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { ApiError, api } from '../services/api'
import { fetchCompanyInfo } from '../services/manage'
import type { BranchOption } from '../services/manage'
import type { CatalogCustomer } from '../services/types'
import { usePos } from '../context/PosContext'
import { saveOutlet } from './data'
import type { SetupOutlet, Warehouse } from './types'
import { isTableService, outletName } from './types'
import { Drawer, Field, Section, useToast } from './ui'

interface Props {
  outlet: SetupOutlet | null
  outlets: SetupOutlet[]
  warehouses: Warehouse[]
  warehouseError: string | null
  onRetryWarehouses: () => void
  onClose: () => void
  onSaved: (outlet: SetupOutlet) => void
}

const MODES = [
  { value: 'retail', title: 'Retail counter', blurb: 'Fast counter billing without table service.' },
  { value: 'restaurant', title: 'Restaurant', blurb: 'Enables floors, tables and kitchen tickets.' },
  { value: 'quick_service', title: 'Quick service', blurb: 'Counter billing with kitchen tickets, no tables.' },
  { value: 'hybrid', title: 'Both', blurb: 'A counter and a dining room in the same outlet.' },
]

export function OutletDrawer({
  outlet,
  outlets,
  warehouses,
  warehouseError,
  onRetryWarehouses,
  onClose,
  onSaved,
}: Props) {
  const { scope } = usePos()
  const toast = useToast()
  const editing = outlet !== null

  const [code, setCode] = useState(outlet?.location_code ?? '')
  const [name, setName] = useState(outlet?.display_name ?? '')
  const [mode, setMode] = useState<string>(outlet?.pos_mode ?? 'retail')
  const [boId, setBoId] = useState<number | null>(
    outlet?.bo_id ?? (scope && scope.bo_id > 0 ? scope.bo_id : null),
  )
  const [warehouseId, setWarehouseId] = useState<number | null>(outlet?.default_warehouse_id ?? null)
  const [cashAccountId, setCashAccountId] = useState<number | null>(outlet?.default_cash_account_id ?? null)
  const [serviceCharge, setServiceCharge] = useState(String(outlet?.service_charge_pc ?? 0))
  const [tips, setTips] = useState(outlet?.tips_enabled ?? false)
  const [negativeOverride, setNegativeOverride] = useState(outlet?.allow_negative_override ?? false)

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // -------------------------------------------------------------- branches
  const [branches, setBranches] = useState<BranchOption[] | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [branchesLoading, setBranchesLoading] = useState(false)

  const loadBranches = useCallback(
    (signal?: AbortSignal) => {
      if (!scope) return
      setBranchesLoading(true)
      setBranchError(null)
      fetchCompanyInfo(scope.cmp_id, signal)
        .then((info) => {
          if (signal?.aborted) return
          setBranches(info.branches)
          // One branch and nothing chosen: choose it rather than make someone
          // pick from a list of one.
          setBoId((current) => current ?? (info.branches.length === 1 ? info.branches[0].boId : null))
        })
        .catch(() => {
          if (signal?.aborted) return
          setBranches(null)
          setBranchError('Unable to load branches from Manage.')
        })
        .finally(() => {
          if (!signal?.aborted) setBranchesLoading(false)
        })
    },
    [scope],
  )

  useEffect(() => {
    const controller = new AbortController()
    loadBranches(controller.signal)
    return () => controller.abort()
  }, [loadBranches])

  // -------------------------------------------------- cash account (Books)
  const [accounts, setAccounts] = useState<CatalogCustomer[] | null>(null)
  const [accountsFailed, setAccountsFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api
      .list<CatalogCustomer>('v1/catalog/payment-accounts', undefined, controller.signal)
      .then((response) => !controller.signal.aborted && setAccounts(response.data))
      .catch(() => !controller.signal.aborted && setAccountsFailed(true))
    return () => controller.abort()
  }, [])

  // ------------------------------------------------------------ validation
  const duplicateCode = useMemo(() => {
    const trimmed = code.trim().toUpperCase()
    if (trimmed === '') return false
    return outlets.some(
      (row) => row.location_id !== outlet?.location_id && row.location_code.trim().toUpperCase() === trimmed,
    )
  }, [code, outlets, outlet])

  const branchBlocked = !editing && branches === null

  function validate(): boolean {
    const found: Record<string, string> = {}
    if (code.trim() === '') found.code = 'Give the outlet a code.'
    else if (duplicateCode) found.code = 'Another outlet already uses that code.'
    if (name.trim() === '') found.name = 'Give the outlet a name.'
    if (!editing && boId === null) found.branch = 'Choose the branch this outlet sells at.'
    if (warehouseId === null) found.warehouse = 'Choose the warehouse stock leaves from.'

    const charge = Number(serviceCharge)
    if (!Number.isFinite(charge) || charge < 0 || charge > 100) found.service = 'Enter a percentage between 0 and 100.'

    setErrors(found)
    return Object.keys(found).length === 0
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return
    if (!validate()) return

    setSaving(true)
    try {
      const saved = await saveOutlet(
        {
          location_code: code.trim().toUpperCase(),
          display_name: name.trim(),
          pos_mode: mode,
          bo_id: boId,
          default_warehouse_id: warehouseId,
          default_cash_account_id: cashAccountId,
          service_charge_pc: Number(serviceCharge) || 0,
          tips_enabled: tips,
          allow_negative_override: negativeOverride,
        },
        outlet?.location_id,
      )
      toast.success(
        editing ? 'Outlet settings saved.' : 'Outlet created.',
        `${name.trim() || code.trim()} is ready to use.`,
      )
      onSaved(saved)
    } catch (error) {
      // A field the server names goes next to that field; anything else is a
      // message, not a stack trace.
      const field = error instanceof ApiError ? (error.details.field as string | undefined) : undefined
      const text = error instanceof Error ? error.message : 'Could not save the outlet. Please try again.'
      if (field === 'location_code') setErrors((current) => ({ ...current, code: text }))
      else if (error instanceof ApiError && error.status === 409) setErrors((current) => ({ ...current, code: text }))
      else toast.failure(editing ? 'Could not save those changes.' : 'Could not create that outlet.', text)
    } finally {
      setSaving(false)
    }
  }

  const branchName = branches?.find((branch) => branch.boId === outlet?.bo_id)?.name

  return (
    <Drawer
      title={editing ? `Edit ${outletName(outlet)}` : 'Add outlet'}
      description={
        editing
          ? 'Change how this selling location behaves and where its stock comes from.'
          : 'Create a POS selling location and connect it to the correct stock source.'
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="setup-outlet-form" className="pos-button pos-button--primary" disabled={saving}>
            {saving && <Loader2 size={15} className="setup-spin" aria-hidden />}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create outlet'}
          </button>
        </>
      }
    >
      <form id="setup-outlet-form" className="setup-drawer__form" onSubmit={submit} noValidate>
        <div className="setup-drawer__body">
          <Section title="Basic details" description="Define how this POS outlet should operate.">
            <div className="setup-grid2">
              <Field label="Outlet code" required error={errors.code}>
                {(props) => (
                  <input
                    {...props}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="MAIN"
                    autoComplete="off"
                    maxLength={24}
                  />
                )}
              </Field>

              <Field label="Outlet name" required error={errors.name}>
                {(props) => (
                  <input
                    {...props}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Main shop"
                    autoComplete="off"
                    maxLength={120}
                  />
                )}
              </Field>
            </div>

            <Field
              label="Branch"
              required={!editing}
              error={errors.branch}
              hint="Branches belong to Aicountly Manage. POS keeps the reference, never a copy."
            >
              {(props) =>
                branchError !== null ? (
                  <div className="pos-unavailable" style={{ alignItems: 'center' }}>
                    <AlertTriangle size={16} aria-hidden />
                    <div style={{ minWidth: 0 }}>
                      {branchError}
                      {editing && branchName === undefined && outlet && (
                        <> This outlet stays on branch #{outlet.bo_id}.</>
                      )}
                    </div>
                    <button
                      type="button"
                      className="pos-button pos-button--secondary pos-button--small"
                      onClick={() => loadBranches()}
                      style={{ marginLeft: 'auto' }}
                    >
                      <RefreshCw size={13} aria-hidden /> Retry
                    </button>
                  </div>
                ) : (
                  <select
                    {...props}
                    value={boId ?? ''}
                    disabled={branchesLoading || branches === null}
                    onChange={(event) => setBoId(event.target.value === '' ? null : Number(event.target.value))}
                  >
                    <option value="">{branchesLoading ? 'Loading branches…' : 'Choose a branch'}</option>
                    {(branches ?? []).map((branch) => (
                      <option key={branch.boId} value={branch.boId}>
                        {branch.name}
                        {branch.isHeadOffice ? ' (head office)' : ''}
                      </option>
                    ))}
                  </select>
                )
              }
            </Field>

            <div className="setup-field">
              <span className="setup-field__label" id="setup-outlet-mode">
                Runs as <span className="setup-field__req" aria-hidden>*</span>
                <span className="pos-visually-hidden">(required)</span>
              </span>
              <div className="setup-choice" role="radiogroup" aria-labelledby="setup-outlet-mode">
                {MODES.map((option) => (
                  <label
                    key={option.value}
                    className={`setup-choice__option${mode === option.value ? ' setup-choice__option--on' : ''}`}
                  >
                    <input
                      type="radio"
                      name="pos_mode"
                      value={option.value}
                      checked={mode === option.value}
                      onChange={() => setMode(option.value)}
                    />
                    <span className="setup-choice__text">
                      <strong>{option.title}</strong>
                      <span>{option.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </Section>

          <Section
            title="Inventory"
            description="Choose the Inventory warehouse that sold stock is issued from."
          >
            <Field
              label="Stock leaves from"
              required
              error={errors.warehouse}
              hint="Stock stays managed by Aicountly Inventory. POS names this warehouse when it posts the movement for a sale."
            >
              {(props) => (
                <WarehousePicker
                  {...props}
                  warehouses={warehouses}
                  failed={warehouseError}
                  onRetry={onRetryWarehouses}
                  value={warehouseId}
                  onChange={setWarehouseId}
                />
              )}
            </Field>
          </Section>

          <Section
            title={isTableService(mode) || mode === 'quick_service' ? 'Money and service' : 'Money'}
            description="Optional. Everything here has a working default and can be changed later."
          >
            <Field
              label="Cash lands in"
              hint={
                accountsFailed
                  ? 'Books could not be reached, so this cannot be changed right now. The outlet works without it.'
                  : 'A Smart Books cash or bank account. POS keeps the reference; the ledger stays Books’.'
              }
            >
              {(props) => (
                <select
                  {...props}
                  value={cashAccountId ?? ''}
                  disabled={accountsFailed || accounts === null}
                  onChange={(event) => setCashAccountId(event.target.value === '' ? null : Number(event.target.value))}
                >
                  <option value="">
                    {accountsFailed ? 'Unavailable' : accounts === null ? 'Loading accounts…' : 'Not set'}
                  </option>
                  {(accounts ?? []).map((account) => (
                    <option key={account.acc_id} value={account.acc_id}>
                      {account.acc_name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {(isTableService(mode) || mode === 'quick_service') && (
              <>
                <Field label="Service charge %" error={errors.service} hint="Added to a table bill. 0 turns it off.">
                  {(props) => (
                    <input
                      {...props}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={serviceCharge}
                      onChange={(event) => setServiceCharge(event.target.value)}
                    />
                  )}
                </Field>

                <label className="setup-switch">
                  <span className="setup-switch__text">
                    <strong>Accept tips</strong>
                    <span>Shows a tip line at checkout for this outlet.</span>
                  </span>
                  <input type="checkbox" checked={tips} onChange={(event) => setTips(event.target.checked)} />
                </label>
              </>
            )}

            <label className="setup-switch">
              <span className="setup-switch__text">
                <strong>Allow selling past a stock warning</strong>
                <span>
                  Inventory still decides what is in stock. This only decides whether a cashier holding the permission
                  may override its warning.
                </span>
              </span>
              <input
                type="checkbox"
                checked={negativeOverride}
                onChange={(event) => setNegativeOverride(event.target.checked)}
              />
            </label>
          </Section>

          {branchBlocked && (
            <p className="setup-field__help" style={{ marginTop: 16 }}>
              A new outlet cannot be created until Manage answers with the branch list, because an outlet that sells at
              no branch cannot post anything.
            </p>
          )}
        </div>
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// The warehouse picker
// ---------------------------------------------------------------------------

/**
 * A combobox over Inventory's warehouses.
 *
 * The list arrives once with the rest of the screen and is filtered in the
 * browser, so typing costs nothing — Inventory returns at most 200 of these and
 * a request per keystroke would be a request per keystroke for no benefit.
 * When Inventory is unreachable this says so and offers Retry; it does NOT fall
 * back to a box for typing a raw id, which is the thing this replaced.
 */
function WarehousePicker({
  id,
  warehouses,
  failed,
  onRetry,
  value,
  onChange,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  id: string
  warehouses: Warehouse[]
  failed: string | null
  onRetry: () => void
  value: number | null
  onChange: (id: number | null) => void
  'aria-describedby': string | undefined
  'aria-invalid': boolean
}) {
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = `${id}-list`

  const selected = warehouses.find((warehouse) => warehouse.id === value) ?? null

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase()
    const rows = needle === ''
      ? warehouses
      : warehouses.filter(
          (warehouse) =>
            warehouse.name.toLowerCase().includes(needle) || (warehouse.code ?? '').toLowerCase().includes(needle),
        )
    return rows.slice(0, 50)
  }, [warehouses, term])

  useEffect(() => setCursor(0), [term])

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  if (failed !== null) {
    return (
      <div className="pos-unavailable" style={{ alignItems: 'center' }}>
        <AlertTriangle size={16} aria-hidden />
        <div style={{ minWidth: 0 }}>
          Unable to load warehouses from Inventory. {failed}
        </div>
        <button
          type="button"
          className="pos-button pos-button--secondary pos-button--small"
          onClick={onRetry}
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={13} aria-hidden /> Retry
        </button>
      </div>
    )
  }

  if (selected) {
    return (
      <div className="setup-picked">
        <Boxes size={16} aria-hidden style={{ flex: '0 0 auto', color: 'var(--accent)' }} />
        <span className="setup-picked__name">
          {selected.name}
          {selected.code && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {selected.code}</span>}
        </span>
        <button
          type="button"
          className="setup-iconbutton"
          onClick={() => {
            onChange(null)
            setOpen(true)
          }}
          aria-label={`Change warehouse, currently ${selected.name}`}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
    )
  }

  // A warehouse id that Inventory's list does not contain — it was renamed,
  // archived, or belongs to a company this user cannot see. Say so; do not
  // silently blank the field the outlet is already using.
  if (value !== null) {
    return (
      <div className="pos-unavailable" style={{ alignItems: 'center' }}>
        <AlertTriangle size={16} aria-hidden />
        <div style={{ minWidth: 0 }}>
          This outlet points at warehouse #{value}, which is not in Inventory’s current list.
        </div>
        <button
          type="button"
          className="pos-button pos-button--secondary pos-button--small"
          onClick={() => onChange(null)}
          style={{ marginLeft: 'auto' }}
        >
          Choose another
        </button>
      </div>
    )
  }

  return (
    <div className="setup-picker" ref={boxRef}>
      <div className="setup-search" style={{ width: '100%' }}>
        <Search size={15} aria-hidden />
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={term}
          placeholder={warehouses.length === 0 ? 'No warehouses in Inventory' : 'Search warehouses…'}
          disabled={warehouses.length === 0}
          onChange={(event) => {
            setTerm(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setCursor((index) => Math.min(index + 1, matches.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && open && matches[cursor]) {
              event.preventDefault()
              onChange(matches[cursor].id)
              setOpen(false)
            } else if (event.key === 'Escape' && open) {
              event.stopPropagation()
              setOpen(false)
            }
          }}
        />
      </div>

      {open && (
        <div className="setup-picker__list" id={listId} role="listbox">
          {warehouses.length === 0 && (
            <p className="setup-picker__note">Inventory has no warehouses for this company yet.</p>
          )}
          {warehouses.length > 0 && matches.length === 0 && (
            <p className="setup-picker__note">No warehouse matches “{term.trim()}”.</p>
          )}
          {matches.map((warehouse, index) => (
            <button
              key={warehouse.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              className="setup-picker__option"
              onMouseEnter={() => setCursor(index)}
              onClick={() => {
                onChange(warehouse.id)
                setOpen(false)
              }}
            >
              <span style={{ minWidth: 0 }}>
                <strong style={{ fontWeight: 650 }}>{warehouse.name}</strong>
                {warehouse.code && <span style={{ color: 'var(--muted)' }}> · {warehouse.code}</span>}
              </span>
              {warehouse.isActive === false ? (
                <span className="setup-chip setup-chip--neutral">Inactive</span>
              ) : (
                index === cursor && <Check size={15} aria-hidden style={{ color: 'var(--accent)' }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
