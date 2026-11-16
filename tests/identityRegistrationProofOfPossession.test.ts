/**
 * Issue #302 — "Identity knowledge != Identity registration authority."
 * Adversarial suite for the mandatory registration proof-of-possession
 * property: canonical `User` creation now requires current proof of
 * possession of the submitted Ed25519 public key (a real registration
 * challenge, signed with the domain-separated construction
 * registrationProofMessage(), validated BEFORE the challenge is
 * consumed via #301's atomicCompareAndConsume()).
 *
 * Exercises the real (unmocked) identityService.register() and the real
 * (unmocked) common/middleware/auth.ts registration functions — only
 * Prisma and Redis are mocked, with the Redis mock reimplementing the
 * two real Lua scripts' semantics against a shared Map (the same
 * discipline tests/routes.test.ts's own redis mock already established
 * for #301), not a "always succeeds" stub. Real Ed25519 keypairs (via
 * tweetnacl) sign real messages — no signature is ever faked.
 *
 * tests/routes.test.ts covers the wire-level (HTTP) proof of a subset of
 * these properties; this file is the service/module-level proof of the
 * full adversarial list (mission requirements A, B, D-I — C is proven
 * here too as an application-layer property, with the real-Redis/
 * real-process-equivalent proof in
 * tests/integration/atomicRedisConsume.test.ts and this mission's own
 * tests/integration/registrationProofOfPossessionLive.test.ts; real
 * Postgres uniqueness — requirement K — is
 * tests/integration/registrationProofOfPossessionLive.test.ts's other half).
 */
import nacl from 'tweetnacl'

const mockUserFindUnique = jest.fn()
const mockUserCreate = jest.fn()

jest.mock('../src/common/database', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
    },
  },
}))

// Same real-Lua-semantics simulation tests/routes.test.ts's own redis
// mock uses — discriminated by whether the script references ARGV[1]
// (atomicCompareAndConsume's own tell, vs. atomicConsume's plain GETDEL
// equivalent). A real, if minimal, semantic reimplementation, not a
// call-count/always-succeeds stub — this is what lets the concurrency
// tests below (C, D) prove a genuine "exactly one winner" property
// rather than assuming it.
const redisStore = new Map<string, string>()
jest.mock('../src/common/redis', () => ({
  redis: {
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value)
      return Promise.resolve('OK')
    }),
    del: jest.fn((key: string) => {
      redisStore.delete(key)
      return Promise.resolve(1)
    }),
    eval: jest.fn((script: string, _numKeys: number, ...args: unknown[]) => {
      const key = args[0] as string
      if (script.includes('ARGV[1]')) {
        const expected = args[1] as string
        if (redisStore.get(key) === expected) {
          redisStore.delete(key)
          return Promise.resolve(1)
        }
        return Promise.resolve(0)
      }
      const current = redisStore.get(key)
      if (current === undefined) return Promise.resolve(null)
      redisStore.delete(key)
      return Promise.resolve(current)
    }),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { identityService } = require('../src/modules/open-identity/identity.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { issueRegistrationChallenge, registrationProofMessage } = require('../src/common/middleware/auth')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AuthError, ValidationError } = require('../src/common/errors')

function newKeypair() {
  const kp = nacl.sign.keyPair()
  return { publicKey: Buffer.from(kp.publicKey).toString('hex'), secretKey: kp.secretKey }
}

async function realProof(publicKey: string, secretKey: Uint8Array, displayName?: string): Promise<string> {
  const { challenge } = await issueRegistrationChallenge(publicKey)
  return Buffer.from(nacl.sign.detached(registrationProofMessage(challenge, displayName), secretKey)).toString('hex')
}

describe('Issue #302 — registration proof-of-possession adversarial suite', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redisStore.clear()
  })

  // A — known victim public key + attacker without the victim's private
  // key. Attacker requests a real challenge for the VICTIM's public key
  // (issuance is deliberately unauthenticated — anyone can request one),
  // but can only sign it with their OWN keypair. Must be rejected, zero
  // User created.
  it('A: an attacker who knows a victim public key but not its private key cannot register it', async () => {
    const victim = newKeypair()
    const attacker = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)

    const { challenge } = await issueRegistrationChallenge(victim.publicKey)
    const forgedSignature = Buffer.from(
      nacl.sign.detached(registrationProofMessage(challenge), attacker.secretKey)
    ).toString('hex')

    await expect(identityService.register({ publicKey: victim.publicKey, signature: forgedSignature })).rejects.toThrow(AuthError)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  // B — invalid signature against a legitimate outstanding challenge
  // must NOT consume it; the legitimate holder must still be able to
  // register with a correct signature afterward.
  it('B: an invalid signature does not consume the challenge — the legitimate holder can still register afterward', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)

    const { challenge } = await issueRegistrationChallenge(holder.publicKey)

    await expect(
      identityService.register({ publicKey: holder.publicKey, signature: 'a'.repeat(128) })
    ).rejects.toThrow(AuthError)
    expect(mockUserCreate).not.toHaveBeenCalled()

    const goodSignature = Buffer.from(nacl.sign.detached(registrationProofMessage(challenge), holder.secretKey)).toString('hex')
    mockUserCreate.mockResolvedValueOnce({ id: 'user-1', publicKey: holder.publicKey })
    const participant = await identityService.register({ publicKey: holder.publicKey, signature: goodSignature })
    expect(participant.id).toBe('user-1')
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
  })

  // C — the same valid registration proof presented 10 times
  // concurrently must produce exactly one canonical User; the other 9
  // must fail closed (the challenge is already consumed), never
  // silently succeed or double-create.
  it('C: the same valid registration proof submitted 10 times concurrently produces exactly one User', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)
    mockUserCreate.mockResolvedValue({ id: 'user-1', publicKey: holder.publicKey })

    const signature = await realProof(holder.publicKey, holder.secretKey)

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => identityService.register({ publicKey: holder.publicKey, signature }))
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(9)
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
  })

  // D — two concurrent, individually valid registration submissions for
  // the SAME public key but CONFLICTING displayName values racing the
  // SAME shared challenge. Exactly one User must be created; the loser
  // must never be able to overwrite the winner's metadata afterward.
  // Deterministic winner semantics: whichever caller's atomic consume of
  // the shared challenge lands first — not "last write wins," not a
  // merge of both displayNames.
  it('D: conflicting displayName values racing the same challenge — exactly one User, no later metadata takeover', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)
    mockUserCreate.mockImplementation((args: any) => Promise.resolve({ id: 'user-1', publicKey: holder.publicKey, displayName: args.data.displayName }))

    const { challenge } = await issueRegistrationChallenge(holder.publicKey)
    const sigAlice = Buffer.from(nacl.sign.detached(registrationProofMessage(challenge, 'Alice'), holder.secretKey)).toString('hex')
    const sigMallory = Buffer.from(nacl.sign.detached(registrationProofMessage(challenge, 'Mallory'), holder.secretKey)).toString('hex')

    const [aliceResult, malloryResult] = await Promise.allSettled([
      identityService.register({ publicKey: holder.publicKey, signature: sigAlice, displayName: 'Alice' }),
      identityService.register({ publicKey: holder.publicKey, signature: sigMallory, displayName: 'Mallory' }),
    ])

    const outcomes = [aliceResult, malloryResult]
    const winners = outcomes.filter((r) => r.status === 'fulfilled')
    const losers = outcomes.filter((r) => r.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(mockUserCreate).toHaveBeenCalledTimes(1)

    const winnerDisplayName = (winners[0] as PromiseFulfilledResult<any>).value.displayName
    expect(['Alice', 'Mallory']).toContain(winnerDisplayName)

    // The loser's displayName must never appear as a takeover of an
    // already-registered identity: a follow-up attempt for the same
    // (now-registered) key with the loser's own displayName is rejected
    // by the pre-check, never silently applied.
    mockUserFindUnique.mockResolvedValue({ id: 'user-1', publicKey: holder.publicKey, displayName: winnerDisplayName })
    const loserDisplayName = winnerDisplayName === 'Alice' ? 'Mallory' : 'Alice'
    await expect(
      identityService.register({ publicKey: holder.publicKey, signature: 'irrelevant-already-registered', displayName: loserDisplayName })
    ).rejects.toThrow(ValidationError)
    expect(mockUserCreate).toHaveBeenCalledTimes(1)
  })

  // E — a stale observed challenge, after a replacement challenge has
  // been issued for the same public key, must not be able to consume
  // the replacement.
  it('E: a stale signature over a replaced challenge cannot consume the replacement challenge', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)

    const { challenge: staleChallenge } = await issueRegistrationChallenge(holder.publicKey)
    const staleSignature = Buffer.from(nacl.sign.detached(registrationProofMessage(staleChallenge), holder.secretKey)).toString('hex')

    // A fresh challenge is issued for the same key, replacing the stale one.
    await issueRegistrationChallenge(holder.publicKey)

    await expect(identityService.register({ publicKey: holder.publicKey, signature: staleSignature })).rejects.toThrow(AuthError)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  // F — an expired challenge (simulated here the same way a real TTL
  // expiry manifests: the key is simply gone from the store by the time
  // registration is attempted) must produce zero registrations.
  it('F: an expired challenge produces zero registrations', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)

    const { challenge } = await issueRegistrationChallenge(holder.publicKey)
    const signature = Buffer.from(nacl.sign.detached(registrationProofMessage(challenge), holder.secretKey)).toString('hex')

    // Simulate real Redis TTL expiry — the key is gone by the time the
    // registration request arrives.
    redisStore.clear()

    await expect(identityService.register({ publicKey: holder.publicKey, signature })).rejects.toThrow(AuthError)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  // G — a public key for which no registration challenge was EVER
  // issued must produce zero registrations, not fall back to any other
  // acceptance path.
  it('G: a public key with no challenge ever issued produces zero registrations', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)
    const bogusSignature = Buffer.from(nacl.sign.detached(registrationProofMessage('never-issued-challenge'), holder.secretKey)).toString('hex')

    await expect(identityService.register({ publicKey: holder.publicKey, signature: bogusSignature })).rejects.toThrow(AuthError)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  // H — malformed signature payload fails safely and does not burn a
  // legitimate outstanding challenge.
  it('H: a malformed (non-hex) signature fails safely without burning the legitimate challenge', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue(null)
    const { challenge } = await issueRegistrationChallenge(holder.publicKey)

    await expect(
      identityService.register({ publicKey: holder.publicKey, signature: 'not-hex-at-all-!!' })
    ).rejects.toThrow(AuthError)
    expect(mockUserCreate).not.toHaveBeenCalled()

    // The legitimate challenge must still be usable afterward.
    const goodSignature = Buffer.from(nacl.sign.detached(registrationProofMessage(challenge), holder.secretKey)).toString('hex')
    mockUserCreate.mockResolvedValueOnce({ id: 'user-1', publicKey: holder.publicKey })
    await expect(identityService.register({ publicKey: holder.publicKey, signature: goodSignature })).resolves.toMatchObject({ id: 'user-1' })
  })

  // I — an already-registered public key cannot be used to replace
  // metadata or canonical identity via this endpoint, even with a fully
  // valid, freshly-produced proof of possession by the real key holder.
  // Authentication of the legitimate key holder (a separate concern —
  // /v1/identity/authenticate) is untouched by this rejection.
  it('I: an already-registered public key rejects registration even with a valid fresh proof — no metadata/identity takeover', async () => {
    const holder = newKeypair()
    mockUserFindUnique.mockResolvedValue({ id: 'user-1', publicKey: holder.publicKey, displayName: 'Original Name' })

    const signature = await realProof(holder.publicKey, holder.secretKey, 'New Hijacked Name')

    await expect(
      identityService.register({ publicKey: holder.publicKey, signature, displayName: 'New Hijacked Name' })
    ).rejects.toThrow(ValidationError)
    expect(mockUserCreate).not.toHaveBeenCalled()
  })
})
