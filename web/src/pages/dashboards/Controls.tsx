/**
 * Cash, Shifts & Controls — close the day, and resolve what is stuck.
 *
 * The primary action changes with the state of the till the user is standing
 * at: Open a till when there is no shift, Close the shift when there is one.
 * Both go to the screen that owns the action rather than doing it from here —
 * closing a drawer means counting it, and counting it is a form on the till.
 */

import { useCallback, useState } from 'react'
import { usePos } from '../../context/PosContext'
import { api } from '../../services/api'
import { count, money, moneyExact } from '../../dashboards/format'
import { DashboardFilterBar, useVisibleDashboards } from '../../dashboards/registry'
import { DashboardBody, PosDashboardShell } from '../../dashboards/shell'
import { Freshness } from '../../dashboards/panels/common'
import {
  ApprovalQueue,
  AuditTimeline,
  CashMovements,
  CashSummary,
  PostingExceptions,
  ShiftRegister,
  TenderReconciliation,
} from '../../dashboards/panels/controls'
import type { ControlsBoard } from '../../dashboards/types'
import { useBoard, useDashboardFilters } from '../../dashboards/useDashboard'

export default function Controls() {
  const { terminalId, can } = usePos()
  const { filters, update, query } = useDashboardFilters()
  const tabs = useVisibleDashboards(filters.locationId)
  const board = useBoard<ControlsBoard>('v1/dashboards/controls', query)

  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const data = board.data
  const cash = data?.cash

  // The shift on the till this browser is signed on to, which is the one whose
  // state decides what the primary button says.
  const myShift = data?.shifts.find(
    (shift) => shift.terminal_id === terminalId && shift.status !== 'CLOSED',
  )

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
      setNotice(null)
      try {
        await api.post(kind === 'cart' ? `v1/carts/${id}/retry` : `v1/offline/${id}/retry`)
        setNotice('Sent again. The board below is refreshed.')
        board.refresh()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'That could not be sent again.')
      } finally {
        setBusy(null)
      }
    },
    [board],
  )

  const primaryAction = myShift
    ? { label: 'Close the shift', to: '/reports' }
    : can('shift.open')
      ? { label: 'Open a till', to: '/' }
      : null

  return (
    <PosDashboardShell
      title="Cash, Shifts & Controls"
      description="Close confidently. Every exception has a person and a reason."
      activeDashboard="controls"
      visibleTabs={tabs}
      filterControls={<DashboardFilterBar filters={filters} update={update} showComparison={false} />}
      freshnessLabel={<Freshness at={board.fetchedAt} refreshing={board.refreshing} />}
      primaryAction={primaryAction}
      onRefresh={board.refresh}
      refreshing={board.refreshing}
      metrics={
        cash
          ? [
              {
                id: 'float',
                label: 'Opening float',
                value: money(cash.opening_float),
                context: `${count(cash.shifts)} shift${cash.shifts === 1 ? '' : 's'} in this period`,
              },
              {
                id: 'sales',
                label: 'Cash from sales',
                value: money(cash.cash_sales),
                context: 'Net of change given. Card and UPI excluded.',
              },
              {
                id: 'expected',
                label: 'Expected in the drawer',
                value: moneyExact(cash.expected_cash),
                context: 'Float + cash sales + pay-ins − refunds − payouts − drops',
              },
              {
                id: 'counted',
                label: 'Counted',
                value: cash.counted_cash === null ? null : moneyExact(cash.counted_cash),
                context:
                  cash.counted_cash === null
                    ? `${count(cash.open_shifts)} shift${cash.open_shifts === 1 ? '' : 's'} still open`
                    : `${count(cash.counted_shifts)} of ${count(cash.shifts)} shifts counted`,
              },
              {
                id: 'variance',
                label: 'Variance',
                value: cash.variance === null ? null : moneyExact(cash.variance),
                context:
                  cash.variance === null
                    ? 'Nothing counted yet'
                    : cash.variance < 0
                      ? 'The drawer is short'
                      : cash.variance > 0
                        ? 'The drawer is over'
                        : 'The drawer balances',
              },
              {
                id: 'exceptions',
                label: 'Waiting on someone',
                value: count(
                  data.posting.commands.length +
                    data.posting.offline.length +
                    data.approvals.pending_variances.length,
                ),
                context: 'Postings and unsigned drawers',
              },
            ]
          : []
      }
    >
      <DashboardBody
        loading={board.loading}
        error={board.error}
        empty={data !== null && data.shifts.length === 0 && data.posting.commands.length === 0}
        emptyTitle="No shifts in this period"
        onRetry={board.refresh}
      >
        {data && (
          <>
            {notice && (
              <div className="pos-unavailable" role="status">
                {notice}
              </div>
            )}

            <div className="pos-grid-main">
              <ShiftRegister board={data} onShift={(sessionId) => update({ sessionId })} />
              <CashSummary board={data} />
            </div>

            <div className="pos-grid-main">
              <TenderReconciliation board={data} />
              <ApprovalQueue board={data} />
            </div>

            <div className="pos-grid-main">
              <PostingExceptions board={data} onRetry={retry} busy={busy} />
              <CashMovements board={data} />
            </div>

            <AuditTimeline board={data} />

            <p className="pos-note">{data.window.scope_note}</p>
          </>
        )}
      </DashboardBody>
    </PosDashboardShell>
  )
}
