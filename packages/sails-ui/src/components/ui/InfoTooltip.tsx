// Real Radix Tooltip (2026-08-01) — replaces a hand-rolled hover/click
// span that only ever responded to mouse events. A keyboard-only user
// tabbing to the "i" button had no way to see this text at all before —
// Tooltip.Trigger shows/hides on focus/blur too, not just hover/click.
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'
import { useUiStrings } from './uiStrings'

export function InfoTooltip({ text }: { text: string }) {
  const strings = useUiStrings()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* p/-m 14px (44px; px so 200% text does not double the overhang past the line end) on the button, visible circle kept on the inner span
            (2026-08-01): the 16px badge is the intended look everywhere
            it's used inline next to a label, but as the actual button
            box it was also a 16px tap target — real mobile-testing find,
            not hypothetical, same class of fix as FavoriteButton's own. */}
        <button type="button" aria-label={strings.moreInfo} className="group p-[14px] -m-[14px] flex items-center justify-center">
          <span className="w-4 h-4 rounded-full border border-brand-border text-brand-text-muted text-xs flex items-center justify-center transition-colors group-hover:border-brand-orange-accent group-hover:text-brand-orange-accent">
            i
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="w-56 text-xs normal-case font-normal">{text}</TooltipContent>
    </Tooltip>
  )
}
