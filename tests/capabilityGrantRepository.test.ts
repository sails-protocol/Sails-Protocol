/**
 * Missão 02.5 §3 — real gap found while auditing capability readiness:
 * tests/capabilityRegistry.test.ts already proves check()'s scope/expiry
 * logic thoroughly, but only against a fake repository that returns
 * whatever a test configures regardless of which (grantedTo,
 * capabilityName) it was actually called with. The real "wrong
 * capability never gets fetched at all" guarantee lives one layer down,
 * in this repository's own Prisma `where` clause — untested until now.
 */
export {} // forces this file to be a module (no top-level import/export
// otherwise) so its top-level `const mockFindMany` doesn't leak into the
// shared global scope and collide with another such file's identically
// named one (found for real, Missão 06: colliding with
// tests/escrowEventHashChain.test.ts's own module-scope mockFindMany).
const mockFindMany = jest.fn().mockResolvedValue([])
const mockFindUnique = jest.fn()
const mockUpdate = jest.fn()
const mockTxFindMany = jest.fn()
const mockTxCreate = jest.fn()
const mockExecuteRaw = jest.fn().mockResolvedValue(0)
const mockTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    $executeRaw: mockExecuteRaw,
    capabilityGrant: {
      update: (...args: unknown[]) => mockUpdate(...args),
      findMany: (...args: unknown[]) => mockTxFindMany(...args),
      create: (...args: unknown[]) => mockTxCreate(...args),
    },
  })
)
jest.mock('../src/common/database', () => ({
  prisma: {
    capabilityGrant: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { capabilityGrantRepository } = require('../src/core/capability-grant-repository')

describe('capabilityGrantRepository.findActiveGrants() — Missão 02.5 §3', () => {
  beforeEach(() => {
    mockFindMany.mockClear()
    mockFindMany.mockResolvedValue([])
  })

  it('queries Prisma scoped to exactly (grantedTo, capabilityName, revokedAt: null) — a grant for a different capability is never fetched', async () => {
    await capabilityGrantRepository.findActiveGrants('user-1', 'trade-coordination')

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { grantedTo: 'user-1', capabilityName: 'trade-coordination', revokedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  })

  it('a real "wrong capability" scenario: user-1 holds a settlement grant, but a trade-coordination check never even sees it', async () => {
    // Simulates the real Prisma behavior: the WHERE clause above means a
    // 'settlement' grant is filtered out server-side before this
    // function's own JS ever runs — proven by resolving what the real
    // query for 'trade-coordination' would get back (nothing, since the
    // only grant this user holds is for a different capability).
    mockFindMany.mockResolvedValueOnce([])

    const grants = await capabilityGrantRepository.findActiveGrants('user-1', 'trade-coordination')

    expect(grants).toEqual([])
  })

  it('a revoked grant for the right capability is also never fetched (revokedAt: null in the same query)', async () => {
    await capabilityGrantRepository.findActiveGrants('user-1', 'trade-coordination')
    const [{ where }] = mockFindMany.mock.calls[0]
    expect(where.revokedAt).toBeNull()
  })

  it('scoped strictly to the requested participant — never returns another participant\'s grants', async () => {
    await capabilityGrantRepository.findActiveGrants('user-1', 'trade-coordination')
    const [{ where }] = mockFindMany.mock.calls[0]
    expect(where.grantedTo).toBe('user-1')
  })
})


describe('capabilityGrantRepository.markRevoked() — ADR-004 serialization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindUnique.mockResolvedValue({
      id: 'grant-1',
      grantedTo: 'user-1',
      capabilityName: 'settlement',
      scope: ['settlement.escrow.released'],
      constraints: null,
      issuedBy: 'user-1',
      revokedAt: null,
      createdAt: new Date(),
    })
    mockUpdate.mockResolvedValue({})
  })

  it('serializes revocation under the same Postgres advisory-lock domain Gate B uses', async () => {
    await capabilityGrantRepository.markRevoked({
      grantId: 'grant-1',
      grantedTo: 'user-1',
      capabilityName: 'settlement',
      scope: ['settlement.escrow.released'],
      issuedBy: 'user-1',
    })

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'grant-1' },
      data: { revokedAt: expect.any(Date) },
    })
  })

})

// Issue #303 delta - create() is idempotent for an equivalent LIVE grant and
// runs under the same per-(actor, capability) advisory lock as Gate B/revoke.
describe('capabilityGrantRepository.create() - idempotent, locked (Issue #303 delta)', () => {
  const SCOPES = ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split']
  const input = { grantedTo: 'user-1', capabilityName: 'settlement', scope: SCOPES, issuedBy: 'user-1' }
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'existing', grantedTo: 'user-1', capabilityName: 'settlement', scope: SCOPES, constraints: null,
    issuedBy: 'user-1', revokedAt: null, createdAt: new Date(), ...over,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockTxFindMany.mockResolvedValue([])
    mockTxCreate.mockImplementation(async ({ data }: any) => ({ id: 'new', revokedAt: null, createdAt: new Date(), ...data }))
  })

  it('takes the advisory lock on the SAME key namespace as markRevoked()/Gate B, before reading or writing', async () => {
    await capabilityGrantRepository.create(input)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1)
    const [strings, key] = mockExecuteRaw.mock.calls[0]
    expect(strings.join('?')).toContain('pg_advisory_xact_lock')
    expect(key).toBe('capability:user-1:settlement')
    expect(mockExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mockTxFindMany.mock.invocationCallOrder[0])
  })

  it('only considers non-revoked grants of exactly this (grantedTo, capabilityName) - a revoked grant can never block reissue', async () => {
    await capabilityGrantRepository.create(input)
    expect(mockTxFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { grantedTo: 'user-1', capabilityName: 'settlement', revokedAt: null },
    }))
  })

  it('inserts when no equivalent live grant exists', async () => {
    const grant = await capabilityGrantRepository.create(input)
    expect(mockTxCreate).toHaveBeenCalledTimes(1)
    expect(grant.grantId).toBe('new')
  })

  it('returns the existing grant instead of inserting when an equivalent live one exists', async () => {
    mockTxFindMany.mockResolvedValue([row()])
    const grant = await capabilityGrantRepository.create(input)
    expect(mockTxCreate).not.toHaveBeenCalled()
    expect(grant.grantId).toBe('existing')
  })

  it('an existing grant whose scopes cover a SUBSET-request is equivalent (superset satisfies the request)', async () => {
    mockTxFindMany.mockResolvedValue([row()])
    await capabilityGrantRepository.create({ ...input, scope: ['settlement.escrow.released'] })
    expect(mockTxCreate).not.toHaveBeenCalled()
  })

  it('an EXPIRED existing grant is not equivalent - reissue inserts a new one (history untouched)', async () => {
    mockTxFindMany.mockResolvedValue([row({ constraints: { expiresAt: new Date(Date.now() - 1000).toISOString() } })])
    await capabilityGrantRepository.create(input)
    expect(mockTxCreate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('a not-yet-expired existing grant with the SAME constraints is equivalent regardless of key order', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    mockTxFindMany.mockResolvedValue([row({ constraints: { expiresAt: future, note: 'a' } })])
    await capabilityGrantRepository.create({ ...input, constraints: { note: 'a', expiresAt: future } })
    expect(mockTxCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['different constraints', { constraints: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }, {}],
    ['a wider scope request than the existing grant covers', { scope: [...SCOPES, 'settlement.escrow.extra'] }, {}],
    ['a different issuer', {}, { issuedBy: 'someone-else' }],
  ])('is NOT equivalent for %s - a new grant is inserted, not collapsed', async (_name, inputOver, rowOver) => {
    mockTxFindMany.mockResolvedValue([row(rowOver)])
    await capabilityGrantRepository.create({ ...input, ...inputOver })
    expect(mockTxCreate).toHaveBeenCalledTimes(1)
  })
})
