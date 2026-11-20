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
import { useMemo, useState } from 'react'
import type { AssetType } from '../../types'
import { ASSET_LABELS } from '../../lib/labels'
import { Input } from '../ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'
import { AssetIcon } from '../ui/AssetIcon'
import { ChevronDown } from 'lucide-react'

interface Props {
  assets: readonly AssetType[]
  value: AssetType | 'Todos'
  onChange: (asset: AssetType | 'Todos') => void
  /** Trigger text while nothing specific is chosen (a form passes a "select" prompt). */
  allLabel?: string
  /** A form input, not a filter: no "all assets" option in the list. */
  hideAllOption?: boolean
}

export function AssetPicker({ assets, value, onChange, allLabel = 'Todos os ativos', hideAllOption }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return assets.filter((a) => a.toLowerCase().includes(q) || ASSET_LABELS[a].toLowerCase().includes(q))
  }, [assets, search])

  const select = (asset: AssetType | 'Todos') => {
    onChange(asset)
    setOpen(false)
    setSearch('')
  }

  return (
    // Real Radix Popover (2026-08-01) — replaces a hand-rolled
    // `fixed inset-0` backdrop, which had no focus trap, no Escape-to-
    // close, no ARIA. Trigger keeps its `.input-field` look (that part
    // was never the problem); only the dropdown mechanics changed.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Ativo" className="toolbar-chip flex items-center gap-2 min-w-[140px] justify-between">
        <span className="flex items-center gap-1.5 min-w-0">
          {value !== 'Todos' && <AssetIcon asset={value} />}
          <span className={value === 'Todos' && hideAllOption ? 'truncate text-brand-text-muted' : 'font-medium truncate'}>{value === 'Todos' ? allLabel : ASSET_LABELS[value]}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-brand-text-muted shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar ativo..."
          className="w-full mb-2"
        />
        <div className="max-h-64 overflow-y-auto">
          {!hideAllOption && <button
            onClick={() => select('Todos')}
            className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${value === 'Todos' ? 'text-brand-orange-accent font-semibold' : 'text-brand-text'}`}
          >
            Todos os ativos
          </button>}
          {filtered.map((asset) => (
            <button
              key={asset}
              onClick={() => select(asset)}
              title={asset}
              className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${value === asset ? 'text-brand-orange-accent font-semibold' : 'text-brand-text'}`}
            >
              <AssetIcon asset={asset} />
              <span className="truncate">{ASSET_LABELS[asset]}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="text-xs text-brand-text-muted px-3 py-2">Nenhum ativo encontrado.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
