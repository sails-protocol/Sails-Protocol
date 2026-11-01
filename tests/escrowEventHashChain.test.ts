/**
 * Missão 05.5 — EscrowEvent's hash chain (RFC-008 D2 amendment).
 *
 * Unlike tests/timeline.test.ts (which reaches into the real, in-memory
 * InMemoryEventStore directly — no DB involved), EscrowEvent is
 * Postgres-backed, so this file follows this codebase's own established
 * pattern for that case: a small in-memory fake standing in for
 * prisma.escrowEvent (create/findFirst/findMany operating on a real
 * backing array), letting the write path (emitEscrowTransition) and the
 * verifier (verifyEscrowEventChain) be exercised against a genuinely
 * shared, mutable store — the same "real store, then tamper it" spirit
 * timeline.test.ts uses, adapted to how this module is actually mocked
 * elsewhere in this suite (tests/escrowReleaseControls.test.ts etc.).
 */
export {} // forces this file to be a module (no top-level import/export
// otherwise) so its top-level consts don't leak into the shared global
// scope and collide with another such file's identically named ones
// (found for real, Missão 06: mockFindMany colliding with
// tests/capabilityGrantRepository.test.ts's own module-scope one).
let escrowEvents: any[] = []
let nextId = 1

const mockCreate = jest.fn(async (args: any) => {
  const row = { id: `ee-${nextId++}`, createdAt: new Date(Date.now() + nextId), ...args.data }
  escrowEvents.push(row)
  return row
})
// Missão 11 Fase 9.7 — emitEscrowTransition() now makes TWO distinct
// findFirst() calls per invocation, inside the lock: (1) the new
// idempotency claim, filtered by BOTH escrowId AND toStatus ("has THIS
// exact transition already happened") and (2) the pre-existing "what's
// the most recent event at all" lookup (escrowId only, no toStatus),
// used to compute prevHash. This fake must honor toStatus when the real
// query includes it — otherwise call (1) would incorrectly match ANY
// prior event for the escrowId (any toStatus), not just a real repeat
// of the SAME transition, and every subsequent emitEscrowTransition()
// call for an escrow already past its first transition would be
// wrongly treated as a duplicate and silently skipped.
const mockFindFirst = jest.fn(async (args: any) => {
  const matching = escrowEvents.filter((e) =>
    e.escrowId === args.where.escrowId && (args.where.toStatus === undefined || e.toStatus === args.where.toStatus)
  )
  if (matching.length === 0) return null
  return matching.reduce((latest, e) => (e.createdAt > latest.createdAt ? e : latest))
})
const mockFindMany = jest.fn(async (args: any) => {
  return escrowEvents
    .filter((e) => e.escrowId === args.where.escrowId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
})

jest.mock('../src/common/database', () => ({
  prisma: {
    escrowEvent: {
      create: (...args: unknown[]) => mockCreate(...(args as [any])),
      findFirst: (...args: unknown[]) => mockFindFirst(...(args as [any])),
      findMany: (...args: unknown[]) => mockFindMany(...(args as [any])),
    },
    // Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
    // existence-check-then-create INSIDE withEscrowFundingLock()
    // (prisma.$transaction()). This mock is a bare passthrough — no real
    // mutual exclusion, exactly like every other test file's own
    // $transaction mock — so it does NOT change the "concurrency" describe
    // block's own scenario below: real serialization is a genuine Postgres
    // property (tests/integration/escrowFundingConcurrency.test.ts), not
    // something a mocked transaction can provide.
    $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
        eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        escrowEvent: {
          create: (...args: unknown[]) => mockCreate(...(args as [any])),
          findFirst: (...args: unknown[]) => mockFindFirst(...(args as [any])),
        },
      }),
  },
}))
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../src/modules/open-settlement/escrow-circuit-breaker', () => ({
  assertCircuitClosed: jest.fn(),
  recordEscrowConflict: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emitEscrowTransition, verifyEscrowEventChain, computeEscrowEventHash } = require('../src/modules/open-settlement/escrow-lifecycle')

describe('EscrowEvent hash chain — write path (Missão 05.5)', () => {
  beforeEach(() => {
    escrowEvents = []
    nextId = 1
    jest.clearAllMocks()
  })

  it('the first event for an escrowId gets prevHash = genesis', async () => {
    await emitEscrowTransition('escrow-1', 'trade-1', 'CREATED', 'FUNDS_LOCKED', 'seller-1', 'settlement.escrow.locked')
    expect(escrowEvents[0].prevHash).toBe('genesis')
    expect(escrowEvents[0].entryHash).toBe(
      computeEscrowEventHash('CREATED', 'FUNDS_LOCKED', 'seller-1', 'genesis')
    )
  })

  it('each subsequent event chains off the real previous entryHash', async () => {
    await emitEscrowTransition('escrow-1', 'trade-1', 'CREATED', 'FUNDS_LOCKED', 'seller-1', 'settlement.escrow.locked')
    await emitEscrowTransition('escrow-1', 'trade-1', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'buyer-1', 'settlement.escrow.payment_pending')
    await emitEscrowTransition('escrow-1', 'trade-1', 'PAYMENT_PENDING', 'COMPLETED', 'seller-1', 'settlement.escrow.released')

    expect(escrowEvents[1].prevHash).toBe(escrowEvents[0].entryHash)
    expect(escrowEvents[2].prevHash).toBe(escrowEvents[1].entryHash)
    // Real content, not opaque — a chain that verifies correctly must
    // also be recomputable from what's actually stored.
    expect(escrowEvents[2].entryHash).toBe(
      computeEscrowEventHash('PAYMENT_PENDING', 'COMPLETED', 'seller-1', escrowEvents[1].entryHash)
    )
  })

  it('two different escrowIds never chain into each other — independent chains', async () => {
    await emitEscrowTransition('escrow-A', 'trade-A', 'CREATED', 'FUNDS_LOCKED', 'seller-A', 'settlement.escrow.locked')
    await emitEscrowTransition('escrow-B', 'trade-B', 'CREATED', 'FUNDS_LOCKED', 'seller-B', 'settlement.escrow.locked')

    expect(escrowEvents[0].prevHash).toBe('genesis')
    expect(escrowEvents[1].prevHash).toBe('genesis') // NOT escrowEvents[0].entryHash
  })

  it('never accepts an entryHash/prevHash from the caller — emitEscrowTransition() has no such parameters', () => {
    expect(emitEscrowTransition.length).toBeLessThanOrEqual(8) // (escrowId, tradeId, from, to, triggeredBy, eventName, eventExtra, note) — no hash params
  })
})

describe('verifyEscrowEventChain() — a genuine, untampered chain (Missão 05.5)', () => {
  beforeEach(() => {
    escrowEvents = []
    nextId = 1
    jest.clearAllMocks()
  })

  it('reports valid: true for a real, untampered chain', async () => {
    await emitEscrowTransition('escrow-1', 'trade-1', 'CREATED', 'FUNDS_LOCKED', 'seller-1', 'settlement.escrow.locked')
    await emitEscrowTransition('escrow-1', 'trade-1', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'buyer-1', 'settlement.escrow.payment_pending')
    await emitEscrowTransition('escrow-1', 'trade-1', 'PAYMENT_PENDING', 'COMPLETED', 'seller-1', 'settlement.escrow.released')

    const result = await verifyEscrowEventChain('escrow-1')
    expect(result).toEqual({ valid: true })
  })

  it('reports valid: true for an escrowId with no events at all', async () => {
    const result = await verifyEscrowEventChain('escrow-nonexistent')
    expect(result).toEqual({ valid: true })
  })
})

describe('verifyEscrowEventChain() — tamper detection (Missão 05.5 Fase 7)', () => {
  beforeEach(async () => {
    escrowEvents = []
    nextId = 1
    jest.clearAllMocks()
    await emitEscrowTransition('escrow-1', 'trade-1', 'CREATED', 'FUNDS_LOCKED', 'seller-1', 'settlement.escrow.locked')
    await emitEscrowTransition('escrow-1', 'trade-1', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'buyer-1', 'settlement.escrow.payment_pending')
    await emitEscrowTransition('escrow-1', 'trade-1', 'PAYMENT_PENDING', 'COMPLETED', 'seller-1', 'settlement.escrow.released')
  })

  it('detects a modified event — triggeredBy changed after the fact, entryHash left untouched', async () => {
    escrowEvents[2].triggeredBy = 'attacker'
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(2)
    expect(result.reason).toMatch(/mutated in place/)
  })

  it('detects a directly-tampered entryHash — attacker recomputes a hash for their own forged payload', async () => {
    escrowEvents[1].triggeredBy = 'attacker'
    // A naive attacker who also "fixes" the hash to match their forged
    // triggeredBy still can't produce a hash matching the REAL prevHash
    // chain unless they also propagate the change forward — this test
    // proves that even a self-consistent single entry still breaks the
    // link to what comes after it.
    escrowEvents[1].entryHash = computeEscrowEventHash('FUNDS_LOCKED', 'PAYMENT_PENDING', 'attacker', escrowEvents[1].prevHash)
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    // Entry 1 itself now recomputes correctly (self-consistent forgery),
    // but entry 2's stored prevHash no longer matches entry 1's new
    // entryHash — caught one link downstream, exactly where a forger
    // who didn't rewrite the whole tail would be exposed.
    expect(result.brokenAtIndex).toBe(2)
  })

  it('detects a tampered prevHash — an entry rewritten to point at a different ancestor', async () => {
    escrowEvents[2].prevHash = 'some-other-hash-entirely'
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(2)
  })

  it('detects a deleted (removed) event — the link to the next real entry breaks', async () => {
    escrowEvents.splice(1, 1) // remove the middle entry
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1) // formerly-index-2 entry, now at index 1, points at a hash no longer present
  })

  it('detects a reordered chain — same three entries, timestamps swapped so the real query order changes', async () => {
    // verifyEscrowEventChain() queries orderBy: { createdAt: 'asc' }, the
    // same way the real Postgres-backed findMany() would — so a real
    // reordering attack has to rewrite createdAt, not just array
    // position. Swapping the middle and last entries' timestamps is the
    // realistic version of that attack.
    const [, b, c] = escrowEvents
    const swap = b.createdAt
    b.createdAt = c.createdAt
    c.createdAt = swap
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1)
  })

  it('detects an inserted event not part of the real chain', async () => {
    escrowEvents.splice(1, 0, {
      id: 'ee-forged', escrowId: 'escrow-1', fromStatus: 'FUNDS_LOCKED', toStatus: 'DISPUTED',
      triggeredBy: 'attacker', createdAt: new Date(escrowEvents[0].createdAt.getTime() + 1),
      entryHash: 'forged-hash', prevHash: escrowEvents[0].entryHash,
    })
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    // The forged entry itself fails the recompute check first (its own
    // entryHash was never real).
    expect(result.brokenAtIndex).toBe(1)
  })

  it('detects a broken genesis — the first entry does not actually point at genesis', async () => {
    escrowEvents[0].prevHash = 'not-genesis'
    escrowEvents[0].entryHash = computeEscrowEventHash('CREATED', 'FUNDS_LOCKED', 'seller-1', 'not-genesis')
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(0)
    expect(result.reason).toMatch(/genesis/)
  })

  it("detects two conflicting entries claiming the same prevHash — a real fork, not just reordering", async () => {
    // Simulates the exact scenario the write path's own safety argument
    // depends on never happening: two entries computed off the SAME
    // ancestor. One of them, by construction, cannot be the legitimate
    // next link once the other is accepted.
    escrowEvents[2].prevHash = escrowEvents[0].entryHash // should be escrowEvents[1].entryHash
    escrowEvents[2].entryHash = computeEscrowEventHash('PAYMENT_PENDING', 'COMPLETED', 'seller-1', escrowEvents[0].entryHash)
    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(2)
  })
})

describe('verifyEscrowEventChain() — historical (pre-migration) rows (Missão 05.5 Fase 6)', () => {
  beforeEach(() => {
    escrowEvents = []
    nextId = 1
    jest.clearAllMocks()
  })

  it('a leading run of null-hash rows is skipped, never treated as broken — chain starts fresh at the first real entry', async () => {
    // Simulates rows written before this migration: no entryHash/prevHash
    // at all, exactly what the schema's nullable columns produce for
    // existing data.
    escrowEvents.push(
      { id: 'ee-old-1', escrowId: 'escrow-1', fromStatus: 'CREATED', toStatus: 'FUNDS_LOCKED', triggeredBy: 'seller-1', createdAt: new Date(1000), entryHash: null, prevHash: null },
      { id: 'ee-old-2', escrowId: 'escrow-1', fromStatus: 'FUNDS_LOCKED', toStatus: 'PAYMENT_PENDING', triggeredBy: 'buyer-1', createdAt: new Date(2000), entryHash: null, prevHash: null }
    )
    // The real write path's own behavior for the first post-migration
    // event: `last?.entryHash ?? 'genesis'` reads the most recent row
    // (the second null-hash one) and correctly falls back to 'genesis'.
    await emitEscrowTransition('escrow-1', 'trade-1', 'PAYMENT_PENDING', 'COMPLETED', 'seller-1', 'settlement.escrow.released')

    const result = await verifyEscrowEventChain('escrow-1')
    expect(result).toEqual({ valid: true })
    expect(escrowEvents[2].prevHash).toBe('genesis')
  })

  it('a tampered event AFTER the historical prefix is still caught', async () => {
    escrowEvents.push({
      id: 'ee-old-1', escrowId: 'escrow-1', fromStatus: 'CREATED', toStatus: 'FUNDS_LOCKED',
      triggeredBy: 'seller-1', createdAt: new Date(1000), entryHash: null, prevHash: null,
    })
    await emitEscrowTransition('escrow-1', 'trade-1', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'buyer-1', 'settlement.escrow.payment_pending')
    escrowEvents[1].triggeredBy = 'attacker'

    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1)
  })
})

describe('EscrowEvent hash chain — concurrency (Missão 05.5 Fase 7)', () => {
  beforeEach(() => {
    escrowEvents = []
    nextId = 1
    jest.clearAllMocks()
  })

  // Proves the real safety argument in emitEscrowTransition()'s own
  // comment (production callers always call this AFTER their own
  // claimEscrowTransition() atomic claim already succeeded, so there is
  // never a second concurrent writer left to race) by showing what
  // happens WITHOUT that discipline: two calls issued without awaiting
  // between them both read the same "last event" and fork. This is a
  // negative test — it demonstrates the failure mode the real call sites
  // are structurally prevented from ever triggering, and confirms
  // verifyEscrowEventChain() would catch it if that discipline were ever
  // violated. Not a claim that this function is safe on its own; the
  // opposite — proof that the atomic claim upstream is load-bearing.
  it('two emitEscrowTransition() calls issued without an intervening await both read the same prevHash — a real fork, caught by verifyEscrowEventChain()', async () => {
    await Promise.all([
      emitEscrowTransition('escrow-1', 'trade-1', 'FUNDS_LOCKED', 'DISPUTED', 'buyer-1', 'settlement.escrow.disputed'),
      emitEscrowTransition('escrow-1', 'trade-1', 'FUNDS_LOCKED', 'REFUNDED', 'seller-1', 'settlement.escrow.refunded'),
    ])

    expect(escrowEvents).toHaveLength(2)
    // Both forked off the same (nonexistent) ancestor — genesis.
    expect(escrowEvents[0].prevHash).toBe('genesis')
    expect(escrowEvents[1].prevHash).toBe('genesis')

    const result = await verifyEscrowEventChain('escrow-1')
    expect(result.valid).toBe(false)
    expect(result.brokenAtIndex).toBe(1) // second entry's prevHash ('genesis') no longer matches the running chain (first entry's own entryHash)
  })
})
