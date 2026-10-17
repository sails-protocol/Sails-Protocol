/**
 * ws-auth.ts — extracted from chat.routes.ts/relay.routes.ts, which each
 * had their own identical copy of this ticket-resolution logic (found
 * while wiring relay.routes.ts, which would have made it a third copy).
 *
 * Migrated 2026-08-15 (security review P1): resolveParticipantFromToken
 * (looked up a raw, reusable, long-lived session token) replaced by
 * resolveParticipantFromTicket (looks up AND burns a short-lived,
 * single-use ticket) — see ws-auth.ts's own header for the full
 * rationale.
 *
 * Issue #301 — the file previously mocked `redis.get`/`redis.del`
 * directly and proved only SEQUENTIAL reuse (a second call after the
 * first had already completed and manually re-mocked `get` to return
 * null) — never genuine concurrent consumption. Ticket consumption
 * still delegates to `atomicConsume()` (`common/redis/atomic-consume.ts`),
 * while the parent session is checked separately after the atomic burn.
 * The concurrency tests below back that mock with a real, synchronous,
 * Map-based get-and-delete-once implementation — not a canned per-call
 * return sequence — so "10 concurrent calls, exactly 1 winner" is a
 * genuine property of the mock's own atomic step, matching what the real
 * Lua-script primitive guarantees server-side (proven separately against
 * real Redis in tests/integration/atomicRedisConsume.test.ts).
 */
export {} // same forced-module reasoning as chatUnification.test.ts

const mockAtomicConsume = jest.fn()
const mockRedisGet = jest.fn()
jest.mock('../src/common/redis/atomic-consume', () => ({
  atomicConsume: (...args: unknown[]) => mockAtomicConsume(...args),
}))
jest.mock('../src/common/redis', () => ({
  redis: { get: (...args: unknown[]) => mockRedisGet(...args) },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveParticipantFromTicket } = require('../src/common/middleware/ws-auth')

describe('resolveParticipantFromTicket (ws-auth.ts)', () => {
  beforeEach(() => {
    mockAtomicConsume.mockReset()
    mockRedisGet.mockReset()
  })

  it('returns null without querying Redis when no ticket is given', async () => {
    const result = await resolveParticipantFromTicket(undefined)
    expect(result).toBeNull()
    expect(mockAtomicConsume).not.toHaveBeenCalled()
  })

  it('delegates to atomicConsume() with the auth:ws-ticket: prefixed key and returns its result', async () => {
    mockAtomicConsume.mockResolvedValueOnce(JSON.stringify({ participantId: 'participant-42', sessionToken: 'session-42' }))
    mockRedisGet.mockResolvedValueOnce('participant-42')

    const result = await resolveParticipantFromTicket('some-ticket')

    expect(mockAtomicConsume).toHaveBeenCalledWith('auth:ws-ticket:some-ticket')
    expect(result).toBe('participant-42')
  })

  it('returns null for an expired or unknown ticket (atomicConsume itself returns null)', async () => {
    mockAtomicConsume.mockResolvedValueOnce(null)
    const result = await resolveParticipantFromTicket('expired-ticket')
    expect(result).toBeNull()
  })

  it('atomically consumes the ticket before checking its parent session', async () => {
    mockAtomicConsume.mockResolvedValueOnce(JSON.stringify({ participantId: 'participant-42', sessionToken: 'session-42' }))
    mockRedisGet.mockResolvedValueOnce('participant-42')
    await resolveParticipantFromTicket('some-ticket')
    expect(mockAtomicConsume).toHaveBeenCalledTimes(1)
    expect(mockRedisGet).toHaveBeenCalledWith('auth:session:session-42')
  })

  it('rejects a ticket whose parent session has been revoked', async () => {
    mockAtomicConsume.mockResolvedValueOnce(JSON.stringify({ participantId: 'participant-42', sessionToken: 'revoked-session' }))
    mockRedisGet.mockResolvedValueOnce(null)

    await expect(resolveParticipantFromTicket('revoked-parent-ticket')).resolves.toBeNull()
  })
})

// Issue #301, adversarial requirement 4 — same WS ticket x 10 concurrent
// resolutions -> exactly 1 returns participantId, 9 return null. Backs
// the atomicConsume() mock with a real synchronous Map so the "exactly
// one winner" property is genuinely exercised by 10 simultaneously
// in-flight calls against the SAME underlying store, not scripted.
describe('resolveParticipantFromTicket — concurrent consumption (Issue #301)', () => {
  function installRealAtomicConsumeMock() {
    const store = new Map<string, string>()
    mockAtomicConsume.mockImplementation(async (key: string) => {
      const value = store.get(key)
      if (value === undefined) return null
      store.delete(key)
      return value
    })
    mockRedisGet.mockImplementation(async (key: string) => key === 'auth:session:session-42' ? 'participant-42' : null)
    return store
  }

  beforeEach(() => mockAtomicConsume.mockReset())

  it('10 concurrent resolutions of the SAME ticket: exactly 1 returns the participantId, 9 return null', async () => {
    const store = installRealAtomicConsumeMock()
    store.set('auth:ws-ticket:shared-ticket', JSON.stringify({ participantId: 'participant-42', sessionToken: 'session-42' }))

    const results = await Promise.all(
      Array.from({ length: 10 }, () => resolveParticipantFromTicket('shared-ticket'))
    )

    const winners = results.filter((r) => r === 'participant-42')
    const losers = results.filter((r) => r === null)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(9)
  })

  it('an already-expired/missing ticket: zero winners across 10 concurrent attempts', async () => {
    installRealAtomicConsumeMock() // empty store — nothing set for this key

    const results = await Promise.all(
      Array.from({ length: 10 }, () => resolveParticipantFromTicket('never-issued-ticket'))
    )

    expect(results.every((r) => r === null)).toBe(true)
  })
})
