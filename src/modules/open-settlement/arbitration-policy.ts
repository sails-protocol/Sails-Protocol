/**
 * ADR-003 — rail-scoped arbitration capability + policy truth.
 *
 * Pure module by design: no runtime provider imports, no database, no
 * configuration side effects. Boot validation and service selection may
 * both depend on this without creating provider/import cycles.
 */
import type { EscrowType } from '../../common/types/trade'

export type ArbitrationMode = 'trusted-list' | 'market'

export function parseArbitrationMode(raw: string | undefined, source = 'ARBITRATION_MODE'): ArbitrationMode {
  const value = raw?.trim() || 'trusted-list'
  if (value !== 'trusted-list' && value !== 'market') {
    throw new Error(`Invalid ${source} value '${value}'. Expected trusted-list|market`)
  }
  return value
}
export type ArbitrationCapability =
  | 'FIXED_ARBITER_COMMITMENT'
  | 'DYNAMIC_REASSIGNABLE'
  | 'UNKNOWN'

const CAPABILITY_BY_IMPLEMENTATION: Readonly<Partial<Record<EscrowType, ArbitrationCapability>>> = Object.freeze({
  MULTISIG: 'FIXED_ARBITER_COMMITMENT',
  MOCK: 'DYNAMIC_REASSIGNABLE',
})

export function arbitrationCapabilityFor(implementation: string): ArbitrationCapability {
  return CAPABILITY_BY_IMPLEMENTATION[implementation as EscrowType] ?? 'UNKNOWN'
}

export function resolveArbitrationModeForImplementation(
  implementation: string,
  defaultMode: ArbitrationMode,
  overrides: Readonly<Record<string, ArbitrationMode>>,
): ArbitrationMode {
  return overrides[implementation] ?? defaultMode
}

export function assertArbitrationPolicyCompatible(
  implementation: string,
  mode: ArbitrationMode,
): void {
  if (mode !== 'market') return
  const capability = arbitrationCapabilityFor(implementation)
  if (capability === 'DYNAMIC_REASSIGNABLE') return

  throw new Error(
    `FATAL: arbitration policy selects market for settlement implementation '${implementation}', ` +
    `but its arbitration capability is ${capability}. Market arbitration requires DYNAMIC_REASSIGNABLE. ` +
    'Refusing to boot with a policy whose economic authority semantics cannot be honored.'
  )
}

/**
 * Issue #255 (Arbiter Collateral Contribution Identity / Economic Truth) — discovery traced
 * MarketArbitrationProvider.register()'s `monetaryCollateral` all the way to its real source:
 * `POST /v1/settlement/arbitration/register`'s own request body (settlement.routes.ts,
 * `registerArbiterSchema = z.object({ monetaryCollateral: z.string().min(1), collateralAsset:
 * z.string().optional() })`) — a bare, caller-declared decimal string with NO deposit reference, NO
 * txid, NO on-chain lock, NO escrow, and no verification of any kind anywhere in this codebase.
 * RFC-021's own text ("BTC/USDT posted into escrow for this arbiter") overclaims what the reference
 * implementation actually does — corrected there too, same date.
 *
 * This is not a cosmetic gap: `monetaryCollateral` (via `effectiveStake`) directly gates
 * `eligibleFor()`'s K_ELIGIBILITY threshold and directly weights `assign()`'s/`assignAppealPanel()`'s
 * real dispute-arbiter selection — a self-declared number currently buys real arbitration authority
 * (RELEASE/REFUND/SPLIT power) over real escrowed funds. `slash()` only ever decrements this same
 * internal Postgres column; there is no external seizure, burn, or lock reduction anywhere to slash.
 *
 * #255's own decision gate (repository reality, not inference): PATH B — collateral is NOT
 * economically backed today. Per that gate's own explicit instruction ("DO NOT manufacture a fake
 * deposit identity... instead: fail closed or mark the capability production-ineligible"), this
 * follows escrow-providers.ts's own PRODUCTION_INELIGIBLE_TYPES/assertDeploymentEligible() precedent
 * for MOCK escrow exactly: "safe as a deliberate dev/test/sandbox choice, never safe as something a
 * production node treats as real." ARBITRATION_MODE=market is opt-in (parseArbitrationMode()'s own
 * default is 'trusted-list') — this refuses to boot only when an operator has explicitly chosen it
 * for a production deployment, not silently in every environment.
 *
 * Pure and parameterized (no `config` import), matching this file's own header discipline — `app.ts`'s
 * buildApp() calls this with `config.isProduction` at the same boot point as
 * assertArbitrationModeCompatibleWithAvailableRails() above.
 */
export function assertMarketArbitrationCollateralProductionEligible(mode: ArbitrationMode, isProduction: boolean): void {
  if (!isProduction || mode !== 'market') return
  throw new Error(
    'FATAL: ARBITRATION_MODE=market in production, but MarketArbitrationProvider.monetaryCollateral is ' +
    'caller-declared bookkeeping with no external funding/escrow verification (Issue #255) — a participant ' +
    'can self-declare arbitrary collateral and thereby win real arbitration authority (dispute assignment ' +
    'and RELEASE/REFUND/SPLIT power) over real escrowed funds. Not economically backed, not production-' +
    'eligible. Use ARBITRATION_MODE=trusted-list in production until a real funding/custody adapter exists.'
  )
}
