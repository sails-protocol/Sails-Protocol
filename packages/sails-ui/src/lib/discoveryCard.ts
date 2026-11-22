/**
 * "Descoberta na hora certa" (DECISIONS.md "Modelo mundo aberto"): the small markets card in the Market shows until it
 * is dismissed, then stays hidden for DISCOVERY_SNOOZE_DAYS. The dismissal lives in this browser only (guarded
 * localStorage: a blocked or private-mode storage just shows the card again, never breaks the page).
 */
export const DISCOVERY_KEY = 'sails_ui_markets_card_dismissed_at'
export const DISCOVERY_SNOOZE_DAYS = 30
const DAY_MS = 86_400_000

/** Pure rule: show when never dismissed, when the stored value is unreadable, or after the snooze. */
export function shouldShowDiscovery(now: number, dismissedAt: string | null): boolean {
  if (!dismissedAt) return true
  const at = Date.parse(dismissedAt)
  return Number.isNaN(at) || now - at >= DISCOVERY_SNOOZE_DAYS * DAY_MS
}

export function readDiscoveryDismissedAt(): string | null {
  try { return localStorage.getItem(DISCOVERY_KEY) } catch { return null }
}

export function dismissDiscovery(now: number): void {
  try { localStorage.setItem(DISCOVERY_KEY, new Date(now).toISOString()) } catch { /* storage blocked: the card simply returns next time */ }
}
