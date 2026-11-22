/**
 * Demo-only fixtures for the nodes and private markets prototype (?demo=1). Every name is fictional and every entry
 * is flagged `illustrative`. Read only through lib/demoMarkers.ts (demoNodes, demoPrivateMarkets).
 */
import type { NodeView } from '../lib/sailsNode'
import type { MarketView } from '../lib/myMarkets'

// The public network in the demo: two nodes of one operator (redundancy) and one of another.
export const DEMO_NODES: readonly NodeView[] = [
  { id: 'demo-node-boreal-1', name: 'Nó Boreal 1', profile: 'public', operator: 'Boreal OTC', region: 'América do Sul', status: 'online', fee: '0,5 % por trade', limits: '10 – 5.000 USD por trade', custodyModel: 'Multisig 2 de 3, declarado pelo operador', illustrative: true },
  { id: 'demo-node-boreal-2', name: 'Nó Boreal 2', profile: 'public', operator: 'Boreal OTC', region: 'América do Norte', status: 'online', fee: '0,5 % por trade', limits: '10 – 5.000 USD por trade', custodyModel: 'Multisig 2 de 3, declarado pelo operador', illustrative: true },
  { id: 'demo-node-kestrel', name: 'Nó Kestrel', profile: 'public', sharedHosting: true, operator: 'Kestrel Câmbio', region: 'Europa', status: 'degraded', fee: '0,8 % por trade', limits: '50 – 2.000 USD por trade', custodyModel: 'Multisig 2 de 3, declarado pelo operador', illustrative: true },
]

// One extra public market (a storefront on Rede Sails) and two private ones, all fictional.
export const DEMO_MARKETS: readonly MarketView[] = [
  { id: 'demo-market-clube', name: 'Clube Exemplo', visibility: 'public', relation: 'none', infrastructure: 'network', preset: 'comunidade', description: 'Comunidade fictícia aberta, em que todos os membros publicam', participants: 312, illustrative: true },
  { id: 'demo-market-loja', name: 'Loja Exemplo', visibility: 'public', relation: 'follows', infrastructure: 'network', preset: 'vitrine', description: 'Vitrine de uma loja fictícia que vende e compra BTC e USDT', participants: 128, illustrative: true },
  { id: 'demo-market-amigos', name: 'Bitcoin Amigos PY', visibility: 'private', relation: 'member', infrastructure: 'network', preset: 'comunidade', description: 'Grupo fechado de amigos', participants: 24, illustrative: true },
  { id: 'demo-market-abc', name: 'Clientes Empresa ABC', visibility: 'private', relation: 'member', infrastructure: 'own', preset: 'vitrine', description: 'Mercado exclusivo para parceiros', participants: 41, illustrative: true },
]
