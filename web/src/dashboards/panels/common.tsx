/**
 * Panels more than one board uses.
 *
 * Kept small and specific. There is deliberately no generic <ChartPanel> that
 * every board renders with a different heading — the boards differ because the
 * questions differ, and a component that flattens that difference would produce
 * five identical screens.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { StatusBadge, Unavailable, type BadgeTone } from '../shell'
import { count, dateTime, duration, money, titleCase } from '../format'
import type { InsightBlock, IntegrationState, TenderLine } from '../types'
import { ShareBars } from '../charts'

/** The suggestions panel, with the AI state told honestly at the bottom. */
export function InsightList({
  block,
  emptyTitle = 'Nothing needs attention',
  emptyBody,
  renderItem,
}: {
  block: InsightBlock
  emptyTitle?: string
  emptyBody?: string
  renderItem: (item: InsightBlock['items'][number]) => ReactNode
}) {
  return (
    <>
      {block.items.length === 0 ? (
        <Unavailable muted title={emptyTitle}>
          {emptyBody ?? 'No threshold was crossed in this period. Nothing is being hidden — there is nothing to show.'}
        </Unavailable>
      ) : (
        block.items.map(renderItem)
      )}

      <p className="pos-note">
        <StatusBadge tone="neutral">No AI configured</StatusBadge> {block.ai.note}
      </p>
    </>
  )
}

const INTEGRATION_TONE: Record<IntegrationState, BadgeTone> = {
  posted: 'success',
  failed: 'danger',
  blocked: 'danger',
  in_flight: 'warning',
  not_attempted: 'neutral',
}

const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  posted: 'Posted',
  failed: 'Failed',
  blocked: 'Refused',
  in_flight: 'In flight',
  not_attempted: 'Not sent',
}

/**
 * One leg of a sale.
 *
 * Three of these appear side by side on a transaction row — payment, Books,
 * Inventory — because they are three separate outcomes and a single tick over
 * all three is how a shop finds out at stock-take that a week never moved.
 */
export function IntegrationBadge({ state, label }: { state: IntegrationState; label?: string }) {
  return (
    <StatusBadge tone={INTEGRATION_TONE[state]} dot>
      {label ? `${label}: ` : ''}
      {INTEGRATION_LABEL[state]}
    </StatusBadge>
  )
}

/** Cash is collected. Everything else is only recorded, and says so. */
export function TenderStateBadge({ state }: { state: 'collected' | 'recorded' | 'none' }) {
  if (state === 'none') return <StatusBadge tone="neutral">No tender</StatusBadge>
  if (state === 'collected') return <StatusBadge tone="success">In the drawer</StatusBadge>

  return <StatusBadge tone="info">Recorded, not confirmed</StatusBadge>
}

/**
 * The tender mix.
 *
 * Shared by Business Overview and Controls, because the same distinction
 * matters on both: what is in the drawer versus what a cashier typed off a
 * terminal slip.
 */
export function TenderMix({ lines }: { lines: TenderLine[] }) {
  const recorded = lines.filter((line) => line.settlement_state === 'recorded')

  return (
    <>
      <ShareBars
        rows={lines.map((line) => ({
          key: line.payment_mode,
          label: line.display_name,
          value: line.amount,
          note: `${count(line.count)} tender${line.count === 1 ? '' : 's'} · ${line.settlement_label}`,
          tone: line.settlement_state === 'collected' ? 'brand' : 'muted',
        }))}
        format={(v) => money(v)}
        emptyLabel="No tenders recorded in this period."
      />

      {recorded.length > 0 && (
        <p className="pos-note">
          <strong>{recorded.map((l) => l.display_name).join(', ')}</strong> {recorded.length === 1 ? 'is' : 'are'}{' '}
          recorded at the counter from an external terminal slip. POS has no payment provider integration, so nothing
          here is a provider-confirmed collection.
        </p>
      )}
    </>
  )
}

/** A count that links somewhere, or a count that does not. Used on both attention panels. */
export function AttentionRow({
  label,
  value,
  tone = 'neutral',
  href,
  description,
}: {
  label: string
  value: number
  tone?: BadgeTone
  href?: string
  description?: string
}) {
  const body = (
    <>
      <span style={{ minWidth: 0 }}>
        <strong>{label}</strong>
        {description && (
          <span className="pos-muted" style={{ display: 'block' }}>
            {description}
          </span>
        )}
      </span>
      <StatusBadge tone={value > 0 ? tone : 'neutral'}>{count(value)}</StatusBadge>
    </>
  )

  if (href && value > 0) {
    return (
      <Link className="pos-split" to={href} style={{ textDecoration: 'none', color: 'inherit' }}>
        {body}
      </Link>
    )
  }

  return <div className="pos-split">{body}</div>
}

/** An audit or activity entry. Shared by Controls and, in miniature, by Retail. */
export function TimelineEntry({
  action,
  actorLabel,
  at,
  reason,
  detail,
}: {
  action: string
  actorLabel: string
  at: string
  reason?: string | null
  detail?: ReactNode
}) {
  return (
    <li>
      <div className="pos-timeline__head">
        <span className="pos-timeline__action">{titleCase(action)}</span>
        <span className="pos-muted">{actorLabel}</span>
        <span className="pos-muted">{dateTime(at)}</span>
      </div>
      {reason && <p className="pos-timeline__detail">“{reason}”</p>}
      {detail && <p className="pos-timeline__detail">{detail}</p>}
    </li>
  )
}

/** "Updated 2m ago", with the absolute time in the tooltip. */
export function Freshness({ at, refreshing }: { at: Date | null; refreshing: boolean }) {
  if (refreshing) return <>Refreshing…</>
  if (!at) return <>Not loaded yet</>

  return (
    <span title={at.toLocaleString()}>
      Updated {duration((Date.now() - at.getTime()) / 1000)} ago · figures are counted from this POS
    </span>
  )
}
