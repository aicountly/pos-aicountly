/**
 * The right-hand rail: what this device is doing, how the queue behaves, and
 * the promise the screen makes about the data.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE. The safety card says the queue is
 * stored on the device and kept until the server takes it, because that is what
 * the code does. It does NOT say "encrypted", because the outbox is plain
 * IndexedDB (see offline/db.ts). Telling a shop their offline sales are
 * encrypted when they are not is the kind of reassurance that ends an audit
 * badly. If the store is ever encrypted, this copy can change with it.
 */

import { CheckCircle2, ShieldCheck } from 'lucide-react'
import type { Terminal } from '../../services/types'
import type { ConnectivityState } from '../useConnectivity'
import type { QueueStatus, QueueType } from '../model'
import { activeFilterCount, type DateWindow, type QueueFilterState } from '../filters'
import { STATUS_LABEL } from './badges'
import { timeLabel } from './badges'

// ---------------------------------------------------------------------------
// Device status
// ---------------------------------------------------------------------------

export function DeviceStatusCard({
  connectivity,
  syncing,
  terminal,
  terminalId,
  pending,
  lastSyncAt,
  lastAcknowledgedAt,
  storageHealthy,
  autoSync,
  onToggleAutoSync,
}: {
  connectivity: ConnectivityState
  syncing: boolean
  terminal: Terminal | null
  terminalId: number | null
  pending: number
  lastSyncAt: number | null
  lastAcknowledgedAt: string | null
  storageHealthy: boolean
  autoSync: boolean
  onToggleAutoSync: () => void
}) {
  const badge = syncing
    ? { tone: 'q-ministatus--busy', text: 'Syncing' }
    : connectivity === 'ONLINE'
      ? { tone: 'q-ministatus--ok', text: 'Connected' }
      : connectivity === 'DEGRADED'
        ? { tone: 'q-ministatus--bad', text: 'No server' }
        : { tone: 'q-ministatus--warn', text: 'Offline' }

  const deviceName = terminal
    ? `This Terminal (${terminal.terminal_code})`
    : terminalId
      ? `This Terminal (#${terminalId})`
      : 'No till selected'

  return (
    <section className="q-card">
      <div className="q-card__header">
        <h2>Device Status</h2>
        <span className={`q-ministatus ${badge.tone}`}>
          <span className="q-dot" aria-hidden />
          {badge.text}
        </span>
      </div>

      <dl className="q-deflist">
        <div>
          <dt>Device</dt>
          <dd>{deviceName}</dd>
        </div>
        <div>
          <dt>Last Sync</dt>
          <dd>{lastSyncAt ? timeLabel(lastSyncAt) : 'Not yet'}</dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>
            {pending} transaction{pending === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt>Last acknowledgement</dt>
          <dd>{lastAcknowledgedAt ? timeLabel(lastAcknowledgedAt) : '—'}</dd>
        </div>
        <div>
          <dt>Local storage</dt>
          <dd style={{ color: storageHealthy ? undefined : 'var(--q-red)' }}>
            {storageHealthy ? 'Healthy' : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Auto Sync</dt>
          <dd>
            <button
              type="button"
              role="switch"
              aria-checked={autoSync}
              className="q-switch"
              onClick={onToggleAutoSync}
            >
              <span className="q-switch__track" aria-hidden>
                <span className="q-switch__thumb" />
              </span>
              {autoSync ? 'Enabled' : 'Off'}
            </button>
          </dd>
        </div>
      </dl>
    </section>
  )
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

export function OfflineHelpCard({ onLearnMore }: { onLearnMore: () => void }) {
  return (
    <section className="q-card q-card--info">
      <h2>How it works?</h2>

      <ol className="q-steps">
        <li>
          <span aria-hidden>1</span>
          Transactions are saved on this device when you&rsquo;re offline
        </li>
        <li>
          <span aria-hidden>2</span>
          They automatically post when the connection is restored
        </li>
        <li>
          <span aria-hidden>3</span>
          You can also post manually any time the till is online
        </li>
      </ol>

      <button type="button" className="q-link" onClick={onLearnMore}>
        Learn more &rarr;
      </button>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Data safety
// ---------------------------------------------------------------------------

export function QueueSafetyCard() {
  return (
    <section className="q-safe">
      <span className="q-safe__icon" aria-hidden>
        <ShieldCheck size={16} />
      </span>
      <div>
        <strong>Your data is safe</strong>
        <p>
          Offline transactions are stored on this device and kept until the server confirms it has them. A sale is
          never removed because sending it failed.
        </p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<QueueType, string> = {
  SALE: 'Sale',
  RETURN: 'Return',
  PAYMENT: 'Payment',
  ORDER: 'Order',
}

/** The order they are offered in when the queue holds more than one kind. */
const TYPE_ORDER: QueueType[] = ['SALE', 'RETURN', 'PAYMENT', 'ORDER']

const STATUS_OPTIONS: QueueStatus[] = ['READY', 'POSTING', 'FAILED', 'NEEDS_ATTENTION', 'POSTED', 'ABANDONED']

const WINDOW_OPTIONS: { value: DateWindow; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'all', label: 'All dates' },
]

export function QueueFilters({
  filters,
  terminals,
  availableTypes,
  onChange,
  onClear,
}: {
  filters: QueueFilterState
  terminals: Terminal[]
  /**
   * The kinds actually present in the queue. Offering a chip that can only ever
   * return nothing — "Order", on a queue that holds sales, returns and account
   * receipts — teaches people the filters are broken.
   */
  availableTypes: QueueType[]
  onChange: (next: QueueFilterState) => void
  onClear: () => void
}) {
  const typeOptions = TYPE_ORDER.filter((type) => availableTypes.includes(type))
  const toggleType = (type: QueueType) =>
    onChange({
      ...filters,
      types: filters.types.includes(type) ? filters.types.filter((t) => t !== type) : [...filters.types, type],
    })

  const toggleStatus = (status: QueueStatus) =>
    onChange({
      ...filters,
      statuses: filters.statuses.includes(status)
        ? filters.statuses.filter((s) => s !== status)
        : [...filters.statuses, status],
    })

  return (
    <div className="q-filters">
      <div>
        <span className="q-filter__label" id="q-filter-type">
          Transaction type
        </span>
        <div className="q-chiprow" role="group" aria-labelledby="q-filter-type">
          {typeOptions.length === 0 ? (
            <span className="q-count">Nothing in the queue to filter yet.</span>
          ) : (
            typeOptions.map((type) => (
              <button
                type="button"
                key={type}
                className="q-chip"
                aria-pressed={filters.types.includes(type)}
                onClick={() => toggleType(type)}
              >
                {TYPE_LABELS[type]}
              </button>
            ))
          )}
        </div>
      </div>

      <div>
        <span className="q-filter__label" id="q-filter-status">
          Status
        </span>
        <div className="q-chiprow" role="group" aria-labelledby="q-filter-status">
          {STATUS_OPTIONS.map((status) => (
            <button
              type="button"
              key={status}
              className="q-chip"
              aria-pressed={filters.statuses.includes(status)}
              onClick={() => toggleStatus(status)}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>
      </div>

      <label>
        <span className="q-filter__label">Terminal</span>
        <select
          className="q-select"
          value={filters.terminalId ?? ''}
          onChange={(event) =>
            onChange({ ...filters, terminalId: event.target.value === '' ? null : Number(event.target.value) })
          }
        >
          <option value="">All terminals</option>
          {terminals.map((terminal) => (
            <option key={terminal.terminal_id} value={terminal.terminal_id}>
              {terminal.display_name ?? terminal.terminal_code}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="q-filter__label">Date</span>
        <select
          className="q-select"
          value={filters.window}
          onChange={(event) => onChange({ ...filters, window: event.target.value as DateWindow })}
        >
          {WINDOW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="q-filter__label">Retry attempts</span>
        <select
          className="q-select"
          value={filters.minAttempts}
          onChange={(event) => onChange({ ...filters, minAttempts: Number(event.target.value) })}
        >
          <option value={0}>Any</option>
          <option value={1}>Tried at least once</option>
          <option value={3}>Tried 3 or more times</option>
        </select>
      </label>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="q-count">
          {activeFilterCount(filters) === 0
            ? 'No filters applied'
            : `${activeFilterCount(filters)} filter${activeFilterCount(filters) === 1 ? '' : 's'} applied`}
        </span>
        <button type="button" className="q-btn q-btn--sm" onClick={onClear} disabled={activeFilterCount(filters) === 0}>
          Clear
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export function QueueEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="q-empty">
      <span className="q-empty__icon" aria-hidden>
        <CheckCircle2 size={22} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}
