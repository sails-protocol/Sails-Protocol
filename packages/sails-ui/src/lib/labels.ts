/**
 * Human-friendly display labels for raw backend enum values
 * (AssetType/PaymentMethod, prisma/schema.prisma) — found missing during
 * a cold-start UX walkthrough (asked directly: "consegue perceber a UX
 * na prática?"): `USDT_ERC20`, `BANK_TRANSFER`, `CRYPTO_DIRECT` etc. were
 * showing up verbatim in offer cards, filters, and forms — code
 * identifiers, not interface copy. The underlying value is unchanged
 * everywhere (still what's stored/filtered/submitted); only what's
 * rendered to a person changes.
 */
import type { AssetType, PaymentMethod } from '../types'
import type { DisputeRuling, DisputeStatus, EscrowType } from '@satsails/p2p-trading-sdk'

// VERTICAL-SLICE-1 (2026-09-12) — BTC was the one Bitcoin-family label
// with no rail qualifier (every sibling below already has one), leaving
// a user unable to tell "Bitcoin" apart from "Bitcoin (Ark/Arkade)" as
// two DIFFERENT settlement rails rather than one asset with a
// vocabulary variant. Minimum representability fix for the frozen
// {BTC, BITCOIN_L1} canonical scope this slice proves end-to-end —
// not a general asset+rail selector (see ADR-002/PROJECT_CONTEXT.md §2C
// for the still-open, separately-authorized full Day-0 selector work).
//
// Asset catalog (2026-11-20, DECISIONS.md): every value the official catalog maps renders as its pair
// label, "asset · network" (lib/assetCatalog.ts; tests/assetCatalog.test.ts keeps them equal). LN_BTC
// is Arkade on a test network, never "Lightning". USDT_LIQUID/RSK_BTC follow the same format for
// existing data; the remaining values are kept only so old records still render.
export const ASSET_LABELS: Record<AssetType, string> = {
  BTC: 'BTC · On-chain',
  LN_BTC: 'BTC · Rede de teste',
  LIQUID_BTC: 'BTC · Liquid',
  RSK_BTC: 'BTC · RSK',
  USDT_ERC20: 'USDT · Ethereum',
  USDT_TRC20: 'USDT · Tron',
  USDT_LIQUID: 'USDT · Liquid',
  USDT_LIGHTNING: 'USDT (Lightning)',
  SPARK: 'Spark',
  STACKS: 'Stacks (STX)',
  DEPIX: 'DePix',
  ETH: 'Ethereum',
  BNB: 'BNB',
  SOL: 'Solana',
  LTC: 'Litecoin',
  WBTC: 'Wrapped Bitcoin (WBTC)',
  USDC_ERC20: 'USDC (ETH)',
  USDC_POLYGON: 'USDC (Polygon)',
  USDC_BASE: 'USDC (Base)',
  SBTC_STACKS: 'sBTC (Stacks)',
  USDCX_STACKS: 'USDCx (Stacks)',
}

// Compact form for space-constrained spots (an input's inline unit
// suffix, a chart axis) where the full parenthetical label
// ("USDT (ERC-20)") would overlap typed digits.
export const ASSET_SHORT_LABELS: Record<AssetType, string> = {
  BTC: 'BTC',
  LN_BTC: 'ARK-BTC',
  LIQUID_BTC: 'L-BTC',
  RSK_BTC: 'RSK-BTC',
  USDT_ERC20: 'USDT',
  USDT_TRC20: 'USDT',
  USDT_LIQUID: 'USDT',
  USDT_LIGHTNING: 'USDT',
  SPARK: 'SPARK',
  STACKS: 'STX',
  DEPIX: 'DEPIX',
  ETH: 'ETH',
  BNB: 'BNB',
  SOL: 'SOL',
  LTC: 'LTC',
  WBTC: 'WBTC',
  USDC_ERC20: 'USDC',
  USDC_POLYGON: 'USDC',
  USDC_BASE: 'USDC',
  SBTC_STACKS: 'sBTC',
  USDCX_STACKS: 'USDCx',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  PIX: 'PIX',
  TED: 'TED',
  BANK_TRANSFER: 'Transferência bancária',
  CRYPTO_DIRECT: 'Cripto direto',
  LIGHTNING_DIRECT: 'Lightning direto',
  CASH: 'Dinheiro em espécie',
  OTHER: 'Outro',
  PAYPAL: 'PayPal',
  CASH_BY_MAIL: 'Dinheiro pelo correio',
  SKRILL: 'Skrill',
  ADVCASH: 'AdvCash',
  NETELLER: 'Neteller',
  PAYEER: 'Payeer',
  PAYONEER: 'Payoneer',
  PERFECT_MONEY: 'Perfect Money',
  WEBMONEY: 'WebMoney',
  ZELLE: 'Zelle',
  ZINLI: 'Zinli',
  CREDIT_DEBIT_CARD: 'Cartão de crédito/débito',
  GIFT_CARD: 'Vale-presente',
  MERCADO_PAGO: 'Mercado Pago',
  NEQUI: 'Nequi',
  BANCOLOMBIA: 'Bancolombia',
  WALLY: 'Wally',
  YAPE: 'Yape',
  MOBILE_MONEY: 'Dinheiro móvel (M-Pesa etc.)',
  REVOLUT: 'Revolut',
  BOLETO: 'Boleto bancário',
  LOTERICA_DEPOSIT: 'Depósito em lotérica/caixa eletrônico',
  DEPIX: 'DePix',
  WISE: 'Wise',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  PICPAY: 'PicPay',
  PLIN: 'Plin',
  // HodlHodl (2026-08-01) — see types.ts's own comment on this same group.
  UPI: 'UPI (Índia)',
  INTERAC: 'Interac e-Transfer',
  ALIPAY: 'Alipay',
  WECHAT_PAY: 'WeChat Pay',
  BIZUM: 'Bizum',
  AIRTM: 'Airtm',
  ASTROPAY: 'AstroPay',
  BINANCE_PAY: 'Binance Pay',
}

// De-duplicated 2026-08-11 — Disputes.tsx and TradeDisputePanel.tsx
// each had their own identical copy of this map.
export const DISPUTE_RULING_LABEL: Record<DisputeRuling, string> = {
  RELEASE: 'liberar para o comprador',
  REFUND: 'reembolsar o vendedor',
  SPLIT: 'dividir entre as partes',
}

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  OPENED: 'Aberta',
  EVIDENCE_SUBMITTED: 'Evidências enviadas',
  ARBITRATED: 'Decisão do árbitro',
  RESOLVED: 'Resolvida',
  APPEALED: 'Em apelação',
  AUTO_PROPOSED: 'Resolução automática proposta',
}

/** Escrow.type in words (the settlement rail of the escrow); the code stays the stored value. */
export const ESCROW_TYPE_LABEL: Record<EscrowType, string> = {
  MULTISIG: 'Multisig Bitcoin',
  LIGHTNING_HODL: 'Bitcoin via Arkade (rede de teste)',
  LIQUID_COVENANT: 'Covenant na Liquid',
  WDK_USDT_EVM: 'USDT em rede EVM (WDK)',
  SAFE_GUARD_EVM: 'Safe com Guard (EVM)',
  MOCK: 'Simulado (sem provedor real)',
}
