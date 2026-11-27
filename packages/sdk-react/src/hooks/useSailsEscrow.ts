import { useQuery, useMutation, useQueryClient, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query'
import type { Escrow, Dispute } from '@satsails/p2p-trading-sdk'
import { useSailsClient } from './useSailsClient'

export interface UseSailsEscrowResult {
  query: UseQueryResult<Escrow>
  lock: UseMutationResult<Escrow, Error, void>
  markPaymentSent: UseMutationResult<Escrow, Error, void>
  release: UseMutationResult<Escrow, Error, string>
  refund: UseMutationResult<Escrow, Error, void>
  dispute: UseMutationResult<Dispute, Error, { reason: string; evidence?: unknown[] }>
  /** Only the seller creates a trade's escrow; false for the buyer (and when the role is unknown). */
  canCreate: boolean
}

/**
 * Wraps `settlement.get/lock/markPaymentSent/release/refund/dispute`
 * (all real — packages/sails-sdk/src/modules/settlement.ts, verified
 * against src/modules/open-settlement/settlement.routes.ts directly).
 * Every mutation invalidates this escrow's own query on success — no
 * caller-side refetch plumbing needed to see the new status after a
 * real action. `escrowId` may be undefined (query stays disabled,
 * mutations simply aren't called yet) the same way useSailsTrade()
 * handles an unresolved id.
 */
export function useSailsEscrow(escrowId: string | undefined, opts: { role?: 'buyer' | 'seller' } = {}): UseSailsEscrowResult {
  const client = useSailsClient()
  const queryClient = useQueryClient()
  const queryKey = ['sails', 'escrow', escrowId] as const

  const query = useQuery({
    queryKey,
    queryFn: () => client.settlement.get(escrowId as string),
    enabled: Boolean(escrowId),
  })

  function invalidate(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey })
  }

  const lock = useMutation({
    mutationFn: () => client.settlement.lock(escrowId as string),
    onSuccess: invalidate,
  })

  const markPaymentSent = useMutation({
    mutationFn: () => client.settlement.markPaymentSent(escrowId as string),
    onSuccess: invalidate,
  })

  const release = useMutation({
    mutationFn: (toAddress: string) => client.settlement.release(escrowId as string, toAddress),
    onSuccess: invalidate,
  })

  const refund = useMutation({
    mutationFn: () => client.settlement.refund(escrowId as string),
    onSuccess: invalidate,
  })

  const dispute = useMutation({
    mutationFn: ({ reason, evidence }: { reason: string; evidence?: unknown[] }) =>
      client.settlement.dispute(escrowId as string, reason, evidence),
    onSuccess: invalidate,
  })

  return { query, lock, markPaymentSent, release, refund, dispute, canCreate: opts.role === 'seller' }
}
