/**
 * The Cash, Shifts & Controls panels.
 *
 * The board a manager closes the day on, so it is the one where nothing may be
 * glossed. Three things it refuses to do:
 *
 *   • Show a variance on a drawer nobody has counted. Null is rendered as
 *     "not counted", never as zero.
 *   • Put a provider-confirmed column next to a recorded one when the confirmed
 *     figure does not exist.
 *   • Offer Retry on a command the other product refused for a business reason.
 *     Retrying a locked period cannot work, and a button that pretends
 *     otherwise teaches people to press it twice.
 *
 * WHAT MOVED. The shift register, the drawer summary and the cash-movements
 * table used to live here too. They are now the Shift Overview, Cash
 * Reconciliation and Recent Cash Transactions cards in ./controls, which the
 * board composes directly. The panels left in this file are the ones that own a
 * workflow — retrying a posting, signing an approval, reading the audit trail —
 * and the board still renders them underneath the cards.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { actor, count, dateTime, money, moneyExact, titleCase } from '../format'
import { Panel, StatusBadge, Unavailable } from '../shell'
import type { ControlsBoard } from '../types'
import { TimelineEntry } from './common'

export function TenderReconciliation({ board }: { board: ControlsBoard }) {
  return (
    <Panel title="Tender reconciliation" description="What was recorded, and what it can be reconciled against.">
      <div className="pos-table-wrap">
        <table className="pos-table">
          <thead>
            <tr>
              <th scope="col">Tender</th>
              <th scope="col" className="is-number">Recorded</th>
              <th scope="col" className="is-number">Count</th>
              <th scope="col" className="is-number">Provider confirmed</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {board.tenders.lines.map((line) => (
              <tr key={line.payment_mode}>
                <th scope="row" style={{ fontWeight: 600 }}>{line.display_name}</th>
                <td className="is-number">{moneyExact(line.amount)}</td>
                <td className="is-number">{count(line.count)}</td>
                <td className="is-number">
                  {/* Never the recorded figure repeated. */}
                  <span className="pos-muted">Not available</span>
                </td>
                <td>
                  <StatusBadge tone={line.settlement_state === 'collected' ? 'success' : 'info'} dot>
                    {line.settlement_label}
                  </StatusBadge>
                  <span className="pos-muted" style={{ display: 'block', fontSize: 11.5 }}>
                    {line.settlement_state === 'recorded' && line.with_reference > 0
                      ? `${count(line.with_reference)} of ${count(line.count)} have a reference typed in`
                      : line.evidence}
                  </span>
                </td>
              </tr>
            ))}
            {board.tenders.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="pos-muted">
                  No tenders recorded in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {board.tenders.refunds.length > 0 && (
        <>
          <h3>Refunds</h3>
          <div className="pos-stack pos-stack--tight">
            {board.tenders.refunds.map((refund) => (
              <div key={refund.resolution} className="pos-split">
                <span>
                  {refund.display_name}
                  <span className="pos-muted"> · {count(refund.count)}</span>
                </span>
                <strong>{moneyExact(refund.amount)}</strong>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 14 }}>
        <Unavailable title="No provider to reconcile against">
          {board.tenders.provider.note}
          <br />
          <span className="pos-muted">{board.tenders.provider.contract_gap}</span>
        </Unavailable>
      </div>
    </Panel>
  )
}

export function ApprovalQueue({ board }: { board: ControlsBoard }) {
  const pending = board.approvals.pending_variances

  return (
    <Panel
      title="Approvals"
      description="What someone had to sign for, and what is still waiting."
    >
      {pending.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Unavailable title={`${count(pending.length)} drawer${pending.length === 1 ? '' : 's'} closed out and unsigned`}>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {pending.map((item) => (
                <li key={item.session_id}>
                  {item.terminal_code ?? `Shift #${item.session_id}`} — {moneyExact(item.variance)}{' '}
                  {item.variance < 0 ? 'short' : 'over'}
                  {item.reason && <> · “{item.reason}”</>}
                </li>
              ))}
            </ul>
          </Unavailable>
        </div>
      )}

      {board.approvals.summary.length === 0 ? (
        <Unavailable muted title="Nothing needed approving">
          No discount override, void, refund or cash adjustment was recorded in this period.
        </Unavailable>
      ) : (
        <>
          <div className="pos-stack pos-stack--tight">
            {board.approvals.summary.map((row) => (
              <div key={row.event_kind} className="pos-split">
                <span>{row.display_name}</span>
                <span>
                  <strong>{count(row.count)}</strong>
                  {row.unapproved > 0 && (
                    <>
                      {' '}
                      <StatusBadge tone="warning">{count(row.unapproved)} unsigned</StatusBadge>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          <h3>Most recent</h3>
          <div className="pos-table-wrap">
            <table className="pos-table">
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Asked by</th>
                  <th scope="col">Approved by</th>
                  <th scope="col">Reason</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {board.approvals.events.slice(0, 12).map((event) => (
                  <tr key={event.approval_id}>
                    <th scope="row" style={{ fontWeight: 500 }}>{event.display_name}</th>
                    <td>{actor(event.requested_by)}</td>
                    <td>
                      {event.approved_by ? (
                        actor(event.approved_by)
                      ) : (
                        <StatusBadge tone="warning">Unsigned</StatusBadge>
                      )}
                    </td>
                    <td>{event.reason ?? <span className="pos-muted">—</span>}</td>
                    <td>{dateTime(event.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}

/**
 * Posting exceptions, and the recovery each one actually permits.
 *
 * FAILED gets Retry. BLOCKED does not, and says why. IN FLIGHT gets neither,
 * because the outcome is unknown and pressing anything is the one thing that
 * could turn an unknown into a double posting.
 */
export function PostingExceptions({
  board,
  onRetry,
  busy,
}: {
  board: ControlsBoard
  onRetry: (kind: 'cart' | 'offline', id: number) => void
  busy: string | null
}) {
  const { commands, offline } = board.posting

  return (
    <Panel title="Posting exceptions" description="Payment, Books and Inventory are separate outcomes.">
      {commands.length === 0 && offline.length === 0 ? (
        <Unavailable muted title="Everything has landed">
          No sale is waiting on Books or Inventory, and no offline sale is outstanding.
        </Unavailable>
      ) : (
        <>
          {commands.length > 0 && (
            <div className="pos-table-wrap">
              <table className="pos-table">
                <caption>Sales waiting on another product</caption>
                <thead>
                  <tr>
                    <th scope="col">Sale</th>
                    <th scope="col">Goes to</th>
                    <th scope="col">State</th>
                    <th scope="col" className="is-number">Tries</th>
                    <th scope="col">Last error</th>
                    <th scope="col"><span className="pos-visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((command) => (
                    <tr key={command.command_id}>
                      <th scope="row" style={{ fontWeight: 600 }}>
                        {command.books_voucher_no ?? `#${command.entity_id}`}
                        {command.total_amount !== null && (
                          <span className="pos-muted" style={{ display: 'block', fontWeight: 400 }}>
                            {money(command.total_amount)}
                            {command.terminal_code && ` · ${command.terminal_code}`}
                          </span>
                        )}
                      </th>
                      <td>{titleCase(command.target_service)}</td>
                      <td>
                        <StatusBadge
                          tone={
                            command.status === 'BLOCKED'
                              ? 'danger'
                              : command.status === 'FAILED'
                                ? 'warning'
                                : 'info'
                          }
                          dot
                        >
                          {titleCase(command.status)}
                        </StatusBadge>
                        <span className="pos-muted" style={{ display: 'block', fontSize: 11.5 }}>
                          {command.state_label}
                        </span>
                      </td>
                      <td className="is-number">{count(command.attempts)}</td>
                      <td style={{ maxWidth: 260 }}>
                        {command.last_error ? (
                          <span className="pos-muted">{command.last_error}</span>
                        ) : (
                          <span className="pos-muted">—</span>
                        )}
                      </td>
                      <td>
                        {command.retryable ? (
                          <button
                            type="button"
                            className="pos-button pos-button--small"
                            disabled={busy === `cart:${command.entity_id}`}
                            onClick={() => onRetry('cart', command.entity_id)}
                          >
                            {busy === `cart:${command.entity_id}` ? 'Retrying…' : 'Retry'}
                          </button>
                        ) : (
                          <span className="pos-muted" style={{ fontSize: 11.5 }}>
                            {command.status === 'BLOCKED' ? 'Fix the cause first' : 'Wait for the answer'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {offline.length > 0 && (
            <div className="pos-table-wrap" style={{ marginTop: 18 }}>
              <table className="pos-table">
                <caption>Sales taken while a till was offline</caption>
                <thead>
                  <tr>
                    <th scope="col">Till</th>
                    <th scope="col">Taken</th>
                    <th scope="col">State</th>
                    <th scope="col">Why it is stuck</th>
                    <th scope="col"><span className="pos-visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {offline.map((submission) => (
                    <tr key={submission.submission_id}>
                      <th scope="row" style={{ fontWeight: 600 }}>
                        {submission.terminal_code ?? <span className="pos-muted">Unknown till</span>}
                      </th>
                      <td>{dateTime(submission.client_created_at)}</td>
                      <td>
                        <StatusBadge tone={submission.status === 'CONFLICT' ? 'danger' : 'warning'} dot>
                          {titleCase(submission.status)}
                        </StatusBadge>
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        <span className="pos-muted">
                          {submission.conflict_detail ?? submission.last_error ?? 'Waiting to be sent again.'}
                        </span>
                      </td>
                      <td>
                        {submission.retryable ? (
                          <button
                            type="button"
                            className="pos-button pos-button--small"
                            disabled={busy === `offline:${submission.submission_id}`}
                            onClick={() => onRetry('offline', submission.submission_id)}
                          >
                            {busy === `offline:${submission.submission_id}` ? 'Retrying…' : 'Retry'}
                          </button>
                        ) : (
                          <Link className="pos-button pos-button--quiet pos-button--small" to="/offline">
                            Resolve
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <p className="pos-note">{board.posting.note}</p>
    </Panel>
  )
}

export function AuditTimeline({ board }: { board: ControlsBoard }) {
  const [expanded, setExpanded] = useState(false)
  const entries = expanded ? board.audit : board.audit.slice(0, 10)

  return (
    <Panel
      title="Audit trail"
      description="Append-only. The database refuses an edit or a delete, not just the API."
      action={
        board.audit.length > 10 ? (
          <button
            type="button"
            className="pos-button pos-button--quiet pos-button--small"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Show fewer' : `Show all ${count(board.audit.length)}`}
          </button>
        ) : undefined
      }
    >
      {board.audit.length === 0 ? (
        <Unavailable muted title="Nothing recorded in this period">
          No shift, cart, return or setting was changed.
        </Unavailable>
      ) : (
        <ul className="pos-timeline">
          {entries.map((entry) => (
            <TimelineEntry
              key={entry.audit_id}
              action={entry.action}
              actorLabel={`${actor(entry.actor_uuid)} · ${entry.source_app}`}
              at={entry.created_at}
              reason={entry.reason}
              detail={
                entry.before_state || entry.after_state ? (
                  <>
                    {entry.entity_type}
                    {entry.entity_id && ` #${entry.entity_id}`}
                    {entry.before_state && entry.after_state && (
                      <>
                        {' · '}
                        {summarise(entry.before_state)} → {summarise(entry.after_state)}
                      </>
                    )}
                  </>
                ) : null
              }
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

/**
 * A before/after state as one readable line.
 *
 * Audit payloads are JSON written by whatever recorded them, so this renders
 * them as TEXT and never as markup. React escapes it, which is the point: an
 * audit reason is user input and has no business becoming HTML.
 */
function summarise(state: Record<string, unknown>): string {
  const parts = Object.entries(state)
    .slice(0, 3)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${formatValue(value)}`)

  return parts.length === 0 ? '—' : parts.join(', ')
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value

  return '…'
}

