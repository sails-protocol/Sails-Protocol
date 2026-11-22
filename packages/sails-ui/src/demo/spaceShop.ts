/**
 * Demo-only fixture for the simulated space checkout (lib/spaceCatalog.ts): a FIXED fictional "cotação de
 * demonstração", USD per unit. Not a market price, never refreshed, never used outside the demo checkout.
 */
import type { PayAsset } from '../lib/spaceCatalog'

export const DEMO_QUOTE_USD: Readonly<Record<PayAsset, number>> = { BTC: 100_000, USDT: 1, USDC: 1 }
