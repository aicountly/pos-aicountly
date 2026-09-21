/**
 * The chips and the filters.
 *
 * The chips are toggle buttons with aria-pressed rather than links or tabs,
 * because that is what they are: a filter that is on or off, with the count it
 * would show written inside it. The counts are worked out BEFORE the chips are
 * applied, so pressing New does not leave every other chip reading zero.
 *
 * Outlet and station are asked of the server; status, order kind and search
 * are answered from the tickets already in hand. That split is not an
 * implementation detail — the figures above the board are counted over what
 * the server was asked for, and they would stop being true otherwise.
 */

import { memo } from 'react'
import { Search, X } from 'lucide-react'
import type { Location } from '../../services/types'
import type { KdsStation, KitchenFilters, StatusFilter } from '../types'
import { ORDER_KIND_LABEL } from '../derive'
import type { LaneCounts } from '../derive'

const CHIPS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'ready', label: 'Ready' },
  { id: 'delayed', label: 'Delayed' },
]

const ORDER_KINDS: { value: string; label: string }[] = [
  { value: 'all', label: 'All order types' },
  { value: 'dine_in', label: ORDER_KIND_LABEL.dine_in },
  { value: 'takeaway', label: ORDER_KIND_LABEL.takeaway },
  { value: 'delivery', label: ORDER_KIND_LABEL.delivery },
  { value: 'pickup', label: ORDER_KIND_LABEL.pickup },
  { value: 'qr_order', label: ORDER_KIND_LABEL.qr_order },
]

export const KitchenToolbar = memo(function KitchenToolbar({
  filters,
  counts,
  outlets,
  stations,
  onChange,
}: {
  filters: KitchenFilters
  counts: LaneCounts
  outlets: Location[]
  stations: KdsStation[]
  onChange: (patch: Partial<KitchenFilters>) => void
}) {
  return (
    <div className="kds-toolbar">
      <div className="kds-chips" role="group" aria-label="Filter tickets by status">
        {CHIPS.map((chip) => {
          const value = counts[chip.id === 'all' ? 'all' : chip.id]
          const pressed = filters.status === chip.id

          return (
            <button
              key={chip.id}
              type="button"
              className={chip.id === 'delayed' ? 'kds-chip kds-chip--danger' : 'kds-chip'}
              aria-pressed={pressed}
              onClick={() => onChange({ status: chip.id })}
            >
              {chip.label}
              <span className="kds-chip__count">{value}</span>
            </button>
          )
        })}
      </div>

      <div className="kds-filters">
        {outlets.length > 1 && (
          <select
            className="kds-select"
            aria-label="Outlet"
            value={filters.locationId === null ? 'all' : String(filters.locationId)}
            onChange={(event) =>
              onChange({ locationId: event.target.value === 'all' ? null : Number(event.target.value) })
            }
          >
            <option value="all">All outlets</option>
            {outlets.map((outlet) => (
              <option key={outlet.location_id} value={outlet.location_id}>
                {outlet.display_name ?? outlet.location_code}
              </option>
            ))}
          </select>
        )}

        {stations.length > 0 && (
          <select
            className="kds-select"
            aria-label="Kitchen station"
            value={filters.stationId === null ? 'all' : String(filters.stationId)}
            onChange={(event) =>
              onChange({ stationId: event.target.value === 'all' ? null : Number(event.target.value) })
            }
          >
            <option value="all">All stations</option>
            {stations.map((station) => (
              <option key={station.station_id} value={station.station_id}>
                {station.station_name}
              </option>
            ))}
          </select>
        )}

        <select
          className="kds-select"
          aria-label="Order type"
          value={filters.orderKind}
          onChange={(event) => onChange({ orderKind: event.target.value })}
        >
          {ORDER_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>

        <label className="kds-search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            value={filters.search}
            placeholder="Search order, table or item…"
            aria-label="Search tickets by order, table, customer, item or station"
            onChange={(event) => onChange({ search: event.target.value })}
          />
          {filters.search !== '' && (
            <button type="button" onClick={() => onChange({ search: '' })} aria-label="Clear the search">
              <X size={14} aria-hidden />
            </button>
          )}
        </label>
      </div>
    </div>
  )
})

/**
 * What each station is carrying.
 *
 * Only shown when there is more than one, because "Main kitchen 4" beside a
 * board that IS the main kitchen is a label, not information.
 */
export const StationLoad = memo(function StationLoad({
  stations,
  activeStationId,
  onSelect,
}: {
  stations: KdsStation[]
  activeStationId: number | null
  onSelect: (id: number | null) => void
}) {
  if (stations.length < 2) return null

  return (
    <div className="kds-stations">
      <span className="kds-stations__label">Stations</span>
      {stations.map((station) => (
        <button
          key={station.station_id}
          type="button"
          className={station.late > 0 ? 'kds-station kds-station--late' : 'kds-station'}
          aria-pressed={activeStationId === station.station_id}
          onClick={() => onSelect(activeStationId === station.station_id ? null : station.station_id)}
          title={
            station.late > 0
              ? `${station.station_name}: ${station.live} live, ${station.late} past its ${station.late_after_minutes} minute target`
              : `${station.station_name}: ${station.live} live, target ${station.late_after_minutes} minutes`
          }
        >
          {station.station_name}
          <span className="kds-station__count">{station.live}</span>
          {station.late > 0 && <span>· {station.late} late</span>}
        </button>
      ))}
    </div>
  )
})
