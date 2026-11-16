/**
 * SailsCapabilitiesModule + WalletAdapter integration (RFC-013).
 */
import { SailsTransport } from '../src/transport'
import { SailsCapabilitiesModule } from '../src/modules/capabilities'
import type { WalletAdapter } from '../src/wallet-adapter'

function fakeFetch(status: number, body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
}

function authedTransport(fetchImpl: jest.Mock): SailsTransport {
  const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
  transport.setSessionToken('session-abc')
  return transport
}

describe('SailsCapabilitiesModule', () => {
  it('register() posts to /v1/capabilities/register with auth', async () => {
    const fetchImpl = fakeFetch(201, {
      success: true,
      data: { grantId: 'grant-1', grantedTo: 'user-1', capabilityName: 'trade-coordination', scope: ['a'], issuedBy: 'user-1' },
    })
    const capabilities = new SailsCapabilitiesModule(authedTransport(fetchImpl))

    const grant = await capabilities.register({ capabilityName: 'trade-coordination', scope: ['a'] })

    // Checked 2026-08-01 (see types.ts's own comment on CapabilityGrant):
    // `grantId` is correct — capability-registry.ts's toCapabilityGrant()
    // really does map the Prisma row's `id` to `grantId` before this
    // response ever leaves the server.
    expect(grant.grantId).toBe('grant-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/capabilities/register')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('list() hits GET /v1/capabilities/:participantId, no auth required', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: [] })
    const capabilities = new SailsCapabilitiesModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch }))

    await capabilities.list('user-1')

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/v1/capabilities/user-1')
  })

  it('revoke() posts to /v1/capabilities/:grantId/revoke with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: {} })
    const capabilities = new SailsCapabilitiesModule(authedTransport(fetchImpl))

    await capabilities.revoke('grant-1')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/capabilities/grant-1/revoke')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  // Issue #303 - a wallet's technical capabilities are NOT permission.
  it('registerFromWallet() is deprecated: it ignores the wallet declaration and self-issues both canonical grants', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ success: true, data: { grantId: 'g1', grantedTo: 'u', capabilityName: 'trade-coordination', scope: ['intent.created', 'intent.discovering'], issuedBy: 'u' } }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ success: true, data: { grantId: 'g2', grantedTo: 'u', capabilityName: 'settlement', scope: [], issuedBy: 'u' } }) })
    const capabilities = new SailsCapabilitiesModule(authedTransport(fetchImpl))
    const wallet = {
      getCapabilities: async () => ({ assets: ['USDT'], fiatRails: ['PIX'], supportsP2PTrading: false, supportsOnchainSettlement: false }),
    } as unknown as WalletAdapter

    const grant = await capabilities.registerFromWallet(wallet)

    expect(grant.grantId).toBe('g1')
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies).toEqual([
      { capabilityName: 'trade-coordination', scope: ['intent.created', 'intent.discovering'] },
      { capabilityName: 'settlement', scope: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'] },
    ])
  })
})

describe('SailsCapabilitiesModule.ensureCanonicalGrants (Issue #303)', () => {
  const trade = { grantId: 't', grantedTo: 'u', capabilityName: 'trade-coordination', scope: ['intent.created', 'intent.discovering'], issuedBy: 'u' }
  const settlement = { grantId: 's', grantedTo: 'u', capabilityName: 'settlement', scope: ['settlement.escrow.released', 'settlement.escrow.refunded', 'settlement.escrow.split'], issuedBy: 'u' }
  const ok = (status: number, data: unknown) => ({ ok: true, status, json: async () => ({ success: true, data }) })

  it('issues both canonical grants for a participant with none', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(ok(200, []))
      .mockResolvedValueOnce(ok(201, trade))
      .mockResolvedValueOnce(ok(201, settlement))
    const result = await new SailsCapabilitiesModule(authedTransport(fetchImpl)).ensureCanonicalGrants('u')
    expect(result.map((g) => g.capabilityName)).toEqual(['trade-coordination', 'settlement'])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('is idempotent: registers nothing when live canonical grants already cover every scope', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(ok(200, [trade, settlement]))
    await new SailsCapabilitiesModule(authedTransport(fetchImpl)).ensureCanonicalGrants('u')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('re-issues a canonical grant whose only live coverage has expired, and only that one', async () => {
    const expired = { ...settlement, constraints: { expiresAt: '2000-01-01T00:00:00.000Z' } }
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(ok(200, [trade, expired]))
      .mockResolvedValueOnce(ok(201, { ...settlement, grantId: 's2' }))
    const result = await new SailsCapabilitiesModule(authedTransport(fetchImpl)).ensureCanonicalGrants('u')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).capabilityName).toBe('settlement')
    expect(result.map((g) => g.grantId).sort()).toEqual(['s2', 't'])
  })

  it('ignores non-canonical grants a participant may hold', async () => {
    const legacy = { grantId: 'x', grantedTo: 'u', capabilityName: 'legacy', scope: ['a'], issuedBy: 'u' }
    const fetchImpl = jest.fn().mockResolvedValueOnce(ok(200, [legacy, trade, settlement]))
    const result = await new SailsCapabilitiesModule(authedTransport(fetchImpl)).ensureCanonicalGrants('u')
    expect(result.map((g) => g.grantId)).toEqual(['t', 's'])
  })
})
