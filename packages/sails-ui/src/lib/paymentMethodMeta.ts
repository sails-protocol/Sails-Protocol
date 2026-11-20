/**
 * NAVIGATION-FILTER-1 §4.2/§4.3 — presentation-only organization layer
 * for `PaymentMethod` (types.ts). Fixes the "wall of chips" problem
 * (all 43 filterable methods rendered flat, no grouping/search/
 * prioritization) found in `FilterPanel.tsx`. Explicitly NOT protocol
 * truth: a method's category here is a frontend display grouping, never
 * read by the backend, never round-tripped in a real submission
 * (PublishOffer.tsx keeps using the narrower real `PAYMENT_METHODS`
 * list, untouched by this file) — see that file's own comment on why
 * the real-vs-filterable split exists at all.
 *
 * Categories and their members are derived from the same sourcing
 * already documented in `types.ts`'s own `PaymentMethod` comment
 * (HodlHodl/Airtm/El Dorado/Noones/Binance P2P) — no new payment
 * method or metadata invented, just grouped.
 */
import type { PaymentMethod } from '../types'

export type PaymentMethodCategory = 'BANK' | 'WALLET' | 'CASH' | 'CRYPTO' | 'REMITTANCE' | 'OTHER'

export const PAYMENT_METHOD_CATEGORY_LABELS: Record<PaymentMethodCategory, string> = {
  BANK: 'Transferência bancária',
  WALLET: 'Carteiras digitais',
  CASH: 'Dinheiro / presencial',
  CRYPTO: 'Cripto / Lightning',
  REMITTANCE: 'Internacional / remessas',
  OTHER: 'Outros',
}

// Category order used when rendering the expanded/grouped list —
// roughly most-locally-relevant to most-niche, matching this screen's
// own Binance-P2P-density reference.
export const PAYMENT_METHOD_CATEGORY_ORDER: PaymentMethodCategory[] = [
  'BANK', 'WALLET', 'CASH', 'CRYPTO', 'REMITTANCE', 'OTHER',
]

export const PAYMENT_METHOD_CATEGORY: Record<PaymentMethod, PaymentMethodCategory> = {
  PIX: 'BANK', TED: 'BANK', BANK_TRANSFER: 'BANK', BOLETO: 'BANK', BANCOLOMBIA: 'BANK',
  INTERAC: 'BANK', BIZUM: 'BANK',

  PAYPAL: 'WALLET', SKRILL: 'WALLET', ADVCASH: 'WALLET', NETELLER: 'WALLET', PAYEER: 'WALLET',
  PAYONEER: 'WALLET', PERFECT_MONEY: 'WALLET', WEBMONEY: 'WALLET', ZELLE: 'WALLET', ZINLI: 'WALLET',
  MERCADO_PAGO: 'WALLET', NEQUI: 'WALLET', WALLY: 'WALLET', YAPE: 'WALLET', PLIN: 'WALLET',
  VENMO: 'WALLET', CASH_APP: 'WALLET', PICPAY: 'WALLET', UPI: 'WALLET', ALIPAY: 'WALLET',
  WECHAT_PAY: 'WALLET', MOBILE_MONEY: 'WALLET',

  CASH: 'CASH', CASH_BY_MAIL: 'CASH', LOTERICA_DEPOSIT: 'CASH',

  CRYPTO_DIRECT: 'CRYPTO', LIGHTNING_DIRECT: 'CRYPTO', DEPIX: 'CRYPTO', BINANCE_PAY: 'CRYPTO',

  WISE: 'REMITTANCE', REVOLUT: 'REMITTANCE', AIRTM: 'REMITTANCE', ASTROPAY: 'REMITTANCE',

  CREDIT_DEBIT_CARD: 'OTHER', GIFT_CARD: 'OTHER', OTHER: 'OTHER',
}

/**
 * §4.2's "country selection may PRIORITIZE, not rigidly RESTRICT" rule —
 * this map only ever reorders a country's most-locally-relevant methods
 * to the front of the list; every method stays selectable regardless of
 * the chosen country (`FilterPanel.tsx` never filters the underlying
 * list by this map, only sorts by it). Deliberately incomplete: only
 * covers `COUNTRIES` (data/mock.ts) entries with an obvious, already-
 * sourced regional method in `PaymentMethod` above — a country missing
 * here just falls back to the plain alphabetical list, which is honest
 * (no fabricated priority) rather than a gap papered over with a guess.
 */
export const COUNTRY_PRIORITY_METHODS: Partial<Record<string, PaymentMethod[]>> = {
  BR: ['PIX', 'TED', 'BANK_TRANSFER', 'MERCADO_PAGO', 'PICPAY', 'BOLETO', 'DEPIX'],
  US: ['ZELLE', 'CASH_APP', 'VENMO', 'WISE', 'PAYPAL', 'CREDIT_DEBIT_CARD'],
  AR: ['MERCADO_PAGO', 'ASTROPAY', 'BANK_TRANSFER'],
  MX: ['MERCADO_PAGO', 'BANK_TRANSFER', 'PAYPAL'],
  CO: ['BANCOLOMBIA', 'NEQUI', 'MERCADO_PAGO'],
  PE: ['YAPE', 'PLIN', 'MERCADO_PAGO'],
  VE: ['ZELLE', 'AIRTM', 'BANK_TRANSFER'],
  BO: ['MERCADO_PAGO', 'BANK_TRANSFER'],
  NG: ['MOBILE_MONEY', 'BANK_TRANSFER'],
  IN: ['UPI', 'BANK_TRANSFER'],
  PT: ['BANK_TRANSFER', 'REVOLUT', 'WISE'],
  DE: ['BANK_TRANSFER', 'REVOLUT', 'WISE'],
  EG: ['MOBILE_MONEY', 'BANK_TRANSFER'],
}
