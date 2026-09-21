/**
 * What needed, or still needs, a manager.
 *
 * SIX NUMBERS, READ IN TWO SECONDS, AND ONE OF THEM OPENED. That is the whole
 * design: the tiles are a triage, and the rows behind a tile are fetched when
 * somebody opens it and not before — a shift with four hundred approval events
 * must not cost four hundred rows on every page load.
 *
 * THE PAGE IS NOT FLOODED WITH RED. Tone follows the state of the thing rather
 * than its category: four overrides a manager approved are a record and read
 * amber; one nobody approved is a question and reads red; none at all reads
 * green. A screen where everything is red is a screen nobody reads.
 */

import { useState } from 'react'
import {
  Ban,
  Inbox,
  Percent,
  ShieldAlert,
  Undo2,
  UserRoundCheck,
} from 'lucide-react'
import { Note, Overlay } from './states'
import { useRiskDetail, RISK_ROWS_PER_PAGE } from '../useShiftReport'
import { clockLabel, moneyExact } from '../format'
import type { RiskBlock, RiskKind, RiskTile as RiskTileShape } from '../types'

const RISK_ICONS: Record<RiskKind, typeof Ban> = {
  voids: Ban,
  no_sale: Inbox,
  override: Percent,
  refund: Undo2,
  approval: UserRoundCheck,
  suspicious: ShieldAlert,
}

const DRAWER_TITLES: Record<RiskKind, { title: string; description: string }> = {
  voids: { title: 'Void events', description: 'Bills cancelled on this shift before they were paid for.' },
  no_sale: { title: 'No-sale drawer opens', description: 'Every time the drawer opened with no sale behind it.' },
  override: { title: 'Price and discount overrides', description: 'What was changed at the counter, and who allowed it.' },
  refund: { title: 'Refund requests', description: 'Returns taken at the counter on this shift.' },
  approval: { title: 'Approvals still unsigned', description: 'Recorded on this shift with nobody signed against them.' },
  suspicious: { title: 'Flagged for investigation', description: 'Rule-based checks on this shift that fired.' },
}

export function RiskTile({ tile, onOpen }: { tile: RiskTileShape; onOpen: (kind: RiskKind) => void }) {
  const Icon = RISK_ICONS[tile.kind] ?? ShieldAlert
  const openable = tile.count > 0

  return (
    <button
      type="button"
      className={tile.tone === 'success' ? 'shift-risk__tile' : `shift-risk__tile shift-risk__tile--${tile.tone}`}
      onClick={() => onOpen(tile.kind)}
      disabled={!openable}
      aria-label={
        openable
          ? `${tile.label}: ${tile.count}. ${tile.action_label}. ${tile.note} Open the detail.`
          : `${tile.label}: ${tile.count}. ${tile.action_label}.`
      }
      title={tile.note}
    >
      <span className="shift-risk__label">
        {tile.label}
        <Icon size={14} aria-hidden style={{ flex: '0 0 auto', opacity: 0.75 }} />
      </span>
      <span className="shift-risk__count">{tile.count}</span>
      {/* The words, not just the colour — one man in twelve cannot tell the
          amber tile from the red one. */}
      <span className="shift-risk__action">{tile.action_label}</span>
    </button>
  )
}

export function RiskMonitor({
  risk,
  sessionId,
  onViewAll,
}: {
  risk: RiskBlock
  sessionId: number
  onViewAll: () => void
}) {
  const [open, setOpen] = useState<RiskKind | null>(null)
  const needing = risk.tiles.filter((tile) => tile.count > 0 && tile.tone !== 'success').length

  return (
    <section className="shift-card" aria-label="Approvals and risk monitor">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <ShieldAlert size={14} />
            </span>
            Approvals &amp; Risk Monitor
          </h2>
          <p>
            Items that need attention from managers
            {needing > 0
              ? ` — ${needing} of ${risk.tiles.length} need${needing === 1 ? 's' : ''} a look`
              : ' — nothing outstanding on this shift'}
          </p>
        </div>

        <button type="button" className="shift-button shift-button--quiet" onClick={onViewAll}>
          View all →
        </button>
      </div>

      <div className="shift-risk">
        {risk.tiles.map((tile) => (
          <RiskTile key={tile.kind} tile={tile} onOpen={setOpen} />
        ))}
      </div>

      {risk.suspicious.items.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Note tone="danger" title="Flagged by a rule on this shift">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {risk.suspicious.items.map((item) => (
                <li key={item.id} style={{ marginBottom: 2 }}>
                  <strong style={{ display: 'inline' }}>{item.title}.</strong> {item.detail}
                </li>
              ))}
            </ul>
          </Note>
        </div>
      )}

      <p className="shift-card__note">{risk.suspicious.note}</p>

      {open && <RiskDrawer sessionId={sessionId} kind={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

/**
 * The rows behind one tile.
 *
 * Paged at twenty. A drawer that fetched everything would be the exact problem
 * the tiles exist to avoid, one click later.
 */
export function RiskDrawer({
  sessionId,
  kind,
  onClose,
  timezone,
}: {
  sessionId: number
  kind: RiskKind
  onClose: () => void
  timezone?: string
}) {
  const detail = useRiskDetail(sessionId, kind)
  const copy = DRAWER_TITLES[kind]
  const page = Math.floor(detail.offset / RISK_ROWS_PER_PAGE) + 1
  const pages = Math.max(1, Math.ceil(detail.total / RISK_ROWS_PER_PAGE))

  return (
    <Overlay
      variant="drawer"
      labelledBy={`risk-drawer-${kind}`}
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      footer={
        <>
          <span className="shift-pager" style={{ margin: 0 }}>
            {detail.total === 0 ? 'Nothing to show' : `${detail.total} in total · page ${page} of ${pages}`}
          </span>
          <span className="shift-pager__buttons">
            <button
              type="button"
              className="shift-button"
              onClick={() => detail.setOffset(Math.max(0, detail.offset - RISK_ROWS_PER_PAGE))}
              disabled={detail.offset === 0 || detail.loading}
            >
              Previous
            </button>
            <button
              type="button"
              className="shift-button"
              onClick={() => detail.setOffset(detail.offset + RISK_ROWS_PER_PAGE)}
              disabled={page >= pages || detail.loading}
            >
              Next
            </button>
          </span>
        </>
      }
    >
      {detail.error ? (
        <Note tone="danger" title="Unable to load these events.">
          {detail.error}{' '}
          <button type="button" className="shift-button shift-button--quiet" onClick={detail.retry}>
            Retry
          </button>
        </Note>
      ) : detail.loading && detail.rows.length === 0 ? (
        <div className="shift-skeleton" style={{ height: 220 }} role="status" aria-label="Loading these events" />
      ) : detail.rows.length === 0 ? (
        <p className="shift-card__note">Nothing of this kind happened on this shift.</p>
      ) : (
        <>
          {detail.note && <Note tone="info">{detail.note}</Note>}

          <div className="shift-scroll" style={{ marginTop: detail.note ? 12 : 0 }}>
            <table className="shift-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">{kind === 'suspicious' ? 'Finding' : 'Reference'}</th>
                  <th scope="col" className="is-number">Amount</th>
                  <th scope="col">By</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Approved by</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="is-muted">{row.at ? clockLabel(row.at, timezone) : '—'}</td>
                    <td>
                      {row.reference}
                      {row.detail && (
                        <span className="is-muted" style={{ display: 'block', fontSize: 10.5 }}>
                          {row.detail}
                        </span>
                      )}
                    </td>
                    <td className="is-number">{row.amount === null ? '—' : moneyExact(row.amount)}</td>
                    <td>{row.actor?.label ?? '—'}</td>
                    <td className="is-muted">{row.reason ?? '—'}</td>
                    <td>{row.approved_by?.label ?? '—'}</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Overlay>
  )
}
