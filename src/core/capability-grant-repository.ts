/**
 * CapabilityGrantRepository — Sails Protocol Core Component
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3 ("Introduzir
 * repositórios: IntentRepository, CapabilityGrantRepository,
 * TradeRepository, EscrowRepository — dependência via injeção no
 * construtor"), step 1 of an incremental rollout, closed 2026-08-08.
 * Smallest, lowest-risk entity to start with — 5 pre-existing
 * `prisma.capabilityGrant.*` call sites, all inside
 * `capability-registry.ts`, zero fund-movement involved.
 *
 * Every method here is a verbatim move of an existing query from
 * `capability-registry.ts` — no behavior change, same discipline used
 * for the escrow.service.ts decomposition. The Prisma-record-to-domain
 * mapping (`toCapabilityGrant`, formerly a private helper in
 * `capability-registry.ts`) now lives here too — the repository's job
 * is exactly "translate the persistence shape to the domain shape,"
 * `capability-registry.ts` should never need to know `CapabilityGrant`'s
 * raw Prisma row shape at all.
 *
 * Interface-first, following this codebase's existing Provider
 * convention (`SettlementProvider`, `TransportProvider`) — a concrete
 * class implementation exported as an eagerly-built singleton, and
 * `CapabilityRegistry` (a factory function, not a class — see that
 * file) takes this interface as an optional constructor-style argument
 * defaulting to the real singleton, so a test can pass a plain fake
 * object instead of `jest.mock('../common/database', ...)`.
 */
import { prisma } from '../common/database'
import type { CapabilityGrant } from '../common/types/capability'

export interface CapabilityGrantRepository {
  create(input: Omit<CapabilityGrant, 'grantId'>): Promise<CapabilityGrant>
  /** Non-revoked grants matching (grantedTo, capabilityName) — check()'s own scope/expiry filtering happens on the result, not here. */
  findActiveGrants(grantedTo: string, capabilityName: string): Promise<CapabilityGrant[]>
  /** Null if no grant exists with this id — revoke()'s own ownership check happens on the result. */
  findById(grantId: string): Promise<CapabilityGrant | null>
  markRevoked(grant: CapabilityGrant): Promise<void>
  /** Every non-revoked grant for a participant, newest first. */
  listActiveGrants(grantedTo: string): Promise<CapabilityGrant[]>
}

function toCapabilityGrant(record: {
  id: string
  grantedTo: string
  capabilityName: string
  scope: string[]
  constraints: unknown
  issuedBy: string
}): CapabilityGrant {
  return {
    grantId: record.id,
    grantedTo: record.grantedTo,
    capabilityName: record.capabilityName,
    scope: record.scope,
    constraints: (record.constraints as Record<string, unknown> | null) ?? undefined,
    issuedBy: record.issuedBy,
  }
}

function isPastExpiry(constraints: unknown, now: Date): boolean {
  const expiresAt = (constraints as Record<string, unknown> | null | undefined)?.expiresAt
  return typeof expiresAt === 'string' && new Date(expiresAt) <= now
}

// Order-insensitive deep equality for JSON constraints; null/undefined/{} are all "no constraints".
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return entries.length === 0 ? 'null' : `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameConstraints(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

class PrismaCapabilityGrantRepository implements CapabilityGrantRepository {
  /**
   * Issue #303 delta - idempotent, concurrency-safe creation.
   *
   * `create()` used to be a blind INSERT, so N concurrent onboarding calls
   * for the same participant each saw "capability missing" and each inserted
   * an identical live grant. A database UNIQUE constraint cannot express
   * "at most one LIVE equivalent grant": liveness is time-dependent
   * (constraints.expiresAt is JSON and compared to now()), a partial unique
   * index on revokedAt IS NULL would either block reissue after an expiry
   * (an expired grant is not revoked) or forbid legitimately distinct grants
   * (different scope/constraints). So this uses the repository's existing
   * pattern instead: the same per-(actor, capability) advisory lock
   * markRevoked() and Gate B already use, held for the duration of one short
   * transaction, with the equivalence check INSIDE the lock. Consequences:
   * the lock key is the narrowest one (other participants and other
   * capabilities of the same participant never wait); it works across
   * processes/nodes because the lock lives in PostgreSQL; and it also
   * serializes creation against Gate B/revoke for that actor, which is the
   * intended ordering.
   *
   * Equivalent = same grantedTo, capabilityName and issuedBy; LIVE (not
   * revoked, not past constraints.expiresAt); its scopes cover every
   * requested scope; identical constraints. An equivalent live grant is
   * returned instead of inserting another one. A revoked or expired grant is
   * never equivalent, so reissue after revocation/expiry always works and the
   * historical row is left untouched. A grant with different constraints or a
   * wider request is not equivalent and is created normally.
   */
  async create(input: Omit<CapabilityGrant, 'grantId'>): Promise<CapabilityGrant> {
    return prisma.$transaction(async (tx) => {
      const lockKey = `capability:${input.grantedTo}:${input.capabilityName}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`

      const live = await tx.capabilityGrant.findMany({
        where: { grantedTo: input.grantedTo, capabilityName: input.capabilityName, revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // oldest wins, same as findActiveGrants()
      })
      const now = new Date()
      const equivalent = live.find(
        (g) =>
          g.issuedBy === input.issuedBy &&
          !isPastExpiry(g.constraints, now) &&
          input.scope.every((s) => g.scope.includes(s)) &&
          sameConstraints(g.constraints, input.constraints)
      )
      if (equivalent) return toCapabilityGrant(equivalent)

      const record = await tx.capabilityGrant.create({
        data: {
          grantedTo: input.grantedTo,
          capabilityName: input.capabilityName,
          scope: input.scope,
          constraints: (input.constraints ?? undefined) as object | undefined,
          issuedBy: input.issuedBy,
        },
      })
      return toCapabilityGrant(record)
    })
  }

  async findActiveGrants(grantedTo: string, capabilityName: string): Promise<CapabilityGrant[]> {
    const grants = await prisma.capabilityGrant.findMany({
      where: { grantedTo, capabilityName, revokedAt: null },
      // ADR-004: exact-grant selection must be stable across retries/nodes.
      // Oldest grant wins; id is the deterministic tie-breaker.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return grants.map(toCapabilityGrant)
  }

  async findById(grantId: string): Promise<CapabilityGrant | null> {
    const record = await prisma.capabilityGrant.findUnique({ where: { id: grantId } })
    return record ? toCapabilityGrant(record) : null
  }

  async markRevoked(grant: CapabilityGrant): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Same lock namespace Gate B uses. The registry already loaded and
      // ownership-validated this grant; grantedTo/capabilityName are immutable
      // authority identity, so re-reading the same row here would add no
      // correctness and creates an avoidable second-read race/mock surface.
      const lockKey = `capability:${grant.grantedTo}:${grant.capabilityName}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`
      await tx.capabilityGrant.update({ where: { id: grant.grantId }, data: { revokedAt: new Date() } })
    })
  }

  async listActiveGrants(grantedTo: string): Promise<CapabilityGrant[]> {
    const grants = await prisma.capabilityGrant.findMany({
      where: { grantedTo, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    return grants.map(toCapabilityGrant)
  }
}

export const capabilityGrantRepository: CapabilityGrantRepository = new PrismaCapabilityGrantRepository()
