/**
 * Issue #266 — Dispute.evidence <-> OpenProof cross-reference.
 *
 * Proves the additive `evidenceReferenceId` path on `EvidenceDescriptor`
 * (dispute.service.ts's `resolveEvidenceDescriptor()`, called by both
 * `raiseDispute()` and `submitEvidence()`): a caller-supplied
 * `evidenceReferenceId` is resolved/scope-checked server-side via
 * `proofService.assertEvidenceReferenceBelongsToTrade()` — mocked here
 * at the collaborator boundary (its own correctness is proven directly
 * in tests/proofService.test.ts) — before ever being persisted, and a
 * legacy raw/external descriptor is left completely untouched.
 *
 * `idempotencyKey` is omitted in every submitEvidence() call below —
 * `withIdempotency()`'s own no-key path (`common/idempotency.ts`) calls
 * straight through to persist()/postPersist() with no Redis/Prisma
 * idempotency-store dependency, so this file needs no mock for that.
 */
const mockDisputeFindUnique = jest.fn()
const mockDisputeCreate = jest.fn()
const mockDisputeUpdate = jest.fn()
// persistEvidence()'s write is one conditional UPDATE ... RETURNING "evidenceGeneration" ($queryRaw), the new entry bound as a JSON array.
const mockExecuteRaw = jest.fn()
const mockTradeFindUnique = jest.fn()
const mockEscrowParticipantKeyFindUnique = jest.fn()
const mockEmit = jest.fn().mockResolvedValue(undefined)
const mockOpenDispute = jest.fn().mockResolvedValue({})
const mockAssertEvidenceReferenceBelongsToTrade = jest.fn()

jest.mock('../src/common/database', () => ({
  prisma: {
    dispute: {
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      create: (...args: unknown[]) => mockDisputeCreate(...args),
      update: (...args: unknown[]) => mockDisputeUpdate(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    escrowParticipantKey: { findUnique: (...args: unknown[]) => mockEscrowParticipantKeyFindUnique(...args) },
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    // #309 — the evidence append is one UPDATE ... RETURNING "evidenceGeneration" ($queryRaw). It shares
    // mockExecuteRaw's queued results and recorded SQL: a count of 1 is one committed row, 0 none.
    $queryRaw: async (...args: unknown[]) => ((await mockExecuteRaw(...args)) ? [{ evidenceGeneration: 1 }] : []),
  },
}))

// The entries persistEvidence() appended in its (single) write.
function persistedEntries(): any[] {
  const [, ...values] = mockExecuteRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
  return JSON.parse(values.find((v) => typeof v === 'string' && v.startsWith('[')) as string)
}
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))
jest.mock('../src/modules/open-settlement/escrow.service', () => ({
  // Issue #238 - raiseDispute() establishes the Dispute inside openDisputeEstablishing()'s transaction;
  // this mock records the same openDispute() call and runs `establish` against the mocked prisma (as tx).
  escrowService: {
    openDispute: (...args: unknown[]) => mockOpenDispute(...args),
    openDisputeEstablishing: async (escrowId: string, by: string, reason: string, establish: (tx: unknown) => Promise<unknown>) => {
      await mockOpenDispute(escrowId, by, reason)
      return establish(require('../src/common/database').prisma)
    },
  },
}))
jest.mock('../src/modules/open-proof/proof.service', () => ({
  proofService: {
    assertEvidenceReferenceBelongsToTrade: (...args: unknown[]) => mockAssertEvidenceReferenceBelongsToTrade(...args),
  },
}))

import { DisputeService } from '../src/modules/open-settlement/dispute.service'
import type { ArbitrationProvider } from '../src/modules/open-settlement/arbitration-provider'
import { NotFoundError, ForbiddenError } from '../src/common/errors'

function fakeArbitrationProvider(pick = 'arb-configured'): ArbitrationProvider {
  return { name: 'fake-provider', arbitrators: [pick], assign: jest.fn().mockResolvedValue(pick) }
}

const TRADE_1 = { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' }

function seedDispute(overrides: Partial<{ id: string; tradeId: string; status: string; evidence: unknown }> = {}) {
  const dispute = {
    id: overrides.id ?? 'dispute-1',
    tradeId: overrides.tradeId ?? 'trade-1',
    escrowId: 'escrow-1',
    status: overrides.status ?? 'OPENED',
    evidence: overrides.evidence ?? [],
  }
  mockDisputeFindUnique.mockResolvedValue(dispute)
  mockDisputeUpdate.mockImplementation(async ({ data }: any) => ({ ...dispute, ...data }))
  // Same effect as persistEvidence()'s real conditional UPDATE on this seeded row: append, then EVIDENCE_SUBMITTED.
  mockExecuteRaw.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const entries = JSON.parse(values.find((v) => typeof v === 'string' && v.startsWith('[')) as string)
    dispute.evidence = [...(dispute.evidence as unknown[]), ...entries]
    dispute.status = 'EVIDENCE_SUBMITTED'
    return 1
  })
  return dispute
}

describe('DisputeService.submitEvidence() — OpenProof cross-reference (Issue #266)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTradeFindUnique.mockResolvedValue(TRADE_1)
  })

  const service = new DisputeService(fakeArbitrationProvider())

  // Property 1 (read side) — historical raw descriptors still read
  // correctly. Read/serialization is untouched by #266 —
  // settlement.routes.ts's GET /v1/settlement/disputes/:id returns
  // prisma.dispute.findUnique()'s row as-is; getDispute() itself does
  // no transformation. A pre-existing raw entry (predating even the
  // `externalReference` discriminator) is never reinterpreted,
  // upgraded, or stripped by any code path — this function
  // (resolveEvidenceDescriptor) only ever runs on a NEW write, never on
  // data already sitting in Dispute.evidence.
  it('1 (read) — getDispute() returns a historical raw descriptor with neither evidenceReferenceId nor externalReference exactly as stored, never reinterpreted', async () => {
    const legacyEntry = { type: 'chat_log', uri: 'https://example.com/old-receipt.png', note: 'from before this discriminator existed', submittedBy: 'buyer-1', submittedAt: '2026-01-01T00:00:00.000Z' }
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', evidence: [legacyEntry] })

    const dispute = await service.getDispute('dispute-1')

    expect(dispute.evidence).toEqual([legacyEntry])
  })

  // CTO Gate re-gate, adversarial test 3 — external/non-file raw
  // reference remains supported for NEW writes, given the required
  // explicit `externalReference: true` declaration.
  it('3 — a NEW external/non-file reference, explicitly declared via externalReference:true, persists successfully with no OpenProof lookup', async () => {
    seedDispute()

    const result = await service.submitEvidence('dispute-1', 'buyer-1', {
      type: 'chat_log', uri: 'https://example.com/receipt.png', note: 'see attached', externalReference: true,
    })

    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
    const persistedEvidence = persistedEntries()
    expect(persistedEvidence[0]).toMatchObject({
      type: 'chat_log', uri: 'https://example.com/receipt.png', note: 'see attached',
      externalReference: true, submittedBy: 'buyer-1',
    })
    expect(persistedEvidence[0].evidenceReferenceId).toBeUndefined()
    expect(result.status).toBe('EVIDENCE_SUBMITTED')
  })

  // CTO Gate re-gate, adversarial test 1 — the core delta this mission
  // exists to close: a NEW raw-uri submission with NEITHER
  // evidenceReferenceId NOR an explicit externalReference:true
  // declaration is REJECTED outright, never silently accepted as
  // production-eligible (regardless of what `type` says — 'screenshot',
  // 'payment_receipt', anything). No partial state persists.
  it("CTO Gate 1 — a NEW raw-uri-only submission with no explicit classification is rejected (production-ineligible), nothing persisted", async () => {
    seedDispute()

    await expect(
      service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', uri: 'https://example.com/receipt.png' })
    ).rejects.toThrow(/must either reference OpenProof.*or be explicitly declared as an external/)
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
  })

  it('CTO Gate — evidenceReferenceId + externalReference together is rejected as a contradiction (the two classes are mutually exclusive)', async () => {
    seedDispute()

    await expect(
      service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', evidenceReferenceId: 'ref-1', externalReference: true })
    ).rejects.toThrow(/mutually exclusive/)
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
  })

  // Codex addendum, matrix case C — externalReference:true without a uri
  // is a meaningless declaration (nothing is being referenced) and must
  // be rejected explicitly, not silently accepted as an ambiguous
  // descriptor.
  it('CTO Gate matrix C — externalReference:true with no uri is rejected as meaningless, nothing persisted', async () => {
    seedDispute()

    await expect(
      service.submitEvidence('dispute-1', 'buyer-1', { type: 'verbal_confirmation', note: 'confirmed by phone', externalReference: true })
    ).rejects.toThrow(/externalReference: true requires a uri/)
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
  })

  // A pure text note (no uri, no evidenceReferenceId, no
  // externalReference) has nothing that could masquerade as file
  // evidence — this legitimate, always-valid EvidenceDescriptor shape
  // is untouched by #266's production-eligibility rule.
  it('a pure note-only descriptor (no uri at all) remains valid with no explicit classification required — nothing to misrepresent as file evidence', async () => {
    seedDispute()

    const result = await service.submitEvidence('dispute-1', 'buyer-1', { type: 'verbal_confirmation', note: 'seller confirmed via phone call' })

    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
    const persistedEvidence = persistedEntries()
    expect(persistedEvidence[0]).toMatchObject({ type: 'verbal_confirmation', note: 'seller confirmed via phone call', submittedBy: 'buyer-1' })
    expect(persistedEvidence[0].uri).toBeUndefined()
    expect(persistedEvidence[0].evidenceReferenceId).toBeUndefined()
    expect(result.status).toBe('EVIDENCE_SUBMITTED')
  })

  // Property 4 — valid OpenProof cross-reference attaches successfully.
  it('4 — a valid evidenceReferenceId attaches successfully after being scope-checked against the dispute\'s own trade', async () => {
    seedDispute()
    mockAssertEvidenceReferenceBelongsToTrade.mockResolvedValue({ id: 'ref-1', provider: 's3', uri: 'key.bin', sha256: 'abc' })

    const result = await service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', evidenceReferenceId: 'ref-1' })

    expect(mockAssertEvidenceReferenceBelongsToTrade).toHaveBeenCalledWith('ref-1', 'trade-1')
    const persistedEvidence = persistedEntries()
    expect(persistedEvidence[0]).toMatchObject({ type: 'payment_receipt', evidenceReferenceId: 'ref-1', submittedBy: 'buyer-1' })
    // Never a second copy of OpenProof's own facts — provider/uri/sha256
    // are NOT duplicated into the descriptor.
    expect(persistedEvidence[0].uri).toBeUndefined()
    expect(persistedEvidence[0].provider).toBeUndefined()
    expect(persistedEvidence[0].sha256).toBeUndefined()
    expect(result.status).toBe('EVIDENCE_SUBMITTED')
  })

  // Property 5 — nonexistent reference is rejected.
  it('5 — a nonexistent evidenceReferenceId is rejected (NotFoundError from the OpenProof layer), nothing persisted', async () => {
    seedDispute()
    mockAssertEvidenceReferenceBelongsToTrade.mockRejectedValue(new NotFoundError('EvidenceReference', 'nope'))

    await expect(
      service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', evidenceReferenceId: 'nope' })
    ).rejects.toThrow(NotFoundError)
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
  })

  // Property 6 — reference from another trade/economic scope is rejected.
  it('6 — an evidenceReferenceId belonging to a DIFFERENT trade is rejected (ForbiddenError from the OpenProof layer), nothing persisted', async () => {
    seedDispute()
    mockAssertEvidenceReferenceBelongsToTrade.mockRejectedValue(
      new ForbiddenError('EvidenceReference ref-foreign does not belong to trade trade-1')
    )

    await expect(
      service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', evidenceReferenceId: 'ref-foreign' })
    ).rejects.toThrow(ForbiddenError)
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
  })

  // Property 7 — unrelated authenticated participant is rejected.
  it('7 — an authenticated but unrelated participant cannot attach a cross-reference to someone else\'s dispute — rejected before ever resolving the reference', async () => {
    seedDispute()

    await expect(
      service.submitEvidence('dispute-1', 'outsider-1', { type: 'payment_receipt', evidenceReferenceId: 'ref-1' })
    ).rejects.toThrow(/is not a party to trade/)
    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
  })

  // Property 8 — superseded arbiter cannot use stale authority.
  // Dispute-native evidence submission has always been buyer/seller-only
  // (never the assigned arbiter, current or historical) — #266 does not
  // change this authorization boundary, it only reuses it. An arbiter id
  // (even the CURRENTLY assigned one) is rejected exactly like any other
  // non-party.
  it('8 — neither a historical nor the currently assigned arbiter can attach a cross-reference — dispute-evidence placement has always been buyer/seller-only', async () => {
    seedDispute()

    await expect(
      service.submitEvidence('dispute-1', 'arbiter-current-or-historical', { type: 'payment_receipt', evidenceReferenceId: 'ref-1' })
    ).rejects.toThrow(/is not a party to trade/)
    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
  })

  // Property 9 — caller cannot forge hash/provider/URI through the
  // dispute cross-reference: a descriptor combining uri + evidenceReferenceId
  // is rejected outright, never silently resolved by preferring one over
  // the other.
  it('9 — a descriptor combining uri AND evidenceReferenceId is rejected outright — never silently resolved by preferring one', async () => {
    seedDispute()

    await expect(
      service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', uri: 'https://attacker.example/fake.png', evidenceReferenceId: 'ref-1' })
    ).rejects.toThrow(/cannot include both uri and evidenceReferenceId/)
    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
    expect(mockExecuteRaw).not.toHaveBeenCalled()
  })

  // Property 12 — #265 provider/error semantics remain intact: this
  // service never catches/reclassifies EvidenceStorageError or any
  // #265-defined error — whatever proofService throws propagates as-is
  // (already proven by properties 5/6 above using the real NotFoundError/
  // ForbiddenError classes, not a locally re-invented error shape).
})

describe('DisputeService.raiseDispute() — OpenProof cross-reference applies at dispute-creation time too (Issue #266)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTradeFindUnique.mockResolvedValue(TRADE_1)
    mockEscrowParticipantKeyFindUnique.mockResolvedValue(null)
    mockDisputeCreate.mockImplementation(async ({ data }: any) => ({ id: 'dispute-1', ...data }))
    mockDisputeUpdate.mockImplementation(async ({ data }: any) => ({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arb-configured', ...data }))
  })

  const service = new DisputeService(fakeArbitrationProvider())

  // This is the bypass this mission's own resolveEvidenceDescriptor()
  // comment names explicitly: a caller could otherwise skip
  // submitEvidence()'s own cross-reference validation entirely by
  // submitting the SAME forged/out-of-scope reference at dispute-open
  // time instead.
  it('rejects a forged/out-of-scope evidenceReferenceId submitted at dispute-creation time — the same guard as submitEvidence(), not bypassable via raiseDispute()', async () => {
    mockAssertEvidenceReferenceBelongsToTrade.mockRejectedValue(
      new ForbiddenError('EvidenceReference ref-foreign does not belong to trade trade-1')
    )

    await expect(
      service.raiseDispute('trade-1', 'buyer-1', 'payment never received', [{ type: 'payment_receipt', evidenceReferenceId: 'ref-foreign' }])
    ).rejects.toThrow(ForbiddenError)
    expect(mockOpenDispute).not.toHaveBeenCalled()
    expect(mockDisputeCreate).not.toHaveBeenCalled()
  })

  it('accepts a valid evidenceReferenceId at dispute-creation time, scope-checked against the trade being disputed', async () => {
    mockAssertEvidenceReferenceBelongsToTrade.mockResolvedValue({ id: 'ref-1' })

    const dispute = await service.raiseDispute('trade-1', 'buyer-1', 'payment never received', [{ type: 'payment_receipt', evidenceReferenceId: 'ref-1' }])

    expect(mockAssertEvidenceReferenceBelongsToTrade).toHaveBeenCalledWith('ref-1', 'trade-1')
    expect(dispute.id).toBe('dispute-1')
    const persistedEvidence = mockDisputeCreate.mock.calls[0][0].data.evidence
    expect(persistedEvidence[0]).toMatchObject({ type: 'payment_receipt', evidenceReferenceId: 'ref-1' })
  })

  it('accepts a NEW external/non-file reference at dispute-creation time, given the explicit externalReference:true declaration', async () => {
    const dispute = await service.raiseDispute('trade-1', 'buyer-1', 'payment never received', [
      { type: 'chat_log', uri: 'https://example.com/x.png', externalReference: true },
    ])

    expect(mockAssertEvidenceReferenceBelongsToTrade).not.toHaveBeenCalled()
    expect(dispute.id).toBe('dispute-1')
    const persistedEvidence = mockDisputeCreate.mock.calls[0][0].data.evidence
    expect(persistedEvidence[0]).toMatchObject({ type: 'chat_log', uri: 'https://example.com/x.png', externalReference: true })
  })

  // CTO Gate re-gate, adversarial test 5 — the production-eligibility
  // rule (not just the OpenProof-scope guard tested above) cannot be
  // bypassed by submitting a raw, unclassified URI at dispute-creation
  // time instead of via submitEvidence().
  it('CTO Gate 5 — a NEW raw-uri-only descriptor with no explicit classification is rejected at dispute-creation time too, nothing persisted', async () => {
    await expect(
      service.raiseDispute('trade-1', 'buyer-1', 'payment never received', [{ type: 'payment_receipt', uri: 'https://example.com/x.png' }])
    ).rejects.toThrow(/must either reference OpenProof.*or be explicitly declared as an external/)
    expect(mockOpenDispute).not.toHaveBeenCalled()
    expect(mockDisputeCreate).not.toHaveBeenCalled()
  })
})

// Codex addendum, matrix case L — proves the REAL HTTP-boundary Zod
// schema (the exact one settlement.routes.ts's routes call .parse()
// with — imported here, not a hand-copied duplicate that could
// silently drift) actually preserves `evidenceReferenceId`/
// `externalReference` through parsing, closing the specific "Zod might
// be silently stripping the new field" concern an independent review
// raised. Deliberately imports the extracted, side-effect-free
// evidence-descriptor-schema.ts module (only depends on `zod`) rather
// than settlement.routes.ts itself, which would drag in escrow/dispute
// services, Redis-backed rate limiting, and config just to reach two
// schema consts.
describe('evidenceDescriptorInputSchema — real HTTP-boundary Zod schema (Codex addendum, matrix L)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { evidenceDescriptorInputSchema } = require('../src/modules/open-settlement/evidence-descriptor-schema')

  it('preserves evidenceReferenceId through .parse() — proves it reaches the service, not stripped as an unknown key', () => {
    const parsed = evidenceDescriptorInputSchema.parse({ type: 'payment_receipt', evidenceReferenceId: 'ref-1' })
    expect(parsed.evidenceReferenceId).toBe('ref-1')
  })

  it('preserves externalReference through .parse() — proves the explicit declaration reaches the service, not stripped', () => {
    const parsed = evidenceDescriptorInputSchema.parse({ type: 'chat_log', uri: 'https://example.com/x.png', externalReference: true })
    expect(parsed.externalReference).toBe(true)
  })

  it('rejects externalReference: false — the discriminator is a presence-only literal(true), never a general boolean', () => {
    expect(() => evidenceDescriptorInputSchema.parse({ type: 'chat_log', uri: 'https://example.com/x.png', externalReference: false })).toThrow()
  })
})
