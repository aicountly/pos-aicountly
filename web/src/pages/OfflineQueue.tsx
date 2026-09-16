import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../services/api'
import type { OfflineSubmission } from '../services/types'
import { outboxAll, type OutboxSale } from '../offline/db'
import { drainOutbox } from '../offline/sync'
import { Button, Card, DataTable, Notice, StatusBadge, money } from '../ui'

/**
 * Sales made offline, on both sides of the line.
 *
 * THIS TILL shows what is still sitting in this browser's outbox — sales this
 * machine took that the server has not acknowledged. THE SERVER shows what
 * arrived and did not post.
 *
 * Both are shown because they fail differently and are fixed differently: a
 * sale stuck on the till needs a connection, and a sale stuck on the server
 * needs a person.
 */
export default function OfflineQueue() {
  const [local, setLocal] = useState<OutboxSale[]>([])
  const [server, setServer] = useState<OfflineSubmission[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLocal(await outboxAll())
    try {
      const response = await api.list<OfflineSubmission>('v1/offline/queue', { limit: 100 })
      setServer(response.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server to check the queue.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sync = async () => {
    setBusy(true)
    try {
      const outcome = await drainOutbox()
      setNotice(outcome.message)
    } finally {
      setBusy(false)
      await load()
    }
  }

  const retry = async (submissionId: number) => {
    setBusy(true)
    try {
      await api.post(`v1/offline/${submissionId}/retry`, {})
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That sale still will not post.')
    } finally {
      setBusy(false)
    }
  }

  const abandon = async (submissionId: number) => {
    const note = window.prompt('This sale will never reach the books. Say why it is being abandoned — the note is kept.')
    if (note === null || note.trim() === '') return
    setBusy(true)
    try {
      await api.post(`v1/offline/${submissionId}/abandon`, { note: note.trim() })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not abandon that sale.')
    } finally {
      setBusy(false)
    }
  }

  const waiting = local.filter((s) => s.status !== 'DONE')

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="info" onDismiss={() => setNotice(null)}>{notice}</Notice>}

      <Card
        title="Waiting on this till"
        subtitle={
          waiting.length === 0
            ? 'Nothing. Everything this machine took has been acknowledged.'
            : `${waiting.length} sale${waiting.length === 1 ? '' : 's'} not yet acknowledged by the server`
        }
        action={
          <Button onClick={() => void sync()} disabled={busy || waiting.length === 0}>
            <RefreshCw size={14} aria-hidden /> Send now
          </Button>
        }
      >
        {waiting.length === 0 ? (
          <p style={{ color: 'var(--muted)', margin: 0 }}>
            A sale stays here until the server says it is in. It is never dropped because sending failed.
          </p>
        ) : (
          <DataTable
            rows={waiting}
            rowKey={(row) => row.client_uuid}
            columns={[
              { key: 'taken_at', header: 'Taken at', render: (row) => new Date(row.client_created_at).toLocaleString() },
              { key: 'lines', header: 'Lines', render: (row) => String(row.lines.length) },
              {
                key: 'amount', header: 'Amount',
                numeric: true,
                render: (row) => money(row.payments.reduce((sum, p) => sum + p.amount, 0)),
              },
              { key: 'tries', header: 'Tries', numeric: true, render: (row) => String(row.attempts) },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'last_error', header: 'Last error', render: (row) => row.lastError ?? '—' },
            ]}
          />
        )}
      </Card>

      <Card
        title="Arrived but not posted"
        subtitle="The server has these; something stopped them going into the books"
      >
        {server.length === 0 ? (
          <p style={{ color: 'var(--muted)', margin: 0 }}>Nothing stuck.</p>
        ) : (
          <DataTable
            rows={server}
            rowKey={(row) => row.submission_id}
            columns={[
              { key: 'taken_at', header: 'Taken at', render: (row) => new Date(row.client_created_at).toLocaleString() },
              { key: 'till', header: 'Till', render: (row) => (row.terminal_id ? `#${row.terminal_id}` : '—') },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'tries', header: 'Tries', numeric: true, render: (row) => String(row.attempts) },
              {
                key: 'why', header: 'Why',
                render: (row) => (
                  <span style={{ color: row.conflict_detail ? 'var(--danger-fg, #f87171)' : 'var(--muted)' }}>
                    {row.conflict_detail ?? row.last_error ?? '—'}
                  </span>
                ),
              },
              {
                key: 'actions', header: '',
                render: (row) =>
                  row.status === 'ABANDONED' || row.status === 'POSTED' ? null : (
                    <span style={{ display: 'flex', gap: '0.35rem' }}>
                      <Button tone="ghost" onClick={() => void retry(row.submission_id)} disabled={busy}>
                        <RefreshCw size={12} aria-hidden /> Retry
                      </Button>
                      <Button tone="ghost" onClick={() => void abandon(row.submission_id)} disabled={busy}>
                        <Trash2 size={12} aria-hidden /> Abandon
                      </Button>
                    </span>
                  ),
              },
            ]}
          />
        )}

        {server.some((s) => s.status === 'CONFLICT') && (
          <Notice tone="warning" title="These need a decision">
            <AlertTriangle size={14} aria-hidden style={{ verticalAlign: '-2px', marginRight: '0.3rem' }} />
            A conflict means the books refused the sale — a closed period, a customer that no longer exists. Retrying
            without changing anything will refuse again. Fix the cause, then retry; or abandon it and record why.
          </Notice>
        )}
      </Card>
    </div>
  )
}
