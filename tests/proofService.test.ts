/**
 * ProofService — new methods closed 2026-08-04: attachEvidence() (RFC-007
 * D2), anchorEvidence() (RFC-008 D1), getEvidenceBundleForTrade() (RFC-007
 * D6). Real Ed25519 signature verification (real `tweetnacl`, a real
 * generated keypair) — same "test real crypto, not a mock of it"
 * discipline `tests/identity.test.ts` already establishes; everything
 * else (Prisma, EvidenceProvider, TimestampAnchor, Timeline) mocked at
 * the collaborator boundary.
 */
export {} // same forced-module reasoning used throughout this suite

import nacl from 'tweetnacl'

jest.mock('../src/config', () => ({
  config: { proof: { submissionWindowHours: 72, verificationNonceTtlSeconds: 300 } },
}))

// proof.service.ts imports the real `redis` singleton, which reads
// config.redis.url at module-load time — not exercised by any test in
// this file, but mocked anyway so requiring proof.service.ts doesn't
// need a real Redis connection (same pattern tests/qvac-forgery.test.ts
// already establishes).
jest.mock('../src/common/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}))

const mockProofFindUnique = jest.fn()
const mockProofCreate = jest.fn()
const mockUserFindUnique = jest.fn()
const mockClaimFindMany = jest.fn()
const mockClaimFindUnique = jest.fn()
const mockEvidenceReferenceCreate = jest.fn()
const mockEvidenceReferenceFindUnique = jest.fn()
const mockEvidenceReferenceUpdate = jest.fn()
// Issue #261 — assertClaimEconomicScopeAccess() (proof.service.ts) reads
// these two for its trade-participant-or-current-arbiter check. Default
// to "no trade, no dispute" (null/null) so any test that doesn't care
// about authorization specifically doesn't need its own override —
// tests below only set a real trade/dispute fixture when they actually
// exercise the trade-scoped authorization path.
const mockTradeFindUnique = jest.fn().mockResolvedValue(null)
const mockDisputeFindFirst = jest.fn().mockResolvedValue(null)

jest.mock('../src/common/database', () => ({
  prisma: {
    proof: {
      findUnique: (...args: unknown[]) => mockProofFindUnique(...args),
      create: (...args: unknown[]) => mockProofCreate(...args),
    },
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
    claim: {
      findMany: (...args: unknown[]) => mockClaimFindMany(...args),
      findUnique: (...args: unknown[]) => mockClaimFindUnique(...args),
    },
    evidenceReference: {
      create: (...args: unknown[]) => mockEvidenceReferenceCreate(...args),
      findUnique: (...args: unknown[]) => mockEvidenceReferenceFindUnique(...args),
      update: (...args: unknown[]) => mockEvidenceReferenceUpdate(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
  },
}))

// #267 quota/idempotency has its own real-PostgreSQL integration suite. This
// RFC-007 unit file keeps Prisma at the collaborator boundary and models the
// quota collaborator without weakening ProofService's mandatory operationKey.
const mockReserveEvidenceQuota = jest.fn(async (input: any) => ({
  id: 'reservation-unit', status: 'RESERVED', evidenceRefId: null, ...input,
}))
const mockMarkEvidenceReservationUnknown = jest.fn().mockResolvedValue(undefined)
const mockPersistCanonicalEvidenceSubmittedEvent = jest.fn().mockResolvedValue({ id: 'event-unit' })
const mockCommitEvidenceReservation = jest.fn(async (reservationId: string, stored: any, signature: string) =>
  mockEvidenceReferenceCreate({
    data: {
      proofId: 'proof-1', provider: stored.provider, uri: stored.uri,
      sha256: require('crypto').createHash('sha256').update(new Uint8Array(Buffer.from('real evidence photo bytes'))).digest('hex'),
      mimeType: 'image', signature,
    },
  })
)
jest.mock('../src/modules/open-proof/evidence-quota', () => ({
  reserveEvidenceQuota: (input: any) => mockReserveEvidenceQuota(input),
  markEvidenceReservationUnknown: (...args: unknown[]) => mockMarkEvidenceReservationUnknown(...args),
  commitEvidenceReservation: (reservationId: string, stored: any, signature: string) => mockCommitEvidenceReservation(reservationId, stored, signature),
  persistCanonicalEvidenceSubmittedEvent: (...args: unknown[]) => mockPersistCanonicalEvidenceSubmittedEvent(...args),
}))

const mockEmit = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

const mockStore = jest.fn()
// Issue #265 CTO Gate R2, BLOCKER 3 — resolveEvidenceProviderByLabel()
// is a separate export from the `evidenceProvider` singleton
// (evidence-provider.ts); retrieveVerifiedEvidence() below dispatches
// through it, never through `evidenceProvider` directly. Defaults to a
// fake provider whose `retrieve()` just echoes back a fixed payload —
// individual tests override this to exercise dispatch/mismatch/failure
// paths specifically.
const mockResolveEvidenceProviderByLabel = jest.fn()
jest.mock('../src/modules/open-proof/evidence-provider', () => ({
  evidenceProvider: { store: (...args: unknown[]) => mockStore(...args) },
  resolveEvidenceProviderByLabel: (...args: unknown[]) => mockResolveEvidenceProviderByLabel(...args),
}))

const mockAnchor = jest.fn()
jest.mock('../src/modules/open-proof/timestamp-anchor', () => ({
  timestampAnchor: { anchor: (...args: unknown[]) => mockAnchor(...args) },
}))

const mockFindDuplicates = jest.fn().mockResolvedValue([])
jest.mock('../src/modules/open-proof/proof-registry', () => ({
  proofRegistry: { findDuplicates: (...args: unknown[]) => mockFindDuplicates(...args) },
}))

const mockGetEvents = jest.fn().mockResolvedValue([])
jest.mock('../src/core/timeline', () => ({
  getTimeline: (...args: unknown[]) => ({ getEvents: () => mockGetEvents(...args) }),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProofService, updateEvidenceReferenceProvenanceGuarded } = require('../src/modules/open-proof/proof.service')

describe('ProofService.attachEvidence() — RFC-007 D2, real Ed25519 verification', () => {
  beforeEach(() => jest.clearAllMocks())

  it('stores real media and persists a real EvidenceReference when the signature genuinely verifies', async () => {
    const keypair = nacl.sign.keyPair()
    const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex')
    const media = new Uint8Array(Buffer.from('real evidence photo bytes'))
    const digest = require('crypto').createHash('sha256').update(media).digest()
    const signature = nacl.sign.detached(digest, keypair.secretKey)
    const signatureHex = Buffer.from(signature).toString('hex')

    // claim.tradeId: null + claimedBy: 'user-1' — a non-trade Claim whose
    // creator is the same 'user-1' submitting evidence, satisfying Issue
    // #261's assertClaimEconomicScopeAccess() (creator-only for a
    // non-trade Claim) so this test still exercises signature
    // verification specifically, not authorization.
    mockProofFindUnique.mockResolvedValue({ id: 'proof-1', claimId: 'claim-1', claim: { tradeId: null, claimedBy: 'user-1' } })
    mockUserFindUnique.mockResolvedValue({ id: 'user-1', publicKey: publicKeyHex })
    mockStore.mockResolvedValue({ provider: 'local-fs', uri: '/tmp/fake', sha256: digest.toString('hex') })
    mockEvidenceReferenceCreate.mockResolvedValue({ id: 'ref-1', proofId: 'proof-1' })

    const service = new ProofService()
    const result = await service.attachEvidence('proof-1', media, 'image', 'user-1', signatureHex, 'proof-service-test-1')

    expect(mockStore).toHaveBeenCalledWith(media, 'image')
    expect(mockEvidenceReferenceCreate).toHaveBeenCalledWith({
      data: { proofId: 'proof-1', provider: 'local-fs', uri: '/tmp/fake', sha256: digest.toString('hex'), mimeType: 'image', signature: signatureHex },
    })
    expect(result.id).toBe('ref-1')
  })

  it('rejects a signature that does not verify against the submitter\'s real public key — never stores unverified evidence', async () => {
    const keypair = nacl.sign.keyPair()
    const wrongKeypair = nacl.sign.keyPair()
    const media = new Uint8Array(Buffer.from('real evidence'))
    const digest = require('crypto').createHash('sha256').update(media).digest()
    // Signed with the WRONG key — a real forgery attempt, not a malformed input.
    const signature = nacl.sign.detached(digest, wrongKeypair.secretKey)

    mockProofFindUnique.mockResolvedValue({ id: 'proof-1', claimId: 'claim-1', claim: { tradeId: null, claimedBy: 'user-1' } })
    mockUserFindUnique.mockResolvedValue({ id: 'user-1', publicKey: Buffer.from(keypair.publicKey).toString('hex') })

    const service = new ProofService()
    await expect(
      service.attachEvidence('proof-1', media, 'image', 'user-1', Buffer.from(signature).toString('hex'), 'proof-service-test-2')
    ).rejects.toThrow(/does not verify/)
    expect(mockStore).not.toHaveBeenCalled()
  })

  it('throws NotFoundError for an unknown proofId', async () => {
    mockProofFindUnique.mockResolvedValue(null)
    const service = new ProofService()
    await expect(service.attachEvidence('nope', new Uint8Array(), 'image', 'user-1', 'ab', 'proof-service-test-3')).rejects.toThrow('Proof')
  })

  it('throws NotFoundError for an unknown submittedBy', async () => {
    // claimedBy: 'nope' matches the actor under test so this exercises
    // the user-existence check specifically, not #261's authorization
    // (which would otherwise throw its own, different ForbiddenError
    // first for an actor with no relationship to the claim).
    mockProofFindUnique.mockResolvedValue({ id: 'proof-1', claimId: 'claim-1', claim: { tradeId: null, claimedBy: 'nope' } })
    mockUserFindUnique.mockResolvedValue(null)
    const service = new ProofService()
    await expect(service.attachEvidence('proof-1', new Uint8Array(), 'image', 'nope', 'ab', 'proof-service-test-4')).rejects.toThrow('User')
  })

  // Issue #265 CTO Gate R2, BLOCKER 2 — a faulty (or malicious) storage
  // provider that writes real bytes but misreports its own sha256 (here
  // simulated directly — the concrete failure mode this test closes)
  // must never get to define the canonical, caller-trusted
  // EvidenceReference.sha256. The signature above was verified against
  // `digestHex` (the service's own, pre-storage computation from the
  // real `media`) — that must remain the source of truth.
  it("rejects when the storage provider's returned sha256 does not match the signed digest — never persists a mismatched EvidenceReference", async () => {
    const keypair = nacl.sign.keyPair()
    const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex')
    const media = new Uint8Array(Buffer.from('real evidence bytes'))
    const digest = require('crypto').createHash('sha256').update(media).digest()
    const signature = nacl.sign.detached(digest, keypair.secretKey)
    const signatureHex = Buffer.from(signature).toString('hex')

    mockProofFindUnique.mockResolvedValue({ id: 'proof-1', claimId: 'claim-1', claim: { tradeId: null, claimedBy: 'user-1' } })
    mockUserFindUnique.mockResolvedValue({ id: 'user-1', publicKey: publicKeyHex })
    // A faulty provider: wrote SOMETHING, but self-reports a completely
    // different hash than what it was actually given.
    mockStore.mockResolvedValue({ provider: 'local-fs', uri: '/tmp/faulty', sha256: 'not-the-real-hash-at-all' })

    const service = new ProofService()
    await expect(
      service.attachEvidence('proof-1', media, 'image', 'user-1', signatureHex, 'proof-service-test-5')
    ).rejects.toMatchObject({ storageReason: 'CORRUPTED' })
    expect(mockEvidenceReferenceCreate).not.toHaveBeenCalled()
  })
})

describe('ProofService.retrieveVerifiedEvidence() — Issue #265', () => {
  beforeEach(() => jest.clearAllMocks())

  const REFERENCE_FIXTURE = {
    id: 'ref-1',
    provider: 's3',
    uri: 's3-key.bin',
    sha256: null as string | null, // set per-test to the real digest of `MEDIA`
    proof: { claim: { tradeId: null, claimedBy: 'user-1' } },
  }
  const MEDIA = new Uint8Array(Buffer.from('verified evidence bytes'))
  const MEDIA_SHA256 = require('crypto').createHash('sha256').update(MEDIA).digest('hex')

  it("dispatches retrieval through resolveEvidenceProviderByLabel(reference.provider) — never a fixed global provider (BLOCKER 3)", async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({ ...REFERENCE_FIXTURE, sha256: MEDIA_SHA256 })
    mockResolveEvidenceProviderByLabel.mockReturnValue({ retrieve: jest.fn().mockResolvedValue(MEDIA) })

    const service = new ProofService()
    const bytes = await service.retrieveVerifiedEvidence('ref-1', 'user-1')

    expect(mockResolveEvidenceProviderByLabel).toHaveBeenCalledWith('s3')
    expect(Buffer.from(bytes).equals(Buffer.from(MEDIA))).toBe(true)
  })

  it('dispatches to whichever backend the reference actually names, not a hardcoded label', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({ ...REFERENCE_FIXTURE, provider: 'local-fs', uri: '/tmp/historical', sha256: MEDIA_SHA256 })
    mockResolveEvidenceProviderByLabel.mockReturnValue({ retrieve: jest.fn().mockResolvedValue(MEDIA) })

    const service = new ProofService()
    await service.retrieveVerifiedEvidence('ref-1', 'user-1')

    expect(mockResolveEvidenceProviderByLabel).toHaveBeenCalledWith('local-fs')
  })

  it('throws EvidenceStorageError with storageReason CORRUPTED when retrieved bytes do not match the recorded sha256', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({ ...REFERENCE_FIXTURE, sha256: 'a-completely-different-hash' })
    mockResolveEvidenceProviderByLabel.mockReturnValue({ retrieve: jest.fn().mockResolvedValue(MEDIA) })

    const service = new ProofService()
    await expect(service.retrieveVerifiedEvidence('ref-1', 'user-1')).rejects.toMatchObject({ storageReason: 'CORRUPTED' })
  })

  it('propagates the resolver\'s own UNAVAILABLE failure for an unresolvable provider — never silently substitutes a different backend', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({ ...REFERENCE_FIXTURE, provider: 'retired-vendor', sha256: MEDIA_SHA256 })
    const { EvidenceStorageError } = require('../src/common/errors')
    mockResolveEvidenceProviderByLabel.mockImplementation(() => {
      throw new EvidenceStorageError("EvidenceReference provider 'retired-vendor' is not a recognized evidence storage backend", 'UNAVAILABLE')
    })

    const service = new ProofService()
    await expect(service.retrieveVerifiedEvidence('ref-1', 'user-1')).rejects.toMatchObject({ storageReason: 'UNAVAILABLE' })
  })

  it('throws NotFoundError for an unknown evidenceReferenceId', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue(null)
    const service = new ProofService()
    await expect(service.retrieveVerifiedEvidence('nope', 'user-1')).rejects.toThrow('EvidenceReference')
  })

  it('enforces #261 economic-scope authorization before ever resolving a provider — an outsider is rejected, no dispatch attempted', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({ ...REFERENCE_FIXTURE, sha256: MEDIA_SHA256 })

    const service = new ProofService()
    await expect(service.retrieveVerifiedEvidence('ref-1', 'outsider')).rejects.toThrow()
    expect(mockResolveEvidenceProviderByLabel).not.toHaveBeenCalled()
  })
})

describe('ProofService.anchorEvidence() — RFC-008 D1', () => {
  beforeEach(() => jest.clearAllMocks())

  it('anchors an existing EvidenceReference and persists the real AnchorProof', async () => {
    // Issue #261 — anchorEvidence() now resolves reference -> proof ->
    // claim in one include and checks requestedBy against it; 'user-1'
    // matches claimedBy on this non-trade Claim.
    mockEvidenceReferenceFindUnique.mockResolvedValue({ id: 'ref-1', sha256: 'abc123', proof: { claim: { tradeId: null, claimedBy: 'user-1' } } })
    const anchorProof = { anchorType: 'opentimestamps', anchorId: 'base64stuff', submittedAt: '2026-08-04T00:00:00.000Z', upgraded: false }
    mockAnchor.mockResolvedValue(anchorProof)
    mockEvidenceReferenceUpdate.mockResolvedValue({ id: 'ref-1', anchorProof })

    const service = new ProofService()
    const result = await service.anchorEvidence('ref-1', 'user-1')

    expect(mockAnchor).toHaveBeenCalledWith('abc123')
    expect(mockEvidenceReferenceUpdate).toHaveBeenCalledWith({ where: { id: 'ref-1' }, data: { anchorProof } })
    expect(result.anchorProof).toEqual(anchorProof)
  })

  it('throws NotFoundError for an unknown evidenceReferenceId', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue(null)
    const service = new ProofService()
    await expect(service.anchorEvidence('nope', 'user-1')).rejects.toThrow('EvidenceReference')
  })

  // Issue #265 CTO Gate R2, CONTRACT DELTA 5 — anchorEvidence() is the
  // ONLY place any EvidenceReference row is ever updated after creation
  // (see prisma/schema.prisma's own EvidenceReference model comment).
  // This pins that guarantee explicitly, rather than leaving it as an
  // implicit side effect of the exact-match assertion above: provider/uri
  // (storage location provenance) must never appear in this — or any —
  // update payload, or a future migration could silently overwrite a
  // row's own storage attribution instead of adding a new one.
  it('never includes provider or uri in its update payload — storage location provenance is immutable once a reference is created', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({ id: 'ref-1', provider: 'local-fs', uri: '/tmp/original', sha256: 'abc123', proof: { claim: { tradeId: null, claimedBy: 'user-1' } } })
    mockAnchor.mockResolvedValue({ anchorType: 'opentimestamps', anchorId: 'x', submittedAt: '2026-08-04T00:00:00.000Z', upgraded: false })
    mockEvidenceReferenceUpdate.mockResolvedValue({ id: 'ref-1' })

    const service = new ProofService()
    await service.anchorEvidence('ref-1', 'user-1')

    const updateCallData = mockEvidenceReferenceUpdate.mock.calls[0][0].data
    expect(Object.keys(updateCallData)).not.toContain('provider')
    expect(Object.keys(updateCallData)).not.toContain('uri')
  })
})

describe('updateEvidenceReferenceProvenanceGuarded() — CTO Delta, Durable Evidence Provenance', () => {
  // Tests the mutation BOUNDARY itself, independent of anchorEvidence()'s
  // own current call shape (the test above only proves what one caller
  // happens to send today — it would not catch a DIFFERENT future
  // caller that mutates provider/uri through this same table). This is
  // the property that closes that gap: no payload containing
  // provider/uri can reach Prisma through this function, from ANY
  // caller, ever — proven directly, not inferred from one call site.
  beforeEach(() => jest.clearAllMocks())

  it("refuses a payload containing 'provider' — throws before Prisma is ever called (bypassing TypeScript's own Omit<> via 'as any', the real-world equivalent of a future caller that doesn't go through this function's own type)", () => {
    expect(() =>
      updateEvidenceReferenceProvenanceGuarded('ref-1', { provider: 'malicious-s3' } as never)
    ).toThrow(/immutable storage-location provenance/)
    expect(mockEvidenceReferenceUpdate).not.toHaveBeenCalled()
  })

  it("refuses a payload containing 'uri' — same guard, the other half of storage-location provenance", () => {
    expect(() =>
      updateEvidenceReferenceProvenanceGuarded('ref-1', { uri: '/attacker/controlled/path' } as never)
    ).toThrow(/immutable storage-location provenance/)
    expect(mockEvidenceReferenceUpdate).not.toHaveBeenCalled()
  })

  it("refuses a payload containing BOTH 'provider' and 'uri' at once — the exact shape a real provider-migration bug would attempt", () => {
    expect(() =>
      updateEvidenceReferenceProvenanceGuarded('ref-1', { provider: 's3', uri: 'new-key.bin' } as never)
    ).toThrow(/immutable storage-location provenance/)
    expect(mockEvidenceReferenceUpdate).not.toHaveBeenCalled()
  })

  it('allows a legitimate mutation (anchorProof) through to Prisma unmodified — the guard is narrow, not a blanket freeze of the row', async () => {
    mockEvidenceReferenceUpdate.mockResolvedValue({ id: 'ref-1' })

    await updateEvidenceReferenceProvenanceGuarded('ref-1', { anchorProof: { anchorType: 'opentimestamps' } } as never)

    expect(mockEvidenceReferenceUpdate).toHaveBeenCalledWith({
      where: { id: 'ref-1' },
      data: { anchorProof: { anchorType: 'opentimestamps' } },
    })
  })
})

describe('ProofService.assertEvidenceReferenceBelongsToTrade() — Issue #266', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the reference when it genuinely belongs to the given trade', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({
      id: 'ref-1', provider: 's3', uri: 'key.bin', sha256: 'abc',
      proof: { claim: { tradeId: 'trade-1' } },
    })

    const service = new ProofService()
    const result = await service.assertEvidenceReferenceBelongsToTrade('ref-1', 'trade-1')

    expect(result.id).toBe('ref-1')
  })

  it('throws NotFoundError for a nonexistent evidenceReferenceId', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue(null)

    const service = new ProofService()
    await expect(service.assertEvidenceReferenceBelongsToTrade('nope', 'trade-1')).rejects.toThrow('EvidenceReference')
  })

  it('throws ForbiddenError when the reference belongs to a DIFFERENT trade', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({
      id: 'ref-1', proof: { claim: { tradeId: 'trade-OTHER' } },
    })

    const service = new ProofService()
    await expect(service.assertEvidenceReferenceBelongsToTrade('ref-1', 'trade-1')).rejects.toThrow(/does not belong to trade/)
  })

  it('throws ForbiddenError when the reference\'s Claim is not trade-scoped at all (tradeId null) — never treated as a match', async () => {
    mockEvidenceReferenceFindUnique.mockResolvedValue({
      id: 'ref-1', proof: { claim: { tradeId: null } },
    })

    const service = new ProofService()
    await expect(service.assertEvidenceReferenceBelongsToTrade('ref-1', 'trade-1')).rejects.toThrow(/does not belong to trade/)
  })
})

describe('ProofService.getEvidenceBundleForTrade() — RFC-007 D6, real per-trade aggregate', () => {
  beforeEach(() => jest.clearAllMocks())

  it('aggregates claims, proofs, verifications, externalReferences, and the real Timeline', async () => {
    // Issue #264 — getEvidenceBundleForTrade() now enforces
    // tradeService.assertParticipant() itself; 'buyer-1' is this trade's
    // buyer.
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockClaimFindMany.mockResolvedValue([
      {
        id: 'claim-1', tradeId: 'trade-1',
        proofs: [
          { id: 'proof-1', verifications: [{ id: 'v-1' }], evidenceReferences: [{ id: 'ref-1' }] },
        ],
      },
    ])
    mockGetEvents.mockResolvedValue([{ eventType: 'openp2p.trade.created', eventId: 'e-1' }])

    const service = new ProofService()
    const bundle = await service.getEvidenceBundleForTrade('trade-1', 'buyer-1')

    expect(mockClaimFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tradeId: 'trade-1' } }))
    expect(bundle.tradeId).toBe('trade-1')
    expect(bundle.claims).toHaveLength(1)
    expect(bundle.proofs).toEqual([expect.objectContaining({ id: 'proof-1' })])
    expect(bundle.verifications).toEqual([{ id: 'v-1' }])
    expect(bundle.externalReferences).toEqual([{ id: 'ref-1' }])
    expect(bundle.timeline).toEqual([{ eventType: 'openp2p.trade.created', eventId: 'e-1' }])
  })

  it('returns empty arrays for a trade with no claims, never throws', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-empty', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockClaimFindMany.mockResolvedValue([])
    mockGetEvents.mockResolvedValue([])
    const service = new ProofService()
    const bundle = await service.getEvidenceBundleForTrade('trade-empty', 'buyer-1')
    expect(bundle.claims).toEqual([])
    expect(bundle.proofs).toEqual([])
  })

  it('Issue #264 — rejects a direct service call from an unrelated actor, proving the service boundary itself enforces authorization, not only the HTTP route', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    const service = new ProofService()
    await expect(service.getEvidenceBundleForTrade('trade-1', 'outsider-1')).rejects.toThrow(
      'is not a party to trade'
    )
    expect(mockClaimFindMany).not.toHaveBeenCalled()
  })
})

describe('ProofService.submitProof() — RFC-007 D1 duplicate detection (real wiring, mocked registry)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('emits proof.duplicate_detected when the registry reports a real match from a different trade', async () => {
    mockClaimFindUnique.mockResolvedValue({ id: 'claim-1', tradeId: 'trade-current', createdAt: new Date() })
    // Issue #261 — submitProof() now checks submittedBy against the
    // claim's trade; 'user-1' is this trade's buyer.
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-current', buyerId: 'user-1', sellerId: 'seller-x' })
    mockProofCreate.mockResolvedValue({ id: 'proof-new', claimId: 'claim-1' })
    mockFindDuplicates.mockResolvedValue([{ proofId: 'proof-old', tradeId: 'trade-other', matchedAt: '2026-08-01T00:00:00.000Z' }])

    const service = new ProofService()
    await service.submitProof({ claimId: 'claim-1', evidence: { note: 'reused screenshot' }, submittedBy: 'user-1' })

    expect(mockEmit).toHaveBeenCalledWith(
      'proof.duplicate_detected',
      expect.objectContaining({ matches: [{ proofId: 'proof-old', tradeId: 'trade-other', matchedAt: '2026-08-01T00:00:00.000Z' }] }),
      'claim-1'
    )
  })

  it('does not emit proof.duplicate_detected when no real duplicate exists', async () => {
    mockClaimFindUnique.mockResolvedValue({ id: 'claim-1', tradeId: 'trade-current', createdAt: new Date() })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-current', buyerId: 'user-1', sellerId: 'seller-x' })
    mockProofCreate.mockResolvedValue({ id: 'proof-new', claimId: 'claim-1' })
    mockFindDuplicates.mockResolvedValue([])

    const service = new ProofService()
    await service.submitProof({ claimId: 'claim-1', evidence: { note: 'unique evidence' }, submittedBy: 'user-1' })

    expect(mockEmit).not.toHaveBeenCalledWith('proof.duplicate_detected', expect.anything(), expect.anything())
  })
})
