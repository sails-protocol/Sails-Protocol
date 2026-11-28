/**
 * Demo-only fixtures for the nodes and markets prototype (?demo=1). Every name is fictional and every entry is marked
 * as fictional on screen. Read only through lib/demoMarkers.ts.
 */
import type { NodeView } from '../lib/sailsNode'
import type { Market, MyMarketEntry } from '../lib/marketContract'
import type { DemoMarketStats } from '../lib/marketSpaces'

// The public network in the demo: two nodes of one operator (redundancy) and one of another.
export const DEMO_NODES: readonly NodeView[] = [
  { id: 'demo-node-boreal-1', name: 'Nó Boreal 1', profile: 'public', operator: 'Boreal OTC', region: 'América do Sul', status: 'online', fee: '0,5 % por trade', limits: '10 – 5.000 USD por trade', custodyModel: 'Multisig 2 de 3, declarado pelo operador', illustrative: true },
  { id: 'demo-node-boreal-2', name: 'Nó Boreal 2', profile: 'public', operator: 'Boreal OTC', region: 'América do Norte', status: 'online', fee: '0,5 % por trade', limits: '10 – 5.000 USD por trade', custodyModel: 'Multisig 2 de 3, declarado pelo operador', illustrative: true },
  { id: 'demo-node-kestrel', name: 'Nó Kestrel', profile: 'public', sharedHosting: true, operator: 'Kestrel Câmbio', region: 'Europa', status: 'degraded', fee: '0,8 % por trade', limits: '50 – 2.000 USD por trade', custodyModel: 'Multisig 2 de 3, declarado pelo operador', illustrative: true },
]

/**
 * Market Spaces fixtures, shaped like the Principal's contract draft (lib/marketContract.ts) so the SDK swap is
 * mechanical. UI-only extras the draft does not carry (participation preset, hosting, demo stats) are kept apart.
 */
// Fictional 64-hex keys (opaque strings for the UI); never a real person's key.
const key = (seed: string) => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64)

export interface DemoMarketFixture {
  market: Market
  preset: 'vitrine' | 'comunidade'
  infrastructure?: 'network' | 'own'
  stats?: DemoMarketStats
  /** Public communities: open to join, or admin approval. Private markets are by invite. */
  entry?: 'open' | 'approval'
  /** Fictional "negociações em 30 dias" (Explore sorts by it, "Mais ativas"). */
  activity30d?: number
}

export const DEMO_MARKET_FIXTURES: readonly DemoMarketFixture[] = [
  {
    market: { id: 'demo-market-clube', name: 'Clube Exemplo', description: 'Comunidade fictícia para pagar contas do dia a dia com cripto', category: 'BILL_PAY', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 312, adminIdentity: key('5be90dfe1d'), createdAt: '2026-03-02T12:00:00Z', entryPolicy: { kyc: 'none', social: [] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade', entry: 'open', activity30d: 64,
  },
  {
    market: { id: 'demo-market-traders', name: 'Traders P2P Exemplo', description: 'Traders fictícios que negociam BTC e USDT entre si', category: 'GENERAL', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 540, adminIdentity: key('c41d9e73a2'), createdAt: '2025-11-18T12:00:00Z', entryPolicy: { kyc: 'none', social: ['X', 'GITHUB'] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade', stats: { trades: 410, volumeUsd: 480_000, activeDays: 78, calculatedAt: '2026-11-22T06:00:00Z' }, entry: 'open', activity30d: 212,
  },
  {
    market: { id: 'demo-market-loja', name: 'Loja Exemplo', description: 'Vitrine de uma loja fictícia que vende e compra BTC e USDT', category: 'COMMERCE', profile: 'EMPRESA_OTC', visibility: 'PUBLIC', participantsCount: 128, adminIdentity: key('9a0b7c61'), createdAt: '2026-06-10T12:00:00Z', entryPolicy: { kyc: 'above_threshold', thresholdUsd: 10_000, providerUrl: 'https://kyc.example/loja-exemplo', providerName: 'Verifica Exemplo', social: [] }, listed: true, state: 'PUBLISHED' },
    preset: 'vitrine', stats: { trades: 88, volumeUsd: 61_000, activeDays: 40, calculatedAt: '2026-11-22T06:00:00Z' }, entry: 'approval', activity30d: 18,
  },
  {
    // The only fixture with an admin-supplied media link: shows the click-to-load rule (GK, 2026-11-22).
    market: { id: 'demo-market-boreal', name: 'Boreal OTC', description: 'Mesa OTC fictícia para volumes maiores, atendida pela própria empresa', category: 'COMMERCE', profile: 'EMPRESA_OTC', visibility: 'PUBLIC', participantsCount: 86, adminIdentity: key('7e2f40d9b1'), createdAt: '2025-08-01T12:00:00Z', bannerRef: { url: 'https://media.example/boreal-otc/banner.png', sha256: key('0f') }, entryPolicy: { kyc: 'all', providerUrl: 'https://kyc.example/boreal-otc', providerName: 'Identidade Exemplo', social: ['LINKEDIN'] }, listed: true, state: 'PUBLISHED' },
    preset: 'vitrine', stats: { trades: 402, volumeUsd: 2_350_000, activeDays: 61, calculatedAt: '2026-11-22T06:00:00Z' }, entry: 'approval', activity30d: 41,
  },
  {
    market: { id: 'demo-market-sul', name: 'Bitcoin Sul Exemplo', description: 'Comunidade regional fictícia de quem negocia em reais no sul do Brasil', category: 'REGIONAL', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 97, adminIdentity: key('b50ee0e9'), createdAt: '2026-09-21T12:00:00Z', entryPolicy: { kyc: 'none', social: ['X'] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade', entry: 'open', activity30d: 9,
  },
  {
    market: { id: 'demo-market-amigos', name: 'Bitcoin Amigos PY', description: 'Grupo fechado de amigos', category: 'GENERAL', profile: 'P2P', visibility: 'PRIVATE', participantsCount: 24, adminIdentity: key('2d6a91'), createdAt: '2026-01-15T12:00:00Z', entryPolicy: { kyc: 'none', social: [] }, listed: false, state: 'PUBLISHED' },
    preset: 'comunidade',
  },
  {
    market: { id: 'demo-market-abc', name: 'Clientes Empresa ABC', description: 'Mercado exclusivo para parceiros', category: 'COMMERCE', profile: 'EMPRESA_OTC', visibility: 'PRIVATE', participantsCount: 41, adminIdentity: key('e83c05'), createdAt: '2026-04-04T12:00:00Z', entryPolicy: { kyc: 'all', providerUrl: 'https://kyc.example/empresa-abc', providerName: 'Verifica Exemplo', social: [] }, listed: false, state: 'PUBLISHED' },
    preset: 'vitrine', infrastructure: 'own',
  },
  {
    // Administered by the demo user: its page shows the admin's member list (public keys only).
    market: { id: 'demo-market-meu', name: 'Meu Mercado Exemplo', description: 'Comunidade fictícia, com aprovação, que você administra nesta demonstração', category: 'GENERAL', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 4, adminIdentity: key('a7d3'), createdAt: '2026-11-01T12:00:00Z', entryPolicy: { kyc: 'none', social: ['GITHUB'] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade', entry: 'approval', activity30d: 6,
  },
]

/** The private market a fictional invite grants (Entrar com convite); before that the demo user is not a member. */
export const DEMO_INVITED_FIXTURE: DemoMarketFixture = {
  market: { id: 'demo-market-convite', name: 'Mercado do convite', description: 'Mercado privado fictício de um grupo que negocia só entre convidados', category: 'GENERAL', profile: 'P2P', visibility: 'PRIVATE', participantsCount: 18, adminIdentity: key('4af1'), createdAt: '2026-10-30T12:00:00Z', entryPolicy: { kyc: 'none', social: [] }, listed: false, state: 'PUBLISHED' },
  preset: 'comunidade',
}

/** The demo user's own markets (sails.markets.mine shape). */
export const DEMO_MY_MARKETS: readonly MyMarketEntry[] = [
  { marketId: 'demo-market-loja', relation: 'follower', joinedAt: '2026-07-01T12:00:00Z' },
  { marketId: 'demo-market-amigos', relation: 'member', joinedAt: '2026-02-01T12:00:00Z' },
  { marketId: 'demo-market-abc', relation: 'member', joinedAt: '2026-05-01T12:00:00Z' },
  { marketId: 'demo-market-meu', relation: 'admin', joinedAt: '2026-11-01T12:00:00Z' },
]

/** Fictional members of the market the demo user administers (the admin sees public keys only, GK 2026-11-22). */
export const DEMO_MEMBER_KEYS: readonly string[] = [key('a7d3'), key('5be90dfe1d'), key('c41d9e73a2'), key('b50ee0e9')]

/** Fictional join requests on the market the demo user administers ("Pedidos"). */
export const DEMO_JOIN_REQUEST_KEYS: readonly string[] = [key('6c0ffee1'), key('d00dfeed')]
