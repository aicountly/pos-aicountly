/**
 * Three questions about the same window: how much is coming back, why, and
 * through which door.
 *
 * Every figure here was aggregated by PostgreSQL over the SAME filter as the
 * register below, so the charts and the table can never disagree. Nothing on
 * this row is estimated, interpolated or smoothed — a quiet day is a quiet day.
 *
 * When the window holds no returns at all, the panels say so instead of drawing
 * an empty axis. A chart of nothing looks like a chart of zero, and they are
 * different facts.
 */

import { ChartTable, ComboTrendChart, RingChart, type ComboPoint, type RingSlice } from '../dashboards/charts'
import { count, decimal, money, percent } from '../dashboards/format'
import { Panel } from '../dashboards/shell'
import { formatDay, formatRange, PERIODS, periodFor } from './periods'
import { CHANNEL_TERMS, CONDITION_TERMS, labelFor, REASON_TERMS, SLICE_COLOURS } from './vocabulary'
import type { ReturnsSummary } from './types'

/**
 * Money on a chart axis.
 *
 * Whole rupees, always: the shared `money()` shows paise below ₹1,000, which
 * put "₹0.00" at the foot of an axis whose top read "₹3,120".
 */
const AXIS_MONEY = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

function PanelSkeleton({ lines = 5 }: { lines?: number }) {
  return (
    <div className="returns-skeleton-stack" aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="returns-skeleton returns-skeleton--line" />
      ))}
    </div>
  )
}

/** The period control that sits in a panel header. */
function PeriodSelect({
  from,
  to,
  onChange,
}: {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
}) {
  const active = periodFor(from, to)

  return (
    <label className="returns-period">
      <span className="pos-visually-hidden">Period</span>
      <select
        value={active?.id ?? 'custom'}
        onChange={(event) => {
          const period = PERIODS.find((candidate) => candidate.id === event.target.value)
          if (period) onChange(period.range())
        }}
      >
        {PERIODS.map((period) => (
          <option key={period.id} value={period.id}>
            {period.label}
          </option>
        ))}
        {!active && <option value="custom">{formatRange(from, to)}</option>}
      </select>
    </label>
  )
}

function TrendPanel({
  summary,
  loading,
  onPeriod,
}: {
  summary: ReturnsSummary | null
  loading: boolean
  onPeriod: (range: { from: string; to: string }) => void
}) {
  const points: ComboPoint[] = (summary?.trend ?? []).map((point) => ({
    key: point.date,
    label: formatDay(point.date),
    bar: point.return_count,
    line: point.return_value,
    title: `${formatDay(point.date)}: ${count(point.return_count)} return${point.return_count === 1 ? '' : 's'}, ${money(point.return_value)}`,
  }))

  const hasActivity = points.some((point) => point.bar > 0)

  return (
    <Panel
      title="Returns trend"
      description={summary ? formatRange(summary.window.from, summary.window.to) : 'Loading the window…'}
      action={
        summary ? (
          <PeriodSelect from={summary.window.from} to={summary.window.to} onChange={onPeriod} />
        ) : undefined
      }
    >
      {loading || !summary ? (
        <PanelSkeleton lines={6} />
      ) : !hasActivity ? (
        <p className="pos-muted returns-quiet">
          Nothing came back between {formatRange(summary.window.from, summary.window.to)}. The chart is left off rather
          than drawn flat at zero.
        </p>
      ) : (
        <>
          <div className="returns-legend">
            <span className="returns-legend__item">
              <i className="returns-legend__dot returns-legend__dot--soft" aria-hidden /> Returns taken
            </span>
            <span className="returns-legend__item">
              <i className="returns-legend__dot returns-legend__dot--accent" aria-hidden /> Value credited (₹)
            </span>
          </div>

          <ComboTrendChart
            points={points}
            barLabel="Returns taken"
            lineLabel="Value credited"
            formatBar={(value) => count(Math.round(value))}
            formatLine={(value) => AXIS_MONEY.format(value)}
            caption={`Returns taken and value credited each day, ${formatRange(summary.window.from, summary.window.to)}`}
          />
        </>
      )}
    </Panel>
  )
}

/**
 * Why goods came back.
 *
 * "Not stated" is a slice like any other, and deliberately: a counter that is
 * not recording reasons is the most useful thing this panel can tell a manager,
 * and hiding it would turn 60% of the truth into a rounding error.
 */
function ReasonsPanel({
  summary,
  loading,
  onReason,
}: {
  summary: ReturnsSummary | null
  loading: boolean
  onReason: (code: string | null) => void
}) {
  const reasons = summary?.reasons ?? []
  const slices: RingSlice[] = reasons.slice(0, 6).map((reason, index) => ({
    key: reason.reason_code,
    label: labelFor(REASON_TERMS, reason.reason_code),
    value: reason.items,
    colour: SLICE_COLOURS[index % SLICE_COLOURS.length],
    display: `${decimal(reason.items, 2)} item${reason.items === 1 ? '' : 's'}`,
    share: reason.share_pc,
  }))

  return (
    <Panel title="Return reasons" description="By quantity of goods that came back">
      {loading || !summary ? (
        <PanelSkeleton />
      ) : reasons.length === 0 ? (
        <p className="pos-muted returns-quiet">No returns in this period, so there is nothing to attribute.</p>
      ) : (
        <div className="returns-reasons">
          <RingChart
            slices={slices}
            centreValue={decimal(summary.kpis.items_returned, 0)}
            centreLabel={summary.kpis.items_returned === 1 ? 'item' : 'items'}
            caption="Share of returned items by reason"
          />

          <ul className="returns-breakdown">
            {reasons.slice(0, 6).map((reason, index) => (
              <li key={reason.reason_code}>
                <button
                  type="button"
                  className="returns-breakdown__row"
                  onClick={() => onReason(reason.reason_code)}
                  title={`Show only returns recorded as ${labelFor(REASON_TERMS, reason.reason_code)}`}
                >
                  <span className="returns-breakdown__name">
                    <i
                      className="returns-breakdown__dot"
                      style={{ background: SLICE_COLOURS[index % SLICE_COLOURS.length] }}
                      aria-hidden
                    />
                    {labelFor(REASON_TERMS, reason.reason_code)}
                  </span>
                  <span className="returns-breakdown__figure num">
                    <strong>{percent(reason.share_pc, 0)}</strong>
                    <small>{count(reason.return_count)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {summary.conditions.length > 0 && (
            <div className="returns-conditions">
              <h3>Condition the goods came back in</h3>
              <ul>
                {summary.conditions.map((condition) => (
                  <li key={condition.condition_code}>
                    <span>{labelFor(CONDITION_TERMS, condition.condition_code)}</span>
                    <strong className="num">{percent(condition.share_pc, 0)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

/** Where the sale being returned was taken. The till's own order kinds, not a guess. */
function ChannelsPanel({
  summary,
  loading,
  onChannel,
}: {
  summary: ReturnsSummary | null
  loading: boolean
  onChannel: (channel: string | null) => void
}) {
  const channels = summary?.channels ?? []

  return (
    <Panel title="Return channels" description="Where the original sale was taken">
      {loading || !summary ? (
        <PanelSkeleton lines={4} />
      ) : channels.length === 0 ? (
        <p className="pos-muted returns-quiet">No returns in this period.</p>
      ) : (
        <>
          <ul className="returns-channels">
            {channels.map((channel, index) => (
              <li key={channel.channel}>
                <button
                  type="button"
                  className="returns-channel"
                  onClick={() => onChannel(channel.channel)}
                  title={`Show only returns against ${labelFor(CHANNEL_TERMS, channel.channel)} sales`}
                >
                  <span className="returns-channel__label">{labelFor(CHANNEL_TERMS, channel.channel)}</span>
                  <span className="returns-channel__track" aria-hidden>
                    <span
                      className="returns-channel__fill"
                      style={{
                        width: `${Math.max(channel.share_pc, channel.share_pc > 0 ? 2 : 0)}%`,
                        background: SLICE_COLOURS[index % SLICE_COLOURS.length],
                      }}
                    />
                  </span>
                  <strong className="returns-channel__count num">{count(channel.return_count)}</strong>
                  <span className="returns-channel__share num">{percent(channel.share_pc, 0)}</span>
                </button>
              </li>
            ))}
          </ul>

          <ChartTable
            visible={false}
            caption="Returns by the channel the original sale came through"
            columns={['Channel', 'Returns', 'Value', 'Share']}
            rows={channels.map((channel) => [
              labelFor(CHANNEL_TERMS, channel.channel),
              count(channel.return_count),
              money(channel.amount),
              percent(channel.share_pc, 0),
            ])}
          />
        </>
      )}
    </Panel>
  )
}

/**
 * One sentence about the window, and only when the data supports one.
 *
 * Both statements below are read straight off the same aggregates the panels
 * draw. Nothing is inferred, nothing is predicted, and when the window is too
 * thin to say anything the line is absent rather than hedged.
 */
export function ReturnsInsight({ summary }: { summary: ReturnsSummary | null }) {
  if (!summary || summary.kpis.total_returns === 0) return null

  const [top] = summary.reasons
  if (!top || top.share_pc < 15) return null

  const before = summary.comparison_reasons.find((reason) => reason.reason_code === top.reason_code)
  const label = labelFor(REASON_TERMS, top.reason_code)

  const movement =
    before && Math.abs(before.share_pc - top.share_pc) >= 3
      ? ` — ${before.share_pc < top.share_pc ? 'up' : 'down'} from ${percent(before.share_pc, 0)} in the previous ${summary.comparison_window.days} days`
      : ''

  if (top.reason_code === 'unspecified') {
    return (
      <p className="returns-insight" role="note">
        <strong>{percent(top.share_pc, 0)}</strong> of returned items carry no recorded reason{movement}. Reasons are
        captured on the new-return flow, and without them this panel cannot say why goods are coming back.
      </p>
    )
  }

  return (
    <p className="returns-insight" role="note">
      <strong>{label}</strong> accounts for {percent(top.share_pc, 0)} of returned items in this period{movement}.
    </p>
  )
}

export function ReturnsAnalytics({
  summary,
  loading,
  onPeriod,
  onReason,
  onChannel,
}: {
  summary: ReturnsSummary | null
  loading: boolean
  onPeriod: (range: { from: string; to: string }) => void
  onReason: (code: string | null) => void
  onChannel: (channel: string | null) => void
}) {
  return (
    <section className="returns-analytics" aria-label="Returns analytics">
      <div className="returns-analytics__trend">
        <TrendPanel summary={summary} loading={loading} onPeriod={onPeriod} />
      </div>
      <ReasonsPanel summary={summary} loading={loading} onReason={onReason} />
      <ChannelsPanel summary={summary} loading={loading} onChannel={onChannel} />
    </section>
  )
}
