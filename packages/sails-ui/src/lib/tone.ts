/**
 * Design System tones (DESIGN_SYSTEM.md): tint + decorative border + AA
 * text for chips, badges and notices, one meaning each. Plain utility
 * strings (not CSS classes) so cn()/twMerge resolves them against a base
 * like badgeVariants' `text-foreground`. buy/sell are trade side, never status.
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'buy' | 'sell'

export const TONE_CLASS: Record<Tone, string> = {
  // Subtle border like the other tones' base/25 (a full 3:1 border made neutral look heavier than danger).
  neutral: 'border-brand-border-subtle bg-brand-elevated text-brand-text-secondary',
  info: 'border-brand-info-border bg-brand-info-bg text-brand-info-fg',
  success: 'border-brand-success-border bg-brand-success-bg text-brand-success-fg',
  warning: 'border-brand-warning-border bg-brand-warning-bg text-brand-warning-fg',
  danger: 'border-brand-danger-border bg-brand-danger-bg text-brand-danger-fg',
  buy: 'border-brand-buy-border bg-brand-buy-bg text-brand-buy-fg',
  sell: 'border-brand-sell-border bg-brand-sell-bg text-brand-sell-fg',
}
