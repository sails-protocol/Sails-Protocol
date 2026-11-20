import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // DESIGN-LANGUAGE-1 §2.3 — a bare `type="number"` renders the
          // browser's own up/down spinner (Chrome/Edge/Safari) or relies
          // on Firefox's textfield appearance; both are native browser
          // chrome that doesn't exist anywhere else in the Sails token
          // system. Suppressed here (the shared primitive every numeric
          // field in the app already uses) rather than per-callsite, so
          // no future numeric input silently reintroduces it. `type`
          // semantics (numeric keyboard on mobile, native validation)
          // are unaffected — only the rendered spinner chrome is removed.
          "flex h-11 md:h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm [-moz-appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
