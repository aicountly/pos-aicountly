/**
 * The filter panel, and the chips that show what it left switched on.
 *
 * TWO RULES.
 *
 * A filter is offered only where the data can answer it: the channel and reason
 * lists are built from what this window actually contains, so nobody narrows to
 * "QR order" in a shop that has never taken one and concludes the screen is
 * broken. Statuses and types are fixed enums the server defines, so those are
 * listed in full.
 *
 * Changes are held locally until Apply. Every keystroke rewriting the URL would
 * fire a request per character and make the back button useless.
 */

import { useEffect, useState } from 'react'
import { count } from '../dashboards/format'
import { Drawer } from './Drawer'
import {
  CHANNEL_TERMS,
  labelFor,
  REASON_TERMS,
  RESOLUTION_TERMS,
  STATUS_TERMS,
} from './vocabulary'
import type { ReturnResolution, ReturnStatus, ReturnsSummary } from './types'
import type { ReturnFilters } from './useReturnsRegister'
import type { Terminal } from '../services/types'

const STATUS_ORDER: ReturnStatus[] = ['DRAFT', 'APPROVED', 'RECEIVED', 'SETTLED', 'CANCELLED']
const RESOLUTION_ORDER: ReturnResolution[] = [
  'refund_cash',
  'refund_original',
  'credit_note',
  'store_credit',
  'exchange',
]

interface Draft {
  statuses: ReturnStatus[]
  resolutions: ReturnResolution[]
  channel: string | null
  reason: string | null
  terminalId: number | null
  minAmount: string
  maxAmount: string
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]
}

function draftOf(filters: ReturnFilters): Draft {
  return {
    statuses: filters.statuses,
    resolutions: filters.resolutions,
    channel: filters.channel,
    reason: filters.reason,
    terminalId: filters.terminalId,
    minAmount: filters.minAmount,
    maxAmount: filters.maxAmount,
  }
}

export function ReturnFiltersPanel({
  open,
  filters,
  summary,
  terminals,
  onClose,
  onApply,
  onClear,
}: {
  open: boolean
  filters: ReturnFilters
  summary: ReturnsSummary | null
  terminals: Terminal[]
  onClose: () => void
  onApply: (draft: Draft) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(filters))

  // Re-seed each time the panel opens, so a cancelled edit is really cancelled.
  useEffect(() => {
    if (open) setDraft(draftOf(filters))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Drawer
      open={open}
      title="Filter returns"
      eyebrow="Register"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="returns-button returns-button--ghost"
            onClick={() => {
              onClear()
              onClose()
            }}
          >
            Clear all
          </button>
          <button
            type="button"
            className="returns-button returns-button--primary"
            onClick={() => {
              onApply(draft)
              onClose()
            }}
          >
            Apply filters
          </button>
        </>
      }
    >
      <fieldset className="returns-fieldset">
        <legend>How it was settled</legend>
        <div className="returns-checks">
          {RESOLUTION_ORDER.map((resolution) => (
            <label key={resolution} className="returns-check">
              <input
                type="checkbox"
                checked={draft.resolutions.includes(resolution)}
                onChange={() => setDraft((current) => ({ ...current, resolutions: toggle(current.resolutions, resolution) }))}
              />
              <span>
                {RESOLUTION_TERMS[resolution].label}
                <small>{RESOLUTION_TERMS[resolution].description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="returns-fieldset">
        <legend>Status</legend>
        <div className="returns-checks">
          {STATUS_ORDER.map((status) => (
            <label key={status} className="returns-check">
              <input
                type="checkbox"
                checked={draft.statuses.includes(status)}
                onChange={() => setDraft((current) => ({ ...current, statuses: toggle(current.statuses, status) }))}
              />
              <span>
                {STATUS_TERMS[status].label}
                <small>{STATUS_TERMS[status].description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {summary && summary.channels.length > 0 && (
        <label className="returns-field">
          <span>Channel of the original sale</span>
          <select
            value={draft.channel ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value || null }))}
          >
            <option value="">Any channel</option>
            {summary.channels.map((channel) => (
              <option key={channel.channel} value={channel.channel}>
                {labelFor(CHANNEL_TERMS, channel.channel)} ({count(channel.return_count)})
              </option>
            ))}
          </select>
        </label>
      )}

      {summary && summary.reasons.length > 0 && (
        <label className="returns-field">
          <span>Reason recorded</span>
          <select
            value={draft.reason ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value || null }))}
          >
            <option value="">Any reason</option>
            {summary.reasons.map((reason) => (
              <option key={reason.reason_code} value={reason.reason_code}>
                {labelFor(REASON_TERMS, reason.reason_code)} ({count(reason.return_count)})
              </option>
            ))}
          </select>
        </label>
      )}

      {terminals.length > 0 && (
        <label className="returns-field">
          <span>Till the return was taken on</span>
          <select
            value={draft.terminalId ?? ''}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                terminalId: event.target.value ? Number.parseInt(event.target.value, 10) : null,
              }))
            }
          >
            <option value="">Any till</option>
            {terminals.map((terminal) => (
              <option key={terminal.terminal_id} value={terminal.terminal_id}>
                {terminal.display_name ?? terminal.terminal_code}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset className="returns-fieldset">
        <legend>Amount credited</legend>
        <div className="returns-range">
          <label className="returns-field">
            <span>At least</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={draft.minAmount}
              onChange={(event) => setDraft((current) => ({ ...current, minAmount: event.target.value }))}
            />
          </label>
          <label className="returns-field">
            <span>At most</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={draft.maxAmount}
              onChange={(event) => setDraft((current) => ({ ...current, maxAmount: event.target.value }))}
            />
          </label>
        </div>
      </fieldset>

      <p className="pos-note">
        The date range is set from the toolbar, and is shared with the charts above — the figures and the rows always
        describe the same window.
      </p>
    </Drawer>
  )
}

export interface Chip {
  key: string
  label: string
  onRemove: () => void
}

/** What is switched on, and one click to switch it off again. */
export function ActiveFilterChips({ chips, onClearAll }: { chips: Chip[]; onClearAll: () => void }) {
  if (chips.length === 0) return null

  return (
    <div className="returns-chips" aria-label="Filters in force">
      {chips.map((chip) => (
        <button key={chip.key} type="button" className="returns-chip returns-chip--removable" onClick={chip.onRemove}>
          {chip.label}
          <span aria-hidden>×</span>
          <span className="pos-visually-hidden">, remove this filter</span>
        </button>
      ))}

      <button type="button" className="returns-textlink" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  )
}
