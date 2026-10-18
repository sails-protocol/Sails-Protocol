import { consumeSharedRelayBudget } from '../src/infrastructure/p2p/relay-shared-budget'
import { RELAY_FRAME_MAX_BYTES } from '../src/infrastructure/p2p/relay-ingress-budget'

const evalMock = jest.fn()
jest.mock('../src/common/redis', () => ({
  redis: { eval: (...args: unknown[]) => evalMock(...args) },
}))

describe('shared relay budget — Redis atomic gate', () => {
  beforeEach(() => evalMock.mockReset())

  it('rejects oversize frames without invoking Redis', async () => {
    expect(await consumeSharedRelayBudget('a', RELAY_FRAME_MAX_BYTES + 1)).toBe(false)
    expect(await consumeSharedRelayBudget('a', -1)).toBe(false)
    expect(evalMock).not.toHaveBeenCalled()
  })

  it('uses one atomic Redis script with a participant-scoped key', async () => {
    evalMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    expect(await consumeSharedRelayBudget('participant-1', 42)).toBe(true)
    expect(await consumeSharedRelayBudget('participant-1', 42)).toBe(false)
    expect(evalMock).toHaveBeenCalledTimes(2)
    const args = evalMock.mock.calls[0]
    expect(args[1]).toBe(1)
    expect(args[2]).toBe('ratelimit:ws-relay:participant-1')
    expect(args[3]).toBe(42)
  })

  it('fails closed on Redis outage and unexpected result', async () => {
    evalMock.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce(null)
    expect(await consumeSharedRelayBudget('a', 1)).toBe(false)
    expect(await consumeSharedRelayBudget('a', 1)).toBe(false)
  })
})
