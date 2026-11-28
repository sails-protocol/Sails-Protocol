// tests/escrowFeeSnapshotService.test.ts
//
// Missão 11 Fase 4.1 §1/§5 — unit-level proof of computeSnapshotFields()'s
// pre-funding waiver decision, against a fake FeePolicyVersionRepository
// (no real database) and real config mutation (evaluateFeeCollectibility()
// in multisig.provider.ts reads config.settlement.protocolFeeCollectionAddress
// directly — the same pattern already used by tests/multisigFeeConservation.test.ts
// for the provider itself, just at the config layer instead of an env
// reload, since this service never touches bitcoinjs-lib directly).

import { Prisma } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import { config } from '../src/config'
import { EscrowFeeSnapshotService } from '../src/modules/open-settlement/escrow-fee-snapshot.service'
import { FeePolicyService } from '../src/modules/open-settlement/fee-policy.service'
import type { FeePolicyVersionRepository } from '../src/modules/open-settlement/fee-policy-repository'
import { dustThresholdSats } from '../src/modules/open-settlement/bitcoin-dust-policy'

const ORIGINAL_COLLECTION_ADDRESS = config.settlement.protocolFeeCollectionAddress

// Real testnet P2WPKH addresses — dust threshold ~294 sats, same fixture
// convention tests/multisigFeeConservation.test.ts already uses.
const COLLECTIBLE_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const DUST_THRESHOLD = Number(dustThresholdSats(Buffer.from(bitcoin.address.toOutputScript(COLLECTIBLE_ADDRESS, bitcoin.networks.testnet))))

/** rate string such that T_sats * rate === targetFeeSats exactly, for the
 *  fixed T=100,000 sats the boundary tests below use. */
function rateForExactFmax(targetFeeSats: number): string {
  return (targetFeeSats / 100_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0')
}

afterEach(() => {
  config.settlement.protocolFeeCollectionAddress = ORIGINAL_COLLECTION_ADDRESS
})

function fakePolicyRepo(policy: any): FeePolicyVersionRepository {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findPublishedForRail: jest.fn().mockResolvedValue(policy ? [policy] : []),
    publish: jest.fn(),
    retire: jest.fn(),
  } as unknown as FeePolicyVersionRepository
}

function fixturePolicy(overrides: Record<string, any> = {}) {
  return {
    id: 'policy-1',
    railScope: 'MULTISIG',
    status: 'PUBLISHED',
    protocolFeeRate: '0.004',
    payerModel: 'SELLER_PAYS',
    economicBasis: 'SELLER_DELIVERED_VALUE',
    ...overrides,
  }
}

describe('EscrowFeeSnapshotService.computeSnapshotFields() — Fase 4.1 pre-funding waiver', () => {
  it('returns null when no PUBLISHED policy exists for the rail (legacy, unchanged)', async () => {
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(null)))
    const result = await service.computeSnapshotFields('MULTISIG', '0.001')
    expect(result).toBeNull()
  })

  it('a genuine zero-rate policy: waivedPreFunding stays FALSE (never inferred from Fmax=0)', async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const policy = fixturePolicy({ protocolFeeRate: '0' })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.001')
    expect(result).not.toBeNull()
    expect(result!.snapshotProtocolFeeRate.toString()).toBe('0')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(false)
    expect(result!.snapshotFeeCollectionAddress).toBeNull()
  })

  it('nonzero rate, MULTISIG, address configured and Fmax clears dust: collectible, address frozen', async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    // T=1,000,000 sats (0.01 BTC), rate=0.004 -> Fmax=4,000 sats, well above dust.
    const policy = fixturePolicy({ protocolFeeRate: '0.004' })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.01')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(false)
    expect(result!.snapshotFeeCollectionAddress).toBe(COLLECTIBLE_ADDRESS)
  })

  it('nonzero rate, MULTISIG, NO collection address configured: pre-funding waived (Fmax=0, R=T)', async () => {
    config.settlement.protocolFeeCollectionAddress = undefined
    const policy = fixturePolicy({ protocolFeeRate: '0.004' })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.01')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(true)
    expect(result!.snapshotFeeCollectionAddress).toBeNull()
    // The REAL rate is still recorded, undisturbed — this is what lets
    // accounting distinguish this case from a genuine zero-rate policy.
    expect(result!.snapshotProtocolFeeRate.toString()).toBe('0.004')
  })

  it('nonzero rate, MULTISIG, address configured but candidate Fmax is sub-dust: pre-funding waived', async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    // T=1000 sats (0.00001 BTC), rate=0.005 (the protocol ceiling) -> Fmax=5 sats, below any real dust threshold.
    const policy = fixturePolicy({ protocolFeeRate: '0.005' })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.00001')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(true)
    expect(result!.snapshotFeeCollectionAddress).toBeNull()
  })

  // Fase 4.1 §10 — exact boundary tests around the pre-funding waiver
  // threshold itself, T fixed at 100,000 sats (comfortably non-dust on
  // its own), Fmax engineered via rate exactly as
  // tests/multisigFeeConservation.test.ts's own boundary matrix does.
  it(`pre-funding boundary - 1 (Fmax=${DUST_THRESHOLD - 1}): waived`, async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const target = DUST_THRESHOLD - 1
    const policy = fixturePolicy({ protocolFeeRate: rateForExactFmax(target) })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.001')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(true)
    expect(result!.snapshotFeeCollectionAddress).toBeNull()
  })

  it(`pre-funding boundary exactly (Fmax=${DUST_THRESHOLD}): collectible (IsDust() is strict less-than)`, async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const target = DUST_THRESHOLD
    const policy = fixturePolicy({ protocolFeeRate: rateForExactFmax(target) })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.001')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(false)
    expect(result!.snapshotFeeCollectionAddress).toBe(COLLECTIBLE_ADDRESS)
  })

  it(`pre-funding boundary + 1 (Fmax=${DUST_THRESHOLD + 1}): collectible`, async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const target = DUST_THRESHOLD + 1
    const policy = fixturePolicy({ protocolFeeRate: rateForExactFmax(target) })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('MULTISIG', '0.001')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(false)
    expect(result!.snapshotFeeCollectionAddress).toBe(COLLECTIBLE_ADDRESS)
  })

  // Missão 11 Fase 5 §10 (Fase 4.2 Activation Blocker B, closed): a
  // PUBLISHED policy for a real rail with no fee-aware construction must
  // never be snapshotted onto an escrow at all — this is a defense-in-depth
  // backstop behind fee-policy.service.ts's own publish()-time gate, so it
  // fails loudly here too if that gate is ever somehow bypassed (a raw-SQL
  // insert, never a real application path). Superseded from Fase 4.1's own
  // "never pre-funding-waived, no address evaluated" expectation, which
  // predates this gate.
  it('a real rail with no fee-collection capability (LIGHTNING_HODL) is refused, never silently snapshotted', async () => {
    config.settlement.protocolFeeCollectionAddress = undefined
    const policy = fixturePolicy({ railScope: 'LIGHTNING_HODL', protocolFeeRate: '0.004' })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    await expect(service.computeSnapshotFields('LIGHTNING_HODL', '0.01')).rejects.toThrow(
      /Fee policy activation is not supported for rail 'LIGHTNING_HODL'/
    )
  })

  it('a fixture-only railScope (not a real EscrowType) is never gated by rail-activation', async () => {
    config.settlement.protocolFeeCollectionAddress = undefined
    const policy = fixturePolicy({ railScope: 'FIXTURE_RAIL_UNRELATED', protocolFeeRate: '0.004' })
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(policy)))

    const result = await service.computeSnapshotFields('FIXTURE_RAIL_UNRELATED', '0.01')
    expect(result!.snapshotFeeCollectionWaivedPreFunding).toBe(false)
    expect(result!.snapshotFeeCollectionAddress).toBeNull()
  })

  it('is pure/idempotent: calling it twice with the same inputs returns identical fields (no hidden state, no double-effect)', async () => {
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const policy = fixturePolicy({ protocolFeeRate: '0.004' })
    const repo = fakePolicyRepo(policy)
    const service = new EscrowFeeSnapshotService(new FeePolicyService(repo))

    const first = await service.computeSnapshotFields('MULTISIG', '0.01')
    const second = await service.computeSnapshotFields('MULTISIG', '0.01')
    expect(second).toEqual(first)
  })

  it('propagates (fail-closed) when the underlying policy lookup itself throws', async () => {
    const failingRepo: FeePolicyVersionRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findPublishedForRail: jest.fn().mockRejectedValue(new Error('simulated DB outage')),
      publish: jest.fn(),
      retire: jest.fn(),
    } as unknown as FeePolicyVersionRepository
    const service = new EscrowFeeSnapshotService(new FeePolicyService(failingRepo))

    await expect(service.computeSnapshotFields('MULTISIG', '0.01')).rejects.toThrow('simulated DB outage')
  })
})

describe('EscrowFeeSnapshotService.snapshotEscrowFeePolicy() — update-based path, unchanged for isolated/DB-immutability testing', () => {
  it('returns null and performs no write when no PUBLISHED policy exists', async () => {
    const service = new EscrowFeeSnapshotService(new FeePolicyService(fakePolicyRepo(null)))
    const result = await service.snapshotEscrowFeePolicy('escrow-1', 'MULTISIG', '0.01')
    expect(result).toBeNull()
  })
})
