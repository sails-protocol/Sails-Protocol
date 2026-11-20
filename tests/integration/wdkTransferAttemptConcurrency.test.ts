/**
 * #246 — real PostgreSQL evidence for WDK generation ownership.
 * These tests intentionally use the real Prisma client/database. They prove
 * the database, not a Jest mock, arbitrates concurrent economic ownership.
 *
 * CTO Despacho 046: runs in the PostgreSQL lane (--runInBand) and in the CI restricted step as sails_runtime, never in the unit lane.
 * Every test seeds its own escrow under a fresh id, so nothing is deleted (the runtime role has no DELETE on these tables) and no run
 * can collide with another run's or a crashed run's rows.
 */
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { legacyEscrowSeed } from './helpers/legacyEscrowSeed'

let escrowId = ''
const operationType = 'RELEASE' as const
const destination = '0x00000000000000000000000000000000000000aa'
const amount = '1'

describe('WDK active generation ownership — PostgreSQL', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any
  let wdkTransferAttemptRepository: any

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ wdkTransferAttemptRepository } = require('../../src/modules/open-settlement/wdk-transfer-attempt-repository'))
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect() })

  /** A fresh users/offer/trade/pre-cut WDK escrow under a new escrowId. */
  async function seed() {
    escrowId = `wdk-ownership-race-${randomUUID()}`
    await prisma.user.createMany({
      data: [
        { id: `${escrowId}-buyer`, publicKey: randomBytes(32).toString('hex') },
        { id: `${escrowId}-seller`, publicKey: randomBytes(32).toString('hex') },
      ],
    })
    await prisma.offer.create({
      data: {
        id: `${escrowId}-offer`,
        userId: `${escrowId}-seller`,
        asset: 'USDT_ERC20',
        side: 'SELL',
        priceUsd: '1',
        minAmount: '1',
        maxAmount: '1',
        paymentMethod: 'CRYPTO_DIRECT',
      },
    })
    await prisma.trade.create({
      data: {
        id: `${escrowId}-trade`,
        offerId: `${escrowId}-offer`,
        buyerId: `${escrowId}-buyer`,
        sellerId: `${escrowId}-seller`,
        asset: 'USDT_ERC20',
        amount: '1',
        priceUsd: '1',
        totalUsd: '1',
      },
    })
    // pre-cut legacy WDK escrow (F4 deny-by-default: no new WDK escrow can exist), through the single legacy-seed helper
    await legacyEscrowSeed({ id: escrowId, tradeId: `${escrowId}-trade`, type: 'WDK_USDT_EVM', lockedAmount: '1', asset: 'USDT_ERC20', columns: { status: 'FUNDS_LOCKED' } })
  }

  beforeEach(async () => {
    pg.requirePostgres('WDK active generation ownership')
    await seed()
  })

  it('allows at most one concurrent first-generation owner', async () => {
    const attempts = await Promise.allSettled([
      wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount }),
      wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount }),
    ])

    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1)

    const active = await prisma.wdkTransferAttempt.findMany({
      where: { escrowId, operationType, activeKey: `${escrowId}:${operationType}` },
    })
    expect(active).toHaveLength(1)
  })

  it('refuses to replace an active generation from an unsafe predecessor state', async () => {
    for (const unsafeStatus of ['SUBMISSION_UNKNOWN', 'SUBMITTED', 'CONFIRMED'] as const) {
      await seed() // a fresh escrow per predecessor state, instead of deleting the previous attempt
      const first = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
      await wdkTransferAttemptRepository.updateStatus(first.id, unsafeStatus, unsafeStatus === 'SUBMITTED' || unsafeStatus === 'CONFIRMED' ? { txHash: '0xabc' } : undefined, ['PREPARED'])

      await expect(
        wdkTransferAttemptRepository.replaceActive(first.id, ['REVERTED'], { escrowId, operationType, destination, amount })
      ).rejects.toThrow(/cannot relinquish active generation/)

      const active = await prisma.wdkTransferAttempt.findMany({
        where: { escrowId, operationType, activeKey: `${escrowId}:${operationType}` },
      })
      expect(active).toHaveLength(1)
      expect(active[0].id).toBe(first.id)
      expect(active[0].status).toBe(unsafeStatus)
    }
  })

  it('keeps RELEASE and SPLIT legs as independent ownership domains', async () => {
    const operationTypes = ['RELEASE', 'SPLIT_BUYER', 'SPLIT_SELLER'] as const
    const created = await Promise.all(
      operationTypes.map((op) =>
        wdkTransferAttemptRepository.create({ escrowId, operationType: op, destination, amount })
      )
    )

    expect(created).toHaveLength(3)
    const active = await prisma.wdkTransferAttempt.findMany({
      where: { escrowId, activeKey: { not: null } },
      orderBy: { operationType: 'asc' },
    })
    expect(active).toHaveLength(3)
    expect(new Set(active.map((x) => x.activeKey))).toEqual(
      new Set(operationTypes.map((op) => `${escrowId}:${op}`))
    )
  })

  it('allows FAILED_BEFORE_SUBMISSION to transfer ownership exactly once', async () => {
    const first = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
    await wdkTransferAttemptRepository.updateStatus(first.id, 'FAILED_BEFORE_SUBMISSION', undefined, ['PREPARED'])

    const replacements = await Promise.allSettled([
      wdkTransferAttemptRepository.replaceActive(first.id, ['FAILED_BEFORE_SUBMISSION'], { escrowId, operationType, destination, amount }),
      wdkTransferAttemptRepository.replaceActive(first.id, ['FAILED_BEFORE_SUBMISSION'], { escrowId, operationType, destination, amount }),
    ])

    expect(replacements.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(replacements.filter((x) => x.status === 'rejected')).toHaveLength(1)

    const rows = await prisma.wdkTransferAttempt.findMany({
      where: { escrowId, operationType },
      orderBy: { createdAt: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows.filter((x) => x.activeKey === `${escrowId}:${operationType}`)).toHaveLength(1)
    expect(rows.find((x) => x.id === first.id)?.activeKey).toBeNull()
  })

  it('a stale worker cannot regress SUBMITTED or CONFIRMED truth', async () => {
    const first = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
    await wdkTransferAttemptRepository.updateStatus(first.id, 'SUBMISSION_UNKNOWN', undefined, ['PREPARED'])
    await wdkTransferAttemptRepository.updateStatus(first.id, 'SUBMITTED', { txHash: '0xabc' }, ['SUBMISSION_UNKNOWN'])
    await wdkTransferAttemptRepository.updateStatus(first.id, 'CONFIRMED', undefined, ['SUBMITTED'])

    await expect(
      wdkTransferAttemptRepository.updateStatus(first.id, 'SUBMITTED', { txHash: '0xstale' }, ['SUBMISSION_UNKNOWN'])
    ).rejects.toThrow(/transition ownership lost/)

    await expect(
      wdkTransferAttemptRepository.updateStatus(first.id, 'REVERTED', undefined, ['SUBMITTED'])
    ).rejects.toThrow(/transition ownership lost/)

    const persisted = await prisma.wdkTransferAttempt.findUnique({ where: { id: first.id } })
    expect(persisted?.status).toBe('CONFIRMED')
    expect(persisted?.txHash).toBe('0xabc')
  })

  it('reconciles a persisted SUBMITTED generation idempotently after restart', async () => {
    const first = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
    await wdkTransferAttemptRepository.updateStatus(first.id, 'SUBMISSION_UNKNOWN', undefined, ['PREPARED'])
    await wdkTransferAttemptRepository.updateStatus(first.id, 'SUBMITTED', { txHash: '0xrestart' }, ['SUBMISSION_UNKNOWN'])

    const afterRestart = await wdkTransferAttemptRepository.findLatest(escrowId, operationType)
    expect(afterRestart?.id).toBe(first.id)
    expect(afterRestart?.status).toBe('SUBMITTED')
    expect(afterRestart?.txHash).toBe('0xrestart')

    const firstReconciler = await wdkTransferAttemptRepository.updateStatus(first.id, 'CONFIRMED', undefined, ['SUBMITTED'])
    expect(firstReconciler.status).toBe('CONFIRMED')

    await expect(
      wdkTransferAttemptRepository.updateStatus(first.id, 'CONFIRMED', undefined, ['SUBMITTED'])
    ).rejects.toThrow(/transition ownership lost/)

    const persisted = await wdkTransferAttemptRepository.findLatest(escrowId, operationType)
    expect(persisted?.status).toBe('CONFIRMED')
    expect(persisted?.txHash).toBe('0xrestart')
    expect(persisted?.activeKey).toBe(`${escrowId}:${operationType}`)
  })

  it('persists SUBMISSION_UNKNOWN across restart and refuses generation replacement', async () => {
    const first = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
    await wdkTransferAttemptRepository.updateStatus(first.id, 'SUBMISSION_UNKNOWN', undefined, ['PREPARED'])

    const afterRestart = await wdkTransferAttemptRepository.findLatest(escrowId, operationType)
    expect(afterRestart?.status).toBe('SUBMISSION_UNKNOWN')
    expect(afterRestart?.activeKey).toBe(`${escrowId}:${operationType}`)

    await expect(
      wdkTransferAttemptRepository.replaceActive(first.id, ['REVERTED'], { escrowId, operationType, destination, amount })
    ).rejects.toThrow(/cannot relinquish active generation/)

    const rows = await prisma.wdkTransferAttempt.findMany({ where: { escrowId, operationType } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.id)
    expect(rows[0].status).toBe('SUBMISSION_UNKNOWN')
  })

  it('allows at most one replacement generation under concurrent retry', async () => {
    const first = await wdkTransferAttemptRepository.create({ escrowId, operationType, destination, amount })
    await wdkTransferAttemptRepository.updateStatus(first.id, 'REVERTED', undefined, ['PREPARED'])

    const replacements = await Promise.allSettled([
      wdkTransferAttemptRepository.replaceActive(first.id, ['REVERTED'], { escrowId, operationType, destination, amount }),
      wdkTransferAttemptRepository.replaceActive(first.id, ['REVERTED'], { escrowId, operationType, destination, amount }),
    ])

    expect(replacements.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(replacements.filter((x) => x.status === 'rejected')).toHaveLength(1)

    const active = await prisma.wdkTransferAttempt.findMany({
      where: { escrowId, operationType, activeKey: `${escrowId}:${operationType}` },
    })
    expect(active).toHaveLength(1)
  })
})
