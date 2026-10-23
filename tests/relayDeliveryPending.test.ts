import { RelayDeliveryPendingRegistry, RELAY_MAX_PENDING_DELIVERIES } from '../src/infrastructure/p2p/relay-delivery-pending'

describe('bounded cross-instance delivery pending registry', () => {
  it('correlates ACK and rejects replay or mismatched ACK', async () => {
    const registry = new RelayDeliveryPendingRegistry()
    const pending = registry.register()!
    expect(registry.acknowledge({ requestId: 'unrelated', accepted: true })).toBe(false)
    expect(registry.acknowledge({ requestId: pending.requestId, accepted: 'true' })).toBe(false)
    expect(registry.acknowledge({ requestId: pending.requestId, accepted: true })).toBe(true)
    expect(await pending.result).toBe(true)
    expect(registry.acknowledge({ requestId: pending.requestId, accepted: true })).toBe(false)
    expect(registry.size).toBe(0)
    registry.close()
  })

  it('settles a valid negative ACK immediately and rejects its replay', async () => {
    const registry = new RelayDeliveryPendingRegistry()
    const pending = registry.register()!
    expect(registry.acknowledge({ requestId: pending.requestId, accepted: false })).toBe(true)
    expect(await pending.result).toBe(false)
    expect(registry.size).toBe(0)
    expect(registry.acknowledge({ requestId: pending.requestId, accepted: true })).toBe(false)
    registry.close()
  })

  it('caps outstanding requests and releases capacity after rejection', async () => {
    const registry = new RelayDeliveryPendingRegistry()
    const entries = Array.from({ length: RELAY_MAX_PENDING_DELIVERIES }, () => registry.register()!)
    expect(registry.size).toBe(RELAY_MAX_PENDING_DELIVERIES)
    expect(registry.register()).toBeNull()
    expect(registry.reject(entries[0].requestId)).toBe(true)
    expect(await entries[0].result).toBe(false)
    expect(registry.register()).not.toBeNull()
    registry.close()
    expect(await Promise.all(entries.slice(1).map(x => x.result))).toEqual(
      Array(RELAY_MAX_PENDING_DELIVERIES - 1).fill(false),
    )
    expect(registry.size).toBe(0)
    expect(registry.register()).toBeNull()
  })

  it('expires unanswered requests and rejects late ACKs', async () => {
    jest.useFakeTimers()
    try {
      const registry = new RelayDeliveryPendingRegistry()
      const pending = registry.register()!
      jest.advanceTimersByTime(3001)
      expect(await pending.result).toBe(false)
      expect(registry.acknowledge({ requestId: pending.requestId, accepted: true })).toBe(false)
      registry.close()
    } finally {
      jest.useRealTimers()
    }
  })
})
