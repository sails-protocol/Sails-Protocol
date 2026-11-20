/**
 * Payment-method list helpers (DESIGN_SYSTEM.md 5.3, PaymentMethods). Today an offer carries one
 * `paymentMethod`; callers pass `[offer.paymentMethod]` so the screen is unchanged. Multi-method offers
 * need a schema + SDK change (LOOSE_WIRES.multiPaymentMethods).
 */

/** First `max` items to show and how many are left for the "+N" overflow. */
export function splitOverflow<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  const n = Math.max(0, Math.floor(max))
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) }
}

/** Filter rule: an offer matches when it accepts ANY of the selected methods; no selection matches all. */
export function acceptsAnyMethod<T>(offerMethods: readonly T[], selected: readonly T[]): boolean {
  return selected.length === 0 || offerMethods.some((m) => selected.includes(m))
}
