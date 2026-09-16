import { useCallback, useEffect, useState } from 'react'
import { Check, ChefHat, Clock, X } from 'lucide-react'
import { api } from '../services/api'
import type { Kot } from '../services/types'
import { Button, Notice } from '../ui'

/**
 * The kitchen display.
 *
 * Deliberately plain and deliberately large: this screen is read across a hot
 * room by someone holding a pan. Tickets are oldest first, because a kitchen
 * works a queue, and a late ticket is marked against ITS OWN station's
 * threshold — a bar ticket is late after four minutes and a tandoor ticket is
 * not.
 */
export default function Kitchen() {
  const [kots, setKots] = useState<Kot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const response = await api.one<{ kots: Kot[] }>('v1/kds')
      setKots(response.data.kots)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the kitchen screen.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // A kitchen screen that lags is a kitchen screen nobody watches.
    const id = window.setInterval(load, 5000)
    return () => window.clearInterval(id)
  }, [load])

  const advance = async (kot: Kot, status: string) => {
    try {
      await api.post(`v1/kots/${kot.kot_id}/advance`, { status })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update that ticket.')
    }
  }

  if (loading) return <p style={{ color: 'var(--muted)' }}>Loading tickets…</p>

  if (kots.length === 0) {
    return (
      <Notice tone="success" title="Nothing waiting">
        Every ticket is served. New orders appear here the moment they are fired.
      </Notice>
    )
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(17rem, 1fr))', gap: '0.75rem' }}>
        {kots.map((kot) => (
          <div
            key={kot.kot_id}
            style={{
              border: '2px solid ' + (kot.is_late ? 'var(--danger-fg, #f87171)' : 'var(--border)'),
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)',
              padding: '0.85rem',
              display: 'grid',
              gap: '0.5rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong style={{ fontSize: '1.05rem' }}>
                {kot.table_code ? `Table ${kot.table_code}` : kot.token_no ? `Token ${kot.token_no}` : kot.kot_no}
              </strong>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: kot.is_late ? 'var(--danger-fg, #f87171)' : 'var(--muted)',
                }}
              >
                <Clock size={13} aria-hidden />
                {kot.waiting_minutes ?? 0}m
              </span>
            </div>

            <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              {kot.kot_no}
              {kot.kot_kind !== 'new' && (
                <strong style={{ color: 'var(--warn-fg, #fbbf24)', marginLeft: '0.4rem', textTransform: 'uppercase' }}>
                  {kot.kot_kind}
                </strong>
              )}
              {kot.station_name ? ` · ${kot.station_name}` : ''}
            </div>

            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.3rem' }}>
              {kot.lines.map((line) => (
                <li key={line.kot_line_id} style={{ fontSize: '1rem' }}>
                  <strong className="num">{line.quantity}×</strong> {line.display_name}
                  {line.modifiers.length > 0 && (
                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem', paddingLeft: '1.4rem' }}>
                      {line.modifiers.map((m) => m.option_name).join(', ')}
                    </div>
                  )}
                  {line.instructions && (
                    <div style={{ color: 'var(--warn-fg, #fbbf24)', fontSize: '0.82rem', paddingLeft: '1.4rem' }}>
                      {line.instructions}
                    </div>
                  )}
                  {line.allergy_note && (
                    <div style={{ color: 'var(--danger-fg, #f87171)', fontWeight: 700, fontSize: '0.85rem', paddingLeft: '1.4rem' }}>
                      ALLERGY: {line.allergy_note}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {kot.notes && <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--warn-fg, #fbbf24)' }}>{kot.notes}</p>}

            <div style={{ display: 'flex', gap: '0.35rem' }}>
              {kot.status === 'NEW' && (
                <Button onClick={() => void advance(kot, 'PREPARING')} style={{ flex: 1, justifyContent: 'center' }}>
                  <ChefHat size={14} aria-hidden /> Start
                </Button>
              )}
              {kot.status === 'PREPARING' && (
                <Button onClick={() => void advance(kot, 'READY')} style={{ flex: 1, justifyContent: 'center' }}>
                  <Check size={14} aria-hidden /> Ready
                </Button>
              )}
              {kot.status === 'READY' && (
                <Button tone="ghost" onClick={() => void advance(kot, 'SERVED')} style={{ flex: 1, justifyContent: 'center' }}>
                  <X size={14} aria-hidden /> Picked up
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
