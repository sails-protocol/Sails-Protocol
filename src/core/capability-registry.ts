/**
 * Capability Registry — Sails Protocol Core Component
 * PROTOCOL_SPECIFICATION.md section 1.10, rfcs/RFC-005-capability-model.md
 * (the `Capability`/`CapabilityGrant` shapes), rfcs/RFC-013-capability-registry-and-wallet-adapter.md
 * (this file's first real implementation — stub since Architecture Freeze).
 *
 * Real, not a stub. Only `CapabilityGrant` (the permission side) is
 * persisted — `Capability`/`CapabilityImplementation` (the static
 * moduleId <-> capabilityName mapping RFC-005's own table lists as
 * "illustrative... a Reference Implementation detail") stays an
 * in-code map below, since it has no real write path in this pass
 * (RFC-013's Alternatives Considered).
 *
 * Corrects a signature drift found while implementing: the pre-RFC-013
 * stub's `grant(capability: Capability): Promise<void>` predates RFC-005
 * disambiguating `Capability` from `CapabilityGrant` and was never
 * updated — it took the wrong shape (the abstract category, not the
 * permission grant) and returned nothing a caller could reference later.
 * Fixed here as part of making this real, not a silent behavior change
 * to code that never actually ran (the stub only ever threw).
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3, step 1, closed
 * 2026-08-08 — all `prisma.capabilityGrant.*` access moved to
 * `capability-grant-repository.ts`; this file no longer imports `prisma`
 * or knows the raw persisted row shape at all. `createCapabilityRegistry()`
 * is a factory function, not a class — `capabilityRegistry` itself was
 * always a plain object literal implementing the `CapabilityRegistry`
 * interface, so there's no class to add a constructor to; the factory
 * takes the repository as an optional parameter (defaulting to the real
 * singleton) instead, giving tests the same seam a constructor would
 * (`createCapabilityRegistry(fakeRepo)` instead of
 * `jest.mock('../common/database', ...)`), with the real, always-used
 * `capabilityRegistry` export's own call sites completely unchanged.
 */
import { NotFoundError, ForbiddenError, ValidationError } from '../common/errors'
import type { CapabilityGrant } from '../common/types/capability'
import { capabilityGrantRepository, type CapabilityGrantRepository } from './capability-grant-repository'

// RFC-005's own module <-> Capability mapping table, illustrative but
// stable enough to encode directly — a genuinely new Capability (a new
// functional category, not a new feature within one of these) requires
// its own RFC per that document's "Stability Guidance."
export const CAPABILITY_IMPLEMENTATIONS: Record<string, string> = {
  openp2p: 'trade-coordination',
  opensettlement: 'settlement',
  openliquidity: 'liquidity-discovery',
  openidentity: 'identity-verification',
  openreputation: 'reputation-scoring',
  openagents: 'agent-delegation',
  openfinance: 'financial-instruments', // 📋 future — PROJECT_CONTEXT.md
  openproof: 'proof-verification', // RFC-006
}

// Issue #303 - the ONE canonical vocabulary of capability names and action
// scopes a CapabilityGrant may carry. Every entry is a scope that an
// existing gate actually consumes today:
//   - 'intent.created'      -> intent-engine.ts create() (trade-coordination)
//   - 'intent.discovering'  -> intent.routes.ts propose (trade-coordination)
//   - 'settlement.escrow.*' -> checkFundMovementCapability() (Gate A) and
//                              authorizePendingExecution() (Gate B)
// Anything else (an unknown name, or a scope that belongs to a different
// capability) is rejected at registration instead of being persisted as an
// arbitrary authority string. A new gated action must be added here in the
// same change that adds its gate.
export const CANONICAL_CAPABILITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'trade-coordination': ['intent.created', 'intent.discovering'],
  settlement: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'],
}

export function assertCanonicalCapabilityGrant(capabilityName: string, scope: readonly string[]): void {
  const allowed = Object.prototype.hasOwnProperty.call(CANONICAL_CAPABILITY_SCOPES, capabilityName)
    ? CANONICAL_CAPABILITY_SCOPES[capabilityName]
    : undefined
  if (!allowed) {
    throw new ValidationError(
      `Unknown capabilityName '${capabilityName}' - expected one of: ${Object.keys(CANONICAL_CAPABILITY_SCOPES).join(', ')}`
    )
  }
  const invalid = scope.filter((s) => !allowed.includes(s))
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid scope(s) for capability '${capabilityName}': ${invalid.join(', ')} - allowed: ${allowed.join(', ')}`
    )
  }
}

export interface CapabilityRegistry {
  grant(input: Omit<CapabilityGrant, 'grantId'>): Promise<CapabilityGrant>
  check(grantedTo: string, capabilityName: string, requiredScope: string): Promise<boolean>
  /** Deterministically resolves the exact live grant authorizing this scope, or null. */
  resolveActiveGrant(grantedTo: string, capabilityName: string, requiredScope: string): Promise<CapabilityGrant | null>
  // requestedBy added during a gap audit: this previously took only
  // grantId, with no check that the caller revoking a grant actually
  // owned it — any authenticated participant could revoke any other
  // participant's CapabilityGrant. Required, not optional.
  revoke(grantId: string, requestedBy: string): Promise<void>
  listGrants(grantedTo: string): Promise<CapabilityGrant[]>
}

export function createCapabilityRegistry(repo: CapabilityGrantRepository = capabilityGrantRepository): CapabilityRegistry {
  return {
    async grant(input) {
      assertCanonicalCapabilityGrant(input.capabilityName, input.scope)
      return repo.create(input)
    },

    async resolveActiveGrant(grantedTo, capabilityName, requiredScope) {
      const grants = await repo.findActiveGrants(grantedTo, capabilityName)
      const now = new Date()
      return grants.find((g) => {
        if (!g.scope.includes(requiredScope)) return false
        const expiresAt = g.constraints?.expiresAt as string | undefined
        if (expiresAt && new Date(expiresAt) <= now) return false
        return true
      }) ?? null
    },

    async check(grantedTo, capabilityName, requiredScope) {
      return (await this.resolveActiveGrant(grantedTo, capabilityName, requiredScope)) !== null
    },

    async revoke(grantId, requestedBy) {
      const existing = await repo.findById(grantId)
      if (!existing) throw new NotFoundError('CapabilityGrant', grantId)
      // Gap-audit fix: only the grant's own holder may revoke it — grants
      // are self-issued only in this pass (RFC-013's own scope cut,
      // grantedTo === issuedBy), so checking grantedTo covers both.
      if (existing.grantedTo !== requestedBy) {
        throw new ForbiddenError(`${requestedBy} does not own CapabilityGrant ${grantId}`)
      }
      await repo.markRevoked(existing)
    },

    async listGrants(grantedTo) {
      return repo.listActiveGrants(grantedTo)
    },
  }
}

export const capabilityRegistry: CapabilityRegistry = createCapabilityRegistry()
