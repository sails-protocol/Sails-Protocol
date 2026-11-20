import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

// Disabled (DESIGN_SYSTEM.md 5.2): M3 container 12 % / content 38 % of the text color, no brand
// color, so a disabled primary no longer reads as an orange action. `aria-disabled` gets the same look.
const DISABLED_FILLED = "disabled:bg-brand-disabled-container disabled:text-brand-disabled-content aria-disabled:bg-brand-disabled-container aria-disabled:text-brand-disabled-content"
const DISABLED_QUIET = "disabled:text-brand-disabled-content aria-disabled:text-brand-disabled-content"

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-control font-medium transition-colors duration-short ease-standard disabled:pointer-events-none disabled:cursor-not-allowed aria-disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Hover/pressed are state layers (5.2): white over the dark label of the orange primary.
        default: cn("bg-primary text-primary-foreground state-layer state-layer-light", DISABLED_FILLED),
        // White label -> black layer, so the label only gains contrast.
        destructive: cn("bg-destructive text-destructive-foreground state-layer state-layer-dark", DISABLED_FILLED),
        // Tonal (5.1): filled one step off whatever surface it sits on, no outline. The text label
        // identifies the button, so no 3:1 boundary is required (WCAG 1.4.11 Understanding).
        secondary: cn("bg-brand-tonal text-brand-text state-layer", DISABLED_FILLED),
        // Deprecated alias of `secondary`, kept so existing callers keep working.
        outline: cn("bg-brand-tonal text-brand-text state-layer", DISABLED_FILLED),
        // Quiet, low-emphasis: no fill until hover.
        ghost: cn("text-brand-text state-layer", DISABLED_QUIET),
        // Trade side (DESIGN_SYSTEM.md 5.1): only for the action that IS a side ("Comprar" / "Vender"),
        // never for status. Solid = the one primary on the offer ticket (replaces orange there);
        // tonal = the row action in the Market list. Solid: white label + black layer (light), dark label + white layer (dark).
        buy: cn("bg-brand-buy-solid text-brand-on-buy state-layer state-layer-dark dark:state-layer-light", DISABLED_FILLED),
        sell: cn("bg-brand-sell-solid text-brand-on-sell state-layer state-layer-dark dark:state-layer-light", DISABLED_FILLED),
        "buy-tonal": cn("bg-brand-buy-bg text-brand-buy-fg state-layer state-layer-buy", DISABLED_FILLED),
        "sell-tonal": cn("bg-brand-sell-bg text-brand-sell-fg state-layer state-layer-sell", DISABLED_FILLED),
        // Brand link token (blue): orange means "act", never "go to" (DESIGN_SYSTEM.md 2).
        link: cn("text-brand-link underline-offset-4 hover:underline", DISABLED_QUIET),
      },
      // Fine pointer: 40 / 36 / 44; `touch:` (coarse pointer or < 768 px) raises every size to 44.
      size: {
        default: "h-10 px-4 py-2 touch:min-h-11",
        sm: "h-9 px-3 touch:min-h-11",
        lg: "h-11 px-5",
        icon: "h-10 w-10 touch:h-11 touch:w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /**
   * Work in progress (5.2): keeps the enabled look and its width, shows a spinner in place of
   * the label, sets aria-busy and ignores clicks. Not the same as disabled (unavailable).
   */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, onClick, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    if (asChild || !loading) {
      return (
        <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} onClick={onClick} {...props}>
          {children}
        </Comp>
      )
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), "cursor-progress")}
        ref={ref}
        aria-busy="true"
        onClick={(e) => e.preventDefault()}
        {...props}
      >
        {/* Label stays in the accessible name and keeps the width; the spinner sits on top. */}
        <span className="inline-flex items-center gap-2 opacity-0">{children}</span>
        <Loader2 aria-hidden="true" className="absolute motion-safe:animate-spin" />
      </button>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
