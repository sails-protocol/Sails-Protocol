/**
 * IdentityService — getPublicView() (Missão 11 Fase 9.3.5 privacy
 * boundary, INV-OP-10). GET /v1/identity/participants/:id is a public,
 * unauthenticated lookup of ANY participant — it stays deliberately
 * public (a counterparty needs another participant's publicKey/peerId
 * to verify signatures/connect over P2P), but the ROW previously
 * returned verbatim (`prisma.user.findUnique(...)`) included reputation
 * stats (which have their own canonical, already-public home at
 * GET /v1/reputation/:participantId) and operator-internal bookkeeping
 * (moduleId/protocolVersion/createdAt/updatedAt) — none of which this
 * route's stated purpose ever required. getPublicView() is now the ONLY
 * method the public route may call; these tests prove its exact field
 * boundary directly against the service, independent of HTTP wiring
 * (tests/routes.test.ts covers the wire-level proof). GET /v1/identity/me
 * is unaffected — authenticated, self-referential, stays the full raw
 * row via getParticipant(), correctly (the only recipient is the person
 * it's already about).
 */
export {} // same forced-module reasoning used throughout this suite

const mockUserFindUnique = jest.fn()
const mockUserCreate = jest.fn()

jest.mock('../src/common/database', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
    },
  },
}))

// identity.service.ts imports auth.ts (Issue #302 registration proof), which
// opens the shared ioredis singleton at import. These tests only exercise
// getPublicView(), so Redis is stubbed — otherwise a real connection is left
// open and Jest cannot exit.
jest.mock('../src/common/redis', () => ({ redis: { get: jest.fn(), set: jest.fn(), eval: jest.fn() } }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IdentityService } = require('../src/modules/open-identity/identity.service')

describe('IdentityService — getPublicView() (Missão 11 Fase 9.3.5 privacy boundary)', () => {
  beforeEach(() => jest.clearAllMocks())

  const fullRow = {
    id: 'user-1',
    publicKey: 'a'.repeat(64),
    displayName: 'Alice',
    peerId: 'peer-abc123',
    verified: true,
    reputationScore: 87,
    totalTrades: 42,
    disputeCount: 1,
    totalVolumeBtc: '3.5',
    moduleId: 'openidentity',
    protocolVersion: '0.1',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  }

  it('never includes reputation stats — reputationScore/totalTrades/disputeCount/totalVolumeBtc have their own canonical, already-public endpoint (GET /v1/reputation/:participantId), not this one', async () => {
    mockUserFindUnique.mockResolvedValue(fullRow)
    const service = new IdentityService()
    const view = await service.getPublicView('user-1')
    expect(view).not.toHaveProperty('reputationScore')
    expect(view).not.toHaveProperty('totalTrades')
    expect(view).not.toHaveProperty('disputeCount')
    expect(view).not.toHaveProperty('totalVolumeBtc')
  })

  it('never includes operator-internal bookkeeping (moduleId/protocolVersion/createdAt/updatedAt)', async () => {
    mockUserFindUnique.mockResolvedValue(fullRow)
    const service = new IdentityService()
    const view = await service.getPublicView('user-1')
    expect(view).not.toHaveProperty('moduleId')
    expect(view).not.toHaveProperty('protocolVersion')
    expect(view).not.toHaveProperty('createdAt')
    expect(view).not.toHaveProperty('updatedAt')
  })

  it('every field required for real signature verification / P2P connection remains present and correct', async () => {
    mockUserFindUnique.mockResolvedValue(fullRow)
    const service = new IdentityService()
    const view = await service.getPublicView('user-1')
    expect(view).toEqual({
      id: 'user-1',
      publicKey: 'a'.repeat(64),
      displayName: 'Alice',
      peerId: 'peer-abc123',
      verified: true,
    })
  })

  it('the exact same projection shape is returned regardless of who is asking — no hidden extra fields unlocked for a "privileged" caller (this route has no auth at all)', async () => {
    mockUserFindUnique.mockResolvedValue(fullRow)
    const service = new IdentityService()
    const viewA = await service.getPublicView('user-1')
    const viewB = await service.getPublicView('user-1') // a second, independent caller
    expect(viewA).toEqual(viewB)
    expect(Object.keys(viewA).sort()).toEqual(['displayName', 'id', 'peerId', 'publicKey', 'verified'])
  })

  it('an unknown participantId throws NotFoundError — existence is disclosed by design (that IS the identity lookup), but nothing beyond the public projection leaks', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    const service = new IdentityService()
    await expect(service.getPublicView('never-registered-id')).rejects.toThrow('Participant')
  })

  it('cannot accidentally return the raw persistence object — the returned reference is a fresh object, not the row getParticipant() fetched', async () => {
    mockUserFindUnique.mockResolvedValue(fullRow)
    const service = new IdentityService()
    const view = await service.getPublicView('user-1')
    expect(view).not.toBe(fullRow)
  })
})
