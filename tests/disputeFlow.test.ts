/**
 * Dispute flow + p2p-schemas — 04-Deepseek Review.md Tasks 1 & 2.
 *
 * Same mocking pattern as intentFlow.test.ts: Prisma/eventBus are mocked
 * to unit-test the real business logic (authorization, freeze-then-assign
 * ordering, ruling -> escrow action mapping) without a live Postgres.
 * deriveTradeState is a pure function — no mocking needed at all.
 */
import { deriveTradeState } from '@satsails/p2p-schemas'
import { toOfferSchema } from '@satsails/p2p-schemas'
import { TrustedArbitratorProvider } from '../src/modules/open-settlement/arbitration-provider'
import nacl from 'tweetnacl'
import { signAuthorityDecision, type AuthorityDecisionPayload } from '../src/modules/open-settlement/arbitration-authority'

// Missão 13 Fase 2 — resolveDispute() now verifies a signed authority
// decision against the arbiter's registered User.publicKey (INV-12) before
// executing any settlement. One real Ed25519 keypair stands in for every
// arbiter this file exercises ('arbiter-1', 'new-arbiter') — the mocked
// prisma.user.findUnique below returns this same public key regardless of
// which arbiterId is looked up, since these tests are about DisputeService's
// own orchestration, not about distinguishing multiple real identities.
const testKeypair = nacl.sign.keyPair()
const testPublicKeyHex = Buffer.from(testKeypair.publicKey).toString('hex')
const mockUserFindUnique = jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({
  id: where.id,
  publicKey: testPublicKeyHex,
}))

// Signs an authority decision exactly the way dispute.service.ts's own
// resolveDispute() builds its verification payload — mirroring
// `dispute.appealRound` verbatim (including undefined, for fixtures that
// don't set it) so the signature verifies against whatever the mocked
// prisma.dispute.findUnique() row actually contains.
function signResolution(
  dispute: { id: string; escrowId: string; appealRound?: number },
  authorityId: string,
  outcome: 'RELEASE' | 'REFUND' | 'SPLIT',
  buyerBps: number | null = null,
  issuedAt = '2026-08-29T00:00:00.000Z'
): [string, string] {
  const payload = {
    disputeId: dispute.id,
    escrowId: dispute.escrowId,
    appealRound: dispute.appealRound,
    authorityId,
    outcome,
    buyerBps,
    issuedAt,
  } as AuthorityDecisionPayload
  return [signAuthorityDecision(payload, testKeypair.secretKey), issuedAt]
}

const mockTradeFindUnique = jest.fn()
const mockDisputeCreate = jest.fn()
const mockDisputeFindUnique = jest.fn()
const mockDisputeFindMany = jest.fn().mockResolvedValue([])
const mockDisputeCount = jest.fn().mockResolvedValue(0)
const mockDisputeUpdate = jest.fn()
const mockDisputeUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
// RFC-021 D9 (2026-08-02) — applyRuling() now looks up the escrow itself
// (isSignatureCollectionType() dispatch) even for RELEASE/REFUND, so every
// test needs a real default here, not just the new SPLIT-specific ones.
// 'MOCK' keeps isSignatureCollectionType() false, preserving this file's
// existing tests' direct-call expectations unchanged.
const mockEscrowFindUnique = jest.fn().mockResolvedValue({ id: 'escrow-1', type: 'MOCK' })
// RFC-021 D6 real appeal-fee collection (2026-08-01) — appeal() charges
// one of these per appeal round, resolveDispute() settles its outcome.
const mockDisputeAppealFeeCreate = jest.fn().mockResolvedValue({ id: 'appeal-fee-1' })
const mockDisputeAppealFeeUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
// Fase 7.3.1 §B — findCommittedArbiterId() reads this for every
// raiseDispute()/appeal() call. Defaults to "no committed arbiter" (null),
// preserving this file's existing MOCK-escrow-fixture tests' assign()-based
// expectations unchanged; tests exercising the new script-commitment
// behavior override this per-test.
const mockEscrowParticipantKeyFindUnique = jest.fn().mockResolvedValue(null)

// ADR-005 / #218 — applyRuling()'s resolve-write and appeal()'s
// authority-reassignment write now run inside prisma.$transaction() (the
// economic-disposition:<disputeId> advisory lock + a conditional claim,
// closing the old-arbiter in-flight race). The fake `tx` client below
// routes to the SAME mock functions the rest of this file already asserts
// against, so this is purely a wiring change — every existing assertion on
// mockDisputeUpdateMany/mockDisputeFindUnique continues to observe the
// same calls, now made via `tx` instead of the top-level `prisma` object.
const mockExecuteRaw = jest.fn().mockResolvedValue(0)
const mockTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    disputeAppealFee: {
      create: (...args: unknown[]) => mockDisputeAppealFeeCreate(...args),
    },
    dispute: {
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      updateMany: (...args: unknown[]) => mockDisputeUpdateMany(...args),
    },
  })
)

jest.mock('../src/common/database', () => ({
  prisma: {
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: {
      create: (...args: unknown[]) => mockDisputeCreate(...args),
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      findMany: (...args: unknown[]) => mockDisputeFindMany(...args),
      count: (...args: unknown[]) => mockDisputeCount(...args),
      update: (...args: unknown[]) => mockDisputeUpdate(...args),
      updateMany: (...args: unknown[]) => mockDisputeUpdateMany(...args),
    },
    disputeAppealFee: {
      create: (...args: unknown[]) => mockDisputeAppealFeeCreate(...args),
      updateMany: (...args: unknown[]) => mockDisputeAppealFeeUpdateMany(...args),
    },
    escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args) },
    escrowParticipantKey: { findUnique: (...args: unknown[]) => mockEscrowParticipantKeyFindUnique(...args) },
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

// dispute.service.ts's new RFC-021 D8 methods read
// config.settlement.qvacAutoResolutionWindowHours — a real config import,
// not mocked away in the other tests in this file (which never needed
// it), so it's mocked here specifically for the new describe blocks.
jest.mock('../src/config', () => ({
  config: { settlement: { qvacAutoResolutionWindowHours: 24 } },
}))

const mockEmit = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

const mockOpenDispute = jest.fn().mockResolvedValue({})
const mockReleaseFunds = jest.fn().mockResolvedValue({})
const mockRefundFunds = jest.fn().mockResolvedValue({})
// RFC-021 D9 (2026-08-02)
const mockSplitFunds = jest.fn().mockResolvedValue({})
const mockInitiateRelease = jest.fn().mockResolvedValue({})
const mockInitiateRefund = jest.fn().mockResolvedValue({})
const mockInitiateSplit = jest.fn().mockResolvedValue({})
const mockIsSignatureCollectionType = jest.fn().mockReturnValue(false)
jest.mock('../src/modules/open-settlement/escrow.service', () => ({
  escrowService: {
    openDispute: (...args: unknown[]) => mockOpenDispute(...args),
    releaseFunds: (...args: unknown[]) => mockReleaseFunds(...args),
    refundFunds: (...args: unknown[]) => mockRefundFunds(...args),
    splitFunds: (...args: unknown[]) => mockSplitFunds(...args),
    initiateRelease: (...args: unknown[]) => mockInitiateRelease(...args),
    initiateRefund: (...args: unknown[]) => mockInitiateRefund(...args),
    initiateSplit: (...args: unknown[]) => mockInitiateSplit(...args),
    isSignatureCollectionType: (...args: unknown[]) => mockIsSignatureCollectionType(...args),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DisputeService } = require('../src/modules/open-settlement/dispute.service')

describe('deriveTradeState — Task 1 state vocabulary over the real columns', () => {
  it('maps the happy path: open -> payment_sent -> escrow_released', () => {
    expect(deriveTradeState({ status: 'PENDING' }, null, null)).toBe('open')
    expect(deriveTradeState({ status: 'ACTIVE' }, { status: 'FUNDS_LOCKED' }, null)).toBe('open')
    expect(deriveTradeState({ status: 'ACTIVE' }, { status: 'PAYMENT_PENDING' }, null)).toBe('payment_sent')
    expect(deriveTradeState({ status: 'COMPLETED' }, { status: 'COMPLETED' }, null)).toBe('escrow_released')
  })

  it('maps dispute states, including buyer/seller resolutions', () => {
    expect(deriveTradeState({ status: 'DISPUTED' }, { status: 'DISPUTED' }, { status: 'OPENED', ruling: null })).toBe('dispute_opened')
    expect(deriveTradeState({ status: 'COMPLETED' }, { status: 'COMPLETED' }, { status: 'RESOLVED', ruling: 'RELEASE' })).toBe('dispute_resolved_buyer')
    expect(deriveTradeState({ status: 'CANCELLED' }, { status: 'REFUNDED' }, { status: 'RESOLVED', ruling: 'REFUND' })).toBe('dispute_resolved_seller')
  })

  it('maps cancellation/refund to cancelled', () => {
    expect(deriveTradeState({ status: 'CANCELLED' }, null, null)).toBe('cancelled')
    expect(deriveTradeState({ status: 'ACTIVE' }, { status: 'REFUNDED' }, null)).toBe('cancelled')
  })

  // F-01 (System Coherence & Integration Audit, 2026-09-13) — a resolved
  // SPLIT dispute previously fell through to 'dispute_opened' (still-open
  // dispute) via this branch, or to 'open' (not-yet-started trade) via
  // the escrow-status-only fallback below — both misreporting a real,
  // terminal, partial-payout outcome. Every path this function can reach
  // a SPLIT outcome through is exercised here adversarially, not just the
  // happy one.
  describe('SPLIT outcome — F-01 fix', () => {
    it('maps a resolved SPLIT dispute to dispute_resolved_split, not dispute_opened (the exact defect this fix closes)', () => {
      expect(
        deriveTradeState({ status: 'COMPLETED' }, { status: 'SPLIT' }, { status: 'RESOLVED', ruling: 'SPLIT' })
      ).toBe('dispute_resolved_split')
    })

    it('does not regress dispute_opened for a SPLIT ruling that has not resolved yet (still ARBITRATED/EVIDENCE_SUBMITTED/OPENED)', () => {
      // A ruling may be recorded ahead of RESOLVED in some real flows —
      // deriveTradeState() must still report the dispute as open until
      // dispute.status itself says RESOLVED, exactly like RELEASE/REFUND
      // already do.
      expect(
        deriveTradeState({ status: 'DISPUTED' }, { status: 'DISPUTED' }, { status: 'ARBITRATED', ruling: 'SPLIT' })
      ).toBe('dispute_opened')
    })

    it('maps a SPLIT escrow with no Dispute row available (the escrow-status-only fallback path) to dispute_resolved_split, not open', () => {
      // Mirrors the real caller shape that reaches this path (e.g. a
      // read model that only has the Escrow row, not a joined Dispute
      // row) — RFC-021 D9 makes SPLIT reachable exclusively via a
      // dispute ruling, so this is unambiguous even without one.
      expect(deriveTradeState({ status: 'COMPLETED' }, { status: 'SPLIT' }, null)).toBe('dispute_resolved_split')
    })

    it('does not fabricate a resolution for a RESOLVED dispute with neither a recognized ruling nor SPLIT (malformed/incomplete state)', () => {
      expect(
        deriveTradeState({ status: 'DISPUTED' }, { status: 'DISPUTED' }, { status: 'RESOLVED', ruling: null })
      ).toBe('dispute_opened')
    })

    it('does not regress RELEASE/REFUND/cancelled/completed-without-dispute semantics', () => {
      expect(deriveTradeState({ status: 'COMPLETED' }, { status: 'COMPLETED' }, { status: 'RESOLVED', ruling: 'RELEASE' })).toBe('dispute_resolved_buyer')
      expect(deriveTradeState({ status: 'CANCELLED' }, { status: 'REFUNDED' }, { status: 'RESOLVED', ruling: 'REFUND' })).toBe('dispute_resolved_seller')
      expect(deriveTradeState({ status: 'CANCELLED' }, null, null)).toBe('cancelled')
      expect(deriveTradeState({ status: 'COMPLETED' }, { status: 'COMPLETED' }, null)).toBe('escrow_released')
    })
  })
})

describe('toOfferSchema — Task 1 Offer contract over the real Prisma shape', () => {
  it('derives assetSell/assetBuy from asset+side and wraps paymentMethod as array', () => {
    const schema = toOfferSchema({
      id: 'offer-1',
      userId: 'user-1',
      asset: 'BTC',
      side: 'SELL',
      priceUsd: { toString: () => '65000' },
      priceBrl: { toString: () => '350000' },
      maxAmount: { toString: () => '0.5' },
      paymentMethod: 'PIX',
      status: 'ACTIVE',
    })
    expect(schema).toMatchObject({
      assetSell: 'BTC',
      assetBuy: 'BRL', // BRL quote present -> BRL pair
      amount: '0.5',
      price: '350000',
      paymentMethods: ['PIX'],
    })
  })
})

describe('DisputeService — Task 2 raiseDispute/resolveDispute', () => {
  const arbitration = new TrustedArbitratorProvider(['arbiter-1', 'arbiter-2'])
  const service = new DisputeService(arbitration)

  beforeEach(() => jest.clearAllMocks())

  it('raiseDispute freezes the escrow, persists, assigns an arbiter, and notifies via pubsub', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })
    mockDisputeCreate.mockResolvedValue({ id: 'dispute-1' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', arbiterId: 'arbiter-1' })

    const dispute = await service.raiseDispute('trade-1', 'buyer-1', 'paguei e não recebi', [])

    expect(mockOpenDispute).toHaveBeenCalledWith('escrow-1', 'buyer-1', 'paguei e não recebi') // freeze
    expect(dispute.arbiterId).toBe('arbiter-1') // assignment via ArbitrationProvider
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.opened',
      expect.objectContaining({ disputeId: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' }),
      'trade-1' // correlationId (RFC-010)
    )
  })

  // Security-validation round (2026-07-19, "disputa dupla" scenario):
  // buyer and seller both raising a dispute at once can both pass every
  // check in raiseDispute()/openDispute() before either write lands —
  // nothing serializes the two calls. The real guard is the database:
  // schema.prisma's Dispute model gained @@unique([tradeId]), so the
  // second concurrent prisma.dispute.create() throws a real P2002 (this
  // mock stands in for that database behavior, not fabricating a new
  // failure mode). Proves raiseDispute() converts it to a clean rejection
  // instead of letting a second Dispute row silently exist.
  it('a second concurrent raiseDispute for the same trade is rejected, not silently duplicated', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })
    const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`tradeId`)'), { code: 'P2002' })
    mockDisputeCreate.mockRejectedValueOnce(p2002)

    await expect(service.raiseDispute('trade-1', 'seller-1', 'contraparte não confirma pagamento')).rejects.toThrow(
      /already been raised/
    )
    // openDispute() still ran (the escrow-side race isn't what's being
    // asserted here — the Dispute-row race is) — this test's own value is
    // that the ValidationError surfaces cleanly, not a raw P2002.
    expect(mockOpenDispute).toHaveBeenCalled()
  })

  it('rejects a raiseDispute from someone who is not a party to the trade', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })
    await expect(service.raiseDispute('trade-1', 'stranger', 'reason')).rejects.toThrow(/not a party/)
    expect(mockOpenDispute).not.toHaveBeenCalled()
  })

  it('resolveDispute RELEASE (buyer wins) releases the escrow and emits the ruling — M8-R2: the caller-supplied releaseToAddress is never forwarded, escrowService resolves the buyer\'s own registered PayoutAddress instead', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })

    const [sig1, issuedAt1] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'RELEASE')
    // A real address is still supplied here (as an old/legacy caller
    // would) specifically to prove it has NO effect — see the assertion
    // below (docs/DESTINATION_AUTHORITY_ARCHITECTURE.md).
    await service.resolveDispute('dispute-1', 'arbiter-1', 'RELEASE', 'bc1qbuyeraddress', undefined, undefined, sig1, issuedAt1)

    expect(mockReleaseFunds).toHaveBeenCalledWith('escrow-1', undefined, 'arbiter-1')
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.resolved',
      expect.objectContaining({ ruling: 'RELEASE', tradeId: 'trade-1' }),
      'trade-1'
    )
  })

  it('resolveDispute REFUND (seller wins) refunds the escrow', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })

    const [sig2, issuedAt2] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'REFUND')
    await service.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, undefined, undefined, sig2, issuedAt2)
    expect(mockRefundFunds).toHaveBeenCalledWith('escrow-1', 'arbiter-1')
  })

  // ADR-005 §10 — the old-arbiter in-flight race applyRuling()'s
  // resolve-write now guards against: a stale arbiter's ruling arrives
  // (or is retried) after a concurrent appeal() has already reassigned
  // this dispute to a different generation. Previously an unconditional
  // `prisma.dispute.update()` by id alone would have silently overwritten
  // whatever appeal() committed; the conditional updateMany claim used
  // inside the `economic-disposition:<disputeId>` lock now observes
  // { count: 0 } for exactly this case and fails closed instead.
  it('ADR-005 §10 — fails closed when the dispute\'s economic disposition authority changed between the top-level read and the locked resolve-write (old-arbiter in-flight race)', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    // Simulates a concurrent appeal() (or resolution) having already
    // claimed this row by the time applyRuling()'s locked updateMany runs.
    // mockResolvedValueOnce (not mockResolvedValue) — mockDisputeUpdateMany
    // is a module-scoped mock other describe blocks in this file also rely
    // on for its persistent { count: 1 } default; jest.clearAllMocks() in
    // beforeEach does not restore a resolved value, so overriding it
    // permanently here would leak into every later test in this file.
    mockDisputeUpdateMany.mockResolvedValueOnce({ count: 0 })

    const [sig, issuedAt] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'RELEASE')
    await expect(
      service.resolveDispute('dispute-1', 'arbiter-1', 'RELEASE', undefined, undefined, undefined, sig, issuedAt)
    ).rejects.toThrow(/no longer authorized for a ruling/)
    expect(mockReleaseFunds).not.toHaveBeenCalled()
    expect(mockInitiateRelease).not.toHaveBeenCalled()
  })

  it('rejects a resolution from anyone but the assigned arbiter', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    await expect(service.resolveDispute('dispute-1', 'impostor', 'REFUND')).rejects.toThrow(/not the arbiter/)
    expect(mockRefundFunds).not.toHaveBeenCalled()
  })

  // Missão 13 Fase 2, INV-12 — the fail-closed gate itself: a request
  // claiming to be the assigned arbiter (arbiterId matches) but carrying
  // no valid signature over that exact decision must still be refused,
  // never falling back to trusting the bare (disputeId, arbiterId, ruling)
  // request body. This is the loophole the whole mission closes — the
  // server's own database (dispute.arbiterId) is exactly what an attacker
  // controlling the arbiter's session token (but not their signing key)
  // would already satisfy under the pre-Missão-13 code.
  it('INV-12 — a garbage/forged authoritySignature is rejected even though arbiterId matches, never falling back to the DB-only claim', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    await expect(
      service.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, undefined, undefined, 'deadbeef'.repeat(16), '2026-08-29T00:00:00.000Z')
    ).rejects.toThrow(/does not verify against arbiter-1's registered public key/)
    expect(mockRefundFunds).not.toHaveBeenCalled()
  })

  // Same gate, different forgery: a signature that is cryptographically
  // real but was produced by a DIFFERENT keypair than the one registered
  // for this arbiterId (e.g. QVAC or any other actor signing with its own
  // key and merely claiming to be the human arbiter) must also fail —
  // proves the check binds to the SPECIFIC registered public key, not
  // "any well-formed Ed25519 signature".
  it('INV-12 — a well-formed signature from a DIFFERENT keypair than the registered arbiter is rejected (QVAC/anyone-else impersonation)', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    const impostorKeypair = nacl.sign.keyPair()
    const [forgedSig, issuedAt] = (() => {
      const payload = {
        disputeId: 'dispute-1', escrowId: 'escrow-1', appealRound: undefined,
        authorityId: 'arbiter-1', outcome: 'REFUND', buyerBps: null,
        issuedAt: '2026-08-29T00:00:00.000Z',
      } as unknown as AuthorityDecisionPayload
      return [signAuthorityDecision(payload, impostorKeypair.secretKey), payload.issuedAt]
    })()
    await expect(
      service.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, undefined, undefined, forgedSig, issuedAt)
    ).rejects.toThrow(/does not verify against arbiter-1's registered public key/)
    expect(mockRefundFunds).not.toHaveBeenCalled()
  })

  // BACKLOG.md's own "Participant payout address" gap, closed 2026-08-04
  // — resolveDispute() no longer pre-validates address presence itself;
  // it forwards through to escrowService.releaseFunds(), whose own
  // resolvePayoutAddress() falls back to a registered PayoutAddress and
  // only throws if neither that nor an explicit address exists. This
  // test now asserts that forwarding, not an upfront rejection.
  it('forwards an omitted releaseToAddress through to escrowService.releaseFunds() rather than rejecting upfront', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })
    const [sig3, issuedAt3] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'RELEASE')
    await service.resolveDispute('dispute-1', 'arbiter-1', 'RELEASE', undefined, undefined, undefined, sig3, issuedAt3)
    expect(mockReleaseFunds).toHaveBeenCalledWith('escrow-1', undefined, 'arbiter-1')
  })

  // RFC-021 D9 (2026-08-02) — the third §1.9 dispute-ruling option finally
  // has a real settlement action.
  describe('resolveDispute SPLIT (RFC-021 D9)', () => {
    it('rejects SPLIT missing splitBuyerBps — addresses alone are no longer required upfront (2026-08-04, PayoutAddress fallback)', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      await expect(service.resolveDispute('dispute-1', 'arbiter-1', 'SPLIT', 'bc1qbuyer', 'bc1qseller')).rejects.toThrow(/splitBuyerBps/)
      expect(mockSplitFunds).not.toHaveBeenCalled()
    })

    it('calls escrowService.splitFunds() directly for a MOCK/WDK-style escrow — M8-R2: buyer/seller destinations are each resolved independently from their own registered PayoutAddress, never the caller-supplied values', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'SPLIT' })

      const [sig4, issuedAt4] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'SPLIT', 6000)
      await service.resolveDispute('dispute-1', 'arbiter-1', 'SPLIT', 'bc1qbuyer', 'bc1qseller', 6000, sig4, issuedAt4)

      expect(mockSplitFunds).toHaveBeenCalledWith('escrow-1', undefined, undefined, 6000, 'arbiter-1')
      expect(mockInitiateSplit).not.toHaveBeenCalled()
      expect(mockEmit).toHaveBeenCalledWith(
        'dispute.resolved',
        expect.objectContaining({ ruling: 'SPLIT', tradeId: 'trade-1' }),
        'trade-1'
      )
    })

    it('routes to initiateSplit() instead for a signature-collection escrow (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM) — M8-R2: same destination-independence as the direct-call path above', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'SPLIT' })
      mockIsSignatureCollectionType.mockReturnValueOnce(true)

      const [sig5, issuedAt5] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'SPLIT', 4000)
      await service.resolveDispute('dispute-1', 'arbiter-1', 'SPLIT', 'bc1qbuyer', 'bc1qseller', 4000, sig5, issuedAt5)

      expect(mockInitiateSplit).toHaveBeenCalledWith('escrow-1', undefined, undefined, 4000, 'arbiter-1')
      expect(mockSplitFunds).not.toHaveBeenCalled()
    })

    it('reverts the dispute to its prior state if the underlying settlement action throws (e.g. SAFE_GUARD_EVM/LIGHTNING_HODL rejecting an unsupported split)', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'SPLIT' })
      mockIsSignatureCollectionType.mockReturnValueOnce(true)
      mockInitiateSplit.mockRejectedValueOnce(new Error('SPLIT is not supported for this escrow type'))

      const [sig6, issuedAt6] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'SPLIT', 4000)
      await expect(
        service.resolveDispute('dispute-1', 'arbiter-1', 'SPLIT', 'bc1qbuyer', 'bc1qseller', 4000, sig6, issuedAt6)
      ).rejects.toThrow(/SPLIT is not supported/)
      // Reverted back to the dispute's own pre-resolution status, ruling
      // cleared — and, since this call carried a verified authority
      // decision, the three authority columns are cleared too (Missão 13
      // Fase 2: a reverted ruling never leaves a verified decision attached
      // to a dispute that never actually settled).
      //
      // CTO Gate R2 (#222) finding R2-1 — the revert is now a lock-protected
      // conditional claim (tx.dispute.updateMany via mockDisputeUpdateMany),
      // proving the row still matches EXACTLY the generation this call
      // committed before reverting it — never a bare update() by id alone.
      expect(mockDisputeUpdateMany).toHaveBeenLastCalledWith({
        where: { id: 'dispute-1', status: 'RESOLVED', ruling: 'SPLIT', arbiterId: 'arbiter-1', appealRound: undefined, authoritySignature: sig6 },
        data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null },
      })
    })

    // CTO Gate R2 (#222) finding R2-1, required Case B — the settlement
    // action fails AFTER a concurrent appeal() has already won the shared
    // economic-disposition:<disputeId> lock and advanced the generation.
    // The revert's own conditional claim must observe { count: 0 } (the
    // row no longer matches this call's own generation) and MUST NOT touch
    // the newer generation's state — the original provider error is still
    // the one the caller sees, but nothing about the dispute is rewritten.
    it('R2-1 Case B — does not overwrite a newer appeal generation when the revert runs after appeal already won the lock', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockIsSignatureCollectionType.mockReturnValueOnce(true)
      mockInitiateSplit.mockRejectedValueOnce(new Error('SPLIT is not supported for this escrow type'))
      // First updateMany call = the resolve-write claim (succeeds, count 1).
      // Second updateMany call = the revert claim, running after this
      // call's own settlement action failed — simulates a concurrent
      // appeal() having already advanced the generation in between, so the
      // row this call originally committed no longer matches.
      mockDisputeUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 })

      const [sig7, issuedAt7] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'SPLIT', 4000)
      await expect(
        service.resolveDispute('dispute-1', 'arbiter-1', 'SPLIT', 'bc1qbuyer', 'bc1qseller', 4000, sig7, issuedAt7)
      ).rejects.toThrow(/SPLIT is not supported/)

      // The revert claim was attempted with the correct generation-bound
      // predicate (proving the mechanism engages) even though it did not
      // match anything live — this is the "fail safely, do nothing" path,
      // not a silent skip of the attempt itself.
      expect(mockDisputeUpdateMany).toHaveBeenLastCalledWith({
        where: { id: 'dispute-1', status: 'RESOLVED', ruling: 'SPLIT', arbiterId: 'arbiter-1', appealRound: undefined, authoritySignature: sig7 },
        data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null },
      })
      expect(mockDisputeUpdateMany).toHaveBeenCalledTimes(2)
    })
  })

  // RFC-021 D9 (2026-08-02) — real bug found while building SPLIT:
  // applyRuling() used to call escrowService.releaseFunds()/refundFunds()
  // unconditionally, but those throw "not directly callable" for
  // MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM (client-held keys). Fixed for
  // all three rulings, not just SPLIT — see escrowService.
  // isSignatureCollectionType()'s own comment.
  describe('resolveDispute RELEASE/REFUND — signature-collection dispatch fix (RFC-021 D9)', () => {
    it('routes RELEASE to initiateRelease() instead of releaseFunds() for a signature-collection escrow — M8-R2: caller-supplied releaseToAddress still has no effect', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })
      mockIsSignatureCollectionType.mockReturnValueOnce(true)

      const [sig7, issuedAt7] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'RELEASE')
      await service.resolveDispute('dispute-1', 'arbiter-1', 'RELEASE', 'bc1qbuyeraddress', undefined, undefined, sig7, issuedAt7)

      expect(mockInitiateRelease).toHaveBeenCalledWith('escrow-1', undefined, 'arbiter-1')
      expect(mockReleaseFunds).not.toHaveBeenCalled()
    })

    it('routes REFUND to initiateRefund() instead of refundFunds() for a signature-collection escrow', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })
      mockIsSignatureCollectionType.mockReturnValueOnce(true)

      const [sig8, issuedAt8] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'REFUND')
      await service.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, undefined, undefined, sig8, issuedAt8)

      // M8-RF (Destination Consistency) — no refundToAddress was supplied
      // here, so it's threaded through as undefined (initiateRefund()
      // itself resolves the seller's own registered PayoutAddress in
      // that case) — never silently dropped.
      expect(mockInitiateRefund).toHaveBeenCalledWith('escrow-1', 'arbiter-1', undefined)
      expect(mockRefundFunds).not.toHaveBeenCalled()
    })

    // Superseded 2026-09-11 (M8-R2, docs/DESTINATION_AUTHORITY_ARCHITECTURE.md).
    // This test previously proved the OPPOSITE property under the name
    // "M8-RF: threads a caller-supplied refundToAddress through to
    // initiateRefund() ... completes a parameter that already existed but
    // was previously dropped" — i.e. that an arbiter-supplied
    // refundToAddress WAS forwarded and governed execution for this
    // legacy (non-MULTISIG) path. That was itself the Model-E vulnerability
    // this later mission closes: Destination Authority belongs to the
    // beneficiary (the seller, for a REFUND), never the arbiter's own
    // request. Kept at the same name/location, corrected rather than
    // deleted, per this repository's own never-silently-rewrite discipline
    // for a test whose prior assertion is now the exact thing being fixed.
    it('M8-R2: an arbiter-supplied refundToAddress has NO effect on initiateRefund() for this legacy (non-MULTISIG) signature-collection path — the seller\'s own registered PayoutAddress governs instead', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED' })
      mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })
      mockIsSignatureCollectionType.mockReturnValueOnce(true)

      const [sig, issuedAt] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'REFUND')
      await service.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, 'legacy-seller-address', undefined, sig, issuedAt)

      expect(mockInitiateRefund).toHaveBeenCalledWith('escrow-1', 'arbiter-1', undefined)
    })
  })
})

// A minimal ArbitrationProvider stub implementing the three RFC-021 D6
// optional methods — stands in for MarketArbitrationProvider (which has
// its own real-math unit tests in marketArbitrationProvider.test.ts) so
// these tests can focus purely on DisputeService's own orchestration:
// does it call assignAppealPanel/slash/recordRuling with the right
// arguments, at the right time, and not at all when it shouldn't.
function marketProviderStub() {
  const mockAssignAppealPanel = jest.fn()
  const mockSlash = jest.fn().mockResolvedValue({})
  const mockRecordRuling = jest.fn().mockResolvedValue(undefined)
  const provider = {
    name: 'market-arbitration',
    arbitrators: [] as string[],
    assign: jest.fn(),
    assignAppealPanel: (...args: unknown[]) => mockAssignAppealPanel(...args),
    slash: (...args: unknown[]) => mockSlash(...args),
    recordRuling: (...args: unknown[]) => mockRecordRuling(...args),
  }
  return { provider, mockAssignAppealPanel, mockSlash, mockRecordRuling }
}

describe('DisputeService — appeal() (RFC-021 D6)', () => {
  const { provider: marketProvider, mockAssignAppealPanel } = marketProviderStub()
  const marketService = new DisputeService(marketProvider as any)

  beforeEach(() => jest.clearAllMocks())

  it('rejects appealing a dispute that is not RESOLVED', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'OPENED' })
    await expect(marketService.appeal('dispute-1', 'buyer-1')).rejects.toThrow(/only a RESOLVED dispute can be appealed/)
  })

  it('rejects an appeal from someone who is not a party to the trade', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', tradeId: 'trade-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    await expect(marketService.appeal('dispute-1', 'stranger')).rejects.toThrow(/not a party/)
  })

  it('surfaces a clear config error under trusted-list mode instead of a crash', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', tradeId: 'trade-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    const trustedService = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))
    await expect(trustedService.appeal('dispute-1', 'buyer-1')).rejects.toThrow(/ARBITRATION_MODE=market/)
  })

  it('reopens the dispute, draws a new arbiter excluding the original, and computes the appeal fee', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', status: 'RESOLVED', tradeId: 'trade-1', escrowId: 'escrow-1',
      arbiterId: 'original-arbiter', ruling: 'RELEASE', appealRound: 0,
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockAssignAppealPanel.mockResolvedValue('new-arbiter')
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: '1.0' })

    const result = await marketService.appeal('dispute-1', 'seller-1')

    expect(mockAssignAppealPanel).toHaveBeenCalledWith('dispute-1', 'trade-1', 1, 'original-arbiter')
    // ADR-005 §3/§10 — the authority-moving write is now a conditional
    // claim (economic-disposition:<disputeId>-locked), guarded on the
    // exact generation this appeal() call read at its own top, not a bare
    // `update()` by id alone.
    expect(mockDisputeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dispute-1', status: 'RESOLVED', appealRound: 0 },
      data: {
        status: 'APPEALED',
        appealRound: 1,
        previousRuling: 'RELEASE',
        previousArbiterId: 'original-arbiter',
        arbiterId: 'new-arbiter',
        ruling: null,
        resolvedAt: null,
      },
    })
    expect(result.appealFeeRequired).toBe('2.00000000') // 1.0 * APPEAL_FEE_MULTIPLIER(2)
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.appealed',
      expect.objectContaining({ disputeId: 'dispute-1', tradeId: 'trade-1', round: 1, newArbiterId: 'new-arbiter' }),
      'trade-1'
    )
    // Real charge (2026-08-01), not just a computed-and-returned number —
    // see dispute.service.ts's own header comment on APPEAL_FEE_MULTIPLIER.
    expect(mockDisputeAppealFeeCreate).toHaveBeenCalledWith({
      data: {
        disputeId: 'dispute-1',
        appealRound: 1,
        requestedBy: 'seller-1',
        amount: '2.00000000',
        asset: 'BTC',
      },
    })
  })
})

// RFC-021 D6 real appeal-fee settlement (2026-08-01) — resolveDispute()'s
// other new behavior alongside the slashing block above, same
// dispute.previousRuling-vs-ruling comparison, different outcome table.
describe('DisputeService — resolveDispute() appeal-fee settlement (RFC-021 D6)', () => {
  const { provider: marketProvider } = marketProviderStub()
  const marketService = new DisputeService(marketProvider as any)

  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: null })
  })

  it('forfeits the appeal fee when the panel upholds the original ruling (denied, frivolous appeal)', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'new-arbiter', status: 'APPEALED',
      previousRuling: 'RELEASE', previousArbiterId: 'original-arbiter', appealRound: 1,
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })

    const [sig9, issuedAt9] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1', appealRound: 1 }, 'new-arbiter', 'RELEASE')
    await marketService.resolveDispute('dispute-1', 'new-arbiter', 'RELEASE', 'bc1qbuyer', undefined, undefined, sig9, issuedAt9)

    expect(mockDisputeAppealFeeUpdateMany).toHaveBeenCalledWith({
      where: { disputeId: 'dispute-1', appealRound: 1, outcome: null },
      data: { outcome: 'FORFEITED', settledAt: expect.any(Date) },
    })
  })

  it('refunds the appeal fee when the panel overturns the original ruling', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'new-arbiter', status: 'APPEALED',
      previousRuling: 'RELEASE', previousArbiterId: 'original-arbiter', appealRound: 1,
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })

    const [sig10, issuedAt10] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1', appealRound: 1 }, 'new-arbiter', 'REFUND')
    await marketService.resolveDispute('dispute-1', 'new-arbiter', 'REFUND', undefined, undefined, undefined, sig10, issuedAt10)

    expect(mockDisputeAppealFeeUpdateMany).toHaveBeenCalledWith({
      where: { disputeId: 'dispute-1', appealRound: 1, outcome: null },
      data: { outcome: 'REFUNDED', settledAt: expect.any(Date) },
    })
  })

  it('does not touch appeal-fee settlement on an ordinary first-instance (non-appeal) resolution', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED',
      previousRuling: null, previousArbiterId: null, appealRound: 0,
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })

    const [sig11, issuedAt11] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1', appealRound: 0 }, 'arbiter-1', 'REFUND')
    await marketService.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, undefined, undefined, sig11, issuedAt11)

    expect(mockDisputeAppealFeeUpdateMany).not.toHaveBeenCalled()
  })
})

describe('DisputeService — resolveDispute() slashing on overturn (RFC-021 D6)', () => {
  const { provider: marketProvider, mockSlash, mockRecordRuling } = marketProviderStub()
  const marketService = new DisputeService(marketProvider as any)

  beforeEach(() => {
    jest.clearAllMocks()
    // RFC-021 D4, Phase 3 default: no fee charged on this escrow — most
    // tests below aren't about feeObserved, so a null default keeps the
    // recordRuling() assertions simple; the one test that IS about the
    // fee dimension overrides this explicitly.
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: null })
  })

  it('slashes the original arbiter when an appeal panel overturns their ruling', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'new-arbiter', status: 'APPEALED',
      previousRuling: 'RELEASE', previousArbiterId: 'original-arbiter',
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })

    const [sig12, issuedAt12] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'new-arbiter', 'REFUND')
    await marketService.resolveDispute('dispute-1', 'new-arbiter', 'REFUND', undefined, undefined, undefined, sig12, issuedAt12)

    expect(mockSlash).toHaveBeenCalledWith('original-arbiter')
    expect(mockRecordRuling).toHaveBeenCalledWith('new-arbiter', undefined)
  })

  it('does NOT slash when the appeal panel upholds the original ruling — a denied, not frivolous-punished, appeal', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'new-arbiter', status: 'APPEALED',
      previousRuling: 'RELEASE', previousArbiterId: 'original-arbiter',
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })

    const [sig13, issuedAt13] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'new-arbiter', 'RELEASE')
    await marketService.resolveDispute('dispute-1', 'new-arbiter', 'RELEASE', 'bc1qbuyer', undefined, undefined, sig13, issuedAt13)

    expect(mockSlash).not.toHaveBeenCalled()
    expect(mockRecordRuling).toHaveBeenCalledWith('new-arbiter', undefined)
  })

  it('does not attempt to slash on an ordinary first-instance (non-appeal) resolution', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED',
      previousRuling: null, previousArbiterId: null,
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })

    const [sig14, issuedAt14] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'REFUND')
    await marketService.resolveDispute('dispute-1', 'arbiter-1', 'REFUND', undefined, undefined, undefined, sig14, issuedAt14)

    expect(mockSlash).not.toHaveBeenCalled()
    expect(mockRecordRuling).toHaveBeenCalledWith('arbiter-1', undefined)
  })

  // RFC-021 D4, Phase 3 — the arbiter-side half of cumulativeFeesObserved.
  it('passes the resolved escrow\'s real feeCharged through to recordRuling()', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', arbiterId: 'arbiter-1', status: 'OPENED',
      previousRuling: null, previousArbiterId: null,
    })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: '0.5' })

    const [sig15, issuedAt15] = signResolution({ id: 'dispute-1', escrowId: 'escrow-1' }, 'arbiter-1', 'RELEASE')
    await marketService.resolveDispute('dispute-1', 'arbiter-1', 'RELEASE', 'bc1qbuyer', undefined, undefined, sig15, issuedAt15)

    expect(mockRecordRuling).toHaveBeenCalledWith('arbiter-1', '0.5')
  })
})

describe('DisputeService — submitEvidence() (RFC-021 D8)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))

  beforeEach(() => jest.clearAllMocks())

  it('appends evidence, transitions OPENED -> EVIDENCE_SUBMITTED, and emits the event finally reachable after this pass', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'OPENED', evidence: [],
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', status: 'EVIDENCE_SUBMITTED' })

    await service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt', note: 'bank confirmation' })

    expect(mockDisputeUpdate).toHaveBeenCalledWith({
      where: { id: 'dispute-1' },
      data: {
        evidence: [expect.objectContaining({ type: 'payment_receipt', note: 'bank confirmation', submittedBy: 'buyer-1' })],
        status: 'EVIDENCE_SUBMITTED',
      },
    })
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.evidence_submitted',
      expect.objectContaining({ disputeId: 'dispute-1', tradeId: 'trade-1', triggeredBy: 'buyer-1' }),
      'trade-1'
    )
  })

  it('appends to existing evidence rather than overwriting it', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'EVIDENCE_SUBMITTED',
      evidence: [{ type: 'chat_log', submittedBy: 'seller-1', submittedAt: '2026-01-01T00:00:00.000Z' }],
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockDisputeUpdate.mockResolvedValue({})

    await service.submitEvidence('dispute-1', 'seller-1', { type: 'payment_receipt' })

    const call = mockDisputeUpdate.mock.calls[0][0]
    expect(call.data.evidence).toHaveLength(2)
    expect(call.data.evidence[0].type).toBe('chat_log')
    expect(call.data.evidence[1].type).toBe('payment_receipt')
  })

  it('rejects a submitter who is not a party to the trade', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'OPENED', evidence: [] })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(service.submitEvidence('dispute-1', 'not-a-party', { type: 'payment_receipt' })).rejects.toThrow('is not a party to trade')
    expect(mockDisputeUpdate).not.toHaveBeenCalled()
  })

  it('rejects new evidence once the dispute has moved past evidence-gathering (RESOLVED/APPEALED/AUTO_PROPOSED)', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'RESOLVED', evidence: [] })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(service.submitEvidence('dispute-1', 'buyer-1', { type: 'payment_receipt' })).rejects.toThrow('cannot accept new evidence')
  })
})

describe('DisputeService — proposeAutoResolution() / contestAutoResolution() (RFC-021 D8)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))

  beforeEach(() => jest.clearAllMocks())

  it('atomically claims an open dispute and moves it to AUTO_PROPOSED with the recommendation attached', async () => {
    mockDisputeFindUnique
      .mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'EVIDENCE_SUBMITTED' })
      .mockResolvedValueOnce({ id: 'dispute-1', status: 'AUTO_PROPOSED' })
    mockDisputeUpdateMany.mockResolvedValue({ count: 1 })

    const result = await service.proposeAutoResolution('dispute-1', 'RELEASE', 0.92, 'clear matching receipt')

    expect(mockDisputeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dispute-1', status: { in: ['OPENED', 'EVIDENCE_SUBMITTED'] }, ruling: null },
      data: expect.objectContaining({
        status: 'AUTO_PROPOSED',
        autoResolutionRecommendation: 'RELEASE',
        autoResolutionConfidence: 0.92,
        autoResolutionReasoning: 'clear matching receipt',
      }),
    })
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.auto_resolution_proposed',
      expect.objectContaining({ disputeId: 'dispute-1', recommendation: 'RELEASE', confidence: 0.92 }),
      'trade-1'
    )
    expect(result).toEqual({ id: 'dispute-1', status: 'AUTO_PROPOSED' })
  })

  it('loses the race cleanly (returns null, no event) when a human arbiter already resolved/appealed the dispute', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'RESOLVED' })
    mockDisputeUpdateMany.mockResolvedValue({ count: 0 })

    const result = await service.proposeAutoResolution('dispute-1', 'REFUND', 0.9, 'r')

    expect(result).toBeNull()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('contestAutoResolution reverts to EVIDENCE_SUBMITTED and clears the auto-resolution fields', async () => {
    const deadline = new Date(Date.now() + 3600_000)
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED',
      autoResolutionDeadline: deadline,
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockDisputeUpdateMany.mockResolvedValue({ count: 1 })
    mockDisputeFindUnique.mockResolvedValueOnce({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED',
      autoResolutionDeadline: deadline,
    }).mockResolvedValueOnce({ id: 'dispute-1', status: 'EVIDENCE_SUBMITTED' })

    await service.contestAutoResolution('dispute-1', 'seller-1')

    expect(mockDisputeUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'dispute-1', status: 'AUTO_PROPOSED' }),
      data: {
        status: 'EVIDENCE_SUBMITTED',
        autoResolutionRecommendation: null,
        autoResolutionConfidence: null,
        autoResolutionReasoning: null,
        autoResolutionDeadline: null,
      },
    })
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.auto_resolution_contested',
      expect.objectContaining({ disputeId: 'dispute-1', contestedBy: 'seller-1' }),
      'trade-1'
    )
  })

  it('rejects a contest from someone who is not a party to the trade', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED', autoResolutionDeadline: new Date(Date.now() + 3600_000) })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(service.contestAutoResolution('dispute-1', 'not-a-party')).rejects.toThrow('is not a party to trade')
  })

  it('rejects a contest once the window has already closed', async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED',
      autoResolutionDeadline: new Date(Date.now() - 1000),
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(service.contestAutoResolution('dispute-1', 'buyer-1')).rejects.toThrow('contest window has already closed')
  })

  it('rejects a contest when there is no pending automated resolution at all', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'EVIDENCE_SUBMITTED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(service.contestAutoResolution('dispute-1', 'buyer-1')).rejects.toThrow('no pending automated resolution')
  })
})

// Missão 13 Fase 2 — QVAC downgraded to advisory-only (mandate's own
// explicit permission: "It is acceptable for Phase 2 to downgrade QVAC to
// ADVISORY until scoped delegation is properly implemented. Correct
// attribution is more important than preserving automation"). An expired,
// uncontested AUTO_PROPOSED recommendation no longer executes settlement
// on its own — dispute.service.ts has no signed authority decision for it
// (nothing signs on QVAC's or the arbiter's behalf), so it can only revert
// the dispute back to EVIDENCE_SUBMITTED and let the real human arbiter
// produce a genuine resolveDispute() call. These tests replace the old
// auto-execute assertions (`resolved`/mockRefundFunds-was-called) with
// this new advisory-only contract (`revertedToHuman`, no settlement call).
describe('DisputeService — sweepExpiredAutoResolutions() (RFC-021 D8, advisory-only per Missão 13 Fase 2)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))

  beforeEach(() => jest.clearAllMocks())

  it('reverts an expired, uncontested AUTO_PROPOSED dispute to EVIDENCE_SUBMITTED without calling any settlement function', async () => {
    mockDisputeFindMany.mockResolvedValue([
      { id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED', arbiterId: 'arbiter-1', autoResolutionRecommendation: 'REFUND' },
    ])
    mockDisputeUpdateMany.mockResolvedValue({ count: 1 })

    const result = await service.sweepExpiredAutoResolutions()

    expect(mockRefundFunds).not.toHaveBeenCalled()
    expect(mockReleaseFunds).not.toHaveBeenCalled()
    expect(mockInitiateRefund).not.toHaveBeenCalled()
    expect(mockInitiateRelease).not.toHaveBeenCalled()
    expect(mockDisputeUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'dispute-1', status: 'AUTO_PROPOSED' }),
      data: { status: 'EVIDENCE_SUBMITTED', autoResolutionDeadline: null },
    })
    expect(mockEmit).toHaveBeenCalledWith(
      'dispute.auto_resolution_contested',
      expect.objectContaining({
        disputeId: 'dispute-1',
        tradeId: 'trade-1',
        contestedBy: 'window-expired-advisory-only',
        triggeredBy: 'window-expired-advisory-only',
      }),
      'trade-1'
    )
    expect(result.revertedToHuman).toEqual(['dispute-1'])
    expect(result.failed).toEqual([])
  })

  it('reverts a RELEASE recommendation identically — the ruling itself is irrelevant once execution is advisory-only, not automated', async () => {
    mockDisputeFindMany.mockResolvedValue([
      { id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED', arbiterId: 'arbiter-1', autoResolutionRecommendation: 'RELEASE' },
    ])
    mockDisputeUpdateMany.mockResolvedValue({ count: 1 })

    const result = await service.sweepExpiredAutoResolutions()

    expect(mockReleaseFunds).not.toHaveBeenCalled()
    expect(result.revertedToHuman).toEqual(['dispute-1'])
    expect(result.failed).toEqual([])
  })

  it('collects failures per-dispute without letting one bad row\'s revert failure stop the rest of the sweep', async () => {
    mockDisputeFindMany.mockResolvedValue([
      { id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED', arbiterId: 'arbiter-1', autoResolutionRecommendation: 'REFUND' },
      { id: 'dispute-2', tradeId: 'trade-2', escrowId: 'escrow-2', status: 'AUTO_PROPOSED', arbiterId: 'arbiter-1', autoResolutionRecommendation: 'REFUND' },
    ])
    mockDisputeUpdateMany
      .mockRejectedValueOnce(new Error('row-1 update failed'))
      .mockResolvedValueOnce({ count: 1 })

    const result = await service.sweepExpiredAutoResolutions()

    expect(result.failed).toEqual([{ disputeId: 'dispute-1', error: expect.stringContaining('row-1 update failed') }])
    expect(result.revertedToHuman).toEqual(['dispute-2'])
  })
  it('#308 emits no event when a stale sweeper loses the AUTO_PROPOSED CAS claim', async () => {
    const deadline = new Date(Date.now() - 1000)
    mockDisputeFindMany.mockResolvedValue([
      { id: 'dispute-1', tradeId: 'trade-1', escrowId: 'escrow-1', status: 'AUTO_PROPOSED', autoResolutionDeadline: deadline },
    ])
    mockDisputeUpdateMany.mockResolvedValue({ count: 0 })

    const result = await service.sweepExpiredAutoResolutions()

    expect(result).toEqual({ revertedToHuman: [], failed: [] })
    expect(mockEmit).not.toHaveBeenCalled()
  })

})

// UI-audit gap (2026-08-03, sails-ui SLC audit relayed via the parallel UI
// session) — every dispute action above was real and callable, but the
// operator/arbiter console had no way to discover a disputeId to call
// them with. getDispute()/listForArbiter() are the fetch this closes.
describe('DisputeService — getDispute() / listForArbiter() (UI-audit gap, 2026-08-03)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider(['arbiter-1']))

  beforeEach(() => jest.clearAllMocks())

  it('getDispute returns the real dispute row for a valid id', async () => {
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', arbiterId: 'arbiter-1', status: 'OPENED' })
    const dispute = await service.getDispute('dispute-1')
    expect(dispute).toEqual({ id: 'dispute-1', arbiterId: 'arbiter-1', status: 'OPENED' })
  })

  it('getDispute throws NotFoundError for an unknown id', async () => {
    mockDisputeFindUnique.mockResolvedValue(null)
    await expect(service.getDispute('nope')).rejects.toThrow(/Dispute/)
  })

  it('listForArbiter scopes the query to the given arbiterId — never a client-supplied filter', async () => {
    mockDisputeFindMany.mockResolvedValue([{ id: 'dispute-1', arbiterId: 'arbiter-1' }])
    mockDisputeCount.mockResolvedValue(1)

    const result = await service.listForArbiter('arbiter-1')

    expect(mockDisputeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { arbiterId: 'arbiter-1' } })
    )
    expect(mockDisputeCount).toHaveBeenCalledWith(expect.objectContaining({ where: { arbiterId: 'arbiter-1' } }))
    expect(result).toEqual({ disputes: [{ id: 'dispute-1', arbiterId: 'arbiter-1' }], total: 1, hasMore: false })
  })

  it('clamps pagination the same way trade.service.ts\'s getTrades() does (limit 1-50, default 10)', async () => {
    mockDisputeFindMany.mockResolvedValue([])
    mockDisputeCount.mockResolvedValue(0)

    await service.listForArbiter('arbiter-1', { limit: 500, offset: -5 })

    expect(mockDisputeFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0 }))
  })

  it('hasMore is true when more rows exist beyond this page', async () => {
    mockDisputeFindMany.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }])
    mockDisputeCount.mockResolvedValue(5)

    const result = await service.listForArbiter('arbiter-1', { limit: 2, offset: 0 })

    expect(result.hasMore).toBe(true)
  })
})
