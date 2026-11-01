/**
 * Master Backlog R5: Escrow.timelockHours is protocol policy (DEFAULT_TIMELOCK_HOURS), frozen on each
 * escrow when it is created. It is never caller input: a trade party choosing 0 or a negative value would
 * make the escrow expire the moment funds lock, and a huge value would make it never expire.
 *
 * Pure module by design, like arbitration-policy.ts: boot validation (config/index.ts) and escrow
 * creation (escrow.service.ts) both check the same rule without an import cycle.
 *
 * Only the structural floor is enforced: a whole number of hours, at least 1, whose deadline
 * (lock time + timelock) is a date JavaScript can represent. A narrower range (a minimum dispute
 * window, a maximum lock, a cross-check against a rail's own on-chain exit window) is an economic
 * policy decision this check deliberately does not make.
 */

const HOUR_MS = 3_600_000
// ECMAScript's largest representable Date (ms since the epoch).
const MAX_DATE_MS = 8.64e15

export function isValidTimelockHours(hours: number): boolean {
  return Number.isSafeInteger(hours) && hours >= 1 && Date.now() + hours * HOUR_MS <= MAX_DATE_MS
}
