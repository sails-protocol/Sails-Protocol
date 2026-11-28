/**
 * Demo-only dashboard fixtures (PO 2026-11-23): fictional trade records for "Painel do espaço" and "Minhas
 * estatísticas", always shown with the "Simulado" badge. Deterministic (seeded), dated relative to today so every
 * preset has data. Never imported by real-mode code paths: the containers read them only under isDemoMode().
 */
import type { TradeRecord } from '../lib/tradeStats'

/** Small seeded PRNG (mulberry32): the same fixture on every load. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY = 86_400_000
const UNITS = [
  { unit: 'BTC', weight: 0.45, price: 92_000, min: 0.002, max: 0.08, decimals: 6 },
  { unit: 'USDT', weight: 0.4, price: 1, min: 50, max: 4_000, decimals: 2 },
  { unit: 'USDC', weight: 0.15, price: 1, min: 50, max: 2_500, decimals: 2 },
] as const

function trade(r: () => number, at: number): TradeRecord {
  const x = r()
  const u = x < UNITS[0].weight ? UNITS[0] : x < UNITS[0].weight + UNITS[1].weight ? UNITS[1] : UNITS[2]
  const amount = Number((u.min + r() * (u.max - u.min)).toFixed(u.decimals))
  const roll = r()
  const status: TradeRecord['status'] = roll < 0.86 ? 'COMPLETED' : roll < 0.95 ? 'CANCELLED' : 'DISPUTED'
  const created = new Date(at).toISOString()
  const closed = new Date(at + (20 + r() * 90) * 60_000).toISOString()
  return {
    unit: u.unit, amount, totalUsd: Math.round(amount * u.price * 100) / 100, status, createdAt: created,
    completedAt: status === 'COMPLETED' ? closed : null, cancelledAt: status === 'CANCELLED' ? closed : null,
  }
}

/** Trades from `startMs` to now, about `perMonth` a month, growing slowly over time. */
function history(seed: number, startMs: number, nowMs: number, perMonth: number): TradeRecord[] {
  const r = rng(seed)
  const out: TradeRecord[] = []
  for (let d = startMs; d < nowMs; d += DAY) {
    const growth = 0.6 + 0.8 * ((d - startMs) / Math.max(DAY, nowMs - startMs))
    if (r() < (perMonth / 30) * growth) out.push(trade(r, d + r() * DAY * 0.9))
  }
  return out
}

export interface DemoMarketDashboard {
  start: Date
  trades: TradeRecord[]
  /** When each member joined (counts only, never who). */
  memberJoins: Date[]
}

/** The market the demo user administers ("Meu Mercado Exemplo", started about two years ago). */
export const DEMO_DASHBOARD_MARKET_ID = 'demo-market-meu'
export const DEMO_DASHBOARD_MARKET_START = '2024-09-02T12:00:00Z'

/**
 * Its fictional history. The last 30 days hold exactly `activity30d` completed trades, so the dashboard and the
 * Explore card ("6 negociações em 30 dias") tell the same story.
 */
export function demoMarketDashboard(marketId: string, activity30d: number | undefined, participants: number | undefined, now = new Date()): DemoMarketDashboard | null {
  if (marketId !== DEMO_DASHBOARD_MARKET_ID) return null
  const start = new Date(DEMO_DASHBOARD_MARKET_START)
  const cut = now.getTime() - 30 * DAY
  // Older disputes are settled in this fiction (shown as cancelled), so "Disputas abertas" counts today's only.
  const older = history(2024, start.getTime(), cut, 9).map((tr): TradeRecord => tr.status === 'DISPUTED' ? { ...tr, status: 'CANCELLED', cancelledAt: new Date(Date.parse(tr.createdAt) + 2 * DAY).toISOString() } : tr)
  const r = rng(30)
  const recent: TradeRecord[] = Array.from({ length: activity30d ?? 0 }, (_, i) => {
    const t = trade(r, cut + ((i + 0.5) / Math.max(1, activity30d ?? 1)) * 30 * DAY)
    return { ...t, status: 'COMPLETED', completedAt: t.completedAt ?? new Date(Date.parse(t.createdAt) + 45 * 60_000).toISOString(), cancelledAt: null }
  })
  // One open dispute in the market today.
  recent.push({ ...trade(r, now.getTime() - 3 * DAY), status: 'DISPUTED', completedAt: null, cancelledAt: null })
  const count = participants ?? 0
  const span = now.getTime() - start.getTime()
  const memberJoins = Array.from({ length: count }, (_, i) => new Date(start.getTime() + (i === 0 ? 0 : span * (0.2 + 0.78 * (i / Math.max(1, count - 1))))))
  return { start, trades: [...older, ...recent], memberJoins }
}

export interface DemoPersonalStats {
  start: Date
  trades: TradeRecord[]
  /** Fictional average minutes from payment marked sent to release, per completed trade. */
  releaseMinutes: { at: Date; minutes: number }[]
  /** Fictional reputation after each completed trade (the +2 / -5 sum, never a scale). */
  reputation: { at: Date; score: number }[]
}

/** The demo user's fictional history, about 13 months. */
export function demoPersonalStats(now = new Date()): DemoPersonalStats {
  const start = new Date(now.getTime() - 400 * DAY)
  const trades = history(7, start.getTime(), now.getTime(), 6)
  const r = rng(11)
  const completed = trades.filter((tr) => tr.status === 'COMPLETED').sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
  const releaseMinutes = completed.map((tr) => ({ at: new Date(tr.completedAt as string), minutes: Math.round(8 + r() * 30) }))
  let score = 0
  const reputation = trades
    .filter((tr) => tr.status === 'COMPLETED' || tr.status === 'DISPUTED')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((tr) => {
      score += tr.status === 'COMPLETED' ? 2 : r() < 0.3 ? -5 : 0
      return { at: new Date(tr.completedAt ?? tr.createdAt), score }
    })
  return { start, trades, releaseMinutes, reputation }
}
