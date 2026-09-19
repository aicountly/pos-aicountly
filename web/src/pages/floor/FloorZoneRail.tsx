/**
 * The zones on this floor.
 *
 * Zones are derived from the tables rather than configured separately, so this
 * list is whatever the shop has actually named. Choosing one narrows the plan
 * without hiding the rest of the room: the other tables stay where they are and
 * fade, because a waiter filtering to the bar still needs to see the bar in
 * relation to everything else.
 */

import { CircleDot, Grid2x2, GlassWater, PanelsTopLeft, Utensils } from 'lucide-react'
import type { Zone } from './status'

/** A guess at the right icon from the zone's name, falling back to a neutral mark. */
function iconFor(name: string) {
  const lower = name.toLowerCase()
  if (lower.includes('bar') || lower.includes('lounge')) return GlassWater
  if (lower.includes('window') || lower.includes('terrace') || lower.includes('patio')) return PanelsTopLeft
  if (lower.includes('dining') || lower.includes('main') || lower.includes('family')) return Utensils

  return CircleDot
}

export function FloorZoneRail({
  zones,
  total,
  selected,
  onSelect,
}: {
  zones: Zone[]
  total: number
  /** null = all zones. */
  selected: string | null
  onSelect: (zoneId: string | null) => void
}) {
  return (
    <nav className="floor-zones" aria-label="Zones">
      <p className="floor-zones__label">Zones</p>

      <button type="button" className="floor-zone" aria-pressed={selected === null} onClick={() => onSelect(null)}>
        <Grid2x2 size={15} aria-hidden />
        <span>All zones</span>
        <strong>{total}</strong>
      </button>

      {zones.map((zone) => {
        const Icon = iconFor(zone.name)

        return (
          <button
            key={zone.id}
            type="button"
            className="floor-zone"
            aria-pressed={selected === zone.id}
            onClick={() => onSelect(zone.id)}
          >
            <Icon size={15} aria-hidden />
            <span>{zone.name}</span>
            <strong>{zone.tableCount}</strong>
          </button>
        )
      })}

      {zones.length === 0 && (
        <p style={{ margin: '8px 10px', color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          No zones yet. Put tables in a zone from Edit layout.
        </p>
      )}
    </nav>
  )
}
