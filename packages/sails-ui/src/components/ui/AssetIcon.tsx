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
 *
 * 2026-11-20 (asset catalog, DECISIONS.md): pairs from lib/assetCatalog.ts
 * render the official asset logo with the network logo on a small chip in
 * the corner (public/brand, THIRD_PARTY_LOGOS.md; never recolored). The
 * monogram stays the fallback for enum values with no official mark.
 * Logos are decorative: the pair's name is always written next to them.
 */
import type { AssetType } from '../../types'
import { ASSET_LABELS, ASSET_SHORT_LABELS } from '../../lib/labels'
import { ASSET_LOGO, LEGACY_LOGOS, networkChipLogo, pairForAssetType, type AssetPair } from '../../lib/assetCatalog'
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

export type AssetIconSize = 'sm' | 'md' | 'lg'
// Icon scale 16/20/24; the network chip is half the logo, with a 1px surface ring so it separates on any row.
const SIZE: Record<AssetIconSize, { box: string; px: number; chip: string }> = {
  sm: { box: 'size-icon-sm', px: 16, chip: 'size-2.5 -bottom-0.5 -right-1' },
  md: { box: 'size-icon', px: 20, chip: 'size-3 -bottom-0.5 -right-1' },
  lg: { box: 'size-icon-lg', px: 24, chip: 'size-3.5 -bottom-0.5 -right-1' },
}

/** Layer A: asset logo + network chip from image URLs (any host passes its own). Decorative. */
export function AssetLogo({ assetSrc, networkSrc, size = 'md', className }: { assetSrc: string; networkSrc?: string | null; size?: AssetIconSize; className?: string }) {
  const s = SIZE[size]
  return (
    <span aria-hidden="true" className={cn('relative inline-flex shrink-0', s.box, className)}>
      <img src={assetSrc} alt="" width={s.px} height={s.px} className="size-full" draggable={false} />
      {networkSrc && (
        <span className={cn('absolute inline-flex items-center justify-center rounded-full bg-asset-chip ring-1 ring-brand-border-subtle dark:ring-brand-surface', s.chip)}>
          <img src={networkSrc} alt="" width={s.px / 2} height={s.px / 2} className="size-full" draggable={false} />
        </span>
      )}
    </span>
  )
}

/** A catalog pair's icon (pickers show pairs that have no enum value yet). */
export function AssetPairIcon({ pair, size = 'md', className }: { pair: AssetPair; size?: AssetIconSize; className?: string }) {
  return <AssetLogo assetSrc={ASSET_LOGO[pair.asset]} networkSrc={networkChipLogo(pair.asset, pair.network)} size={size} className={className} />
}

export function AssetIcon({ asset, size = 'md', className }: { asset: AssetType; size?: AssetIconSize; className?: string }) {
  const pair = pairForAssetType(asset)
  if (pair) return <AssetPairIcon pair={pair} size={size} className={className} />
  const legacy = LEGACY_LOGOS[asset]
  if (legacy) return <AssetLogo assetSrc={ASSET_LOGO[legacy.asset]} networkSrc={networkChipLogo(legacy.asset, legacy.network)} size={size} className={className} />
  const accent = ASSET_ACCENTS[asset]
  const glyph = accent?.glyph ?? ASSET_SHORT_LABELS[asset]?.[0] ?? '?'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        SIZE[size].box,
        accent?.className ?? FALLBACK_CLASSNAME,
        className
      )}
    >
      {glyph}
    </span>
  )
}

/** Icon + "BTC · On-chain": how an asset is shown wherever it appears (Market, offer, trade, Perfil). */
export function AssetNetworkLabel({ asset, size = 'sm', className }: { asset: AssetType; size?: AssetIconSize; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 align-middle', className)}>
      <AssetIcon asset={asset} size={size} />
      <span className="min-w-0">{ASSET_LABELS[asset]}</span>
    </span>
  )
}
