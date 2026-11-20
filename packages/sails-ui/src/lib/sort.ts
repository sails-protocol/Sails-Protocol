/**
 * Table sorting (DESIGN_SYSTEM.md 5.3, Table). Pure helpers so the sort order
 * and the header's aria-sort come from one place and are unit-tested.
 */
export type SortDirection = 'ascending' | 'descending'
export interface SortState<K extends string = string> {
  key: K
  direction: SortDirection
}

/** Header click: a new column starts ascending, the same column flips. */
export function nextSort<K extends string>(current: SortState<K> | null, key: K): SortState<K> {
  if (current?.key !== key) return { key, direction: 'ascending' }
  return { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
}

/** aria-sort value for a sortable column header. */
export function ariaSort(current: SortState | null, key: string): 'ascending' | 'descending' | 'none' {
  return current?.key === key ? current.direction : 'none'
}

/**
 * Stable sort by one accessor. Numbers compare numerically, strings with pt-BR
 * collation (accents, "10" after "9"); null/undefined always go last, in both directions.
 */
export function sortRows<T>(rows: readonly T[], sort: SortState | null, accessor: (row: T, key: string) => string | number | null | undefined): T[] {
  if (!sort) return [...rows]
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })
  const sign = sort.direction === 'ascending' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: accessor(row, sort.key) }))
    .sort((a, b) => {
      const an = a.v == null, bn = b.v == null
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1
      const d = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : collator.compare(String(a.v), String(b.v))
      return d !== 0 ? d * sign : a.i - b.i
    })
    .map((x) => x.row)
}
