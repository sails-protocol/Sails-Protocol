/**
 * CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 38, 2026-09-13) — proves the
 * two real disagreements `docs/CROSS_LAYER_SEMANTIC_CONTRACT_AUDIT.md`'s
 * CSC-C01/CSC-D01 found are actually closed, against the real canonical
 * source in each case (the live Prisma enum for DisputeStatus; the real
 * server response shape for the arbiter types) — never against a second,
 * hand-written stand-in for either. Same discipline
 * `tests/escrowCreationSchemaParity.test.ts` already established for a
 * different pair of types: a compile-time type-identity check (fails to
 * COMPILE, not just fails an assertion, the moment any declaration
 * drifts again) plus a runtime check against the actual authoritative
 * value list.
 */
import { DisputeStatus as PrismaDisputeStatus } from '@prisma/client'
import type { DisputeStatus as P2PSchemasDisputeStatus } from '@satsails/p2p-schemas'
import type { DisputeStatus as SdkDisputeStatus } from '@satsails/p2p-trading-sdk'
import type { ArbiterCandidate as SdkArbiterCandidate } from '@satsails/p2p-trading-sdk'
import type { ArbiterCandidate as ServerArbiterCandidate } from '../src/modules/open-settlement/market-arbitration.provider'

// `[A] extends [B] ? ([B] extends [A] ? true : false) : false` is
// deliberately a two-way check, not a one-way `extends` — a one-way
// check would silently accept a STRICT SUBSET of the real value set as
// "compatible," exactly the bug CSC-C01 found (packages/sails-p2p-schemas's
// DisputeStatus was a subset of the real 6-value enum, and would have
// passed a one-way `extends PrismaDisputeStatus` check).
type AssertIdentical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('DisputeStatus parity — packages/sails-p2p-schemas and packages/sails-sdk vs the real Prisma enum', () => {
  it('the real, live Prisma enum has exactly the 7 expected values (ground truth, not asserted)', () => {
    expect(new Set(Object.values(PrismaDisputeStatus))).toEqual(
      new Set(['OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATED', 'RESOLVED', 'APPEALED', 'AUTO_PROPOSED', 'MOOT']) // #239D MOOT
    )
  })

  it("packages/sails-p2p-schemas's DisputeStatus is structurally identical to the real Prisma enum (compile-time — this file fails to typecheck if either drifts)", () => {
    const identical: AssertIdentical<P2PSchemasDisputeStatus, PrismaDisputeStatus> = true
    expect(identical).toBe(true)
  })

  it("packages/sails-sdk's DisputeStatus remains structurally identical to the real Prisma enum", () => {
    const identical: AssertIdentical<SdkDisputeStatus, PrismaDisputeStatus> = true
    expect(identical).toBe(true)
  })
})

describe('Arbiter type reconciliation — one canonical shape for the real live response (CSC-D01)', () => {
  it("the SDK's own ArbiterCandidate is structurally identical to the real server ArbiterCandidate (market-arbitration.provider.ts's toCandidate() return type) — compile-time", () => {
    // Two-way check again: this also catches the SDK type being a
    // SUPERSET (a field the real response never sends), not just a
    // subset — either direction is a real drift the audit's own
    // discipline ("no exhaustive table... but no false parity either")
    // requires catching.
    const identical: AssertIdentical<SdkArbiterCandidate, ServerArbiterCandidate> = true
    expect(identical).toBe(true)
  })

  it('SailsSettlementModule no longer exports a competing ArbiterProfile type or registerArbiter()/getArbiterProfile() methods', async () => {
    const settlementModule = await import('../packages/sails-sdk/src/modules/settlement')
    expect((settlementModule as Record<string, unknown>).ArbiterProfile).toBeUndefined()
    const prototype = settlementModule.SailsSettlementModule.prototype as unknown as Record<string, unknown>
    expect(typeof prototype.registerArbiter).toBe('undefined')
    expect(typeof prototype.getArbiterProfile).toBe('undefined')
  })
})
