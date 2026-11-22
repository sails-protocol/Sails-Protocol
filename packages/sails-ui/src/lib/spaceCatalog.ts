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
