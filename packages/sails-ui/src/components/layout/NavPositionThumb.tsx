import type { NavPosition } from '../../lib/navPosition'
import { cn } from '../../lib/utils'

/**
 * Schematic miniature of a desktop layout (Settings → Aparência → "Posição do menu"): a page with the menu
 * on the side or on top. Decorative (the radio label names the option), drawn with tokens only, so it
 * follows the theme and white-label colors. The orange mark stands for the logo, the bars for content.
 */
export function NavPositionThumb({ position, className }: { position: NavPosition; className?: string }) {
  const top = position === 'top'
  return (
    <span aria-hidden="true" className={cn('flex h-9 w-14 shrink-0 overflow-hidden rounded-sm bg-brand-bg', top && 'flex-col', className)}>
      <span className={cn('flex shrink-0 gap-0.5 bg-brand-text-secondary/30 p-0.5', top ? 'h-2.5 items-center' : 'w-3.5 flex-col items-center')}>
        <span className="size-1.5 rounded-full bg-brand-orange-accent" />
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn('rounded-full bg-brand-text-secondary/60', top ? 'h-0.5 w-1.5' : 'h-0.5 w-2')} />
        ))}
      </span>
      <span className="flex flex-1 flex-col gap-1 p-1">
        <span className="h-1 w-3/4 rounded-full bg-brand-text-secondary/25" />
        <span className="h-1 w-1/2 rounded-full bg-brand-text-secondary/25" />
      </span>
    </span>
  )
}
