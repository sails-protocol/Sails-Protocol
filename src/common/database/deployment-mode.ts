/**
 * F4 / invariant 3b (CTO Despacho 030, gate 3): the production boot check for the database environment marker.
 *
 * The escrow commitment-pair trigger exempts MOCK escrows only while the single row of `deployment_mode` exists ('development' | 'test').
 * The migration inserts nothing and the runtime role can only read the table, so in a production database the row is absent and MOCK
 * needs a COMMITTED pair like every other type. If the row IS there in production (an admin inserted it, a test database was promoted),
 * the exemption is open: refuse to start.
 */
import { prisma } from '.'
import { config } from '../../config'

type Query = (sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

export async function assertNoDeploymentModeInProduction(isProduction: boolean = config.isProduction, query: Query = prisma.$queryRaw.bind(prisma) as Query): Promise<void> {
  if (!isProduction) return
  const rows = (await query`SELECT mode, created_by FROM deployment_mode LIMIT 1`) as Array<{ mode: string; created_by: string }>
  if (rows.length > 0) {
    throw new Error(
      `Refusing to start in production: deployment_mode has a row (mode=${rows[0].mode}, created_by=${rows[0].created_by}). ` +
        'That row opens the MOCK exemption of the escrow commitment-pair trigger; a production database has no row (docs/DEPLOYMENT.md).',
    )
  }
}
