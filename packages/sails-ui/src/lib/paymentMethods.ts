/**
 * Payment-method list helpers (DESIGN_SYSTEM.md 5.4, PaymentMethods). A real offer carries one
 * `paymentMethod`; only the dev demo fills `demoPaymentMethods` (lib/demoMarkers.ts). Multi-method offers
 * need a schema + SDK change (LOOSE_WIRES.multiPaymentMethods, issue #735).
 */
import type { PaymentMethod } from '../types'

/** Product rule (PO, 2026-11-20): at most 5 methods per offer. Issue #735 makes it a contract rule. */
export const MAX_PAYMENT_METHODS = 5
/** List rows show this many, then "+N" (DECISIONS.md, Market e ofertas). */
export const LIST_METHODS_MAX = 3
/** Same, below `sm`. */
export const LIST_METHODS_MAX_NARROW = 2

/**
 * Future modalities (CTO 28, 2026-11-21): known to the backend enum but not enabled on Day 0. They stay
 * visible as "Em breve" and can never be chosen to publish an offer or to open a trade.
 */
export const FUTURE_PAYMENT_METHODS: ReadonlySet<string> = new Set(['LIGHTNING_DIRECT'])
export const isFuturePaymentMethod = (m: string): boolean => FUTURE_PAYMENT_METHODS.has(m)
/** True when the offer accepts at least one method that is enabled today. */
export function hasAvailablePaymentMethod(offer: { paymentMethod: PaymentMethod; demoPaymentMethods?: readonly PaymentMethod[] }): boolean {
  return offerPaymentMethods(offer).some((m) => !isFuturePaymentMethod(m))
}

/** The one place the UI reads an offer's methods: the demo list when present, else the real single method. */
export function offerPaymentMethods(offer: { paymentMethod: PaymentMethod; demoPaymentMethods?: readonly PaymentMethod[] }): PaymentMethod[] {
  return offer.demoPaymentMethods?.length ? offer.demoPaymentMethods.slice(0, MAX_PAYMENT_METHODS) : [offer.paymentMethod]
}

/** First `max` items to show and how many are left for the "+N" overflow. */
export function splitOverflow<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  const n = Math.max(0, Math.floor(max))
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) }
}

/** Filter rule: an offer matches when it accepts ANY of the selected methods; no selection matches all. */
export function acceptsAnyMethod<T>(offerMethods: readonly T[], selected: readonly T[]): boolean {
  return selected.length === 0 || offerMethods.some((m) => selected.includes(m))
}
