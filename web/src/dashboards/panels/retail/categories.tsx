/**
 * What sold, by category.
 *
 * WHOSE GROUPING IS THIS? POS owns the menu's categories and nothing else — a
 * scanned item's group belongs to Inventory, and POS keeps no copy of it. The
 * server therefore reads the menu category where there is one, asks Inventory
 * live for the rest, and reports how much of the period it could place. When
 * it could place none, this panel says which product owns the answer rather
 * than drawing an empty ring.
 */

import { useMemo, useState } from 'react'
import { DonutChart, DonutSwatch } from '../../charts'
import { decimal, money, moneyCompact, percent } from '../../format'
import { ContextualEmpty, Panel, Unavailable } from '../../shell'
import type { RetailBoard } from '../../types'

type Basis = 'amount' | 'qty' | 'bills'

const BASES: Array<{ key: Basis; label: string }> = [
  { key: 'amount', label: 'By sales value' },
  { key: 'qty', label: 'By quantity' },
  { key: 'bills', label: 'By bills' },
]

export function TopSellingCategories({ board, periodLabel }: { board: RetailBoard; periodLabel: string }) {
  const [basis, setBasis] = useState<Basis>('amount')
  const categories = board.categories

  const rows = categories.available ? categories.rows : []

  const slices = useMemo(
    () =>
      rows
        .map((row, index) => ({
          key: `${row.label}-${index}`,
          label: row.label,
          value: row[basis],
        }))
        .filter((slice) => slice.value > 0),
    [rows, basis],
  )

  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const format = basis === 'amount' ? (value: number) => money(value) : (value: number) => decimal(value, basis === 'qty' ? 2 : 0)

  return (
    <Panel
      title="Top selling categories"
      action={
        categories.available && (
          <label className="pos-field">
            <span className="pos-visually-hidden">Rank categories by</span>
            <select
              className="pos-select-compact"
              value={basis}
              onChange={(event) => setBasis(event.target.value as Basis)}
            >
              {BASES.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      {!categories.available ? (
        categories.reason === 'no_sales' ? (
          <ContextualEmpty title="No retail activity for this period">
            Try another date range, or start a sale. Categories appear once a bill has lines on it.
          </ContextualEmpty>
        ) : (
          <Unavailable title="No category to group these sales by">{categories.note}</Unavailable>
        )
      ) : slices.length === 0 ? (
        <ContextualEmpty title="Nothing to rank on this basis">
          Every category is zero when measured {BASES.find((b) => b.key === basis)?.label.toLowerCase()}.
        </ContextualEmpty>
      ) : (
        <>
          <div className="pos-category">
            <DonutChart
              slices={slices}
              centreValue={basis === 'amount' ? moneyCompact(total) : decimal(total, basis === 'qty' ? 1 : 0)}
              centreLabel={periodLabel}
              format={format}
              caption={`Top selling categories ${BASES.find((b) => b.key === basis)?.label.toLowerCase()}`}
            />

            <ul className="pos-category__legend">
              {slices.map((slice, index) => (
                <li key={slice.key} className="pos-category__row">
                  <DonutSwatch index={index} />
                  <span className="pos-category__name" title={slice.label}>
                    {slice.label}
                  </span>
                  <span className="pos-category__share">
                    {total > 0 ? percent((slice.value / total) * 100, 0) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="pos-note">
            {categories.coverage_pc !== null && categories.coverage_pc < 99.5 && (
              <>
                <strong>{percent(categories.coverage_pc, 0)} of this period is grouped.</strong>{' '}
                {money(categories.uncategorised)} sold under no category POS could resolve.{' '}
              </>
            )}
            {categories.source}
          </p>
        </>
      )}
    </Panel>
  )
}
