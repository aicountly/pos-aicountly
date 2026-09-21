/**
 * The strip under the plan: what the colours mean, and how big the room is
 * drawn.
 *
 * The legend is not only a key — each entry is a filter, because the question
 * "which tables need cleaning" is asked far more often than it is answered by
 * squinting at the plan.
 */

import { Maximize2 } from 'lucide-react'
import type { TableStatus } from '../../services/types'
import { STATUS_ORDER, statusOf, type Occupancy } from './status'

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 1.5
export const ZOOM_STEP = 0.1

export function FloorLegend({
  counts,
  active,
  onToggle,
  zoom,
  onZoom,
  onFit,
}: {
  counts: Occupancy
  active: TableStatus | null
  onToggle: (status: TableStatus | null) => void
  zoom: number
  onZoom: (zoom: number) => void
  onFit: () => void
}) {
  const countFor = (status: TableStatus): number =>
    status === 'FREE'
      ? counts.available
      : status === 'OCCUPIED'
        ? counts.occupied
        : status === 'RESERVED'
          ? counts.reserved
          : status === 'CLEANING'
            ? counts.cleaning
            : counts.outOfService

  return (
    <footer className="floor-foot">
      <div className="floor-legend" role="group" aria-label="Filter by status">
        {STATUS_ORDER.map((status) => {
          const config = statusOf(status)

          return (
            <button
              key={status}
              type="button"
              className="floor-legend__item"
              aria-pressed={active === status}
              onClick={() => onToggle(active === status ? null : status)}
              title={`Show only tables that are ${config.sentence}`}
            >
              <i className={`floor-legend__dot floor-legend__dot--${config.modifier}`} aria-hidden />
              {config.label}
              <span className="num" style={{ fontWeight: 700 }}>
                {countFor(status)}
              </span>
            </button>
          )
        })}
      </div>

      <div className="floor-zoom">
        <button type="button" className="pos-button pos-button--quiet pos-button--small" onClick={onFit}>
          <Maximize2 size={14} aria-hidden />
          Fit to screen
        </button>

        <div className="floor-zoom__stepper">
          <button
            type="button"
            onClick={() => onZoom(Math.max(ZOOM_MIN, Math.round((zoom - ZOOM_STEP) * 10) / 10))}
            disabled={zoom <= ZOOM_MIN}
            aria-label="Zoom out"
          >
            −
          </button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => onZoom(Math.min(ZOOM_MAX, Math.round((zoom + ZOOM_STEP) * 10) / 10))}
            disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>
    </footer>
  )
}

/**
 * The floor at a glance, above the plan.
 *
 * Five numbers a manager acts on, and no sixth that merely looks impressive.
 */
export function FloorHealth({
  counts,
  dueSoon,
  overdue,
}: {
  counts: Occupancy
  dueSoon: number
  overdue: number
}) {
  const cells: { label: string; value: string; tone?: 'warn' | 'danger' }[] = [
    { label: 'Occupancy', value: `${counts.percent}%` },
    { label: 'Free tables', value: String(counts.available) },
    { label: 'Guests seated', value: String(counts.covers) },
    { label: 'Due in 30 min', value: String(dueSoon), tone: dueSoon > 0 ? 'warn' : undefined },
    { label: 'Over turn time', value: String(overdue), tone: overdue > 0 ? 'warn' : undefined },
    { label: 'Awaiting clean', value: String(counts.cleaning), tone: counts.cleaning > 0 ? 'warn' : undefined },
    {
      label: 'Out of service',
      value: String(counts.outOfService),
      tone: counts.outOfService > 0 ? 'danger' : undefined,
    },
  ]

  return (
    <div className="floor-health" role="group" aria-label="Floor at a glance">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className={cell.tone ? `floor-health__cell floor-health__cell--${cell.tone}` : 'floor-health__cell'}
        >
          <strong className="num">{cell.value}</strong>
          <span>{cell.label}</span>
        </div>
      ))}
    </div>
  )
}
