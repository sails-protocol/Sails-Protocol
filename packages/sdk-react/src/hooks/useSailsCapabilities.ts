import { useQuery, useMutation, useQueryClient, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query'
import type { CapabilityGrant, RegisterCapabilityInput, WalletAdapter } from '@satsails/p2p-trading-sdk'
import { useSailsClient } from './useSailsClient'

export interface UseSailsCapabilitiesResult {
  query: UseQueryResult<CapabilityGrant[]>
  register: UseMutationResult<CapabilityGrant, Error, RegisterCapabilityInput>
  revoke: UseMutationResult<void, Error, string>
  registerFromWallet: UseMutationResult<CapabilityGrant, Error, WalletAdapter>
  // Issue #303 - the supported onboarding call (idempotent; see SDK's
  // capabilities.ensureCanonicalGrants). Variable = the caller's participantId.
  ensureCanonicalGrants: UseMutationResult<CapabilityGrant[], Error, string>
}

/**
 * Wraps `capabilities.register/list/revoke/registerFromWallet`
 * (all real — packages/sails-sdk/src/modules/capabilities.ts, verified
 * against src/modules/open-capabilities/capabilities.routes.ts directly).
 * Every mutation invalidates the capabilities query on success — no
 * caller-side refetch plumbing needed. `participantId` may be undefined
 * (query stays disabled) the same way useSailsTrade() handles an
 * unresolved id.
 */
export function useSailsCapabilities(participantId: string | undefined): UseSailsCapabilitiesResult {
  const client = useSailsClient()
  const queryClient = useQueryClient()
  const queryKey = ['sails', 'capabilities', participantId] as const

  const query = useQuery({
    queryKey,
    queryFn: () => client.capabilities.list(participantId as string),
    enabled: Boolean(participantId),
  })

  function invalidate(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey })
  }

  const register = useMutation({
    mutationFn: (input: RegisterCapabilityInput) => client.capabilities.register(input),
    onSuccess: invalidate,
  })

  const revoke = useMutation({
    mutationFn: (grantId: string) => client.capabilities.revoke(grantId),
    onSuccess: invalidate,
  })

  const registerFromWallet = useMutation({
    mutationFn: (wallet: WalletAdapter) => client.capabilities.registerFromWallet(wallet),
    onSuccess: invalidate,
  })

  const ensureCanonicalGrants = useMutation({
    mutationFn: (id: string) => client.capabilities.ensureCanonicalGrants(id),
    onSuccess: invalidate,
  })

  return { query, register, revoke, registerFromWallet, ensureCanonicalGrants }
}