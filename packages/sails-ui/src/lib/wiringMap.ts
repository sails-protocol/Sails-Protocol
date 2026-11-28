/**
 * Wiring map (PO, 2026-11-22): the team's checklist of what is not wired to the backend yet. One entry per
 * LOOSE_WIRES item (the Record type makes a missing one a TypeScript error). The demo is a complete working
 * simulation of the Day 0 product; production stays honest ("Em breve" / "Em preparação", CTO 437).
 *
 * Statuses (PO): "Ligado ao backend" | "Simulado na demonstração" | "Fora do Day 0 (decisão do CTO)". A fourth one,
 * "Aviso na demonstração", is for items that would handle real secrets or money outside the app (a real wallet, a
 * real key export, a payout address) or that have no settlement rail: simulating them would mislead, so even the demo
 * shows an honest notice. Developer text (pt-BR), like the contracts in LOOSE_WIRES. Pure.
 */
import type { LooseWireId } from './looseWires'

export type WireStatus = 'wired' | 'simulated' | 'outOfDay0' | 'notice'
export type WireArea = 'Mercados' | 'Rede e nós' | 'Wallet e chaves' | 'Notificações' | 'Aparência e conta' | 'Market e ofertas' | 'Trade e disputas' | 'Serviços Satsails' | 'Ajuda e idioma'

export interface WireMeta {
  status: WireStatus
  /** Out-of-Day-0 items can still be simulated in the demo (labelled), so the whole flow can be walked. */
  simulatedInDemo: boolean
  area: WireArea
  /** Screen and where to find it. */
  where: string
  owner: string
}

const BACKEND = 'Principal / backend'
const SATSAILS = 'Satsails (serviço comercial)'
const sim = (area: WireArea, where: string, owner = BACKEND): WireMeta => ({ status: 'simulated', simulatedInDemo: true, area, where, owner })
const out = (area: WireArea, where: string, owner = BACKEND): WireMeta => ({ status: 'outOfDay0', simulatedInDemo: true, area, where, owner })
const notice = (area: WireArea, where: string): WireMeta => ({ status: 'notice', simulatedInDemo: false, area, where, owner: BACKEND })

export const WIRE_META: Readonly<Record<LooseWireId, WireMeta>> = {
  // Mercados (Market Spaces).
  marketDiscovery: sim('Mercados', 'Market → Mercados → Explorar mercados (Comunidades)'),
  marketMembership: sim('Mercados', 'Meus mercados; portal; página do mercado privado'),
  marketPortability: sim('Mercados', 'Meus mercados (rodapé)'),
  createMarket: sim('Mercados', 'Market → Mercados → Criar mercado'),
  marketBranding: sim('Mercados', 'Criar mercado (ícone, banner, capa); cartões e página do mercado'),
  marketInvite: sim('Mercados', 'Entrar com convite; Criar mercado (participantes)'),
  marketInviteQr: sim('Mercados', 'Entrar com convite (QR Code)'),
  marketParticipationPrivacy: sim('Mercados', 'Configurações → Mercados'),
  marketPage: sim('Mercados', '/markets/:id'),
  marketEntryPolicy: sim('Mercados', 'Criar mercado (Regras de entrada); página do mercado'),
  marketJoinRules: sim('Mercados', 'Página do mercado → Entrar → Regras da comunidade'),
  marketJoinRequests: sim('Mercados', 'Página do mercado → Solicitar entrada; Sobre → Pedidos de entrada (administrador)'),
  marketActivity: sim('Mercados', 'Explorar → Comunidades (Mais ativas, entrada, ativos)'),
  marketSpaceTransfer: sim('Serviços Satsails', 'Meus mercados → Seu espaço → Transferir', 'Satsails (serviço comercial)'),
  marketModeration: sim('Mercados', 'Página do mercado → Conversas (fixar) e Sobre (remover citando a regra)'),
  marketIntentPost: sim('Mercados', 'Página do mercado → Chat do grupo → Publicar intenção'),
  marketDirectMessage: sim('Mercados', 'Página do mercado → Conversas privadas · Day 0 (CTO 33)'),
  communities: sim('Mercados', 'Substituído por marketMembership (id mantido)'),
  // Day 0 (CTO 33, 2026-11-23): group chat, pre-trade private messages, the "Mercado ativo" badge and the managed node.
  marketGroupChat: sim('Mercados', 'Página do mercado → Chat do grupo · Day 0 (CTO 33)'),
  marketVerification: sim('Mercados', 'Selo Mercado ativo: cartões e página do mercado · Day 0 (CTO 33)'),
  // Rede e nós.
  publicPrivateServers: sim('Rede e nós', 'Configurações → Rede e nós'),
  manualServer: sim('Rede e nós', 'Configurações → Rede e nós → Adicionar nó manualmente'),
  connectionDiagnostics: sim('Rede e nós', 'Configurações → Rede e nós → Avançado'),
  nodeCatalog: sim('Rede e nós', 'Configurações → Rede e nós → Avançado'),
  nodeStateSync: sim('Rede e nós', 'Configurações → Rede e nós → Avançado'),
  managedNode: sim('Serviços Satsails', 'Rede e nós (Onde um mercado pode rodar); Criar mercado (Onde o mercado roda) · Day 0 (CTO 33), modelo CTO 36', SATSAILS),
  merchantBadge: out('Market e ofertas', 'Perfil → Programa Merchant (Em breve); futuro selo nas ofertas · política global + elegibilidade comprovada'),
  merchantProgram: out('Market e ofertas', 'Perfil → Programa Merchant (proposta); Criar mercado (nota) · proposta CTO 36'),
  spacePurchase: out('Serviços Satsails', 'Criar mercado: escolha do tipo e "Revisar e pagar" (checkout simulado); /markets/space redireciona', SATSAILS),
  // Wallet e chaves: never simulated (real secrets or funds outside the app).
  satsailsWallet: notice('Wallet e chaves', 'Configurações → Wallet; Conectar wallet'),
  walletConnect: notice('Wallet e chaves', 'Configurações → Wallet; Conectar wallet'),
  defaultReceiveAddress: notice('Wallet e chaves', 'Configurações → Wallet'),
  keyBackup: notice('Wallet e chaves', 'Configurações → Segurança'),
  sessionLock: sim('Wallet e chaves', 'Configurações → Segurança'),
  // Notificações.
  notifyTrades: sim('Notificações', 'Configurações → Notificações'),
  notifyChat: sim('Notificações', 'Configurações → Notificações'),
  notifyDisputes: sim('Notificações', 'Configurações → Notificações'),
  // Aparência e conta.
  displayCurrency: sim('Aparência e conta', 'Configurações → Aparência'),
  publicAvatar: sim('Aparência e conta', 'Perfil (baralho de avatares); Configurações → Aparência'),
  publicMemberSince: sim('Aparência e conta', 'Detalhe da oferta; Perfil'),
  // Market e ofertas.
  readRatings: sim('Market e ofertas', 'Lista do Market; detalhe da oferta; Perfil'),
  multiPaymentMethods: sim('Market e ofertas', 'Lista do Market; detalhe da oferta; publicar oferta'),
  assetCatalogPairs: notice('Market e ofertas', 'Seletor de ativo (publicar, filtro)'),
  // Trade e disputas.
  tradePaymentMethodChoice: sim('Trade e disputas', 'Detalhe da oferta → abrir trade'),
  disputeAppealView: sim('Trade e disputas', 'Trade → disputa (contestação)'),
  // Ajuda e idioma.
  helpCenter: sim('Ajuda e idioma', 'Configurações → Ajuda e Sobre', 'Produto (conteúdo)'),
  language: { status: 'wired', simulatedInDemo: false, area: 'Ajuda e idioma', where: 'Configurações → Idioma', owner: 'UI (revisão nativa pendente)' },
}

export const WIRE_STATUS_LABEL: Readonly<Record<WireStatus, string>> = {
  wired: 'Ligado ao backend',
  simulated: 'Simulado na demonstração',
  outOfDay0: 'Fora do Day 0 (decisão do CTO)',
  notice: 'Aviso na demonstração (não simulado)',
}

export function wireCounts(meta: Readonly<Record<string, WireMeta>> = WIRE_META): Record<WireStatus, number> {
  const c: Record<WireStatus, number> = { wired: 0, simulated: 0, outOfDay0: 0, notice: 0 }
  for (const m of Object.values(meta)) c[m.status]++
  return c
}

/** In the demo a simulated wire shows "Simulado", never an unexplained "Em breve"; real mode always says "Em breve". */
export function plannedBadge(id: LooseWireId, demo: boolean): 'simulated' | 'soon' {
  return demo && WIRE_META[id].simulatedInDemo ? 'simulated' : 'soon'
}
