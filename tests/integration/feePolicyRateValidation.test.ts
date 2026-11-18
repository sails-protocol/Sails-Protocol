// tests/integration/feePolicyRateValidation.test.ts
//
// CTO 413 (P1) — real Postgres (CI: postgres:16-alpine) through the real Prisma client/adapter.
// tests/feePolicyService.test.ts proves the service check against a fake repository; this file proves
// the two things only a real database can: what the DECIMAL(24,8) column does on its own (why the
// check is needed) and that createDraft()/publish() hold on that path.

import { randomUUID } from 'crypto'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('FeePolicyVersion protocolFeeRate validation (CTO 413, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let repo: typeof import('../../src/modules/open-settlement/fee-policy-repository').feePolicyVersionRepository
  let service: typeof import('../../src/modules/open-settlement/fee-policy.service').feePolicyService
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  function input(tag: string, protocolFeeRate: string) {
    return {
      label: `cto413-${tag}-${run}`, railScope: `CTO413_RAIL_${tag}-${run}`, protocolFeeRate,
      payerModel: 'SELLER_PAYS' as const, economicBasis: 'SELLER_DELIVERED_VALUE' as const,
      requiredConfirmations: 2, createdBy: 'cto413-fixture',
    }
  }

  async function storedRate(label: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ r: string }>>`SELECT "protocolFeeRate"::text AS r FROM fee_policy_versions WHERE label = ${label}`
    return rows.map((row) => row.r)
  }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ feePolicyVersionRepository: repo } = require('../../src/modules/open-settlement/fee-policy-repository'))
    ;({ feePolicyService: service } = require('../../src/modules/open-settlement/fee-policy.service'))
  })

  afterAll(async () => {
    if (pg.isAvailable()) await prisma.$disconnect()
  })

  // Raw SQL (an old row, a manual fix): the one path that skips both the service and Prisma's own Decimal check.
  async function insertRawNaNDraft(tag: string): Promise<string> {
    const id = randomUUID()
    await prisma.$executeRaw`INSERT INTO fee_policy_versions (id, label, "railScope", status, "protocolFeeRate", "payerModel", "economicBasis", "requiredConfirmations", "createdBy")
      VALUES (${id}, ${`cto413-${tag}-${run}`}, ${`CTO413_RAIL_${tag}-${run}`}, 'DRAFT', 'NaN', 'SELLER_PAYS', 'SELLER_DELIVERED_VALUE', 2, 'cto413-fixture')`
    return id
  }

  it('without the service check: Prisma itself refuses NaN, the column rounds a 9th decimal and refuses Infinity', async () => {
    pg.requirePostgres('CTO 413 column characterization')
    await expect(repo.create(input('nan', 'NaN'))).rejects.toThrow(/Expected decimal/)
    expect(await storedRate(`cto413-nan-${run}`)).toEqual([])

    await repo.create(input('round', '0.004000009'))
    expect(await storedRate(`cto413-round-${run}`)).toEqual(['0.00400001'])

    await expect(repo.create(input('inf', 'Infinity'))).rejects.toThrow()
    expect(await storedRate(`cto413-inf-${run}`)).toEqual([])
  })

  it.each([
    ['nan-svc', 'NaN', /finite/],
    ['inf-svc', 'Infinity', /finite/],
    ['neg-svc', '-0.01', /must be >= 0/],
    ['dp9-svc', '0.004000009', /at most 8 decimal places/],
  ])('createDraft refuses %s before any row is written', async (tag, rate, message) => {
    pg.requirePostgres(`CTO 413 createDraft ${tag}`)
    await expect(service.createDraft(input(tag, rate))).rejects.toThrow(message)
    expect(await storedRate(`cto413-${tag}-${run}`)).toEqual([])
  })

  it('raw SQL still lands NaN in the column, and publish refuses that draft (it stays DRAFT)', async () => {
    pg.requirePostgres('CTO 413 publish NaN')
    const id = await insertRawNaNDraft('nan-pub')
    expect(await storedRate(`cto413-nan-pub-${run}`)).toEqual(['NaN'])
    // Refused either by this check or, if the adapter cannot read NaN back, by findById itself: fail-closed both ways.
    const err: Error = await service.publish(id).then(() => { throw new Error('publish accepted a NaN rate') }, (e) => e)
    console.log(`CTO 413: publish of a raw-SQL NaN draft refused with: ${err.message}`)
    const [after] = await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM fee_policy_versions WHERE id = ${id}`
    expect(after.status).toBe('DRAFT')
  })

  it('a valid 8-decimal rate round-trips exactly through createDraft and publish', async () => {
    pg.requirePostgres('CTO 413 valid round trip')
    const draft = await service.createDraft(input('ok', '0.00000001'))
    expect(await storedRate(`cto413-ok-${run}`)).toEqual(['0.00000001'])
    const published = await service.publish(draft.id)
    expect(published.status).toBe('PUBLISHED')
    expect(published.protocolFeeRate.toFixed()).toBe('0.00000001')
  })
})
