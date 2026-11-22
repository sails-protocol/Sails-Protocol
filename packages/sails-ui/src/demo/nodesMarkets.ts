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
}

export const DEMO_MARKET_FIXTURES: readonly DemoMarketFixture[] = [
  {
    market: { id: 'demo-market-clube', name: 'Clube Exemplo', description: 'Comunidade fictícia aberta, em que todos os membros publicam', category: 'GENERAL', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 312, adminIdentity: key('5be90dfe1d'), createdAt: '2026-03-02T12:00:00Z', entryPolicy: { kyc: 'none', social: [] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade',
  },
  {
    market: { id: 'demo-market-traders', name: 'Traders P2P Exemplo', description: 'Traders fictícios que negociam BTC e USDT entre si', category: 'P2P_TRADER', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 540, adminIdentity: key('c41d9e73a2'), createdAt: '2025-11-18T12:00:00Z', entryPolicy: { kyc: 'none', social: ['X', 'GITHUB'] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade', stats: { rating: 4.8, ratings: 212, trades: 1340, volumeUsd: 480_000 },
  },
  {
    market: { id: 'demo-market-loja', name: 'Loja Exemplo', description: 'Vitrine de uma loja fictícia que vende e compra BTC e USDT', category: 'BUSINESS_OTC', profile: 'EMPRESA_OTC', visibility: 'PUBLIC', participantsCount: 128, adminIdentity: key('9a0b7c61'), createdAt: '2026-06-10T12:00:00Z', entryPolicy: { kyc: 'above_threshold', thresholdUsd: 10_000, providerUrl: 'https://kyc.example/loja-exemplo', social: [] }, listed: true, state: 'PUBLISHED' },
    preset: 'vitrine', stats: { rating: 4.6, ratings: 31, trades: 88, volumeUsd: 61_000 },
  },
  {
    // The only fixture with an admin-supplied media link: shows the click-to-load rule (GK, 2026-11-22).
    market: { id: 'demo-market-boreal', name: 'Boreal OTC', description: 'Mesa OTC fictícia para volumes maiores, atendida pela própria empresa', category: 'BUSINESS_OTC', profile: 'EMPRESA_OTC', visibility: 'PUBLIC', participantsCount: 86, adminIdentity: key('7e2f40d9b1'), createdAt: '2025-08-01T12:00:00Z', bannerRef: { url: 'https://media.example/boreal-otc/banner.png', sha256: key('0f') }, entryPolicy: { kyc: 'all', providerUrl: 'https://kyc.example/boreal-otc', social: ['LINKEDIN'] }, listed: true, state: 'PUBLISHED' },
    preset: 'vitrine', stats: { rating: 4.9, ratings: 74, trades: 402, volumeUsd: 2_350_000 },
  },
  {
    market: { id: 'demo-market-sul', name: 'Bitcoin Sul Exemplo', description: 'Comunidade regional fictícia de quem negocia em reais no sul do Brasil', category: 'REGIONAL', profile: 'P2P', visibility: 'PUBLIC', participantsCount: 97, adminIdentity: key('b50ee0e9'), createdAt: '2026-09-21T12:00:00Z', entryPolicy: { kyc: 'none', social: ['X'] }, listed: true, state: 'PUBLISHED' },
    preset: 'comunidade',
  },
  {
    market: { id: 'demo-market-amigos', name: 'Bitcoin Amigos PY', description: 'Grupo fechado de amigos', category: 'GENERAL', profile: 'P2P', visibility: 'PRIVATE', participantsCount: 24, adminIdentity: key('2d6a91'), createdAt: '2026-01-15T12:00:00Z', entryPolicy: { kyc: 'none', social: [] }, listed: false, state: 'PUBLISHED' },
    preset: 'comunidade',
  },
  {
    market: { id: 'demo-market-abc', name: 'Clientes Empresa ABC', description: 'Mercado exclusivo para parceiros', category: 'BUSINESS_OTC', profile: 'EMPRESA_OTC', visibility: 'PRIVATE', participantsCount: 41, adminIdentity: key('e83c05'), createdAt: '2026-04-04T12:00:00Z', entryPolicy: { kyc: 'all', providerUrl: 'https://kyc.example/empresa-abc', social: [] }, listed: false, state: 'PUBLISHED' },
    preset: 'vitrine', infrastructure: 'own',
  },
  {
    // Administered by the demo user: its page shows the admin's member list (public keys only).
    market: { id: 'demo-market-meu', name: 'Meu Mercado Exemplo', description: 'Mercado privado fictício que você administra nesta demonstração', category: 'GENERAL', profile: 'P2P', visibility: 'PRIVATE', participantsCount: 4, adminIdentity: key('a7d3'), createdAt: '2026-11-01T12:00:00Z', entryPolicy: { kyc: 'none', social: ['GITHUB'] }, listed: false, state: 'PUBLISHED' },
    preset: 'comunidade',
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

/** Fictional offers per market (the liquidity.discover({ marketId }) answer is not defined yet). */
export interface DemoMarketOffer { id: string; marketId: string; side: 'BUY' | 'SELL'; asset: string; priceUsd: number; method: string; advertiser: string }
export const DEMO_MARKET_OFFERS: readonly DemoMarketOffer[] = [
  { id: 'mo-1', marketId: 'demo-market-clube', side: 'SELL', asset: 'BTC', priceUsd: 97_800, method: 'Pix', advertiser: 'Alice' },
  { id: 'mo-2', marketId: 'demo-market-clube', side: 'BUY', asset: 'USDT', priceUsd: 1, method: 'Pix', advertiser: 'Bob' },
  { id: 'mo-3', marketId: 'demo-market-traders', side: 'SELL', asset: 'BTC', priceUsd: 97_650, method: 'TED', advertiser: 'Bob' },
  { id: 'mo-4', marketId: 'demo-market-traders', side: 'BUY', asset: 'BTC', priceUsd: 97_200, method: 'Pix', advertiser: 'Alice' },
  { id: 'mo-5', marketId: 'demo-market-loja', side: 'SELL', asset: 'USDT', priceUsd: 1.01, method: 'Pix', advertiser: 'Loja Exemplo' },
  { id: 'mo-6', marketId: 'demo-market-boreal', side: 'SELL', asset: 'BTC', priceUsd: 97_900, method: 'TED', advertiser: 'Boreal OTC' },
  { id: 'mo-7', marketId: 'demo-market-boreal', side: 'BUY', asset: 'USDC', priceUsd: 0.99, method: 'TED', advertiser: 'Boreal OTC' },
  { id: 'mo-8', marketId: 'demo-market-sul', side: 'SELL', asset: 'BTC', priceUsd: 97_700, method: 'Pix', advertiser: 'Alice' },
  { id: 'mo-9', marketId: 'demo-market-amigos', side: 'SELL', asset: 'BTC', priceUsd: 97_500, method: 'Pix', advertiser: 'Bob' },
  { id: 'mo-10', marketId: 'demo-market-abc', side: 'SELL', asset: 'USDT', priceUsd: 1, method: 'TED', advertiser: 'Kestrel Câmbio' },
  { id: 'mo-11', marketId: 'demo-market-convite', side: 'SELL', asset: 'BTC', priceUsd: 97_400, method: 'Pix', advertiser: 'Alice' },
  { id: 'mo-12', marketId: 'demo-market-convite', side: 'BUY', asset: 'USDT', priceUsd: 1, method: 'Pix', advertiser: 'Bob' },
  { id: 'mo-13', marketId: 'demo-market-meu', side: 'SELL', asset: 'BTC', priceUsd: 97_600, method: 'Pix', advertiser: 'Alice' },
]
