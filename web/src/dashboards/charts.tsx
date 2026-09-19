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

import { useId } from 'react'

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
  tableVisible = false,
  caption,
}: {
  points: SeriesPoint[]
  valueLabel: string
  comparisonLabel?: string | null
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
          line.map((p, i) => <circle key={i} className="pos-chart__point" cx={p.x} cy={p.y} r={2.5} />)}

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
 * A donut, for a whole split into a handful of named parts.
 *
 * Used where the WHOLE is the point — twelve of twenty tables — which a row of
 * bars states less directly. Drawn as one arc per slice with stroke-dasharray
 * rather than a conic-gradient, so the same code produces the accessible table
 * underneath and a zero-sized slice simply draws nothing instead of a hairline.
 *
 * The legend beside it carries the label and the figure for every slice, so
 * nothing here depends on telling two colours apart.
 */
export function DonutChart({
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
