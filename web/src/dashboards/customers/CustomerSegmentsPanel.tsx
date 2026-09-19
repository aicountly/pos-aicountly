/**
 * Who the identified customers are, as a ring.
 *
 * The segments and their definitions are the server's — the same three the
 * suggestions panel reasons about, counted by the same SQL, so a segment total
 * here and a follow-up below cannot disagree.
 *
 * Switching between revenue and customers changes what the ring measures, not
 * which segments exist. A segment with no spend still appears in the legend
 * with a zero rather than vanishing, because "nobody in this segment bought
 * anything" is worth seeing.
 */

import { DonutChart } from '../charts'
import { compactMoney, count, money, percent } from '../format'
import { Panel, Unavailable } from '../shell'
import type { CustomersBoard } from '../types'
import { SEGMENT_TONE, type SegmentMode } from './constants'

export function CustomerSegmentsPanel({
  board,
  mode,
  onMode,
}: {
  board: CustomersBoard
  mode: SegmentMode
  onMode: (mode: SegmentMode) => void
}) {
  const { segments } = board
  const byRevenue = mode === 'revenue'

  const totalSpend = segments.segments.reduce((sum, segment) => sum + segment.spend, 0)

  return (
    <Panel
      title="Customer segments"
      description={`${count(segments.total)} identified customers across this POS' whole history.`}
      action={
        <label className="cg-select">
          <span className="pos-visually-hidden">Measure segments by</span>
          <select value={mode} onChange={(e) => onMode(e.target.value as SegmentMode)}>
            <option value="revenue">By revenue</option>
            <option value="customers">By customers</option>
          </select>
        </label>
      }
    >
      {segments.total === 0 ? (
        <Unavailable muted title="No identified customers yet">
          Segments appear once bills start carrying a customer.
        </Unavailable>
      ) : (
        <DonutChart
          slices={segments.segments.map((segment) => ({
            key: segment.key,
            label: segment.label,
            value: byRevenue ? segment.spend : segment.customers,
            note: segment.definition,
            tone: SEGMENT_TONE[segment.key] ?? 'info',
          }))}
          format={(v) => (byRevenue ? money(v) : `${count(v)} customer${v === 1 ? '' : 's'}`)}
          centerValue={byRevenue ? compactMoney(totalSpend) : count(segments.total)}
          centerLabel={byRevenue ? 'Spend on this POS' : 'Identified customers'}
          caption={byRevenue ? 'Spend on this POS by segment' : 'Identified customers by segment'}
          emptyLabel={
            byRevenue
              ? 'These customers have no recorded spend on this POS yet.'
              : 'No customer falls into a segment yet.'
          }
        />
      )}
      <p className="pos-note">{segments.basis}</p>
    </Panel>
  )
}

/** Share of a total, for the one place the ring is not the right shape. */
export function segmentShare(value: number, total: number): string {
  return total > 0 ? percent((value / total) * 100, 0) : '—'
}
