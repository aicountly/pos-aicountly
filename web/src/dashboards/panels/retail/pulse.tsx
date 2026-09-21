/**
 * The briefing strip, on the Retail board.
 *
 * "AICOUNTLY AI INSIGHTS" IS THE NAME OF THE SURFACE, NOT A CLAIM ABOUT THE
 * CONTENT — the same arrangement Business Overview already set, and for the
 * same reason. Every chip here is a threshold crossing computed in SQL from
 * this POS' own rows, so the strip carries a BETA badge, every card in the
 * drawer is badged "Rule-based alert", and the drawer closes with the server's
 * own note saying no model produced any of it. The day one does, its items
 * arrive with `kind: 'ai'` and badge themselves differently — which is why the
 * badge is on the item rather than on the panel.
 *
 * A quiet shop gets a short strip. There is no filler chip.
 */

import { useState } from 'react'
import { ArrowRight, CircleAlert, CircleCheck, Info, Sparkles, TriangleAlert } from 'lucide-react'
import { count } from '../../format'
import { DashboardDrawer, InsightCard, StatusBadge, Unavailable } from '../../shell'
import type { RetailBoard } from '../../types'

function InsightIcon({ severity }: { severity: string }) {
  if (severity === 'danger') return <CircleAlert size={15} aria-hidden />
  if (severity === 'warning') return <TriangleAlert size={15} aria-hidden />
  if (severity === 'success') return <CircleCheck size={15} aria-hidden />

  return <Info size={15} aria-hidden />
}

export function RetailInsights({ board }: { board: RetailBoard }) {
  const [open, setOpen] = useState(false)
  const items = board.pulse.items
  const peak = board.pulse.peak

  const context = peak
    ? `Read from this window's own rows, and 28 days of this outlet's trading for the busiest hour.`
    : "Read from this window's own rows."

  return (
    <>
      <section className="pos-strip" aria-label="Aicountly insights">
        <div className="pos-strip__brand">
          <p className="pos-strip__title">
            <span className="pos-strip__mark" aria-hidden>
              <Sparkles size={15} />
            </span>
            Aicountly AI Insights
            <span className="pos-strip__beta">BETA</span>
          </p>
          <p className="pos-strip__context">{context}</p>
        </div>

        {items.length === 0 ? (
          <p className="pos-strip__quiet">
            Nothing crossed a threshold. No sale is stuck, no counter is quiet and no bill has been sitting on a
            counter too long in this window.
          </p>
        ) : (
          <ul className="pos-strip__items">
            {items.slice(0, 4).map((item) => {
              const severity = item.severity ?? 'info'

              return (
                <li key={item.id} className={`pos-chipcard pos-chipcard--${severity}`}>
                  <span className={`pos-chipcard__icon pos-chipcard__icon--${severity}`}>
                    <InsightIcon severity={severity} />
                  </span>
                  <span className="pos-chipcard__body">
                    <strong>{item.title}</strong>
                    {item.metric && <span className="pos-chipcard__metric">{item.metric}</span>}
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <button type="button" className="pos-strip__more" onClick={() => setOpen(true)}>
          View all insights
          <ArrowRight size={14} aria-hidden />
        </button>
      </section>

      <DashboardDrawer
        open={open}
        title="Aicountly insights"
        description={`${count(items.length)} rule${items.length === 1 ? '' : 's'} fired for these counters.`}
        onClose={() => setOpen(false)}
      >
        {items.length === 0 ? (
          <Unavailable muted title="Nothing crossed a threshold">
            No rule fired for this window. Nothing is being hidden — there is nothing to show.
          </Unavailable>
        ) : (
          items.map((item) => <InsightCard key={item.id} insight={item} />)
        )}

        {peak && (
          <p className="pos-note">
            <strong>Busiest hour: {peak.label}.</strong> {peak.basis}
          </p>
        )}

        <p className="pos-note">
          <StatusBadge tone="neutral">No AI configured</StatusBadge> {board.pulse.ai.note}
        </p>
      </DashboardDrawer>
    </>
  )
}
