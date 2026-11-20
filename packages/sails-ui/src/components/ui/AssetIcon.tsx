/**
 * DESIGN-LANGUAGE-1 §6/§22 — first representative asset/token icon
 * pattern. `docs/SAILS_DESIGN_LANGUAGE.md` §5's iconography evaluation
 * found Lucide (this app's existing icon set) has no crypto/asset brand
 * marks at all — it's a generic UI icon set, correctly scoped to nav/
 * action/status icons, not asset identity. Rather than adopt a real logo
 * library sight-unseen (license/bundle/coverage unevaluated — exactly
 * what that section says not to do), this is an honest, real, minimal
 * placeholder: a tonal monogram badge, keyed off the same
 * `ASSET_SHORT_LABELS` (lib/labels.ts) already shown as text everywhere
 * else. Swapping in real per-asset logos later only touches this file —
 * every call site stays the same.
 *
 * The per-asset accent colors below are a THIRD, separate axis from the
 * brand tokens (`--color-orange*`) and semantic-state tokens
 * (`--color-success/warning/danger/info`) in index.css — asset identity,
 * not brand identity and not a risk/state signal. They must never be
 * reused for meaning (e.g. never repurpose the BTC orange as a "warning"
 * color) — see the Design Language doc's own note on this.
 */
import type { AssetType } from '../../types'
import { ASSET_SHORT_LABELS } from '../../lib/labels'
import { cn } from '../../lib/utils'

interface AssetAccent {
  glyph: string
  className: string
}

// Grouped by real underlying asset family, not by AssetType 1:1 — every
// BTC-settlement-rail variant (on-chain/Ark/Liquid/RSK) is still
// recognizably "Bitcoin" to a person scanning a list, same for the
// multi-rail USDT/USDC families. This is a display grouping only; it
// does not collapse or alias the underlying `AssetType`/`SettlementRail`
// values themselves anywhere.
const ASSET_ACCENTS: Partial<Record<AssetType, AssetAccent>> = {
  BTC: { glyph: '₿', className: 'bg-orange-500/15 text-orange-500' },
  LN_BTC: { glyph: '₿', className: 'bg-orange-500/15 text-orange-500' },
  LIQUID_BTC: { glyph: '₿', className: 'bg-orange-500/15 text-orange-500' },
  RSK_BTC: { glyph: '₿', className: 'bg-orange-500/15 text-orange-500' },
  WBTC: { glyph: '₿', className: 'bg-orange-500/15 text-orange-500' },
  SBTC_STACKS: { glyph: '₿', className: 'bg-orange-500/15 text-orange-500' },
  USDT_ERC20: { glyph: 'U', className: 'bg-emerald-500/15 text-emerald-500' },
  USDT_TRC20: { glyph: 'U', className: 'bg-emerald-500/15 text-emerald-500' },
  USDT_LIQUID: { glyph: 'U', className: 'bg-emerald-500/15 text-emerald-500' },
  USDT_LIGHTNING: { glyph: 'U', className: 'bg-emerald-500/15 text-emerald-500' },
  USDC_ERC20: { glyph: 'U', className: 'bg-blue-500/15 text-blue-500' },
  USDC_POLYGON: { glyph: 'U', className: 'bg-blue-500/15 text-blue-500' },
  USDC_BASE: { glyph: 'U', className: 'bg-blue-500/15 text-blue-500' },
  USDCX_STACKS: { glyph: 'U', className: 'bg-blue-500/15 text-blue-500' },
  DEPIX: { glyph: 'D', className: 'bg-green-600/15 text-green-600' },
  ETH: { glyph: 'Ξ', className: 'bg-indigo-500/15 text-indigo-500' },
  BNB: { glyph: 'B', className: 'bg-yellow-500/15 text-yellow-600' },
  SOL: { glyph: 'S', className: 'bg-purple-500/15 text-purple-500' },
  LTC: { glyph: 'L', className: 'bg-slate-400/15 text-slate-400' },
  STACKS: { glyph: 'S', className: 'bg-orange-400/15 text-orange-400' },
  SPARK: { glyph: 'S', className: 'bg-amber-500/15 text-amber-500' },
}

const FALLBACK_CLASSNAME = 'bg-brand-elevated text-brand-text-muted'

export function AssetIcon({ asset, className }: { asset: AssetType; className?: string }) {
  const accent = ASSET_ACCENTS[asset]
  const glyph = accent?.glyph ?? ASSET_SHORT_LABELS[asset]?.[0] ?? '?'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        accent?.className ?? FALLBACK_CLASSNAME,
        className
      )}
    >
      {glyph}
    </span>
  )
}
