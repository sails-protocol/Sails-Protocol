import { useQuery, useMutation, useQueryClient, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query'
import type { Participant, PublicParticipant, Ed25519Keypair, AuthenticateResult } from '@satsails/p2p-trading-sdk'
import { useSailsClient } from './useSailsClient'

export interface UseSailsIdentityResult {
  // Missão 11 Fase 9.3.5 narrowed identity.get() to PublicParticipant
  // (INV-OP-10) — this hook's query type was never updated to match,
  // caught here in Fase 9.3.6's contract-integrity pass. create()/
  // createWithPublicKey() are self-referential registration responses
  // and correctly stay the full Participant.
  query: UseQueryResult<PublicParticipant>
  create: UseMutationResult<{ participant: Participant; keypair: Ed25519Keypair }, Error, { keypair?: Ed25519Keypair; displayName?: string }>
  createWithPublicKey: UseMutationResult<Participant, Error, { publicKeyHex: string; displayName?: string }>
  // Issue #302 — createWithPublicKey() above can no longer complete
  // registration on its own (the server now requires proof of
  // possession, and that method has no signing capability by design —
  // see packages/sails-sdk/src/modules/identity.ts's own doc comment).
  // This is the wallet-backed equivalent, mirroring
  // authenticateWithWallet() below.
  createWithWallet: UseMutationResult<Participant, Error, { publicKeyHex: string; wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> }; displayName?: string }>
  challenge: UseMutationResult<{ challenge: string; expiresIn: number }, Error, string>
  authenticate: UseMutationResult<AuthenticateResult, Error, Ed25519Keypair>
  authenticateWithWallet: UseMutationResult<AuthenticateResult, Error, { publicKeyHex: string; wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> } }>
}

/**
 * Wraps `identity.create/createWithPublicKey/challenge/authenticate/authenticateWithWallet/get/me`
 * (all real — packages/sails-sdk/src/modules/identity.ts, verified
 * against src/modules/open-identity/identity.routes.ts directly).
 * `participantId` may be undefined (query stays disabled, mutations
 * simply aren't called yet) the same way useSailsTrade() handles an
 * unresolved id.
 */
export function useSailsIdentity(participantId: string | undefined): UseSailsIdentityResult {
  const client = useSailsClient()
  const queryClient = useQueryClient()
  const queryKey = ['sails', 'identity', participantId] as const

  const query = useQuery({
    queryKey,
    queryFn: () => client.identity.get(participantId as string),
    enabled: Boolean(participantId),
  })

  function invalidate(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey })
  }

  const create = useMutation({
    mutationFn: ({ keypair, displayName }: { keypair?: Ed25519Keypair; displayName?: string }) =>
      client.identity.create(keypair, displayName),
    onSuccess: invalidate,
  })

  const createWithPublicKey = useMutation({
    mutationFn: ({ publicKeyHex, displayName }: { publicKeyHex: string; displayName?: string }) =>
      client.identity.createWithPublicKey(publicKeyHex, displayName),
    onSuccess: invalidate,
  })

  const createWithWallet = useMutation({
    mutationFn: ({ publicKeyHex, wallet, displayName }: { publicKeyHex: string; wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> }; displayName?: string }) =>
      client.identity.createWithWallet(publicKeyHex, wallet, displayName),
    onSuccess: invalidate,
  })

  const challenge = useMutation({
    mutationFn: (publicKeyHex: string) => client.identity.challenge(publicKeyHex),
    onSuccess: invalidate,
  })

  const authenticate = useMutation({
    mutationFn: (keypair: Ed25519Keypair) => client.identity.authenticate(keypair),
    onSuccess: invalidate,
  })

  const authenticateWithWallet = useMutation({
    mutationFn: ({ publicKeyHex, wallet }: { publicKeyHex: string; wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> } }) =>
      client.identity.authenticateWithWallet(publicKeyHex, wallet),
    onSuccess: invalidate,
  })

  return { query, create, createWithPublicKey, createWithWallet, challenge, authenticate, authenticateWithWallet }
}