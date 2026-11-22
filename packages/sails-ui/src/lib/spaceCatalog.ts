/**
 * "Comprar espaço": a Satsails commercial service, NOT part of the Sails Protocol or its SDKs (Principal, 2026-11-22;
 * DECISIONS.md "Compra de espaço"). The protocol stays permissionless: anyone or any integrator can create markets
 * with the SDKs without buying anything. Demonstration only: the prices are fictional and not the final commercial
 * prices, the purchase is one-time (no subscription, plan or renewal), BTC/USDT/USDC are future payment options and
 * nothing is ever charged. Kept apart from lib/marketContract.ts on purpose. Pure, no I/O.
 */
export type SpaceProductId = 'community' | 'private' | 'business'

export interface SpaceProduct {
  id: SpaceProductId
  /** Demo price, USD reference value. */
  demoPriceUsd: number
}

export const SPACE_PRODUCTS: readonly SpaceProduct[] = [
  { id: 'community', demoPriceUsd: 497 },
  { id: 'private', demoPriceUsd: 997 },
  { id: 'business', demoPriceUsd: 1997 },
]

/** Shown only as future options: no address, no invoice, no network call. */
export const FUTURE_PAYMENT_ASSETS = ['BTC', 'USDT', 'USDC'] as const

export function spaceProduct(id: string | null | undefined): SpaceProduct | null {
  return SPACE_PRODUCTS.find((p) => p.id === id) ?? null
}

// --- Simulated checkout (PO, 2026-11-22): 100 % demo. No address, no QR, no invoice, no live quote; nothing here
// feeds any economic logic. Steps: catalog -> payment -> review -> awaiting -> confirming -> confirmed -> acquired.

export type PayAsset = (typeof FUTURE_PAYMENT_ASSETS)[number]
export type CheckoutStep = 'catalog' | 'payment' | 'review' | 'awaiting' | 'confirming' | 'confirmed' | 'acquired'
export type CheckoutEvent = { type: 'next' } | { type: 'back' } | { type: 'simulatePaid' } | { type: 'settled' } | { type: 'reset' }

const FORWARD: Partial<Record<CheckoutStep, CheckoutStep>> = { catalog: 'payment', payment: 'review', review: 'awaiting', confirmed: 'acquired' }
// Back (or cancel) from any step before the simulated confirmation; a confirmed demo purchase cannot be "undone".
const BACKWARD: Partial<Record<CheckoutStep, CheckoutStep>> = { payment: 'catalog', review: 'payment', awaiting: 'review', confirming: 'review' }

/** One transition; events that do not apply leave the step unchanged. */
export function nextCheckoutStep(step: CheckoutStep, event: CheckoutEvent): CheckoutStep {
  switch (event.type) {
    case 'reset': return 'catalog'
    case 'next': return FORWARD[step] ?? step
    case 'back': return BACKWARD[step] ?? step
    case 'simulatePaid': return step === 'awaiting' ? 'confirming' : step
    case 'settled': return step === 'confirming' ? 'confirmed' : step
  }
}

/** "Passo N de 4" for the numbered checkout steps (the catalog has no number). */
export function checkoutStepNumber(step: CheckoutStep): number | null {
  return step === 'payment' ? 1 : step === 'review' ? 2 : step === 'awaiting' || step === 'confirming' || step === 'confirmed' ? 3 : step === 'acquired' ? 4 : null
}

/** Networks the official asset catalog lists for `asset` (passed in, so this module stays apart from the SDK code). */
export function checkoutNetworks<P extends { asset: string; network: string | null }>(asset: PayAsset, pairs: readonly P[]): P[] {
  return pairs.filter((p) => p.asset === asset && p.network !== null)
}

/**
 * The demo price in the chosen asset at a FIXED fictional "cotação de demonstração" (USD per unit). BTC to 8 places,
 * stablecoins to 2. Null for a missing or non-positive quote. Display only.
 */
export function demoEquivalent(priceUsd: number, asset: PayAsset, quoteUsd: number | undefined): number | null {
  if (!quoteUsd || !Number.isFinite(quoteUsd) || quoteUsd <= 0) return null
  const places = asset === 'BTC' ? 8 : 2
  const f = 10 ** places
  return Math.round((priceUsd / quoteUsd) * f) / f
}
