/**
 * Layer A: table (DESIGN_SYSTEM.md 5.3). Real <table> parts for data shown as
 * a table at every width (OfferTable), and the same header/row look as class
 * strings for the responsive list-tables (Trades, Perfil, Disputas), which are
 * lists that fold into rows below lg/xl and keep their list semantics.
 * Header: caption 500, muted, sentence case; optional sticky (surface 95 % +
 * blur). Rows: one hairline, hover/pressed via the state layer. Numeric cells
 * right-aligned and tabular (`numeric`). Sortable header: a button inside the
 * th, `aria-sort` on the th, icon ArrowUpDown / ArrowUp / ArrowDown. Empty or
 * error: `TableEmpty` (StateBlock bare) in a full-width row.
 */
import * as React from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { StateBlock, type StateBlockProps } from './StateBlock'
import { ariaSort, type SortState } from '../../lib/sort'

/** Header row of a list-table (grid of spans, aria-hidden: each row names its own cells). */
export const TABLE_HEAD_ROW = 'text-caption font-medium text-brand-text-muted px-4 py-2.5 border-b border-brand-border-subtle'
/** One row of a list-table or table: hairline + state layer; the last row has none. */
export const TABLE_ROW = 'border-b border-brand-border-subtle last:border-b-0'
export const TABLE_ROW_INTERACTIVE = 'transition-colors duration-short state-layer focus-visible:-outline-offset-2'

export function Table({ className, sticky, ...props }: React.TableHTMLAttributes<HTMLTableElement> & { sticky?: boolean }) {
  return <table data-sticky={sticky || undefined} className={cn('group/table w-full border-collapse text-left', className)} {...props} />
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      // Sticky header sits on the surface at 95 % with blur, so rows scrolling under it stay legible.
      className={cn('group-data-[sticky]/table:sticky group-data-[sticky]/table:top-0 group-data-[sticky]/table:z-10 group-data-[sticky]/table:bg-brand-surface/95 group-data-[sticky]/table:backdrop-blur', className)}
      {...props}
    />
  )
}

export const TableBody = (props: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />

export function TableRow({ className, interactive, ...props }: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return <tr className={cn('border-t border-brand-border-subtle', interactive && 'transition-colors duration-short state-layer', className)} {...props} />
}

export function TableHead({ className, numeric, ...props }: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th scope="col" className={cn('py-2.5 px-4 text-caption font-medium text-brand-text-muted', numeric && 'text-right', className)} {...props} />
}

export function TableCell({ className, numeric, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cn('py-3 px-4', numeric && 'text-right tabular-nums', className)} {...props} />
}

/** Sortable column header: the button is the one tab stop; aria-sort lives on the th. */
export function SortableTableHead<K extends string>({ column, sort, onSort, numeric, className, children }: {
  column: K
  sort: SortState<K> | null
  onSort: (column: K) => void
  numeric?: boolean
  className?: string
  children: React.ReactNode
}) {
  const state = ariaSort(sort, column)
  const Icon = state === 'ascending' ? ArrowUp : state === 'descending' ? ArrowDown : ArrowUpDown
  return (
    <th scope="col" aria-sort={state} className={cn('py-1 px-2 text-caption font-medium text-brand-text-muted', numeric && 'text-right', className)}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn('inline-flex min-h-8 touch:min-h-11 items-center gap-1 rounded-sm px-2 state-layer hover:text-brand-text', numeric && 'flex-row-reverse', state !== 'none' && 'text-brand-text')}
      >
        {children}
        <Icon aria-hidden="true" className="size-icon-sm" />
      </button>
    </th>
  )
}

/** Empty / error / loading state inside a table: one full-width row holding a bare StateBlock. */
export function TableEmpty({ colSpan, ...state }: StateBlockProps & { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <StateBlock bare {...state} />
      </td>
    </tr>
  )
}
