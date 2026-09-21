/**
 * Offline Queue — the till's control centre for money that has not landed yet.
 *
 * WHAT THIS SCREEN IS FOR. A shop that sold while the line was down has taken
 * real money that the books do not know about. Until every one of those sales
 * is acknowledged, nobody can say what the day was. This screen exists so that
 * at any moment a cashier or a manager can answer, without asking anyone:
 * are we connected, how much is outstanding, what is safe, what is stuck, what
 * is lost (nothing), and what happens next.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *  • It does not keep its own ledger. The outbox is a queue of commands, not a
 *    second set of books — see offline/db.ts. Everything authoritative comes
 *    from the API, and a local row is forgotten only when the server says it
 *    has it.
 *  • It never posts the same sale twice. Every send carries the uuid the device
 *    minted; the server's UNIQUE (cmp_id, client_uuid) turns a duplicate into a
 *    lookup of the original. Post All, a row's Post button and the automatic
 *    drain all go through one lock in offline/sync.ts.
 *  • It never sweeps a broken record into a bulk post. Needs Attention is not
 *    selectable, which is the point of the category.
 *  • It never deletes a sale. Abandoning exists, needs a reason, is audited by
 *    the API, and lives behind the review drawer — it is not a row action.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Search, SlidersHorizontal } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { ApiError } from '../services/api'
import { Notice } from '../ui'
import { outboxAll } from '../offline/db'
import { applyFilters, applySearch, activeFilterCount, EMPTY_FILTERS, type QueueFilterState } from '../offline/filters'
import { explainFailure, type QueueRecord } from '../offline/model'
import { TAB_LABEL, TAB_ORDER, matchesTab, type QueueTab } from '../offline/tabs'
import { useConnectivity } from '../offline/useConnectivity'
import { useOfflineQueue } from '../offline/useOfflineQueue'
import { readAutoSync, writeAutoSync } from '../offline/preferences'
import type { SyncOutcome } from '../offline/sync'
import { OfflineQueueHeader } from '../offline/components/OfflineQueueHeader'
import { OfflineQueueMetrics } from '../offline/components/OfflineQueueMetrics'
import { OfflineQueueTable, QueueTableSkeleton, isActionable } from '../offline/components/OfflineQueueTable'
import {
  DeviceStatusCard,
  OfflineHelpCard,
  QueueEmptyState,
  QueueFilters,
  QueueSafetyCard,
} from '../offline/components/OfflineQueueSide'
import { TransactionReviewDrawer } from '../offline/components/TransactionReviewDrawer'
import { QueueToasts, type Toast, type ToastTone } from '../offline/components/QueueToasts'
import { useMediaQuery } from '../offline/useMediaQuery'
import '../offline/queue.css'

let toastId = 0

export default function OfflineQueue() {
  const { session, terminal, terminalId, can } = usePos()

  const canReadServer = can('reports.view')
  const canResolve = can('offline.resolve')

  const connectivity = useConnectivity()
  const queue = useOfflineQueue(canReadServer)

  const [activeTab, setActiveTab] = useState<QueueTab>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [filters, setFilters] = useState<QueueFilterState>(EMPTY_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [review, setReview] = useState<QueueRecord | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [autoSync, setAutoSync] = useState(readAutoSync)
  const [busyUuids, setBusyUuids] = useState<Set<string>>(new Set())
  const [storageHealthy, setStorageHealthy] = useState(true)

  const narrow = useMediaQuery('(max-width: 1180px)')

  // ------------------------------------------------------------------ toasts

  const pushToast = useCallback((tone: ToastTone, title: string, detail?: string) => {
    const id = ++toastId
    setToasts((current) => [...current.slice(-3), { id, tone, title, detail }])
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  // ------------------------------------------------------------------ search

  useEffect(() => {
    // These records are already on the device, so this debounce is about not
    // re-filtering a long list on every keystroke, not about sparing the API.
    const timer = window.setTimeout(() => setDebouncedSearch(search), 200)
    return () => window.clearTimeout(timer)
  }, [search])

  // ------------------------------------------- is the local store even usable

  useEffect(() => {
    // A till whose IndexedDB is blocked (private window, wiped profile) cannot
    // sell offline at all. Better it says so on this screen than a cashier
    // discovers it at close-out.
    outboxAll()
      .then(() => setStorageHealthy(true))
      .catch(() => setStorageHealthy(false))
  }, [])

  // --------------------------------------------------------------- filtering

  const visible = useMemo(() => {
    const byTab = queue.records.filter((record) => matchesTab(record, activeTab))
    return applySearch(applyFilters(byTab, filters), debouncedSearch)
  }, [queue.records, activeTab, filters, debouncedSearch])

  const tabCounts = useMemo(() => {
    const counts: Record<QueueTab, number> = { all: 0, ready: 0, attention: 0, failed: 0, posted: 0 }
    for (const tab of TAB_ORDER) counts[tab] = queue.records.filter((r) => matchesTab(r, tab)).length
    return counts
  }, [queue.records])

  // Selections must not survive the rows they point at: a row that posts while
  // ticked would otherwise stay "selected" and be counted in the bulk bar.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current
      const live = new Set(queue.records.filter(isActionable).map((r) => r.clientUuid))
      const next = new Set([...current].filter((uuid) => live.has(uuid)))
      return next.size === current.size ? current : next
    })
  }, [queue.records])

  const selectedRecords = useMemo(
    () => queue.records.filter((record) => selected.has(record.clientUuid)),
    [queue.records, selected],
  )

  // --------------------------------------------------------------- posting

  const summarise = useCallback(
    (outcome: SyncOutcome) => {
      if (outcome.busy) {
        pushToast('info', 'Already sending', 'A sync is already running. Nothing was sent twice.')
        return
      }

      const lines: string[] = []
      if (outcome.posted > 0) lines.push(`${outcome.posted} posted`)
      if (outcome.conflicted > 0) lines.push(`${outcome.conflicted} need attention`)
      if (outcome.stillQueued > 0) lines.push(`${outcome.stillQueued} will retry`)
      if (outcome.skipped > 0) lines.push(`${outcome.skipped} held back`)

      if (outcome.posted > 0 && outcome.conflicted === 0 && outcome.stillQueued === 0) {
        const only = outcome.results.find((result) => result.status === 'POSTED')
        pushToast(
          'success',
          outcome.posted === 1 && only ? `${only.reference} posted successfully.` : `${outcome.posted} transactions posted.`,
          outcome.posted === 1 ? undefined : 'The books have all of them.',
        )
        return
      }

      if (outcome.posted === 0 && outcome.stillQueued > 0 && outcome.conflicted === 0) {
        pushToast('warning', 'Nothing could be sent', outcome.message)
        return
      }

      if (lines.length === 0) {
        pushToast('info', 'Nothing to send', outcome.message || 'The queue is already clear.')
        return
      }

      pushToast(outcome.conflicted > 0 ? 'warning' : 'success', 'Sync finished', lines.join(' · ') + '.')
    },
    [pushToast],
  )

  const markBusy = useCallback((uuids: string[], busy: boolean) => {
    setBusyUuids((current) => {
      const next = new Set(current)
      for (const uuid of uuids) {
        if (busy) next.add(uuid)
        else next.delete(uuid)
      }
      return next
    })
  }, [])

  const runPost = useCallback(
    async (uuids: string[], options: { silent?: boolean } = {}) => {
      if (uuids.length === 0) return
      markBusy(uuids, true)
      try {
        const outcome = await queue.post(uuids)
        if (!options.silent || outcome.posted > 0 || outcome.conflicted > 0) summarise(outcome)
      } catch (e) {
        pushToast('danger', 'Could not send', e instanceof Error ? e.message : 'The send failed.')
      } finally {
        markBusy(uuids, false)
      }
    },
    [markBusy, queue, summarise, pushToast],
  )

  /** A sale the server already holds is retried server-side, on its own payload. */
  const runServerRetry = useCallback(
    async (record: QueueRecord) => {
      if (record.submissionId === null) return
      markBusy([record.clientUuid], true)
      try {
        await queue.retryServer(record.submissionId)
        pushToast('success', `${record.reference} sent to the books again.`, 'Refresh in a moment to see where it landed.')
      } catch (e) {
        const message =
          e instanceof ApiError && e.status === 403
            ? 'You do not have permission to retry offline transactions.'
            : e instanceof Error
              ? e.message
              : 'That sale still will not post.'
        pushToast('danger', `${record.reference} could not be retried`, message)
      } finally {
        markBusy([record.clientUuid], false)
      }
    },
    [markBusy, queue, pushToast],
  )

  const onPrimary = useCallback(
    (record: QueueRecord) => {
      if (record.origin === 'server') void runServerRetry(record)
      else void runPost([record.clientUuid])
    },
    [runServerRetry, runPost],
  )

  const readyUuids = useMemo(
    () => queue.records.filter((r) => r.status === 'READY' && r.origin === 'device').map((r) => r.clientUuid),
    [queue.records],
  )

  const failedDeviceUuids = useMemo(
    () => queue.records.filter((r) => r.status === 'FAILED' && r.origin === 'device').map((r) => r.clientUuid),
    [queue.records],
  )

  const online = connectivity.state === 'ONLINE'
  const canPostAll = online && !queue.progress.active && readyUuids.length > 0

  const postAll = useCallback(() => {
    if (!canPostAll) return
    void runPost(readyUuids)
  }, [canPostAll, runPost, readyUuids])

  // ------------------------------------------- coming back from being offline

  const previousState = useRef<string | null>(null)

  useEffect(() => {
    const state = connectivity.state
    const previous = previousState.current
    previousState.current = state

    if (state !== 'ONLINE') return

    // First observation on mount is not a "reconnection" — announcing one every
    // time the page opens would train people to ignore the message.
    if (previous === null) {
      if (autoSync && readyUuids.length > 0) void runPost(readyUuids, { silent: true })
      return
    }

    if (previous === 'ONLINE') return

    if (readyUuids.length > 0) {
      pushToast(
        'info',
        'Connection restored.',
        `${readyUuids.length} transaction${readyUuids.length === 1 ? ' is' : 's are'} ready to post.`,
      )
      if (autoSync) void runPost(readyUuids, { silent: true })
    }
    // readyUuids is intentionally not a dependency: this must fire on a change
    // of CONNECTION, not every time the queue length moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectivity.state, autoSync])

  // ------------------------------------------------------------------ actions

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text)
        pushToast('success', `${what} copied.`, text)
      } catch {
        pushToast('warning', `Could not copy the ${what.toLowerCase()}`, text)
      }
    },
    [pushToast],
  )

  const exportDiagnostics = useCallback(
    (records: QueueRecord[], name: string) => {
      const payload = {
        exported_at: new Date().toISOString(),
        company: session?.company ?? null,
        terminal: terminal?.terminal_code ?? terminalId ?? null,
        app_state: {
          connectivity: connectivity.state,
          auto_sync: autoSync,
          local_storage: storageHealthy ? 'healthy' : 'unavailable',
        },
        transactions: records.map((record) => ({
          transaction_id: record.clientUuid,
          submission_id: record.submissionId,
          held_by: record.origin,
          reference: record.reference,
          type: record.type,
          amount: record.amount,
          created_at: record.createdAt,
          status: record.status,
          attempts: record.attempts,
          last_attempt_at: record.lastAttemptAt,
          error_code: record.lastErrorCode,
          error_message: record.lastErrorMessage,
          explanation: explainFailure(record),
          terminal_id: record.terminalId,
          device_uuid: record.deviceUuid,
          server_reference: record.serverReference,
        })),
      }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)

      pushToast('success', 'Diagnostics exported.', `${records.length} transaction${records.length === 1 ? '' : 's'}.`)
    },
    [session, terminal, terminalId, connectivity.state, autoSync, storageHealthy, pushToast],
  )

  const abandon = useCallback(
    async (record: QueueRecord, note: string) => {
      if (record.submissionId === null) return
      markBusy([record.clientUuid], true)
      try {
        await queue.abandonServer(record.submissionId, note)
        setReview(null)
        pushToast('warning', `${record.reference} abandoned.`, 'The reason has been recorded against your name.')
      } catch (e) {
        pushToast('danger', 'Could not abandon that sale', e instanceof Error ? e.message : 'The server refused.')
      } finally {
        markBusy([record.clientUuid], false)
      }
    },
    [markBusy, queue, pushToast],
  )

  const learnMore = useCallback(() => {
    pushToast(
      'info',
      'How the offline queue works',
      'Sales taken without a connection are kept on this till, each with its own identifier. When the line is back they are sent in order, and only removed once the server confirms it has them — so a sale can never be sent twice or quietly lost.',
    )
  }, [pushToast])

  const toggleSelect = useCallback((uuid: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(uuid)) next.delete(uuid)
      else next.add(uuid)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback((uuids: string[], select: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const uuid of uuids) {
        if (select) next.add(uuid)
        else next.delete(uuid)
      }
      return next
    })
  }, [])

  const toggleAutoSync = useCallback(() => {
    setAutoSync((current) => {
      const next = !current
      writeAutoSync(next)
      return next
    })
  }, [])

  // ------------------------------------------------------------------ render

  const currency = useMemo(() => {
    const locations = session?.locations ?? []
    const owning = terminal ? locations.find((l) => l.location_id === terminal.location_id) : null
    return owning?.currency_code ?? locations[0]?.currency_code ?? 'INR'
  }, [session, terminal])

  const lastAcknowledged = useMemo(() => {
    const stamps = queue.records
      .map((record) => record.serverAcknowledgedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    return stamps.length > 0 ? stamps[stamps.length - 1] : null
  }, [queue.records])

  const selectedPostable = selectedRecords.filter((r) => r.status === 'READY' || r.status === 'FAILED')

  const emptyState = (() => {
    if (debouncedSearch.trim() || activeFilterCount(filters) > 0) {
      return {
        title: 'No matching transactions',
        description: 'Nothing here matches what you searched for. Clear the search or the filters to see the whole queue.',
      }
    }
    switch (activeTab) {
      case 'failed':
        return { title: 'No failed transactions', description: 'Nothing has failed to post. Anything still waiting is under Ready.' }
      case 'attention':
        return { title: 'Nothing needs attention', description: 'No transaction is waiting on a decision from you.' }
      case 'ready':
        return { title: 'Nothing waiting to post', description: 'Every transaction this till took has already gone up.' }
      case 'posted':
        return { title: 'Nothing posted yet today', description: 'Transactions appear here once the server confirms it has them.' }
      default:
        return connectivity.state === 'OFFLINE'
          ? {
              title: 'No offline activity yet',
              description: 'This till is offline but has not taken anything yet. Sales made now are kept here until the connection is back.',
            }
          : {
              title: "You're all caught up",
              description: 'All offline transactions have been successfully posted. Nothing is waiting on this till.',
            }
    }
  })()

  const availableTypes = useMemo(
    () => Array.from(new Set(queue.records.map((record) => record.type))),
    [queue.records],
  )

  const filterPanel = (
    <QueueFilters
      filters={filters}
      terminals={session?.terminals ?? []}
      availableTypes={availableTypes}
      onChange={setFilters}
      onClear={() => setFilters(EMPTY_FILTERS)}
    />
  )

  return (
    <div className="pos-offline">
      <OfflineQueueHeader
        connectivity={connectivity.state}
        checking={connectivity.checking}
        progress={queue.progress}
        queuedCount={queue.counts.queued}
        readyCount={queue.counts.ready}
        failedCount={queue.counts.failed}
        autoSync={autoSync}
        refreshing={queue.refreshing}
        canPostAll={canPostAll}
        onRefresh={() => {
          void connectivity.check()
          void queue.reload()
        }}
        onPostAll={postAll}
        onRetryFailed={() => void runPost(failedDeviceUuids)}
        onExportDiagnostics={() => exportDiagnostics(queue.records, 'offline-queue')}
        onLearnMore={learnMore}
      />

      {queue.error && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="danger" title="This device cannot open its local queue">
            {queue.error} Sales taken now may not be kept if the browser is closed. Tell support before selling offline.
          </Notice>
        </div>
      )}

      {queue.serverError && connectivity.state === 'ONLINE' && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="warning" title="Could not check the server's side of the queue">
            {queue.serverError} What this till is holding is still shown below and is safe.
          </Notice>
        </div>
      )}

      <OfflineQueueMetrics
        counts={queue.counts}
        lastOfflineAt={queue.lastOfflineAt}
        activeTab={activeTab}
        onFilter={setActiveTab}
        loading={queue.loading}
      />

      <div className="q-layout">
        <main className="q-panel">
          <div className="q-toolbar">
            <div className="q-tabs" role="tablist" aria-label="Offline transaction status">
              {TAB_ORDER.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`q-tab-${tab}`}
                  aria-selected={activeTab === tab}
                  aria-controls="q-tabpanel"
                  tabIndex={activeTab === tab ? 0 : -1}
                  className="q-tab"
                  onClick={() => setActiveTab(tab)}
                  onKeyDown={(event) => {
                    // Arrow keys move between tabs, which is what a keyboard
                    // user expects of a tablist and what the old screen lacked.
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
                    event.preventDefault()
                    const index = TAB_ORDER.indexOf(tab)
                    const next =
                      event.key === 'ArrowRight'
                        ? TAB_ORDER[(index + 1) % TAB_ORDER.length]
                        : TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]
                    setActiveTab(next)
                    document.getElementById(`q-tab-${next}`)?.focus()
                  }}
                >
                  {tab === 'posted'
                    ? `Posted (Today: ${queue.counts.postedToday})`
                    : `${TAB_LABEL[tab]} (${tabCounts[tab]})`}
                </button>
              ))}
            </div>

            <div className="q-search">
              <Search size={15} aria-hidden />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by invoice no, type, customer..."
                aria-label="Search the offline queue"
              />
            </div>
          </div>

          {queue.progress.active && (
            <div className="q-progress" role="status">
              <span>{queue.progress.label}</span>
              <span className="q-progress__track">
                <span
                  className="q-progress__bar"
                  style={{ width: `${queue.progress.total ? (queue.progress.done / queue.progress.total) * 100 : 0}%` }}
                />
              </span>
            </div>
          )}

          {selected.size > 0 && (
            <div className="q-bulk">
              <strong>{selected.size} selected</strong>
              <div className="q-bulk__actions">
                <button
                  type="button"
                  className="q-btn q-btn--sm"
                  onClick={() => {
                    const first = selectedRecords.find((r) => r.status === 'NEEDS_ATTENTION')
                    if (first) setReview(first)
                    else setActiveTab('attention')
                  }}
                >
                  Review issues
                </button>
                <button type="button" className="q-btn q-btn--sm" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                <button
                  type="button"
                  className="q-btn q-btn--sm q-btn--primary"
                  disabled={!online || selectedPostable.length === 0 || queue.progress.active}
                  onClick={() => {
                    // Only the device's own rows can be pushed from here; a row
                    // the server holds is retried on its own submission.
                    const deviceUuids = selectedPostable.filter((r) => r.origin === 'device').map((r) => r.clientUuid)
                    const serverRows = selectedPostable.filter((r) => r.origin === 'server')
                    if (deviceUuids.length > 0) void runPost(deviceUuids)
                    for (const row of serverRows) void runServerRetry(row)
                  }}
                >
                  Post selected ({selectedPostable.length})
                </button>
              </div>
            </div>
          )}

          <div id="q-tabpanel" role="tabpanel" aria-labelledby={`q-tab-${activeTab}`}>
            {queue.loading ? (
              <QueueTableSkeleton />
            ) : visible.length === 0 ? (
              <QueueEmptyState title={emptyState.title} description={emptyState.description} />
            ) : (
              <OfflineQueueTable
                records={visible}
                selected={selected}
                currency={currency}
                busyUuids={busyUuids}
                canResolve={canResolve}
                online={online}
                onToggle={toggleSelect}
                onToggleAll={toggleSelectAll}
                onPrimary={onPrimary}
                onReview={setReview}
                onCopy={(text, what) => void copy(text, what)}
                onExport={(record) => exportDiagnostics([record], record.reference)}
                onAbandon={setReview}
              />
            )}
          </div>
        </main>

        <aside className="q-side">
          <section className="q-tools">
            <button
              type="button"
              className="q-btn"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
            >
              <Filter size={14} aria-hidden />
              Filters{activeFilterCount(filters) > 0 ? ` (${activeFilterCount(filters)})` : ''}
            </button>

            <select
              className="q-select"
              value={filters.window}
              onChange={(event) => setFilters({ ...filters, window: event.target.value as QueueFilterState['window'] })}
              aria-label="Date range"
            >
              <option value="all">All dates</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="week">Last 7 days</option>
            </select>

            {filtersOpen && !narrow && <div style={{ gridColumn: '1 / -1' }}>{filterPanel}</div>}
          </section>

          <DeviceStatusCard
            connectivity={connectivity.state}
            syncing={queue.progress.active}
            terminal={terminal}
            terminalId={terminalId}
            pending={queue.counts.queued}
            lastSyncAt={queue.lastSyncAt}
            lastAcknowledgedAt={lastAcknowledged}
            storageHealthy={storageHealthy}
            autoSync={autoSync}
            onToggleAutoSync={toggleAutoSync}
          />

          <OfflineHelpCard onLearnMore={learnMore} />
          <QueueSafetyCard />
        </aside>
      </div>

      {/* On a narrow screen the rail is stacked under the table, so the filters
          come forward as a sheet instead of being buried below the fold. */}
      {filtersOpen && narrow && (
        <>
          <button type="button" className="q-scrim" aria-label="Close filters" onClick={() => setFiltersOpen(false)} />
          <div className="q-drawer" role="dialog" aria-modal="true" aria-label="Filters">
            <div className="q-drawer__head">
              <div>
                <h2>
                  <SlidersHorizontal size={16} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />
                  Filters
                </h2>
                <p>Narrow the queue down to what you are looking for.</p>
              </div>
            </div>
            <div className="q-drawer__body">{filterPanel}</div>
            <div className="q-drawer__foot">
              <button type="button" className="q-btn" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear all
              </button>
              <button type="button" className="q-btn q-btn--primary" onClick={() => setFiltersOpen(false)}>
                Show {visible.length} transaction{visible.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </>
      )}

      {review && (
        <TransactionReviewDrawer
          record={review}
          currency={currency}
          canResolve={canResolve}
          online={online}
          busy={busyUuids.has(review.clientUuid)}
          onClose={() => setReview(null)}
          onRetry={(record) => {
            setReview(null)
            onPrimary(record)
          }}
          onAbandon={(record, note) => void abandon(record, note)}
          onExport={(record) => exportDiagnostics([record], record.reference)}
        />
      )}

      <QueueToasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
