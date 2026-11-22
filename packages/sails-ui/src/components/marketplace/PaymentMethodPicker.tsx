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
import { useMemo } from 'react'
import type { PaymentMethod } from '../../types'
import { PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { t } from '../../i18n'

interface Props {
  methods: readonly PaymentMethod[]
  value: PaymentMethod[]
  onChange: (methods: PaymentMethod[]) => void
}

// Combobox primitive (2026-11-20): same multi-select toggle, search and "Limpar seleção"; the list stays open.
export function PaymentMethodPicker({ methods, value, onChange }: Props) {
  const options = useMemo<ComboboxOption<PaymentMethod>[]>(() => methods.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] })), [methods])
  const toggle = (m: PaymentMethod) => {
    onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m])
  }

  const label =
    value.length === 0 ? t('market.payment.all') : value.length === 1 ? PAYMENT_METHOD_LABELS[value[0]] : t('market.payment.selected', { count: String(value.length) })

  return (
    <Combobox
      multiple
      label={t('market.payment.label')}
      valueText={label}
      options={options}
      selected={value}
      onSelect={toggle}
      triggerClassName="min-w-[150px]"
      // Active filter: brand blue (chosen), never orange (act).
      trigger={<span className={`truncate ${value.length > 0 ? 'font-medium text-brand-blue-fg' : ''}`}>{label}</span>}
      searchPlaceholder={t('market.payment.search')}
      emptyText={() => t('market.payment.empty')}
      footer={value.length > 0 ? () => (
        <div className="p-1">
          <button
            type="button"
            onClick={() => onChange([])}
            className="w-full min-h-8 touch:min-h-11 rounded-sm text-xs text-brand-text-secondary hover:text-brand-text state-layer"
          >
            {t('market.payment.clearSelection')}
          </button>
        </div>
      ) : undefined}
    />
  )
}
