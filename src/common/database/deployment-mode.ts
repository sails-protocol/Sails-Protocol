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

interface TickLogger { error: (o: Record<string, unknown>) => void }

/**
 * One periodic check (defence in depth, GK on Despacho 031): the boot check runs only at start-up, so a row written LATER by the
 * admin in a running production process would otherwise go unnoticed until the next restart. Never throws (a timer must not die): it
 * logs an error with the row and reports whether the database is clean.
 */
export async function checkDeploymentModeTick(log: TickLogger, isProduction: boolean = config.isProduction, query?: Query): Promise<boolean> {
  try {
    await assertNoDeploymentModeInProduction(isProduction, query)
    return true
  } catch (err) {
    log.error({ msg: 'deployment_mode row present in production: the MOCK exemption is OPEN', module: 'deployment-mode', err: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** Starts the periodic check in production only; the timer is unref()'d and never overlaps itself. Returns it (or null outside production). */
export function startDeploymentModeWatch(log: TickLogger, intervalMs: number, isProduction: boolean = config.isProduction, query?: Query): NodeJS.Timeout | null {
  if (!isProduction) return null
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    checkDeploymentModeTick(log, isProduction, query).finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return timer
}
