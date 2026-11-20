/**
 * Binance-style asset selector: a button that opens a search list,
 * instead of a lateral row of pills. Requested directly — a pill row
 * doesn't scale once more assets exist (ETH, USDC, SOL, etc.), and a
 * search-based picker already handles that without changing this
 * component when ASSETS (data/mock.ts) grows.
 *
 * Renders `ASSET_LABELS` (2026-07-29 fix, found while testing the new
 * asset additions) — used to render the raw `AssetType` code verbatim
 * (`USDC_ERC20`, `SBTC_STACKS`, `USDCX_STACKS`...), the exact "code
 * identifier, not interface copy" problem lib/labels.ts's own header
 * comment already named and fixed everywhere else in this UI; just
 * missed here since this component predates most of those codes. Search
 * now matches the label too (e.g. "bitcoin" finds BTC/LN_BTC/etc.), not
 * only the raw code — the label is what's visible now, so it should be
 * searchable too.
 *
 * 2026-11-20 (asset catalog, DECISIONS.md): the options are the official
 * 14 pairs (lib/assetCatalog.ts), one per network, grouped under the asset.
 * "Em breve" pairs stay visible but disabled: they cannot be filtered nor
 * published. Only `available` pairs (plus the Arkade test rail in dev
 * builds) can be chosen, so the filter and the publish form share one list.
 * Whole-group selection ("all of Bitcoin") is not offered: each group has
 * at most one selectable pair today, so it would add a control with no effect.
 */
import { useMemo } from 'react'
import type { AssetType } from '../../types'
import { ASSET_LABELS } from '../../lib/labels'
import { ASSET_GROUPS, SOON_NOTE, pairForAssetType, pickerPairs } from '../../lib/assetCatalog'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { badgeVariants } from '../ui/badge'
import { AssetIcon, AssetPairIcon } from '../ui/AssetIcon'
import { cn } from '../../lib/utils'

interface Props {
  value: AssetType | 'Todos'
  onChange: (asset: AssetType | 'Todos') => void
  /** Trigger text while nothing specific is chosen (a form passes a "select" prompt). */
  allLabel?: string
  /** A form input, not a filter: no "all assets" option in the list. */
  hideAllOption?: boolean
}

const SOON_BADGE = cn(badgeVariants({ variant: 'outline' }), 'border-transparent bg-brand-tonal font-medium text-brand-text')

// Combobox primitive (2026-11-20, DESIGN_SYSTEM.md 5.3): search (label, code, asset or network name), arrow keys and Enter.
export function AssetPicker({ value, onChange, allLabel = 'Todos os ativos', hideAllOption }: Props) {
  const options = useMemo<ComboboxOption<string>[]>(() => [
    ...(hideAllOption ? [] : [{ value: 'Todos', label: 'Todos os ativos' }]),
    ...pickerPairs(import.meta.env.DEV).map((p) => {
      const soon = p.availability === 'soon'
      const group = ASSET_GROUPS.find((g) => g.asset === p.asset)!.name
      return {
        value: p.id,
        label: p.label,
        keywords: [group, p.networkLabel, ...(p.assetType ? [p.assetType] : [])],
        leading: <AssetPairIcon pair={p} />,
        group,
        disabled: soon || p.assetType === null,
        description: p.note && p.note !== SOON_NOTE ? p.note : undefined,
        detail: soon ? <span className={SOON_BADGE}>{SOON_NOTE}</span> : undefined,
      }
    }),
  ], [hideAllOption])
  const valueText = value === 'Todos' ? allLabel : ASSET_LABELS[value]
  const selectedId = value === 'Todos' ? 'Todos' : pairForAssetType(value)?.id ?? value

  return (
    <Combobox
      label="Ativo"
      valueText={valueText}
      options={options}
      selected={[selectedId]}
      onSelect={(id) => {
        if (id === 'Todos') return onChange('Todos')
        const p = pickerPairs(import.meta.env.DEV).find((x) => x.id === id)
        if (p?.assetType && p.availability === 'available') onChange(p.assetType)
      }}
      triggerClassName="min-w-[140px]"
      contentClassName="w-80 max-w-[calc(100vw-2rem)]"
      trigger={
        <span className="flex items-center gap-1.5 min-w-0">
          {value !== 'Todos' && <AssetIcon asset={value} />}
          <span className={value === 'Todos' && hideAllOption ? 'truncate text-brand-text-muted' : 'font-medium truncate'}>{valueText}</span>
        </span>
      }
      searchPlaceholder="Buscar ativo ou rede…"
      emptyText={() => 'Nenhum ativo encontrado.'}
    />
  )
}
