/**
 * Protocol SDK modules (liquidity, settlement, peers, openp2p) — each
 * test asserts the exact method/path/body the module sends, checked
 * against the verified route inventory (docs/API_REFERENCE.md
 * cross-referenced with each route file directly, not assumed from the
 * aspirational doc alone).
 */
import { SailsTransport } from '../src/transport'
import { SailsLiquidityModule } from '../src/modules/liquidity'
import { SailsSettlementModule, recommendedEscrowType, parseSafeGuardBundle } from '../src/modules/settlement'
import { SailsArbitrationModule } from '../src/modules/arbitration'
import { SailsPeersModule } from '../src/modules/peers'
import { SailsOpenP2PModule, WebSocketChannel } from '../src/modules/openp2p'
import { SailsReputationModule } from '../src/modules/reputation'
import { SailsProofModule } from '../src/modules/proof'
import { SailsAgentsModule } from '../src/modules/agents'

function fakeFetch(status: number, body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
}

function authedTransport(fetchImpl: jest.Mock): SailsTransport {
  const transport = new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch })
  transport.setSessionToken('session-abc')
  return transport
}

describe('SailsLiquidityModule', () => {
  it('discover() hits GET /v1/liquidity/offers with asset+side query only, and returns the real DiscoverResult shape with total/hasMore', async () => {
    // Real bug found and fixed wiring the first real caller
    // (packages/sails-ui): this method's return type used to claim a
    // bare Offer[] — the live route (liquidity.routes.ts ->
    // getAggregatedOffers()) actually returns { offers, sources,
    // total, hasMore }, each offer a LiquidityOfferSummary, not a
    // persisted Offer. Confirmed against the real server, not assumed.
    const fetchImpl = fakeFetch(200, { success: true, data: { offers: [], sources: ['internal'], total: 0, hasMore: false } })
    const liquidity = new SailsLiquidityModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch }))

    const result = await liquidity.discover({ asset: 'BTC', side: 'BUY' })

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/v1/liquidity/offers?asset=BTC&side=BUY')
    expect(result).toEqual({ offers: [], sources: ['internal'], total: 0, hasMore: false })
  })

  it('publish() posts to /v1/liquidity/offers with auth', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'offer-1' } })
    const liquidity = new SailsLiquidityModule(authedTransport(fetchImpl))

    await liquidity.publish({
      asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.01', maxAmount: '0.5', paymentMethod: 'PIX',
    })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/liquidity/offers')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('match() posts asset/side/amount to /v1/liquidity/match', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: null })
    const liquidity = new SailsLiquidityModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch }))

    const result = await liquidity.match({ asset: 'BTC', side: 'BUY', amount: '0.1' })

    expect(result).toBeNull()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/liquidity/match')
    expect(JSON.parse(init.body)).toEqual({ asset: 'BTC', side: 'BUY', amount: '0.1' })
  })
})

describe('SailsSettlementModule', () => {
  it('create() resolves an omitted type via recommendedEscrowType and sends it to the server', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'escrow-1', type: 'MULTISIG' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await settlement.create({ tradeId: 'trade-1', lockedAmount: '0.001', asset: 'BTC' })

    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ tradeId: 'trade-1', lockedAmount: '0.001', asset: 'BTC', type: 'MULTISIG' })
  })

  it('create() never overrides an explicitly passed type, even for an asset with a different recommendation', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'escrow-1', type: 'MOCK' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await settlement.create({ tradeId: 'trade-1', lockedAmount: '0.001', asset: 'BTC', type: 'MOCK' })

    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(init.body).type).toBe('MOCK')
  })

  it('create() throws client-side, before any network call, for an asset with no real SettlementProvider yet', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: {} })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await expect(settlement.create({ tradeId: 'trade-1', lockedAmount: '10', asset: 'SPARK' as any })).rejects.toThrow(
      "no real SettlementProvider exists yet for asset 'SPARK'"
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('recommendedEscrowType() matches the real backend mapping for BTC/LN_BTC/USDT_ERC20, undefined otherwise', () => {
    expect(recommendedEscrowType('BTC')).toBe('MULTISIG')
    expect(recommendedEscrowType('LN_BTC')).toBe('LIGHTNING_HODL')
    expect(recommendedEscrowType('USDT_ERC20')).toBe('WDK_USDT_EVM')
    expect(recommendedEscrowType('SPARK' as any)).toBeUndefined()
  })

  it('release() posts toAddress to /v1/settlement/escrow/:id/release with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'escrow-1', status: 'COMPLETED' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.release('escrow-1', '0xbuyer')

    expect(result.status).toBe('COMPLETED')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1/release')
    expect(JSON.parse(init.body)).toEqual({ toAddress: '0xbuyer' })
  })

  it('dispute() posts reason+evidence to /v1/settlement/escrow/:id/dispute', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'dispute-1' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await settlement.dispute('escrow-1', 'no payment received', ['screenshot.png'])

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1/dispute')
    expect(JSON.parse(init.body)).toEqual({ reason: 'no payment received', evidence: ['screenshot.png'] })
  })

  it('initiateExpiryRecovery() (Missão 11 Fase 8.1 LB-05) posts to /v1/settlement/escrow/:id/initiate-expiry-recovery with auth, no body — the exact public route, no privileged bypass', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'dispute-1', status: 'OPENED' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.initiateExpiryRecovery('escrow-1')

    expect(result.id).toBe('dispute-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1/initiate-expiry-recovery')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('resolveDispute() posts ruling+releaseToAddress+authoritySignature+authorityIssuedAt to /v1/settlement/disputes/:id/resolve', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'dispute-1', ruling: 'RELEASE' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await settlement.resolveDispute('dispute-1', 'RELEASE', '0xbuyer', undefined, undefined, 'deadbeef', '2026-08-29T00:00:00.000Z')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/disputes/dispute-1/resolve')
    expect(JSON.parse(init.body)).toEqual({
      ruling: 'RELEASE',
      releaseToAddress: '0xbuyer',
      refundToAddress: undefined,
      splitBuyerBps: undefined,
      authoritySignature: 'deadbeef',
      authorityIssuedAt: '2026-08-29T00:00:00.000Z',
    })
  })

  // RFC-021 D9 (2026-08-02) — additive params on an already-frozen method
  // (docs/API_STABLE.md's own "new optional parameters... are additive,
  // not breaking" precedent).
  it('resolveDispute() posts refundToAddress+splitBuyerBps for a SPLIT ruling', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'dispute-1', ruling: 'SPLIT' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await settlement.resolveDispute('dispute-1', 'SPLIT', '0xbuyer', '0xseller', 6000, 'deadbeef', '2026-08-29T00:00:00.000Z')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/disputes/dispute-1/resolve')
    expect(JSON.parse(init.body)).toEqual({
      ruling: 'SPLIT',
      releaseToAddress: '0xbuyer',
      refundToAddress: '0xseller',
      splitBuyerBps: 6000,
      authoritySignature: 'deadbeef',
      authorityIssuedAt: '2026-08-29T00:00:00.000Z',
    })
  })

  // Missão 13 Fase 2 (INV-12) — the server now requires a signed authority
  // decision; a caller who omits it gets a clear client-side error, never
  // a request the server would 400 on anyway.
  it('resolveDispute() throws SailsValidationError when authoritySignature/authorityIssuedAt are omitted, without ever calling fetch', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: {} })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await expect(settlement.resolveDispute('dispute-1', 'RELEASE', '0xbuyer')).rejects.toThrow(/authoritySignature/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Missão 13 Fase 2 (INV-12) — resolveDisputeWithWallet() is the
  // convenience path: it fetches the dispute for escrowId/appealRound/
  // arbiterId, builds the canonical decision, and signs it via the
  // wallet — the caller never constructs the signature by hand.
  it('resolveDisputeWithWallet() fetches the dispute, signs the canonical decision via the wallet, and forwards it to resolveDispute()', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ success: true, data: { id: 'dispute-1', escrowId: 'escrow-1', appealRound: 0, arbiterId: 'arbiter-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ success: true, data: { id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' } }),
      })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))
    const signMessage = jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]))

    const result = await settlement.resolveDisputeWithWallet('dispute-1', 'REFUND', { signMessage } as any)

    expect(result).toEqual({ id: 'dispute-1', status: 'RESOLVED', ruling: 'REFUND' })
    expect(signMessage).toHaveBeenCalledTimes(1)
    const [, resolveInit] = fetchImpl.mock.calls[1]
    const body = JSON.parse(resolveInit.body)
    expect(body.authoritySignature).toBe('01020304')
    expect(typeof body.authorityIssuedAt).toBe('string')
  })

  it('resolveDisputeWithWallet() throws SailsValidationError when the dispute has no assigned arbiter yet', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'dispute-1', escrowId: 'escrow-1', appealRound: 0, arbiterId: null } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))
    const signMessage = jest.fn()

    await expect(settlement.resolveDisputeWithWallet('dispute-1', 'REFUND', { signMessage } as any)).rejects.toThrow(/no assigned arbiter/)
    expect(signMessage).not.toHaveBeenCalled()
  })
})

describe('parseSafeGuardBundle() — the SAFE_GUARD_EVM guard-deployment gap closed 2026-08-02', () => {
  const realBundle = JSON.stringify({
    path: 'COOPERATIVE',
    userOpHash: 'abc123',
    toAddress: '0x' + '22'.repeat(20),
    guardAddress: '0x' + '33'.repeat(20),
    guardDeployment: { to: '0x4e59b44847b379578588920ca78fbf26c0b4956c', data: '0xdeadbeef' },
    userOp: { sender: '0x' + '11'.repeat(20) },
  })

  it('parses a real SAFE_GUARD_EVM bundle into its structured shape', () => {
    const parsed = parseSafeGuardBundle(realBundle)
    expect(parsed.guardAddress).toBe('0x' + '33'.repeat(20))
    expect(parsed.guardDeployment).toEqual({ to: '0x4e59b44847b379578588920ca78fbf26c0b4956c', data: '0xdeadbeef' })
    expect(parsed.toAddress).toBe('0x' + '22'.repeat(20))
  })

  it('rejects a MULTISIG-shaped PSBT (a literal base64 string, not JSON) with a clear error, not a garbage parse', () => {
    expect(() => parseSafeGuardBundle('cHNidP8BAHECAAAAAA==')).toThrow(/not valid JSON/)
  })

  it('rejects valid JSON that is missing guardAddress/guardDeployment (e.g. a different escrow type\'s bundle shape)', () => {
    const notASafeGuardBundle = JSON.stringify({ path: 'COOPERATIVE', userOpHash: 'abc', toAddress: '0x123' })
    expect(() => parseSafeGuardBundle(notASafeGuardBundle)).toThrow(/not a SAFE_GUARD_EVM bundle/)
  })

  it('rejects a bundle with guardAddress but no guardDeployment (malformed, not a real case, but must fail loudly)', () => {
    const malformed = JSON.stringify({ guardAddress: '0x' + '33'.repeat(20) })
    expect(() => parseSafeGuardBundle(malformed)).toThrow(/not a SAFE_GUARD_EVM bundle/)
  })
})

describe('SailsPeersModule', () => {
  it('start() posts to /v1/peers/start with auth and no body (key-custody fix, 2026-08-09 — server generates its own identity now)', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { peerId: 'abc123' } })
    const peers = new SailsPeersModule(authedTransport(fetchImpl))

    const result = await peers.start()

    expect(result.peerId).toBe('abc123')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/peers/start')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('joinTopic() posts to /v1/peers/join-topic', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: {} })
    const peers = new SailsPeersModule(authedTransport(fetchImpl))

    await peers.joinTopic('marketplace')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/peers/join-topic')
    expect(JSON.parse(init.body)).toEqual({ topic: 'marketplace' })
  })
})

describe('SailsOpenP2PModule', () => {
  it('trade() posts offerId+amount to /v1/openp2p/trades (the SDK_GUIDE.md deviation this module documents)', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'trade-1' } })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    await openp2p.trade('offer-1', '0.1')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/openp2p/trades')
    expect(JSON.parse(init.body)).toEqual({ offerId: 'offer-1', amount: '0.1' })
  })

  it('chat() throws if called before authenticate() (no session token)', () => {
    const openp2p = new SailsOpenP2PModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: jest.fn() as unknown as typeof fetch }))
    expect(() => openp2p.chat('trade-1')).toThrow(/active session/)
  })

  // Fase 2 (SDK React) — GET /v1/openp2p/trades didn't exist before
  // useSailsTrades() needed a real list endpoint (trade.routes.ts's own
  // comment has the full story). Requires auth, same as getTrade()/
  // getTradeByIntent() below (SECURITY_AUDIT_REPORT.md §2, closed
  // 2026-08-08 — both used to be unauthenticated).
  it('getTrades() hits GET /v1/openp2p/trades with auth, passing limit/offset as query params', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { trades: [], total: 0, hasMore: false } })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    const result = await openp2p.getTrades({ limit: 20, offset: 40 })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/openp2p/trades?limit=20&offset=40')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(result).toEqual({ trades: [], total: 0, hasMore: false })
  })

  it('getTrades() omits limit/offset from the query string when called with no arguments', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { trades: [], total: 0, hasMore: false } })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    await openp2p.getTrades()

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/v1/openp2p/trades')
  })

  it('getTrades() throws if called before authenticate() (no session token) — matches every other auth-required call in this module', async () => {
    const openp2p = new SailsOpenP2PModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: jest.fn() as unknown as typeof fetch }))
    await expect(openp2p.getTrades()).rejects.toThrow(/requires authentication/)
  })

  // SECURITY_AUDIT_REPORT.md §2, closed 2026-08-08 — GET /v1/openp2p/trades/:id
  // and .../trades/by-intent/:intentId used to be unauthenticated even
  // though a trade carries the full chat history and the seller's real
  // payment details; the backend now requires requireAuth + a
  // buyer/seller check, so the SDK must send the Bearer header.
  it('getTrade() hits GET /v1/openp2p/trades/:id with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' } })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    await openp2p.getTrade('trade-1')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/openp2p/trades/trade-1')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('getTrade() throws if called before authenticate() (no session token)', async () => {
    const openp2p = new SailsOpenP2PModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: jest.fn() as unknown as typeof fetch }))
    await expect(openp2p.getTrade('trade-1')).rejects.toThrow(/requires authentication/)
  })

  it('getTradeByIntent() hits GET /v1/openp2p/trades/by-intent/:intentId with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' } })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    await openp2p.getTradeByIntent('intent-1')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/openp2p/trades/by-intent/intent-1')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('getTradeByIntent() throws if called before authenticate() (no session token)', async () => {
    const openp2p = new SailsOpenP2PModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: jest.fn() as unknown as typeof fetch }))
    await expect(openp2p.getTradeByIntent('intent-1')).rejects.toThrow(/requires authentication/)
  })

  // chat.routes.ts, closed 2026-08-08 — GET /v1/openp2p/chat/:tradeId/messages
  // gained real limit/offset pagination; getMessages() previously typed its
  // return as a bare Message[], which would have shipped broken against the
  // new {items, total, hasMore, nextOffset} shape (same class of bug as
  // reputation.leaderboard() above).
  it('getMessages() hits GET /v1/openp2p/chat/:tradeId/messages with auth, passing limit/offset as query params', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { items: [], total: 0, hasMore: false, nextOffset: null } })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    const result = await openp2p.getMessages('trade-1', { limit: 20, offset: 10 })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/openp2p/chat/trade-1/messages?limit=20&offset=10')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(result).toEqual({ items: [], total: 0, hasMore: false, nextOffset: null })
  })

  it('getMessages() throws if called before authenticate() (no session token)', async () => {
    const openp2p = new SailsOpenP2PModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: jest.fn() as unknown as typeof fetch }))
    await expect(openp2p.getMessages('trade-1')).rejects.toThrow(/requires authentication/)
  })
})

// Minimal fake matching the WebSocket surface WebSocketChannel actually
// uses (addEventListener/send/close) — no real socket/network involved.
class FakeSocket {
  sent: string[] = []
  closed = false
  private listeners: Record<string, Array<(e: any) => void>> = {}
  addEventListener(type: string, handler: (e: any) => void) {
    (this.listeners[type] ??= []).push(handler)
  }
  send(data: string) {
    this.sent.push(data)
  }
  // A real WebSocket fires its own 'close' event after .close() is called
  // (the spec guarantees it, same as the 'error'-always-followed-by-'close'
  // guarantee this file's own class doc comment already relies on) — the
  // heartbeat's force-close (A-STA-03) depends on that same contract to
  // feed into the existing reconnect path, so this fake must honor it too.
  close() {
    this.closed = true
    this.emitClose()
  }
  emitOpen() {
    (this.listeners['open'] ?? []).forEach((h) => h({}))
  }
  emitMessage(data: unknown) {
    (this.listeners['message'] ?? []).forEach((h) => h({ data: JSON.stringify(data) }))
  }
  emitClose() {
    (this.listeners['close'] ?? []).forEach((h) => h({}))
  }
}

// WebSocketChannel's constructor now kicks off an async ticket-fetch-
// then-open (openSocket returns Promise<WebSocket> — security review,
// 2026-08-15, P1: chat() fetches a real single-use ticket before every
// connection attempt instead of reusing a raw session token) instead of
// attaching a socket synchronously. Every test below needs to let that
// resolve — a real setTimeout flush, not just one `await
// Promise.resolve()`, since the exact microtask-hop count through an
// async factory is an implementation detail not worth depending on.
function flushConnect(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('WebSocketChannel', () => {
  it('auto-joins the trade room as soon as the socket opens', async () => {
    const socket = new FakeSocket()
    new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1')
    await flushConnect()

    socket.emitOpen()

    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'JOIN_TRADE', payload: { tradeId: 'trade-1' } })
  })

  it('send() wraps content in a SEND_MESSAGE frame scoped to the channel\'s tradeId', async () => {
    const socket = new FakeSocket()
    const channel = new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1')
    await flushConnect()

    channel.send({ content: 'Sending payment now' })

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'SEND_MESSAGE',
      payload: { tradeId: 'trade-1', content: 'Sending payment now', msgType: 'TEXT' },
    })
  })

  it('onMessage() fires only for NEW_MESSAGE frames, onEvent() fires for every frame', async () => {
    const socket = new FakeSocket()
    const channel = new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1')
    await flushConnect()
    const messages: unknown[] = []
    const events: unknown[] = []
    channel.onMessage((m) => messages.push(m))
    channel.onEvent((e) => events.push(e))

    socket.emitMessage({ type: 'NEW_MESSAGE', payload: { id: 'msg-1', content: 'hi' } })
    socket.emitMessage({ type: 'TRADE_STATUS_UPDATE', payload: { status: 'ACTIVE' } })

    expect(messages).toEqual([{ id: 'msg-1', content: 'hi' }])
    expect(events).toHaveLength(2)
  })

  it('throws if send() is called before the first connection attempt resolves — no silent no-op', () => {
    const socket = new FakeSocket()
    const channel = new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1')
    // No flushConnect() — asserts the pre-connect window's real behavior.
    expect(() => channel.send({ content: 'too early' })).toThrow(/not connected yet/)
  })
})

// PRODUCTION_READINESS_REVIEW.md's High-severity finding #1 / docs/TODO.md's
// "No WebSocket reconnection logic anywhere in the client stack" entry,
// closed 2026-08-02. The factory (`() => socket`) below returns a NEW
// FakeSocket each call, exactly like a real WebSocket reconnect needs to
// (a closed real socket can never be reopened) — reconnectDelayMs kept
// tiny in every test so these stay fast.
describe('WebSocketChannel — reconnect with backoff', () => {
  it('reopens via the factory and re-JOINs the trade after the socket closes unexpectedly', async () => {
    const sockets: FakeSocket[] = []
    const channel = new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      { initialReconnectDelayMs: 1, maxReconnectDelayMs: 2 }
    )
    await flushConnect()
    sockets[0].emitOpen()
    expect(sockets).toHaveLength(1)

    sockets[0].emitClose() // unexpected drop, not a close() call
    await new Promise((r) => setTimeout(r, 20)) // let the scheduled reconnect fire

    expect(sockets).toHaveLength(2) // the factory was called again
    sockets[1].emitOpen()
    expect(JSON.parse(sockets[1].sent[0])).toEqual({ type: 'JOIN_TRADE', payload: { tradeId: 'trade-1' } })
  })

  it('does not reconnect after close() — the caller asked it to stop', async () => {
    const sockets: FakeSocket[] = []
    const channel = new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      { initialReconnectDelayMs: 1 }
    )
    await flushConnect()
    sockets[0].emitOpen()

    channel.close()
    sockets[0].emitClose()
    await new Promise((r) => setTimeout(r, 20))

    expect(sockets).toHaveLength(1) // no new socket opened
    expect(sockets[0].closed).toBe(true)
  })

  it('gives up after maxReconnectAttempts and reports connection state closed', async () => {
    const sockets: FakeSocket[] = []
    const states: string[] = []
    const channel = new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      { initialReconnectDelayMs: 1, maxReconnectDelayMs: 1, maxReconnectAttempts: 2 }
    )
    channel.onConnectionStateChange((s) => states.push(s))
    await flushConnect()

    // Every reconnected socket immediately closes again — never reaches 'open'.
    for (let i = 0; i < 5 && states[states.length - 1] !== 'closed'; i++) {
      sockets[sockets.length - 1].emitClose()
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(sockets).toHaveLength(3) // 1 initial + 2 retries, then gives up
    expect(states).toEqual(['reconnecting', 'reconnecting', 'closed'])
  })

  it('reconnect: false disables reconnection entirely — same behavior as before this pass', async () => {
    const sockets: FakeSocket[] = []
    const states: string[] = []
    const channel = new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      { reconnect: false }
    )
    channel.onConnectionStateChange((s) => states.push(s))
    await flushConnect()

    sockets[0].emitClose()
    await new Promise((r) => setTimeout(r, 20))

    expect(sockets).toHaveLength(1)
    expect(states).toEqual(['closed'])
  })

  it('resets the reconnect-attempt counter after a successful reconnect', async () => {
    const sockets: FakeSocket[] = []
    const states: string[] = []
    new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      { initialReconnectDelayMs: 1, maxReconnectDelayMs: 1, maxReconnectAttempts: 1 }
    ).onConnectionStateChange((s) => states.push(s))
    await flushConnect()

    sockets[0].emitClose() // attempt 1 of 1
    await new Promise((r) => setTimeout(r, 10))
    expect(sockets).toHaveLength(2)
    sockets[1].emitOpen() // succeeds — resets the counter back to 0

    sockets[1].emitClose() // a second, independent drop — should get a fresh budget, not "already used up"
    await new Promise((r) => setTimeout(r, 10))

    expect(sockets).toHaveLength(3)
    expect(states.filter((s) => s === 'closed')).toHaveLength(0)
  })
})

// CTO_DUE_DILIGENCE_REPORT.md A-STA-03, closed 2026-08-08 — "reconecta mas
// não detecta zombie connections (socket aberto mas sem tráfego)". Real
// timers (setInterval), kept as short as each test's own timing margin
// allows (some need real slack between the PONG cadence and the timeout
// to survive a full-suite parallel run — see the timeout tests' own
// comments), same style as the reconnect describe block above.
describe('WebSocketChannel — heartbeat (A-STA-03)', () => {
  it('sends a PING frame on the configured interval', async () => {
    const socket = new FakeSocket()
    new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1', { heartbeatIntervalMs: 5, heartbeatTimeoutMs: 1000 })
    await flushConnect()
    socket.emitOpen()

    await new Promise((r) => setTimeout(r, 20))

    const pings = socket.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'PING')
    expect(pings.length).toBeGreaterThan(0)
  })

  it('does not force-close while PONGs keep arriving within the timeout', async () => {
    const sockets: FakeSocket[] = []
    new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      // Wide margin between the PONG cadence and the timeout — found
      // flaky at 5ms/30ms under a full-suite parallel run (many other
      // suites' real buildApp() calls competing for the event loop delay
      // a 5ms setInterval past the 30ms threshold often enough to cause
      // a false-positive force-close). 20ms/300ms keeps the same "PONGs
      // keep arriving" behavior under test while tolerating real
      // scheduling jitter.
      { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 300 }
    )
    await flushConnect()
    sockets[0].emitOpen()

    // Answer every PING with a PONG, faster than the timeout.
    const interval = setInterval(() => sockets[0].emitMessage({ type: 'PONG', payload: {} }), 20)
    await new Promise((r) => setTimeout(r, 250))
    clearInterval(interval)

    expect(sockets[0].closed).toBe(false)
    expect(sockets).toHaveLength(1) // never force-closed, so no reconnect happened
  })

  it('force-closes (and reconnects) when no PONG arrives within heartbeatTimeoutMs — the zombie-connection case', async () => {
    const sockets: FakeSocket[] = []
    new WebSocketChannel(
      async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s as unknown as WebSocket
      },
      'trade-1',
      { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 40, initialReconnectDelayMs: 1, maxReconnectDelayMs: 1 }
    )
    await flushConnect()
    sockets[0].emitOpen()
    // Never answer with PONG — simulates a socket object that's still
    // "open" but whose underlying network path is dead.

    await new Promise((r) => setTimeout(r, 300))

    expect(sockets[0].closed).toBe(true) // the heartbeat force-closed it
    expect(sockets.length).toBeGreaterThan(1) // ...which fed into the real reconnect path
  })

  it('heartbeat: false disables PING entirely', async () => {
    const socket = new FakeSocket()
    new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1', { heartbeat: false, heartbeatIntervalMs: 5 })
    await flushConnect()
    socket.emitOpen()

    await new Promise((r) => setTimeout(r, 20))

    const pings = socket.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'PING')
    expect(pings).toHaveLength(0)
  })

  it('stops the heartbeat timer on close() — no PING sent after the caller closes', async () => {
    const socket = new FakeSocket()
    const channel = new WebSocketChannel(async () => socket as unknown as WebSocket, 'trade-1', { heartbeatIntervalMs: 5 })
    await flushConnect()
    socket.emitOpen()
    channel.close()
    socket.sent = [] // clear the JOIN_TRADE frame so only post-close activity shows up

    await new Promise((r) => setTimeout(r, 20))

    expect(socket.sent).toHaveLength(0)
  })
})

// Missão 07.5 — the external-Node reconnect-loop investigation confirmed
// this class's own factory (POST /v1/identity/ws-ticket then openWebSocket)
// was never actually exercised end-to-end by a test: every WebSocketChannel
// test above hands it a raw `async () => socket` factory, bypassing
// SailsOpenP2PModule.chat() entirely. The real bug turned out to be a stale
// npm publish (dist predated the 2026-08-15 ticket migration), not a source
// defect, but this gap — "does chat() really mint a NEW single-use ticket on
// every reconnect, not just the first connect" — was real and untested.
describe("SailsOpenP2PModule.chat() — ticket lifecycle (Missão 07.5)", () => {
  it('mints a fresh single-use ticket via POST /v1/identity/ws-ticket for the initial connection AND again for every reconnect', async () => {
    let ticketCounter = 0
    const urls: string[] = []
    const sockets: FakeSocket[] = []

    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith('/v1/identity/ws-ticket')) {
        ticketCounter += 1
        return { ok: true, status: 200, json: async () => ({ success: true, data: { ticket: `ticket-${ticketCounter}`, expiresIn: 30 } }) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super()
        urls.push(url)
        sockets.push(this)
      }
    }

    const transport = new SailsTransport({
      baseUrl: 'http://localhost:3000',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
    })
    transport.setSessionToken('session-abc')

    const openp2p = new SailsOpenP2PModule(transport)
    openp2p.chat('trade-1', { initialReconnectDelayMs: 1, maxReconnectDelayMs: 1 })

    await flushConnect()
    expect(ticketCounter).toBe(1)
    expect(urls[0]).toContain('ticket=ticket-1')

    // An unexpected drop must trigger a real reconnect — and since a ticket
    // is single-use by design, the reconnect attempt has no valid credential
    // to reuse even if it wanted to; it must go mint a brand new one.
    sockets[0].emitClose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await flushConnect()

    expect(ticketCounter).toBe(2)
    expect(urls[1]).toContain('ticket=ticket-2')
    expect(urls[1]).not.toBe(urls[0])
  })
})

describe('SailsSettlementModule — RFC-021 settlement gaps', () => {
  it('approveRelease() posts to /v1/settlement/escrow/:id/approve-release with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { approval: { id: 'appr-1', escrowId: 'escrow-1', approverId: 'participant-1', approvedAt: '2026-08-01T00:00:00Z' }, readyToRelease: false } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.approveRelease('escrow-1')

    expect(result.readyToRelease).toBe(false)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1/approve-release')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  // P3-F02 (Pre-M3 Reality Gate, 2026-09-13) — corrected from "no auth
  // required": that was already wrong when written (the comparison
  // point, get() above, has itself required auth since Missão 06.8 —
  // see its own "WITH auth" test below), and the real server route
  // (settlement.routes.ts) independently requires requireAuth +
  // party/arbiter scoping. Same class of bug Missão 07.1's own comment
  // (below, on get()/getDispute()) already warns about: a passing
  // 200-mock test stays green even with the bug, since fakeFetch
  // doesn't enforce auth — asserting the header directly is the point.
  it('getReleaseApprovals() hits GET /v1/settlement/escrow/:id/release-approvals WITH auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { approvals: [{ id: 'appr-1', escrowId: 'escrow-1', approverId: 'participant-1', approvedAt: '2026-08-01T00:00:00Z' }], readyToRelease: true } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.getReleaseApprovals('escrow-1')

    expect(result.readyToRelease).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1/release-approvals')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  // P3-F01 (Pre-M3 Reality Gate, 2026-09-13) — getPendingTransaction()
  // had no test coverage at all before this pass (same gap Missão 07.1
  // found for get()/getDispute()) and, like getReleaseApprovals() above,
  // was calling the server's party/arbiter-scoped pending-transaction
  // route with no Authorization header — 401 for every real caller.
  it('getPendingTransaction() hits GET /v1/settlement/escrow/:id/pending-transaction WITH auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'pending-1', escrowId: 'escrow-1', kind: 'release', toAddress: 'addr-1', unsignedPsbtBase64: 'cHNidA==', requiredSigners: ['buyer-1'], triggeredBy: 'buyer-1', createdAt: '2026-08-01T00:00:00Z', signatures: [] } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.getPendingTransaction('escrow-1')

    expect(result.escrowId).toBe('escrow-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1/pending-transaction')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 38, 2026-09-13) —
  // registerArbiter()/getArbiterProfile() (this module's own, wrong-
  // shaped duplicate of arbitration.ts's register()/getProfile()) were
  // deleted — see settlement.ts's own removal comment for the full
  // reasoning. The two tests that used to live here moved to
  // `SailsArbitrationModule`'s own describe block below, testing the
  // one canonical, correct, documented surface instead.

  // Missão 07.1 — get()/getDispute() were previously called with no `auth`
  // argument, so no Authorization header ever went out. Both backend routes
  // became party/arbiter-scoped (requireAuth) as of Missão 06.8, so every
  // real call 401'd unconditionally — never caught because neither method
  // had test coverage until this pass. Asserting the header directly (not
  // just "no throw") is the point: a passing 200-mock test would have
  // stayed green even with the bug, since fakeFetch doesn't enforce auth.
  it('get() hits GET /v1/settlement/escrow/:id WITH auth (Missão 06.8 made this a party-scoped read)', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'escrow-1', tradeId: 'trade-1', status: 'FUNDS_LOCKED' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.get('escrow-1')

    expect(result.id).toBe('escrow-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/escrow/escrow-1')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('getDispute() hits GET /v1/settlement/disputes/:id WITH auth (same Missão 06.8 fix)', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'dispute-1', tradeId: 'trade-1', status: 'OPENED' } })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.getDispute('dispute-1')

    expect(result.id).toBe('dispute-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/disputes/dispute-1')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  // M10 SDK Adapter — item 15 of the required implementation tests:
  // proves the SDK returns the server's semantic representation
  // verbatim, with zero recomputation/reinterpretation. The mocked
  // server body deliberately includes an UNSATISFIABLE conditionResult
  // and a null attribution/outcome (a shape no real endpoint returns
  // for a genuine ruling, but exactly the kind of edge case that would
  // reveal if the SDK were silently normalizing "falsy" fields away) —
  // asserting a byte-exact match proves getSemanticRecord() performs no
  // interpretation at all, only transport.
  it('getSemanticRecord() hits GET .../semantic-record?appealRound=N WITH auth, and returns the server body byte-exact (no recomputation)', async () => {
    const serverBody = {
      disputeId: 'dispute-1',
      escrowId: 'escrow-1',
      appealRound: 2,
      rulesetIdentity: { name: 'sails-mission13-dispute-ruling-ruleset', version: '1.0' },
      evaluatorIdentity: { name: 'sails-attribution-evaluator', version: '1.0' },
      profileIdentity: { name: 'sails-semantic-profile', version: '1.0' },
      // Deliberately UNSATISFIABLE, not the "happy path" SATISFIED — if
      // the SDK ever collapsed this to a falsy/generic value, this
      // assertion would catch it.
      conditionResult: 'UNSATISFIABLE',
      // Deliberately null, not omitted — proves the SDK doesn't
      // silently coerce null into undefined, an empty object, or throw.
      attribution: null,
      outcome: null,
    }
    const fetchImpl = fakeFetch(200, { success: true, data: serverBody })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    const result = await settlement.getSemanticRecord('dispute-1', 2)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/disputes/dispute-1/semantic-record?appealRound=2')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(result).toEqual(serverBody)
  })

  it('getSemanticRecord() throws SailsNotFoundError on a 404 — never returns a fabricated record or conditionResult: UNKNOWN', async () => {
    const fetchImpl = fakeFetch(404, { success: false, error: 'NOT_FOUND', message: 'semantic record for dispute dispute-1 not found: appealRound=5' })
    const settlement = new SailsSettlementModule(authedTransport(fetchImpl))

    await expect(settlement.getSemanticRecord('dispute-1', 5)).rejects.toMatchObject({ name: 'SailsNotFoundError' })
  })
})

// CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 38, 2026-09-13) — the one
// canonical SDK surface for the arbitration register/profile routes,
// replacing SailsSettlementModule's own now-deleted, wrong-shaped
// duplicate (registerArbiter()/getArbiterProfile()/ArbiterProfile — see
// settlement.ts's own removal comment). Response shapes below match
// market-arbitration.provider.ts's real toCandidate() field names
// exactly (participantId/monetaryCollateral/collateralAsset/
// arbiterReputation/effectiveStake), not the wrong shape the deleted
// duplicate used to assert.
describe('SailsArbitrationModule', () => {
  it('register() posts to /v1/settlement/arbitration/register with auth, returning the real ArbiterCandidate shape', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { participantId: 'participant-1', monetaryCollateral: '1000000', collateralAsset: 'BTC', arbiterReputation: 0, effectiveStake: 1000000, cumulativeFeesObserved: '0' } })
    const arbitration = new SailsArbitrationModule(authedTransport(fetchImpl))

    const result = await arbitration.register('1000000')

    expect(result).toEqual({ participantId: 'participant-1', monetaryCollateral: '1000000', collateralAsset: 'BTC', arbiterReputation: 0, effectiveStake: 1000000, cumulativeFeesObserved: '0' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/arbitration/register')
    expect(JSON.parse(init.body)).toEqual({ monetaryCollateral: '1000000', collateralAsset: undefined })
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('getProfile() hits GET /v1/settlement/arbitration/profile/:id with no auth header, returning a nullable collateralAsset and the real cumulativeFeesObserved field', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { participantId: 'participant-1', monetaryCollateral: '1000000', collateralAsset: null, arbiterReputation: 85, effectiveStake: 1000850, cumulativeFeesObserved: '12.5' } })
    const arbitration = new SailsArbitrationModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch }))

    const result = await arbitration.getProfile('participant-1')

    expect(result.collateralAsset).toBeNull()
    expect(result.arbiterReputation).toBe(85)
    expect(result.cumulativeFeesObserved).toBe('12.5')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/settlement/arbitration/profile/participant-1')
    expect(init.headers.authorization).toBeUndefined()
  })

  it('getProfile() throws SailsNotFoundError on a 404 — never resolves null (the deleted duplicate\'s own `| null` return type was unreachable for exactly this reason)', async () => {
    const fetchImpl = fakeFetch(404, { success: false, error: 'NOT_FOUND', message: 'ArbiterProfile not found: participant-2' })
    const arbitration = new SailsArbitrationModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch }))

    await expect(arbitration.getProfile('participant-2')).rejects.toMatchObject({ name: 'SailsNotFoundError' })
  })
})

describe('SailsOpenP2PModule — reconcileTrade()', () => {
  it('reconcileTrade() posts sinceMessageCreatedAt to /v1/openp2p/trades/:id/reconcile with auth', async () => {
    // The real ReconciliationResult shape (reconciliation.service.ts) —
    // this mock used to be a bare message array, matching the SDK's old
    // (wrong) Message[] declaration instead of what the route returns.
    const fetchImpl = fakeFetch(200, {
      success: true,
      data: {
        tradeId: 'trade-1',
        currentTradeStatus: 'ACTIVE',
        currentEscrowStatus: 'FUNDS_LOCKED',
        missedMessages: [{ id: 'msg-1', senderId: 'seller', content: 'Payment sent', msgType: 'TEXT', createdAt: '2026-08-01T00:00:00.000Z' }],
      },
    })
    const openp2p = new SailsOpenP2PModule(authedTransport(fetchImpl))

    const result = await openp2p.reconcileTrade('trade-1', new Date('2026-07-01T00:00:00Z'))

    expect(result.tradeId).toBe('trade-1')
    expect(result.currentTradeStatus).toBe('ACTIVE')
    expect(result.currentEscrowStatus).toBe('FUNDS_LOCKED')
    expect(result.missedMessages).toHaveLength(1)
    expect(result.missedMessages[0].createdAt).toBe('2026-08-01T00:00:00.000Z')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/openp2p/trades/trade-1/reconcile')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    const body = JSON.parse(init.body)
    expect(body.sinceMessageCreatedAt).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('SailsReputationModule — getScoreByPeerId()', () => {
  // Missão 11 Fase 9.3.6 — PUBLIC CONTRACT INTEGRITY. This mock
  // previously used `id`/`publicKey`/`reputationScore`/`disputeCount`,
  // none of which reputation.service.ts's getScore() has ever actually
  // returned (traced directly — it returns participantId/total/
  // tradeScore/volumeScore/settlementScore/disputeRate/totalTrades/
  // cumulativeFeesObserved). The old mock passed only because it was
  // self-consistent with the SDK type's own (also wrong) declaration,
  // never cross-checked against the real server — the same blind spot
  // that let packages/sdk-react's ReputationBadge go unnoticed.
  it('getScoreByPeerId() hits GET /v1/reputation/peer/:peerId', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { participantId: 'rep-1', total: 85, tradeScore: 0, volumeScore: 0, settlementScore: 0, disputeRate: 0, totalTrades: 10, cumulativeFeesObserved: '0' } })
    const reputation = new SailsReputationModule(new SailsTransport({ baseUrl: 'http://localhost:3000', fetchImpl: fetchImpl as unknown as typeof fetch }))

    const result = await reputation.getScoreByPeerId('peer-abc123')

    expect(result.total).toBe(85)
    expect(result.participantId).toBe('rep-1')
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/reputation/peer/peer-abc123')
  })
})

describe('SailsProofModule', () => {
  it('assertClaim() posts to /v1/proof/claims with auth', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'claim-1', claimType: 'payment_sent', assertion: { intentId: 'intent-1' }, claimedBy: 'participant-1', createdAt: '2026-08-01T00:00:00Z' } })
    const proof = new SailsProofModule(authedTransport(fetchImpl))

    const result = await proof.assertClaim({ claimType: 'payment_sent', assertion: { intentId: 'intent-1' } })

    expect(result.id).toBe('claim-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/proof/claims')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual({ claimType: 'payment_sent', assertion: { intentId: 'intent-1' } })
  })

  it('submitProof() posts to /v1/proof/proofs with auth', async () => {
    const fetchImpl = fakeFetch(201, { success: true, data: { id: 'proof-1', claimId: 'claim-1', evidenceHash: 'abc123', submittedBy: 'participant-1', createdAt: '2026-08-01T00:00:00Z' } })
    const proof = new SailsProofModule(authedTransport(fetchImpl))

    const result = await proof.submitProof({ claimId: 'claim-1', evidence: { amount: '500' } })

    expect(result.id).toBe('proof-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/proof/proofs')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual({ claimId: 'claim-1', evidence: { amount: '500' } })
  })

  it('issueVerificationNonce() posts to /v1/proof/proofs/:id/verify-nonce with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { nonce: 'nonce-abc-123' } })
    const proof = new SailsProofModule(authedTransport(fetchImpl))

    const result = await proof.issueVerificationNonce('proof-1')

    expect(result.nonce).toBe('nonce-abc-123')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/proof/proofs/proof-1/verify-nonce')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })

  it('verifyProof() posts verdict to /v1/proof/proofs/:id/verify with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { id: 'proof-1', claimId: 'claim-1', evidenceHash: 'abc123', submittedBy: 'arbiter-1', submittedAt: '2026-08-01T00:00:00Z' } })
    const proof = new SailsProofModule(authedTransport(fetchImpl))

    const result = await proof.verifyProof('proof-1', { verdict: 'ACCEPTED', nonce: 'nonce-abc-123' })

    expect(result.id).toBe('proof-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/proof/proofs/proof-1/verify')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual({ verdict: 'ACCEPTED', nonce: 'nonce-abc-123' })
  })

  it('getEvidenceBundle() hits GET /v1/proof/claims/:id/bundle with auth', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { claim: { id: 'claim-1', claimType: 'payment_sent', assertion: { intentId: 'intent-1' }, claimedBy: 'participant-1', createdAt: '2026-08-01T00:00:00Z' }, proofs: [] } })
    const proof = new SailsProofModule(authedTransport(fetchImpl))

    const result = await proof.getEvidenceBundle('claim-1')

    expect(result.claim.id).toBe('claim-1')
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/proof/claims/claim-1/bundle')
  })

  // Missão 07.1 — getTradeEvidenceBundle() was previously called with no
  // `auth` argument (its own doc comment even claimed "public read, no
  // session required"). The real route became trade-participant-scoped as
  // of Missão 06.6, so every real call 401'd unconditionally — zero prior
  // test coverage meant this went undetected until Missão 07's golden-path
  // audit. Asserting the header directly is the point, same reasoning as
  // the settlement.get()/getDispute() fix above.
  it('getTradeEvidenceBundle() hits GET /v1/proof/trades/:id/bundle WITH auth (Missão 06.6 made this participant-scoped)', async () => {
    const fetchImpl = fakeFetch(200, { success: true, data: { claims: [], proofs: [], verifications: [], evidence: [], timeline: [] } })
    const proof = new SailsProofModule(authedTransport(fetchImpl))

    await proof.getTradeEvidenceBundle('trade-1')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/proof/trades/trade-1/bundle')
    expect(init.headers.authorization).toBe('Bearer session-abc')
  })
})

describe('SailsAgentsModule', () => {
  it('generateTradeIntent() posts to /v1/agents/generate-trade-intent with auth', async () => {
    const fetchImpl = fakeFetch(200, {
      success: true,
      data: { asset: 'BTC', side: 'BUY', maxValue: '500', minValue: '50', currency: 'BRL', fiatMethod: 'PIX' },
    })
    const agents = new SailsAgentsModule(authedTransport(fetchImpl))

    const result = await agents.generateTradeIntent('quero comprar até 500 reais em BTC via PIX')

    expect(result.asset).toBe('BTC')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/agents/generate-trade-intent')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual({ goal: 'quero comprar até 500 reais em BTC via PIX' })
  })

  it('generateOfferIntent() posts to /v1/agents/generate-offer-intent with auth', async () => {
    const fetchImpl = fakeFetch(200, {
      success: true,
      data: { asset: 'BTC', side: 'SELL', minAmount: '0.001', maxAmount: '0.5', paymentMethod: 'PIX' },
    })
    const agents = new SailsAgentsModule(authedTransport(fetchImpl))

    const result = await agents.generateOfferIntent('quero vender bitcoin recebendo via PIX')

    expect(result.paymentMethod).toBe('PIX')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/agents/generate-offer-intent')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual({ goal: 'quero vender bitcoin recebendo via PIX' })
  })

  it('assessIntentRisk() posts to /v1/agents/assess-intent-risk with auth', async () => {
    const fetchImpl = fakeFetch(200, {
      success: true,
      data: { risk: 'low', reasoning: 'Amount and payment method are consistent.', recommendation: 'proceed' },
    })
    const agents = new SailsAgentsModule(authedTransport(fetchImpl))

    const intent = { asset: 'BTC' as const, side: 'BUY' as const, maxValue: '500', minValue: '50', currency: 'BRL', fiatMethod: 'PIX' as const }
    const result = await agents.assessIntentRisk(intent)

    expect(result.recommendation).toBe('proceed')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:3000/v1/agents/assess-intent-risk')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer session-abc')
    expect(JSON.parse(init.body)).toEqual(intent)
  })
})
