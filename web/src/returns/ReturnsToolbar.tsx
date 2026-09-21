/**
 * The tabs and the controls above the register.
 *
 * The four tabs are the four questions a supervisor actually asks — everything,
 * money back, swapped, and what is still waiting on somebody — and their counts
 * come from the server's summary rather than from the page on screen, so
 * "Pending (3)" means three in the whole window and not three on this page.
 *
 * Search is debounced and, like every other control here, ends up in the URL:
 * this whole bar is a view of the query string.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, Download, Filter, Printer, Search, X } from 'lucide-react'
import { count } from '../dashboards/format'
import { MenuButton } from './Menu'
import { formatRange, PERIODS, periodFor } from './periods'
import type { RegisterTab } from './types'
import type { ReturnFilters } from './useReturnsRegister'

const TABS: Array<{ id: RegisterTab; label: string; hint: string }> = [
  { id: 'all', label: 'All returns', hint: 'Every return in this window' },
  { id: 'refunds', label: 'Refunds', hint: 'Cash, original mode, credit note and store credit' },
  { id: 'exchanges', label: 'Exchanges', hint: 'Settled by replacing the goods' },
  { id: 'pending', label: 'Pending', hint: 'Draft, approved or received — not yet settled' },
]

function DateRangeButton({
  from,
  to,
  onChange,
}: {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = periodFor(from, to)

  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="returns-menu" ref={rootRef}>
      <button
        type="button"
        className="returns-button returns-button--secondary"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarDays size={15} aria-hidden />
        {formatRange(from, to)}
      </button>

      {open && (
        <div className="returns-menu__list returns-menu__list--panel" role="dialog" aria-label="Choose a date range">
          <div className="returns-daterange__presets">
            {PERIODS.map((period) => (
              <button
                key={period.id}
                type="button"
                className={
                  active?.id === period.id ? 'returns-chip returns-chip--active' : 'returns-chip'
                }
                onClick={() => {
                  onChange(period.range())
                  setOpen(false)
                }}
              >
                {period.label}
              </button>
            ))}
          </div>

          <div className="returns-daterange__custom">
            <label>
              <span>From</span>
              <input type="date" value={from} max={to} onChange={(event) => onChange({ from: event.target.value, to })} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={to} min={from} onChange={(event) => onChange({ from, to: event.target.value })} />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

export function ReturnsToolbar({
  filters,
  counts,
  activeFilterCount,
  searchRef,
  exporting,
  onTab,
  onSearch,
  onRange,
  onOpenFilters,
  onExport,
  onPrint,
}: {
  filters: ReturnFilters
  counts: { all: number; refunds: number; exchanges: number; pending: number } | null
  activeFilterCount: number
  searchRef: React.RefObject<HTMLInputElement | null>
  exporting: boolean
  onTab: (tab: RegisterTab) => void
  onSearch: (term: string) => void
  onRange: (range: { from: string; to: string }) => void
  onOpenFilters: () => void
  onExport: () => void
  onPrint: () => void
}) {
  const [term, setTerm] = useState(filters.search)
  const pushed = useRef(filters.search)

  // The URL wins when it changes from anywhere else — a chip cleared, the back
  // button — but not while somebody is mid-word.
  useEffect(() => {
    if (filters.search !== pushed.current) {
      pushed.current = filters.search
      setTerm(filters.search)
    }
  }, [filters.search])

  useEffect(() => {
    if (term === pushed.current) return undefined

    const timer = window.setTimeout(() => {
      pushed.current = term
      onSearch(term)
    }, 300)

    return () => window.clearTimeout(timer)
  }, [term, onSearch])

  const clear = useCallback(() => {
    pushed.current = ''
    setTerm('')
    onSearch('')
    searchRef.current?.focus()
  }, [onSearch, searchRef])

  return (
    <div className="returns-register__head">
      <nav className="returns-tabs" aria-label="Return types">
        {TABS.map((tab) => {
          const value = counts ? counts[tab.id] : null

          return (
            <button
              key={tab.id}
              type="button"
              className={filters.tab === tab.id ? 'returns-tab returns-tab--active' : 'returns-tab'}
              aria-current={filters.tab === tab.id ? 'true' : undefined}
              title={tab.hint}
              onClick={() => onTab(tab.id)}
            >
              {tab.label}
              <span className="returns-tab__count num">{value === null ? '' : `(${count(value)})`}</span>
            </button>
          )
        })}
      </nav>

      <div className="returns-tools">
        <div className="returns-search">
          <Search size={15} aria-hidden className="returns-search__icon" />
          <input
            ref={searchRef}
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search by return no., bill no., customer, item…"
            aria-label="Search returns by return number, bill number, customer or item"
          />
          {term !== '' && (
            <button type="button" className="returns-search__clear" onClick={clear} aria-label="Clear the search">
              <X size={14} aria-hidden />
            </button>
          )}
          <kbd className="returns-search__kbd" aria-hidden>
            Ctrl K
          </kbd>
        </div>

        <button
          type="button"
          className={
            activeFilterCount > 0
              ? 'returns-button returns-button--secondary returns-button--on'
              : 'returns-button returns-button--secondary'
          }
          onClick={onOpenFilters}
        >
          <Filter size={15} aria-hidden />
          Filter
          {activeFilterCount > 0 && <span className="returns-button__badge">{activeFilterCount}</span>}
        </button>

        <DateRangeButton from={filters.from} to={filters.to} onChange={onRange} />

        <MenuButton
          label={exporting ? 'Exporting…' : 'Export'}
          icon={<Download size={15} aria-hidden />}
          actions={[
            {
              key: 'csv',
              label: 'Download CSV',
              icon: <Download size={15} aria-hidden />,
              onSelect: onExport,
              disabled: exporting,
              hint: 'Every row this filter matches',
            },
            {
              key: 'print',
              label: 'Print this view',
              icon: <Printer size={15} aria-hidden />,
              onSelect: onPrint,
            },
            {
              key: 'pdf',
              label: 'Download PDF',
              onSelect: () => undefined,
              disabled: true,
              hint: 'No PDF service on this product yet — print to PDF instead',
            },
          ]}
        />
      </div>
    </div>
  )
}
