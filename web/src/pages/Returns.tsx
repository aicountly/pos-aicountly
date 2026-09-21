/**
 * Returns & Exchanges — the counter's workspace for goods coming back.
 *
 * HOW IT HANGS TOGETHER. The URL is the state: the window, the tab, the search
 * and every filter live in the query string, and the two requests this screen
 * makes — a page of the register, and the summary above it — are built from the
 * SAME filter object. That is what stops the KPIs describing one set of returns
 * while the table shows another, which is the classic way a dashboard lies.
 *
 * WHAT IT REFUSES TO DO. It does not total the page on screen to draw a KPI, it
 * does not keep a customer or item list of its own, and it does not compute the
 * money that gets recorded — the server does all three. The arithmetic in the
 * new-return flow is a preview for the person at the counter, and says so.
 *
 * `/returns/:id` opens the same screen with that return's panel open, so a
 * return is a link somebody can send.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { PackageOpen } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { returnsService } from '../services/returns'
import { count, money } from '../dashboards/format'
import { Panel } from '../dashboards/shell'
import { Notice } from '../ui'
import { Drawer } from '../returns/Drawer'
import { NewReturnFlow } from '../returns/NewReturnFlow'
import { ReturnDetailsDrawer } from '../returns/ReturnDetailsDrawer'
import { ActiveFilterChips, ReturnFiltersPanel, type Chip } from '../returns/ReturnFiltersPanel'
import { ReturnsAnalytics, ReturnsInsight } from '../returns/ReturnsAnalytics'
import { ReturnsHero } from '../returns/ReturnsHero'
import { ReturnsKpiGrid } from '../returns/ReturnsKpiGrid'
import { ReturnsPagination, ReturnsTable } from '../returns/ReturnsTable'
import { ReturnsToolbar } from '../returns/ReturnsToolbar'
import { formatRange } from '../returns/periods'
import {
  CHANNEL_TERMS,
  labelFor,
  REASON_TERMS,
  RESOLUTION_TERMS,
  STATUS_TERMS,
} from '../returns/vocabulary'
import { PAGE_SIZES, useReturnFilters, useReturnsResource } from '../returns/useReturnsRegister'
import type { RegisterTab, ReturnRow, ReturnsSummary } from '../returns/types'
import type { ListResponse } from '../services/api'
import '../returns/returns.css'

/** The CSV a spreadsheet opens without asking questions. */
function toCsv(rows: ReturnRow[]): string {
  const headers = [
    'Return no.',
    'Date',
    'Bill no.',
    'Customer',
    'Channel',
    'Items',
    'Type',
    'Amount',
    'Reason',
    'Settled as',
    'Status',
    'Till',
    'Taken by',
  ]

  const cell = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value)

    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const lines = rows.map((row) =>
    [
      row.return_no,
      row.return_date,
      row.books_invoice_no ?? '',
      row.customer_name ?? 'Walk-in',
      row.order_kind ? labelFor(CHANNEL_TERMS, row.order_kind) : '',
      row.item_qty,
      RESOLUTION_TERMS[row.resolution]?.kind === 'exchange' ? 'Exchange' : 'Refund',
      row.refund_amount,
      row.reason_code ? labelFor(REASON_TERMS, row.reason_code) : '',
      RESOLUTION_TERMS[row.resolution]?.label ?? row.resolution,
      STATUS_TERMS[row.status]?.label ?? row.status,
      row.terminal_code ?? '',
      row.created_by,
    ]
      .map(cell)
      .join(','),
  )

  // The BOM is what makes Excel read the rupee sign and Indian names correctly.
  return `﻿${[headers.join(','), ...lines].join('\n')}`
}

function ReturnsEmptyState({
  filtered,
  onCreate,
  onPolicy,
  onClear,
  canCreate,
}: {
  filtered: boolean
  onCreate: () => void
  onPolicy: () => void
  onClear: () => void
  canCreate: boolean
}) {
  if (filtered) {
    return (
      <div className="returns-empty">
        <span className="returns-empty__icon" aria-hidden>
          <PackageOpen size={26} />
        </span>
        <h3>No returns match these filters</h3>
        <p>Nothing in this window matches what you have narrowed to. Widen the dates, or clear the filters.</p>
        <div className="returns-empty__actions">
          <button type="button" className="returns-button returns-button--secondary" onClick={onClear}>
            Clear filters
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="returns-empty">
      <span className="returns-empty__icon" aria-hidden>
        <PackageOpen size={26} />
      </span>
      <h3>No returns yet</h3>
      <p>
        Returns and exchanges taken on this POS will appear here. You can find the original bill and send selected items
        back without re-entering anything about the sale.
      </p>
      <div className="returns-empty__actions">
        {canCreate && (
          <button type="button" className="returns-button returns-button--primary" onClick={onCreate}>
            Take a return
          </button>
        )}
        <button type="button" className="returns-button returns-button--secondary" onClick={onPolicy}>
          View return policy
        </button>
      </div>
    </div>
  )
}

/**
 * The rules this till actually enforces.
 *
 * Read from POS settings and from what the API refuses, not from a policy
 * document somebody may or may not have written. A shop that wants different
 * rules changes them in Setup, and this panel changes with them.
 */
function ReturnPolicyPanel({
  open,
  onClose,
  requireReason,
  prefix,
  onSettings,
}: {
  open: boolean
  onClose: () => void
  requireReason: boolean
  prefix: string
  onSettings: (() => void) | null
}) {
  return (
    <Drawer
      open={open}
      eyebrow="Counter rules"
      title="Return policy"
      onClose={onClose}
      footer={
        onSettings ? (
          <button
            type="button"
            className="returns-button returns-button--secondary"
            onClick={() => {
              onClose()
              onSettings()
            }}
          >
            Change these in Setup
          </button>
        ) : undefined
      }
    >
      <p className="pos-muted">
        These are the rules the till enforces, read from this company's POS settings. They are not a description of a
        policy somebody wrote down — they are what the API will and will not accept.
      </p>

      <ul className="returns-policy">
        <li>
          <strong>Returns are taken against a completed sale.</strong> A sale that never went through is voided, not
          returned.
        </li>
        <li>
          <strong>Nothing comes back twice.</strong> The quantity still returnable is checked per item against every
          earlier return on that sale, and a request for more is refused.
        </li>
        <li>
          <strong>A reason {requireReason ? 'is required' : 'is optional'}.</strong>{' '}
          {requireReason
            ? 'This company requires a reason on every return.'
            : 'This company does not require one, though the new-return flow still asks — the reasons panel is only as good as what is recorded.'}
        </li>
        <li>
          <strong>Taking a return and approving one are different permissions.</strong> A return is money leaving the
          till against goods nobody has checked yet, so approval is somebody else's decision.
        </li>
        <li>
          <strong>Goods are booked back in before the credit is raised.</strong> Inventory receives them — damaged ones
          too, recorded as damaged — and then Smart Books raises the credit note.
        </li>
        <li>
          <strong>Cash refunds come off the open drawer.</strong> They are recorded as a drawer event on the shift that
          is open now, which is what makes the close-out balance.
        </li>
        <li>
          <strong>Return numbers are issued as {prefix || 'RET'}-0000.</strong> They are allocated by the server, in
          sequence, per company.
        </li>
      </ul>

      <p className="pos-note">
        POS has no payment gateway, so a card refund is what the cashier did on the external terminal, recorded with its
        reference. Nothing here reverses a card payment by itself.
      </p>
    </Drawer>
  )
}

export default function Returns() {
  const navigate = useNavigate()
  const location = useLocation()
  const { id } = useParams<{ id: string }>()
  const { can, session, terminalId } = usePos()

  const { filters, update, clearAll, activeCount, baseQuery, listQuery } = useReturnFilters()

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [newReturnOpen, setNewReturnOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger' | 'success'; text: string } | null>(null)
  const [offline, setOffline] = useState(() => !navigator.onLine)

  const searchRef = useRef<HTMLInputElement>(null)

  const openReturnId = id ? Number.parseInt(id, 10) : null
  const detailOpen = openReturnId !== null && Number.isFinite(openReturnId)
  const anyPanelOpen = detailOpen || newReturnOpen || filtersOpen || policyOpen

  const canCreate = can('return.create')

  // ----------------------------------------------------------------------
  // Data
  // ----------------------------------------------------------------------

  const listKey = JSON.stringify(listQuery)
  const summaryKey = JSON.stringify(baseQuery)

  const register = useReturnsResource<ListResponse<ReturnRow>>(listKey, (signal) =>
    returnsService.list(listQuery, signal),
  )
  const summary = useReturnsResource<ReturnsSummary>(summaryKey, (signal) =>
    returnsService.summary(baseQuery, signal).then((response) => response.data),
  )

  const rows = register.data?.data ?? []
  const total = register.data?.meta.total ?? 0

  const refreshAll = useCallback(() => {
    register.refresh()
    summary.refresh()
  }, [register, summary])

  // ----------------------------------------------------------------------
  // Connection
  // ----------------------------------------------------------------------

  useEffect(() => {
    const goOnline = () => setOffline(false)
    const goOffline = () => setOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // ----------------------------------------------------------------------
  // Navigation between the register and one return
  // ----------------------------------------------------------------------

  const onSearch = useCallback((search: string) => update({ search }), [update])
  const onRange = useCallback((range: { from: string; to: string }) => update(range), [update])
  const onTab = useCallback((tab: RegisterTab) => update({ tab }), [update])

  const openReturn = useCallback(
    (returnId: number) => navigate({ pathname: `/returns/${returnId}`, search: location.search }),
    [navigate, location.search],
  )

  const closeReturn = useCallback(
    () => navigate({ pathname: '/returns', search: location.search }),
    [navigate, location.search],
  )

  // ----------------------------------------------------------------------
  // Shortcuts
  //
  // Never while somebody is typing: F2 inside the search box has to stay F2 in
  // the search box, and Ctrl+K in a text field is a line-kill on some systems.
  // ----------------------------------------------------------------------

  useEffect(() => {
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F2' && !typing(event.target)) {
        // Not on top of something already open: a second drawer over the first
        // traps focus in the wrong one and Escape then closes the wrong thing.
        if (!canCreate || offline || anyPanelOpen) return
        event.preventDefault()
        setNewReturnOpen(true)

        return
      }

      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canCreate, offline, anyPanelOpen])

  // ----------------------------------------------------------------------
  // Export
  // ----------------------------------------------------------------------

  const exportCsv = useCallback(async () => {
    setExporting(true)
    setNotice(null)
    try {
      const result = await returnsService.exportRows(listQuery)
      if (result.rows.length === 0) {
        setNotice({ tone: 'info', text: 'There is nothing to export for this filter.' })

        return
      }

      const blob = new Blob([toCsv(result.rows)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `returns-${filters.from}-to-${filters.to}.csv`
      link.click()
      URL.revokeObjectURL(url)

      setNotice({
        tone: result.truncated ? 'info' : 'success',
        text: result.truncated
          ? `Exported the first ${count(result.rows.length)} of ${count(result.total)} rows. Narrow the window to export the rest.`
          : `Exported ${count(result.rows.length)} row${result.rows.length === 1 ? '' : 's'}.`,
      })
    } catch (failure) {
      setNotice({
        tone: 'danger',
        text: failure instanceof Error ? failure.message : 'The export did not finish.',
      })
    } finally {
      setExporting(false)
    }
  }, [listQuery, filters.from, filters.to])

  // ----------------------------------------------------------------------
  // Chips
  // ----------------------------------------------------------------------

  const chips = useMemo<Chip[]>(() => {
    const list: Chip[] = []

    if (filters.resolutions.length > 0) {
      list.push({
        key: 'resolutions',
        label: `Settled as: ${filters.resolutions.map((value) => RESOLUTION_TERMS[value].label).join(', ')}`,
        onRemove: () => update({ resolutions: [] }),
      })
    }
    if (filters.statuses.length > 0) {
      list.push({
        key: 'statuses',
        label: `Status: ${filters.statuses.map((value) => STATUS_TERMS[value].label).join(', ')}`,
        onRemove: () => update({ statuses: [] }),
      })
    }
    if (filters.channel) {
      list.push({
        key: 'channel',
        label: `Channel: ${labelFor(CHANNEL_TERMS, filters.channel)}`,
        onRemove: () => update({ channel: null }),
      })
    }
    if (filters.reason) {
      list.push({
        key: 'reason',
        label: `Reason: ${labelFor(REASON_TERMS, filters.reason)}`,
        onRemove: () => update({ reason: null }),
      })
    }
    if (filters.terminalId) {
      const terminal = session?.terminals.find((candidate) => candidate.terminal_id === filters.terminalId)
      list.push({
        key: 'terminal',
        label: `Till: ${terminal?.display_name ?? terminal?.terminal_code ?? filters.terminalId}`,
        onRemove: () => update({ terminalId: null }),
      })
    }
    if (filters.minAmount !== '' || filters.maxAmount !== '') {
      const from = filters.minAmount === '' ? null : money(Number.parseFloat(filters.minAmount))
      const to = filters.maxAmount === '' ? null : money(Number.parseFloat(filters.maxAmount))
      list.push({
        key: 'amount',
        label: `Amount: ${from ?? 'any'} – ${to ?? 'any'}`,
        onRemove: () => update({ minAmount: '', maxAmount: '' }),
      })
    }

    return list
  }, [filters, session, update])

  // ----------------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------------

  const settings = session?.settings
  const filtered = activeCount > 0 || filters.search.trim() !== '' || filters.tab !== 'all'

  return (
    <main className="pos-workspace returns-workspace">
      <ReturnsHero
        canCreate={canCreate}
        offline={offline}
        onNewReturn={() => setNewReturnOpen(true)}
        onExport={() => void exportCsv()}
        onPolicy={() => setPolicyOpen(true)}
        onSettings={can('settings.manage') ? () => navigate('/setup') : null}
        onAuditTrail={can('reports.view') ? () => navigate('/controls') : null}
      />

      {offline && (
        <Notice tone="warning" title="This till is offline">
          Returns are shown from the last successful load and cannot be taken while the connection is down — a refund
          reaches Smart Books and Inventory, so it is never queued locally.
        </Notice>
      )}

      {notice && (
        <Notice tone={notice.tone === 'success' ? 'success' : notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      {summary.error && (
        <Notice
          tone="danger"
          title="The figures above the register could not be loaded"
          action={
            <button type="button" className="returns-button returns-button--secondary" onClick={summary.refresh}>
              Try again
            </button>
          }
        >
          {summary.error} The register below is unaffected.
        </Notice>
      )}

      {/* On a summary failure the notice above is the whole story. Leaving the
          cards and charts up as skeletons would shimmer for ever and read as a
          page still loading. */}
      {!summary.error && (
        <>
          <ReturnsKpiGrid summary={summary.data} loading={summary.loading} />

          <ReturnsInsight summary={summary.data} />

          <ReturnsAnalytics
            summary={summary.data}
            loading={summary.loading}
            onPeriod={onRange}
            onReason={(reason) => update({ reason })}
            onChannel={(channel) => update({ channel })}
          />
        </>
      )}

      <section className="returns-register">
        <Panel title="Returns register" description={formatRange(filters.from, filters.to)} flush>
          <ReturnsToolbar
            filters={filters}
            counts={summary.data?.register_counts ?? null}
            activeFilterCount={activeCount}
            searchRef={searchRef}
            exporting={exporting}
            onTab={onTab}
            onSearch={onSearch}
            onRange={onRange}
            onOpenFilters={() => setFiltersOpen(true)}
            onExport={() => void exportCsv()}
            onPrint={() => window.print()}
          />

          {chips.length > 0 && (
            <div className="returns-register__chips">
              <ActiveFilterChips chips={chips} onClearAll={clearAll} />
            </div>
          )}

          {register.error ? (
            <div className="returns-error">
              <h3>The register could not be loaded</h3>
              <p className="pos-muted">{register.error}</p>
              <button type="button" className="returns-button returns-button--primary" onClick={register.refresh}>
                Try again
              </button>
            </div>
          ) : !register.loading && rows.length === 0 ? (
            <ReturnsEmptyState
              filtered={filtered}
              canCreate={canCreate && !offline}
              onCreate={() => setNewReturnOpen(true)}
              onPolicy={() => setPolicyOpen(true)}
              onClear={() => {
                clearAll()
                update({ tab: 'all', search: '' })
              }}
            />
          ) : (
            <>
              <ReturnsTable
                rows={rows}
                loading={register.loading}
                firstIndex={(filters.page - 1) * filters.pageSize + 1}
                sort={filters.sort}
                order={filters.order}
                onSort={(column) =>
                  update({
                    sort: column,
                    order: filters.sort === column && filters.order === 'desc' ? 'asc' : 'desc',
                  })
                }
                onOpen={(row) => openReturn(row.return_id)}
                rowActions={(row) => [
                  // The three workflow steps deliberately live in the panel, not
                  // here: approving a refund from a menu, without the lines and
                  // the original sale in front of you, is not a decision — it is
                  // a reflex.
                  { key: 'open', label: 'Open return', onSelect: () => openReturn(row.return_id) },
                  {
                    key: 'copy',
                    label: 'Copy return number',
                    onSelect: () => {
                      void navigator.clipboard?.writeText(row.return_no).then(
                        () => setNotice({ tone: 'success', text: `${row.return_no} copied.` }),
                        () => setNotice({ tone: 'danger', text: 'This browser would not let the page copy that.' }),
                      )
                    },
                  },
                  ...(row.books_invoice_no
                    ? [
                        {
                          key: 'copy-bill',
                          label: 'Copy bill number',
                          onSelect: () => {
                            void navigator.clipboard?.writeText(row.books_invoice_no ?? '')
                          },
                        },
                      ]
                    : []),
                ]}
              />

              <ReturnsPagination
                total={total}
                page={filters.page}
                pageSize={filters.pageSize}
                pageSizes={PAGE_SIZES}
                loading={register.loading}
                onPage={(page) => update({ page })}
                onPageSize={(pageSize) => update({ pageSize })}
              />
            </>
          )}
        </Panel>
      </section>

      <ReturnFiltersPanel
        open={filtersOpen}
        filters={filters}
        summary={summary.data}
        terminals={session?.terminals ?? []}
        onClose={() => setFiltersOpen(false)}
        onApply={(draft) => update(draft)}
        onClear={clearAll}
      />

      <ReturnPolicyPanel
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        requireReason={settings?.require_reason_on_return ?? true}
        prefix={settings?.return_prefix ?? 'RET'}
        onSettings={can('settings.manage') ? () => navigate('/setup') : null}
      />

      <NewReturnFlow
        open={newReturnOpen}
        terminalId={terminalId}
        canSell={can('sell')}
        onClose={() => setNewReturnOpen(false)}
        onCreated={refreshAll}
        onOpenReturn={openReturn}
      />

      <ReturnDetailsDrawer
        open={detailOpen}
        returnId={detailOpen ? openReturnId : null}
        can={can}
        onClose={closeReturn}
        onChanged={refreshAll}
      />
    </main>
  )
}
