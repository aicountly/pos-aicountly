/**
 * Downloading what is on the screen.
 *
 * CSV, and only CSV. This product has no PDF or spreadsheet writer, on the
 * server or in the browser, and adding one to put three tables in a file would
 * be a large dependency for a small job — so the menu offers what actually
 * works rather than three items where two produce a CSV with the wrong
 * extension. Every row written here is a row the board already fetched and the
 * viewer is already allowed to see, so exporting grants nobody anything: the
 * endpoint's own permission check has already happened.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Download } from 'lucide-react'

export type CsvRow = Record<string, string | number | null | undefined>

/**
 * RFC 4180 quoting, plus the one thing it does not cover.
 *
 * A leading `=`, `+`, `-` or `@` makes a spreadsheet treat the cell as a
 * formula, which is a real injection route out of an innocent-looking export.
 * Those cells are prefixed with an apostrophe, which spreadsheets read as
 * "this is text" and strip on display.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const raw = String(value)
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw

  return /["\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return ''

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))]

  return lines.join('\r\n')
}

export function downloadCsv(filename: string, rows: CsvRow[]): void {
  const csv = toCsv(rows)
  if (csv === '') return

  // The BOM is what makes Excel open a UTF-8 CSV as UTF-8 rather than as the
  // system codepage, which is the difference between "Kirana" and "KiranaÂ ".
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export interface ExportOption {
  key: string
  label: string
  /** Called on click. Returning nothing is fine — the option may be a no-op. */
  run: () => void
  disabled?: boolean
}

/**
 * The Export button.
 *
 * A real menu: Escape closes it, a click outside closes it, and focus goes
 * back to the button. A dropdown that can only be dismissed with the mouse is
 * a dropdown a keyboard user is stuck in.
 */
export function ExportMenu({ options, disabled = false }: { options: ExportOption[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    const onClick = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <div className="pos-menu" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className="pos-button pos-button--secondary"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled || options.length === 0}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
      >
        <Download size={15} aria-hidden />
        Export
        <ChevronDown size={14} aria-hidden />
      </button>

      {open && (
        <div className="pos-menu__panel" id={id} role="menu">
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitem"
              className="pos-menu__item"
              disabled={option.disabled}
              onClick={() => {
                option.run()
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
