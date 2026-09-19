/**
 * One card per floor, and how full it is.
 *
 * The strip is the manager's first read of the shop: which room is busy, which
 * is empty, and whether anything is closed. Selecting a card changes the
 * workspace below without a page load and without re-fetching the plan — the
 * floors all arrived in the same answer.
 */

import { Building2, Mountain, PartyPopper, Plus, Sun, Trees, Utensils } from 'lucide-react'
import type { FloorKind, FloorPlanFloor } from '../../services/types'
import { occupancyOf } from './status'

const KIND_ICON: Record<FloorKind, typeof Building2> = {
  indoor: Building2,
  outdoor: Trees,
  rooftop: Sun,
  private_dining: Utensils,
  banquet: PartyPopper,
  other: Mountain,
}

export function FloorSummaryCards({
  floors,
  selectedId,
  onSelect,
  onAdd,
  canAdd,
}: {
  floors: FloorPlanFloor[]
  selectedId: number | null
  onSelect: (floorId: number) => void
  onAdd: () => void
  canAdd: boolean
}) {
  return (
    <section className="floor-cards" aria-label="Floors">
      {floors.map((floor) => {
        const occupancy = occupancyOf(floor.tables)
        const Icon = KIND_ICON[floor.floor_kind] ?? Building2
        const barTone = occupancy.percent >= 90 ? ' floor-bar--full' : occupancy.percent >= 70 ? ' floor-bar--busy' : ''

        return (
          <button
            key={floor.floor_id}
            type="button"
            className="floor-card"
            aria-pressed={floor.floor_id === selectedId}
            onClick={() => onSelect(floor.floor_id)}
          >
            <div className="floor-card__head">
              <span className={`floor-card__icon floor-card__icon--${floor.floor_kind}`} aria-hidden>
                <Icon size={19} />
              </span>
              <span className="floor-card__names">
                <strong>{floor.floor_name}</strong>
                <small>
                  {floor.tables.length} table{floor.tables.length === 1 ? '' : 's'}
                  {floor.is_open ? '' : ' · closed'}
                </small>
              </span>
            </div>

            {/* The bar is a picture of the number beneath it, never the only
                place the number appears. */}
            <div className={`floor-bar${barTone}`} aria-hidden>
              <span style={{ width: `${occupancy.percent}%` }} />
            </div>

            <div className="floor-card__meta">
              <span className="num">
                {occupancy.occupied}/{occupancy.total} occupied
              </span>
              <strong className="num">{occupancy.percent}%</strong>
            </div>
          </button>
        )
      })}

      {canAdd && (
        <button type="button" className="floor-card floor-card--add" onClick={onAdd}>
          <Plus size={20} aria-hidden />
          <strong>Add floor</strong>
          <span>Create a new floor layout</span>
        </button>
      )}
    </section>
  )
}
