// tests/priceSourceSelection.test.ts
//
// #235 R7H-E2 — price source adapters and agreeing-set selection, without a database. Payload fixtures are the
// live shapes captured from each public endpoint on 2026-10-08; transport faults are exercised through the real
// boundedFetch() against a local HTTP server.

import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { Prisma } from '@prisma/client'
import { assertIndependentSources, BITSTAMP, COINBASE, GEMINI, KRAKEN, observe, PriceSourceError, type PriceSource, type SourceObservation } from '../src/modules/open-valuation/price-sources'
import { selectAgreeingSet, type QuotePolicy } from '../src/modules/open-valuation/quote-selection'

const LIVE = {
  KRAKEN: { error: [], result: { XXBTZUSD: { a: ['82750.20000', '1', '1.000'], b: ['82750.10000', '1', '1.000'], c: ['82754.90000', '0.00020000'], o: '83276.10000' } } },
  COINBASE: { ask: '82752.46', bid: '82750.77', price: '82752.62', size: '0.00562885', time: '2026-10-08T10:31:47.091108428Z' },
  BITSTAMP: { timestamp: '1791455507', last: '82756.43', bid: '82756.43', ask: '82756.44' },
  GEMINI: { bid: '82766.30000', ask: '82766.31000', last: '82774.56000', volume: { BTC: '208.85158623', timestamp: 1791455460000 } },
}

const V1: QuotePolicy = { quoteWindowSeconds: 30, quotePublicationMaxSeconds: 10, maxSourceDisagreementBps: 100, minAgreeingOperators: 2, sourceMaxAgeSeconds: 60, sourceFutureSkewSeconds: 15 }
const AS_OF = new Date('2026-10-08T10:31:50.000Z')

function obs(operator: string, price: string, sourceTs: Date | null = new Date(AS_OF.getTime() - 2_000)): SourceObservation {
  return { operator, price: new Prisma.Decimal(price), sourceTimestamp: sourceTs, collectedAt: new Date(AS_OF.getTime() + 300), payloadSha256: '0'.repeat(64) }
}

describe('#235 R7H-E2 — price source adapters', () => {
  it('parse the live payload shapes into exact decimals and source timestamps', () => {
    expect(KRAKEN.parse(LIVE.KRAKEN)).toEqual({ price: new Prisma.Decimal('82754.9'), sourceTimestamp: null })
    expect(COINBASE.parse(LIVE.COINBASE)).toEqual({ price: new Prisma.Decimal('82752.62'), sourceTimestamp: new Date('2026-10-08T10:31:47.091Z') })
    expect(BITSTAMP.parse(LIVE.BITSTAMP)).toEqual({ price: new Prisma.Decimal('82756.43'), sourceTimestamp: new Date(1791455507 * 1000) })
    expect(GEMINI.parse(LIVE.GEMINI)).toEqual({ price: new Prisma.Decimal('82774.56'), sourceTimestamp: new Date(1791455460000) })
    expect([KRAKEN, COINBASE, BITSTAMP, GEMINI].map((s) => [s.operator, s.reserve])).toEqual([['KRAKEN', false], ['COINBASE', false], ['BITSTAMP', false], ['GEMINI', true]])
  })

  it.each([
    ['a JSON-number price (already a float)', COINBASE, { ...LIVE.COINBASE, price: 82752.62 }],
    ['a negative price', BITSTAMP, { ...LIVE.BITSTAMP, last: '-82756.43' }],
    ['a zero price', BITSTAMP, { ...LIVE.BITSTAMP, last: '0' }],
    ['a price finer than 8 decimal places', GEMINI, { ...LIVE.GEMINI, last: '82774.123456789' }],
    ['an exponent price', COINBASE, { ...LIVE.COINBASE, price: '8.2e4' }],
    ['a price with a leading zero / sign / spaces', COINBASE, { ...LIVE.COINBASE, price: ' 082752.62' }],
    ['more than 16 integer digits', BITSTAMP, { ...LIVE.BITSTAMP, last: '12345678901234567.0' }],
    ['a missing price', BITSTAMP, { timestamp: '1791455507' }],
    ['a Kraken error', KRAKEN, { error: ['EService:Unavailable'], result: {} }],
    ['two Kraken pairs', KRAKEN, { error: [], result: { XXBTZUSD: LIVE.KRAKEN.result.XXBTZUSD, XETHZUSD: LIVE.KRAKEN.result.XXBTZUSD } }],
    ['a non-UTC Coinbase time', COINBASE, { ...LIVE.COINBASE, time: '2026-10-08T10:31:47+02:00' }],
    ['a Bitstamp timestamp in milliseconds as a number', BITSTAMP, { ...LIVE.BITSTAMP, timestamp: 1791455507000 }],
    ['a Gemini timestamp as a string', GEMINI, { ...LIVE.GEMINI, volume: { timestamp: '1791455460000' } }],
    ['a null payload', KRAKEN, null],
  ])('refuse %s', (_label, source, payload) => {
    expect(() => source.parse(payload)).toThrow(PriceSourceError)
  })

  it('refuse a source list in which one operator could count twice', () => {
    expect(() => assertIndependentSources([KRAKEN, COINBASE, BITSTAMP, GEMINI])).not.toThrow()
    expect(() => assertIndependentSources([KRAKEN, { ...COINBASE, operator: 'KRAKEN' }])).toThrow(/listed twice/)
    expect(() => assertIndependentSources([COINBASE, { ...COINBASE, operator: 'COINBASE_MIRROR' }])).toThrow(/share the endpoint host/)
    expect(() => assertIndependentSources([COINBASE, { ...COINBASE, operator: 'COINBASE_PRO', url: 'https://API.EXCHANGE.COINBASE.COM/products/BTC-USD/ticker' }])).toThrow(/share the endpoint host/)
    expect(() => assertIndependentSources([{ ...KRAKEN, operator: 'kraken' }])).toThrow(/canonical/)
  })
})

describe('#235 R7H-E2 — source transport faults (real boundedFetch, local server)', () => {
  let server: Server
  let base = ''
  const routes: Record<string, (res: import('http').ServerResponse) => void> = {}
  beforeAll(async () => {
    server = createServer((req, res) => (routes[req.url ?? ''] ?? ((r) => { r.statusCode = 404; r.end() }))(res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  const at = (path: string, src: PriceSource = BITSTAMP): PriceSource => ({ ...src, url: `${base}${path}` })
  const clock = () => new Date('2026-10-08T10:31:51.000Z')

  it('a valid response is an observation with the payload digest of the exact bytes received', async () => {
    const body = JSON.stringify(LIVE.BITSTAMP)
    routes['/ok'] = (res) => res.end(body)
    const r = await observe(at('/ok'), 1000, clock)
    expect(r).toMatchObject({ operator: 'BITSTAMP', collectedAt: clock(), payloadSha256: require('crypto').createHash('sha256').update(body).digest('hex') })
    expect((r as SourceObservation).price.toFixed()).toBe('82756.43')
  })

  it.each([
    ['HTTP 500', (res: import('http').ServerResponse) => { res.statusCode = 500; res.end('{}') }, /HTTP 500/],
    ['HTTP 429', (res: import('http').ServerResponse) => { res.statusCode = 429; res.end('{}') }, /HTTP 429/],
    ['a non-JSON body', (res: import('http').ServerResponse) => res.end('<html>maintenance</html>'), /not JSON/],
    ['a malformed price', (res: import('http').ServerResponse) => res.end(JSON.stringify({ ...LIVE.BITSTAMP, last: 82756.43 })), /decimal string/],
    ['a stalled response (timeout)', (_res: import('http').ServerResponse) => undefined, /timed out/],
    ['an oversized body', (res: import('http').ServerResponse) => res.end('x'.repeat(64 * 1024)), /exceeded/],
  ])('%s is a failure, never a price', async (_label, route, reason) => {
    routes['/fault'] = route
    const r = await observe(at('/fault'), 300, clock)
    expect(r).toEqual({ operator: 'BITSTAMP', reason: expect.stringMatching(reason) })
  })

  it('an unreachable source is a failure', async () => {
    const r = await observe({ ...BITSTAMP, url: 'http://127.0.0.1:1/unreachable' }, 500, clock)
    expect(r).toMatchObject({ operator: 'BITSTAMP', reason: expect.any(String) })
    expect('price' in r).toBe(false)
  })
})

describe('#235 R7H-E2 — agreeing-set selection', () => {
  it('three agreeing primaries: all accepted; the authorization price is the maximum, the median exact', () => {
    const s = selectAgreeingSet(AS_OF, [obs('KRAKEN', '82754.9', null), obs('COINBASE', '82752.62'), obs('BITSTAMP', '82756.43')], V1)
    expect(s).toMatchObject({ ok: true, excluded: [], summary: { priceMaxUsd: '82756.43000000', priceMedianUsd: '82754.90000000', observationCount: 3, sourceSpreadBps: 1 } })
  })

  it('an extreme price never dominates: it is excluded, and the max comes from the agreeing pair', () => {
    const s = selectAgreeingSet(AS_OF, [obs('KRAKEN', '82754.9', null), obs('COINBASE', '165000'), obs('BITSTAMP', '82756.43')], V1)
    expect(s).toMatchObject({ ok: true, summary: { priceMaxUsd: '82756.43000000', observationCount: 2 }, excluded: [{ operator: 'COINBASE', reason: 'OUTSIDE_AGREEMENT', price: '165000' }] })
    const low = selectAgreeingSet(AS_OF, [obs('KRAKEN', '82754.9', null), obs('COINBASE', '1'), obs('BITSTAMP', '82756.43')], V1)
    expect(low).toMatchObject({ ok: true, summary: { priceMaxUsd: '82756.43000000' }, excluded: [{ operator: 'COINBASE', reason: 'OUTSIDE_AGREEMENT' }] })
  })

  it('agreement is exact at the 1 % boundary (100 bps of the median), and refused one unit beyond it', () => {
    // 100 and 101: spread 1 x 10000 = 10000 <= 100 x median 100.5 = 10050.
    expect(selectAgreeingSet(AS_OF, [obs('COINBASE', '100'), obs('BITSTAMP', '101')], V1)).toMatchObject({ ok: true, summary: { sourceSpreadBps: 100 } })
    // 100 and 101.01: 10100 > 100 x 100.505 = 10050.5.
    expect(selectAgreeingSet(AS_OF, [obs('COINBASE', '100'), obs('BITSTAMP', '101.01')], V1)).toMatchObject({ ok: false, reason: 'INSUFFICIENT_AGREEMENT' })
    // 199 and 201: spread 2 x 10000 = 20000 = 100 x median 200, exactly at the bound: accepted.
    const edge = selectAgreeingSet(AS_OF, [obs('COINBASE', '199'), obs('BITSTAMP', '201')], V1)
    expect(edge).toMatchObject({ ok: true, summary: { sourceSpreadBps: 100 } })
  })

  it('two disagreeing groups of the same size are ambiguous: nothing is selected, never a pick', () => {
    const s = selectAgreeingSet(AS_OF, [obs('KRAKEN', '80000', null), obs('COINBASE', '80010'), obs('BITSTAMP', '85000'), obs('GEMINI', '85010')], V1)
    expect(s).toMatchObject({ ok: false, reason: 'AMBIGUOUS_AGREEMENT' })
    // A chain (each neighbour agrees, the ends do not) is ambiguous too.
    expect(selectAgreeingSet(AS_OF, [obs('KRAKEN', '100', null), obs('COINBASE', '100.9'), obs('BITSTAMP', '101.8')], V1)).toMatchObject({ ok: false, reason: 'AMBIGUOUS_AGREEMENT' })
  })

  it('stale and future source timestamps are excluded before agreement; a stale source cannot make a quote eligible', () => {
    const stale = new Date(AS_OF.getTime() - 61_000)
    const future = new Date(AS_OF.getTime() + 16_000)
    const s = selectAgreeingSet(AS_OF, [obs('KRAKEN', '82754.9', null), obs('COINBASE', '82752.62', stale), obs('BITSTAMP', '82756.43', future)], V1)
    expect(s).toMatchObject({ ok: false, reason: 'INSUFFICIENT_AGREEMENT' })
    expect(s.excluded.map((e) => [e.operator, e.reason])).toEqual([['COINBASE', 'STALE_SOURCE_TIMESTAMP'], ['BITSTAMP', 'FUTURE_SOURCE_TIMESTAMP'], ['KRAKEN', 'OUTSIDE_AGREEMENT']])
    // At the bounds exactly: accepted.
    const edge = selectAgreeingSet(AS_OF, [obs('COINBASE', '82752.62', new Date(AS_OF.getTime() - 60_000)), obs('BITSTAMP', '82756.43', new Date(AS_OF.getTime() + 15_000))], V1)
    expect(edge).toMatchObject({ ok: true })
  })

  it('an agreeing set without any source timestamp is refused (Kraken alone carries none)', () => {
    expect(selectAgreeingSet(AS_OF, [obs('KRAKEN', '82754.9', null), obs('OTHER_NO_TS', '82755', null)], V1)).toMatchObject({ ok: false, reason: 'NO_TIMESTAMPED_SOURCE' })
  })

  it('fewer than the policy minimum is refused; the minimum is read from the policy, not hard-coded', () => {
    expect(selectAgreeingSet(AS_OF, [obs('COINBASE', '82752.62')], V1)).toMatchObject({ ok: false, reason: 'INSUFFICIENT_AGREEMENT' })
    expect(selectAgreeingSet(AS_OF, [], V1)).toMatchObject({ ok: false, reason: 'INSUFFICIENT_AGREEMENT' })
    expect(selectAgreeingSet(AS_OF, [obs('COINBASE', '82752.62'), obs('BITSTAMP', '82756.43')], { ...V1, minAgreeingOperators: 3 })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_AGREEMENT' })
  })

  it('exact decimals: the median of an even set rounds half-up at 8 places; no float enters', () => {
    const s = selectAgreeingSet(AS_OF, [obs('COINBASE', '100.00000001'), obs('BITSTAMP', '100.00000002')], V1)
    expect(s).toMatchObject({ ok: true, summary: { priceMaxUsd: '100.00000002', priceMedianUsd: '100.00000002', sourceSpreadBps: 1 } })
  })
})
