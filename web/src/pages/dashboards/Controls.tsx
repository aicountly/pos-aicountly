/**
 * Cash, Shifts & Controls — the close-out command centre.
 *
 * ONE ENDPOINT, SIX QUESTIONS. Everything on this page comes from
 * `v1/dashboards/controls`, which is company-, outlet- and permission-scoped
 * server-side. The widgets are six readings of that one payload rather than six
 * fetches; POS keeps no copy of any of it and derives nothing the server did
 * not send.
 *
 * ACTIONS GO WHERE THEY ALREADY LIVE. Opening a till and closing a shift are
 * the till's and the shift report's jobs and are linked to, not reimplemented.
 * The cash sheets post to `v1/shifts/{id}/drawer` and `v1/shifts/{id}/close`,
 * the same endpoints a cashier's screen uses, so there is exactly one path to
 * the drawer in this product. Export, the drawer shell, the panel error and the
 * panel boundary are the shared ones the other boards use.
 *
 * THE PRIMARY BUTTON FOLLOWS THE TILL. Open a till when this browser's terminal
 * has no shift; close the shift when it has one. The mock this board was drawn
 * from shows a fixed "Open a till", but offering that to someone already
 * standing at an open drawer is how a second shift gets opened by accident.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Calculator,
  Download,
  FileBarChart,
  Printer,
  RefreshCw,
  ShieldCheck,
  Store,
} from 'lucide-react'
import { usePos } from '../../context/PosContext'
import { api } from '../../services/api'
import { count, dateTime, moneyExact, sinceLabel } from '../../dashboards/format'
import { useVisibleDashboards } from '../../dashboards/registry'
import { DashboardTabs, PanelBoundary } from '../../dashboards/shell'
import {
  ApprovalQueue,
  AuditTimeline,
  PostingExceptions,
  TenderReconciliation,
} from '../../dashboards/panels/controls'
import type { ControlsBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'
import { downloadControlsCsv } from '../../dashboards/exportSummary'
import {
  CashControlsFilters,
  activeQuickRange,
  applyQuickRange,
  periodLabel as describePeriod,
  useAdvancedFilters,
} from '../../dashboards/controls/CashControlsFilters'
import { CashControlsKPIs } from '../../dashboards/controls/CashControlsKPIs'
import { ShiftOverviewCard } from '../../dashboards/controls/ShiftOverviewCard'
import { PaymentModeSummaryCard } from '../../dashboards/controls/PaymentModeSummaryCard'
import { CashReconciliationCard } from '../../dashboards/controls/CashReconciliationCard'
import { RecentCashTransactionsCard } from '../../dashboards/controls/RecentCashTransactionsCard'
import { ControlsAlertsCard } from '../../dashboards/controls/ControlsAlertsCard'
import { CashQuickActionsCard, type QuickAction } from '../../dashboards/controls/CashQuickActionsCard'
import { CashActionSheet, type CashActionKind } from '../../dashboards/controls/CashActionSheet'
import { Toasts, type Toast } from '../../dashboards/controls/Toasts'
import { BoardError, ControlsSkeleton, WidgetEmptyState } from '../../dashboards/controls/primitives'
import {
  deriveAlerts,
  deriveKpis,
  derivePaymentMix,
  deriveReconciliation,
  deriveShifts,
  deriveTransactions,
  summariseExceptions,
} from '../../dashboards/controls/derive'
import '../../dashboards/controls/controls.css'

/**
 * "Live · updated 20s ago".
 *
 * Re-renders on a timer so the label ages rather than freezing at the moment of
 * the fetch. Fifteen seconds, not one: a counter ticking every second on a
 * screen someone stares at for eight hours is noise, and the point is only to
 * say whether the figures are minutes or hours old.
 */
function LiveStatus({ at, refreshing }: { at: Date | null; refreshing: boolean }) {
  const [, tick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15000)

    return () => window.clearInterval(id)
  }, [])

  if (refreshing) {
    return (
      <span className="cc-live cc-live--stale" role="status">
        <span className="cc-live__dot" aria-hidden /> Refreshing…
      </span>
    )
  }

  if (!at) {
    return (
      <span className="cc-live cc-live--offline" role="status">
        <span className="cc-live__dot" aria-hidden /> Not loaded yet
      </span>
    )
  }

  const stale = Date.now() - at.getTime() > 10 * 60 * 1000

  return (
    <span className={stale ? 'cc-live cc-live--stale' : 'cc-live'} role="status" title={at.toLocaleString()}>
      <span className="cc-live__dot" aria-hidden />
      {stale ? 'Stale' : 'Live'} · updated {sinceLabel(at.toISOString())}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export default function Controls() {
  const navigate = useNavigate()
  const { terminalId, can, session } = usePos()
  const { filters, update, query } = useDashboardFilters()
  const { advanced, setAdvanced, activeCount } = useAdvancedFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<ControlsBoard>('v1/dashboards/controls', query)

  const [busy, setBusy] = useState<string | null>(null)
  const [sheet, setSheet] = useState<CashActionKind | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(activeCount > 0)
  const [toasts, setToasts] = useState<Toast[]>([])

  const data = board.data

  const pushToast = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, tone, message }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 7000)
  }, [])

  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), [])

  /**
   * Retry a posting.
   *
   * The same idempotency key is reused server-side, so this cannot produce a
   * second invoice however many times it is pressed. The button is disabled
   * while in flight anyway, because a queue of identical requests is a queue of
   * identical answers and a confused user.
   */
  const retry = useCallback(
    async (kind: 'cart' | 'offline', id: number) => {
      const key = `${kind}:${id}`
      setBusy(key)
      try {
        await api.post(kind === 'cart' ? `v1/carts/${id}/retry` : `v1/offline/${id}/retry`)
        pushToast('success', 'Sent again. The board below is refreshed.')
        board.refresh()
      } catch (error) {
        pushToast('danger', error instanceof Error ? error.message : 'That could not be sent again.')
      } finally {
        setBusy(null)
      }
    },
    [board, pushToast],
  )

  // ---- derived view models ------------------------------------------------

  const kpis = useMemo(() => (data ? deriveKpis(data) : null), [data])
  const payment = useMemo(() => (data ? derivePaymentMix(data) : null), [data])
  const reconciliation = useMemo(() => (data ? deriveReconciliation(data) : null), [data])
  const transactions = useMemo(() => (data ? deriveTransactions(data) : []), [data])
  const alerts = useMemo(() => (data ? deriveAlerts(data) : []), [data])
  const exceptions = useMemo(() => (data ? summariseExceptions(data, alerts) : null), [data, alerts])
  const allShifts = useMemo(() => (data ? deriveShifts(data) : []), [data])

  const cashiers = useMemo(() => [...new Set(allShifts.map((shift) => shift.staff))], [allShifts])

  /** The client-side narrowing. Documented as such on the filter bar. */
  const shiftRows = useMemo(
    () =>
      allShifts.filter((shift) => {
        if (advanced.shiftStatus !== '' && shift.status !== advanced.shiftStatus) return false
        if (advanced.cashier !== '' && shift.staff !== advanced.cashier) return false
        if (advanced.variance === 'uncounted') return shift.counted === null
        if (advanced.variance === 'short') return shift.variance !== null && shift.variance < -0.005
        if (advanced.variance === 'over') return shift.variance !== null && shift.variance > 0.005
        if (advanced.variance === 'balanced') return shift.variance !== null && Math.abs(shift.variance) <= 0.005

        return true
      }),
    [allShifts, advanced],
  )

  const period = describePeriod(filters)
  const range = activeQuickRange(filters)

  // The shift on the till this browser is signed on to, which is the one whose
  // state decides what the primary button says.
  const myShift = data?.shifts.find((shift) => shift.terminal_id === terminalId && shift.status !== 'CLOSED')

  const openTill = can('shift.open')
  const canClose = can('shift.close')
  const canMoveCash = can('drawer.cash_io')
  const canReport = can('reports.view')

  // ---- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return

      // Alt only, and only keys the browser does not already own. Counting a
      // drawer and reconciling it are the same workflow here, so C and R open
      // the same sheet rather than one of them being a near-miss.
      const key = event.key.toLowerCase()
      if ((key === 'c' || key === 'r') && canClose) {
        event.preventDefault()
        setSheet('reconcile')
      } else if (key === 'o' && openTill) {
        event.preventDefault()
        navigate('/till')
      } else if (key === 's') {
        event.preventDefault()
        document.getElementById('cc-shifts')?.scrollIntoView({ block: 'start' })
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [canClose, openTill, navigate])

  // ---- actions -------------------------------------------------------------

  const quickActions = useMemo<QuickAction[]>(() => {
    const actions: QuickAction[] = []

    if (openTill) {
      actions.push({ id: 'open', label: 'Open a till', tone: 'green', icon: <Store size={19} />, to: '/till', shortcut: 'Alt + O' })
    }
    if (canClose) {
      actions.push({ id: 'close', label: 'Close shift', tone: 'blue', icon: <ShieldCheck size={19} />, to: '/reports' })
      actions.push({
        id: 'count',
        label: 'Cash count',
        tone: 'purple',
        icon: <Calculator size={19} />,
        onClick: () => setSheet('reconcile'),
        shortcut: 'Alt + C',
      })
    }
    if (canMoveCash) {
      actions.push({
        id: 'deposit',
        label: 'Cash deposit',
        tone: 'orange',
        icon: <ArrowDownToLine size={19} />,
        onClick: () => setSheet('safe_drop'),
      })
      actions.push({
        id: 'withdrawal',
        label: 'Cash withdrawal',
        tone: 'red',
        icon: <ArrowUpFromLine size={19} />,
        onClick: () => setSheet('cash_out'),
      })
    }
    if (canReport) {
      actions.push({ id: 'reports', label: 'View reports', tone: 'slate', icon: <FileBarChart size={19} />, to: '/reports' })
    }

    return actions
  }, [openTill, canClose, canMoveCash, canReport])

  const primaryAction = myShift
    ? { label: 'Close the shift', to: '/reports' }
    : openTill
      ? { label: 'Open a till', to: '/till' }
      : null

  // ---- render --------------------------------------------------------------

  return (
    <main className="pos-workspace pos-controls">
      <header className="cc-header">
        <div className="cc-heading">
          <p className="pos-eyebrow">AICOUNTLY POS</p>
          <h1>Cash, Shifts &amp; Controls</h1>
          <p className="cc-subtitle">
            Monitor cash, manage shifts, track controls and keep your outlet running smoothly.
          </p>
          <p className="cc-tagline">Close confidently. Every exception has a person and a reason.</p>
        </div>

        <div className="cc-actions">
          <LiveStatus at={board.fetchedAt} refreshing={board.refreshing} />
          <button
            type="button"
            className="pos-button pos-button--secondary pos-button--small"
            onClick={board.refresh}
            disabled={board.refreshing}
          >
            <RefreshCw size={14} aria-hidden /> {board.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="pos-button pos-button--secondary pos-button--small"
            onClick={() => window.print()}
            disabled={data === null}
          >
            <Printer size={14} aria-hidden /> Print
          </button>
          <button
            type="button"
            className="pos-button pos-button--secondary pos-button--small"
            onClick={() => data && downloadControlsCsv(data, filters)}
            disabled={data === null}
            title="Downloads the period on screen as a CSV"
          >
            <Download size={14} aria-hidden /> Export
          </button>
          {primaryAction && (
            <Link className="pos-button pos-button--primary pos-button--small" to={primaryAction.to}>
              {primaryAction.label}
            </Link>
          )}
        </div>
      </header>

      <DashboardTabs tabs={tabs} active="controls" />

      {/* Only on paper: which company, outlet and period this printout is of. */}
      <p className="cc-print-context">
        {session?.user.display_name ? `Printed by ${session.user.display_name} · ` : ''}
        {period}
        {data ? ` · ${data.window.from} to ${data.window.to} · generated ${dateTime(data.window.generated_at)}` : ''}
      </p>

      {board.loading ? (
        <ControlsSkeleton />
      ) : board.error ? (
        <BoardError message={board.error} onRetry={board.refresh} />
      ) : data && kpis && payment && reconciliation && exceptions ? (
        <>
          <CashControlsKPIs kpis={kpis} periodLabel={period} />

          <CashControlsFilters
            filters={filters}
            update={update}
            advanced={advanced}
            setAdvanced={setAdvanced}
            advancedCount={activeCount}
            cashiers={cashiers}
            open={filtersOpen}
            onToggle={() => setFiltersOpen((open) => !open)}
          />

          {/* The exception line. Only counts that came off the rules above. */}
          <div
            className={
              exceptions.clear
                ? 'cc-ribbon cc-ribbon--clear'
                : exceptions.critical > 0
                  ? 'cc-ribbon cc-ribbon--critical'
                  : 'cc-ribbon'
            }
            role="status"
          >
            {exceptions.clear ? (
              <span>
                <strong>All clear.</strong> No control exception was detected for {period.toLowerCase()}.
              </span>
            ) : (
              <>
                {exceptions.critical > 0 && (
                  <span>
                    <strong>{count(exceptions.critical)} critical</strong>
                  </span>
                )}
                {exceptions.warning > 0 && (
                  <>
                    <span className="cc-ribbon__sep" aria-hidden>
                      ·
                    </span>
                    <span>{count(exceptions.warning)} to review</span>
                  </>
                )}
                {exceptions.needsReconciliation > 0 && (
                  <>
                    <span className="cc-ribbon__sep" aria-hidden>
                      ·
                    </span>
                    <span>
                      {count(exceptions.needsReconciliation)}{' '}
                      {exceptions.needsReconciliation === 1 ? 'drawer needs' : 'drawers need'} reconciliation
                    </span>
                  </>
                )}
                {exceptions.openShifts > 0 && (
                  <>
                    <span className="cc-ribbon__sep" aria-hidden>
                      ·
                    </span>
                    <span>
                      {count(exceptions.openShifts)} {exceptions.openShifts === 1 ? 'shift' : 'shifts'} still open
                    </span>
                  </>
                )}
                {reconciliation.variance !== null && Math.abs(reconciliation.variance) > 0.005 && (
                  <>
                    <span className="cc-ribbon__sep" aria-hidden>
                      ·
                    </span>
                    <span>
                      Cash variance{' '}
                      <strong className={reconciliation.variance < 0 ? 'cc-amount-short' : 'cc-amount-over'}>
                        {moneyExact(reconciliation.variance)}
                      </strong>
                    </span>
                  </>
                )}
              </>
            )}
          </div>

          <div className="cc-grid-primary" id="cc-shifts">
            <PanelBoundary title="Shift overview">
              <ShiftOverviewCard
                shifts={shiftRows}
                totalShifts={allShifts.length}
                focusedSession={filters.sessionId}
                onFocus={(sessionId) => update({ sessionId })}
                narrowed={activeCount > 0 && shiftRows.length < allShifts.length}
                canOpenTill={openTill}
              />
            </PanelBoundary>

            <PanelBoundary title="Payment mode summary">
              <PaymentModeSummaryCard
                slices={payment.slices}
                total={payment.total}
                period={range}
                periodLabel={period}
                onPeriodChange={(id) => update(applyQuickRange(id))}
              />
            </PanelBoundary>

            <PanelBoundary title="Cash reconciliation">
              <CashReconciliationCard
                view={reconciliation}
                canReconcile={canClose}
                onReconcile={() => setSheet('reconcile')}
              />
            </PanelBoundary>
          </div>

          <div className="cc-grid-secondary">
            <PanelBoundary title="Recent cash transactions">
              <RecentCashTransactionsCard rows={transactions} />
            </PanelBoundary>

            <PanelBoundary title="Controls and alerts">
              <ControlsAlertsCard alerts={alerts} onFocusSession={(sessionId) => update({ sessionId })} />
            </PanelBoundary>

            {quickActions.length > 0 ? (
              <CashQuickActionsCard actions={quickActions} />
            ) : (
              <div className="cc-card cc-quick-card">
                <div className="cc-card__header">
                  <div className="cc-card__title">
                    <h2>Quick actions</h2>
                  </div>
                </div>
                <WidgetEmptyState title="Nothing you can act on here">
                  Your role can see this board but cannot open a till, close a shift or move cash. Ask a manager.
                </WidgetEmptyState>
              </div>
            )}
          </div>

          <div className="cc-section-head">
            <div>
              <h2>Reconciliation detail</h2>
              <p>Tenders, approvals, postings and the audit trail behind the figures above.</p>
            </div>
          </div>

          <div className="cc-grid-detail">
            <div id="cc-tenders">
              <TenderReconciliation board={data} />
            </div>
            <div id="cc-approvals">
              <ApprovalQueue board={data} />
            </div>
          </div>

          <div className="cc-grid-detail">
            <div id="cc-posting">
              <PostingExceptions board={data} onRetry={retry} busy={busy} />
            </div>
            <div id="cc-audit">
              <AuditTimeline board={data} />
            </div>
          </div>

          <p className="pos-note">{data.window.scope_note}</p>
        </>
      ) : null}

      {sheet && data && (
        <CashActionSheet
          kind={sheet}
          shifts={data.shifts}
          defaultSessionId={myShift?.session_id ?? filters.sessionId}
          canOpenTill={openTill}
          onClose={() => setSheet(null)}
          onDone={(message) => {
            pushToast('success', message)
            board.refresh()
          }}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </main>
  )
}
