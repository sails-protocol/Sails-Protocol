/**
 * Fiat currency filter — BRL/USD/EUR/etc. The real backend only models
 * one local-fiat price (Offer.priceBrl, prisma/schema.prisma) — this is
 * a presentation-layer generalization, honestly flagged in types.ts's
 * own comment on FiatCurrency, not a claim the backend already supports
 * arbitrary fiat pricing.
 */
import { useState } from 'react'
import type { FiatCurrency } from '../../types'
import { FIAT_CURRENCIES } from '../../lib/currency'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'
import { ChevronDown } from 'lucide-react'

interface Props {
  value: FiatCurrency | 'Todas'
  onChange: (currency: FiatCurrency | 'Todas') => void
}

export function CurrencyPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)

  const select = (c: FiatCurrency | 'Todas') => {
    onChange(c)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Moeda" className="toolbar-chip flex items-center gap-2 min-w-[110px] justify-between">
        <span className="font-medium">{value === 'Todas' ? 'Todas moedas' : value}</span>
        <ChevronDown className="h-4 w-4 text-brand-text-muted shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2 max-h-64 overflow-y-auto">
        <button
          onClick={() => select('Todas')}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm state-layer focus-visible:-outline-offset-2 ${value === 'Todas' ? 'text-brand-orange-accent font-semibold' : 'text-brand-text'}`}
        >
          Todas as moedas
        </button>
        {FIAT_CURRENCIES.map((c) => (
          <button
            key={c.code}
            onClick={() => select(c.code)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm state-layer focus-visible:-outline-offset-2 flex justify-between ${value === c.code ? 'text-brand-orange-accent font-semibold' : 'text-brand-text'}`}
          >
            <span className="font-mono">{c.code}</span>
            <span className="text-brand-text-muted text-xs">{c.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
