/**
 * The queue table.
 *
 * Two things here are less obvious than they look.
 *
 * SELECTION IS NOT UNIVERSAL. Only rows this screen can actually act on can be
 * ticked. A posted sale has nowhere to go, and a Needs Attention row must never
 * be swept into a bulk post — that is the whole point of it being separated
 * out. Select-all therefore means "select all the ACTIONABLE rows on screen",
 * not "tick every box", which is the behaviour that quietly posts things people
 * did not mean to post.
 *
 * THE ROW MENU IS FIXED, NOT ABSOLUTE. The table scrolls horizontally, and an
 * absolutely positioned menu inside a scroll container gets clipped by it. So
 * the menu is positioned against the viewport from the button's own rectangle.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Ban, Copy, Download, Eye, FileClock, MoreHorizontal, RefreshCw } from 'lucide-react'
import { money } from '../../ui'
import type { QueueRecord } from '../model'
import { QueueStatusBadge, QueueTypeBadge, dayLabel, timeLabel } from './badges'

export interface TableProps {
  records: QueueRecord[]
  selected: Set<string>
  currency: string
  busyUuids: Set<string>
  canResolve: boolean
  online: boolean
  onToggle: (uuid: string) => void
  onToggleAll: (uuids: string[], select: boolean) => void
  onPrimary: (record: QueueRecord) => void
  onReview: (record: QueueRecord) => void
  onCopy: (text: string, what: string) => void
  onExport: (record: QueueRecord) => void
  onAbandon: (record: QueueRecord) => void
}

/** Can this screen do anything to this row right now? */
export function isActionable(record: QueueRecord): boolean {
  return record.status === 'READY' || record.status === 'FAILED'
}

function primaryLabel(record: QueueRecord): string {
  switch (record.status) {
    case 'READY':
      return 'Post'
    case 'FAILED':
      return 'Retry'
    case 'NEEDS_ATTENTION':
      return 'Review'
    case 'POSTING':
      return 'Posting…'
    default:
      return 'View'
  }
}

// ---------------------------------------------------------------------------
// The overflow menu
// ---------------------------------------------------------------------------

function RowMenu({
  record,
  canResolve,
  online,
  onReview,
  onCopy,
  onExport,
  onAbandon,
  onRetry,
}: {
  record: QueueRecord
  canResolve: boolean
  online: boolean
  onReview: () => void
  onCopy: (text: string, what: string) => void
  onExport: () => void
  onAbandon: () => void
  onRetry: () => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const width = 210
    setPosition({
      top: Math.min(rect.bottom + 4, window.innerHeight - 260),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    })
  }, [open])

  useEffect(() => {
    if (!open) return

    const close = (event: MouseEvent) => {
      if (
        menuRef.current?.contains(event.target as Node) ||
        buttonRef.current?.contains(event.target as Node)
      ) {
        return
      }
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    // A menu pinned to the viewport has to go away when the page moves under it.
    window.addEventListener('scroll', () => setOpen(false), { once: true, capture: true })

    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Abandoning is a real, audited business action — the API asks for a reason
  // and records who gave it — so it is offered, but only to someone who holds
  // offline.resolve, only on a sale the server already has, and never on one
  // that is already settled. It is never a "delete".
  const mayAbandon =
    canResolve && record.origin === 'server' && record.status !== 'POSTED' && record.status !== 'ABANDONED'

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="q-more"
        onClick={() => setOpen((v) => !v)}
        aria-label={`More actions for ${record.reference}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>

      {open && position && (
        <ul
          className="q-menu"
          role="menu"
          ref={menuRef}
          style={{ position: 'fixed', top: position.top, left: position.left, right: 'auto' }}
        >
          <li role="none">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onReview() }}>
              <Eye size={14} aria-hidden /> View details
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onCopy(record.reference, 'Reference') }}
            >
              <Copy size={14} aria-hidden /> Copy reference
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onCopy(record.clientUuid, 'Transaction ID') }}
            >
              <FileClock size={14} aria-hidden /> Copy transaction ID
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onExport() }}>
              <Download size={14} aria-hidden /> Export diagnostics
            </button>
          </li>

          {(isActionable(record) || record.status === 'NEEDS_ATTENTION') && (
            <li role="none">
              <button
                type="button"
                role="menuitem"
                disabled={!online}
                onClick={() => { setOpen(false); onRetry() }}
              >
                <RefreshCw size={14} aria-hidden /> Retry now
              </button>
            </li>
          )}

          {mayAbandon && (
            <>
              <li role="none" aria-hidden>
                <div className="q-menu__sep" />
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() => { setOpen(false); onAbandon() }}
                >
                  <Ban size={14} aria-hidden /> Abandon with a reason…
                </button>
              </li>
            </>
          )}
        </ul>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

interface RowProps extends Omit<TableProps, 'records' | 'selected' | 'onToggleAll'> {
  record: QueueRecord
  index: number
  checked: boolean
}

const Row = memo(function Row({
  record,
  index,
  checked,
  currency,
  busyUuids,
  canResolve,
  online,
  onToggle,
  onPrimary,
  onReview,
  onCopy,
  onExport,
  onAbandon,
}: RowProps) {
  const selectable = isActionable(record)
  const busy = busyUuids.has(record.clientUuid) || record.status === 'POSTING'

  return (
    <tr className={checked ? 'is-selected' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={checked}
          disabled={!selectable}
          onChange={() => onToggle(record.clientUuid)}
          aria-label={`Select ${record.reference}`}
        />
      </td>

      <td className="q-num">{index}</td>

      <td>
        <span className="q-cell-date">
          {dayLabel(record.createdAt)}
          <small>{timeLabel(record.createdAt)}</small>
        </span>
      </td>

      <td>
        <QueueTypeBadge type={record.type} />
      </td>

      <td className="q-cell-ref">{record.reference}</td>

      <td>
        <span
          className={record.customer === 'Not captured on this till' ? 'q-cell-party q-cell-party--unknown' : 'q-cell-party'}
          title={record.customer}
        >
          {record.customer}
        </span>
      </td>

      <td className={record.amount !== null && record.amount < 0 ? 'q-cell-amount q-cell-amount--credit' : 'q-cell-amount'}>
        {record.amount === null ? <span className="q-count">—</span> : money(record.amount, currency)}
      </td>

      <td>
        <QueueStatusBadge status={record.status} />
      </td>

      <td>
        <div className="q-rowactions">
          <button
            type="button"
            className="q-btn q-btn--sm"
            onClick={() => (record.status === 'NEEDS_ATTENTION' || record.status === 'POSTED' || record.status === 'ABANDONED' ? onReview(record) : onPrimary(record))}
            disabled={busy || (isActionable(record) && !online)}
            title={isActionable(record) && !online ? 'Waiting for the connection' : undefined}
          >
            {busy ? 'Posting…' : primaryLabel(record)}
          </button>

          <RowMenu
            record={record}
            canResolve={canResolve}
            online={online}
            onReview={() => onReview(record)}
            onCopy={onCopy}
            onExport={() => onExport(record)}
            onAbandon={() => onAbandon(record)}
            onRetry={() => onPrimary(record)}
          />
        </div>
      </td>
    </tr>
  )
})

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export function OfflineQueueTable(props: TableProps) {
  const { records, selected, onToggleAll } = props

  const selectableUuids = records.filter(isActionable).map((r) => r.clientUuid)
  const allSelected = selectableUuids.length > 0 && selectableUuids.every((uuid) => selected.has(uuid))
  const someSelected = selectableUuids.some((uuid) => selected.has(uuid))

  const headRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = someSelected && !allSelected
  }, [someSelected, allSelected])

  const toggleAll = useCallback(
    () => onToggleAll(selectableUuids, !allSelected),
    [onToggleAll, selectableUuids, allSelected],
  )

  // The shadow under the pinned actions column is only drawn once something is
  // actually scrolled beneath it, so a table that fits has no stray seam.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return

    const update = () => setScrolled(element.scrollLeft > 0)
    update()
    element.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)

    return () => {
      element.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [records.length])

  return (
    <div className={scrolled ? 'q-tablewrap q-tablewrap--scrolled' : 'q-tablewrap'} ref={wrapRef}>
      <table className="q-table">
        <thead>
          <tr>
            <th scope="col">
              <input
                type="checkbox"
                ref={headRef}
                checked={allSelected}
                disabled={selectableUuids.length === 0}
                onChange={toggleAll}
                aria-label="Select all transactions that can be posted"
              />
            </th>
            <th scope="col">#</th>
            <th scope="col">Date &amp; Time</th>
            <th scope="col">Type</th>
            <th scope="col">Reference</th>
            <th scope="col">Customer / Table</th>
            <th scope="col" className="q-th-amount">Amount</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>

        <tbody>
          {/* Spreading `props` here would hand every row the whole records
              array, whose identity changes on each render and would make the
              memo above do nothing. Each callback is passed on its own. */}
          {records.map((record, position) => (
            <Row
              key={record.clientUuid || `s${record.submissionId}`}
              record={record}
              index={position + 1}
              checked={selected.has(record.clientUuid)}
              currency={props.currency}
              busyUuids={props.busyUuids}
              canResolve={props.canResolve}
              online={props.online}
              onToggle={props.onToggle}
              onPrimary={props.onPrimary}
              onReview={props.onReview}
              onCopy={props.onCopy}
              onExport={props.onExport}
              onAbandon={props.onAbandon}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Skeleton rows. A table that collapses to a spinner loses its own shape. */
export function QueueTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="q-tablewrap" aria-hidden>
      <table className="q-table">
        <tbody>
          {Array.from({ length: rows }, (_, index) => (
            <tr key={index}>
              {Array.from({ length: 9 }, (__, cell) => (
                <td key={cell}>
                  <span className="q-skel" style={{ display: 'block', width: cell === 0 ? 16 : '80%' }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
