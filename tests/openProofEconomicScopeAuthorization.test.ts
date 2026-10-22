/**
 * Issue #261 — OpenProof economic-scope authorization boundaries.
 *
 * Two halves, per the mission's own required verification shape:
 *
 * 1. HTTP-level (app.inject() through the real route + real requireAuth
 *    + the real service layer) — proves the full stack, multiple
 *    trades/participants, real cross-scope isolation. Same technique
 *    tests/proofBundleAccess.test.ts already establishes for the
 *    trade-scoped bundle route (its own header comment explains why
 *    this lives in its own file, not tests/routes.test.ts's shared
 *    budget — same reasoning applies here).
 *
 * 2. Direct-service-call section — proves the authorization boundary
 *    lives in ProofService itself, not only at the route layer: calling
 *    proofService.<method>() directly, bypassing app.inject()/requireAuth
 *    entirely, still refuses an unrelated actor. This is the mission's
 *    own explicit "Core design requirement": route-only checks are
 *    insufficient.
 */
import type { FastifyInstance } from 'fastify'
import nacl from 'tweetnacl'
import { createHash } from 'crypto'

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSigs: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))

jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: { start: jest.fn(), stop: jest.fn(), get: jest.fn(), getStatus: jest.fn() },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: {
    emit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    onDurable: jest.fn(),
    getEvents: jest.fn().mockResolvedValue([]),
    durable: true,
    storeName: 'postgres',
  },
}))

// Issue #265 CTO Gate R2, BLOCKER 2 — attachEvidence() now rejects when
// the provider's returned sha256 doesn't match the signed digest, so
// this fake provider must behave like a real one and recompute its own
// hash from whatever bytes it's actually given, not return a fixed
// fake value that would never match any real media this file sends.
jest.mock('../src/modules/open-proof/evidence-provider', () => ({
  evidenceProvider: {
    store: jest.fn((media: Uint8Array) =>
      Promise.resolve({
        provider: 'local-fs',
        uri: '/tmp/fake',
        sha256: require('crypto').createHash('sha256').update(media).digest('hex'),
      })
    ),
  },
}))

jest.mock('../src/modules/open-proof/timestamp-anchor', () => ({
  timestampAnchor: { anchor: jest.fn().mockResolvedValue({ anchorType: 'opentimestamps', anchorId: 'x', submittedAt: new Date().toISOString(), upgraded: false }) },
}))

// #267 quota/rate mechanics are proved in their dedicated suites. #261's
// purpose here is HTTP + service economic-scope authorization, so keep those
// new collaborators deterministic while preserving the required request contract.
jest.mock('../src/common/middleware/redis-rate-limit', () => {
  const actual = jest.requireActual('../src/common/middleware/redis-rate-limit')
  return { ...actual, consumeSharedRateLimitKeys: jest.fn().mockResolvedValue(undefined) }
})
jest.mock('../src/modules/open-proof/evidence-quota', () => ({
  reserveEvidenceQuota: jest.fn(async (input: any) => ({ id: 'scope-reservation', status: 'RESERVED', evidenceRefId: null, ...input })),
  markEvidenceReservationUnknown: jest.fn().mockResolvedValue(undefined),
  commitEvidenceReservation: jest.fn(async (_id: string, stored: any, signature: string) => ({
    id: 'ref-new', proofId: PROOF_TRADE1.id, provider: stored.provider, uri: stored.uri, signature,
  })),
  persistCanonicalEvidenceSubmittedEvent: jest.fn().mockResolvedValue({ id: 'scope-event' }),
}))

// ─── Fixtures: two trades, four participants, one outsider, one arbiter,
// one replaced (historical) arbiter. Real cross-scope isolation requires
// more than one trade — a single-trade fixture could not distinguish
// "correctly scoped" from "coincidentally permissive."
const TRADE_1_ID = 'trade-1'
const TRADE_2_ID = 'trade-2'
const BUYER_1 = 'buyer-1'
const SELLER_1 = 'seller-1'
const BUYER_2 = 'buyer-2'
const SELLER_2 = 'seller-2'
const OUTSIDER = 'outsider-1'
const CURRENT_ARBITER = 'arbiter-current'
const OLD_ARBITER = 'arbiter-old' // replaced — must NOT retain authority (Past Authority != Current Authority)

const TRADE_1 = { id: TRADE_1_ID, buyerId: BUYER_1, sellerId: SELLER_1, status: 'ACTIVE' }
const TRADE_2 = { id: TRADE_2_ID, buyerId: BUYER_2, sellerId: SELLER_2, status: 'ACTIVE' }

// Dispute row for trade-1: arbiterId is CURRENT_ARBITER, OLD_ARBITER is
// only in previousArbiterId — the exact shape RFC-021 D6's appeal
// reassignment produces (overwrite in place, never a second row).
const DISPUTE_1 = { id: 'dispute-1', tradeId: TRADE_1_ID, arbiterId: CURRENT_ARBITER, previousArbiterId: OLD_ARBITER }

const CLAIM_TRADE1 = { id: 'claim-trade1', tradeId: TRADE_1_ID, claimedBy: BUYER_1, claimType: 'payment_sent', assertion: {}, createdAt: new Date() }
const CLAIM_TRADE2 = { id: 'claim-trade2', tradeId: TRADE_2_ID, claimedBy: BUYER_2, claimType: 'payment_sent', assertion: {}, createdAt: new Date() }
const CLAIM_NONTRADE = { id: 'claim-nontrade', tradeId: null, claimedBy: BUYER_1, claimType: 'keypair_control', assertion: {}, createdAt: new Date() }

const PROOF_TRADE1 = { id: 'proof-trade1', claimId: CLAIM_TRADE1.id, claim: CLAIM_TRADE1, evidence: {}, evidenceHash: 'h1', submittedBy: BUYER_1 }

const EVIDENCE_REF_TRADE1 = { id: 'ref-trade1', proofId: PROOF_TRADE1.id, sha256: 'a'.repeat(64), proof: { claim: CLAIM_TRADE1 } }

const redisStore = new Map<string, string>()
jest.mock('../src/common/redis', () => ({
  redis: {
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value)
      return Promise.resolve('OK')
    }),
    del: jest.fn((key: string) => {
      const existed = redisStore.has(key)
      redisStore.delete(key)
      return Promise.resolve(existed ? 1 : 0)
    }),
    // Issue #301 — verifyProof() now consumes its verification nonce via
    // atomicConsume()/redis.eval() rather than a separate get+del; this
    // genuinely reimplements common/redis/atomic-consume.ts's Lua
    // script against the same redisStore (a real, if minimal, semantic
    // simulation, not a call-count stub).
    eval: jest.fn((script: string, _numKeys: number, ...args: unknown[]) => {
      const key = args[0] as string
      const current = redisStore.get(key)
      if (current === undefined) return Promise.resolve(null)
      redisStore.delete(key)
      return Promise.resolve(current)
    }),
    ping: jest.fn().mockResolvedValue('PONG'),
  },
}))

jest.mock('../src/common/database', () => ({
  prisma: {
    trade: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.id === TRADE_1_ID) return Promise.resolve(TRADE_1)
        if (where.id === TRADE_2_ID) return Promise.resolve(TRADE_2)
        return Promise.resolve(null)
      }),
    },
    dispute: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(where.tradeId === TRADE_1_ID && where.arbiterId === CURRENT_ARBITER ? DISPUTE_1 : null)
      ),
    },
    claim: {
      create: jest.fn(({ data }: any) => Promise.resolve({ id: 'claim-new', ...data, createdAt: new Date() })),
      findUnique: jest.fn(({ where }: any) => {
        if (where.id === CLAIM_TRADE1.id) return Promise.resolve({ ...CLAIM_TRADE1, proofs: [] })
        if (where.id === CLAIM_TRADE2.id) return Promise.resolve({ ...CLAIM_TRADE2, proofs: [] })
        if (where.id === CLAIM_NONTRADE.id) return Promise.resolve({ ...CLAIM_NONTRADE, proofs: [] })
        return Promise.resolve(null)
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    proof: {
      create: jest.fn(({ data }: any) => Promise.resolve({ id: 'proof-new', ...data, submittedAt: new Date() })),
      findUnique: jest.fn(({ where }: any) => (where.id === PROOF_TRADE1.id ? Promise.resolve(PROOF_TRADE1) : Promise.resolve(null))),
      findMany: jest.fn().mockResolvedValue([]),
    },
    verification: {
      create: jest.fn(({ data }: any) => Promise.resolve({ id: 'verification-new', ...data, verifiedAt: new Date() })),
    },
    evidenceReference: {
      create: jest.fn(({ data }: any) => Promise.resolve({ id: 'ref-new', ...data })),
      findUnique: jest.fn(({ where }: any) => (where.id === EVIDENCE_REF_TRADE1.id ? Promise.resolve(EVIDENCE_REF_TRADE1) : Promise.resolve(null))),
      update: jest.fn(({ where, data }: any) => Promise.resolve({ id: where.id, ...data })),
    },
    user: {
      // attachEvidence() looks up the submitter's registered public key —
      // real Ed25519 keypairs generated per-test below. Keyed by id (via
      // registerUserPublicKey(), below) rather than mockResolvedValueOnce()
      // queuing — a queued value left unconsumed by a DENIED request
      // (authorization refuses before this lookup ever runs) would
      // otherwise leak into a LATER test's own lookup, silently verifying
      // against the wrong keypair.
      findUnique: jest.fn(({ where }: any) => Promise.resolve(registeredUsers.get(where.id) ?? null)),
    },
  },
}))

async function authedSession(participantId: string): Promise<string> {
  const token = `session-${participantId}`
  redisStore.set(`auth:session:${token}`, participantId)
  return token
}

const registeredUsers = new Map<string, { id: string; publicKey: string }>()
function registerUserPublicKey(id: string, publicKey: string): void {
  registeredUsers.set(id, { id, publicKey })
}

describe('OpenProof economic-scope authorization (Issue #261) — HTTP level', () => {
  jest.setTimeout(30_000)
  let app: FastifyInstance

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  // ─── 1. Claim creation ──────────────────────────────────────────────
  describe('Claim creation', () => {
    it('DENY — an outsider cannot create a trade-bound Claim for a trade they are not party to', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/claims',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimType: 'payment_sent', assertion: {}, tradeId: TRADE_1_ID },
      })
      expect(res.statusCode).toBe(403)
    })

    it('DENY — a participant of a DIFFERENT trade cannot create a Claim scoped to trade-1', async () => {
      const token = await authedSession(BUYER_2) // buyer of trade-2, not trade-1
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/claims',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimType: 'payment_sent', assertion: {}, tradeId: TRADE_1_ID },
      })
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — the buyer of trade-1 can create a Claim scoped to trade-1', async () => {
      const token = await authedSession(BUYER_1)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/claims',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimType: 'payment_sent', assertion: {}, tradeId: TRADE_1_ID },
      })
      expect(res.statusCode).toBe(201)
    })

    it('ALLOW — the seller of trade-1 can also create a Claim scoped to trade-1', async () => {
      const token = await authedSession(SELLER_1)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/claims',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimType: 'payment_sent', assertion: {}, tradeId: TRADE_1_ID },
      })
      expect(res.statusCode).toBe(201)
    })

    it('ALLOW — a non-trade Claim is unaffected (no tradeId supplied) — preserves the legitimate non-trade use case', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/claims',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimType: 'keypair_control', assertion: {} },
      })
      expect(res.statusCode).toBe(201)
    })
  })

  // ─── 2. Proof submission ────────────────────────────────────────────
  describe('Proof submission', () => {
    it('DENY — an outsider cannot submit a Proof to another actor\'s Claim', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_TRADE1.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(403)
    })

    it('DENY — a participant of trade-2 cannot submit a Proof to trade-1\'s Claim', async () => {
      const token = await authedSession(SELLER_2)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_TRADE1.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — the seller (counterparty, not the claimant) may submit a Proof for trade-1\'s Claim', async () => {
      const token = await authedSession(SELLER_1)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_TRADE1.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(201)
    })

    it('ALLOW — the current assigned arbiter of trade-1 may submit a Proof for trade-1\'s Claim', async () => {
      const token = await authedSession(CURRENT_ARBITER)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_TRADE1.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(201)
    })

    it('DENY — the REPLACED (old) arbiter no longer has authority — Past Authority != Current Authority', async () => {
      const token = await authedSession(OLD_ARBITER)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_TRADE1.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — a non-trade Claim\'s own creator may submit their own Proof', async () => {
      const token = await authedSession(BUYER_1)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_NONTRADE.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(201)
    })

    it('DENY — an outsider cannot submit a Proof to a non-trade Claim they did not create', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: '/v1/proof/proofs',
        headers: { authorization: `Bearer ${token}` },
        payload: { claimId: CLAIM_NONTRADE.id, evidence: { x: 1 } },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  // ─── 3. Evidence attachment — cryptographic validity != authorization ──
  describe('Evidence attachment', () => {
    it('DENY — User A produces a VALID signature over their own evidence, but has no authority over User B\'s unrelated trade-1 Proof — the required abuse case', async () => {
      const keypair = nacl.sign.keyPair()
      const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex')
      const media = Buffer.from('genuinely real photo bytes')
      const digest = createHash('sha256').update(media).digest()
      const signature = nacl.sign.detached(digest, keypair.secretKey)
      const signatureHex = Buffer.from(signature).toString('hex')
      registerUserPublicKey(OUTSIDER, publicKeyHex)

      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: { mediaBase64: media.toString('base64'), mimeType: 'image', signatureHex, idempotencyKey: 'scope-auth-buyer-evidence-1' },
      })

      // 403, not 201 — the signature genuinely verifies (proven by the
      // "ALLOW" test below using the identical crypto with an authorized
      // caller), so this failure can only be the authorization check.
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — the trade-1 buyer (authorized) attaching their own validly-signed evidence succeeds', async () => {
      const keypair = nacl.sign.keyPair()
      const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex')
      const media = Buffer.from('genuinely real photo bytes, buyer edition')
      const digest = createHash('sha256').update(media).digest()
      const signature = nacl.sign.detached(digest, keypair.secretKey)
      const signatureHex = Buffer.from(signature).toString('hex')
      registerUserPublicKey(BUYER_1, publicKeyHex)

      const token = await authedSession(BUYER_1)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: { mediaBase64: media.toString('base64'), mimeType: 'image', signatureHex, idempotencyKey: 'scope-auth-buyer-evidence-2' },
      })

      expect(res.statusCode).toBe(201)
    })
  })

  // ─── 4. Claim-scoped evidence bundle read ───────────────────────────
  describe('Claim-scoped evidence bundle read', () => {
    it('DENY — an authenticated unrelated actor cannot read trade-1\'s Claim bundle merely by knowing its id', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/claims/${CLAIM_TRADE1.id}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })

    it('DENY — a participant of trade-2 cannot read trade-1\'s Claim bundle', async () => {
      const token = await authedSession(BUYER_2)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/claims/${CLAIM_TRADE1.id}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — the buyer of trade-1 can read trade-1\'s Claim bundle', async () => {
      const token = await authedSession(BUYER_1)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/claims/${CLAIM_TRADE1.id}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('ALLOW — the current assigned arbiter of trade-1 can read trade-1\'s Claim bundle', async () => {
      const token = await authedSession(CURRENT_ARBITER)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/claims/${CLAIM_TRADE1.id}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('DENY — the replaced (old) arbiter can no longer read trade-1\'s Claim bundle', async () => {
      const token = await authedSession(OLD_ARBITER)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/claims/${CLAIM_TRADE1.id}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  // ─── 5. Verification nonce / Proof verification ─────────────────────
  describe('Verification nonce / Proof verification', () => {
    it('DENY — an outsider cannot even obtain a verification nonce for trade-1\'s Proof', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/verify-nonce`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })

    it('DENY — an outsider cannot submit a verification verdict for trade-1\'s Proof (even with a real nonce they could not have obtained)', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/verify`,
        headers: { authorization: `Bearer ${token}` },
        payload: { verdict: 'ACCEPTED', nonce: 'irrelevant-would-fail-here-first' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — the current assigned arbiter can obtain a nonce and verify trade-1\'s Proof', async () => {
      const token = await authedSession(CURRENT_ARBITER)
      const nonceRes = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/verify-nonce`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(nonceRes.statusCode).toBe(200)
      const { nonce } = JSON.parse(nonceRes.body).data

      const verifyRes = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/verify`,
        headers: { authorization: `Bearer ${token}` },
        payload: { verdict: 'ACCEPTED', nonce },
      })
      expect(verifyRes.statusCode).toBe(201)
    })

    it('DENY — the replaced (old) arbiter cannot obtain a verification nonce for trade-1\'s Proof', async () => {
      const token = await authedSession(OLD_ARBITER)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/proofs/${PROOF_TRADE1.id}/verify-nonce`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  // ─── 6. Evidence anchoring ───────────────────────────────────────────
  describe('Evidence anchoring', () => {
    it('DENY — an outsider cannot anchor evidence belonging to trade-1', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/evidence/${EVIDENCE_REF_TRADE1.id}/anchor`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })

    it('DENY — a participant of trade-2 cannot anchor evidence belonging to trade-1', async () => {
      const token = await authedSession(SELLER_2)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/evidence/${EVIDENCE_REF_TRADE1.id}/anchor`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })

    it('ALLOW — the buyer of trade-1 can anchor evidence belonging to trade-1', async () => {
      const token = await authedSession(BUYER_1)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/evidence/${EVIDENCE_REF_TRADE1.id}/anchor`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('ALLOW — the current assigned arbiter of trade-1 can anchor evidence belonging to trade-1', async () => {
      const token = await authedSession(CURRENT_ARBITER)
      const res = await app.inject({
        method: 'POST', url: `/v1/proof/evidence/${EVIDENCE_REF_TRADE1.id}/anchor`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // ─── Error semantics ─────────────────────────────────────────────────
  describe('Error semantics — authorization refusal is not NotFound/ValidationError/UNKNOWN', () => {
    it('an unauthorized bundle read returns 403 with the real ForbiddenError shape, not 404/400', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/claims/${CLAIM_TRADE1.id}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
      const body = JSON.parse(res.body)
      expect(body.success).toBe(false)
      expect(body.error).toBe('FORBIDDEN')
    })
  })

  // ─── Issue #264 — GET /v1/proof/trades/:tradeId/bundle stays green
  // after moving its authorization into the service boundary. The route
  // no longer calls tradeService.assertParticipant() itself — it's
  // proven here to still behave identically from the HTTP caller's
  // point of view (buyer/seller allowed, outsider refused), and that
  // knowing a valid tradeId alone is not authority.
  describe('Trade-scoped evidence bundle (Issue #264) — route remains green after the fix moves into the service', () => {
    it('ALLOW — the buyer of trade-1 can still read the trade bundle over HTTP', async () => {
      const token = await authedSession(BUYER_1)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/trades/${TRADE_1_ID}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('ALLOW — the seller of trade-1 can still read the trade bundle over HTTP', async () => {
      const token = await authedSession(SELLER_1)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/trades/${TRADE_1_ID}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('DENY — knowing a real tradeId alone is not authority: an authenticated outsider is still refused over HTTP', async () => {
      const token = await authedSession(OUTSIDER)
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/trades/${TRADE_1_ID}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })

    it('DENY — a participant of a DIFFERENT trade cannot read trade-1\'s bundle merely by supplying trade-1\'s id', async () => {
      const token = await authedSession(BUYER_2) // buyer of trade-2, not trade-1
      const res = await app.inject({
        method: 'GET', url: `/v1/proof/trades/${TRADE_1_ID}/bundle`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    })
  })
})

// ─── Direct-service-call section — proves the boundary is NOT route-only ──
describe('OpenProof economic-scope authorization (Issue #261) — direct service calls bypass app.inject()/requireAuth entirely', () => {
  it('proofService.submitProof() called directly (no HTTP, no route, no requireAuth) still refuses an unrelated actor', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { proofService } = require('../src/modules/open-proof/proof.service')
    await expect(
      proofService.submitProof({ claimId: CLAIM_TRADE1.id, evidence: { x: 1 }, submittedBy: OUTSIDER })
    ).rejects.toThrow(/no economic-scope authority/)
  })

  it('proofService.getEvidenceBundle() called directly still refuses an unrelated actor', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { proofService } = require('../src/modules/open-proof/proof.service')
    await expect(
      proofService.getEvidenceBundle(CLAIM_TRADE1.id, OUTSIDER)
    ).rejects.toThrow(/no economic-scope authority/)
  })

  it('proofService.verifyProof() called directly still refuses an unrelated actor, even with an otherwise-syntactically-valid call', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { proofService } = require('../src/modules/open-proof/proof.service')
    await expect(
      proofService.verifyProof(PROOF_TRADE1.id, OUTSIDER, 'ACCEPTED', 'any-nonce')
    ).rejects.toThrow(/no economic-scope authority/)
  })

  it('proofService.anchorEvidence() called directly still refuses an unrelated actor', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { proofService } = require('../src/modules/open-proof/proof.service')
    await expect(
      proofService.anchorEvidence(EVIDENCE_REF_TRADE1.id, OUTSIDER)
    ).rejects.toThrow(/no economic-scope authority/)
  })

  it('proofService.assertClaim() called directly still refuses creating a trade-bound Claim for an unrelated trade', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { proofService } = require('../src/modules/open-proof/proof.service')
    await expect(
      proofService.assertClaim({ claimedBy: OUTSIDER, claimType: 'payment_sent', assertion: {}, tradeId: TRADE_1_ID })
    ).rejects.toThrow(/not a party to trade/)
  })

  // Issue #264 — getEvidenceBundleForTrade() previously took no caller
  // identity at all; a direct service call had zero authorization,
  // relying entirely on the (now-removed) route-level check. Proven here
  // exactly like every other method above: buyer succeeds, seller
  // succeeds, an unrelated actor is refused, and merely knowing a real
  // tradeId is not authority.
  describe('proofService.getEvidenceBundleForTrade() — direct call, no HTTP, no route, no requireAuth', () => {
    it('ALLOW — the buyer of trade-1 can call it directly', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { proofService } = require('../src/modules/open-proof/proof.service')
      const bundle = await proofService.getEvidenceBundleForTrade(TRADE_1_ID, BUYER_1)
      expect(bundle.tradeId).toBe(TRADE_1_ID)
    })

    it('ALLOW — the seller of trade-1 can call it directly', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { proofService } = require('../src/modules/open-proof/proof.service')
      const bundle = await proofService.getEvidenceBundleForTrade(TRADE_1_ID, SELLER_1)
      expect(bundle.tradeId).toBe(TRADE_1_ID)
    })

    it('DENY — an unrelated authenticated participant is refused, proving the service boundary itself enforces authorization, not only the (now-removed) route-level check', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { proofService } = require('../src/modules/open-proof/proof.service')
      await expect(
        proofService.getEvidenceBundleForTrade(TRADE_1_ID, OUTSIDER)
      ).rejects.toThrow(/not a party to trade/)
    })

    it('DENY — a participant of a DIFFERENT trade is refused: knowing a valid tradeId string is not authority', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { proofService } = require('../src/modules/open-proof/proof.service')
      await expect(
        proofService.getEvidenceBundleForTrade(TRADE_1_ID, BUYER_2)
      ).rejects.toThrow(/not a party to trade/)
    })
  })
})
