/**
 * Issue #303 - the SDK's onboarding must issue exactly the grants the real
 * gates consume. The REAL SDK module (SailsCapabilitiesModule) is wired to
 * the REAL server registry (in-memory repository) through a fetch stub, so
 * any drift between the SDK's vocabulary and the server's canonical
 * vocabulary, or between either and the gate call sites, fails here.
 */
import { SailsTransport } from '../packages/sails-sdk/src/transport'
import {
  SailsCapabilitiesModule,
  CANONICAL_CAPABILITY_SCOPES as SDK_CANONICAL,
} from '../packages/sails-sdk/src/modules/capabilities'
import {
  createCapabilityRegistry,
  CAPABILITY_IMPLEMENTATIONS,
  CANONICAL_CAPABILITY_SCOPES as SERVER_CANONICAL,
} from '../src/core/capability-registry'
import type { CapabilityGrantRepository } from '../src/core/capability-grant-repository'

function inMemoryRepo(): CapabilityGrantRepository {
  const rows: any[] = []
  let n = 0
  return {
    create: async (i: any) => { const r = { ...i, grantId: `g${++n}` }; rows.push(r); return r },
    findActiveGrants: async (to: string, name: string) => rows.filter((r) => r.grantedTo === to && r.capabilityName === name && !r.revoked),
    findById: async (id: string) => rows.find((r) => r.grantId === id) ?? null,
    markRevoked: async (g: any) => { rows.find((r) => r.grantId === g.grantId).revoked = true },
    listActiveGrants: async (to: string) => rows.filter((r) => r.grantedTo === to && !r.revoked),
  } as unknown as CapabilityGrantRepository
}

// The SDK talks HTTP; this stub answers with the same behavior as
// capability.routes.ts (grantedTo = issuedBy = caller, registry.grant()).
function sdkAgainstRegistry(participantId: string, repo: CapabilityGrantRepository) {
  const registry = createCapabilityRegistry(repo)
  const fetchImpl = jest.fn(async (url: string, init: any) => {
    const respond = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => ({ success: status < 300, data }) })
    try {
      if (String(url).endsWith('/v1/capabilities/register')) {
        const body = JSON.parse(init.body)
        return respond(201, await registry.grant({ grantedTo: participantId, issuedBy: participantId, ...body }))
      }
      return respond(200, await registry.listGrants(participantId))
    } catch (e: any) {
      return { ok: false, status: 400, json: async () => ({ success: false, error: 'VALIDATION_ERROR', message: e.message }) }
    }
  })
  const transport = new SailsTransport({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch })
  transport.setSessionToken('s')
  return { sdk: new SailsCapabilitiesModule(transport), registry, fetchImpl }
}

describe('Issue #303 - canonical vocabulary and SDK onboarding', () => {
  it('the SDK vocabulary is byte-for-byte the server vocabulary', () => {
    expect(SDK_CANONICAL).toEqual(SERVER_CANONICAL)
  })

  it('ensureCanonicalGrants() issues grants that satisfy every existing gate (intent.created, intent.discovering, release, refund, split)', async () => {
    const { sdk, registry } = sdkAgainstRegistry('p1', inMemoryRepo())
    await sdk.ensureCanonicalGrants('p1')

    // capability names exactly as the gate call sites resolve them
    const trade = CAPABILITY_IMPLEMENTATIONS.openp2p // intent-engine.ts / intent.routes.ts
    const settlement = CAPABILITY_IMPLEMENTATIONS.opensettlement // escrow-lifecycle.ts / capability-execution-authorization.ts
    expect(await registry.check('p1', trade, 'intent.created')).toBe(true)
    expect(await registry.check('p1', trade, 'intent.discovering')).toBe(true)
    for (const scope of ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split']) {
      expect(await registry.check('p1', settlement, scope)).toBe(true)
    }
  })

  it('is idempotent against the real registry: a second call issues nothing new', async () => {
    const { sdk, fetchImpl } = sdkAgainstRegistry('p1', inMemoryRepo())
    await sdk.ensureCanonicalGrants('p1')
    const callsAfterFirst = fetchImpl.mock.calls.length
    await sdk.ensureCanonicalGrants('p1')
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst + 1) // only the list call
  })

  it('registerFromWallet() (deprecated) now also yields gate-satisfying grants, regardless of wallet flags', async () => {
    const { sdk, registry } = sdkAgainstRegistry('p1', inMemoryRepo())
    await sdk.registerFromWallet({} as any)
    expect(await registry.check('p1', CAPABILITY_IMPLEMENTATIONS.opensettlement, 'settlement.escrow.released')).toBe(true)
  })

  it('the pre-#303 registerFromWallet() shape is now rejected by the server registry', async () => {
    const { sdk } = sdkAgainstRegistry('p1', inMemoryRepo())
    await expect(
      sdk.register({ capabilityName: 'trade-coordination', scope: ['trade-coordination', 'settlement'], constraints: { assets: ['USDT'] } })
    ).rejects.toThrow()
  })

  it('every scope consumed by a gate call site is in the canonical vocabulary (no gate scope is missing from it)', async () => {
    const fs = await import('fs')
    const read = (p: string) => fs.readFileSync(p, 'utf8')
    const consumed = new Set<string>()
    for (const [file, re] of [
      ['src/core/intent-engine.ts', /capabilityRegistry\.check\([^,]+,[^,]+,\s*'([^']+)'/g],
      ['src/core/intent.routes.ts', /capabilityScope:\s*'([^']+)'/g],
      ['src/modules/open-settlement/escrow-lifecycle.ts', /scope:\s*'(settlement\.escrow\.[a-z]+)'/g],
      ['src/modules/open-settlement/capability-execution-authorization.ts', /return '(settlement\.escrow\.[a-z]+)'/g],
    ] as const) {
      for (const m of read(file).matchAll(re)) consumed.add(m[1])
    }
    const canonical = new Set(Object.values(SERVER_CANONICAL).flat())
    expect(consumed.size).toBeGreaterThanOrEqual(5)
    for (const scope of consumed) expect(canonical.has(scope)).toBe(true)
    for (const scope of canonical) expect(consumed.has(scope)).toBe(true)
  })
})
