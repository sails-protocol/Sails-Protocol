/**
 * #235 R7H-E2 — independent BTC/USD price sources for the canonical valuation quote.
 *
 * Each source is one exchange operator, named by this file (never by its payload): the operator name is the
 * database's independence key (price_observations UNIQUE(quoteId, operator)). A source list is refused when two
 * entries share an operator or an endpoint host, so one operator can never be counted twice.
 *
 * Prices stay decimal strings from the wire to the database: a payload whose price is a JSON number (already a
 * float), negative, zero or finer than the schema's 8 decimal places is malformed, never rounded into shape.
 *
 * Payload formats verified against the live public endpoints (2026-10-08):
 *   Kraken    result.<pair>.c[0]           last trade price; no timestamp
 *   Coinbase  price, time (ISO 8601)        last trade
 *   Bitstamp  last, timestamp (unix s)      last trade
 *   Gemini    last, volume.timestamp (ms)   last trade; reserve source (its timestamp lags by up to a minute)
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { boundedFetch } from '../open-settlement/bounded-rpc'

/** Tickers are a few hundred bytes; anything far larger is not a ticker. */
const MAX_TICKER_BYTES = 16 * 1024

/** Schema Decimal(24, 8): at most 16 integer digits and 8 decimal places. */
const DECIMAL_PRICE = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/

export class PriceSourceError extends Error {
  constructor(readonly operator: string, message: string) {
    super(`${operator}: ${message}`)
    this.name = 'PriceSourceError'
  }
}

export interface ParsedTicker {
  price: Prisma.Decimal
  sourceTimestamp: Date | null
}

export interface PriceSource {
  /** Canonical operator id: upper-case, unique in a source list. */
  operator: string
  url: string
  /** Consulted only when the primary sources alone yield no agreeing set. */
  reserve: boolean
  parse: (payload: unknown) => ParsedTicker
}

export interface SourceObservation {
  operator: string
  price: Prisma.Decimal
  sourceTimestamp: Date | null
  /** Database-anchored time the response was fully read. */
  collectedAt: Date
  payloadSha256: string
}

export interface SourceFailure {
  operator: string
  reason: string
}

function decimalPrice(operator: string, value: unknown): Prisma.Decimal {
  if (typeof value !== 'string' || !DECIMAL_PRICE.test(value)) {
    throw new PriceSourceError(operator, `price must be a decimal string with at most 8 decimal places, got ${JSON.stringify(value)}`)
  }
  const price = new Prisma.Decimal(value)
  if (price.lte(0)) throw new PriceSourceError(operator, `price must be positive, got ${value}`)
  return price
}

function field(operator: string, payload: unknown, ...path: Array<string | number>): unknown {
  let at: unknown = payload
  for (const key of path) {
    if (at === null || typeof at !== 'object' || !(key in (at as object))) {
      throw new PriceSourceError(operator, `payload has no ${path.join('.')}`)
    }
    at = (at as Record<string | number, unknown>)[key]
  }
  return at
}

function validDate(operator: string, ms: number, raw: unknown): Date {
  if (!Number.isFinite(ms)) throw new PriceSourceError(operator, `timestamp is not a valid time: ${JSON.stringify(raw)}`)
  return new Date(ms)
}

export const KRAKEN: PriceSource = {
  operator: 'KRAKEN',
  url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  reserve: false,
  parse(payload) {
    const errors = field('KRAKEN', payload, 'error')
    if (!Array.isArray(errors) || errors.length) throw new PriceSourceError('KRAKEN', `error ${JSON.stringify(errors)}`)
    const result = field('KRAKEN', payload, 'result')
    const pairs = result && typeof result === 'object' ? Object.keys(result) : []
    if (pairs.length !== 1) throw new PriceSourceError('KRAKEN', `expected exactly one pair, got ${JSON.stringify(pairs)}`)
    return { price: decimalPrice('KRAKEN', field('KRAKEN', result, pairs[0], 'c', 0)), sourceTimestamp: null }
  },
}

export const COINBASE: PriceSource = {
  operator: 'COINBASE',
  url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
  reserve: false,
  parse(payload) {
    const time = field('COINBASE', payload, 'time')
    const match = typeof time === 'string' ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(time) : null
    if (!match) throw new PriceSourceError('COINBASE', `time must be an ISO 8601 UTC timestamp, got ${JSON.stringify(time)}`)
    const ms = Date.parse(`${match[1]}${(match[2] ?? '.000').slice(0, 4).padEnd(4, '0')}Z`)
    return { price: decimalPrice('COINBASE', field('COINBASE', payload, 'price')), sourceTimestamp: validDate('COINBASE', ms, time) }
  },
}

export const BITSTAMP: PriceSource = {
  operator: 'BITSTAMP',
  url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
  reserve: false,
  parse(payload) {
    const ts = field('BITSTAMP', payload, 'timestamp')
    if (typeof ts !== 'string' || !/^\d{1,12}$/.test(ts)) throw new PriceSourceError('BITSTAMP', `timestamp must be unix seconds, got ${JSON.stringify(ts)}`)
    return { price: decimalPrice('BITSTAMP', field('BITSTAMP', payload, 'last')), sourceTimestamp: validDate('BITSTAMP', Number(ts) * 1000, ts) }
  },
}

export const GEMINI: PriceSource = {
  operator: 'GEMINI',
  url: 'https://api.gemini.com/v1/pubticker/btcusd',
  reserve: true,
  parse(payload) {
    const ts = field('GEMINI', payload, 'volume', 'timestamp')
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) throw new PriceSourceError('GEMINI', `volume.timestamp must be unix milliseconds, got ${JSON.stringify(ts)}`)
    return { price: decimalPrice('GEMINI', field('GEMINI', payload, 'last')), sourceTimestamp: validDate('GEMINI', ts, ts) }
  },
}

export const DEFAULT_PRICE_SOURCES: readonly PriceSource[] = [KRAKEN, COINBASE, BITSTAMP, GEMINI]

/**
 * Refuses a source list in which one operator could be counted twice: duplicate operator ids, an operator id
 * that is not canonical, or two sources reaching the same endpoint host (an alias of the same operator).
 */
export function assertIndependentSources(sources: readonly PriceSource[]): void {
  const operators = new Set<string>()
  const hosts = new Map<string, string>()
  for (const s of sources) {
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(s.operator)) throw new Error(`price source operator ${JSON.stringify(s.operator)} is not a canonical id`)
    if (operators.has(s.operator)) throw new Error(`price source operator ${s.operator} is listed twice`)
    operators.add(s.operator)
    const host = new URL(s.url).host.toLowerCase()
    const other = hosts.get(host)
    if (other) throw new Error(`price sources ${other} and ${s.operator} share the endpoint host ${host}: not independent operators`)
    hosts.set(host, s.operator)
  }
}

/**
 * Fetches and parses one source. Never throws: a timeout, transport error, non-200 status, oversized or malformed
 * payload is a SourceFailure. `clock` maps "now" onto the database clock (see quote-collector.ts).
 */
export async function observe(source: PriceSource, timeoutMs: number, clock: () => Date): Promise<SourceObservation | SourceFailure> {
  try {
    const res = await boundedFetch(source.url, { headers: { accept: 'application/json' } }, { timeoutMs, maxResponseBytes: MAX_TICKER_BYTES })
    const body = await res.text()
    const collectedAt = clock()
    if (res.status !== 200) return { operator: source.operator, reason: `HTTP ${res.status}` }
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return { operator: source.operator, reason: 'payload is not JSON' }
    }
    const { price, sourceTimestamp } = source.parse(payload)
    return { operator: source.operator, price, sourceTimestamp, collectedAt, payloadSha256: createHash('sha256').update(body).digest('hex') }
  } catch (err) {
    return { operator: source.operator, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function isObservation(r: SourceObservation | SourceFailure): r is SourceObservation {
  return 'price' in r
}
