/**
 * System health.
 *
 * WHAT THIS PANEL IS NOT. It is not a device monitor. A browser cannot ask
 * whether a printer has paper or a drawer is plugged in, and POS integrates no
 * payment provider, so those rows report what the till is CONFIGURED with and
 * say so in the row and again at the foot. A green tick against a cable nobody
 * has checked is the kind of reassurance that gets a shop to open without a
 * printer.
 *
 * The rows that ARE live — the connection and the outbox — are computed from
 * this browser and this device's own queue.
 */

import {
  Archive,
  ChefHat,
  CreditCard,
  MonitorCheck,
  Printer,
  RefreshCcw,
  type LucideIcon,
} from 'lucide-react'
import type { HealthId, HealthRow, Tone } from '../model'
import { Pill } from './states'

const ICONS: Record<HealthId, LucideIcon> = {
  application: MonitorCheck,
  sync: RefreshCcw,
  payments: CreditCard,
  receipt_printer: Printer,
  cash_drawer: Archive,
  kitchen_display: ChefHat,
}

export function SystemHealthCard({
  rows,
  summary,
  loading,
}: {
  rows: HealthRow[]
  summary: { label: string; tone: Tone }
  loading: boolean
}) {
  return (
    <section className="home-card" aria-label="System health">
      <div className="home-card__head">
        <h2>
          <MonitorCheck size={16} aria-hidden /> System Health
        </h2>
        <Pill tone={summary.tone}>{summary.label}</Pill>
      </div>

      <div className="home-health">
        {rows.map((row) => {
          const Icon = ICONS[row.id]

          return (
            <div className="home-health__row" key={row.id}>
              <span className="home-health__label" title={row.note}>
                <Icon size={15} aria-hidden />
                <span>{row.label}</span>
              </span>
              {loading && (row.id === 'cash_drawer' || row.id === 'kitchen_display') ? (
                <span className="home-skeleton home-skeleton--line" style={{ width: 84 }} />
              ) : (
                <Pill tone={row.tone}>{row.status}</Pill>
              )}
            </div>
          )
        })}
      </div>

      <p className="home-card__foot">
        Devices are reported as configured, not as connected — nothing in a browser can verify a cable. Payments are
        recorded from the terminal slip; POS confirms no collection with a provider.
      </p>
    </section>
  )
}
