/**
 * Charts, drawn as inline SVG.
 *
 * WHY NOT A CHART LIBRARY. This product had none, and every candidate is 50-150
 * kB of JavaScript on a till that is often a cheap Android tablet on shop
 * broadband. Four chart shapes are needed across the five boards and each is
 * twenty lines of path arithmetic, so the trade favours the arithmetic.
 *
 * ACCESSIBILITY IS NOT OPTIONAL HERE. An SVG is invisible to a screen reader and
 * unreadable to someone who cannot distinguish the series colours, so every
 * chart in this file renders the same numbers as a real <table> underneath it.
 * The table is the data; the picture is the summary. `tableVisible` decides
 * whether the table is on screen or only in the accessibility tree — it is never
 * absent.
 */

import { Fragment, useId, useState } from 'react'

export interface SeriesPoint {
  label: string
  value: number
  comparison?: number | null
}

function path(points: Array<{ x: number; y: number }>): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

/** Ticks that do not crowd: at most six labels however many points there are. */
function tickIndexes(length: number, max = 6): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i)
  const step = Math.ceil(length / max)

  return Array.from({ length }, (_, i) => i).filter((i) => i % step === 0 || i === length - 1)
}

/**
 * A line over time, optionally against a comparison window.
 *
 * The comparison line is dashed as well as grey, so the two series are still
 * distinguishable in greyscale and to a viewer who cannot separate the hues.
 */
export function TrendChart({
  points,
  valueLabel,
  comparisonLabel,
  format,
  height = 200,
  width = 640,
  tableVisible = false,
  caption,
}: {
  points: SeriesPoint[]
  valueLabel: string
  comparisonLabel?: string | null
  format: (value: number) => string
  height?: number
  /**
   * The viewBox width. The SVG is drawn with preserveAspectRatio="none" so it
   * fills its panel, which stretches the axis text by whatever the panel and
   * the viewBox differ by. 640 suits a full-width dashboard panel; a narrow
   * card passes something nearer its own width so the labels are not squeezed.
   */
  width?: number
  tableVisible?: boolean
  caption: string
}) {
  const titleId = useId()

  if (points.length === 0) {
    return <p className="pos-muted">Nothing to plot for this period.</p>
  }

  const pad = { top: 12, right: 12, bottom: 26, left: 52 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const hasComparison = points.some((p) => p.comparison !== null && p.comparison !== undefined)
  const values = points.flatMap((p) => [p.value, ...(hasComparison && p.comparison != null ? [p.comparison] : [])])
  const max = Math.max(1, ...values)

  const x = (i: number) => pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const y = (v: number) => pad.top + innerH - (v / max) * innerH

  const line = points.map((p, i) => ({ x: x(i), y: y(p.value) }))
  const area = `${path(line)} L${x(points.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`
  const comparisonLine = hasComparison
    ? path(points.map((p, i) => ({ x: x(i), y: y(p.comparison ?? 0) })))
    : null

  const ticks = tickIndexes(points.length)

  return (
    <div className="pos-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} preserveAspectRatio="none">
        <title id={titleId}>{caption}</title>

        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line className="pos-chart__grid" x1={pad.left} x2={width - pad.right} y1={y(max * f)} y2={y(max * f)} />
            <text className="pos-chart__axis" x={pad.left - 8} y={y(max * f) + 3} textAnchor="end">
              {format(max * f)}
            </text>
          </g>
        ))}

        <path className="pos-chart__area" d={area} />
        {comparisonLine && <path className="pos-chart__line pos-chart__line--comparison" d={comparisonLine} />}
        <path className="pos-chart__line" d={path(line)} />

        {points.length <= 32 &&
          line.map((p, i) => (
            <circle key={i} className="pos-chart__point" cx={p.x} cy={p.y} r={2.5}>
              {/* The browser's own tooltip. The table underneath is still the
                  data; this saves a reader crossing to it for one point. */}
              <title>
                {points[i].label}: {format(points[i].value)}
              </title>
            </circle>
          ))}

        {ticks.map((i) => (
          <text key={i} className="pos-chart__axis" x={x(i)} y={height - 8} textAnchor="middle">
            {points[i].label}
          </text>
        ))}
      </svg>

      <div className="pos-legend">
        <span className="pos-legend__item">
          <span className="pos-legend__swatch" aria-hidden /> {valueLabel}
        </span>
        {hasComparison && comparisonLabel && (
          <span className="pos-legend__item">
            <span className="pos-legend__swatch pos-legend__swatch--comparison" aria-hidden /> {comparisonLabel}
          </span>
        )}
      </div>

      <ChartTable
        visible={tableVisible}
        caption={caption}
        columns={[
          'Period',
          valueLabel,
          ...(hasComparison && comparisonLabel ? [comparisonLabel] : []),
        ]}
        rows={points.map((p) => [
          p.label,
          format(p.value),
          ...(hasComparison && comparisonLabel ? [p.comparison == null ? '—' : format(p.comparison)] : []),
        ])}
      />
    </div>
  )
}

/**
 * Bars for a categorical breakdown — sales by day, visits by recency.
 */
export function BarChart({
  points,
  valueLabel,
  format,
  height = 180,
  tableVisible = false,
  caption,
}: {
  points: SeriesPoint[]
  valueLabel: string
  format: (value: number) => string
  height?: number
  tableVisible?: boolean
  caption: string
}) {
  const titleId = useId()

  if (points.length === 0) {
    return <p className="pos-muted">Nothing to plot for this period.</p>
  }

  const width = 640
  const pad = { top: 10, right: 10, bottom: 26, left: 52 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(1, ...points.map((p) => p.value))
  const slot = innerW / points.length
  const barW = Math.max(3, Math.min(42, slot * 0.6))
  const ticks = tickIndexes(points.length)

  return (
    <div className="pos-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} preserveAspectRatio="none">
        <title id={titleId}>{caption}</title>

        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              className="pos-chart__grid"
              x1={pad.left}
              x2={width - pad.right}
              y1={pad.top + innerH - f * innerH}
              y2={pad.top + innerH - f * innerH}
            />
            <text className="pos-chart__axis" x={pad.left - 8} y={pad.top + innerH - f * innerH + 3} textAnchor="end">
              {format(max * f)}
            </text>
          </g>
        ))}

        {points.map((p, i) => {
          const h = (p.value / max) * innerH

          return (
            <rect
              key={p.label}
              className="pos-chart__bar"
              x={pad.left + i * slot + (slot - barW) / 2}
              y={pad.top + innerH - h}
              width={barW}
              height={Math.max(0, h)}
              rx={3}
            />
          )
        })}

        {ticks.map((i) => (
          <text key={i} className="pos-chart__axis" x={pad.left + i * slot + slot / 2} y={height - 8} textAnchor="middle">
            {points[i].label}
          </text>
        ))}
      </svg>

      <ChartTable
        visible={tableVisible}
        caption={caption}
        columns={['Period', valueLabel]}
        rows={points.map((p) => [p.label, format(p.value)])}
      />
    </div>
  )
}

/**
 * A ring over a FIXED set of named states, each with a colour of its own.
 *
 * Not the same chart as DonutChart below, and the difference is the reason
 * both exist:
 *
 *   DonutChart  a breakdown of whatever came back — payment methods, order
 *               channels — so it assigns tones in order, drops empty slices
 *               and prints its own legend table.
 *   StateDonut  a set that is known in advance and does not change. Table
 *               states carry the floor plan's own colours, so they cannot be
 *               assigned in arrival order, and a state with nothing in it
 *               STAYS IN THE LEGEND — "nothing is waiting to be cleared" is
 *               a fact a floor manager wants on the card, not an absence.
 *
 * Drawn as one arc per slice with stroke-dasharray rather than a
 * conic-gradient, so the same numbers produce the accessible table underneath
 * and a zero-sized slice draws nothing instead of a hairline.
 */
export function StateDonut({
  slices,
  centreValue,
  centreLabel,
  caption,
  format,
  tableVisible = false,
}: {
  slices: Array<{ key: string; label: string; value: number; colour: string }>
  centreValue: string
  centreLabel: string
  caption: string
  format: (value: number) => string
  tableVisible?: boolean
}) {
  const titleId = useId()
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)

  const radius = 54
  const circumference = 2 * Math.PI * radius
  let consumed = 0

  return (
    <div className="pos-chart pos-chart--donut">
      <svg viewBox="0 0 140 140" role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          {caption}: {slices.map((slice) => `${slice.label} ${format(slice.value)}`).join(', ')}
        </title>

        {/* The track. It is also the whole chart when nothing has been counted
            yet, which is why it is drawn unconditionally. */}
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#eef2ef" strokeWidth="16" />

        <g transform="rotate(-90 70 70)">
          {slices.map((slice) => {
            const value = Math.max(0, slice.value)
            if (total <= 0 || value <= 0) return null

            const length = (value / total) * circumference
            const offset = consumed
            consumed += length

            return (
              <circle
                key={slice.key}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={slice.colour}
                strokeWidth="16"
                strokeDasharray={`${length.toFixed(2)} ${(circumference - length).toFixed(2)}`}
                strokeDashoffset={(-offset).toFixed(2)}
              />
            )
          })}
        </g>

        <text x="70" y="68" textAnchor="middle" fontSize="19" fontWeight="800" fill="var(--pos-text)">
          {centreValue}
        </text>
        <text x="70" y="85" textAnchor="middle" fontSize="10" fill="var(--pos-muted)">
          {centreLabel}
        </text>
      </svg>

      <ChartTable
        visible={tableVisible}
        caption={caption}
        columns={['State', 'Count']}
        rows={slices.map((slice) => [slice.label, format(slice.value)])}
      />
    </div>
  )
}

export interface ShareRow {
  key: string
  label: string
  value: number
  /** A second line under the label — what the share actually means. */
  note?: string | null
  badge?: React.ReactNode
  tone?: 'brand' | 'muted' | 'warning'
  href?: string
}

/**
 * A share breakdown as labelled bars.
 *
 * Chosen over a pie or donut because the label, the figure and the share sit on
 * the same row and nothing depends on telling two wedge colours apart.
 */
export function ShareBars({
  rows,
  format,
  emptyLabel = 'Nothing recorded in this period.',
}: {
  rows: ShareRow[]
  format: (value: number) => string
  emptyLabel?: string
}) {
  if (rows.length === 0) return <p className="pos-muted">{emptyLabel}</p>

  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0)

  return (
    <div className="pos-bars">
      {rows.map((row) => {
        const share = total > 0 ? (Math.max(0, row.value) / total) * 100 : 0

        return (
          <div key={row.key}>
            <div className="pos-bar__head">
              <span style={{ minWidth: 0 }}>
                <strong>{row.label}</strong>
                {row.badge && <> {row.badge}</>}
                {row.note && <span className="pos-muted" style={{ display: 'block' }}>{row.note}</span>}
              </span>
              <span className="num" style={{ whiteSpace: 'nowrap' }}>
                {format(row.value)} · {share.toFixed(0)}%
              </span>
            </div>
            <div
              className="pos-bar__track"
              role="img"
              aria-label={`${row.label}: ${format(row.value)}, ${share.toFixed(0)} percent of the total`}
            >
              <div
                className={`pos-bar__fill${row.tone === 'muted' ? ' pos-bar__fill--muted' : row.tone === 'warning' ? ' pos-bar__fill--warning' : ''}`}
                style={{ width: `${Math.max(share, share > 0 ? 2 : 0)}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The table every chart carries.
 *
 * Hidden visually by default and present in the accessibility tree always — a
 * chart whose only representation is a picture is a chart some of the shop's
 * managers cannot read.
 */
export function ChartTable({
  visible,
  caption,
  columns,
  rows,
}: {
  visible: boolean
  caption: string
  columns: string[]
  rows: string[][]
}) {
  return (
    <div className={visible ? 'pos-table-wrap' : 'pos-visually-hidden'} style={visible ? { marginTop: 14 } : undefined}>
      <table className="pos-table">
        <caption>{caption} — the same figures as a table</caption>
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th key={column} scope="col" className={i === 0 ? undefined : 'is-number'}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                <td key={i} className={i === 0 ? undefined : 'is-number'}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A target dial.
 *
 * Only rendered where a real target exists; the caller decides that, because a
 * dial against an invented target is worse than no dial.
 */
export function ProgressRing({
  achieved,
  target,
  format,
  label,
}: {
  achieved: number
  target: number
  format: (value: number) => string
  label: string
}) {
  const titleId = useId()
  const pc = target > 0 ? Math.min(100, (achieved / target) * 100) : 0
  const radius = 54
  const circumference = 2 * Math.PI * radius

  return (
    <div className="pos-chart pos-chart--figure">
      <svg viewBox="0 0 140 140" role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          {label}: {format(achieved)} of {format(target)}, {pc.toFixed(0)} percent
        </title>
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#eef2ef" strokeWidth="14" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="var(--pos-brand)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${(pc / 100) * circumference} ${circumference}`}
          transform="rotate(-90 70 70)"
        />
        <text x="70" y="66" textAnchor="middle" fontSize="24" fontWeight="700" fill="var(--pos-text)">
          {pc.toFixed(0)}%
        </text>
        <text x="70" y="86" textAnchor="middle" fontSize="10" fill="var(--pos-muted)">
          of {format(target)}
        </text>
      </svg>
    </div>
  )
}

/* ===========================================================================
   The Business Overview shapes
   ===========================================================================

   Four more pictures, same rules as the four above: inline SVG or CSS grid, no
   library, and nothing that is only a picture.

   A SPARKLINE IS THE ONE EXCEPTION TO THE TABLE RULE, and deliberately. A KPI
   card already states its figure and its movement in words directly above the
   line; a second table of twelve hourly values under every card would bury the
   five numbers the card exists to show. So a sparkline carries an aria-label
   that summarises the shape — where it started, where it ended, where it peaked
   — and nothing that is not also said in text beside it. The full series is on
   the Sales Trend card, with its table, a few hundred pixels below.
   =========================================================================== */

/** The shape of a KPI's recent history. Decoration with a summary, not a data view. */
export function Sparkline({
  values,
  tone = 'brand',
  format,
  label,
  height = 34,
}: {
  values: number[]
  tone?: 'brand' | 'info' | 'danger'
  format: (value: number) => string
  label: string
  height?: number
}) {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length < 2) return null

  const width = 120
  const pad = 3
  const max = Math.max(...usable)
  const min = Math.min(...usable)
  const span = max - min || 1

  const x = (i: number) => pad + (i / (usable.length - 1)) * (width - pad * 2)
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2)

  const line = usable.map((v, i) => ({ x: x(i), y: y(v) }))
  const d = path(line)
  const area = `${d} L${x(usable.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`
  const last = line[line.length - 1]

  return (
    <svg
      className={`pos-spark pos-spark--${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${format(usable[0])} to ${format(usable[usable.length - 1])}, highest ${format(max)}`}
    >
      <path className="pos-spark__area" d={area} />
      <path className="pos-spark__line" d={d} />
      <circle className="pos-spark__tip" cx={last.x} cy={last.y} r={2.4} />
    </svg>
  )
}

/** The same idea in bars, for a count rather than a value. */
export function SparkBars({
  values,
  tone = 'brand',
  format,
  label,
  height = 34,
}: {
  values: number[]
  tone?: 'brand' | 'info' | 'danger'
  format: (value: number) => string
  label: string
  height?: number
}) {
  const usable = values.filter((v) => Number.isFinite(v))
  if (usable.length < 2) return null

  const width = 120
  const max = Math.max(1, ...usable)
  const slot = width / usable.length
  const barW = Math.max(1.5, slot * 0.62)

  return (
    <svg
      className={`pos-spark pos-spark--${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${usable.length} periods, highest ${format(max)}`}
    >
      {usable.map((v, i) => {
        const h = Math.max(v > 0 ? 1.5 : 0, (v / max) * (height - 2))

        return (
          <rect
            key={i}
            className="pos-spark__bar"
            x={i * slot + (slot - barW) / 2}
            y={height - h}
            width={barW}
            height={h}
            rx={1}
          />
        )
      })}
    </svg>
  )
}

export interface ColumnPoint extends SeriesPoint {
  /** The second line of the tooltip — "32 bills" under "₹6,320". */
  secondary?: string
  /** The heading of the tooltip, when the axis label is too terse to stand alone. */
  tooltipLabel?: string
}

/**
 * The trend card's bars, with a readable bar under the pointer.
 *
 * THE HIGHLIGHT IS REACHABLE FROM THE KEYBOARD. The chart itself takes focus
 * and the arrow keys walk the bars, announcing each through a live region —
 * because a tooltip that only a mouse can open is a tooltip half the shop
 * cannot use. Everything the tooltip says is also in the table underneath, so a
 * screen reader gets the whole series either way.
 */
export function ColumnChart({
  points,
  valueLabel,
  format,
  height = 236,
  caption,
  comparisonLabel,
}: {
  points: ColumnPoint[]
  valueLabel: string
  format: (value: number) => string
  height?: number
  caption: string
  comparisonLabel?: string | null
}) {
  const titleId = useId()
  const [active, setActive] = useState<number | null>(null)

  if (points.length === 0) {
    return <p className="pos-muted">Nothing to plot for this period.</p>
  }

  const width = 640
  const pad = { top: 16, right: 10, bottom: 28, left: 54 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const hasComparison = points.some((p) => p.comparison !== null && p.comparison !== undefined)
  const max = Math.max(
    1,
    ...points.map((p) => Math.max(p.value, hasComparison ? (p.comparison ?? 0) : 0)),
  )

  const slot = innerW / points.length
  const barW = Math.max(4, Math.min(34, slot * 0.54))
  const ticks = tickIndexes(points.length, 9)
  const shown = active === null ? null : points[active]

  const move = (delta: number) =>
    setActive((current) => {
      const next = current === null ? (delta > 0 ? 0 : points.length - 1) : current + delta

      return Math.max(0, Math.min(points.length - 1, next))
    })

  return (
    <div className="pos-chart pos-chart--interactive">
      <div className="pos-chart__plot">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={titleId}
          preserveAspectRatio="none"
          tabIndex={0}
          className="pos-chart__svg--focusable"
          onMouseLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'Escape') {
              setActive(null)
            }
          }}
        >
          <title id={titleId}>{caption}. Use the arrow keys to read each period.</title>

          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line
                className="pos-chart__grid"
                x1={pad.left}
                x2={width - pad.right}
                y1={pad.top + innerH - f * innerH}
                y2={pad.top + innerH - f * innerH}
              />
              <text
                className="pos-chart__axis"
                x={pad.left - 8}
                y={pad.top + innerH - f * innerH + 3}
                textAnchor="end"
              >
                {format(max * f)}
              </text>
            </g>
          ))}

          {points.map((point, i) => {
            const h = (point.value / max) * innerH
            const left = pad.left + i * slot

            return (
              <g key={point.label} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)}>
                {/* A full-height target, so the pointer finds a short bar too. */}
                <rect
                  className="pos-chart__hit"
                  x={left}
                  y={pad.top}
                  width={slot}
                  height={innerH}
                  data-active={active === i ? 'true' : undefined}
                />
                <rect
                  className="pos-chart__bar"
                  data-active={active === i ? 'true' : undefined}
                  x={left + (slot - barW) / 2}
                  y={pad.top + innerH - h}
                  width={barW}
                  height={Math.max(0, h)}
                  rx={4}
                />
                {hasComparison && point.comparison != null && (
                  /* Wider than the bar and overhanging it, so it reads as a
                     line drawn ACROSS the bar rather than a cap on top of it. */
                  <rect
                    className="pos-chart__bar--comparison"
                    x={left + (slot - barW) / 2 - 3}
                    y={pad.top + innerH - (point.comparison / max) * innerH - 1}
                    width={barW + 6}
                    height={2.5}
                    rx={1.25}
                  />
                )}
              </g>
            )
          })}

          {ticks.map((i) => (
            <text
              key={i}
              className="pos-chart__axis"
              x={pad.left + i * slot + slot / 2}
              y={height - 8}
              textAnchor="middle"
            >
              {points[i].label}
            </text>
          ))}
        </svg>

        {shown && (
          <div
            className="pos-chart__tooltip"
            style={{ left: `${((pad.left + (active ?? 0) * slot + slot / 2) / width) * 100}%` }}
          >
            <strong>{shown.tooltipLabel ?? shown.label}</strong>
            <span>{format(shown.value)}</span>
            {shown.secondary && <small>{shown.secondary}</small>}
          </div>
        )}
      </div>

      {/* What the pointer reveals, said out loud for anyone driving by keyboard. */}
      <p className="pos-visually-hidden" role="status" aria-live="polite">
        {shown ? `${shown.tooltipLabel ?? shown.label}: ${format(shown.value)}${shown.secondary ? `, ${shown.secondary}` : ''}` : ''}
      </p>

      {hasComparison && comparisonLabel && (
        <div className="pos-legend">
          <span className="pos-legend__item">
            <span className="pos-legend__swatch pos-legend__swatch--square" aria-hidden /> {valueLabel}
          </span>
          <span className="pos-legend__item">
            <span className="pos-legend__swatch pos-legend__swatch--rule" aria-hidden /> {comparisonLabel}
          </span>
        </div>
      )}

      <ChartTable
        visible={false}
        caption={caption}
        columns={['Period', valueLabel, ...(hasComparison && comparisonLabel ? [comparisonLabel] : [])]}
        rows={points.map((p) => [
          p.label,
          format(p.value),
          ...(hasComparison && comparisonLabel ? [p.comparison == null ? '—' : format(p.comparison)] : []),
        ])}
      />
    </div>
  )
}

export interface DonutSlice {
  key: string
  label: string
  value: number
  /** A second line under the label in the legend. */
  note?: string | null
}

const DONUT_TONES = ['a', 'b', 'c', 'd', 'e', 'f'] as const

/**
 * The tender mix as a ring, with the legend doing the real work.
 *
 * Every slice is named, valued and given its share IN THE LEGEND, which is a
 * real table. The ring is the summary. Nothing here depends on telling two
 * wedge colours apart — six tones are used but the legend swatch sits directly
 * beside its own row, so the colour never has to be matched across the card.
 */
export function DonutChart({
  slices,
  format,
  centreLabel,
  emptyLabel = 'Nothing recorded in this period.',
  caption,
}: {
  slices: DonutSlice[]
  format: (value: number) => string
  centreLabel: string
  emptyLabel?: string
  caption: string
}) {
  const titleId = useId()
  const usable = slices.filter((slice) => slice.value > 0)
  const total = usable.reduce((sum, slice) => sum + slice.value, 0)

  if (usable.length === 0 || total <= 0) return <p className="pos-muted">{emptyLabel}</p>

  const size = 150
  const centre = size / 2
  const radius = 58
  const stroke = 22
  const circumference = 2 * Math.PI * radius

  let offset = 0
  const arcs = usable.map((slice, i) => {
    const share = slice.value / total
    const arc = { slice, share, dash: share * circumference, offset, tone: DONUT_TONES[i % DONUT_TONES.length] }
    offset += arc.dash

    return arc
  })

  return (
    <div className="pos-donut">
      <div className="pos-donut__ring">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId}>
          <title id={titleId}>{caption}</title>
          <circle cx={centre} cy={centre} r={radius} fill="none" stroke="#eef2ef" strokeWidth={stroke} />
          {arcs.map((arc) => (
            <circle
              key={arc.slice.key}
              className={`pos-donut__arc pos-donut__arc--${arc.tone}`}
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${arc.dash.toFixed(2)} ${(circumference - arc.dash).toFixed(2)}`}
              strokeDashoffset={(-arc.offset).toFixed(2)}
              transform={`rotate(-90 ${centre} ${centre})`}
            />
          ))}
          <text className="pos-donut__total" x={centre} y={centre - 1} textAnchor="middle">
            {format(total)}
          </text>
          <text className="pos-donut__caption" x={centre} y={centre + 15} textAnchor="middle">
            {centreLabel}
          </text>
        </svg>
      </div>

      <div className="pos-table-wrap">
        <table className="pos-table pos-table--bare">
          <caption className="pos-visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col" className="is-number">Share</th>
              <th scope="col" className="is-number">Value</th>
            </tr>
          </thead>
          <tbody>
            {arcs.map((arc) => (
              <tr key={arc.slice.key}>
                <th scope="row">
                  <span className={`pos-donut__swatch pos-donut__swatch--${arc.tone}`} aria-hidden />
                  {arc.slice.label}
                  {arc.slice.note && <span className="pos-muted pos-donut__note">{arc.slice.note}</span>}
                </th>
                <td className="is-number">{(arc.share * 100).toFixed(1)}%</td>
                <td className="is-number">{format(arc.slice.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export interface HeatCell {
  row: number
  column: number
  value: number
  /** The whole story for this cell, for the title and the accessible name. */
  description: string
}

/**
 * When the shop is busy, as a grid.
 *
 * CSS rather than SVG: it is a table of small rectangles, which is what a grid
 * of divs already is, and it reflows on a phone without any viewBox arithmetic.
 * Six steps of green, and each cell carries its own figures as text — the
 * shade is the summary and never the only way to read a cell.
 */
export function Heatmap({
  rowLabels,
  columnLabels,
  cells,
  caption,
  valueLabel,
  format,
  onCell,
}: {
  rowLabels: string[]
  columnLabels: string[]
  cells: HeatCell[]
  caption: string
  valueLabel: string
  format: (value: number) => string
  onCell?: (cell: HeatCell) => void
}) {
  const max = Math.max(0, ...cells.map((cell) => cell.value))
  const at = new Map(cells.map((cell) => [`${cell.row}:${cell.column}`, cell]))

  // Six steps, so a busy hour and a very busy hour are not the same green. A
  // cell with nothing in it is level 0 and looks like the background it is.
  const level = (value: number) => (max <= 0 || value <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * 5)))

  return (
    <div className="pos-heat">
      <div
        className="pos-heat__grid"
        style={{ gridTemplateColumns: `auto repeat(${columnLabels.length}, minmax(0, 1fr))` }}
        role="presentation"
      >
        <span aria-hidden />
        {columnLabels.map((label) => (
          <span key={label} className="pos-heat__col" aria-hidden>
            {label}
          </span>
        ))}

        {rowLabels.map((rowLabel, row) => (
          <Fragment key={rowLabel}>
            <span className="pos-heat__row" aria-hidden>
              {rowLabel}
            </span>
            {columnLabels.map((columnLabel, column) => {
              const cell = at.get(`${row}:${column}`)
              const value = cell?.value ?? 0
              const description = cell?.description ?? `${rowLabel}, ${columnLabel}: nothing`

              if (!onCell) {
                return (
                  <span
                    key={columnLabel}
                    className="pos-heat__cell"
                    data-level={level(value)}
                    title={description}
                    role="img"
                    aria-label={description}
                  />
                )
              }

              return (
                <button
                  key={columnLabel}
                  type="button"
                  className="pos-heat__cell pos-heat__cell--action"
                  data-level={level(value)}
                  title={description}
                  aria-label={description}
                  onClick={() => cell && onCell(cell)}
                  disabled={!cell}
                />
              )
            })}
          </Fragment>
        ))}
      </div>

      <div className="pos-heat__scale" aria-hidden>
        <span>Quiet</span>
        {[0, 1, 2, 3, 4, 5].map((step) => (
          <span key={step} className="pos-heat__cell pos-heat__cell--legend" data-level={step} />
        ))}
        <span>Busiest {max > 0 ? `· ${format(max)}` : ''}</span>
      </div>

      <ChartTable
        visible={false}
        caption={caption}
        columns={['Period', valueLabel]}
        rows={cells.filter((cell) => cell.value > 0).map((cell) => [cell.description, format(cell.value)])}
      />
    </div>
  )
}

export interface ComboPoint {
  key: string
  label: string
  /** The column — a count. */
  bar: number
  /** The line — a value. */
  line: number
  /** What a hover should say, in full. */
  title: string
}

/**
 * Columns and a line over the same days, on two scales.
 *
 * A count and a rupee total share an axis only by coincidence, so they get one
 * each — left for the columns, right for the line — and each axis is labelled
 * in the units it is in. Without that, twelve returns and twelve thousand
 * rupees plot as the same height and the chart is decoration.
 */
export function ComboTrendChart({
  points,
  barLabel,
  lineLabel,
  formatBar,
  formatLine,
  height = 230,
  tableVisible = false,
  caption,
}: {
  points: ComboPoint[]
  barLabel: string
  lineLabel: string
  formatBar: (value: number) => string
  formatLine: (value: number) => string
  height?: number
  tableVisible?: boolean
  caption: string
}) {
  const titleId = useId()

  if (points.length === 0) {
    return <p className="pos-muted">Nothing to plot for this period.</p>
  }

  const width = 680
  const pad = { top: 14, right: 54, bottom: 26, left: 46 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const maxBar = Math.max(1, ...points.map((p) => p.bar))
  const maxLine = Math.max(1, ...points.map((p) => p.line))

  const slot = innerW / points.length
  const barW = Math.max(2, Math.min(26, slot * 0.52))
  const centre = (i: number) => pad.left + i * slot + slot / 2
  const lineY = (value: number) => pad.top + innerH - (value / maxLine) * innerH
  const ticks = tickIndexes(points.length)

  const linePoints = points.map((p, i) => ({ x: centre(i), y: lineY(p.line) }))

  return (
    <div className="pos-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} preserveAspectRatio="none">
        <title id={titleId}>{caption}</title>

        {[0, 0.5, 1].map((fraction) => {
          const y = pad.top + innerH - fraction * innerH

          return (
            <g key={fraction}>
              <line className="pos-chart__grid" x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
              <text className="pos-chart__axis" x={pad.left - 8} y={y + 3} textAnchor="end">
                {formatBar(maxBar * fraction)}
              </text>
              <text className="pos-chart__axis" x={width - pad.right + 8} y={y + 3} textAnchor="start">
                {formatLine(maxLine * fraction)}
              </text>
            </g>
          )
        })}

        {points.map((point, i) => {
          const barH = (point.bar / maxBar) * innerH

          return (
            <rect
              key={point.key}
              className="pos-chart__bar pos-chart__bar--soft"
              x={centre(i) - barW / 2}
              y={pad.top + innerH - barH}
              width={barW}
              height={Math.max(0, barH)}
              rx={3}
            >
              <title>{point.title}</title>
            </rect>
          )
        })}

        <path className="pos-chart__line pos-chart__line--accent" d={path(linePoints)} />

        {points.length <= 40 &&
          linePoints.map((p, i) => (
            <circle key={points[i].key} className="pos-chart__point pos-chart__point--accent" cx={p.x} cy={p.y} r={2.5}>
              <title>{points[i].title}</title>
            </circle>
          ))}

        {ticks.map((i) => (
          <text key={points[i].key} className="pos-chart__axis" x={centre(i)} y={height - 8} textAnchor="middle">
            {points[i].label}
          </text>
        ))}
      </svg>

      <ChartTable
        visible={tableVisible}
        caption={caption}
        columns={['Day', barLabel, lineLabel]}
        rows={points.map((p) => [p.label, formatBar(p.bar), formatLine(p.line)])}
      />
    </div>
  )
}

export interface RingSlice {
  key: string
  label: string
  value: number
  colour: string
  /** The figure to print beside the label, already formatted. */
  display: string
  share: number
}

/**
 * A share, as a bare ring with a figure in the middle.
 *
 * NOT DonutChart, which is above and does a different job: that one owns its
 * own legend table and is complete on its own. This one draws the ring and
 * nothing else, because the register's legend rows are buttons that narrow the
 * table, and a component that renders its own legend cannot make them that.
 * The two could share their arc arithmetic; until they do, changing one does
 * not change the other.
 *
 * A share, as a ring with the total in the middle.
 *
 * The ring is the summary; the list beside it is the data. Nothing here depends
 * on telling two colours apart — every slice has its label, its figure and its
 * share written next to it, and the table underneath carries all three for a
 * screen reader.
 */
export function RingChart({
  slices,
  centreValue,
  centreLabel,
  caption,
  tableVisible = false,
}: {
  slices: RingSlice[]
  centreValue: string
  centreLabel: string
  caption: string
  tableVisible?: boolean
}) {
  const titleId = useId()
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)

  const radius = 56
  const circumference = 2 * Math.PI * radius
  let consumed = 0

  return (
    <div className="pos-ring">
      <svg viewBox="0 0 140 140" role="img" aria-labelledby={titleId} className="pos-ring__svg">
        <title id={titleId}>{caption}</title>
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#eef2ef" strokeWidth="17" />

        {total > 0 &&
          slices.map((slice) => {
            const length = (Math.max(0, slice.value) / total) * circumference
            const offset = -consumed
            consumed += length

            return (
              <circle
                key={slice.key}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={slice.colour}
                strokeWidth="17"
                strokeDasharray={`${length.toFixed(2)} ${(circumference - length).toFixed(2)}`}
                strokeDashoffset={offset.toFixed(2)}
                transform="rotate(-90 70 70)"
              >
                <title>{`${slice.label}: ${slice.display} (${slice.share.toFixed(0)}%)`}</title>
              </circle>
            )
          })}

        <text className="pos-ring__figure" x="70" y="68" textAnchor="middle">
          {centreValue}
        </text>
        <text className="pos-ring__caption" x="70" y="86" textAnchor="middle">
          {centreLabel}
        </text>
      </svg>

      <ChartTable
        visible={tableVisible}
        caption={caption}
        columns={['Category', 'Figure', 'Share']}
        rows={slices.map((slice) => [slice.label, slice.display, `${slice.share.toFixed(1)}%`])}
      />
    </div>
  )
}
