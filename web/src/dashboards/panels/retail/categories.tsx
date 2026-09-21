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
import { DonutChart } from '../../charts'
import { compactMoney, decimal, money, percent } from '../../format'
import { EmptyState, Panel, Unavailable } from '../../shell'
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

  const format =
    basis === 'amount' ? (value: number) => compactMoney(value) : (value: number) => decimal(value, basis === 'qty' ? 2 : 0)

  return (
    <Panel
      title="Top selling categories"
      action={
        categories.available && (
          <label className="pos-field">
            <span className="pos-visually-hidden">Rank categories by</span>
            <select
              className="pos-select"
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
          <EmptyState title="No retail activity for this period">
            Try another date range, or start a sale. Categories appear once a bill has lines on it.
          </EmptyState>
        ) : (
          <Unavailable title="No category to group these sales by">{categories.note}</Unavailable>
        )
      ) : slices.length === 0 ? (
        <EmptyState title="Nothing to rank on this basis">
          Every category is zero when measured {BASES.find((b) => b.key === basis)?.label.toLowerCase()}.
        </EmptyState>
      ) : (
        <>
          <DonutChart
            slices={slices.map((slice) => ({
              key: slice.key,
              label: slice.label,
              value: slice.value,
            }))}
            format={format}
            centreLabel={periodLabel}
            caption={`Top selling categories ${BASES.find((b) => b.key === basis)?.label.toLowerCase()}`}
          />

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
