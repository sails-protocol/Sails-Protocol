/**
 * CTO Despacho 046 — controlled negative test of the unit lane's database sentinel (scripts/test-unit-lane.js).
 * Under the unit-lane environment: config resolves to the sentinel (no localhost fallback), the integration harness refuses it before
 * any connection (TestDatabaseSafetyError), and the application's own Prisma client cannot reach any database. So a real-PostgreSQL
 * suite left in the unit lane fails loudly, whatever helper it uses.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UNIT_LANE_DATABASE_URL, unitLaneEnv } = require('../scripts/test-unit-lane')
import { assertTestDatabaseAuthorized, TestDatabaseSafetyError } from './integration/postgresTestHarness'

describe('unit lane: no reachable database (CTO 046)', () => {
  jest.setTimeout(60_000)

  it('the unit-lane environment overrides any real DATABASE_URL and drops the integration confirmation', () => {
    const env = unitLaneEnv({ DATABASE_URL: 'postgresql://postgres:password@localhost:5432/sails_protocol', SAILS_INTEGRATION_TEST_DB_CONFIRMED: 'x', KEEP: '1' })
    expect(env.DATABASE_URL).toBe(UNIT_LANE_DATABASE_URL)
    expect(env).not.toHaveProperty('SAILS_INTEGRATION_TEST_DB_CONFIRMED')
    expect(env.KEEP).toBe('1')
  })

  it('the integration harness refuses the sentinel before connecting', () => {
    const saved = process.env.SAILS_INTEGRATION_TEST_DB_CONFIRMED
    delete process.env.SAILS_INTEGRATION_TEST_DB_CONFIRMED
    try {
      expect(() => assertTestDatabaseAuthorized(UNIT_LANE_DATABASE_URL)).toThrow(TestDatabaseSafetyError)
    } finally {
      if (saved !== undefined) process.env.SAILS_INTEGRATION_TEST_DB_CONFIRMED = saved
    }
  })

  it("the application's own Prisma client, under the unit-lane environment, resolves the sentinel and cannot run a query", async () => {
    const savedEnv = process.env
    const savedGlobal = (global as any).__prisma
    process.env = unitLaneEnv(savedEnv)
    ;(global as any).__prisma = undefined
    let prisma: any
    try {
      jest.isolateModules(() => {
        expect(require('../src/config').config.database.url).toBe(UNIT_LANE_DATABASE_URL)
        ;({ prisma } = require('../src/common/database'))
      })
      await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow()
    } finally {
      if (prisma) await prisma.$disconnect().catch(() => undefined)
      process.env = savedEnv
      ;(global as any).__prisma = savedGlobal
    }
  })
})
