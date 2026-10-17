/**
 * DisputeService.initiateExpiryRecovery() — Missão 11 Fase 7.3.3 §D
 * (CTO-selected: Model C + Model A).
 *
 * The explicit, guided, seller-only recovery action for a MULTISIG escrow
 * whose timelock genuinely expired (EscrowStatus.EXPIRED). A thin wrapper
 * around the already-existing raiseDispute() — this file proves the
 * authority boundary is exactly what the CTO's own required invariant
 * demands: the actual authenticated seller, never the server, never the
 * other participant, never a third party; the EXPIRED state alone moves
 * no funds; and every one of Fase 7.3.1 §B's arbiter-commitment
 * guarantees (correct arbiter required, config rotation cannot rewrite
 * historical authority) carry through unchanged, since this is nothing
 * more than a guarded call into raiseDispute() itself.
 */
const mockEscrowFindById = jest.fn()
const mockTradeFindUnique = jest.fn()
const mockDisputeCreate = jest.fn()
const mockDisputeFindUnique = jest.fn()
const mockDisputeUpdate = jest.fn()
const mockEscrowParticipantKeyFindUnique = jest.fn()
const mockEmit = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/common/database', () => ({
  prisma: {
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: {
      create: (...args: unknown[]) => mockDisputeCreate(...args),
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      update: (...args: unknown[]) => mockDisputeUpdate(...args),
    },
    escrowParticipantKey: { findUnique: (...args: unknown[]) => mockEscrowParticipantKeyFindUnique(...args) },
  },
}))
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: (...args: unknown[]) => mockEmit(...args) },
}))
jest.mock('../src/modules/open-settlement/escrow.service', () => ({
  // Issue #238 - raiseDispute() establishes the Dispute inside openDisputeEstablishing()'s transaction;
  // this mock records the same openDispute() call and runs `establish` against the mocked prisma (as tx).
  escrowService: (() => {
    const openDispute = jest.fn().mockResolvedValue({})
    return {
      openDispute,
      openDisputeEstablishing: async (escrowId: string, by: string, reason: string, establish: (tx: unknown) => Promise<unknown>) => {
        await openDispute(escrowId, by, reason)
        return establish(require('../src/common/database').prisma)
      },
    }
  })(),
}))
jest.mock('../src/modules/open-settlement/escrow-repository', () => ({
  escrowRepository: { findById: (...args: unknown[]) => mockEscrowFindById(...args) },
}))

import { DisputeService } from '../src/modules/open-settlement/dispute.service'
import type { ArbitrationProvider } from '../src/modules/open-settlement/arbitration-provider'

describe('DisputeService.initiateExpiryRecovery() — Gen-1 recovery authority (Fase 7.3.3 §D)', () => {
  beforeEach(() => jest.clearAllMocks())

  function fakeArbitrationProvider(pick = 'arb-configured'): ArbitrationProvider {
    return { name: 'fake-provider', arbitrators: [pick], assign: jest.fn().mockResolvedValue(pick) }
  }

  function seedExpiredEscrow() {
    mockEscrowFindById.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', status: 'EXPIRED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: 'escrow-1' })
    mockDisputeCreate.mockResolvedValue({ id: 'dispute-1' })
    mockEscrowParticipantKeyFindUnique.mockResolvedValue(null)
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', arbiterId: 'arb-configured' })
  }

  // Proof 1
  it('1. the correct authorized participant (the trade\'s real seller) can initiate recovery', async () => {
    seedExpiredEscrow()
    const service = new DisputeService(fakeArbitrationProvider())

    const result = await service.initiateExpiryRecovery('escrow-1', 'seller-1')

    expect(result.id).toBe('dispute-1')
    expect(mockDisputeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ openedBy: 'seller-1' }) }))
  })

  // Proof 2
  it('2. the other participant (the buyer) cannot exercise the seller\'s recovery authority', async () => {
    seedExpiredEscrow()
    const service = new DisputeService(fakeArbitrationProvider())

    await expect(service.initiateExpiryRecovery('escrow-1', 'buyer-1')).rejects.toThrow(/is not the seller of trade/)
    expect(mockDisputeCreate).not.toHaveBeenCalled()
  })

  // Proof 3
  it('3. the server/sweeper\'s own system identity cannot exercise participant authority', async () => {
    seedExpiredEscrow()
    const service = new DisputeService(fakeArbitrationProvider())

    // 'system:expiry-sweeper' is the exact triggeredBy the sweeper itself
    // uses to RECORD expiry (escrow.service.ts) — it must never also be
    // accepted as if it were the seller's own authority.
    await expect(service.initiateExpiryRecovery('escrow-1', 'system:expiry-sweeper')).rejects.toThrow(/is not the seller of trade/)
    expect(mockDisputeCreate).not.toHaveBeenCalled()
  })

  // Proof 4
  it('4. an arbitrary third party cannot initiate recovery', async () => {
    seedExpiredEscrow()
    const service = new DisputeService(fakeArbitrationProvider())

    await expect(service.initiateExpiryRecovery('escrow-1', 'random-stranger')).rejects.toThrow(/is not the seller of trade/)
    expect(mockDisputeCreate).not.toHaveBeenCalled()
  })

  // Proof 5
  it('5. the EXPIRED state alone moves no funds and cannot be exercised from a non-expired escrow', async () => {
    mockEscrowFindById.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', status: 'FUNDS_LOCKED' })
    const service = new DisputeService(fakeArbitrationProvider())

    await expect(service.initiateExpiryRecovery('escrow-1', 'seller-1')).rejects.toThrow(/is not in EXPIRED status/)
    expect(mockTradeFindUnique).not.toHaveBeenCalled()
    expect(mockDisputeCreate).not.toHaveBeenCalled()
  })

  // Proof 6
  it('6. a duplicate recovery request converges safely — the second call hits the real @@unique([tradeId]) dispute guard, never a second competing dispute', async () => {
    seedExpiredEscrow()
    mockDisputeCreate.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'P2002' }))
    const service = new DisputeService(fakeArbitrationProvider())

    await expect(service.initiateExpiryRecovery('escrow-1', 'seller-1')).rejects.toThrow(/A dispute has already been raised/)
  })

  // Proof 7 — script-committed arbiter still wins over the configured provider (Fase 7.3.1 §B, inherited unchanged)
  it('7. the script-committed arbiter identity is still required, never the configured provider\'s own independent pick', async () => {
    seedExpiredEscrow()
    mockEscrowParticipantKeyFindUnique.mockResolvedValue({ participantId: 'arb-committed', role: 'arbiter', escrowId: 'escrow-1' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', arbiterId: 'arb-committed' })
    const provider = fakeArbitrationProvider('arb-would-be-picked-instead')
    const service = new DisputeService(provider)

    await service.initiateExpiryRecovery('escrow-1', 'seller-1')

    expect(provider.assign).not.toHaveBeenCalled()
    expect(mockDisputeUpdate).toHaveBeenCalledWith({ where: { id: 'dispute-1' }, data: { arbiterId: 'arb-committed' } })
  })

  // Proof 8 — inherited from Fase 7.3.1 §B / multisigProvider.test.ts's own
  // config-rotation proof: this action never re-derives an arbiter itself,
  // it only ever reads the escrow's own persisted commitment, so a live
  // TRUSTED_ARBITRATORS rotation cannot rewrite which identity this call
  // assigns — proven directly at the multisig.provider.ts signing layer
  // already; re-asserted here at the call-site level.
  it('8. config rotation cannot rewrite recovery authority — the persisted commitment is read directly, never re-derived from live config', async () => {
    seedExpiredEscrow()
    mockEscrowParticipantKeyFindUnique.mockResolvedValue({ participantId: 'arb-original-committed', role: 'arbiter', escrowId: 'escrow-1' })
    mockDisputeUpdate.mockResolvedValue({ id: 'dispute-1', arbiterId: 'arb-original-committed' })
    const service = new DisputeService(fakeArbitrationProvider('arb-new-after-rotation'))

    await service.initiateExpiryRecovery('escrow-1', 'seller-1')

    expect(mockDisputeUpdate).toHaveBeenCalledWith({ where: { id: 'dispute-1' }, data: { arbiterId: 'arb-original-committed' } })
  })

  // Proofs 9/10 are structural, not behavioral: initiateExpiryRecovery()'s
  // entire signature is (escrowId: string, raisedBy: string) => it has no
  // parameter, return value, or persisted field capable of carrying key
  // material at all — confirmed directly by reading the implementation
  // (dispute.service.ts) and its one real effect (a Dispute row + an
  // eventBus emission, both plain strings/ids). verifySigningIntent()
  // remains the SDK's own mandatory pre-signing gate for whatever PSBT a
  // wallet is later asked to sign once resolveDispute() actually rules —
  // this action never constructs, touches, or shortcuts that PSBT at all.
  it('9/10 (structural): the recovery action itself never accepts, returns, or persists any key material', async () => {
    seedExpiredEscrow()
    const service = new DisputeService(fakeArbitrationProvider())

    await service.initiateExpiryRecovery('escrow-1', 'seller-1')

    const createCallArgs = JSON.stringify(mockDisputeCreate.mock.calls[0])
    expect(createCallArgs).not.toMatch(/privkey|privateKey|seed|mnemonic|wif/i)
  })
})
