/**
 * #235 R7G-A — CANCELLED_TRADE_NO_NEW_ECONOMIC_COMMITMENT_V1.
 *
 * Once a Trade is CANCELLED, no new trade-backed Escrow may be created for it,
 * and a manual cancellation and the creation of a trade's first Escrow have one
 * durable order. Before the first Escrow exists there is no escrow-scoped lock
 * to share (#294 takes that one only once an escrow exists), so both take this
 * trade-scoped PostgreSQL advisory transaction lock as the FIRST statement of
 * their transaction, and read the Trade only after holding it:
 *   - cancellation wins: the Trade is CANCELLED before createEscrow() reads it,
 *     which refuses;
 *   - escrow creation wins: the Escrow is committed before the cancellation
 *     reads the trade's escrow, and #294's existing rules then apply to it.
 * Multi-node safe (the lock lives in PostgreSQL) and released by commit or
 * rollback. The key is namespaced: the event store already locks on the bare
 * trade id (its correlationId), which a lifecycle holder must never contend on.
 *
 * Lock order: trade-lifecycle -> escrow (#294) -> trade row. Nothing acquires
 * this lock after the escrow lock or a Trade row lock, so no cycle exists.
 */
import type { Prisma } from '@prisma/client'
import { EscrowError } from '../../common/errors'

export function tradeLifecycleLockKey(tradeId: string): string {
  return `trade-lifecycle:${tradeId}`
}

export async function lockTradeLifecycle(tx: Prisma.TransactionClient, tradeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tradeLifecycleLockKey(tradeId)})::bigint)`
}

/**
 * The statuses a Trade may take its FIRST Escrow from. COMPLETED and DISPUTED
 * are only ever projected from an existing Escrow (trade-repository.ts's
 * ESCROW_TO_TRADE_STATUS), and CANCELLED has revoked the trade's economic intent.
 */
const FIRST_ESCROW_TRADE_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'ACTIVE'])

export function assertFirstEscrowAllowed(tradeId: string, status: string | undefined): void {
  if (!status || !FIRST_ESCROW_TRADE_STATUSES.has(status)) {
    throw new EscrowError(`Trade ${tradeId} is ${status ?? 'missing'}: no new escrow can be created for it`)
  }
}
