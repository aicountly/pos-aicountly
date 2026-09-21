/**
 * Payment Mode Summary — the mix, as a donut with the figures beside it.
 *
 * DRAWN, NOT IMPORTED. POS ships no chart library on purpose: a till is often a
 * cheap tablet on shop broadband, and one donut is twenty lines of dasharray
 * arithmetic. `pathLength={100}` turns every arc into a percentage directly, so
 * there is no radius-to-circumference conversion to get wrong.
 *
 * THE SEGMENTS ARE WHATEVER THE SHOP TOOK. They come from the tender lines the
 * server grouped, so a shop that starts accepting a wallet or a gift card gets a
 * wedge without anyone editing this file.
 *
 * AND THE PICTURE IS NEVER THE ONLY COPY. The legend carries label, share and
 * rupee figure, and the same numbers are in a real table underneath for anyone
 * reading this with a screen reader.
 */

import { useId, useState, type ReactNode } from 'react'
import { Wallet } from 'lucide-react'
import { count, money, percent } from '../format'
import { ChartTable } from '../charts'
import { ControlCard, WidgetEmptyState } from './primitives'
import type { PaymentSlice } from './derive'
import type { QuickRangeId } from './CashControlsFilters'

const PERIOD_OPTIONS: Array<{ id: Exclude<QuickRangeId, 'custom'>; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
]

export function PaymentModeSummaryCard({
  slices,
  total,
  period,
  periodLabel,
  onPeriodChange,
}: {
  slices: PaymentSlice[]
  total: number
  period: QuickRangeId
  periodLabel: string
  onPeriodChange: (id: Exclude<QuickRangeId, 'custom'>) => void
}) {
  const titleId = useId()
  const [hovered, setHovered] = useState<string | null>(null)

  const recorded = slices.filter((slice) => !slice.collected)

  return (
    <ControlCard
      title="Payment mode summary"
      icon={<Wallet size={15} />}
      className="cc-payment-card"
      tools={
        <>
          <label className="pos-visually-hidden" htmlFor="cc-payment-period">
            Period for the payment mix
          </label>
          <select
            id="cc-payment-period"
            className="cc-compact-select"
            value={period === 'custom' ? '' : period}
            onChange={(event) => {
              const next = PERIOD_OPTIONS.find((option) => option.id === event.target.value)
              if (next) onPeriodChange(next.id)
            }}
          >
            {period === 'custom' && <option value="">{periodLabel}</option>}
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      }
    >
      {slices.length === 0 || total <= 0 ? (
        <WidgetEmptyState title="No tenders recorded">
          Nothing was taken in this period for the selected outlet and counter.
        </WidgetEmptyState>
      ) : (
        <>
          <div className="cc-payment">
            <div className="cc-donut">
              <svg viewBox="0 0 120 120" role="img" aria-labelledby={titleId}>
                <title id={titleId}>
                  Payment mix for {periodLabel}: {slices.map((slice) => `${slice.label} ${percent(slice.share, 0)}`).join(', ')}
                </title>
                <circle cx="60" cy="60" r="44" fill="none" stroke="#eef2f6" strokeWidth="17" />
                {slices.reduce<{ offset: number; arcs: ReactNode[] }>(
                  (acc, slice) => {
                    acc.arcs.push(
                      <circle
                        key={slice.key}
                        className="cc-donut__arc"
                        data-dim={hovered !== null && hovered !== slice.key}
                        cx="60"
                        cy="60"
                        r="44"
                        fill="none"
                        stroke={slice.colour}
                        strokeWidth="17"
                        pathLength={100}
                        strokeDasharray={`${slice.share} ${100 - slice.share}`}
                        strokeDashoffset={-acc.offset}
                        transform="rotate(-90 60 60)"
                        onMouseEnter={() => setHovered(slice.key)}
                        onMouseLeave={() => setHovered(null)}
                      >
                        <title>{`${slice.label}: ${money(slice.amount)} (${percent(slice.share, 0)})`}</title>
                      </circle>,
                    )
                    acc.offset += slice.share

                    return acc
                  },
                  { offset: 0, arcs: [] },
                ).arcs}
              </svg>

              <div className="cc-donut__centre">
                <span className="cc-donut__total">{money(total)}</span>
                <span className="cc-donut__caption">Total taken</span>
              </div>
            </div>

            <div className="cc-legend">
              {slices.map((slice) => (
                <div
                  key={slice.key}
                  className="cc-legend__row"
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span className="cc-legend__swatch" style={{ background: slice.colour }} aria-hidden />
                  <span className="cc-legend__label" title={`${slice.settlementLabel} · ${count(slice.count)} tenders`}>
                    {slice.label}
                  </span>
                  <span className="cc-legend__share">{percent(slice.share, 0)}</span>
                  <span className="cc-legend__value">{money(slice.amount)}</span>
                </div>
              ))}
            </div>
          </div>

          {recorded.length > 0 && (
            <p className="cc-hint" style={{ marginTop: 12 }}>
              <strong>{recorded.map((slice) => slice.label).join(', ')}</strong>{' '}
              {recorded.length === 1 ? 'is' : 'are'} recorded at the counter from an external terminal slip. POS has no
              payment provider integration, so no figure here is a provider-confirmed collection.
            </p>
          )}

          <ChartTable
            visible={false}
            caption={`Payment mode summary for ${periodLabel}`}
            columns={['Payment mode', 'Amount', 'Share', 'Tenders']}
            rows={slices.map((slice) => [slice.label, money(slice.amount), percent(slice.share, 0), count(slice.count)])}
          />
        </>
      )}
    </ControlCard>
  )
}
