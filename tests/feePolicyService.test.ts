/**
 * fee-policy.service.ts — Missão 11 Fase 2.2 economic accounting
 * foundation. Structural validation only (rate/percentage bounds, 100%
 * sum, PUBLISHED-only snapshotting) — no real economic parameter is chosen
 * anywhere in this file; every value below is an explicitly-labeled
 * fixture. Fake-repo DI, same pattern as tests/capabilityRegistry.test.ts
 * (no `jest.mock('../src/common/database', ...)` needed).
 */
import { Prisma } from '@prisma/client'
import { FeePolicyService } from '../src/modules/open-settlement/fee-policy.service'
import type { FeePolicyVersionRepository } from '../src/modules/open-settlement/fee-policy-repository'

function fixtureDraft(overrides: Record<string, any> = {}) {
  return {
    id: 'policy-fixture-1',
    label: 'fixture-v1',
    railScope: 'FIXTURE_RAIL',
    status: 'DRAFT',
    protocolFeeRate: '0.004',
    payerModel: 'SELLER_PAYS',
    economicBasis: 'SELLER_DELIVERED_VALUE',
    nodeOperatorPct: '30',
    treasuryPct: '25',
    walletRebatePct: '35',
    arbitratorReservePct: '10',
    requiredConfirmations: 2, // fixture value (Missão 11 Fase 5 §3) — never a chosen production number
    smallTradeRule: {},
    triggerSemantics: {},
    createdBy: 'test-fixture',
    createdAt: new Date(),
    publishedAt: null,
    retiredAt: null,
    ...overrides,
  }
}

function fakeRepo(overrides: Partial<jest.Mocked<FeePolicyVersionRepository>> = {}): jest.Mocked<FeePolicyVersionRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn().mockResolvedValue(null),
    findPublishedForRail: jest.fn().mockResolvedValue([]),
    publish: jest.fn(),
    retire: jest.fn(),
    ...overrides,
  }
}

describe('FeePolicyService.publish — structural validation (G/H/F)', () => {
  // Test H: negative rate rejected
  it('rejects a negative protocolFeeRate', async () => {
    const draft = fixtureDraft({ protocolFeeRate: '-0.01' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/protocolFeeRate must be >= 0/)
    expect(repo.publish).not.toHaveBeenCalled()
  })

  // Missão 11 Fase 7.2 (CTO Decision, §I) — Tests G and F (bucket-percentage
  // negativity/sum-to-100 rejection) used to live here. Removed, not
  // converted: those four columns (nodeOperatorPct/treasuryPct/
  // walletRebatePct/arbitratorReservePct) are remnants of the retired
  // Mechanism 2 distribution architecture (Fase 6.5.2) and are no longer
  // normative inputs for fee-policy publication — DistributionPolicyVersion
  // alone determines revenue allocation now. publish() no longer validates
  // them at all. The replacement tests below prove the new behavior
  // (publication succeeds without them, and their historical presence on
  // an existing draft is simply ignored) rather than testing a removed
  // validation path.
  it('publishes a draft with no legacy distribution-bucket percentages set at all — they are no longer normative inputs (Fase 7.2)', async () => {
    const draft = fixtureDraft({ nodeOperatorPct: null, treasuryPct: null, walletRebatePct: null, arbitratorReservePct: null })
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue(draft),
      publish: jest.fn().mockResolvedValue({ ...draft, status: 'PUBLISHED', publishedAt: new Date() }),
    })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).resolves.toMatchObject({ status: 'PUBLISHED' })
    expect(repo.publish).toHaveBeenCalledWith(draft.id)
  })

  it('publishes a draft even when the (now-vestigial) legacy bucket percentages present on it are negative or do not sum to 100 — no longer validated', async () => {
    const draft = fixtureDraft({ nodeOperatorPct: '-999', treasuryPct: '1', walletRebatePct: '1', arbitratorReservePct: '1' })
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue(draft),
      publish: jest.fn().mockResolvedValue({ ...draft, status: 'PUBLISHED', publishedAt: new Date() }),
    })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).resolves.toMatchObject({ status: 'PUBLISHED' })
  })

  it('accepts a structurally valid draft (fixture values, not a real economic decision) and publishes it', async () => {
    const draft = fixtureDraft() // 30+25+35+10 = 100, rate >= 0
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue(draft),
      publish: jest.fn().mockResolvedValue({ ...draft, status: 'PUBLISHED', publishedAt: new Date() }),
    })
    const service = new FeePolicyService(repo)

    const published = await service.publish(draft.id)
    expect(repo.publish).toHaveBeenCalledWith(draft.id)
    expect(published.status).toBe('PUBLISHED')
  })

  it('rejects publishing a policy that is not currently DRAFT', async () => {
    const already = fixtureDraft({ status: 'PUBLISHED' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(already) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(already.id)).rejects.toThrow(/only a DRAFT policy may be published/)
    expect(repo.publish).not.toHaveBeenCalled()
  })

  // Missão 11 Fase 5 §3 — structural validation only: publish() refuses to
  // activate a policy with no confirmation-depth rule set, never picks one.
  it('rejects a missing requiredConfirmations', async () => {
    const draft = fixtureDraft({ requiredConfirmations: null })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/requiredConfirmations must be a positive integer/)
    expect(repo.publish).not.toHaveBeenCalled()
  })

  it('rejects a zero or negative requiredConfirmations', async () => {
    const draft = fixtureDraft({ requiredConfirmations: 0 })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/requiredConfirmations must be a positive integer/)
    expect(repo.publish).not.toHaveBeenCalled()
  })

  // Missão 11 Fase 5 §10 / Fase 4.2 Activation Blocker B — rail-activation
  // gating: a rail with no real fee-aware construction can never publish.
  it('rejects publishing a policy for a real rail with no fee-aware collection (LIGHTNING_HODL)', async () => {
    const draft = fixtureDraft({ railScope: 'LIGHTNING_HODL' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/Fee policy activation is not supported for rail 'LIGHTNING_HODL'/)
    expect(repo.publish).not.toHaveBeenCalled()
  })

  it('rejects publishing a policy for SAFE_GUARD_EVM', async () => {
    const draft = fixtureDraft({ railScope: 'SAFE_GUARD_EVM' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/Fee policy activation is not supported for rail 'SAFE_GUARD_EVM'/)
  })

  it('rejects publishing a policy for WDK_USDT_EVM', async () => {
    const draft = fixtureDraft({ railScope: 'WDK_USDT_EVM' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/Fee policy activation is not supported for rail 'WDK_USDT_EVM'/)
  })

  it('rejects publishing a policy for MOCK', async () => {
    const draft = fixtureDraft({ railScope: 'MOCK' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).rejects.toThrow(/Fee policy activation is not supported for rail 'MOCK'/)
  })

  it('allows publishing a policy for MULTISIG (the one rail with real fee-aware collection)', async () => {
    const draft = fixtureDraft({ railScope: 'MULTISIG' })
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue(draft),
      publish: jest.fn().mockResolvedValue({ ...draft, status: 'PUBLISHED', publishedAt: new Date() }),
    })
    const service = new FeePolicyService(repo)

    const published = await service.publish(draft.id)
    expect(published.status).toBe('PUBLISHED')
  })

  it('a fixture-only railScope (not a real EscrowType) is never gated by rail-activation — existing isolated accounting tests must keep working', async () => {
    const draft = fixtureDraft({ railScope: 'FIXTURE_RAIL_SOMETHING_UNRELATED' })
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue(draft),
      publish: jest.fn().mockResolvedValue({ ...draft, status: 'PUBLISHED', publishedAt: new Date() }),
    })
    const service = new FeePolicyService(repo)

    await expect(service.publish(draft.id)).resolves.toMatchObject({ status: 'PUBLISHED' })
  })
})

// CTO 413 (P1) — the rate is validated, never coerced: the DECIMAL(24,8) column would otherwise
// store NaN (and treat it as > 0) and round a 9th decimal place silently (sometimes upward).
describe('FeePolicyService — protocolFeeRate strict validation (CTO 413)', () => {
  function draftInput(protocolFeeRate: unknown) {
    return {
      label: 'fixture-v1', railScope: 'FIXTURE_RAIL', protocolFeeRate: protocolFeeRate as string,
      payerModel: 'SELLER_PAYS' as const, economicBasis: 'SELLER_DELIVERED_VALUE' as const,
      requiredConfirmations: 2, createdBy: 'test-fixture',
    }
  }

  const invalid: Array<[string, unknown, RegExp]> = [
    ['NaN', 'NaN', /finite/],
    ['Decimal NaN', new Prisma.Decimal('NaN'), /finite/],
    ['Infinity', 'Infinity', /finite/],
    ['-Infinity', '-Infinity', /finite/],
    ['negative', '-0.01', /must be >= 0/],
    ['9 decimal places', '0.000000001', /at most 8 decimal places/],
    ['9 decimal places that PG would round up', '0.004000009', /at most 8 decimal places/],
    ['comma decimal', '0,5', /not a decimal number/],
    ['non-numeric', 'abc', /not a decimal number/],
    ['empty', '', /not a decimal number/],
    // Protocol ceiling (PROTOCOL_MAX_FEE_RATE, proposed 0.50%, pending governance: CTO 38 D-E6).
    ['above the protocol ceiling', '0.00500001', /must be <= 0.005/],
    ['1%, the former placeholder', '0.01', /must be <= 0.005/],
    ['above 100%', '1.5', /must be <= 0.005/],
  ]

  it.each(invalid)('createDraft refuses %s and writes nothing', async (_label, rate, message) => {
    const repo = fakeRepo()
    await expect(new FeePolicyService(repo).createDraft(draftInput(rate))).rejects.toThrow(message)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it.each(invalid)('publish refuses a stored draft with %s', async (_label, rate, message) => {
    const draft = fixtureDraft({ protocolFeeRate: rate })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    await expect(new FeePolicyService(repo).publish(draft.id)).rejects.toThrow(message)
    expect(repo.publish).not.toHaveBeenCalled()
  })

  it.each([
    ['zero', '0'],
    ['exactly 8 decimal places', '0.00000001'],
    ['the fixture rate', '0.004'],
    ['trailing zeros past 8 places (value has 8 or fewer)', '0.0040000000'],
    ['exactly the protocol ceiling', '0.005'],
  ])('createDraft and publish accept %s, passing the value through unchanged', async (_label, rate) => {
    const repo = fakeRepo({ create: jest.fn().mockImplementation(async (input) => input) })
    await expect(new FeePolicyService(repo).createDraft(draftInput(rate))).resolves.toMatchObject({ protocolFeeRate: rate })
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ protocolFeeRate: rate }))

    const draft = fixtureDraft({ protocolFeeRate: rate })
    const publishRepo = fakeRepo({
      findById: jest.fn().mockResolvedValue(draft),
      publish: jest.fn().mockResolvedValue({ ...draft, status: 'PUBLISHED' }),
    })
    await expect(new FeePolicyService(publishRepo).publish(draft.id)).resolves.toMatchObject({ status: 'PUBLISHED', protocolFeeRate: rate })
  })

  it('accepts a Prisma.Decimal input (the stored column type) and passes the same object through', async () => {
    const rate = new Prisma.Decimal('0.004')
    const repo = fakeRepo({ create: jest.fn().mockImplementation(async (input) => input) })
    await new FeePolicyService(repo).createDraft(draftInput(rate))
    expect(repo.create.mock.calls[0][0].protocolFeeRate).toBe(rate)
  })
})

describe('FeePolicyService.retire', () => {
  it('rejects retiring a policy that is not currently PUBLISHED', async () => {
    const draft = fixtureDraft({ status: 'DRAFT' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.retire(draft.id)).rejects.toThrow(/only a PUBLISHED policy may be retired/)
    expect(repo.retire).not.toHaveBeenCalled()
  })

  it('retires a PUBLISHED policy', async () => {
    const published = fixtureDraft({ status: 'PUBLISHED', publishedAt: new Date() })
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue(published),
      retire: jest.fn().mockResolvedValue({ ...published, status: 'RETIRED', retiredAt: new Date() }),
    })
    const service = new FeePolicyService(repo)

    const retired = await service.retire(published.id)
    expect(retired.status).toBe('RETIRED')
  })
})

// Test I: escrow snapshotting must never be able to reach a DRAFT policy.
describe('FeePolicyService — PUBLISHED-only snapshotting (Test I)', () => {
  it('findLivePolicyForRail never returns a DRAFT policy, even if one exists for the rail', async () => {
    // The fake repository itself only ever returns PUBLISHED rows for
    // findPublishedForRail (mirroring the real Prisma query's own
    // `where: { status: 'PUBLISHED' }` filter) — this test's job is to
    // confirm the SERVICE never second-guesses that and reaches for
    // something else that could surface a DRAFT.
    const repo = fakeRepo({ findPublishedForRail: jest.fn().mockResolvedValue([]) })
    const service = new FeePolicyService(repo)

    const live = await service.findLivePolicyForRail('FIXTURE_RAIL')
    expect(live).toBeNull()
    expect(repo.findPublishedForRail).toHaveBeenCalledWith('FIXTURE_RAIL')
  })

  it('assertPublished throws for a DRAFT policy id', async () => {
    const draft = fixtureDraft({ status: 'DRAFT' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(draft) })
    const service = new FeePolicyService(repo)

    await expect(service.assertPublished(draft.id)).rejects.toThrow(/is not PUBLISHED/)
  })

  it('assertPublished succeeds for a PUBLISHED policy id', async () => {
    const published = fixtureDraft({ status: 'PUBLISHED' })
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(published) })
    const service = new FeePolicyService(repo)

    await expect(service.assertPublished(published.id)).resolves.toEqual(published)
  })
})

// CTO 38 (D-E6): a node's configuration can only tighten the protocol ceiling, never widen it.
describe('protocol fee ceiling: local configuration only tightens it', () => {
  const { config } = require('../src/config')
  const { maxProtocolFeeRate, PROTOCOL_MAX_FEE_RATE } = require('../src/modules/open-settlement/fee-policy.service')
  const original = config.settlement.maxProtocolFeeRate
  afterEach(() => { config.settlement.maxProtocolFeeRate = original })
  it.each([
    ['unset', undefined, PROTOCOL_MAX_FEE_RATE],
    ['a WIDER local value (1%) is ignored', '0.01', PROTOCOL_MAX_FEE_RATE],
    ['an equal local value', PROTOCOL_MAX_FEE_RATE, PROTOCOL_MAX_FEE_RATE],
    ['a TIGHTER local value applies', '0.003', '0.003'],
  ])('%s', (_label, local, effective) => {
    config.settlement.maxProtocolFeeRate = local
    expect(maxProtocolFeeRate()).toBe(effective)
  })
})

describe('createDraft: smallTradeRule.breakEven is validated strictly (CTO 38 §14)', () => {
  const { config } = require('../src/config')
  const original = config.settlement.protocolFeeCollectionAddress
  afterEach(() => { config.settlement.protocolFeeCollectionAddress = original })
  const breakEven = { fMaxSatPerVb: 25, vBytes: 43, dMaxSats: 330, collectionDustSats: 330, allowedPayoutTypes: ['P2WPKH', 'P2WSH', 'P2TR'] }
  const draft = (rule: unknown) => ({ label: 'fixture-be', railScope: 'FIXTURE_RAIL', protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, createdBy: 'test-fixture', smallTradeRule: rule } as any)

  it('an invalid breakEven (dMaxSats 0) is refused and nothing is written', async () => {
    const repo = fakeRepo()
    await expect(new FeePolicyService(repo).createDraft(draft({ breakEven: { ...breakEven, dMaxSats: 0 } }))).rejects.toThrow(/dMaxSats must be a positive integer/)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it("a collection address whose dust exceeds collectionDustSats is refused (P2PKH 546 > 330)", async () => {
    config.settlement.protocolFeeCollectionAddress = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'
    const repo = fakeRepo()
    await expect(new FeePolicyService(repo).createDraft(draft({ breakEven }))).rejects.toThrow(/below the collection address's dust 546/)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('the Day-0 parameters with a P2WPKH collection address, together with fixtureOnlyMinimum, are written unchanged', async () => {
    config.settlement.protocolFeeCollectionAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
    const repo = fakeRepo({ create: jest.fn(async (input: any) => input) })
    const rule = { fixtureOnlyMinimum: '0.001', breakEven }
    await expect(new FeePolicyService(repo).createDraft(draft(rule))).resolves.toMatchObject({ smallTradeRule: rule })
  })
})
