// Satsails brand identity (2026-07-18): black + orange, both a dark and
// a light theme, orange constant across both — matches the pasted
// design brief's own palette (WDK-inspired dark surfaces, Binance
// P2P-inspired information density), with a light counterpart added
// since the light theme wasn't in the original brief. Values are CSS
// custom properties defined in src/index.css's `:root`/`.dark` blocks,
// not hardcoded here, so a future white-label partner (docs/TODO.md's
// "roupagem" plan) swaps one file, not every component. Vars are stored
// as "R G B" triplets (not hex) specifically so Tailwind's opacity
// modifier syntax (`bg-brand-orange/15`, `border-brand-orange/25`)
// works — found while building this: a plain `var(--x)` string doesn't
// support `<alpha-value>` substitution, `rgb(var(--x) / <alpha-value>)`
// does.
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: 'rgb(var(--color-bg) / <alpha-value>)',
          surface: 'rgb(var(--color-surface) / <alpha-value>)',
          elevated: 'rgb(var(--color-elevated) / <alpha-value>)',
          border: 'rgb(var(--color-border) / <alpha-value>)',
          'border-hover': 'rgb(var(--color-border-hover) / <alpha-value>)',
          text: 'rgb(var(--color-text) / <alpha-value>)',
          'text-secondary': 'rgb(var(--color-text-secondary) / <alpha-value>)',
          'text-muted': 'rgb(var(--color-text-muted) / <alpha-value>)',
          orange: 'rgb(var(--color-orange) / <alpha-value>)',
          'orange-hover': 'rgb(var(--color-orange-hover) / <alpha-value>)',
          // Separate from `orange` above: that token is contrast-locked for
          // white-text-on-orange (buttons) in both themes. This one is for
          // orange-as-text/icon/accent on a brand SURFACE (never behind
          // white body text), so dark mode can use the fuller vibrant hue
          // — see src/index.css's own comment on `--color-orange-accent`.
          'orange-accent': 'rgb(var(--color-orange-accent) / <alpha-value>)',
          // UI-FOUNDATION-1 — semantic state colors (docs/SAILS_MARKET_DESIGN_DIRECTION.md
          // §3's success/warning/danger/info categories). `danger` reuses
          // the existing `--destructive` var rather than a second red —
          // see index.css's own comment.
          success: 'rgb(var(--color-success) / <alpha-value>)',
          warning: 'rgb(var(--color-warning) / <alpha-value>)',
          danger: 'rgb(var(--destructive) / <alpha-value>)',
          info: 'rgb(var(--color-info) / <alpha-value>)',
          'border-subtle': 'rgb(var(--color-border-subtle) / <alpha-value>)',
        },
        // shadcn/ui's expected token names (bg-background, bg-primary,
        // border-input, ring-ring, etc.) — aliased onto the same CSS vars
        // as `brand` above (see index.css's own comment) so components
        // added later via `npx shadcn add ...` pick up this theme instead
        // of shadcn's default palette.
        background: 'rgb(var(--background) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'rgb(var(--card) / <alpha-value>)',
          foreground: 'rgb(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'rgb(var(--popover) / <alpha-value>)',
          foreground: 'rgb(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          foreground: 'rgb(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'rgb(var(--secondary) / <alpha-value>)',
          foreground: 'rgb(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          foreground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--destructive) / <alpha-value>)',
          foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
        },
        border: 'rgb(var(--border) / <alpha-value>)',
        input: 'rgb(var(--input) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        // One family for UI and titles (display = ui since 2026-11-19);
        // routed through CSS vars so the dev-only typography study can
        // swap families at runtime. See index.css's `:root`.
        display: ['var(--sails-font-display)'],
        mono: ['var(--sails-font-mono)'],
      },
      // Responsive scale lives in index.css (--t-*); overriding the theme
      // keys keeps these real utilities, so `sm:text-base` etc. still win.
      fontSize: {
        xs: ['var(--t-meta)', { lineHeight: 'var(--t-meta-lh)' }],
        sm: ['var(--t-body)', { lineHeight: 'var(--t-body-lh)' }],
      },
    },
  },
  plugins: [],
}
