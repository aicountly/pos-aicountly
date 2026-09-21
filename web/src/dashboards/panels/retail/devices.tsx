/**
 * The two panels on this board that are careful about what they claim.
 *
 * Devices reports CONFIGURATION and says so. Stock reports what Inventory
 * answered on this request, or says it could not get an answer — which is a
 * different fact from nothing being low, and the two must never render alike.
 */

import { count, decimal, sinceLabel } from '../../format'
import { Panel, StatusBadge, Unavailable } from '../../shell'
import type { RetailBoard } from '../../types'

/**
 * Peripherals.
 *
 * There is no green "Connected" dot on this panel and there cannot honestly be
 * one: a browser has no way to ask whether a receipt printer has paper or a
 * scanner is plugged in. What POS knows is what someone typed into the till's
 * setup, and that is what this shows.
 */
export function DeviceHealth({ board }: { board: RetailBoard }) {
  return (
    <Panel title="Devices" description="What each till is configured with.">
      <Unavailable title="Not verified">{board.devices.note}</Unavailable>

      <div className="pos-stack" style={{ marginTop: 14 }}>
        {board.devices.terminals.map((terminal) => (
          <div key={terminal.terminal_id}>
            <div className="pos-split">
              <strong>{terminal.display_name}</strong>
              <span className="pos-muted">
                {count(terminal.active_devices)} registered device{terminal.active_devices === 1 ? '' : 's'}
                {terminal.revoked_devices > 0 && `, ${count(terminal.revoked_devices)} revoked`}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {terminal.peripherals.map((peripheral) => (
                <StatusBadge
                  key={peripheral.kind}
                  tone={peripheral.state === 'configured' ? 'info' : 'neutral'}
                >
                  {peripheral.label}: {peripheral.state === 'configured' ? (peripheral.value ?? 'set') : 'not set up'}
                </StatusBadge>
              ))}
            </div>
          </div>
        ))}
        {board.devices.terminals.length === 0 && <p className="pos-muted">No tills to report on.</p>}
      </div>
    </Panel>
  )
}

/**
 * Low stock, read live from Inventory on this request.
 *
 * An unreachable Inventory renders as unknown, never as an empty list — the two
 * look identical in a table and only one of them means "stop reordering".
 */
export function StockAttention({ board }: { board: RetailBoard }) {
  return (
    <Panel
      title="Stock needing attention"
      description={board.stock.available ? 'Live from Inventory. Nothing here is stored in POS.' : undefined}
      action={
        <span className="pos-muted" style={{ fontSize: 12 }}>
          {board.stock.available ? `Read ${sinceLabel(board.stock.fetched_at)}` : 'Not available'}
        </span>
      }
    >
      {!board.stock.available ? (
        <Unavailable title="Stock levels are unknown right now">{board.stock.note}</Unavailable>
      ) : board.stock.items.length === 0 ? (
        <Unavailable muted title="Nothing is below its reorder level">
          Inventory answered and had nothing to flag.
        </Unavailable>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="is-number">Available</th>
                <th scope="col" className="is-number">Reorder at</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {board.stock.items.map((item, index) => (
                <tr key={`${item.item_id ?? index}`}>
                  <th scope="row" style={{ fontWeight: 500 }}>{item.display_name}</th>
                  <td className="is-number">{decimal(item.available, 2)}</td>
                  <td className="is-number">{decimal(item.reorder_level, 2)}</td>
                  <td>
                    <StatusBadge tone={(item.available ?? 0) <= 0 ? 'danger' : 'warning'}>
                      {(item.available ?? 0) <= 0 ? 'Out of stock' : 'Low stock'}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {board.stock.available && <p className="pos-note">{board.stock.source}</p>}
    </Panel>
  )
}
