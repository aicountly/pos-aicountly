import { usePos } from '../context/PosContext'
import { Select } from '../ui'

/**
 * Which till this browser is.
 *
 * Almost everything POS does is attributed to a terminal, so this sits in the
 * header rather than in settings. It is remembered per browser because a till
 * is a physical machine: once chosen, it rarely changes.
 */
export function TerminalPicker() {
  const { session, terminalId, setTerminalId } = usePos()

  if (!session || session.terminals.length === 0) return null

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--muted)' }}>
      Till
      <Select
        value={terminalId ?? ''}
        onChange={(e) => setTerminalId(e.target.value === '' ? null : Number(e.target.value))}
        style={{ minWidth: '9rem' }}
      >
        <option value="">Choose…</option>
        {session.terminals.map((terminal) => (
          <option key={terminal.terminal_id} value={terminal.terminal_id}>
            {terminal.display_name ?? terminal.terminal_code}
          </option>
        ))}
      </Select>
    </label>
  )
}
