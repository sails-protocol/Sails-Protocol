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
 * (`--color-success/warning/danger/info`) in index.css — asset identity
 * (`--color-asset-*`, theme-independent),
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
  BTC: { glyph: '₿', className: 'bg-asset-btc/15 text-asset-btc' },
  LN_BTC: { glyph: '₿', className: 'bg-asset-btc/15 text-asset-btc' },
  LIQUID_BTC: { glyph: '₿', className: 'bg-asset-btc/15 text-asset-btc' },
  RSK_BTC: { glyph: '₿', className: 'bg-asset-btc/15 text-asset-btc' },
  WBTC: { glyph: '₿', className: 'bg-asset-btc/15 text-asset-btc' },
  SBTC_STACKS: { glyph: '₿', className: 'bg-asset-btc/15 text-asset-btc' },
  USDT_ERC20: { glyph: 'U', className: 'bg-asset-usdt/15 text-asset-usdt' },
  USDT_TRC20: { glyph: 'U', className: 'bg-asset-usdt/15 text-asset-usdt' },
  USDT_LIQUID: { glyph: 'U', className: 'bg-asset-usdt/15 text-asset-usdt' },
  USDT_LIGHTNING: { glyph: 'U', className: 'bg-asset-usdt/15 text-asset-usdt' },
  USDC_ERC20: { glyph: 'U', className: 'bg-asset-usdc/15 text-asset-usdc' },
  USDC_POLYGON: { glyph: 'U', className: 'bg-asset-usdc/15 text-asset-usdc' },
  USDC_BASE: { glyph: 'U', className: 'bg-asset-usdc/15 text-asset-usdc' },
  USDCX_STACKS: { glyph: 'U', className: 'bg-asset-usdc/15 text-asset-usdc' },
  DEPIX: { glyph: 'D', className: 'bg-asset-depix/15 text-asset-depix' },
  ETH: { glyph: 'Ξ', className: 'bg-asset-eth/15 text-asset-eth' },
  BNB: { glyph: 'B', className: 'bg-asset-bnb/15 text-asset-bnb' },
  SOL: { glyph: 'S', className: 'bg-asset-sol/15 text-asset-sol' },
  LTC: { glyph: 'L', className: 'bg-asset-ltc/15 text-asset-ltc' },
  STACKS: { glyph: 'S', className: 'bg-asset-stx/15 text-asset-stx' },
  SPARK: { glyph: 'S', className: 'bg-asset-spark/15 text-asset-spark' },
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
