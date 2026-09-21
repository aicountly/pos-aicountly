/**
 * The three charts this screen draws, as inline SVG.
 *
 * WHY NOT A CHART LIBRARY. The product has none, and every candidate is
 * 50–150 kB of JavaScript on a till that is often a cheap Android tablet on
 * shop broadband. Three shapes are needed here and each is twenty lines of
 * path arithmetic, so the trade favours the arithmetic — the same call the
 * dashboards made, and these reuse their accessible table.
 *
 * ACCESSIBILITY IS NOT OPTIONAL. An SVG is invisible to a screen reader and
 * unreadable to someone who cannot separate the series colours, so every chart
 * here renders the same numbers as a real <table> underneath it. The table is
 * the data; the picture is the summary. It is hidden to the eye and present in
 * the accessibility tree — and on paper it is what prints, because a colour
 * chart photocopied in greyscale is not a report.
 */

import { useCallback, useId, useRef, useState } from 'react'
import { ChartTable } from '../../dashboards/charts'

/**
 * The categorical slots, in fixed order, never cycled.
 *
 * Validated for protanopia and deuteranopia separation against a white card
 * rather than chosen by eye. A ninth series folds into "Other" in grey — it is
 * never a ninth generated hue, because the order IS the colour-blindness
 * safety mechanism and a hue outside it has not been checked against anything.
 */
export const SERIES = [
  'var(--shift-series-1)',
  'var(--shift-series-2)',
  'var(--shift-series-3)',
  'var(--shift-series-4)',
  'var(--shift-series-5)',
  'var(--shift-series-6)',
  'var(--shift-series-7)',
  'var(--shift-series-8)',
] as const

export const SERIES_OTHER = 'var(--shift-series-other)'

export function seriesColour(index: number): string {
  return index < SERIES.length ? SERIES[index] : SERIES_OTHER
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

/**
 * The shape of a metric across the shift, beside the metric.
 *
 * Decoration, and marked as such: the card already states the value, the change
 * and what it is compared with, in words. A reader who cannot see this loses
 * nothing, which is the only honest way to ship a 62px chart with no axis.
 */
export function Sparkline({ points, tone = 'good' }: { points: number[]; tone?: 'good' | 'bad' | 'flat' }) {
  if (points.length < 2) return null

  const width = 62
  const height = 26
  const pad = 3
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1

  const x = (i: number) => (i / (points.length - 1)) * width
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2)

  const line = points.map((value, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(' ')
  const stroke =
    tone === 'bad' ? 'var(--danger, #aa2929)' : tone === 'flat' ? 'var(--pos-muted, #5e6e64)' : 'var(--shift-series-1)'

  return (
    <svg className="shift-kpi__spark" viewBox={`0 0 ${width} ${height}`} aria-hidden focusable="false">
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={stroke} opacity={0.1} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r={2.4} fill={stroke} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------

export interface DonutSlice {
  key: string
  label: string
  value: number
  colour: string
}

/**
 * The payment mix.
 *
 * A donut rather than bars for one reason: the question is "what share of the
 * money was cash", and a ring answers a part-to-whole question at a glance. The
 * legend beside it carries the label, the share and the amount, so nothing on
 * this card depends on telling two arcs apart — and a 2px gap in the surface
 * colour separates the arcs rather than a stroke around each one.
 */
export function DonutChart({
  slices,
  centreValue,
  centreLabel,
  caption,
  formatValue,
}: {
  slices: DonutSlice[]
  centreValue: string
  centreLabel: string
  caption: string
  formatValue: (value: number) => string
}) {
  const titleId = useId()
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)

  if (slices.length === 0 || total <= 0) {
    return <p className="shift-card__note">Nothing was taken on this shift yet.</p>
  }

  const size = 124
  const stroke = 21
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  // One gap width for every boundary, and none at all when there is only one
  // arc — a ring with a notch in it reads as missing data.
  const gap = slices.length > 1 ? 2 : 0

  let travelled = 0

  return (
    <>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId} focusable="false">
        <title id={titleId}>{caption}</title>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((slice) => {
            const length = (Math.max(0, slice.value) / total) * circumference
            const drawn = Math.max(0, length - gap)
            const offset = -travelled
            travelled += length

            return (
              <circle
                key={slice.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={slice.colour}
                strokeWidth={stroke}
                strokeDasharray={`${drawn.toFixed(2)} ${(circumference - drawn).toFixed(2)}`}
                strokeDashoffset={offset.toFixed(2)}
              />
            )
          })}
        </g>

        <text
          x={size / 2}
          y={size / 2 - 1}
          textAnchor="middle"
          fontSize="15"
          fontWeight="700"
          fill="var(--pos-text, #17251d)"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {centreValue}
        </text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontSize="9.5" fill="var(--pos-muted, #5e6e64)">
          {centreLabel}
        </text>
      </svg>

      <ChartTable
        visible={false}
        caption={caption}
        columns={['Method', 'Amount', 'Share']}
        rows={slices.map((slice) => [
          slice.label,
          formatValue(slice.value),
          `${((Math.max(0, slice.value) / total) * 100).toFixed(1)}%`,
        ])}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export interface TrendPoint {
  key: string
  label: string
  value: number
}

/**
 * Sales through the shift, with a crosshair.
 *
 * THE CROSSHAIR FINDS THE X. A reader aims at an hour, never at a 2px line, so
 * the pointer snaps to the nearest hour rather than requiring a hit on the
 * stroke. Keyboard gets the same readout from the same code: the chart is
 * focusable and the arrow keys walk the hours, because a tooltip only a mouse
 * can reach is a tooltip half the shop cannot use.
 *
 * The tooltip only ever ENHANCES. Every figure in it is also in the table
 * underneath, so nothing is gated behind hovering.
 */
export function TrendChart({
  points,
  valueLabel,
  caption,
  formatValue,
  formatAxis,
}: {
  points: TrendPoint[]
  valueLabel: string
  caption: string
  formatValue: (value: number) => string
  formatAxis: (value: number) => string
}) {
  const titleId = useId()
  const frame = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState<number | null>(null)

  const width = 620
  const height = 186
  const pad = { top: 14, right: 12, bottom: 26, left: 52 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const at = useCallback(
    (clientX: number) => {
      const box = frame.current?.getBoundingClientRect()
      if (!box || box.width === 0 || points.length === 0) return null

      // Pointer → viewBox → nearest point. The chart scales with the card, so
      // the ratio has to come from the rendered box rather than the viewBox.
      const ratio = (clientX - box.left) / box.width
      const inner = (ratio * width - pad.left) / innerW

      return Math.max(0, Math.min(points.length - 1, Math.round(inner * Math.max(1, points.length - 1))))
    },
    [innerW, points.length],
  )

  if (points.length === 0) {
    return <p className="shift-card__note">No hours to plot for this shift yet.</p>
  }

  const values = points.map((point) => point.value)
  const max = Math.max(1, ...values)

  const x = (i: number) => pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const y = (value: number) => pad.top + innerH - (Math.max(0, value) / max) * innerH

  const line = points.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`

  // At most six labels however many hours there are, or they collide.
  const step = Math.max(1, Math.ceil(points.length / 6))
  const ticks = points.map((_, i) => i).filter((i) => i % step === 0 || i === points.length - 1)

  const current = active === null ? null : points[active]

  return (
    <>
      <div
        className="shift-trend"
        ref={frame}
        onPointerMove={(event) => setActive(at(event.clientX))}
        onPointerLeave={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onFocus={() => setActive((value) => value ?? points.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setActive((value) => {
              const from = value ?? points.length - 1
              const next = event.key === 'ArrowLeft' ? from - 1 : from + 1

              return Math.max(0, Math.min(points.length - 1, next))
            })
          }}
        >
          <title id={titleId}>{caption}</title>

          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line
                className="shift-trend__grid"
                x1={pad.left}
                x2={width - pad.right}
                y1={y(max * fraction)}
                y2={y(max * fraction)}
              />
              <text className="shift-trend__axis" x={pad.left - 8} y={y(max * fraction) + 3} textAnchor="end">
                {formatAxis(max * fraction)}
              </text>
            </g>
          ))}

          <path className="shift-trend__area" d={area} />
          <path className="shift-trend__line" d={line} />

          {ticks.map((i) => (
            <text key={i} className="shift-trend__axis" x={x(i)} y={height - 8} textAnchor="middle">
              {points[i].label}
            </text>
          ))}

          {active !== null && (
            <>
              <line className="shift-trend__cross" x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + innerH} />
              <circle className="shift-trend__dot" cx={x(active)} cy={y(points[active].value)} r={4.5} />
            </>
          )}
        </svg>

        {current && (
          <div
            className="shift-tooltip"
            style={{
              left: `${(x(active ?? 0) / width) * 100}%`,
              top: `${(Math.max(pad.top, y(current.value) - 12) / height) * 100}%`,
            }}
          >
            <small>{current.label}</small>
            <strong>{formatValue(current.value)}</strong>
          </div>
        )}
      </div>

      <p className="pos-visually-hidden" aria-live="polite">
        {current ? `${current.label}: ${formatValue(current.value)}` : ''}
      </p>

      <ChartTable
        visible={false}
        caption={caption}
        columns={['Hour', valueLabel]}
        rows={points.map((point) => [point.label, formatValue(point.value)])}
      />
    </>
  )
}
