/**
 * Shift report — one shift, and everything a manager has to decide about it.
 *
 * WHAT THIS SCREEN IS FOR. A manager should understand a whole shift in about
 * ten seconds: what it sold, how it was paid, who worked it, what needed
 * allowing, and whether the drawer agrees. Everything below is arranged in that
 * order, and the one irreversible action on it — closing the till — sits behind
 * a three-step dialog rather than a button that fires.
 *
 * WHAT IT IS NOT. It is not an accounting report. Every figure is counted from
 * POS' own rows; Books owns the ledger and its number for the same day can
 * legitimately differ. The footer says so, and that line is not decoration.
 *
 * ONE REQUEST PAINTS THE PAGE. The board is a single round trip, because six
 * endpoints answering six questions about the same shift is six chances to
 * render half a shift on shop broadband. Only the two lists that grow without
 * limit — the audit trail and the rows behind a risk tile — are paged, and the
 * risk rows are not fetched at all until somebody opens one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, RefreshCw } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { getScope } from '../services/api'
import { fetchCompanyInfo } from '../services/manage'
import { Notice } from '../ui'
import { ShiftReportHeader, type ShareAction } from '../shift/panels/header'
import { ShiftKpiGrid } from '../shift/panels/kpis'
import { ShiftSummaryCard } from '../shift/panels/summary'
import { HourlySalesCard, OrdersByChannelCard, PaymentMixCard } from '../shift/panels/analytics'
import { RiskMonitor } from '../shift/panels/risk'
import { CashReconciliationCard } from '../shift/panels/cash'
import { ShiftAuditTrail } from '../shift/panels/audit'
import { ReconcileShiftDialog } from '../shift/panels/reconcile'
import { ReportEmptyState, ReportErrorState, ReportSkeleton, Toast } from '../shift/panels/states'
import { businessDateLabel, clockLabel, durationLabel, moneyExact, stampLabel } from '../shift/format'
import { useShiftEvents, useShiftFilters, useShiftReport } from '../shift/useShiftReport'
import '../shift/styles.css'

/**
 * Put something on the clipboard, wherever the browser allows it.
 *
 * The async Clipboard API needs a secure context and a permission that a till
 * kiosk may not have, so the old selection trick stands behind it. A manager
 * who cannot copy a link is told, rather than left pressing a button that does
 * nothing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)

      return true
    }
  } catch {
    // Fall through to the selection route.
  }

  try {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(field)

    return copied
  } catch {
    return false
  }
}

export default function Reports() {
  const { can, session } = usePos()
  const navigate = useNavigate()
  const filters = useShiftFilters()
  const board = useShiftReport({ locationId: filters.locationId, date: filters.date, sessionId: filters.sessionId })

  const [reconciling, setReconciling] = useState(false)
  const [toast, setToast] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const [fyLabel, setFyLabel] = useState<string | null>(null)

  const data = board.data
  const shift = data?.shift ?? null
  const timezone = data?.context.timezone ?? 'UTC'

  const events = useShiftEvents(shift?.session_id ?? null, {
    items: data?.events.items ?? [],
    total: data?.events.total ?? 0,
    kinds: data?.events.kinds ?? [],
  })

  /**
   * The company's name, for the printed report only.
   *
   * Manage owns it and POS keeps nothing but the id, so it is read live — once,
   * and only because a PDF with no company on it is not a report. Everything on
   * screen works without it.
   */
  const scope = getScope()
  useEffect(() => {
    if (!scope) return
    let cancelled = false
    const controller = new AbortController()

    fetchCompanyInfo(scope.cmp_id, controller.signal)
      .then((info) => {
        if (cancelled) return
        setCompanyName(info.name)
        setFyLabel(info.fyList.find((fy) => fy.fyId === scope.fy_id)?.label ?? null)
      })
      .catch(() => {
        // The screen is complete without it; the printed header says "—".
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [scope?.cmp_id, scope?.fy_id])

  /** The link to THIS shift, with every filter in it. */
  const permalink = useMemo(() => {
    const url = new URL(window.location.href)
    url.search = ''
    if (filters.locationId ?? shift?.outlet.location_id) {
      url.searchParams.set('location_id', String(filters.locationId ?? shift?.outlet.location_id))
    }
    url.searchParams.set('date', shift?.date ?? filters.date)
    if (shift) url.searchParams.set('session_id', String(shift.session_id))

    return url.toString()
  }, [filters.locationId, filters.date, shift])

  const share = useCallback(
    async (action: ShareAction) => {
      if (action === 'print') {
        window.print()

        return
      }

      if (action === 'email') {
        const subject = `Shift report — ${shift?.terminal.code ?? ''} ${businessDateLabel(shift?.date ?? filters.date)}`
        const body = [
          `Shift report for ${shift?.terminal.code ?? 'this till'} on ${businessDateLabel(shift?.date ?? filters.date)}.`,
          '',
          permalink,
          '',
          'Opening the link needs an Aicountly sign-in and permission to see shift reports.',
        ].join('\n')
        window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

        return
      }

      const copied = await copyText(permalink)
      setToast(
        copied
          ? { tone: 'success', message: 'Link copied. Whoever opens it still signs in and still needs permission.' }
          : { tone: 'danger', message: `This browser would not let us copy. The link is ${permalink}` },
      )
    },
    [filters.date, permalink, shift],
  )

  const onReconciled = useCallback(
    (message: string) => {
      setReconciling(false)
      setToast({ tone: 'success', message })
      board.refresh()
    },
    [board],
  )

  // Every endpoint asserts its own permission, so this only decides whether to
  // draw the screen. A URL typed by someone who may not see it answers 403.
  if (!can('reports.view') && !can('shift.close') && !can('shift.open')) {
    return (
      <Notice tone="warning" title="You cannot see shift reports">
        Ask a manager for the reports permission on this company.
      </Notice>
    )
  }

  if (board.loading && !data) {
    return (
      <main className="pos-workspace">
        <ReportSkeleton />
      </main>
    )
  }

  if (board.error && !data) {
    return (
      <main className="pos-workspace">
        <div className="shift-report">
          <ReportErrorState message={board.error} onRetry={board.refresh} />
        </div>
      </main>
    )
  }

  if (!data) return null

  const { context, metrics, comparison, cash, payment_mix, hourly_sales, channels, risk, denominations, policy } = data

  return (
    <main className="pos-workspace">
      <div className="shift-report">
        <ShiftReportHeader
          context={context}
          shift={shift}
          policy={policy}
          date={filters.date}
          locationId={filters.locationId ?? shift?.outlet.location_id ?? null}
          sessionId={filters.sessionId ?? shift?.session_id ?? null}
          busy={board.refreshing}
          onFilter={filters.update}
          onExport={() => window.print()}
          onShare={(action) => void share(action)}
          onReconcile={() => setReconciling(true)}
        />

        {/* Only on paper. A printed cash record has to say whose shop, whose
            till and whose shift it is, or it proves nothing. */}
        <section className="shift-report__print" aria-hidden>
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Shift report</h2>
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.7 }}>
            <strong>{companyName ?? '—'}</strong>
            {fyLabel ? ` · ${fyLabel}` : ''}
            <br />
            Outlet: {shift?.outlet.name ?? '—'} · Till: {shift ? `${shift.terminal.code} • ${shift.terminal.name}` : '—'}
            <br />
            Business date: {businessDateLabel(shift?.date ?? filters.date)} · Shift:{' '}
            {shift ? `${clockLabel(shift.started_at, timezone)} – ${shift.ended_at ? clockLabel(shift.ended_at, timezone) : 'open'} (${durationLabel(shift.duration_minutes)})` : '—'}
            <br />
            Cashier: {shift?.cashier.label ?? '—'} · Status: {shift?.state_label ?? '—'}
            {cash?.variance !== null && cash !== null ? ` · Variance: ${moneyExact(cash.variance)}` : ''}
            <br />
            Generated: {stampLabel(new Date(), timezone)} · {data.source_note}
          </p>
        </section>

        {board.error && (
          <Notice tone="warning" title="These figures are not the latest">
            Showing {stampLabel(board.fetchedAt, timezone)}. The last refresh failed: {board.error}
          </Notice>
        )}

        {shift === null || cash === null ? (
          <ReportEmptyState title="No shift has been opened here yet">
            Nothing was recorded for {businessDateLabel(filters.date)}
            {context.outlets.length > 0 && filters.locationId
              ? ` at ${context.outlets.find((o) => o.location_id === filters.locationId)?.display_name ?? 'this outlet'}`
              : ''}
            . Choose another date or outlet, or open a till to start a shift. {context.scope_note}
          </ReportEmptyState>
        ) : (
          <>
            <ShiftKpiGrid metrics={metrics} comparison={comparison} hourly={hourly_sales} />

            <ShiftSummaryCard shift={shift} cash={cash} timezone={timezone} />

            {metrics.bills === 0 && (
              <ReportEmptyState title="No transactions have been recorded for this shift yet">
                The till is {shift.state === 'open' ? 'open and waiting' : 'closed without a sale on it'}. The shift
                details, the opening cash and the drawer are all below and are all real — there is simply nothing sold
                to chart.
              </ReportEmptyState>
            )}

            <div className="shift-analytics">
              <PaymentMixCard tenders={payment_mix} total={metrics.net_sales} />
              <HourlySalesCard hourly={hourly_sales} />
              <OrdersByChannelCard channels={channels} />
            </div>

            <RiskMonitor
              risk={risk}
              sessionId={shift.session_id}
              onViewAll={() =>
                navigate(`/controls?session_id=${shift.session_id}&from=${shift.date}&to=${shift.date}`)
              }
            />

            <div className="shift-bottom">
              {denominations && <CashReconciliationCard denominations={denominations} timezone={timezone} />}
              <ShiftAuditTrail events={events} timezone={timezone} />
            </div>
          </>
        )}

        <footer className="shift-report__footer">
          <span>
            <Info size={13} aria-hidden />
            {data.source_note}
          </span>
          <span>
            <button
              type="button"
              className="shift-button shift-button--quiet"
              onClick={board.refresh}
              disabled={board.refreshing}
              aria-label="Refresh the shift report"
            >
              <RefreshCw size={13} aria-hidden />
              {board.refreshing ? 'Refreshing…' : `Last updated: ${stampLabel(board.fetchedAt, timezone)}`}
            </button>
          </span>
        </footer>
        {/* Both of these are position: fixed, so they sit here for the STYLES
            rather than the layout — the stylesheet is scoped to .shift-report,
            and an overlay rendered outside it loses every control style it
            shares with the page behind it. */}
        {reconciling && shift && cash && (
          <ReconcileShiftDialog
            shift={shift}
            cash={cash}
            policy={policy}
            onClose={() => setReconciling(false)}
            onDone={onReconciled}
          />
        )}

        {toast && (
          <Toast tone={toast.tone} onDismiss={() => setToast(null)}>
            {toast.message}
          </Toast>
        )}

        {session === null && <span className="pos-visually-hidden">Opening this company…</span>}
      </div>
    </main>
  )
}
