// tests/integration/offerEnvelopePersistenceRoundTrip.test.ts
//
// PR #100 CTO Gate correction (2026-09-09), Property E — persistence
// round-trip. docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md carries the full
// narrative; this file is the real, executable proof against an actual
// Postgres instance, not a mock.
//
// The concern this closes: `tests/offerEnvelope.test.ts` mocks
// `prisma.offerEnvelope.findFirst`/`create` entirely, so it can prove
// `ingest()`'s decision logic (owner continuity, revision ordering,
// signature verification) but it CANNOT prove that a value actually
// round-trips through real Postgres storage without silently changing
// bytes. The concrete risk: `Prisma.Decimal` strips trailing zeros on
// its own `.toString()` (confirmed directly: `new
// Prisma.Decimal('1.00000000').toString()` returns `"1"`, not
// `"1.00000000"`) — a naive reconstruction of a signed envelope from a
// DB row would silently produce different canonical bytes than what was
// originally signed, making a genuinely valid envelope look forged
// after nothing more than a save-and-reload.
//
// This test proves the full chain against a real database:
//   sign → ingest() → real Postgres row → reconstructSignedEnvelope()
//   → canonical bytes identical to the original → signature still verifies.

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import nacl from 'tweetnacl'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import {
  canonicalizeOfferEnvelope,
  hashOfferEnvelope,
  signOfferEnvelope,
  verifyOfferEnvelope,
  type OfferEnvelopeContent,
} from '../../src/modules/open-liquidity/offer-envelope'
import { OfferEnvelopeRepository, OfferEnvelopeIntegrityError, isOfferStateEconomicallyActive } from '../../src/modules/open-liquidity/offer-envelope-repository'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  return { publicKeyHex: hex(kp.publicKey), secretKeyHex: hex(kp.secretKey) }
}

describe('OfferEnvelope — persistence round-trip against real Postgres (Property E)', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let repo: OfferEnvelopeRepository

  // Every row this suite creates carries this prefix so cleanup can
  // target exactly (and only) its own rows, regardless of what else
  // may exist in this database.
  const TEST_LOGICAL_ID_PREFIX = 'offer-envelope-roundtrip-test-'

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (dbAvailable) {
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.getUrl() }) })
      // Repository under test talks to the shared `prisma` singleton
      // (src/common/database) — this suite instead drives Prisma
      // directly against the real test DB and calls
      // repo.reconstructSignedEnvelope() (a pure function, no DB access
      // of its own) on the rows it reads back, so it exercises the real
      // reconstruction logic without needing to swap the shared
      // singleton's connection.
      repo = new OfferEnvelopeRepository()
    }
  })

  afterAll(async () => {
    if (!dbAvailable) return
    // No cleanup: offer_envelopes is append-only (migration 20261111120000); every id here is unique per run.
    await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  it('a signed envelope with canonical, non-trivial-scale amounts round-trips to byte-identical canonical form and a still-valid signature', async () => {
    requirePostgres('offer envelope persistence round-trip')
    const { publicKeyHex, secretKeyHex } = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-a`

    const content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: publicKeyHex,
      asset: 'BTC',
      side: 'SELL',
      // Deliberately a value whose canonical form has trailing zeros —
      // exactly the case Prisma.Decimal.toString() would silently
      // mangle if reconstruction used it directly instead of
      // formatCanonicalDecimal()'s .toFixed(8).
      priceUsd: '65000.00000000',
      minAmount: '0.00100000',
      maxAmount: '0.50000000',
      paymentMethod: 'PIX',
      revision: 1,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    const signature = signOfferEnvelope(content, secretKeyHex)
    const signed = { ...content, signature }
    const originalCanonicalBytes = canonicalizeOfferEnvelope(content)

    // Insert directly (mirrors ingest()'s own create() call exactly —
    // this suite is proving the storage layer's fidelity, independent
    // of ingest()'s convergence/ownership decision logic, which is
    // already covered by tests/offerEnvelope.test.ts's mocked suite).
    await prisma.offerEnvelope.create({
      data: {
        logicalOfferId: signed.logicalOfferId,
        ownerPublicKey: signed.ownerPublicKey,
        asset: signed.asset,
        side: signed.side,
        priceUsd: signed.priceUsd,
        minAmount: signed.minAmount,
        maxAmount: signed.maxAmount,
        paymentMethod: signed.paymentMethod,
        revision: signed.revision,
        createdAt: new Date(signed.createdAt),
        revisedAt: new Date(signed.revisedAt),
        expiresAt: new Date(signed.expiresAt),
        status: signed.status,
        signature: signed.signature,
        contentDigest: hashOfferEnvelope(content).toString('hex'),
      },
    })

    const row = await prisma.offerEnvelope.findFirst({ where: { logicalOfferId } })
    expect(row).not.toBeNull()

    const reconstructed = repo.reconstructSignedEnvelope(row!)

    // The actual claim: reconstructed canonical bytes are IDENTICAL to
    // what was originally signed, not merely "close" or "numerically
    // equal" — byte equality is what a signature verification depends on.
    const reconstructedCanonicalBytes = canonicalizeOfferEnvelope(reconstructed)
    expect(reconstructedCanonicalBytes.equals(originalCanonicalBytes)).toBe(true)

    // And, as the end-to-end consequence of that byte identity: the
    // ORIGINAL signature still verifies against the RECONSTRUCTED
    // content read back from real Postgres.
    expect(verifyOfferEnvelope(reconstructed)).toEqual({ valid: true })
  })

  it('a value whose Prisma.Decimal.toString() would strip trailing zeros still reconstructs to the exact original canonical decimal string', async () => {
    requirePostgres('decimal trailing-zero round-trip')
    const { publicKeyHex, secretKeyHex } = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-b`

    const content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: publicKeyHex,
      asset: 'USDT_TRC20',
      side: 'BUY',
      // "1.00000000" is the exact case confirmed by hand to collapse to
      // "1" under Prisma.Decimal's own bare .toString().
      priceUsd: '1.00000000',
      minAmount: '10.00000000',
      maxAmount: '100.00000000',
      paymentMethod: 'TED',
      revision: 1,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    const signature = signOfferEnvelope(content, secretKeyHex)

    await prisma.offerEnvelope.create({
      data: {
        logicalOfferId: content.logicalOfferId,
        ownerPublicKey: content.ownerPublicKey,
        asset: content.asset,
        side: content.side,
        priceUsd: content.priceUsd,
        minAmount: content.minAmount,
        maxAmount: content.maxAmount,
        paymentMethod: content.paymentMethod,
        revision: content.revision,
        createdAt: new Date(content.createdAt),
        revisedAt: new Date(content.revisedAt),
        expiresAt: new Date(content.expiresAt),
        status: content.status,
        signature,
        contentDigest: hashOfferEnvelope(content).toString('hex'),
      },
    })

    const row = await prisma.offerEnvelope.findFirst({ where: { logicalOfferId } })
    expect(row).not.toBeNull()

    // Prove the risk this test guards against is real, not hypothetical:
    // the RAW Prisma.Decimal read back from this exact row really does
    // strip the trailing zeros if you call bare .toString() on it.
    expect(row!.priceUsd.toString()).toBe('1')

    // ...yet the repository's reconstruction still recovers the
    // original signed canonical form.
    const reconstructed = repo.reconstructSignedEnvelope(row!)
    expect(reconstructed.priceUsd).toBe('1.00000000')
    expect(verifyOfferEnvelope({ ...reconstructed, signature })).toEqual({ valid: true })
  })

  it('ingest() itself, run against real Postgres end to end, produces a row that reconstructs and re-verifies', async () => {
    requirePostgres('ingest() end-to-end against real Postgres')
    const { publicKeyHex, secretKeyHex } = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-c`

    const content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: publicKeyHex,
      asset: 'LN_BTC',
      side: 'SELL',
      priceUsd: '65123.45000000',
      minAmount: '0.00050000',
      maxAmount: '0.25000000',
      paymentMethod: 'LIGHTNING_DIRECT',
      revision: 1,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    const signed = { ...content, signature: signOfferEnvelope(content, secretKeyHex) }

    // ingest() uses the shared `prisma` singleton (src/common/database),
    // which — outside of the mocked unit-test file — is the same real
    // database this harness just proved reachable via config.database.url.
    const result = await repo.ingest(signed)
    expect(result.accepted).toBe(true)

    const row = await prisma.offerEnvelope.findFirst({ where: { logicalOfferId } })
    expect(row).not.toBeNull()
    const reconstructed = repo.reconstructSignedEnvelope(row!)
    expect(canonicalizeOfferEnvelope(reconstructed).equals(canonicalizeOfferEnvelope(content))).toBe(true)
    expect(verifyOfferEnvelope(reconstructed)).toEqual({ valid: true })
  })

  it('Property H (real DB): two different owners using the identical logicalOfferId both persist without a unique-constraint violation, and ingest() converges each independently against real Postgres', async () => {
    requirePostgres('Property H composite uniqueness against real Postgres')
    const alice = makeKeypair()
    const mallory = makeKeypair()
    // Deliberately the SAME logicalOfferId for two different owners —
    // this is the exact case the corrected `@@unique([ownerPublicKey,
    // logicalOfferId, revision])` constraint (prisma/schema.prisma) must
    // allow; the old `@@unique([logicalOfferId, revision])` constraint
    // would have thrown a real Postgres unique-violation on the second
    // insert.
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-shared`

    const aliceContent: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: alice.publicKeyHex,
      asset: 'BTC',
      side: 'SELL',
      priceUsd: '65000.00000000',
      minAmount: '0.00100000',
      maxAmount: '0.50000000',
      paymentMethod: 'PIX',
      revision: 0,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    const malloryContent: OfferEnvelopeContent = { ...aliceContent, ownerPublicKey: mallory.publicKeyHex }
    const aliceSigned = { ...aliceContent, signature: signOfferEnvelope(aliceContent, alice.secretKeyHex) }
    const mallorySigned = { ...malloryContent, signature: signOfferEnvelope(malloryContent, mallory.secretKeyHex) }

    const aliceResult = await repo.ingest(aliceSigned)
    const malloryResult = await repo.ingest(mallorySigned)

    expect(aliceResult.accepted).toBe(true)
    expect(malloryResult.accepted).toBe(true)

    const aliceLatest = await repo.getLatest(alice.publicKeyHex, logicalOfferId)
    const malloryLatest = await repo.getLatest(mallory.publicKeyHex, logicalOfferId)
    expect(aliceLatest.status).toBe('RESOLVED')
    expect(malloryLatest.status).toBe('RESOLVED')
    expect((aliceLatest as { row: { ownerPublicKey: string } }).row.ownerPublicKey).toBe(alice.publicKeyHex)
    expect((malloryLatest as { row: { ownerPublicKey: string } }).row.ownerPublicKey).toBe(mallory.publicKeyHex)
  })

  it('Property J (real DB): two genuinely different signed envelopes from the same owner at the identical revision both persist without a unique-constraint violation, and getLatest() reports EQUIVOCATED against real Postgres', async () => {
    requirePostgres('Property J/O composite uniqueness (contentDigest) against real Postgres')
    const alice = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-equivocation`

    const e1Content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: alice.publicKeyHex,
      asset: 'BTC',
      side: 'SELL',
      priceUsd: '65000.00000000',
      minAmount: '0.00100000',
      maxAmount: '0.50000000',
      paymentMethod: 'PIX',
      revision: 0,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    // Same identity, same revision, deliberately different price —
    // owner equivocation. `contentDigest` (not `signature` — Property O
    // found Ed25519 signatures malleable, so `signature` is not a sound
    // identity) necessarily differs because the CONTENT differs, which
    // is exactly what the corrected 4-column unique constraint
    // (`prisma/schema.prisma`, keyed on `contentDigest`) allows to
    // coexist — a 3-column constraint would have rejected this node
    // from ever storing E2 at all.
    const e2Content: OfferEnvelopeContent = { ...e1Content, priceUsd: '70000.00000000' }
    const e1 = { ...e1Content, signature: signOfferEnvelope(e1Content, alice.secretKeyHex) }
    const e2 = { ...e2Content, signature: signOfferEnvelope(e2Content, alice.secretKeyHex) }

    const r1 = await repo.ingest(e1)
    const r2 = await repo.ingest(e2)
    expect(r1.accepted).toBe(true)
    expect(r2).toEqual(expect.objectContaining({ accepted: true, equivocationDetected: true }))

    const latest = await repo.getLatest(alice.publicKeyHex, logicalOfferId)
    expect(latest.status).toBe('EQUIVOCATED')
    const prices = new Set((latest as { rows: { priceUsd: { toString(): string } }[] }).rows.map((row) => row.priceUsd.toString()))
    expect(prices).toEqual(new Set(['65000', '70000']))
  })

  it('CONVERGENCE TEST (real DB, Property P): two structurally equivalent histories in opposite arrival order — History A (E1, E2, rev6) vs History B (rev6 FIRST, then E1, E2) — converge to the identical CURRENT state AND retain the identical HISTORICAL equivocation evidence against real Postgres', async () => {
    requirePostgres('Property J/L/P convergence against real Postgres')
    const alice = makeKeypair()

    // "History A" and "History B" below use two DIFFERENT logicalOfferIds
    // — changing logicalOfferId changes the signed bytes, so these are
    // NOT literally the identical envelopes; they are structurally
    // equivalent (isomorphic) histories: the same shape of facts (two
    // equivocating envelopes at revision 5, one resolving envelope at
    // revision 6, same owner, same prices), arriving in opposite order,
    // kept in separate row-sets purely so this single shared real
    // database can hold both without them colliding into ONE offer
    // identity. The property under test — arrival order must not affect
    // final state or retained evidence — holds regardless of which
    // exact logicalOfferId a given history uses.
    function makeContent(logicalOfferId: string, revision: number, priceUsd: string): OfferEnvelopeContent {
      return {
        logicalOfferId,
        ownerPublicKey: alice.publicKeyHex,
        asset: 'BTC',
        side: 'SELL',
        priceUsd,
        minAmount: '0.00100000',
        maxAmount: '0.50000000',
        paymentMethod: 'PIX',
        revision,
        createdAt: '2026-09-09T00:00:00.000Z',
        revisedAt: '2026-09-09T00:00:00.000Z',
        expiresAt: '2026-09-10T00:00:00.000Z',
        status: 'ACTIVE',
      }
    }

    // History A: E1, E2, rev6 — rev6 (the resolving revision) arrives LAST, after the equivocating pair.
    const idA = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-converge-a`
    const e1A = { ...makeContent(idA, 5, '65000.00000000') }
    const e2A = { ...makeContent(idA, 5, '70000.00000000') }
    const rev6A = { ...makeContent(idA, 6, '68000.00000000') }
    const signedE1A = { ...e1A, signature: signOfferEnvelope(e1A, alice.secretKeyHex) }
    const signedE2A = { ...e2A, signature: signOfferEnvelope(e2A, alice.secretKeyHex) }
    const signedRev6A = { ...rev6A, signature: signOfferEnvelope(rev6A, alice.secretKeyHex) }
    await repo.ingest(signedE1A)
    await repo.ingest(signedE2A)
    await repo.ingest(signedRev6A)
    const finalA = await repo.getLatest(alice.publicKeyHex, idA)

    // History B: rev6 arrives FIRST — under the pre-Sixth-Pass "revision
    // < highest is stale, reject" rule, E1/E2 (arriving after rev6 was
    // already known to this row-set) would have been rejected outright
    // and NEVER stored, leaving History B with zero equivocation
    // evidence. Property P's fix (Option B) means they are retained
    // regardless.
    const idB = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-converge-b`
    const e1B = { ...makeContent(idB, 5, '65000.00000000') }
    const e2B = { ...makeContent(idB, 5, '70000.00000000') }
    const rev6B = { ...makeContent(idB, 6, '68000.00000000') }
    const signedE1B = { ...e1B, signature: signOfferEnvelope(e1B, alice.secretKeyHex) }
    const signedE2B = { ...e2B, signature: signOfferEnvelope(e2B, alice.secretKeyHex) }
    const signedRev6B = { ...rev6B, signature: signOfferEnvelope(rev6B, alice.secretKeyHex) }
    await repo.ingest(signedRev6B)
    await repo.ingest(signedE1B)
    await repo.ingest(signedE2B)
    const finalB = await repo.getLatest(alice.publicKeyHex, idB)

    // Current-state convergence.
    expect(finalA.status).toBe('RESOLVED')
    expect(finalB.status).toBe('RESOLVED')
    expect((finalA as { row: { priceUsd: { toString(): string } } }).row.priceUsd.toString()).toBe('68000')
    expect((finalB as { row: { priceUsd: { toString(): string } } }).row.priceUsd.toString()).toBe('68000')

    // Historical-evidence convergence — the actual Property P claim,
    // checked directly against the real database, not just the mocked
    // suite: both histories retain BOTH rev5 rows, regardless of when
    // rev6 happened to arrive relative to them.
    const rev5RowsA = await prisma.offerEnvelope.findMany({ where: { logicalOfferId: idA, revision: 5 } })
    const rev5RowsB = await prisma.offerEnvelope.findMany({ where: { logicalOfferId: idB, revision: 5 } })
    expect(rev5RowsA).toHaveLength(2)
    expect(rev5RowsB).toHaveLength(2)
    expect(new Set(rev5RowsA.map((r) => r.priceUsd.toString()))).toEqual(new Set(['65000', '70000']))
    expect(new Set(rev5RowsB.map((r) => r.priceUsd.toString()))).toEqual(new Set(['65000', '70000']))
  })

  it('Property M (real DB): real concurrent ingest(E1) calls (Promise.all) for the identical signed envelope are idempotent against real Postgres — one stored row, both callers succeed, no leaked exception', async () => {
    requirePostgres('Property M real concurrency against real Postgres')
    const alice = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-concurrent`
    const content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: alice.publicKeyHex,
      asset: 'BTC',
      side: 'SELL',
      priceUsd: '65000.00000000',
      minAmount: '0.00100000',
      maxAmount: '0.50000000',
      paymentMethod: 'PIX',
      revision: 0,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    const signed = { ...content, signature: signOfferEnvelope(content, alice.secretKeyHex) }

    // Real concurrency against a real, separately-connected client —
    // this is the actual reproduction/proof, not a simulation: both
    // calls are genuinely in flight, racing against the same real
    // database connection pool, before either resolves.
    const results = await Promise.allSettled([repo.ingest(signed), repo.ingest(signed)])

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')
    const r1 = (results[0] as PromiseFulfilledResult<{ accepted: boolean; id?: string }>).value
    const r2 = (results[1] as PromiseFulfilledResult<{ accepted: boolean; id?: string }>).value
    expect(r1.accepted).toBe(true)
    expect(r2.accepted).toBe(true)
    expect(r1.id).toBe(r2.id)

    const rows = await prisma.offerEnvelope.findMany({ where: { logicalOfferId } })
    expect(rows).toHaveLength(1)
  })

  it('Property O/Q (real DB): a malleated signature is rejected by Sails verification as non-canonical, and never reaches the repository, against real Postgres', async () => {
    requirePostgres('Property O/Q malleability against real Postgres')
    const alice = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-malleated`
    const content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: alice.publicKeyHex,
      asset: 'BTC',
      side: 'SELL',
      priceUsd: '65000.00000000',
      minAmount: '0.00100000',
      maxAmount: '0.50000000',
      paymentMethod: 'PIX',
      revision: 0,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: 'ACTIVE',
    }
    const signature = signOfferEnvelope(content, alice.secretKeyHex)

    // Ed25519 group order L — confirmed directly (Property O) that raw
    // tweetnacl accepts (R, S + L) alongside the original (R, S), with
    // no secret key required. Property Q (Seventh Pass) closes this at
    // the Sails verification layer specifically.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n
    const sigBytes = Buffer.from(signature, 'hex')
    const R = sigBytes.subarray(0, 32)
    let S = 0n
    for (let i = 31; i >= 0; i--) S = (S << 8n) | BigInt(sigBytes[32 + i])
    const malleatedS = S + L
    const malleatedSBytes = Buffer.alloc(32)
    let rem = malleatedS
    for (let i = 0; i < 32; i++) {
      malleatedSBytes[i] = Number(rem & 0xffn)
      rem >>= 8n
    }
    const malleatedSignature = Buffer.concat([R, malleatedSBytes]).toString('hex')
    expect(malleatedSignature).not.toBe(signature)

    // Sails's own verifier rejects it (Property Q) — the underlying
    // tweetnacl behavior (still accepting it) is unchanged and is not
    // asserted again here; tests/offerEnvelope.test.ts's own Property Q
    // block already proves that directly.
    const verdict = verifyOfferEnvelope({ ...content, signature: malleatedSignature })
    expect(verdict.valid).toBe(false)

    const r1 = await repo.ingest({ ...content, signature })
    const r2 = await repo.ingest({ ...content, signature: malleatedSignature })
    expect(r1.accepted).toBe(true)
    expect(r2.accepted).toBe(false)

    const rows = await prisma.offerEnvelope.findMany({ where: { logicalOfferId } })
    expect(rows).toHaveLength(1)
    const latest = await repo.getLatest(alice.publicKeyHex, logicalOfferId)
    expect(latest.status).toBe('RESOLVED')
  })

  it('Property S (real DB): two concurrent ingest() calls for distinct content at the same revision always store both facts correctly and getLatest() always reports EQUIVOCATED, regardless of what equivocationDetected says on either response', async () => {
    requirePostgres('Property S real concurrency against real Postgres')
    const alice = makeKeypair()
    const logicalOfferId = `${TEST_LOGICAL_ID_PREFIX}${Date.now()}-property-s`

    function makeContent(priceUsd: string): OfferEnvelopeContent {
      return {
        logicalOfferId,
        ownerPublicKey: alice.publicKeyHex,
        asset: 'BTC',
        side: 'SELL',
        priceUsd,
        minAmount: '0.00100000',
        maxAmount: '0.50000000',
        paymentMethod: 'PIX',
        revision: 5,
        createdAt: '2026-09-09T00:00:00.000Z',
        revisedAt: '2026-09-09T00:00:00.000Z',
        expiresAt: '2026-09-10T00:00:00.000Z',
        status: 'ACTIVE',
      }
    }
    const e1Content = makeContent('65000.00000000')
    const e2Content = makeContent('70000.00000000')
    const e1 = { ...e1Content, signature: signOfferEnvelope(e1Content, alice.secretKeyHex) }
    const e2 = { ...e2Content, signature: signOfferEnvelope(e2Content, alice.secretKeyHex) }

    // Real concurrency — genuinely in flight together against the real
    // connection pool, the exact reproduction confirmed directly before
    // this correction pass (see docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md's
    // Seventh Pass, Property S: reproduced across 5 real runs, at least
    // one of which showed BOTH responses missing `equivocationDetected`
    // entirely while the stored state and getLatest() stayed correct
    // every time).
    const [r1, r2] = await Promise.all([repo.ingest(e1), repo.ingest(e2)])
    expect(r1.accepted).toBe(true)
    expect(r2.accepted).toBe(true)

    const rows = await prisma.offerEnvelope.findMany({ where: { logicalOfferId } })
    expect(rows).toHaveLength(2)

    const latest = await repo.getLatest(alice.publicKeyHex, logicalOfferId)
    expect(latest.status).toBe('EQUIVOCATED')
    if (latest.status === 'EQUIVOCATED') {
      expect(new Set(latest.rows.map((r) => r.priceUsd.toString()))).toEqual(new Set(['65000', '70000']))
    }
  })
})

// C9 regression hardening (CTO 24, Issue #105 comment 6800551839; Gatekeeper
// audit 6799838486). The block above proves storage fidelity and the
// equivocation/idempotency races; nothing in it (nor in the mocked
// tests/offerEnvelope.test.ts) asserts against real Postgres that a
// tombstone is economically inactive, that it survives replays and every
// arrival order, or that concurrent higher revisions keep reads monotonic.
// That gap let mutant Q7 (`isOfferEnvelopeEconomicallyActive` ignoring
// `status`) survive. Deterministic: fixed seed, fixed `now`.
describe('OfferEnvelope — C9 tombstone / revision regression against real Postgres', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  const PREFIX = 'offer-envelope-c9-test-'
  // Before every fixture's expiresAt, so ACTIVE really is active and only
  // `status` can make a row inactive.
  const NOW = new Date('2026-09-09T12:00:00.000Z')
  let prisma: PrismaClient
  let repo: OfferEnvelopeRepository
  let dbAvailable = false

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (dbAvailable) {
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.getUrl() }) })
      repo = new OfferEnvelopeRepository()
    }
  })

  afterAll(async () => {
    if (!dbAvailable) return
    // No cleanup: offer_envelopes is append-only (migration 20261111120000); every id here is unique per run.
    await prisma.$disconnect()
  })

  type Fact = { revision: number; status: 'ACTIVE' | 'CANCELLED'; priceUsd: string }

  function signFact(owner: { publicKeyHex: string; secretKeyHex: string }, logicalOfferId: string, fact: Fact) {
    const content: OfferEnvelopeContent = {
      logicalOfferId,
      ownerPublicKey: owner.publicKeyHex,
      asset: 'BTC',
      side: 'SELL',
      priceUsd: fact.priceUsd,
      minAmount: '0.00100000',
      maxAmount: '0.50000000',
      paymentMethod: 'PIX',
      revision: fact.revision,
      createdAt: '2026-09-09T00:00:00.000Z',
      revisedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
      status: fact.status,
    }
    return { ...content, signature: signOfferEnvelope(content, owner.secretKeyHex) }
  }

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items]
    return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))
  }

  // Deterministic Fisher-Yates (LCG) so a failure reproduces exactly.
  function seededShuffle<T>(items: T[], seed: number): T[] {
    const out = [...items]
    let s = seed
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648
      const j = s % (i + 1)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  async function currentState(owner: string, logicalOfferId: string) {
    const state = await repo.getLatest(owner, logicalOfferId)
    const stored = await prisma.offerEnvelope.findMany({ where: { ownerPublicKey: owner, logicalOfferId } })
    return {
      status: state.status,
      revision: state.status === 'RESOLVED' ? state.row.revision : state.status === 'EQUIVOCATED' ? state.revision : null,
      envelopeStatus: state.status === 'RESOLVED' ? state.row.status : null,
      active: isOfferStateEconomicallyActive(state, NOW),
      storedFacts: stored.length,
    }
  }

  it('C9-1: a stored CANCELLED tombstone makes the offer economically inactive (kills mutant Q7)', async () => {
    pg.requirePostgres('C9-1 tombstone => inactive')
    const owner = makeKeypair()
    const id = `${PREFIX}${Date.now()}-inactive`
    expect((await repo.ingest(signFact(owner, id, { revision: 1, status: 'ACTIVE', priceUsd: '65000.00000000' }))).accepted).toBe(true)
    expect((await currentState(owner.publicKeyHex, id)).active).toBe(true)

    expect((await repo.ingest(signFact(owner, id, { revision: 2, status: 'CANCELLED', priceUsd: '65000.00000000' }))).accepted).toBe(true)
    expect(await currentState(owner.publicKeyHex, id)).toEqual({
      status: 'RESOLVED',
      revision: 2,
      envelopeStatus: 'CANCELLED',
      active: false,
      storedFacts: 2,
    })
  })

  // Every arrival order of each fact set, then a full replay in reverse,
  // must give one identical outcome and keep every distinct fact.
  const scenarios: { name: string; facts: Fact[]; expected: Record<string, unknown> }[] = [
    {
      name: 'tombstone on top: older ACTIVE revisions arriving before or after never resurrect it',
      facts: [
        { revision: 1, status: 'ACTIVE', priceUsd: '65000.00000000' },
        { revision: 2, status: 'ACTIVE', priceUsd: '66000.00000000' },
        { revision: 3, status: 'CANCELLED', priceUsd: '66000.00000000' },
      ],
      expected: { status: 'RESOLVED', revision: 3, envelopeStatus: 'CANCELLED', active: false, storedFacts: 3 },
    },
    {
      name: 'ACTIVE equivocation at the top revision is fail-closed',
      facts: [
        { revision: 1, status: 'ACTIVE', priceUsd: '65000.00000000' },
        { revision: 2, status: 'ACTIVE', priceUsd: '66000.00000000' },
        { revision: 2, status: 'ACTIVE', priceUsd: '70000.00000000' },
      ],
      expected: { status: 'EQUIVOCATED', revision: 2, envelopeStatus: null, active: false, storedFacts: 3 },
    },
    {
      name: 'ACTIVE vs CANCELLED equivocation at the top revision is fail-closed',
      facts: [
        { revision: 1, status: 'ACTIVE', priceUsd: '65000.00000000' },
        { revision: 2, status: 'ACTIVE', priceUsd: '66000.00000000' },
        { revision: 2, status: 'CANCELLED', priceUsd: '66000.00000000' },
      ],
      expected: { status: 'EQUIVOCATED', revision: 2, envelopeStatus: null, active: false, storedFacts: 3 },
    },
  ]

  it.each(scenarios)('C9-2 arrival-order independence + replay: $name', async ({ facts, expected }) => {
    pg.requirePostgres('C9-2 arrival-order independence')
    const owner = makeKeypair()
    const orders = permutations(facts.map((_, i) => i))
    for (const [k, order] of orders.entries()) {
      const id = `${PREFIX}${Date.now()}-perm-${k}`
      const signed = facts.map((fact) => signFact(owner, id, fact))
      for (const i of [...order, ...[...order].reverse()]) {
        expect((await repo.ingest(signed[i])).accepted).toBe(true)
      }
      expect({ order, ...(await currentState(owner.publicKeyHex, id)) }).toEqual({ order, ...expected })
    }
  })

  it('C9-3: once a tombstone is stored, relabelled, revision-bumped or foreign-key envelopes cannot un-cancel it', async () => {
    pg.requirePostgres('C9-3 signature binds status/revision/owner')
    const owner = makeKeypair()
    const forger = makeKeypair()
    const id = `${PREFIX}${Date.now()}-forgery`
    const active1 = signFact(owner, id, { revision: 1, status: 'ACTIVE', priceUsd: '65000.00000000' })
    const cancel2 = signFact(owner, id, { revision: 2, status: 'CANCELLED', priceUsd: '65000.00000000' })
    await repo.ingest(active1)
    await repo.ingest(cancel2)

    const attempts = [
      { ...cancel2, status: 'ACTIVE' as const }, // relay flips the tombstone, keeps its signature
      { ...active1, revision: 3 }, // old ACTIVE replayed above the tombstone with its old signature
      { ...signFact(forger, id, { revision: 3, status: 'ACTIVE', priceUsd: '65000.00000000' }), ownerPublicKey: owner.publicKeyHex }, // signed by another key
    ]
    for (const attempt of attempts) {
      expect(await repo.ingest(attempt)).toEqual(expect.objectContaining({ accepted: false }))
    }
    expect(await currentState(owner.publicKeyHex, id)).toEqual({
      status: 'RESOLVED',
      revision: 2,
      envelopeStatus: 'CANCELLED',
      active: false,
      storedFacts: 2,
    })
  })

  it('C9-4: concurrent ingestion of shuffled revisions with replays and tombstones keeps reads monotonic and ends on the top tombstone', async () => {
    pg.requirePostgres('C9-4 concurrent ingestion with concurrent readers')
    const owner = makeKeypair()
    const id = `${PREFIX}${Date.now()}-concurrent`
    // r0..r11 ACTIVE, interleaved tombstones at r4 and r8, top tombstone at r12.
    const facts: Fact[] = Array.from({ length: 13 }, (_, r) => ({
      revision: r,
      status: r === 4 || r === 8 || r === 12 ? 'CANCELLED' : 'ACTIVE',
      priceUsd: `${65000 + r}.00000000`,
    }))
    const signed = facts.map((fact) => signFact(owner, id, fact))
    const sends = seededShuffle([...signed, ...signed, ...signed], 20261111)

    let writing = true
    const reader = async () => {
      const seen: number[] = []
      while (writing) {
        const state = await repo.getLatest(owner.publicKeyHex, id)
        seen.push(state.status === 'RESOLVED' ? state.row.revision : state.status === 'EQUIVOCATED' ? state.revision : -1)
      }
      return seen
    }
    const readers = [reader(), reader(), reader()]
    const results = await Promise.allSettled(sends.map((envelope) => repo.ingest(envelope)))
    writing = false
    const reads = await Promise.all(readers)

    expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    expect(results.filter((r) => r.status === 'fulfilled' && !r.value.accepted)).toEqual([])
    for (const seen of reads) {
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((rev, i) => i === 0 || rev >= seen[i - 1])).toBe(true)
    }
    expect(await currentState(owner.publicKeyHex, id)).toEqual({
      status: 'RESOLVED',
      revision: 12,
      envelopeStatus: 'CANCELLED',
      active: false,
      storedFacts: 13,
    })
  })

  // ─── C9 write-once + read-time re-verification (migration 20261111120000) ────
  const GUARD = 'offer_envelopes_immutability_guard'
  /** What only an unrestricted database role can do: switch the guard off, rewrite, switch it back, atomically. */
  const asTableOwner = (sql: string, ...params: unknown[]) => prisma.$transaction([
    prisma.$executeRawUnsafe(`ALTER TABLE offer_envelopes DISABLE TRIGGER ${GUARD}`),
    prisma.$executeRawUnsafe(sql, ...params),
    prisma.$executeRawUnsafe(`ALTER TABLE offer_envelopes ENABLE TRIGGER ${GUARD}`),
  ])
  const rowAt = (owner: string, logicalOfferId: string, revision: number) =>
    prisma.offerEnvelope.findFirstOrThrow({ where: { ownerPublicKey: owner, logicalOfferId, revision } })
  const forgedRow = (envelope: ReturnType<typeof signFact>) => ({
    ...envelope,
    createdAt: new Date(envelope.createdAt), revisedAt: new Date(envelope.revisedAt), expiresAt: new Date(envelope.expiresAt),
    contentDigest: hashOfferEnvelope(envelope).toString('hex'),
  })
  /** r1 ACTIVE under an r2 CANCELLED tombstone: the resurrection target. */
  async function tombstoned(label: string) {
    const owner = makeKeypair()
    const id = `${PREFIX}${Date.now()}-${label}`
    for (const fact of [{ revision: 1, status: 'ACTIVE' as const, priceUsd: '60000.00000000' }, { revision: 2, status: 'CANCELLED' as const, priceUsd: '60000.00000000' }]) {
      expect(await repo.ingest(signFact(owner, id, fact))).toMatchObject({ accepted: true })
    }
    expect(await currentState(owner.publicKeyHex, id)).toMatchObject({ status: 'RESOLVED', revision: 2, active: false })
    return { owner, id }
  }

  it('C9-5: the migration guards the table - UPDATE, DELETE and TRUNCATE are refused, rows are unchanged, the triggers are installed and enabled', async () => {
    pg.requirePostgres('C9-5 write-once')
    const { owner, id } = await tombstoned('write-once')
    const before = await prisma.offerEnvelope.findMany({ where: { ownerPublicKey: owner.publicKeyHex, logicalOfferId: id }, orderBy: { revision: 'asc' } })
    await expect(prisma.$executeRaw`UPDATE offer_envelopes SET status = 'ACTIVE' WHERE "logicalOfferId" = ${id} AND revision = 2`).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRaw`DELETE FROM offer_envelopes WHERE "logicalOfferId" = ${id} AND revision = 2`).rejects.toThrow(/append-only/)
    await expect(prisma.offerEnvelope.deleteMany({ where: { logicalOfferId: id } })).rejects.toThrow(/append-only/)
    await expect(prisma.$executeRawUnsafe('TRUNCATE offer_envelopes')).rejects.toThrow(/append-only/)
    expect(await prisma.offerEnvelope.findMany({ where: { ownerPublicKey: owner.publicKeyHex, logicalOfferId: id }, orderBy: { revision: 'asc' } })).toEqual(before)
    const triggers = await prisma.$queryRaw<Array<{ name: string; enabled: string }>>`
      SELECT t.tgname AS name, t.tgenabled::text AS enabled FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
      WHERE c.relname = 'offer_envelopes' AND NOT t.tgisinternal ORDER BY t.tgname`
    expect(triggers).toEqual([{ name: GUARD, enabled: 'O' }, { name: 'offer_envelopes_truncate_guard', enabled: 'O' }])
  })

  it.each([
    ['the tombstone relabelled ACTIVE', `UPDATE offer_envelopes SET status = 'ACTIVE' WHERE "logicalOfferId" = $1 AND revision = 2`],
    ['the price rewritten', `UPDATE offer_envelopes SET "priceUsd" = 1 WHERE "logicalOfferId" = $1 AND revision = 2`],
    ['the stored digest rewritten', `UPDATE offer_envelopes SET "contentDigest" = repeat('0', 64) WHERE "logicalOfferId" = $1 AND revision = 2`],
    ['the r1 ACTIVE renumbered above the tombstone', `UPDATE offer_envelopes SET revision = 3 WHERE "logicalOfferId" = $1 AND revision = 1`],
  ])('C9-6: %s by a table owner fails the identity closed - an integrity error, never the older ACTIVE revision', async (_name, sql) => {
    pg.requirePostgres('C9-6 tampered top row')
    const { owner, id } = await tombstoned('tamper')
    await asTableOwner(sql, id)
    const read = repo.getLatest(owner.publicKeyHex, id)
    await expect(read).rejects.toBeInstanceOf(OfferEnvelopeIntegrityError)
    await expect(read).rejects.toMatchObject({ ownerPublicKey: owner.publicKeyHex, logicalOfferId: id })
  })

  it('C9-7: rows inserted around ingest() at a higher revision (bad signature, or signed by another key) fail the identity closed', async () => {
    pg.requirePostgres('C9-7 forged rows')
    const mallory = makeKeypair()
    for (const forge of [
      (e: ReturnType<typeof signFact>) => ({ ...e, signature: 'ab'.repeat(64) }),
      ({ signature: _owners, ...content }: ReturnType<typeof signFact>) => ({ ...content, signature: signOfferEnvelope(content, mallory.secretKeyHex) }),
    ]) {
      const { owner, id } = await tombstoned('forged')
      await prisma.offerEnvelope.create({ data: forgedRow(forge(signFact(owner, id, { revision: 3, status: 'ACTIVE', priceUsd: '1.00000000' }))) })
      await expect(repo.getLatest(owner.publicKeyHex, id)).rejects.toBeInstanceOf(OfferEnvelopeIntegrityError)
    }
  })

  it('C9-8: an equivocation cannot be collapsed into one RESOLVED fact - not by sharing a digest (unique index), not by rewriting content', async () => {
    pg.requirePostgres('C9-8 equivocation collapse')
    const owner = makeKeypair()
    const id = `${PREFIX}${Date.now()}-collapse`
    const a = signFact(owner, id, { revision: 5, status: 'ACTIVE', priceUsd: '60000.00000000' })
    const b = signFact(owner, id, { revision: 5, status: 'ACTIVE', priceUsd: '61000.00000000' })
    for (const e of [a, b]) expect(await repo.ingest(e)).toMatchObject({ accepted: true })
    expect(await currentState(owner.publicKeyHex, id)).toMatchObject({ status: 'EQUIVOCATED', active: false })
    const bRow = await prisma.offerEnvelope.findFirstOrThrow({ where: { logicalOfferId: id, priceUsd: '61000.00000000' } })
    // Even with the trigger off, two rows of one revision cannot share a digest: the identity's unique index refuses it.
    await expect(asTableOwner(`UPDATE offer_envelopes SET "contentDigest" = $1 WHERE id = $2`, hashOfferEnvelope(a).toString('hex'), bRow.id))
      .rejects.toThrow(/offer_envelopes_identity_revision_digest_key|23505/)
    // B rewritten to A's terms keeps its own digest and signature, so it no longer verifies: closed, never RESOLVED as A.
    await asTableOwner(`UPDATE offer_envelopes SET "priceUsd" = 60000 WHERE id = $1`, bRow.id)
    await expect(repo.getLatest(owner.publicKeyHex, id)).rejects.toBeInstanceOf(OfferEnvelopeIntegrityError)
  })

  it('C9-9: concurrent rewrite and delete attempts during ingestion are all refused; ingestion and reads are unaffected', async () => {
    pg.requirePostgres('C9-9 concurrent mutation')
    const owner = makeKeypair()
    const id = `${PREFIX}${Date.now()}-concurrent-mutation`
    expect(await repo.ingest(signFact(owner, id, { revision: 1, status: 'ACTIVE', priceUsd: '60000.00000000' }))).toMatchObject({ accepted: true })
    const ingests = [2, 3, 4, 5, 6].map((revision) => repo.ingest(signFact(owner, id, { revision, status: revision === 6 ? 'CANCELLED' : 'ACTIVE', priceUsd: '60000.00000000' })))
    const mutations = Array.from({ length: 10 }, (_, i) => i % 2 === 0
      ? prisma.$executeRaw`UPDATE offer_envelopes SET status = 'ACTIVE' WHERE "logicalOfferId" = ${id}`
      : prisma.$executeRaw`DELETE FROM offer_envelopes WHERE "logicalOfferId" = ${id}`)
    const [ingested, mutated] = await Promise.all([Promise.allSettled(ingests), Promise.allSettled(mutations)])
    expect(ingested.every((r) => r.status === 'fulfilled' && r.value.accepted)).toBe(true)
    expect(mutated.every((r) => r.status === 'rejected' && /append-only/.test(String(r.reason)))).toBe(true)
    expect(await currentState(owner.publicKeyHex, id)).toEqual({ status: 'RESOLVED', revision: 6, envelopeStatus: 'CANCELLED', active: false, storedFacts: 6 })
    expect((await rowAt(owner.publicKeyHex, id, 1)).status).toBe('ACTIVE')
  })
})
