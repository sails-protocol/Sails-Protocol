/**
 * Self-test of the corpus helper tests/integration/helpers/committedPairFixture.ts against real PostgreSQL: the fixture must build a REAL
 * COMMITTED pair (F3 service, real signatures, admitted trade bound to its accepted envelope) and escrows that the F4 triggers accept
 * for every non-MOCK type; and it must NOT be a bypass: an escrow without the pair is still refused.
 */
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

describe('committedPairFixture (corpus helper)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any
  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect() })

  it('builds an admitted trade bound to the accepted envelope and a COMMITTED pair created by the F3 service', async () => {
    pg.requirePostgres('fixture committed pair')
    const fx = await createCommitmentFixture(prisma, { seed: 0x61 })
    const { tradeId, anchorRef, pairId } = await fx.committedPair()
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } })
    expect(trade).toMatchObject({ tradeIntentId: anchorRef, acceptedEnvelopeId: fx.envelopeRow.id, status: 'PENDING' })
    const pair = await prisma.commitmentPair.findUnique({ where: { id: pairId } })
    expect(pair).toMatchObject({ state: 'COMMITTED', anchorRef, committedAnchorRef: anchorRef, rail: 'MULTISIG' })
    expect(pair.makerReceivedAt).not.toBeNull()
    expect(pair.takerReceivedAt).not.toBeNull()
  })

  it('createTestEscrow: a MULTISIG escrow is accepted under the F4 triggers, bound to its pair', async () => {
    pg.requirePostgres('fixture escrow')
    const fx = await createCommitmentFixture(prisma, { seed: 0x62 })
    const escrow = await fx.createTestEscrow({ type: 'MULTISIG', status: 'CREATED' })
    const row = await prisma.escrow.findUnique({ where: { id: escrow.id } })
    expect(row.type).toBe('MULTISIG')
    expect(row.commitmentPairId).not.toBeNull()
  })

  it('it is not a bypass: the SAME escrow without the pair is refused, and so is one bound to ANOTHER trade\'s pair', async () => {
    pg.requirePostgres('fixture is not a bypass')
    const fx = await createCommitmentFixture(prisma, { seed: 0x63 })
    const a = await fx.committedPair(), b = await fx.committedPair()
    await expect(prisma.escrow.create({ data: { tradeId: a.tradeId, type: 'MULTISIG', lockedAmount: '0.005', asset: 'BTC' } })).rejects.toThrow(/needs a COMMITTED commitment pair/)
    await expect(prisma.escrow.create({ data: { tradeId: a.tradeId, type: 'MULTISIG', lockedAmount: '0.005', asset: 'BTC', commitmentPairId: b.pairId } })).rejects.toThrow(/anchor mismatch/)
    expect((await prisma.escrow.create({ data: { tradeId: a.tradeId, type: 'MULTISIG', lockedAmount: '0.005', asset: 'BTC', commitmentPairId: a.pairId } })).id).toBeTruthy()
  })

  it('FINDING: a WDK_USDT_EVM pair can NEVER be COMMITTED today (arbitration capability UNKNOWN), so no WDK escrow can be created under the deny-by-default trigger', async () => {
    pg.requirePostgres('fixture WDK finding')
    const fx = await createCommitmentFixture(prisma, { seed: 0x64, asset: 'USDT_ERC20', rail: 'WDK_USDT_EVM' })
    // arbitrationCapabilityFor(): only MULTISIG (FIXED_ARBITER_COMMITMENT) and MOCK (DYNAMIC_REASSIGNABLE) are known; every other rail is UNKNOWN,
    // and an UNKNOWN pair stays PROPOSED (K2 CHECK). The fixture therefore cannot produce a COMMITTED WDK pair, and the F4 trigger (WDK is not exempt) refuses the escrow.
    await expect(fx.committedPair()).rejects.toMatchObject({ code: 'E26_TERMS_REFUSED' })
    const { tradeId } = await fx.admitTrade()
    await expect(prisma.escrow.create({ data: { tradeId, type: 'WDK_USDT_EVM', lockedAmount: '0.005', asset: 'USDT_ERC20' } })).rejects.toThrow(/needs a COMMITTED commitment pair/)
  })
})
