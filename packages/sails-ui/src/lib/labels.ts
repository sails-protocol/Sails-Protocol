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
import { t } from '../i18n'

// Translated entries are getters, so a label follows the interface language on every read (a plain
// value would freeze in the language active at import time). Brand names stay plain strings.

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
  get LN_BTC() { return `BTC · ${t('labels.network.test')}` },
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
  get BANK_TRANSFER() { return t('labels.payment.bankTransfer') },
  get CRYPTO_DIRECT() { return t('labels.payment.cryptoDirect') },
  get LIGHTNING_DIRECT() { return t('labels.payment.lightningDirect') },
  // Legacy cash methods: no longer offered, kept so old records still render their name.
  get CASH() { return t('labels.legacy.cash') },
  get OTHER() { return t('labels.payment.other') },
  PAYPAL: 'PayPal',
  get CASH_BY_MAIL() { return t('labels.legacy.cashByMail') },
  SKRILL: 'Skrill',
  ADVCASH: 'AdvCash',
  NETELLER: 'Neteller',
  PAYEER: 'Payeer',
  PAYONEER: 'Payoneer',
  PERFECT_MONEY: 'Perfect Money',
  WEBMONEY: 'WebMoney',
  ZELLE: 'Zelle',
  ZINLI: 'Zinli',
  get CREDIT_DEBIT_CARD() { return t('labels.payment.card') },
  get GIFT_CARD() { return t('labels.payment.giftCard') },
  MERCADO_PAGO: 'Mercado Pago',
  NEQUI: 'Nequi',
  BANCOLOMBIA: 'Bancolombia',
  WALLY: 'Wally',
  YAPE: 'Yape',
  get MOBILE_MONEY() { return t('labels.payment.mobileMoney') },
  REVOLUT: 'Revolut',
  get BOLETO() { return t('labels.payment.boleto') },
  get LOTERICA_DEPOSIT() { return t('labels.legacy.lotericaDeposit') },
  DEPIX: 'DePix',
  WISE: 'Wise',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  PICPAY: 'PicPay',
  PLIN: 'Plin',
  // HodlHodl (2026-08-01) — see types.ts's own comment on this same group.
  get UPI() { return t('labels.payment.upi') },
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
  get RELEASE() { return t('labels.disputeRuling.release') },
  get REFUND() { return t('labels.disputeRuling.refund') },
  get SPLIT() { return t('labels.disputeRuling.split') },
}

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  get OPENED() { return t('labels.disputeStatus.opened') },
  get EVIDENCE_SUBMITTED() { return t('labels.disputeStatus.evidenceSubmitted') },
  get ARBITRATED() { return t('labels.disputeStatus.arbitrated') },
  get RESOLVED() { return t('labels.disputeStatus.resolved') },
  get APPEALED() { return t('labels.disputeStatus.appealed') },
  get AUTO_PROPOSED() { return t('labels.disputeStatus.autoProposed') },
}

/** Escrow.type in words (the settlement rail of the escrow); the code stays the stored value. */
export const ESCROW_TYPE_LABEL: Record<EscrowType, string> = {
  get MULTISIG() { return t('labels.escrowType.multisig') },
  get LIGHTNING_HODL() { return t('labels.escrowType.lightningHodl') },
  get LIQUID_COVENANT() { return t('labels.escrowType.liquidCovenant') },
  get WDK_USDT_EVM() { return t('labels.escrowType.wdkUsdtEvm') },
  get SAFE_GUARD_EVM() { return t('labels.escrowType.safeGuardEvm') },
  get MOCK() { return t('labels.escrowType.mock') },
}
