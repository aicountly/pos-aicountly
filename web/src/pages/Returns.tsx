import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PackageCheck, Receipt, ThumbsUp } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { api } from '../services/api'
import type { PosReturn } from '../services/types'
import { Button, Card, DataTable, Notice, StatusBadge, date, money } from '../ui'
import { CommandStrip } from '../components/CommandStrip'

export function ReturnsList() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<PosReturn[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const response = await api.list<PosReturn>('v1/returns', { limit: 50 })
        setRows(response.data)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load returns.')
      }
    })()
  }, [])

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger">{error}</Notice>}
      <Card title="Counter returns" subtitle="Goods brought back, and what the customer got">
        <DataTable
          rows={rows}
          rowKey={(row) => row.return_id}
          onRowClick={(row) => navigate(`/returns/${row.return_id}`)}
          columns={[
            { key: 'number', header: 'Number', render: (row) => row.return_no },
            { key: 'date', header: 'Date', render: (row) => date(row.return_date) },
            { key: 'against', header: 'Against', render: (row) => row.books_invoice_no ?? '—' },
            { key: 'refund', header: 'Refund', numeric: true, render: (row) => money(row.refund_amount) },
            { key: 'how', header: 'How', render: (row) => row.resolution.replace(/_/g, ' ') },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
          ]}
          empty="No returns yet."
        />
      </Card>
    </div>
  )
}

/**
 * One return, and the three steps it goes through.
 *
 * Deliberately shown as three separate actions rather than one button: the
 * goods coming back, the stock going in and the credit being raised are three
 * different products' decisions, and a single button that silently did all
 * three would hide which one failed.
 */
export function ReturnDetail() {
  const { id } = useParams<{ id: string }>()
  const { can } = usePos()
  const [ret, setRet] = useState<PosReturn | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    try {
      const response = await api.one<PosReturn>(`v1/returns/${id}`)
      setRet(response.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that return.')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'approve' | 'receive' | 'settle') => {
    if (!ret) return
    setBusy(true)
    try {
      await api.post(`v1/returns/${ret.return_id}/${action}`, {})
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That step did not go through.')
    } finally {
      setBusy(false)
    }
  }

  if (!ret) return <p style={{ color: 'var(--muted)' }}>{error ?? 'Loading…'}</p>

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}

      <Card
        title={ret.return_no}
        subtitle={`${date(ret.return_date)} · ${ret.resolution.replace(/_/g, ' ')}`}
        action={
          <span style={{ display: 'flex', gap: '0.4rem' }}>
            {ret.status === 'DRAFT' && can('return.approve') && (
              <Button onClick={() => void act('approve')} disabled={busy}>
                <ThumbsUp size={14} aria-hidden /> Approve
              </Button>
            )}
            {ret.status === 'APPROVED' && can('return.approve') && (
              <Button onClick={() => void act('receive')} disabled={busy}>
                <PackageCheck size={14} aria-hidden /> Take the goods back
              </Button>
            )}
            {(ret.status === 'RECEIVED' || ret.status === 'APPROVED') && can('refund.give') && (
              <Button onClick={() => void act('settle')} disabled={busy}>
                <Receipt size={14} aria-hidden /> Raise the credit note
              </Button>
            )}
          </span>
        }
      >
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1.5rem', margin: 0 }}>
          <dt style={{ color: 'var(--muted)' }}>Status</dt>
          <dd style={{ margin: 0 }}><StatusBadge status={ret.status} /></dd>
          <dt style={{ color: 'var(--muted)' }}>Refund</dt>
          <dd className="num" style={{ margin: 0 }}>{money(ret.refund_amount)}</dd>
          <dt style={{ color: 'var(--muted)' }}>Original invoice</dt>
          <dd style={{ margin: 0 }}>{ret.books_invoice_no ?? '—'}</dd>
          <dt style={{ color: 'var(--muted)' }} title="Inventory holds the stock movement; this is its reference.">
            Stock document
          </dt>
          <dd style={{ margin: 0 }} className="num">{ret.inventory_document_uuid ?? 'Not yet'}</dd>
          <dt style={{ color: 'var(--muted)' }} title="Books holds the credit note; this is its reference.">
            Credit note
          </dt>
          <dd style={{ margin: 0 }} className="num">{ret.books_credit_note_uuid ?? 'Not yet'}</dd>
          {ret.reason_note && (
            <>
              <dt style={{ color: 'var(--muted)' }}>Reason</dt>
              <dd style={{ margin: 0 }}>{ret.reason_note}</dd>
            </>
          )}
        </dl>
      </Card>

      <Card title="What came back">
        <DataTable
          rows={ret.lines}
          rowKey={(row) => row.line_id}
          columns={[
            { key: 'item', header: 'Item', render: (row) => row.display_name ?? `#${row.item_id}` },
            { key: 'qty', header: 'Qty', numeric: true, render: (row) => String(row.return_qty) },
            { key: 'rate', header: 'Rate', numeric: true, render: (row) => money(row.rate) },
            { key: 'amount', header: 'Amount', numeric: true, render: (row) => money(row.line_amount) },
            { key: 'condition', header: 'Condition', render: (row) => row.condition_code.replace(/_/g, ' ') },
          ]}
        />
      </Card>

      {ret.commands && ret.commands.length > 0 && <CommandStrip commands={ret.commands} />}
    </div>
  )
}
