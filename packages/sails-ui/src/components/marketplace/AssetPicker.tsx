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
 */
import { useMemo } from 'react'
import type { AssetType } from '../../types'
import { ASSET_LABELS } from '../../lib/labels'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { AssetIcon } from '../ui/AssetIcon'

interface Props {
  assets: readonly AssetType[]
  value: AssetType | 'Todos'
  onChange: (asset: AssetType | 'Todos') => void
  /** Trigger text while nothing specific is chosen (a form passes a "select" prompt). */
  allLabel?: string
  /** A form input, not a filter: no "all assets" option in the list. */
  hideAllOption?: boolean
}

// Combobox primitive (2026-11-20, DESIGN_SYSTEM.md 5.13): same options, search (label or raw code) and
// single choice as the hand-rolled Popover list it replaces, plus arrow keys and Enter.
export function AssetPicker({ assets, value, onChange, allLabel = 'Todos os ativos', hideAllOption }: Props) {
  const options = useMemo<ComboboxOption<AssetType | 'Todos'>[]>(() => [
    ...(hideAllOption ? [] : [{ value: 'Todos' as const, label: 'Todos os ativos' }]),
    ...assets.map((a) => ({ value: a, label: ASSET_LABELS[a], keywords: [a], leading: <AssetIcon asset={a} /> })),
  ], [assets, hideAllOption])
  const valueText = value === 'Todos' ? allLabel : ASSET_LABELS[value]

  return (
    <Combobox
      label="Ativo"
      valueText={valueText}
      options={options}
      selected={[value]}
      onSelect={onChange}
      triggerClassName="min-w-[140px]"
      trigger={
        <span className="flex items-center gap-1.5 min-w-0">
          {value !== 'Todos' && <AssetIcon asset={value} />}
          <span className={value === 'Todos' && hideAllOption ? 'truncate text-brand-text-muted' : 'font-medium truncate'}>{valueText}</span>
        </span>
      }
      searchPlaceholder="Buscar ativo…"
      emptyText={() => 'Nenhum ativo encontrado.'}
    />
  )
}
