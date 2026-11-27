/**
 * Demo-only hooks the demo backend (demo/demoBackend.ts) registers when `?demo=1` installs it. Product code calls
 * them through `demoHooks()`, which is empty in production builds and outside demo mode, so the demo module is never
 * imported by a page (it stays a dev-only chunk).
 */
import type { Ed25519Keypair, PaymentMethod } from '@satsails/p2p-trading-sdk'
import { isDemoMode } from './demoMarkers'

export interface DemoHooks {
  /** The demo identity key of this tab's session, so a reload or HMR keeps the session (demo only). */
  sessionKeypair: () => Ed25519Keypair | null
  /** A fictional counterparty opens a trade on one of your offers; resolves to the new trade id. */
  simulateIncomingTrade: (offerId: string) => Promise<string>
  /** The payment method chosen for the next demo trade (the real trade-create has no such field). */
  stageTradePaymentMethod: (method: string | null) => void
}

let hooks: Partial<DemoHooks> = {}

export function setDemoHooks(h: Partial<DemoHooks>): void {
  hooks = { ...hooks, ...h }
}

export function demoHooks(): Partial<DemoHooks> {
  return import.meta.env.DEV && isDemoMode() ? hooks : {}
}

/** Demo only: the payment method picked for a demo trade (the demo backend stores it); undefined for real data. */
export function demoTradePaymentMethodOf(raw: unknown): PaymentMethod | undefined {
  if (!import.meta.env.DEV || !isDemoMode()) return undefined
  const m = (raw as { demoPaymentMethod?: unknown } | null)?.demoPaymentMethod
  return typeof m === 'string' ? (m as PaymentMethod) : undefined
}
