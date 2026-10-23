/**
 * Database — Prisma client singleton.
 * Referenced by escrow.service.ts, liquidity.service.ts, and
 * common/events/handlers.ts. Nothing that touches Trade/Escrow/Offer/User
 * works without this existing.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { config } from '../../config'
import { childLogger } from '../logger'
import { assertMigrationsApplied, MigrationRow } from './migration-gate'

const log = childLogger('database')

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

// Prisma 7 (Dependabot major-version bump, 2026-07-19): `datasources: { db:
// { url } }` in the PrismaClient constructor is gone — the client now
// requires an explicit driver adapter (prisma.config.ts covers the CLI
// side only, not this runtime client). PrismaPg wraps a real `pg` Pool,
// same connection string this always used (config.database.url).
const adapter = new PrismaPg({ connectionString: config.database.url })

// Reuse the client across hot-reloads in dev (ts-node-dev) instead of
// opening a new connection pool on every file change.
export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    adapter,
    log: config.isProduction ? ['error', 'warn'] : ['error', 'warn', 'query'],
  })

if (!config.isProduction) {
  global.__prisma = prisma
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect()
  if (config.isProduction) {
    await assertMigrationsApplied(
      () => prisma.$queryRaw<MigrationRow[]>`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`,
    )
  }
  log.info({ msg: 'Connected' })
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
}
