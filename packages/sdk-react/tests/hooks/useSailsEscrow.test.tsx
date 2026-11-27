import { describe, it, expect } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SailsProvider } from '../../src/providers/SailsProvider'
import { useSailsEscrow } from '../../src/hooks/useSailsEscrow'
import { createMockSailsClient } from '../mocks/sails-client.mock'
import { mockEscrow } from '../mocks/trade.mock'

function makeWrapper(client: ReturnType<typeof createMockSailsClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <SailsProvider client={client}>{children}</SailsProvider>
      </QueryClientProvider>
    )
  }
}

describe('useSailsEscrow', () => {
  it('fetches the escrow by id', async () => {
    const escrow = mockEscrow({ id: 'escrow-9', status: 'CREATED' })
    const client = createMockSailsClient({ handleRequest: () => escrow })

    const { result } = renderHook(() => useSailsEscrow('escrow-9'), { wrapper: makeWrapper(client) })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
    expect(result.current.query.data).toEqual(escrow)
  })

  it('stays disabled when escrowId is undefined', () => {
    const client = createMockSailsClient()
    const { result } = renderHook(() => useSailsEscrow(undefined), { wrapper: makeWrapper(client) })
    expect(result.current.query.fetchStatus).toBe('idle')
  })

  it("canCreate is true only for the seller (D7: the buyer never creates the escrow)", () => {
    const wrapper = makeWrapper(createMockSailsClient())
    expect(renderHook(() => useSailsEscrow(undefined, { role: 'seller' }), { wrapper }).result.current.canCreate).toBe(true)
    expect(renderHook(() => useSailsEscrow(undefined, { role: 'buyer' }), { wrapper }).result.current.canCreate).toBe(false)
    expect(renderHook(() => useSailsEscrow(undefined), { wrapper }).result.current.canCreate).toBe(false)
  })

  it('lock() calls settlement.lock and invalidates the escrow query on success', async () => {
    let requestCount = 0
    const requestedUrls: string[] = []
    const client = createMockSailsClient({
      handleRequest: (url) => {
        requestCount += 1
        requestedUrls.push(url)
        return mockEscrow({ status: requestCount > 1 ? 'FUNDS_LOCKED' : 'CREATED' })
      },
    })

    const { result } = renderHook(() => useSailsEscrow('escrow-1'), { wrapper: makeWrapper(client) })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
    expect(result.current.query.data?.status).toBe('CREATED')

    await act(async () => {
      await result.current.lock.mutateAsync()
    })

    expect(requestedUrls.some((u) => u.includes('/escrow/escrow-1/lock'))).toBe(true)
    await waitFor(() => expect(result.current.query.data?.status).toBe('FUNDS_LOCKED'))
  })

  it('markPaymentSent() and refund() hit their respective endpoints', async () => {
    const requestedUrls: string[] = []
    const client = createMockSailsClient({
      handleRequest: (url) => {
        requestedUrls.push(url)
        return mockEscrow()
      },
    })

    const { result } = renderHook(() => useSailsEscrow('escrow-1'), { wrapper: makeWrapper(client) })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))

    await act(async () => {
      await result.current.markPaymentSent.mutateAsync()
    })
    await act(async () => {
      await result.current.refund.mutateAsync()
    })

    expect(requestedUrls.some((u) => u.includes('/escrow/escrow-1/payment-sent'))).toBe(true)
    expect(requestedUrls.some((u) => u.includes('/escrow/escrow-1/refund'))).toBe(true)
  })

  it('release() passes toAddress through to settlement.release', async () => {
    const bodies: unknown[] = []
    const client = createMockSailsClient({
      handleRequest: (_url, init) => {
        if (init.body) bodies.push(JSON.parse(String(init.body)))
        return mockEscrow({ status: 'COMPLETED' })
      },
    })

    const { result } = renderHook(() => useSailsEscrow('escrow-1'), { wrapper: makeWrapper(client) })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))

    await act(async () => {
      await result.current.release.mutateAsync('bc1qmockaddress')
    })

    expect(bodies).toContainEqual({ toAddress: 'bc1qmockaddress' })
  })

  it('dispute() passes reason and evidence through and returns a Dispute', async () => {
    const bodies: unknown[] = []
    const client = createMockSailsClient({
      handleRequest: (_url, init) => {
        if (init.body) bodies.push(JSON.parse(String(init.body)))
        return {
          id: 'dispute-1',
          tradeId: 'trade-1',
          escrowId: 'escrow-1',
          openedBy: 'buyer-1',
          reason: 'not received',
          evidence: ['photo.png'],
          arbiterId: 'arbiter-1',
          status: 'OPENED',
          ruling: null,
          resolvedAt: null,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        }
      },
    })

    const { result } = renderHook(() => useSailsEscrow('escrow-1'), { wrapper: makeWrapper(client) })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))

    const disputeResult = await act(async () =>
      result.current.dispute.mutateAsync({ reason: 'not received', evidence: ['photo.png'] })
    )

    expect(bodies).toContainEqual({ reason: 'not received', evidence: ['photo.png'] })
    expect(disputeResult).toMatchObject({ status: 'OPENED' })
  })
})
