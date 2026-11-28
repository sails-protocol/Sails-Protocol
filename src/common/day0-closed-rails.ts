/**
 * Despacho 064 (CTO): rails closed for Day 0, in EVERY environment.
 *
 * LIGHTNING_HODL (Arkade) is under a provider review. Until it is completed, no NEW offer, intent, trade or escrow
 * may use the rail: LN_BTC routes to LIGHTNING_HODL, and LIGHTNING_HODL can also be requested explicitly for any asset
 * without a settlement scope.
 *
 * Deliberately independent of NODE_ENV, config and environment variables: there is no flag to reopen. Reopening is a
 * code change with its own despacho, after the provider review. Existing escrows are NOT blocked here (dispatch, refund
 * and recovery keep their current rules: escrow-providers.ts PRODUCTION_INELIGIBLE_TYPES, untouched).
 */
import { AppError } from './errors'

export const DAY0_CLOSED_ASSETS: ReadonlySet<string> = new Set(['LN_BTC'])
export const DAY0_CLOSED_ESCROW_TYPES: ReadonlySet<string> = new Set(['LIGHTNING_HODL'])

export class RailClosedError extends AppError {
  constructor(rail: { asset?: string; escrowType?: string }) {
    const name = rail.escrowType ?? rail.asset
    super(
      `Rail closed for Day 0: ${name} (Despacho 064). It is not available in any environment.`,
      409,
      'RAIL_CLOSED',
      // details stays an array, like every other error envelope the SDK reads (SailsError.details: unknown[])
      [{ ...(rail.asset !== undefined ? { asset: rail.asset } : {}), ...(rail.escrowType !== undefined ? { escrowType: rail.escrowType } : {}) }],
    )
  }
}

/** Throws RailClosedError when the asset or the escrow type is closed for Day 0. Call it before any write. */
export function assertRailOpen(rail: { asset?: string | null; escrowType?: string | null }): void {
  if (rail.asset != null && DAY0_CLOSED_ASSETS.has(rail.asset)) throw new RailClosedError({ asset: rail.asset })
  if (rail.escrowType != null && DAY0_CLOSED_ESCROW_TYPES.has(rail.escrowType)) throw new RailClosedError({ escrowType: rail.escrowType })
}
