import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CloudOff, Lock } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { api } from '../services/api'
import type { Dashboard, RegisterSession, ShiftReport } from '../services/types'
import { Button, Card, DataTable, Field, Input, Notice, StatCard, StatusBadge, money } from '../ui'

/**
 * What these tills did today, and what is still stuck.
 *
 * The numbers come from POS' own rows, and the screen says so at the bottom.
 * A dashboard that showed a different figure from Books under the same word is
 * a dashboard people stop trusting.
 */
export default function Reports() {
  const { terminalId } = usePos()
  const [board, setBoard] = useState<Dashboard | null>(null)
  const [shift, setShift] = useState<RegisterSession | null>(null)
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [counted, setCounted] = useState('')

  const load = useCallback(async () => {
    try {
      const response = await api.one<Dashboard>('v1/dashboard')
      setBoard(response.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the day.')
    }

    if (!terminalId) return
    try {
      const current = await api.one<{ session: RegisterSession | null }>('v1/shifts/current', { terminal_id: terminalId })
      setShift(current.data.session)
      if (current.data.session) {
        const r = await api.one<ShiftReport>(`v1/shifts/${current.data.session.session_id}/report`)
        setReport(r.data)
      }
    } catch {
      // The day still renders without the shift panel.
    }
  }, [terminalId])

  useEffect(() => {
    void load()
  }, [load])

  const closeShift = async () => {
    if (!shift) return
    const amount = Number(counted)
    if (!Number.isFinite(amount)) {
      setError('Count the drawer first.')
      return
    }

    const variance = amount - (report?.expected_cash ?? shift.expected_cash)
    let reason: string | null = ''
    if (Math.abs(variance) > 0.001) {
      reason = window.prompt(
        `The drawer is ${variance > 0 ? 'over' : 'short'} by ${Math.abs(variance).toFixed(2)}. What happened?`,
      )
      if (reason === null || reason.trim() === '') return
    }

    setBusy(true)
    try {
      await api.post(`v1/shifts/${shift.session_id}/close`, {
        counted_cash: amount,
        variance_reason: reason ? reason.trim() : undefined,
      })
      setCounted('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close the shift.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}

      {board && (board.needs_attention.stuck_commands > 0 || board.needs_attention.pending_offline > 0) && (
        <Notice tone="warning" title="Needs someone to look at it">
          {board.needs_attention.stuck_commands > 0 && (
            <div>
              <AlertTriangle size={13} aria-hidden style={{ verticalAlign: '-2px', marginRight: '0.3rem' }} />
              {board.needs_attention.stuck_commands} sale{board.needs_attention.stuck_commands === 1 ? '' : 's'} have
              not reached Books or Inventory.
            </div>
          )}
          {board.needs_attention.pending_offline > 0 && (
            <div>
              <CloudOff size={13} aria-hidden style={{ verticalAlign: '-2px', marginRight: '0.3rem' }} />
              {board.needs_attention.pending_offline} offline sale
              {board.needs_attention.pending_offline === 1 ? '' : 's'} still waiting — see the offline queue.
            </div>
          )}
        </Notice>
      )}

      {board && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.75rem' }}>
          <StatCard label="Bills" value={String(board.sales.bills)} />
          <StatCard label="Taken" value={money(board.sales.net)} />
          <StatCard label="Average bill" value={money(board.sales.average_bill)} />
          <StatCard label="Discount given" value={money(board.sales.discount)} />
          <StatCard label="Refunds" value={money(board.exceptions.refunds)} />
          <StatCard label="Voids" value={String(board.exceptions.voids)} tone={board.exceptions.voids > 0 ? 'warning' : undefined} />
        </div>
      )}

      {shift && report && (
        <Card title="This shift" subtitle="Close it out when the till stops">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.75rem', marginBottom: '0.9rem' }}>
            <StatCard label="Opened with" value={money(shift.opening_float)} />
            <StatCard label="Should hold" value={money(report.expected_cash)} />
            <StatCard label="Bills this shift" value={String(report.sales.bills)} />
            <StatCard label="Taken this shift" value={money(report.sales.net)} />
          </div>

          <DataTable
            rows={report.tenders}
            rowKey={(row) => row.payment_mode}
            columns={[
              { key: 'tender', header: 'Tender', render: (row) => row.payment_mode.replace(/_/g, ' ') },
              { key: 'count', header: 'Count', numeric: true, render: (row) => String(row.count) },
              { key: 'amount', header: 'Amount', numeric: true, render: (row) => money(row.amount) },
            ]}
            empty="Nothing taken yet."
          />

          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', marginTop: '0.9rem' }}>
            <Field label="Counted in the drawer" hint="Count it before you type it. The difference is recorded either way.">
              <Input type="number" min={0} step="any" value={counted} onChange={(e) => setCounted(e.target.value)} />
            </Field>
            <Button onClick={() => void closeShift()} disabled={busy || counted === ''}>
              <Lock size={14} aria-hidden /> Close the shift
            </Button>
          </div>
        </Card>
      )}

      {board && board.top_items.length > 0 && (
        <Card title="What sold">
          <DataTable
            rows={board.top_items}
            rowKey={(row) => row.display_name}
            columns={[
              { key: 'item', header: 'Item', render: (row) => row.display_name },
              { key: 'qty', header: 'Qty', numeric: true, render: (row) => String(row.qty) },
              { key: 'amount', header: 'Amount', numeric: true, render: (row) => money(row.amount) },
            ]}
          />
        </Card>
      )}

      {board && (
        <Card title="What needed approving" subtitle="Voids, no-sales and overrides — the fraud trail">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '0.75rem' }}>
            <StatCard label="Voids" value={String(board.exceptions.voids)} />
            <StatCard label="No-sale drawer opens" value={String(board.exceptions.no_sales)} />
            <StatCard label="Price/discount overrides" value={String(board.exceptions.overrides)} />
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem', margin: '0.9rem 0 0' }}>{board.source_note}</p>
        </Card>
      )}

      {shift === null && terminalId !== null && (
        <Notice tone="info">
          No shift is open on this till. <StatusBadge status="CLOSED" />
        </Notice>
      )}
    </div>
  )
}
