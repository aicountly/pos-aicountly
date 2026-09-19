/**
 * Two questions about the shop right now: which outlets can take money, and who
 * is standing at a till.
 *
 * Readiness is deliberately ONE condition — a till — because that is the
 * condition the rest of the application enforces. Anything else worth knowing
 * about an outlet's setup is said in the row rather than turned into a
 * requirement POS does not actually have.
 */

import { Link } from 'react-router-dom'
import { Building2, ChevronRight, Users } from 'lucide-react'
import { duration, money } from '../../dashboards/format'
import { initialsFor, type OutletRow, type ShiftRow } from '../model'
import { Pill, SkeletonRows, WidgetEmpty, WidgetFailed } from './states'

export function OutletReadinessCard({
  outlets,
  loading,
  canManage,
}: {
  outlets: OutletRow[]
  loading: boolean
  canManage: boolean
}) {
  const ready = outlets.filter((outlet) => outlet.ready).length
  const shown = outlets.slice(0, 3)

  return (
    <section className="home-card" aria-label="Outlet readiness">
      <div className="home-card__head">
        <h2>
          <Building2 size={16} aria-hidden /> Outlet Readiness
        </h2>
        <span className="home-card__count">
          {outlets.length === 0 ? 'None yet' : `${ready}/${outlets.length} ready`}
        </span>
      </div>

      <div className="home-card__body">
        {loading ? (
          <SkeletonRows count={2} />
        ) : outlets.length === 0 ? (
          <WidgetEmpty title="No outlets configured yet.">
            An outlet is the shop a till belongs to, and where its stock and cash are recorded.
          </WidgetEmpty>
        ) : (
          <div className="home-rows">
            {shown.map((outlet) => {
              const body = (
                <>
                  <span className="home-row__copy">
                    <div>
                      <strong>{outlet.name}</strong>
                      <small>
                        {outlet.mode} · {outlet.note}
                      </small>
                    </div>
                  </span>
                  <span className="home-row__right">
                    <Pill tone={outlet.ready ? 'ok' : 'warn'}>{outlet.ready ? 'Ready' : 'Not ready'}</Pill>
                    {canManage && <ChevronRight size={15} aria-hidden />}
                  </span>
                </>
              )

              return canManage ? (
                <Link className="home-row" key={outlet.id} to="/setup">
                  {body}
                </Link>
              ) : (
                <div className="home-row" key={outlet.id}>
                  {body}
                </div>
              )
            })}

            {outlets.length > shown.length && canManage && (
              <Link className="home-btn home-btn--quiet" to="/setup">
                View all {outlets.length} outlets
              </Link>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export function StaffShiftCard({
  shifts,
  loading,
  error,
  onRetry,
  allowed,
  canReports,
}: {
  shifts: ShiftRow[]
  loading: boolean
  error: string | null
  onRetry: () => void
  allowed: boolean
  canReports: boolean
}) {
  return (
    <section className="home-card" aria-label="Staff shift status">
      <div className="home-card__head">
        <h2>
          <Users size={16} aria-hidden /> Staff Shift Status
        </h2>
        <span className="home-card__count">{allowed && !loading && !error ? `${shifts.length} active` : '—'}</span>
      </div>

      <div className="home-card__body">
        {!allowed ? (
          <WidgetEmpty title="Shifts are not shown for your role.">
            Opening or reporting on a till is what this panel needs.
          </WidgetEmpty>
        ) : error ? (
          <WidgetFailed message={`Unable to load shifts. ${error}`} onRetry={onRetry} />
        ) : loading ? (
          <SkeletonRows count={2} />
        ) : shifts.length === 0 ? (
          <WidgetEmpty title="No active shifts">Start a shift to begin operations.</WidgetEmpty>
        ) : (
          <div className="home-rows">
            {shifts.slice(0, 3).map((shift) => (
              <div className="home-row" key={shift.id}>
                <span className="home-row__copy">
                  <span className="home-avatar" aria-hidden>
                    {initialsFor(shift.who)}
                  </span>
                  <div>
                    <strong>{shift.who}</strong>
                    <small>
                      {shift.till} · {shift.outlet}
                    </small>
                  </div>
                </span>
                <span className="home-row__right">
                  <span
                    style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
                    title={`Opened at ${new Date(shift.openedAt).toLocaleString()}. Drawer should hold ${money(shift.expectedCash)}.`}
                  >
                    {duration((Date.now() - new Date(shift.openedAt).getTime()) / 1000)}
                  </span>
                  {shift.busy && <Pill tone="ok">Busy</Pill>}
                </span>
              </div>
            ))}

            {(shifts.length > 3 || canReports) && (
              <Link className="home-btn home-btn--quiet" to="/controls">
                View all shifts
              </Link>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
