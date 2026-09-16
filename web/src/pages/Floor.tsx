import { useCallback, useEffect, useState } from 'react'
import { ArrowRightLeft, Loader2, Merge, Users } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { api } from '../services/api'
import type { FloorPlanFloor, FloorPlanTable } from '../services/types'
import { Button, Card, Notice, money } from '../ui'

/**
 * The floor.
 *
 * Refreshed on a short interval because a restaurant floor changes under you —
 * another waiter seats a table while you are looking at it. The interval is
 * short enough to be useful and long enough not to hammer a shared server.
 */
export default function Floor() {
  const { can, terminalId } = usePos()
  const [floors, setFloors] = useState<FloorPlanFloor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await api.one<{ floors: FloorPlanFloor[] }>('v1/floor-plan')
      setFloors(response.data.floors)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the floor.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(load, 10000)
    return () => window.clearInterval(id)
  }, [load])

  const seat = async (table: FloorPlanTable) => {
    const covers = window.prompt(`How many people at ${table.table_code}?`, String(table.seats))
    if (covers === null) return
    setBusy(true)
    try {
      await api.post(`v1/tables/${table.table_id}/open`, { covers: Number(covers) || table.seats, terminal_id: terminalId })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not seat that table.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async (table: FloorPlanTable) => {
    if (!table.table_session_id) return
    setBusy(true)
    try {
      await api.post(`v1/table-sessions/${table.table_session_id}/close`, {})
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear that table.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p style={{ color: 'var(--muted)' }}>Loading the floor…</p>

  if (floors.length === 0) {
    return (
      <Notice tone="info" title="No floors set up yet">
        Add a floor and its tables under Setup. Until then this outlet works as a counter, which is what a retail shop
        wants anyway.
      </Notice>
    )
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}

      {floors.map((floor) => (
        <Card key={floor.floor_id} title={floor.floor_name} subtitle={`${floor.tables.length} tables`}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))', gap: '0.75rem' }}>
            {floor.tables.map((table) => {
              const occupied = table.status === 'OCCUPIED'
              return (
                <div
                  key={table.table_id}
                  style={{
                    border: '1px solid ' + (occupied ? 'var(--border-strong)' : 'var(--border)'),
                    background: occupied ? 'var(--surface-2)' : 'transparent',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.75rem',
                    display: 'grid',
                    gap: '0.4rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong>{table.table_name ?? table.table_code}</strong>
                    <span style={{ color: 'var(--muted)', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                      <Users size={12} aria-hidden />
                      {occupied ? table.covers : table.seats}
                    </span>
                  </div>

                  {occupied ? (
                    <>
                      <div className="num" style={{ fontSize: '1.05rem', fontWeight: 600 }}>
                        {money(table.running_total ?? 0)}
                      </div>
                      {table.open_kots > 0 && (
                        <div style={{ color: 'var(--warn-fg, #fbbf24)', fontSize: '0.78rem' }}>
                          {table.open_kots} ticket{table.open_kots === 1 ? '' : 's'} with the kitchen
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                        {can('table.transfer') && (
                          <Button tone="ghost" onClick={() => void transfer(table, load, setError)} disabled={busy}>
                            <ArrowRightLeft size={12} aria-hidden /> Move
                          </Button>
                        )}
                        {can('table.merge') && (
                          <Button tone="ghost" onClick={() => void merge(table, floors, load, setError)} disabled={busy}>
                            <Merge size={12} aria-hidden /> Merge
                          </Button>
                        )}
                        {can('table.open') && (
                          <Button tone="ghost" onClick={() => void clear(table)} disabled={busy}>
                            Clear
                          </Button>
                        )}
                      </div>
                    </>
                  ) : (
                    can('table.open') && (
                      <Button onClick={() => void seat(table)} disabled={busy}>
                        {busy ? <Loader2 size={12} className="spin" aria-hidden /> : null} Seat
                      </Button>
                    )
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      ))}
    </div>
  )
}

async function transfer(
  table: FloorPlanTable,
  reload: () => Promise<void>,
  onError: (message: string) => void,
): Promise<void> {
  if (!table.table_session_id) return
  const code = window.prompt('Move this party to which table? Type the table code.')
  if (code === null || code.trim() === '') return

  try {
    const plan = await api.one<{ floors: FloorPlanFloor[] }>('v1/floor-plan')
    const target = plan.data.floors
      .flatMap((f) => f.tables)
      .find((t) => t.table_code.toLowerCase() === code.trim().toLowerCase())

    if (!target) {
      onError(`There is no table called ${code.trim()}.`)
      return
    }

    await api.post(`v1/table-sessions/${table.table_session_id}/transfer`, { table_id: target.table_id })
    await reload()
  } catch (e) {
    onError(e instanceof Error ? e.message : 'Could not move that table.')
  }
}

async function merge(
  table: FloorPlanTable,
  floors: FloorPlanFloor[],
  reload: () => Promise<void>,
  onError: (message: string) => void,
): Promise<void> {
  if (!table.table_session_id) return
  const code = window.prompt('Put this table’s bill onto which table? Type the table code.')
  if (code === null || code.trim() === '') return

  const target = floors
    .flatMap((f) => f.tables)
    .find((t) => t.table_code.toLowerCase() === code.trim().toLowerCase() && t.status === 'OCCUPIED')

  if (!target?.table_session_id) {
    onError(`Table ${code.trim()} is not occupied, so there is no bill to merge into.`)
    return
  }

  try {
    await api.post(`v1/table-sessions/${table.table_session_id}/merge`, { into_table_session_id: target.table_session_id })
    await reload()
  } catch (e) {
    onError(e instanceof Error ? e.message : 'Could not merge those tables.')
  }
}
