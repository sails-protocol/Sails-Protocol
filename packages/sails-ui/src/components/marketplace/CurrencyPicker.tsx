/**
 * Fiat currency filter — BRL/USD/EUR/etc. The real backend only models
 * one local-fiat price (Offer.priceBrl, prisma/schema.prisma) — this is
 * a presentation-layer generalization, honestly flagged in types.ts's
 * own comment on FiatCurrency, not a claim the backend already supports
 * arbitrary fiat pricing.
 */
import { useMemo } from 'react'
import type { FiatCurrency } from '../../types'
import { FIAT_CURRENCIES, currencyLabel } from '../../lib/currency'
import { t } from '../../i18n'
import { Combobox, type ComboboxOption } from '../ui/combobox'

interface Props {
  value: FiatCurrency | 'Todas'
  onChange: (currency: FiatCurrency | 'Todas') => void
}

// Combobox primitive (2026-11-20): same options and single choice; search by code or name is new.
export function CurrencyPicker({ value, onChange }: Props) {
  const options = useMemo<ComboboxOption<FiatCurrency | 'Todas'>[]>(() => [
    { value: 'Todas', label: t('market.currency.allOption') },
    // Search matches the pt-BR name too, so a name typed in either language finds the currency.
    ...FIAT_CURRENCIES.map((c) => ({ value: c.code, label: c.code, keywords: [currencyLabel(c.code), c.label], detail: currencyLabel(c.code) })),
  ], [])
  const valueText = value === 'Todas' ? t('market.currency.allShort') : value

  return (
    <Combobox
      label={t('market.field.currency')}
      valueText={valueText}
      options={options}
      selected={[value]}
      onSelect={onChange}
      triggerClassName="min-w-[110px]"
      trigger={<span className="font-medium">{valueText}</span>}
      searchPlaceholder={t('market.currency.search')}
      emptyText={() => t('market.currency.empty')}
      contentClassName="w-56"
    />
  )
}
