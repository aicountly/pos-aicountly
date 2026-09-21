/**
 * Three questions about the same shift: how it was paid, when it sold, and
 * where the orders came from.
 *
 * None of the three hard-codes its categories. A shop that takes gift cards and
 * store credit sees both; one that sells through an aggregator and a QR code
 * sees those. What the counter recorded is what appears — these cards count,
 * they do not decide.
 */

import { useMemo, useState } from 'react'
import {
  Bike,
  Globe,
  ListChecks,
  Monitor,
  Package,
  Phone,
  QrCode,
  ShoppingBag,
  Store,
  Truck,
  UtensilsCrossed,
  WalletCards,
} from 'lucide-react'
import { DonutChart, SERIES_OTHER, TrendChart, seriesColour, type DonutSlice } from './charts'
import { compactMoney, moneyExact, safeNumber } from '../format'
import type { ChannelBlock, HourPoint, TenderSlice, TrendMetric } from '../types'

// ---------------------------------------------------------------------------
// Payment mix
// ---------------------------------------------------------------------------

/**
 * How the shift was paid.
 *
 * CASH IS COLLECTED; EVERYTHING ELSE IS RECORDED. POS has no payment provider
 * integration, so a card or UPI row means a cashier read an approval off a
 * separate terminal and typed the reference. The note under the legend says so,
 * because a reconciliation screen that added the two together under one word
 * would be claiming a confirmation nobody gave.
 */
export function PaymentMixCard({ tenders, total }: { tenders: TenderSlice[]; total: number }) {
  // Nine tenders is more than the palette can keep distinguishable, so the tail
  // folds into one grey "Other" rather than inventing a ninth hue.
  const slices = useMemo<DonutSlice[]>(() => {
    const ranked = [...tenders].sort((a, b) => b.amount - a.amount)
    const head = ranked.slice(0, 8)
    const tail = ranked.slice(8)

    const out: DonutSlice[] = head.map((tender, index) => ({
      key: tender.payment_mode,
      label: tender.display_name,
      value: safeNumber(tender.amount),
      colour: seriesColour(index),
    }))

    if (tail.length > 0) {
      out.push({
        key: 'other',
        label: `Other (${tail.length})`,
        value: tail.reduce((sum, tender) => sum + safeNumber(tender.amount), 0),
        colour: SERIES_OTHER,
      })
    }

    return out
  }, [tenders])

  const taken = slices.reduce((sum, slice) => sum + slice.value, 0)
  const recorded = tenders.filter((tender) => tender.settlement_state === 'recorded')

  return (
    <section className="shift-card" aria-label="Payment mix">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <WalletCards size={14} />
            </span>
            Payment Mix
          </h2>
          <p>Share of payments in this shift</p>
        </div>
      </div>

      {slices.length === 0 ? (
        <p className="shift-card__note">No tenders were recorded on this shift.</p>
      ) : (
        <>
          <div className="shift-mix">
            <div className="shift-mix__chart">
              <DonutChart
                slices={slices}
                centreValue={compactMoney(total || taken)}
                centreLabel="Total Sales"
                caption="Payment mix for this shift"
                formatValue={(value) => moneyExact(value)}
              />
            </div>

            {/* The legend is the identity channel, always present. The colour on
                the swatch reinforces it; the text never wears the series hue. */}
            <div className="shift-mix__legend">
              {slices.map((slice) => (
                <div key={slice.key} style={{ display: 'contents' }}>
                  <span className="shift-mix__name" title={slice.label}>
                    <span className="shift-mix__swatch" style={{ background: slice.colour }} aria-hidden />
                    {slice.label}
                  </span>
                  <span className="shift-mix__pc">{taken > 0 ? `${Math.round((slice.value / taken) * 100)}%` : '0%'}</span>
                  <span className="shift-mix__amount">{moneyExact(slice.value)}</span>
                </div>
              ))}
            </div>
          </div>

          {recorded.length > 0 && (
            <p className="shift-card__note">
              <strong>{recorded.map((tender) => tender.display_name).join(', ')}</strong>{' '}
              {recorded.length === 1 ? 'was' : 'were'} typed from an external terminal slip. POS has no payment provider
              integration, so only cash is confirmed by a count.
            </p>
          )}
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Hourly sales
// ---------------------------------------------------------------------------

const TREND_METRICS: Array<{ key: TrendMetric; label: string; kind: 'money' | 'count' }> = [
  { key: 'net_sales', label: 'Net Sales', kind: 'money' },
  { key: 'gross_sales', label: 'Gross Sales', kind: 'money' },
  { key: 'orders', label: 'Orders', kind: 'count' },
  { key: 'average_bill', label: 'Average Bill', kind: 'money' },
]

export function HourlySalesCard({ hourly }: { hourly: HourPoint[] }) {
  const [metric, setMetric] = useState<TrendMetric>('net_sales')
  const chosen = TREND_METRICS.find((item) => item.key === metric) ?? TREND_METRICS[0]

  const points = useMemo(
    () => hourly.map((point) => ({ key: point.time, label: point.label, value: safeNumber(point[metric]) })),
    [hourly, metric],
  )

  const format = (value: number) =>
    chosen.kind === 'money' ? moneyExact(value) : new Intl.NumberFormat('en-IN').format(Math.round(value))
  const axis = (value: number) =>
    chosen.kind === 'money' ? compactMoney(value) : new Intl.NumberFormat('en-IN').format(Math.round(value))

  return (
    <section className="shift-card" aria-label="Hourly sales trend">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <ListChecks size={14} />
            </span>
            Hourly Sales Trend
          </h2>
          <p>Sales throughout this shift</p>
        </div>

        <label>
          <span className="pos-visually-hidden">Which figure to plot</span>
          <select className="shift-control" value={metric} onChange={(event) => setMetric(event.target.value as TrendMetric)}>
            {TREND_METRICS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <TrendChart
        points={points}
        valueLabel={chosen.label}
        caption={`${chosen.label} by the hour, through this shift`}
        formatValue={format}
        formatAxis={axis}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Orders by channel
// ---------------------------------------------------------------------------

/**
 * An icon for a channel, where one is obviously right.
 *
 * A channel POS has never seen before still renders — with the generic mark and
 * the label the counter used. Nothing here decides what channels exist.
 */
const CHANNEL_ICONS: Record<string, typeof Store> = {
  dine_in: UtensilsCrossed,
  takeaway: ShoppingBag,
  delivery: Bike,
  pickup: Package,
  retail: Store,
  counter: Store,
  qr_order: QrCode,
  kiosk: Monitor,
  aggregator: Globe,
  phone_order: Phone,
  drive_through: Truck,
  room_service: Package,
}

export function OrdersByChannelCard({ channels }: { channels: ChannelBlock }) {
  const total = safeNumber(channels.total_orders)

  return (
    <section className="shift-card" aria-label="Orders by channel">
      <div className="shift-card__head">
        <div style={{ minWidth: 0 }}>
          <h2>
            <span className="shift-card__icon" aria-hidden>
              <Store size={14} />
            </span>
            Orders by Channel
          </h2>
          <p>Order type breakdown</p>
        </div>

        <div className="shift-total">
          <small>Total Orders</small>
          <strong>{new Intl.NumberFormat('en-IN').format(total)}</strong>
        </div>
      </div>

      {channels.rows.length === 0 ? (
        <p className="shift-card__note">No completed orders on this shift yet.</p>
      ) : (
        <div className="shift-channels">
          {channels.rows.map((row) => {
            const Icon = CHANNEL_ICONS[row.channel] ?? Store
            const share = safeNumber(row.percentage)

            return (
              <div className="shift-channel" key={row.channel}>
                <span className="shift-channel__name" title={row.label}>
                  <Icon size={14} aria-hidden style={{ color: 'var(--pos-muted)', flex: '0 0 auto' }} />
                  {row.label}
                </span>
                <span
                  className="shift-channel__track"
                  role="img"
                  aria-label={`${row.label}: ${row.orders} orders, ${share}% of the shift, ${moneyExact(row.net)} taken`}
                >
                  <span className="shift-channel__fill" style={{ width: `${Math.max(share, share > 0 ? 3 : 0)}%` }} />
                </span>
                <span className="shift-channel__count">{new Intl.NumberFormat('en-IN').format(row.orders)}</span>
                <span className="shift-channel__pc">{share}%</span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
