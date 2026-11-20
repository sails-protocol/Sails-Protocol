/**
 * Payment-method quick filter (2026-07-28), requested directly — same
 * search-based picker pattern AssetPicker/CurrencyPicker already use on
 * this toolbar, so a user can immediately check "does anyone here accept
 * my payment method?" without opening the full Filtros drawer. Multi-
 * select (unlike Asset/CurrencyPicker's single value): a trader might
 * accept more than one method. Binds to the exact same
 * `filters.paymentMethods` FilterPanel's own "Método de pagamento"
 * section already edits — not a second source of truth, just a second,
 * faster entry point to it.
 */
import { useMemo, useState } from 'react'
import type { PaymentMethod } from '../../types'
import { PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { Input } from '../ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'
import { Search, Check, ChevronDown } from 'lucide-react'

interface Props {
  methods: readonly PaymentMethod[]
  value: PaymentMethod[]
  onChange: (methods: PaymentMethod[]) => void
}

export function PaymentMethodPicker({ methods, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(
    () => methods.filter((m) => PAYMENT_METHOD_LABELS[m].toLowerCase().includes(search.toLowerCase())),
    [methods, search]
  )

  const toggle = (m: PaymentMethod) => {
    onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m])
  }

  const label =
    value.length === 0 ? 'Todos os métodos' : value.length === 1 ? PAYMENT_METHOD_LABELS[value[0]] : `${value.length} métodos`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Métodos de pagamento" className="toolbar-chip flex items-center gap-2 min-w-[150px] justify-between">
        <span className={`truncate ${value.length > 0 ? 'font-medium text-brand-orange-accent' : ''}`}>{label}</span>
        <ChevronDown className="h-4 w-4 text-brand-text-muted shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-brand-text-muted pointer-events-none" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar método de pagamento..."
            className="w-full pl-8"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {filtered.map((m) => {
            const checked = value.includes(m)
            return (
              <button
                key={m}
                onClick={() => toggle(m)}
                aria-pressed={checked}
                className={`w-full flex items-center justify-between text-left px-3 py-2 rounded-lg text-sm hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  checked ? 'text-brand-orange-accent font-semibold' : 'text-brand-text'
                }`}
              >
                {PAYMENT_METHOD_LABELS[m]}
                {checked && <Check className="h-4 w-4" />}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className="text-xs text-brand-text-muted px-3 py-2">Nenhum método encontrado com esse nome.</p>
          )}
        </div>
        {value.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="w-full text-xs text-brand-text-muted hover:text-brand-text mt-1 pt-2 border-t border-brand-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            Limpar seleção
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
