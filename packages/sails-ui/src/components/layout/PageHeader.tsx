import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

const WIDTHS = {
  /** Collections (Market, Trades, Disputas): the full content width. */
  list: 'max-w-7xl',
  /** One object (offer detail, Perfil): main column + optional sticky aside. */
  detail: 'max-w-6xl',
  /** Forms (Publicar oferta): one readable column, left-aligned with every other page. */
  form: 'max-w-2xl',
  /** Long prose (explanations, dispute text): a 68-character reading measure. */
  prose: 'max-w-[68ch]',
} as const

export type PageWidth = keyof typeof WIDTHS

/** Page width wrapper (DESIGN_SYSTEM.md 4.1 layout table). Left-aligned so every page's header starts on the same line. */
export function Page({ width = 'list', className, children }: { width?: PageWidth; className?: string; children: ReactNode }) {
  return <div className={cn('w-full', WIDTHS[width], className)}>{children}</div>
}

export interface PageHeaderProps {
  title: ReactNode
  /** One muted line under the title (counts, context). */
  meta?: ReactNode
  /** Marks the meta line as a polite live region (e.g. a result count that changes with filters). */
  metaLive?: boolean
  /** Optional back link above the title (the caller supplies the link: no routing here). */
  back?: ReactNode
  /** Right side: secondary controls plus at most ONE primary (solid) action per page. */
  actions?: ReactNode
  /** Optional tabs / sub-navigation under the meta line. */
  children?: ReactNode
  className?: string
}

/**
 * Layer A page header: back link (optional), h1 on the left, actions on the right, meta line under the
 * title, optional tabs. One rule on phones (below sm): the actions move under the title, full width, so
 * the primary action stays visible with its label. All copy comes through props; styled only with tokens.
 */
export function PageHeader({ title, meta, metaLive, back, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-6', className)}>
      {back && <div className="mb-2">{back}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-[1_1_12rem]">
          <h1 className="text-page-title">{title}</h1>
          {meta !== undefined && (
            <p className="text-metadata mt-1" role={metaLive ? 'status' : undefined}>{meta}</p>
          )}
        </div>
        {actions && <div className="flex w-full items-center gap-3 sm:w-auto sm:shrink-0 max-sm:[&>*]:flex-1">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  )
}
