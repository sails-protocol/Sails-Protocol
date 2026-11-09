/**
 * DisputeService — arbiter/script commitment consistency at ASSIGNMENT
 * time (Missão 11 Fase 7.3.1 §B).
 *
 * Phase 7.3's audit found a real P0: for a MULTISIG escrow, the arbiter
 * identity baked into the P2WSH script at creation time
 * (EscrowParticipantKey{role:'arbiter'}) can diverge from whichever
 * arbiter raiseDispute()/appeal() independently assign via the configured
 * ArbitrationProvider (round-robin over a multi-entry TRUSTED_ARBITRATORS
 * list, or market mode's weighted-random draw) — no signature from any
 * identity other than the one committed into the script can ever validate
 * (multisig.provider.ts's assertArbiterMatchesScript()), so a mismatched
 * assignment leaves a dispute permanently stuck (ruling reverted).
 *
 * The fix (dispute.service.ts): a script-committed arbiter identity always
 * wins over the configured ArbitrationProvider's own pick. This file
 * proves that directly against DisputeService, with a fully mocked
 * ArbitrationProvider so a "wrong" assignment is trivially observable.
 * tests/multisigProvider.test.ts separately proves the same invariant at
 * the cryptographic-verification layer (assertArbiterMatchesScript()).
 */
const mockTradeFindUnique = jest.fn()
const mockDisputeCreate = jest.fn()
const mockDisputeFindUnique = jest.fn()
const mockDisputeUpdateMany = jest.fn()
const mockEscrowParticipantKeyFindUnique = jest.fn()
const mockEmit = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/common/database', () => ({
  prisma: {
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: {
      create: (...args: unknown[]) => mockDisputeCreate(...args),
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      updateMany: (...args: unknown[]) => mockDisputeUpdateMany(...args),
    },
    escrowParticipantKey: { findUnique: (...args: unknown[]) => mockEscrowParticipantKeyFindUnique(...args) },
  },
}))
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))
// Issue #238 - openDispute() runs the Dispute insert inside its own transaction; the mocked prisma stands in for it.
jest.mock('../src/modules/open-settlement/escrow.service', () => ({
  escrowService: {
    openDispute: jest.fn((_e: string, _b: string, _r: string, recordDispute: (tx: unknown) => Promise<unknown>) =>
      recordDispute(require('../src/common/database').prisma)),
  },
}))

// The arbiter each raiseDispute() ended up persisting: written with the Dispute row (committed) or by the conditional assignment.
const persistedArbiters = () => [
  ...mockDisputeCreate.mock.calls.map((call: any) => call[0].data.arbiterId).filter(Boolean),
  ...mockDisputeUpdateMany.mock.calls.map((call: any) => call[0].data.arbiterId),
]

import { DisputeService } from '../src/modules/open-settlement/dispute.service'
import type { ArbitrationProvider } from '../src/modules/open-settlement/arbitration-provider'

describe('DisputeService — script-committed arbiter always wins over ArbitrationProvider.assign() (Fase 7.3.1 §B)', () => {
  beforeEach(() => jest.clearAllMocks())

  function fakeArbitrationProvider(pick: string): ArbitrationProvider {
    return {
      name: 'fake-provider',
      arbitrators: [pick],
      assign: jest.fn().mockResolvedValue(pick),
    }
  }

  // Proof: "correct assigned arbiter succeeds" — no script commitment
  // exists (e.g. a MOCK/WDK_USDT_EVM escrow), so the configured
  // provider's own pick is used unchanged — this fix must not alter
  // behavior for escrow types with no script commitment at all.
  it('falls back to ArbitrationProvider.assign() when the escrow has no script-committed arbiter', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })
    mockDisputeCreate.mockImplementation(async ({ data }: any) => ({ id: 'dispute-1', ...data }))
    mockEscrowParticipantKeyFindUnique.mockResolvedValue(null) // no commitment
    mockDisputeUpdateMany.mockResolvedValue({ count: 1 })
    mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', arbiterId: 'arb-configured' })
    const provider = fakeArbitrationProvider('arb-configured')

    const service = new DisputeService(provider)
    await service.raiseDispute('trade-1', 'buyer-1', 'reason')

    expect(provider.assign).toHaveBeenCalledWith('dispute-1', 'trade-1')
    expect(mockDisputeCreate.mock.calls[0][0].data.arbiterId).toBeNull()
    expect(mockDisputeUpdateMany).toHaveBeenCalledWith({ where: { id: 'dispute-1', arbiterId: null, appealRound: 0 }, data: { arbiterId: 'arb-configured' } })
  })

  // Proof: "different authorized-but-uncommitted arbiter cannot produce a
  // stuck state" — the configured provider WOULD pick a different
  // identity than the one baked into the script; the fix must never let
  // that pick win.
  it('uses the script-committed arbiter and never calls assign() at all when a commitment exists', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })
    mockDisputeCreate.mockImplementation(async ({ data }: any) => ({ id: 'dispute-1', ...data }))
    mockEscrowParticipantKeyFindUnique.mockResolvedValue({ participantId: 'arb-committed', role: 'arbiter', escrowId: 'escrow-1' })
    // A provider that would pick a DIFFERENT identity than the commitment
    // — proves the commitment wins, not merely that assign() happens to
    // agree with it.
    const provider = fakeArbitrationProvider('arb-would-be-picked-instead')

    const service = new DisputeService(provider)
    const dispute = await service.raiseDispute('trade-1', 'buyer-1', 'reason')

    expect(provider.assign).not.toHaveBeenCalled()
    // Issue #238 - written with the Dispute row itself, in the opening transaction: never an unassigned window.
    expect(mockDisputeCreate.mock.calls[0][0].data.arbiterId).toBe('arb-committed')
    expect(mockDisputeUpdateMany).not.toHaveBeenCalled()
    expect(dispute.arbiterId).toBe('arb-committed')
  })

  // Proof: "multi-arbiter configuration cannot create an unexecutable
  // ruling" — even a real, round-robin-eligible TrustedArbitratorProvider
  // with multiple entries never gets consulted once a commitment exists,
  // so a second/third TRUSTED_ARBITRATORS entry can never be assigned to
  // a MULTISIG dispute.
  it('a real multi-entry TrustedArbitratorProvider never overrides a script commitment, across repeated calls', async () => {
    const { TrustedArbitratorProvider } = require('../src/modules/open-settlement/arbitration-provider')
    const roundRobinProvider = new TrustedArbitratorProvider(['arb-1', 'arb-2', 'arb-3'])
    mockEscrowParticipantKeyFindUnique.mockResolvedValue({ participantId: 'arb-1', role: 'arbiter', escrowId: 'escrow-1' })
    mockDisputeCreate.mockImplementation(async ({ data }: any) => ({ id: 'dispute-x', ...data }))
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })

    const service = new DisputeService(roundRobinProvider)
    await service.raiseDispute('trade-1', 'buyer-1', 'reason-1')
    await service.raiseDispute('trade-1', 'buyer-1', 'reason-2')

    // Round-robin would normally advance to arb-2 on the second call —
    // both calls must still resolve to the SAME committed identity.
    expect(persistedArbiters()).toEqual(['arb-1', 'arb-1'])
  })

  describe('appeal() — a script-committed identity can never be reassigned', () => {
    // Proof: "appeal/reassignment semantics remain historically coherent"
    // — appealing a MULTISIG dispute is refused outright (no other
    // identity could ever sign this script), regardless of arbitration
    // mode, rather than drawing a new panel that could never execute.
    it('refuses to appeal a dispute whose escrow has a script-committed arbiter, even under market mode', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', tradeId: 'trade-1', escrowId: 'escrow-1', appealRound: 0, arbiterId: 'arb-committed' })
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      mockEscrowParticipantKeyFindUnique.mockResolvedValue({ participantId: 'arb-committed', role: 'arbiter', escrowId: 'escrow-1' })
      const provider: ArbitrationProvider = {
        name: 'market-arbitration',
        arbitrators: [],
        assign: jest.fn(),
        assignAppealPanel: jest.fn().mockResolvedValue('arb-new'),
      }

      const service = new DisputeService(provider)
      await expect(service.appeal('dispute-1', 'buyer-1')).rejects.toThrow(
        'cannot reassign arbitration authority to a different identity'
      )
      expect(provider.assignAppealPanel).not.toHaveBeenCalled()
    })

    it('still requires ARBITRATION_MODE=market for a dispute with no script commitment — unchanged pre-existing behavior', async () => {
      mockDisputeFindUnique.mockResolvedValue({ id: 'dispute-1', status: 'RESOLVED', tradeId: 'trade-1', escrowId: 'escrow-1', appealRound: 0, arbiterId: 'arb-1' })
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      mockEscrowParticipantKeyFindUnique.mockResolvedValue(null)
      const { TrustedArbitratorProvider } = require('../src/modules/open-settlement/arbitration-provider')
      const service = new DisputeService(new TrustedArbitratorProvider(['arb-1']))

      await expect(service.appeal('dispute-1', 'buyer-1')).rejects.toThrow('Appeals require ARBITRATION_MODE=market')
    })
  })
})
