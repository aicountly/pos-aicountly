/**
 * The layout editor's memory.
 *
 * Nothing here touches the server. Dragging a table writes to local state and
 * to an undo stack, and the server hears about it once, when Save is pressed —
 * because a floor plan saved a pixel at a time is a floor plan that cannot be
 * undone, and because a manager rearranging a room at four o'clock should not
 * be changing what the waiters are looking at until they have finished.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { PlacedTable } from './FloorMap'

interface Snapshot {
  tables: PlacedTable[]
  removed: number[]
}

export interface LayoutEditor {
  active: boolean
  tables: PlacedTable[]
  removed: ReadonlySet<number>
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  begin: (tables: PlacedTable[]) => void
  cancel: () => void
  /** Continuous change during a drag: no history entry until commit(). */
  moveTo: (tableId: number, x: number, y: number) => void
  /** One discrete change, recorded straight into history. */
  update: (tableId: number, patch: Partial<PlacedTable>) => void
  commit: () => void
  toggleRemoved: (tableId: number) => void
  undo: () => void
  redo: () => void
  /** The payload the save endpoint takes. */
  payload: () => { tables: unknown[]; removed_table_ids: number[] }
}

function clone(tables: PlacedTable[]): PlacedTable[] {
  return tables.map((table) => ({ ...table }))
}

function same(a: Snapshot, b: Snapshot): boolean {
  if (a.removed.length !== b.removed.length) return false
  if (a.tables.length !== b.tables.length) return false

  return a.tables.every((table, index) => {
    const other = b.tables[index]

    return (
      table.table_id === other.table_id &&
      table.x === other.x &&
      table.y === other.y &&
      table.shape === other.shape &&
      table.seats === other.seats &&
      table.table_code === other.table_code &&
      table.table_name === other.table_name &&
      table.zone_name === other.zone_name &&
      table.min_covers === other.min_covers &&
      table.max_covers === other.max_covers
    )
  })
}

export function useLayoutEditor(): LayoutEditor {
  const [active, setActive] = useState(false)
  const [tables, setTables] = useState<PlacedTable[]>([])
  const [removed, setRemoved] = useState<Set<number>>(() => new Set())
  const [history, setHistory] = useState<Snapshot[]>([])
  const [cursor, setCursor] = useState(-1)

  // The state the editor opened with. Compared against, so closing without
  // changing anything does not warn about unsaved work.
  const origin = useRef<Snapshot | null>(null)

  const begin = useCallback((next: PlacedTable[]) => {
    const snapshot: Snapshot = { tables: clone(next), removed: [] }
    origin.current = { tables: clone(next), removed: [] }
    setTables(snapshot.tables)
    setRemoved(new Set())
    setHistory([snapshot])
    setCursor(0)
    setActive(true)
  }, [])

  const cancel = useCallback(() => {
    setActive(false)
    setTables([])
    setRemoved(new Set())
    setHistory([])
    setCursor(-1)
    origin.current = null
  }, [])

  const record = useCallback(
    (nextTables: PlacedTable[], nextRemoved: Set<number>) => {
      setHistory((current) => {
        const trimmed = current.slice(0, cursor + 1)
        trimmed.push({ tables: clone(nextTables), removed: [...nextRemoved] })

        // Twenty steps is more than anybody undoes and far less than a memory
        // leak on a floor with a hundred tables.
        const capped = trimmed.slice(-20)
        setCursor(capped.length - 1)

        return capped
      })
    },
    [cursor],
  )

  const moveTo = useCallback((tableId: number, x: number, y: number) => {
    setTables((current) =>
      current.map((table) => (table.table_id === tableId ? { ...table, x, y } : table)),
    )
  }, [])

  const commit = useCallback(() => {
    setTables((current) => {
      record(current, removed)
      return current
    })
  }, [record, removed])

  const update = useCallback(
    (tableId: number, patch: Partial<PlacedTable>) => {
      setTables((current) => {
        const next = current.map((table) => (table.table_id === tableId ? { ...table, ...patch } : table))
        record(next, removed)

        return next
      })
    },
    [record, removed],
  )

  const toggleRemoved = useCallback(
    (tableId: number) => {
      setRemoved((current) => {
        const next = new Set(current)
        if (next.has(tableId)) next.delete(tableId)
        else next.add(tableId)
        record(tables, next)

        return next
      })
    },
    [record, tables],
  )

  const goTo = useCallback(
    (index: number) => {
      const snapshot = history[index]
      if (!snapshot) return
      setTables(clone(snapshot.tables))
      setRemoved(new Set(snapshot.removed))
      setCursor(index)
    },
    [history],
  )

  const undo = useCallback(() => goTo(cursor - 1), [goTo, cursor])
  const redo = useCallback(() => goTo(cursor + 1), [goTo, cursor])

  const dirty = useMemo(() => {
    if (!active || !origin.current) return false

    return !same({ tables, removed: [...removed] }, origin.current)
  }, [active, tables, removed])

  const payload = useCallback(
    () => ({
      tables: tables
        .filter((table) => !removed.has(table.table_id))
        .map((table) => ({
          table_id: table.table_id,
          table_code: table.table_code,
          table_name: table.table_name,
          seats: table.seats,
          min_covers: table.min_covers,
          max_covers: table.max_covers,
          zone_name: table.zone_name,
          shape: table.shape,
          layout_x: table.x,
          layout_y: table.y,
          layout_w: table.layout_w,
          layout_h: table.layout_h,
        })),
      removed_table_ids: [...removed],
    }),
    [tables, removed],
  )

  return {
    active,
    tables,
    removed,
    dirty,
    canUndo: cursor > 0,
    canRedo: cursor >= 0 && cursor < history.length - 1,
    begin,
    cancel,
    moveTo,
    update,
    commit,
    toggleRemoved,
    undo,
    redo,
    payload,
  }
}
