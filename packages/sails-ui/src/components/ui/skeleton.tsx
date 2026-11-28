import { cn } from '../../lib/utils'

/** A token-styled placeholder block; decorative, so hidden from assistive tech. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('motion-safe:animate-pulse rounded-md bg-brand-elevated', className)} />
}

export interface ListSkeletonProps {
  /** Announced to screen readers while loading (caller-supplied copy, no hardcoded language). */
  label: string
  rows?: number
  /** Height/padding of one row, matched to the final row so the layout does not jump. */
  rowClassName?: string
  className?: string
}

/** Rows of placeholder lines shaped like a list or table row. */
export function ListSkeleton({ label, rows = 4, rowClassName, className }: ListSkeletonProps) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn('flex items-center gap-4 border-b border-brand-border-subtle px-4 last:border-b-0', rowClassName)}>
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
