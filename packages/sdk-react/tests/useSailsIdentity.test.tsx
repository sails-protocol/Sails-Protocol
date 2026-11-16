import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SailsProvider } from '../src/providers/SailsProvider'
import { useSailsIdentity } from '../src/hooks/useSailsIdentity'
import type { SailsClient, Ed25519Keypair } from '@satsails/p2p-trading-sdk'

const mockKeypair: Ed25519Keypair = {
  publicKey: new Uint8Array([1, 2, 3]),
  secretKey: new Uint8Array([4, 5, 6]),
}

function mockClient(): SailsClient {
  return {
    identity: {
      get: vi.fn().mockResolvedValue({ participantId: 'participant-1', displayName: 'Alice' }),
      create: vi.fn().mockResolvedValue({ participant: { participantId: 'participant-2', displayName: 'Bob' }, keypair: mockKeypair }),
      createWithPublicKey: vi.fn().mockResolvedValue({ participantId: 'participant-3', displayName: 'Charlie' }),
      createWithWallet: vi.fn().mockResolvedValue({ participantId: 'participant-4', displayName: 'Dana' }),
      challenge: vi.fn().mockResolvedValue({ challenge: 'challenge-123', expiresIn: 300 }),
      authenticate: vi.fn().mockResolvedValue({ token: 'session-token-123' }),
      authenticateWithWallet: vi.fn().mockResolvedValue({ token: 'wallet-session-token-123' }),
    },
  } as unknown as SailsClient
}

function errorClient(): SailsClient {
  return {
    identity: {
      get: vi.fn().mockRejectedValue(new Error('Get failed')),
      create: vi.fn().mockRejectedValue(new Error('Create failed')),
      createWithPublicKey: vi.fn().mockRejectedValue(new Error('CreateWithPubKey failed')),
      createWithWallet: vi.fn().mockRejectedValue(new Error('CreateWithWallet failed')),
      challenge: vi.fn().mockRejectedValue(new Error('Challenge failed')),
      authenticate: vi.fn().mockRejectedValue(new Error('Auth failed')),
      authenticateWithWallet: vi.fn().mockRejectedValue(new Error('AuthWithWallet failed')),
    },
  } as unknown as SailsClient
}

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useSailsIdentity', () => {
  let client: SailsClient
  let queryClient: QueryClient

  beforeEach(() => {
    client = mockClient()
    queryClient = makeQueryClient()
  })

  function renderHookWithProvider(participantId?: string) {
    return renderHook(() => useSailsIdentity(participantId ?? 'participant-1'), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <SailsProvider client={client}>{children}</SailsProvider>
        </QueryClientProvider>
      ),
    })
  }

  it('get query calls client.identity.get with participantId', async () => {
    const { result } = renderHookWithProvider()

    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true)
    })

    expect(client.identity.get).toHaveBeenCalledWith('participant-1')
    expect(result.current.query.data).toEqual({ participantId: 'participant-1', displayName: 'Alice' })
  })

  it('get query is disabled if participantId is undefined', () => {
    const { result } = renderHook(() => useSailsIdentity(undefined), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <SailsProvider client={client}>{children}</SailsProvider>
        </QueryClientProvider>
      ),
    })
    expect(result.current.query.fetchStatus).toBe('idle')
    expect(result.current.query.isPending).toBe(true)
  })

  it('get query surfaces error when transport rejects', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()

    await waitFor(() => {
      expect(result.current.query.isError).toBe(true)
    })

    expect(result.current.query.error).toBeInstanceOf(Error)
    expect((result.current.query.error as Error).message).toBe('Get failed')
  })

  it('create mutation calls client.identity.create and invalidates on success', async () => {
    const { result } = renderHookWithProvider()

    await act(async () => {
      await result.current.create.mutateAsync({ keypair: mockKeypair, displayName: 'Bob' })
    })

    expect(client.identity.create).toHaveBeenCalledWith(mockKeypair, 'Bob')
  })

  it('create mutation surfaces error when transport rejects', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()

    await act(async () => {
      await expect(result.current.create.mutateAsync({ keypair: mockKeypair, displayName: 'Bob' })).rejects.toThrow('Create failed')
    })
  })

  it('createWithPublicKey mutation calls client.identity.createWithPublicKey', async () => {
    const { result } = renderHookWithProvider()

    await act(async () => {
      await result.current.createWithPublicKey.mutateAsync({ publicKeyHex: '010203', displayName: 'Charlie' })
    })

    expect(client.identity.createWithPublicKey).toHaveBeenCalledWith('010203', 'Charlie')
  })

  it('createWithWallet mutation calls client.identity.createWithWallet', async () => {
    const { result } = renderHookWithProvider()
    const mockWallet = { signMessage: vi.fn() }

    await act(async () => {
      await result.current.createWithWallet.mutateAsync({ publicKeyHex: '010203', wallet: mockWallet, displayName: 'Dana' })
    })

    expect(client.identity.createWithWallet).toHaveBeenCalledWith('010203', mockWallet, 'Dana')
  })

  it('challenge mutation calls client.identity.challenge', async () => {
    const { result } = renderHookWithProvider()

    await act(async () => {
      await result.current.challenge.mutateAsync('010203')
    })

    expect(client.identity.challenge).toHaveBeenCalledWith('010203')
  })

  it('authenticate mutation calls client.identity.authenticate', async () => {
    const { result } = renderHookWithProvider()

    await act(async () => {
      await result.current.authenticate.mutateAsync(mockKeypair)
    })

    expect(client.identity.authenticate).toHaveBeenCalledWith(mockKeypair)
  })

  it('authenticateWithWallet mutation calls client.identity.authenticateWithWallet', async () => {
    const { result } = renderHookWithProvider()
    const mockWallet = { signMessage: vi.fn() }

    await act(async () => {
      await result.current.authenticateWithWallet.mutateAsync({ publicKeyHex: '010203', wallet: mockWallet })
    })

    expect(client.identity.authenticateWithWallet).toHaveBeenCalledWith('010203', mockWallet)
  })
})
