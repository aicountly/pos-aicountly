/**
 * No floors yet.
 *
 * The important sentence on this screen is the last one: a shop without a floor
 * plan is not a broken shop. A retail counter never needs one, and a restaurant
 * that has not drawn its room yet can still take money at the till today. The
 * page invites the setup; it does not block anything on it.
 */

import { Plus, Store } from 'lucide-react'
import { Link } from 'react-router-dom'

export function FloorEmptyState({ onCreate, canCreate }: { onCreate: () => void; canCreate: boolean }) {
  return (
    <section className="floor-empty">
      <div className="floor-empty__art" aria-hidden>
        <div className="floor-empty__plan">
          <span className="floor-empty__table floor-empty__table--a" />
          <span className="floor-empty__table floor-empty__table--b" />
          <span className="floor-empty__table floor-empty__table--round floor-empty__table--c" />
          <span className="floor-empty__table floor-empty__table--round floor-empty__table--d" />
        </div>
      </div>

      <div className="floor-empty__body">
        <p className="pos-eyebrow">RESTAURANT FLOOR MANAGEMENT</p>
        <h2>Set up your restaurant floor</h2>
        <p>
          Create floors, dining zones and tables so your team can seat guests, follow orders and turn tables
          visually, in real time.
        </p>

        {canCreate ? (
          <button type="button" className="pos-button pos-button--primary" onClick={onCreate}>
            <Plus size={16} aria-hidden />
            Create first floor
          </button>
        ) : (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
            Ask a manager to add the first floor — setting the shop up needs the terminal management permission.
          </p>
        )}

        <span className="floor-empty__helper">
          Takes about two minutes. You can keep selling from the{' '}
          <Link to="/" className="pos-link">
            <Store size={12} aria-hidden style={{ verticalAlign: -1, marginRight: 3 }} />
            Till
          </Link>{' '}
          without a floor plan — a counter shop never needs one.
        </span>
      </div>
    </section>
  )
}
