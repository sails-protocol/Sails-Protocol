/**
 * CTO 118: the legacy publish contract requires priceUsd. Until the
 * multi-fiat contract (#623 / B7) is validated, no illustrative FX may
 * create that value. Keep the user's USD decimal exact (Decimal(24,8)).
 */
export function publicationPriceUsd(price: string, currency: string): string | null {
  if (currency !== 'USD') return null
  if (!/^\d{1,16}(\.\d{1,8})?$/.test(price) || !/[1-9]/.test(price)) return null
  return price
}
