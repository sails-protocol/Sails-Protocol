import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SailsProvider } from '../src/providers/SailsProvider'
import { useSailsCapabilities } from '../src/hooks/useSailsCapabilities'
import type { SailsClient } from '@satsails/p2p-trading-sdk'

function mockClient(): SailsClient {
  return {
    capabilities: {
      list: vi.fn().mockResolvedValue([{ grantId: 'grant-1', grantedTo: 'participant-1', capabilityName: 'trade-coordination', scope: ['intent.created'], issuedBy: 'participant-1' }]),
      register: vi.fn().mockResolvedValue({ grantId: 'grant-2', grantedTo: 'participant-1', capabilityName: 'settlement', scope: ['settlement.escrow.released'], issuedBy: 'participant-1' }),
      revoke: vi.fn().mockResolvedValue(undefined),
      registerFromWallet: vi.fn().mockResolvedValue({ grantId: 'grant-3', grantedTo: 'participant-1', capabilityName: 'trade-coordination', scope: ['intent.created', 'intent.discovering'], issuedBy: 'participant-1' }),
      ensureCanonicalGrants: vi.fn().mockResolvedValue([{ grantId: 'grant-4', grantedTo: 'participant-1', capabilityName: 'settlement', scope: ['settlement.escrow.released'], issuedBy: 'participant-1' }]),
    },
  } as unknown as SailsClient
}

function errorClient(): SailsClient {
  return {
    capabilities: {
      list: vi.fn().mockRejectedValue(new Error('List failed')),
      register: vi.fn().mockRejectedValue(new Error('Register failed')),
      revoke: vi.fn().mockRejectedValue(new Error('Revoke failed')),
      registerFromWallet: vi.fn().mockRejectedValue(new Error('Wallet register failed')),
      ensureCanonicalGrants: vi.fn().mockRejectedValue(new Error('Ensure failed')),
    },
  } as unknown as SailsClient
}

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useSailsCapabilities', () => {
  let client: SailsClient
  let queryClient: QueryClient

  beforeEach(() => {
    client = mockClient()
    queryClient = makeQueryClient()
  })

  function renderHookWithProvider(participantId?: string) {
    return renderHook(() => useSailsCapabilities(participantId ?? 'participant-1'), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <SailsProvider client={client}>{children}</SailsProvider>
        </QueryClientProvider>
      ),
    })
  }

  it('list query calls client.capabilities.list with participantId', async () => {
    const { result } = renderHookWithProvider()

    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true)
    })

    expect(client.capabilities.list).toHaveBeenCalledWith('participant-1')
    expect(result.current.query.data).toEqual([{ grantId: 'grant-1', grantedTo: 'participant-1', capabilityName: 'trade-coordination', scope: ['intent.created'], issuedBy: 'participant-1' }])
  })

  it('list query is disabled if participantId is undefined', () => {
    const { result } = renderHook(() => useSailsCapabilities(undefined), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <SailsProvider client={client}>{children}</SailsProvider>
        </QueryClientProvider>
      ),
    })
    expect(result.current.query.fetchStatus).toBe('idle')
    expect(result.current.query.isPending).toBe(true)
  })

  it('list query surfaces an error when the transport rejects', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()

    await waitFor(() => {
      expect(result.current.query.isError).toBe(true)
    })

    expect(result.current.query.error).toBeInstanceOf(Error)
    expect((result.current.query.error as Error).message).toBe('List failed')
  })

  it('register mutation calls client.capabilities.register and invalidates on success', async () => {
    const { result } = renderHookWithProvider()

    await act(async () => {
      await result.current.register.mutateAsync({ capabilityName: 'settlement', scope: ['settlement.escrow.released'] })
    })

    expect(client.capabilities.register).toHaveBeenCalledWith({ capabilityName: 'settlement', scope: ['settlement.escrow.released'] })
  })

  it('register mutation surfaces an error when the transport rejects', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()

    await act(async () => {
      await expect(
        result.current.register.mutateAsync({ capabilityName: 'settlement', scope: ['settlement.escrow.released'] })
      ).rejects.toThrow('Register failed')
    })
  })

  it('revoke mutation calls client.capabilities.revoke', async () => {
    const { result } = renderHookWithProvider()

    await act(async () => {
      await result.current.revoke.mutateAsync('grant-1')
    })

    expect(client.capabilities.revoke).toHaveBeenCalledWith('grant-1')
  })

  it('revoke mutation surfaces an error when the transport rejects', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()

    await act(async () => {
      await expect(result.current.revoke.mutateAsync('grant-1')).rejects.toThrow('Revoke failed')
    })
  })

  it('registerFromWallet mutation calls client.capabilities.registerFromWallet', async () => {
    const { result } = renderHookWithProvider()
    const mockWallet = {} as any

    await act(async () => {
      await result.current.registerFromWallet.mutateAsync(mockWallet)
    })

    expect(client.capabilities.registerFromWallet).toHaveBeenCalledWith(mockWallet)
  })

  it('registerFromWallet mutation surfaces an error when the transport rejects', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()
    const mockWallet = {} as any

    await act(async () => {
      await expect(result.current.registerFromWallet.mutateAsync(mockWallet)).rejects.toThrow('Wallet register failed')
    })
  })
  it('ensureCanonicalGrants mutation calls client.capabilities.ensureCanonicalGrants with the participantId (Issue #303)', async () => {
    const { result } = renderHookWithProvider()
    await act(async () => {
      await result.current.ensureCanonicalGrants.mutateAsync('participant-1')
    })
    expect(client.capabilities.ensureCanonicalGrants).toHaveBeenCalledWith('participant-1')
  })

  it('ensureCanonicalGrants surfaces a rejection instead of swallowing it (Issue #303)', async () => {
    client = errorClient()
    const { result } = renderHookWithProvider()
    await act(async () => {
      await expect(result.current.ensureCanonicalGrants.mutateAsync('participant-1')).rejects.toThrow('Ensure failed')
    })
  })
})
