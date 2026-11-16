/**
 * capability-registry.ts — RFC-013's real implementation of RFC-005's
 * CapabilityGrant.
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3, step 1, closed
 * 2026-08-08 — was `jest.mock('../src/common/database', () => ({ prisma:
 * { capabilityGrant: { create: ..., findMany: ..., findUnique: ...,
 * update: ... } } }))`, the same module-path-mocking boilerplate every
 * Prisma-touching test file in this suite repeats. Now a plain object
 * implementing `CapabilityGrantRepository`, passed straight into
 * `createCapabilityRegistry()` — no module mocking, no knowledge of
 * Prisma's raw row shape needed here at all; this test only ever deals
 * in the real `CapabilityGrant` domain shape.
 */
import { createCapabilityRegistry, CAPABILITY_IMPLEMENTATIONS, CANONICAL_CAPABILITY_SCOPES } from '../src/core/capability-registry'
import type { CapabilityGrantRepository } from '../src/core/capability-grant-repository'
import type { CapabilityGrant } from '../src/common/types/capability'

function fakeRepo(overrides: Partial<jest.Mocked<CapabilityGrantRepository>> = {}): jest.Mocked<CapabilityGrantRepository> {
  return {
    create: jest.fn(),
    findActiveGrants: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    markRevoked: jest.fn(),
    listActiveGrants: jest.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('capabilityRegistry.grant', () => {
  it('creates a grant and returns it in the frozen CapabilityGrant shape (grantId, not id)', async () => {
    const created: CapabilityGrant = {
      grantId: 'grant-1',
      grantedTo: 'user-1',
      capabilityName: 'trade-coordination',
      scope: ['intent.created'],
      constraints: { maxValue: '100' },
      issuedBy: 'user-1',
    }
    const repo = fakeRepo({ create: jest.fn().mockResolvedValue(created) })
    const registry = createCapabilityRegistry(repo)

    const grant = await registry.grant({
      grantedTo: 'user-1',
      capabilityName: 'trade-coordination',
      scope: ['intent.created'],
      constraints: { maxValue: '100' },
      issuedBy: 'user-1',
    })

    expect(grant).toEqual(created)
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ grantedTo: 'user-1' }))
  })
})

describe('capabilityRegistry.grant - canonical vocabulary (Issue #303)', () => {
  const base = { grantedTo: 'user-1', issuedBy: 'user-1' }

  it('exposes exactly the capability names/scopes the existing gates consume', () => {
    expect(CANONICAL_CAPABILITY_SCOPES).toEqual({
      'trade-coordination': ['intent.created', 'intent.discovering'],
      settlement: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'],
    })
  })

  it.each([
    ['anything'],
    ['liquidity-discovery'], // a real RFC-005 name that no gate consumes yet
    ['__proto__'],
    ['constructor'],
  ])('rejects the unknown capabilityName %p and persists nothing', async (name) => {
    const repo = fakeRepo()
    const registry = createCapabilityRegistry(repo)
    await expect(registry.grant({ ...base, capabilityName: name, scope: ['intent.created'] })).rejects.toThrow(/Unknown capabilityName/)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it.each([
    ['trade-coordination', ['whatever']],
    ['trade-coordination', ['settlement.escrow.released']], // valid scope, wrong capability
    ['settlement', ['intent.created']], // valid scope, wrong capability
    ['settlement', ['settlement.escrow.released', 'settlement.escrow.everything']],
    ['trade-coordination', ['trade-coordination']], // the old registerFromWallet() shape
  ])('rejects mismatched/invalid scope %p %p and persists nothing', async (name, scope) => {
    const repo = fakeRepo()
    const registry = createCapabilityRegistry(repo)
    await expect(registry.grant({ ...base, capabilityName: name, scope })).rejects.toThrow(/Invalid scope/)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('accepts every canonical (name, scope) pair', async () => {
    for (const [name, scopes] of Object.entries(CANONICAL_CAPABILITY_SCOPES)) {
      const repo = fakeRepo({ create: jest.fn().mockResolvedValue({ grantId: 'g', ...base, capabilityName: name, scope: [...scopes] }) })
      await createCapabilityRegistry(repo).grant({ ...base, capabilityName: name, scope: [...scopes] })
      expect(repo.create).toHaveBeenCalledTimes(1)
    }
  })
})

describe('capabilityRegistry.check', () => {
  it('returns true when an active, unexpired grant covers the requested scope', async () => {
    const repo = fakeRepo({
      findActiveGrants: jest.fn().mockResolvedValue([
        { grantId: 'g1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a', 'b'], issuedBy: 'user-1' },
      ]),
    })
    const registry = createCapabilityRegistry(repo)

    const ok = await registry.check('user-1', 'trade-coordination', 'b')
    expect(ok).toBe(true)
    expect(repo.findActiveGrants).toHaveBeenCalledWith('user-1', 'trade-coordination')
  })

  it('returns false when no grant covers the requested scope', async () => {
    const repo = fakeRepo({
      findActiveGrants: jest.fn().mockResolvedValue([
        { grantId: 'g1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'], issuedBy: 'user-1' },
      ]),
    })
    const registry = createCapabilityRegistry(repo)

    const ok = await registry.check('user-1', 'trade-coordination', 'z')
    expect(ok).toBe(false)
  })

  it('returns false for a grant whose constraints.expiresAt has passed', async () => {
    const repo = fakeRepo({
      findActiveGrants: jest.fn().mockResolvedValue([
        {
          grantId: 'g1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'],
          constraints: { expiresAt: new Date(Date.now() - 1000).toISOString() }, issuedBy: 'user-1',
        },
      ]),
    })
    const registry = createCapabilityRegistry(repo)

    const ok = await registry.check('user-1', 'trade-coordination', 'a')
    expect(ok).toBe(false)
  })

  it('returns true for a grant whose constraints.expiresAt is in the future', async () => {
    const repo = fakeRepo({
      findActiveGrants: jest.fn().mockResolvedValue([
        {
          grantId: 'g1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'],
          constraints: { expiresAt: new Date(Date.now() + 100_000).toISOString() }, issuedBy: 'user-1',
        },
      ]),
    })
    const registry = createCapabilityRegistry(repo)

    const ok = await registry.check('user-1', 'trade-coordination', 'a')
    expect(ok).toBe(true)
  })
})

describe('capabilityRegistry.revoke', () => {
  it('throws NotFoundError for a nonexistent grantId', async () => {
    const repo = fakeRepo({ findById: jest.fn().mockResolvedValue(null) })
    const registry = createCapabilityRegistry(repo)

    await expect(registry.revoke('nope', 'user-1')).rejects.toThrow(/CapabilityGrant/)
    expect(repo.markRevoked).not.toHaveBeenCalled()
  })

  it('throws ForbiddenError when the caller does not own the grant', async () => {
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue({
        grantId: 'grant-1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'], issuedBy: 'user-1',
      }),
    })
    const registry = createCapabilityRegistry(repo)

    await expect(registry.revoke('grant-1', 'someone-else')).rejects.toThrow(/does not own/)
    expect(repo.markRevoked).not.toHaveBeenCalled()
  })

  it('sets revokedAt on an existing grant owned by the requester', async () => {
    const repo = fakeRepo({
      findById: jest.fn().mockResolvedValue({
        grantId: 'grant-1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'], issuedBy: 'user-1',
      }),
    })
    const registry = createCapabilityRegistry(repo)

    await registry.revoke('grant-1', 'user-1')

    expect(repo.markRevoked).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-1', grantedTo: 'user-1' }))
  })
})

describe('capabilityRegistry.listGrants', () => {
  it('returns only active grants, in the frozen CapabilityGrant shape', async () => {
    const grants: CapabilityGrant[] = [
      { grantId: 'g1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'], issuedBy: 'user-1' },
    ]
    const repo = fakeRepo({ listActiveGrants: jest.fn().mockResolvedValue(grants) })
    const registry = createCapabilityRegistry(repo)

    const result = await registry.listGrants('user-1')

    expect(result).toEqual(grants)
    expect(repo.listActiveGrants).toHaveBeenCalledWith('user-1')
  })
})

describe('CAPABILITY_IMPLEMENTATIONS (RFC-005 module <-> Capability table)', () => {
  it('maps every real module to its Capability, matching RFC-005 exactly', () => {
    expect(CAPABILITY_IMPLEMENTATIONS).toEqual({
      openp2p: 'trade-coordination',
      opensettlement: 'settlement',
      openliquidity: 'liquidity-discovery',
      openidentity: 'identity-verification',
      openreputation: 'reputation-scoring',
      openagents: 'agent-delegation',
      openfinance: 'financial-instruments',
      openproof: 'proof-verification',
    })
  })
})
