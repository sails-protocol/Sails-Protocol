/**
 * DEV-ONLY demonstration mode ("modo demonstração").
 *
 * Replaces the network-facing methods of the shared `sailsClient`
 * singleton with an in-memory, sessionStorage-persisted fake backend so
 * the whole Sails Market journey can be clicked through with no server.
 * Loaded only from main.tsx behind `import.meta.env.DEV`, so production
 * builds never contain it. Client-side cryptography (keypair generation,
 * passphrase encryption, the arbiter's authority-decision signature) stays
 * real; only the server round trips are fake. Every escrow is type MOCK
 * (single-call release, no PSBT, no escrow signatures).
 */
import { SailsNotFoundError } from '@satsails/p2p-trading-sdk'
import type {
  ChatMessageEvent, CounterProposal, Dispute, DisputeRuling, Escrow, Intent, Message, Offer, Participant,
  PublicOfferDetail, ReputationScore, Trade, TradeIntentPayload, TradeProposal, Vouch, WebSocketChannel,
} from '@satsails/p2p-trading-sdk'
import { sailsClient } from '../lib/sailsClient'

const FLAG_KEY = 'sails_demo_mode'
const STATE_KEY = 'sails_demo_state_v4'
// The encrypted identity/escrow keypairs AuthContext/useEscrowKey keep in
// localStorage. In demo mode they are never stored or handed back, so every
// login generates a fresh key and any passphrase works. Every other
// localStorage key goes to sessionStorage, so real localStorage is untouched.
const DISCARDED_KEYS = new Set(['sails_ui_keypair_secret_hex', 'sails_ui_escrow_keypair'])
const SHADOW_PREFIX = 'sails_demo_shadow:'
/** Every demo login is this one fictional participant, whatever key the login generated. */
const ME = 'demo-me'
const JUDGE = 'demo-0e55'
const APPEAL_PANEL = 'demo-0f66'
/** Trade id the demo controls navigate through to make Trade.tsx refetch. */
export const REFRESH_TRADE_ID = 'demo-refresh'
export const UNAVAILABLE = 'Não disponível no modo demonstração'
const DEMO_SUGGESTION =
  'Sugestão de exemplo do modo demonstração (nenhum modelo foi consultado). É só uma recomendação, não uma decisão: o árbitro decide e qualquer parte pode contestar.'

interface DemoState {
  participants: Participant[]
  offers: Offer[]
  trades: Trade[]
  escrows: Escrow[]
  messages: Message[]
  payoutAddresses: { participantId: string; asset: Trade['asset']; address: string }[]
  vouches: Vouch[]
  intents: Intent<TradeIntentPayload>[]
}

interface Evidence { type: string; uri?: string; note?: string; submittedBy: string; submittedAt: string }

const now = () => new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

function participant(id: string, displayName: string, reputationScore: number, totalTrades: number, disputeCount: number, verified: boolean): Participant {
  return {
    id, publicKey: id.replace(/[^0-9a-f]/g, '').padEnd(64, '0'), displayName, peerId: null,
    reputationScore, totalTrades, disputeCount, totalVolumeBtc: '0', verified,
    createdAt: daysAgo(400), updatedAt: daysAgo(1),
  }
}

function offer(id: string, userId: string, o: Pick<Offer, 'asset' | 'side' | 'priceUsd' | 'minAmount' | 'maxAmount' | 'paymentMethod' | 'paymentDetails' | 'description'>, age: number): Offer {
  return { id, userId, priceBrl: null, status: 'ACTIVE', network: null, createdAt: daysAgo(age), updatedAt: daysAgo(age), ...o }
}

function mockEscrow(t: Trade, status: Escrow['status'], at: string, disputes: Dispute[] = []): Escrow {
  const funded = status !== 'CREATED'
  return {
    id: `${t.id}-escrow`, tradeId: t.id, type: 'MOCK', status, lockedAmount: t.amount, asset: t.asset,
    network: null, multisigAddr: null, txLockId: null, txLockVout: null, fundedAmount: funded ? t.amount : null, txReleaseId: null,
    timelockHours: 72, lockedAt: funded ? at : null, expiresAt: funded ? new Date(Date.parse(at) + 72 * 3_600_000).toISOString() : null,
    releasedAt: ['COMPLETED', 'REFUNDED', 'SPLIT'].includes(status) ? at : null, createdAt: at, updatedAt: at,
    disputes, participantKeys: [], feePolicyVersionId: null, snapshotProtocolFeeRate: null, snapshotPayerModel: null,
    snapshotEconomicBasis: null, snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: null, custodyModel: null,
  }
}

function seedTrade(id: string, o: Offer, buyerId: string, sellerId: string, amount: string, at: string, status: Trade['status']): Trade {
  return {
    id, offerId: o.id, buyerId, sellerId, asset: o.asset, amount, priceUsd: o.priceUsd,
    totalUsd: (Number(amount) * Number(o.priceUsd)).toFixed(2), status, escrowId: null, network: null,
    completedAt: status === 'COMPLETED' ? at : null, cancelledAt: status === 'CANCELLED' ? at : null, createdAt: at, updatedAt: at,
  }
}

const evidence = (submittedBy: string, note: string, at: string): Evidence => ({ type: 'text', note, submittedBy, submittedAt: at })

function newDispute(tradeId: string, escrowId: string, openedBy: string, arbiterId: string, reason: string, at: string, patch: Partial<Dispute> = {}): Dispute {
  return {
    id: `${tradeId}-dispute`, tradeId, escrowId, openedBy, reason, evidence: [], arbiterId,
    status: 'OPENED', ruling: null, resolvedAt: null, appealRound: 0, previousRuling: null, previousArbiterId: null,
    autoResolutionRecommendation: null, autoResolutionConfidence: null, autoResolutionReasoning: null,
    autoResolutionDeadline: null, autoResolved: false, createdAt: at, updatedAt: at, ...patch,
  }
}

// Obviously fictional traders, offers, trades and disputes; prices in USD like the real discover() route.
function seed(): DemoState {
  const g = 'demo-0a11', f = 'demo-0b22', m = 'demo-0c33', a = 'demo-0d44'
  const offers: Offer[] = [
    offer('demo-offer-1', g, { asset: 'BTC', side: 'SELL', priceUsd: '97450', minAmount: '0.001', maxAmount: '0.05', paymentMethod: 'PIX', paymentDetails: 'Chave PIX fictícia: gaivota@exemplo.invalid', description: 'Oferta de exemplo do modo demonstração.' }, 2),
    offer('demo-offer-2', f, { asset: 'BTC', side: 'BUY', priceUsd: '96900', minAmount: '0.005', maxAmount: '0.2', paymentMethod: 'BANK_TRANSFER', paymentDetails: null, description: 'Compro BTC — exemplo fictício.' }, 1),
    offer('demo-offer-3', m, { asset: 'USDT_TRC20', side: 'SELL', priceUsd: '1.002', minAmount: '50', maxAmount: '2000', paymentMethod: 'PIX', paymentDetails: 'Chave PIX fictícia: mare-mansa@exemplo.invalid', description: null }, 3),
    offer('demo-offer-4', a, { asset: 'USDT_ERC20', side: 'BUY', priceUsd: '0.998', minAmount: '100', maxAmount: '5000', paymentMethod: 'TED', paymentDetails: null, description: 'Compro USDT — exemplo fictício.' }, 5),
    offer('demo-offer-5', a, { asset: 'BTC', side: 'SELL', priceUsd: '97800', minAmount: '0.0005', maxAmount: '0.01', paymentMethod: 'TED', paymentDetails: 'Banco Fictício 000, ag. 0001, conta 12345-6', description: null }, 4),
    offer('demo-offer-6', g, { asset: 'USDT_LIQUID', side: 'SELL', priceUsd: '1.004', minAmount: '20', maxAmount: '1500', paymentMethod: 'CASH', paymentDetails: 'Encontro combinado pelo chat (exemplo).', description: null }, 6),
    offer('demo-offer-me-1', ME, { asset: 'BTC', side: 'SELL', priceUsd: '97600', minAmount: '0.001', maxAmount: '0.02', paymentMethod: 'PIX', paymentDetails: 'Chave PIX fictícia: voce-demo@exemplo.invalid', description: 'Minha oferta de exemplo (modo demonstração).' }, 3),
    { ...offer('demo-offer-me-2', ME, { asset: 'USDT_TRC20', side: 'BUY', priceUsd: '0.999', minAmount: '100', maxAmount: '1000', paymentMethod: 'TED', paymentDetails: null, description: null }, 9), status: 'PAUSED' },
  ]
  const o = (id: string) => offers.find((x) => x.id === id)!
  const trades: Trade[] = []
  const escrows: Escrow[] = []
  const add = (t: Trade, status?: Escrow['status'], disputes?: (escrowId: string) => Dispute[]) => {
    trades.push(t)
    if (!status) return
    const e = mockEscrow(t, status, t.updatedAt)
    e.disputes = disputes ? disputes(e.id) : []
    t.escrowId = e.id
    escrows.push(e)
  }

  // Demo user's own history.
  add(seedTrade('5c1e9a02-demo-h1', o('demo-offer-1'), ME, g, '0.01', daysAgo(20), 'COMPLETED'), 'COMPLETED')
  add(seedTrade('8b3d0f14-demo-h2', o('demo-offer-2'), f, ME, '0.02', daysAgo(12), 'COMPLETED'), 'COMPLETED')
  add(seedTrade('2e7a4c91-demo-h3', o('demo-offer-4'), a, ME, '250', daysAgo(45), 'COMPLETED'), 'COMPLETED')
  add(seedTrade('9d0b6e35-demo-h4', o('demo-offer-3'), ME, m, '300', daysAgo(8), 'CANCELLED'))
  add(seedTrade('4a8f2d60-demo-h5', o('demo-offer-5'), ME, a, '0.005', daysAgo(29), 'CANCELLED'), 'REFUNDED', (eid) => [
    newDispute('4a8f2d60-demo-h5', eid, ME, JUDGE, 'O vendedor diz que o TED não chegou (exemplo fictício).', daysAgo(30), {
      status: 'RESOLVED', ruling: 'REFUND', resolvedAt: daysAgo(29),
      evidence: [evidence(ME, 'Comprovante de TED enviado às 14h (exemplo).', daysAgo(30)), evidence(a, 'O valor não apareceu na conta (exemplo).', daysAgo(30))],
    }),
  ])
  // Demo user's open trades: one waiting for the user's payment, one in dispute with an automatic suggestion to contest.
  add(seedTrade('7e2c5b18-demo-a1', o('demo-offer-3'), ME, m, '500', daysAgo(0.05), 'ACTIVE'), 'FUNDS_LOCKED')
  add(seedTrade('c41d9e73-demo-a2', o('demo-offer-6'), ME, g, '200', daysAgo(2), 'DISPUTED'), 'DISPUTED', (eid) => [
    newDispute('c41d9e73-demo-a2', eid, ME, JUDGE, 'Paguei em dinheiro no encontro e o vendedor não liberou (exemplo fictício).', daysAgo(2), {
      status: 'AUTO_PROPOSED', evidence: [evidence(ME, 'Recibo assinado no encontro (exemplo).', daysAgo(2))],
      autoResolutionRecommendation: 'RELEASE', autoResolutionConfidence: 0.62, autoResolutionReasoning: DEMO_SUGGESTION, autoResolutionDeadline: daysAhead(1),
    }),
  ])
  // Disputes between other fictional parties, assigned to the demo user as arbiter.
  add(seedTrade('b62f0a49-demo-x1', o('demo-offer-1'), f, g, '0.03', daysAgo(1), 'DISPUTED'), 'DISPUTED', (eid) => [
    newDispute('b62f0a49-demo-x1', eid, f, ME, 'Paguei via PIX e o vendedor não liberou os fundos (exemplo fictício).', daysAgo(1), {
      status: 'EVIDENCE_SUBMITTED',
      evidence: [evidence(f, 'Comprovante PIX de exemplo, id E000-DEMO.', daysAgo(1)), evidence(g, 'O PIX não caiu na minha conta (exemplo).', daysAgo(0.5))],
    }),
  ])
  add(seedTrade('1d8e7c25-demo-x2', o('demo-offer-4'), a, m, '1000', daysAgo(3), 'DISPUTED'), 'DISPUTED', (eid) => [
    newDispute('1d8e7c25-demo-x2', eid, m, ME, 'O comprador pediu cancelamento depois de os fundos estarem bloqueados (exemplo fictício).', daysAgo(3), {
      status: 'AUTO_PROPOSED', evidence: [evidence(m, 'Captura da conversa no chat (exemplo).', daysAgo(3))],
      autoResolutionRecommendation: 'REFUND', autoResolutionConfidence: 0.55, autoResolutionReasoning: DEMO_SUGGESTION, autoResolutionDeadline: daysAhead(2),
    }),
  ])

  const msg = (tradeId: string, senderId: string, content: string, at: string): Message => ({ id: `${tradeId}-${at}`, tradeId, senderId, content, msgType: 'TEXT', readAt: null, createdAt: at })
  return {
    participants: [
      participant(g, 'Gaivota Demo', 92, 148, 1, true),
      participant(f, 'Farol Norte Demo', 85, 63, 2, true),
      participant(m, 'Maré Mansa Demo', 78, 21, 0, false),
      participant(a, 'Âncora Demo', 96, 312, 3, true),
      participant(JUDGE, 'Juíza Brisa Demo', 98, 40, 0, true),
      participant(APPEAL_PANEL, 'Painel Recife Demo', 97, 55, 0, true),
      { ...participant(ME, 'Você Demo', 74, 3, 1, false), totalVolumeBtc: '0.035' },
    ],
    offers, trades, escrows, vouches: [], intents: [],
    // The demo user already bought BTC (history above), so a BTC payout address exists; other assets show the registration flow.
    payoutAddresses: [{ participantId: ME, asset: 'BTC', address: 'endereco-ficticio-voce-demo-btc' }],
    messages: [
      msg('7e2c5b18-demo-a1', m, 'Olá! Fundos bloqueados no escrow, pode enviar o PIX (exemplo).', daysAgo(0.04)),
      msg('7e2c5b18-demo-a1', ME, 'Combinado, envio em alguns minutos (exemplo).', daysAgo(0.03)),
      msg('5c1e9a02-demo-h1', g, 'PIX recebido, liberando agora (exemplo).', daysAgo(20)),
      msg('8b3d0f14-demo-h2', f, 'Transferência feita, confere aí? (exemplo).', daysAgo(12)),
      msg('2e7a4c91-demo-h3', a, 'Obrigado pelo trade (exemplo).', daysAgo(45)),
      msg('9d0b6e35-demo-h4', ME, 'Desisti, vou cancelar este trade (exemplo).', daysAgo(8)),
      msg('4a8f2d60-demo-h5', ME, 'Enviei o TED, segue o comprovante na disputa (exemplo).', daysAgo(30)),
      msg('c41d9e73-demo-a2', g, 'Não recebi o dinheiro no encontro (exemplo).', daysAgo(2)),
    ],
  }
}

let state: DemoState = seed()
let currentId: string | null = null

function load() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY)
    if (raw) state = JSON.parse(raw) as DemoState
  } catch { state = seed() }
}
function save() {
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)) } catch { /* state stays in memory */ }
}

/** `?demo=1` turns demo mode on for this tab, `?demo=0` off; otherwise the last choice in this tab. */
export function demoRequested(): boolean {
  const flag = new URLSearchParams(window.location.search).get('demo')
  try {
    if (flag === '1') sessionStorage.setItem(FLAG_KEY, '1')
    if (flag === '0') sessionStorage.removeItem(FLAG_KEY)
    return sessionStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return flag === '1'
  }
}

/** Clears demo trades, offers and the demo identity, then starts over logged out. */
export function resetDemoAndReload() {
  try {
    sessionStorage.removeItem(STATE_KEY)
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(SHADOW_PREFIX)) sessionStorage.removeItem(k)
  } catch { /* nothing persisted */ }
  window.location.href = '/?demo=1'
}

function shadowLocalStorage() {
  const proto = Storage.prototype
  const { getItem, setItem, removeItem } = proto
  const isLocal = (store: Storage) => store === window.localStorage
  proto.getItem = function (key: string) {
    if (!isLocal(this)) return getItem.call(this, key)
    return DISCARDED_KEYS.has(key) ? null : getItem.call(window.sessionStorage, SHADOW_PREFIX + key)
  }
  proto.setItem = function (key: string, value: string) {
    if (!isLocal(this)) setItem.call(this, key, value)
    else if (!DISCARDED_KEYS.has(key)) setItem.call(window.sessionStorage, SHADOW_PREFIX + key, value)
  }
  proto.removeItem = function (key: string) {
    if (!isLocal(this)) removeItem.call(this, key)
    else removeItem.call(window.sessionStorage, SHADOW_PREFIX + key)
  }
}

// ---------- lookups ----------

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const notFound = (what: string, feminine = false) => new SailsNotFoundError(`${what} não ${feminine ? 'encontrada' : 'encontrado'} (modo demonstração)`)
function needMe(): string {
  if (!currentId) throw new Error('Conecte sua wallet primeiro (modo demonstração)')
  return currentId
}
function findParticipant(id: string) {
  const p = state.participants.find((x) => x.id === id)
  if (!p) throw notFound('Participante')
  return p
}
function findTrade(id: string) {
  const t = state.trades.find((x) => x.id === id)
  if (!t) throw notFound('Trade')
  return t
}
function findEscrow(id: string) {
  const e = state.escrows.find((x) => x.id === id)
  if (!e) throw notFound('Escrow')
  return e
}
function findDispute(id: string) {
  for (const e of state.escrows) for (const d of e.disputes ?? []) if (d.id === id) return d
  throw notFound('Disputa', true)
}
const allDisputes = () => state.escrows.flatMap((e) => e.disputes ?? [])
const isParty = (t: Trade, who: string) => who === t.buyerId || who === t.sellerId
function requireParty(d: Dispute) {
  const me = needMe()
  if (!isParty(findTrade(d.tradeId), me)) throw new Error('Somente as partes do trade podem fazer isto (modo demonstração)')
  return me
}
function reputationOf(p: Participant): ReputationScore {
  return {
    participantId: p.id, total: p.reputationScore, tradeScore: p.reputationScore, volumeScore: p.reputationScore,
    settlementScore: p.reputationScore, disputeRate: p.totalTrades ? p.disputeCount / p.totalTrades : 0,
    totalTrades: p.totalTrades, cumulativeFeesObserved: '0',
  }
}
const tradeWithOffer = (t: Trade): Trade => ({ ...t, offer: state.offers.find((o) => o.id === t.offerId) })
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

// Any key logs in as the same demo participant, so history survives a login with another passphrase.
function registerPublicKey(publicKey: string): Participant {
  const p = findParticipant(ME)
  p.publicKey = publicKey
  save()
  return p
}

// ---------- escrow lifecycle (shared by the UI actions and the counterparty simulation) ----------

// Same Escrow -> Trade projection as the server (trade-repository.ts ESCROW_TO_TRADE_STATUS).
const TRADE_FOR: Partial<Record<Escrow['status'], Trade['status']>> = {
  FUNDS_LOCKED: 'ACTIVE', PAYMENT_PENDING: 'ACTIVE', DISPUTED: 'DISPUTED', COMPLETED: 'COMPLETED', SPLIT: 'COMPLETED', REFUNDED: 'CANCELLED',
}
// Same ruling -> Escrow status as the server (dispute.service.ts SETTLED_STATUS).
const SETTLED_STATUS: Record<DisputeRuling, Escrow['status']> = { RELEASE: 'COMPLETED', REFUND: 'REFUNDED', SPLIT: 'SPLIT' }

function setEscrowStatus(e: Escrow, status: Escrow['status'], patch: Partial<Escrow> = {}) {
  Object.assign(e, patch, { status, updatedAt: now() })
  const t = findTrade(e.tradeId)
  const next = TRADE_FOR[status]
  if (next && next !== t.status) {
    if (next === 'COMPLETED') for (const id of [t.buyerId, t.sellerId]) findParticipant(id).totalTrades += 1
    Object.assign(t, { status: next, updatedAt: now() })
    if (next === 'COMPLETED') t.completedAt = now()
    if (next === 'CANCELLED') t.cancelledAt = now()
  }
  save()
  return clone(e)
}

function createEscrow(tradeId: string, actorId: string): Escrow {
  const t = findTrade(tradeId)
  if (actorId !== t.sellerId) throw new Error('Somente o vendedor cria o escrow')
  if (t.escrowId) return clone(findEscrow(t.escrowId))
  if (t.status !== 'PENDING') throw new Error(`Não é possível criar escrow com o trade em ${t.status}`)
  const e = mockEscrow(t, 'CREATED', now())
  state.escrows.push(e)
  Object.assign(t, { escrowId: e.id, status: 'ACTIVE', updatedAt: now() })
  save()
  return clone(e)
}

function step(escrowId: string, actorId: string, action: 'lock' | 'markPaymentSent' | 'release'): Escrow {
  const e = findEscrow(escrowId)
  const t = findTrade(e.tradeId)
  const rule = { lock: ['CREATED', t.sellerId], markPaymentSent: ['FUNDS_LOCKED', t.buyerId], release: ['PAYMENT_PENDING', t.sellerId] }[action]
  if (e.status !== rule[0]) throw new Error(`Ação recusada: o escrow está em ${e.status} (modo demonstração)`)
  if (actorId !== rule[1]) throw new Error('Ação recusada: não é a sua vez (modo demonstração)')
  if (action === 'lock') {
    return setEscrowStatus(e, 'FUNDS_LOCKED', { lockedAt: now(), fundedAmount: e.lockedAmount, expiresAt: new Date(Date.now() + e.timelockHours * 3_600_000).toISOString() })
  }
  if (action === 'markPaymentSent') return setEscrowStatus(e, 'PAYMENT_PENDING')
  // Same rule as the real server (M8-R2): release pays the buyer's own registered address.
  if (!state.payoutAddresses.some((a) => a.participantId === t.buyerId && a.asset === t.asset)) {
    throw new Error('O comprador ainda não registrou um endereço de recebimento para este ativo.')
  }
  return setEscrowStatus(e, 'COMPLETED', { releasedAt: now() })
}

// ---------- dispute lifecycle (same status transitions as dispute.service.ts) ----------

function touch(d: Dispute, patch: Partial<Dispute>) {
  Object.assign(d, patch, { updatedAt: now() })
  save()
  return clone(d)
}

function addEvidence(d: Dispute, submittedBy: string, descriptor: { type: string; uri?: string; note?: string }) {
  if (d.status !== 'OPENED' && d.status !== 'EVIDENCE_SUBMITTED') throw new Error(`A disputa não aceita evidências no status ${d.status}`)
  return touch(d, { evidence: [...d.evidence, { ...descriptor, submittedBy, submittedAt: now() } satisfies Evidence], status: 'EVIDENCE_SUBMITTED' })
}

function autoPropose(d: Dispute) {
  return touch(d, {
    status: 'AUTO_PROPOSED', autoResolutionRecommendation: 'SPLIT', autoResolutionConfidence: 0.58,
    autoResolutionReasoning: DEMO_SUGGESTION, autoResolutionDeadline: daysAhead(1),
  })
}

function applyRuling(d: Dispute, ruling: DisputeRuling) {
  if (d.status === 'RESOLVED') throw new Error('Esta disputa já foi resolvida')
  const updated = touch(d, { status: 'RESOLVED', ruling, resolvedAt: now() })
  setEscrowStatus(findEscrow(d.escrowId), SETTLED_STATUS[ruling], { releasedAt: now() })
  return updated
}

// ---------- counterparty / arbiter simulation (DemoControls) ----------

export interface DemoTradeView {
  role: 'buyer' | 'seller' | 'none' | 'signed-out'
  escrowStatus: Escrow['status'] | null
  /** What the other side (counterparty or arbiter) would do next, or null when nothing is pending. */
  nextCounterpartyStep: string | null
}

function disputeStep(d: Dispute, t: Trade, viewer: string) {
  const other = viewer === t.buyerId ? t.sellerId : t.buyerId
  if (d.status === 'OPENED') {
    return { label: 'Contraparte envia uma evidência', run: () => addEvidence(d, other, { type: 'text', note: 'Minha versão dos fatos (exemplo fictício).' }) }
  }
  if (d.status === 'EVIDENCE_SUBMITTED' && !d.autoResolutionRecommendation) {
    return { label: 'Sistema propõe uma sugestão automática (exemplo)', run: () => autoPropose(d) }
  }
  if (d.status === 'RESOLVED') return null
  return d.status === 'APPEALED'
    ? { label: 'Painel de apelação decide (exemplo: liberar ao comprador)', run: () => applyRuling(d, 'RELEASE') }
    : { label: 'Árbitro decide a disputa (exemplo: dividir 50/50)', run: () => applyRuling(d, 'SPLIT') }
}

function counterpartyStep(t: Trade, e: Escrow | undefined, viewer: string) {
  const buyerView = viewer === t.buyerId
  const d = e?.disputes?.[0]
  if (d) return disputeStep(d, t, viewer)
  if (t.status === 'COMPLETED' || t.status === 'CANCELLED') return null
  if (!e) return buyerView ? { label: 'Vendedor cria o escrow', run: () => createEscrow(t.id, t.sellerId) } : null
  if (e.status === 'CREATED' && buyerView) return { label: 'Vendedor bloqueia os fundos', run: () => step(e.id, t.sellerId, 'lock') }
  if (e.status === 'FUNDS_LOCKED' && !buyerView) return { label: 'Comprador marca o pagamento como enviado', run: () => step(e.id, t.buyerId, 'markPaymentSent') }
  if (e.status === 'PAYMENT_PENDING' && buyerView) return { label: 'Vendedor libera os fundos', run: () => step(e.id, t.sellerId, 'release') }
  return null
}

export function viewTrade(tradeId: string): DemoTradeView | null {
  const t = state.trades.find((x) => x.id === tradeId)
  if (!t) return null
  const e = t.escrowId ? state.escrows.find((x) => x.id === t.escrowId) : undefined
  const escrowStatus = e?.status ?? null
  if (!currentId) return { role: 'signed-out', escrowStatus, nextCounterpartyStep: null }
  if (!isParty(t, currentId)) return { role: 'none', escrowStatus, nextCounterpartyStep: null }
  return { role: currentId === t.buyerId ? 'buyer' : 'seller', escrowStatus, nextCounterpartyStep: counterpartyStep(t, e, currentId)?.label ?? null }
}

/** Performs the other side's next permitted step; throws with a readable message when it cannot. */
export function simulateCounterparty(tradeId: string): string {
  const t = findTrade(tradeId)
  const viewer = needMe()
  const next = counterpartyStep(t, t.escrowId ? findEscrow(t.escrowId) : undefined, viewer)
  if (!next) throw new Error('Não há ação pendente da outra parte agora.')
  next.run()
  return next.label
}

// ---------- Sails Agent (deterministic stand-ins; no model is consulted) ----------

function parseGoal(goal: string) {
  const g = goal.toLowerCase()
  const numbers = (goal.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.'))
  return {
    asset: /liquid/.test(g) ? 'USDT_LIQUID' : /usdt|tether|d[oó]lar/.test(g) ? 'USDT_TRC20' : 'BTC',
    side: /vend|sell/.test(g) ? 'SELL' as const : 'BUY' as const,
    minValue: numbers[0] ?? '100',
    maxValue: numbers[numbers.length - 1] ?? '1000',
    // Offers are priced in USD (discover() returns priceUsd only), so USD unless the goal names reais.
    currency: /\bbrl\b|r\$|reais|real\b/.test(g) ? 'BRL' : 'USD',
    fiatMethod: /\bted\b/.test(g) ? 'TED' : /transfer/.test(g) ? 'BANK_TRANSFER' : /dinheiro|esp[eé]cie|cash/.test(g) ? 'CASH' : 'PIX',
  }
}

// Same matching as the server's liquidity.service.ts proposeForIntent(), over the demo offers.
function proposeForIntent(intent: Intent<TradeIntentPayload>, amount: string): { proposal: TradeProposal | null; counterProposal: CounterProposal | null } {
  const { asset, side, minPriceUsd, maxPriceUsd, minReputationRating } = intent.payload
  const counterSide = side === 'BUY' ? 'SELL' : 'BUY'
  const reputation = (o: Offer) => findParticipant(o.userId).reputationScore
  const sorted = state.offers
    // shortcut: own offers are skipped (openp2p.trade() would refuse them anyway); the real server does not filter them here.
    .filter((o) => o.status === 'ACTIVE' && o.asset === asset && o.side === counterSide && o.userId !== intent.participantId)
    .sort((x, y) => (counterSide === 'SELL' ? 1 : -1) * (Number(x.priceUsd) - Number(y.priceUsd)))
  const amountNum = Number(amount)
  const passesAmountAndReputation = (o: Offer) =>
    reputation(o) >= (minReputationRating ?? 0) && amountNum >= Number(o.minAmount) && amountNum <= Number(o.maxAmount)
  const passesPrice = (o: Offer) =>
    !(minPriceUsd !== undefined && Number(o.priceUsd) < Number(minPriceUsd)) && !(maxPriceUsd !== undefined && Number(o.priceUsd) > Number(maxPriceUsd))

  const match = sorted.find((o) => passesAmountAndReputation(o) && passesPrice(o))
  if (match) {
    return { proposal: { offerId: match.id, priceUsd: match.priceUsd, amount, traderReputation: reputation(match), paymentMethods: [match.paymentMethod] }, counterProposal: null }
  }
  const bound = side === 'BUY' ? maxPriceUsd : minPriceUsd
  if (bound === undefined) return { proposal: null, counterProposal: null }
  const nearMiss = sorted.find((o) => passesAmountAndReputation(o) && (side === 'BUY' ? Number(o.priceUsd) > Number(bound) : Number(o.priceUsd) < Number(bound)))
  if (!nearMiss) return { proposal: null, counterProposal: null }
  return {
    proposal: null,
    counterProposal: {
      referenceOfferId: nearMiss.id, listedPriceUsd: nearMiss.priceUsd, suggestedPriceUsd: bound,
      reasoning: `Sugestão de exemplo do modo demonstração: a oferta mais próxima está listada a ${nearMiss.priceUsd}, fora do seu limite (${bound}). ` +
        'Isto é só uma sugestão: não cria nem altera nenhuma oferta, e negociar com ela usa o preço listado dela.',
    },
  }
}

// ---------- install ----------

function rejectAll(target: object, keep: string[] = []) {
  const record = target as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
    if (name === 'constructor' || keep.includes(name) || typeof record[name] !== 'function') continue
    record[name] = () => Promise.reject(new Error(UNAVAILABLE))
  }
}

// Demo state lives in this module and the patches live on the sailsClient
// instance: a hot update of either would leave them out of sync (and the
// real client hitting the network), so reload the page instead.
function reloadOnRelevantHotUpdate() {
  import.meta.hot?.on('vite:beforeUpdate', (payload) => {
    if (payload.updates.some((u) => /\/src\/demo\/|\/lib\/sailsClient|sails-sdk/.test(u.path))) window.location.reload()
  })
}

export function installDemoBackend() {
  load()
  shadowLocalStorage()
  reloadOnRelevantHotUpdate()
  const c = sailsClient
  const intents = (c as unknown as { intents: object }).intents

  // Anything not implemented below fails loudly instead of hitting the network.
  for (const mod of [c.identity, c.reputation, c.liquidity, c.openp2p, c.peers, c.capabilities, c.arbitration, c.paymentAccounts, c.proof, c.agents, intents]) rejectAll(mod)
  // resolveDisputeWithWallet() stays real: it signs with the user's own key, then calls the fake getDispute()/resolveDispute().
  rejectAll(c.settlement, ['resolveDisputeWithWallet'])
  rejectAll(c, ['setSessionToken', 'setOnSessionExpired', 'getSessionToken', 'requireWallet'])

  Object.assign(c.identity, {
    async create(keypair) {
      const p = registerPublicKey(hex(keypair!.publicKey))
      return { participant: clone(p), keypair: keypair! }
    },
    async authenticate(keypair) {
      currentId = registerPublicKey(hex(keypair.publicKey)).id
      const sessionToken = `demo-session-${currentId}`
      c.setSessionToken(sessionToken)
      return { participantId: currentId, sessionToken }
    },
    async me() { return clone(findParticipant(needMe())) },
    async get(id) {
      const { publicKey, displayName, peerId, verified } = findParticipant(id)
      return { id, publicKey, displayName, peerId, verified }
    },
  } satisfies Partial<typeof c.identity>)

  // AuthContext.logout() clears the token; forget the demo session too.
  const setToken = c.setSessionToken.bind(c)
  c.setSessionToken = (token) => { if (token === null) currentId = null; setToken(token) }

  Object.assign(c.capabilities, { async ensureCanonicalGrants() { return [] } } satisfies Partial<typeof c.capabilities>)
  Object.assign(c.reputation, {
    async get(id) { return reputationOf(findParticipant(id)) },
    async vouchFor(voucheeId) {
      const me = findParticipant(needMe())
      findParticipant(voucheeId)
      if (voucheeId === me.id) throw new Error('Você não pode avalizar a si mesmo')
      if (me.totalTrades < 3 || me.reputationScore <= 0) throw new Error('Requer pelo menos 3 trades e reputação positiva para avalizar alguém')
      if (state.vouches.some((v) => v.voucherId === me.id && v.voucheeId === voucheeId && !v.burnedAt)) throw new Error('Você já avalizou esta pessoa')
      const v: Vouch = { id: crypto.randomUUID(), voucherId: me.id, voucheeId, createdAt: now(), burnedAt: null }
      state.vouches.push(v)
      save()
      return clone(v)
    },
  } satisfies Partial<typeof c.reputation>)
  Object.assign(c.agents, {
    async generateTradeIntent(goal) { needMe(); return parseGoal(goal) },
    async assessIntentRisk() {
      return { risk: 'low', recommendation: 'proceed', reasoning: 'Exemplo do modo demonstração — nenhum modelo foi consultado.' }
    },
  } satisfies Partial<typeof c.agents>)
  Object.assign(intents, {
    async createIntent(type, payload, agentId) {
      const intent: Intent<TradeIntentPayload> = {
        id: crypto.randomUUID(), type, version: '1.0', participantId: needMe(), agentId, moduleId: 'open-p2p',
        payload, status: 'CREATED', createdAt: now(), updatedAt: now(), metadata: {},
      }
      state.intents.push(intent)
      save()
      return clone(intent)
    },
    async proposeTradeOutcome(intentId, amount) {
      const intent = state.intents.find((x) => x.id === intentId && x.participantId === needMe())
      if (!intent) throw notFound('Intenção', true)
      return proposeForIntent(intent, amount)
    },
    async proposeTrade(intentId, amount) {
      const intent = state.intents.find((x) => x.id === intentId && x.participantId === needMe())
      if (!intent) throw notFound('Intenção', true)
      return proposeForIntent(intent, amount).proposal
    },
  } satisfies Partial<Pick<typeof c, 'createIntent' | 'proposeTradeOutcome' | 'proposeTrade'>>)

  Object.assign(c.liquidity, {
    async discover({ asset, side, limit = 50, offset = 0 }) {
      const all = state.offers.filter((o) => o.status === 'ACTIVE' && (!asset || o.asset === asset) && (!side || o.side === side))
      const offers = all.slice(offset, offset + limit).map((o) => ({
        id: o.id, source: 'internal', asset: o.asset, side: o.side, priceUsd: o.priceUsd, minAmount: o.minAmount,
        maxAmount: o.maxAmount, paymentMethods: [o.paymentMethod], traderReputation: findParticipant(o.userId).reputationScore,
      }))
      return { offers, sources: ['internal'], total: all.length, hasMore: offset + limit < all.length }
    },
    async getOffer(id) {
      const o = state.offers.find((x) => x.id === id)
      if (!o) throw notFound('Oferta', true)
      const p = findParticipant(o.userId)
      const { userId: _u, paymentDetails: _d, ...rest } = o
      const detail: PublicOfferDetail = {
        ...rest,
        seller: { id: p.id, publicKey: p.publicKey, displayName: p.displayName, peerId: p.peerId, verified: p.verified, reputationScore: p.reputationScore, totalTrades: p.totalTrades, disputeRate: reputationOf(p).disputeRate },
      }
      return detail
    },
    async publish(input) {
      const o: Offer = {
        id: crypto.randomUUID(), userId: needMe(), asset: input.asset, side: input.side, priceUsd: input.priceUsd,
        priceBrl: input.priceBrl ?? null, minAmount: input.minAmount, maxAmount: input.maxAmount, paymentMethod: input.paymentMethod,
        paymentDetails: input.paymentDetails ?? null, status: 'ACTIVE', network: input.network ?? null,
        description: input.description ?? null, createdAt: now(), updatedAt: now(),
      }
      state.offers.push(o)
      save()
      return clone(o)
    },
    async getMyOffers() { const me = needMe(); return clone(state.offers.filter((o) => o.userId === me)) },
    async updateStatus(id, status) {
      const o = state.offers.find((x) => x.id === id && x.userId === needMe())
      if (!o) throw notFound('Oferta', true)
      Object.assign(o, { status, updatedAt: now() })
      save()
      return clone(o)
    },
  } satisfies Partial<typeof c.liquidity>)

  Object.assign(c.openp2p, {
    async trade(offerId, amount) {
      const me = needMe()
      const o = state.offers.find((x) => x.id === offerId)
      if (!o) throw notFound('Oferta', true)
      if (o.userId === me) throw new Error('Você não pode negociar com sua própria oferta')
      if (Number(amount) < Number(o.minAmount) || Number(amount) > Number(o.maxAmount)) throw new Error(`Quantidade fora dos limites da oferta (${o.minAmount}–${o.maxAmount})`)
      const [buyerId, sellerId] = o.side === 'SELL' ? [me, o.userId] : [o.userId, me]
      const t: Trade = { ...seedTrade(crypto.randomUUID(), o, buyerId, sellerId, amount, now(), 'PENDING') }
      state.trades.push(t)
      save()
      return clone(t)
    },
    async getTrades(pagination) {
      const me = needMe()
      const mine = state.trades.filter((t) => isParty(t, me)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const offset = pagination?.offset ?? 0, limit = pagination?.limit ?? 10
      return { trades: clone(mine.slice(offset, offset + limit).map(tradeWithOffer)), total: mine.length, hasMore: offset + limit < mine.length }
    },
    async getTrade(id) {
      if (id === REFRESH_TRADE_ID) return new Promise<Trade>(() => {}) // never settles; see DemoControls' refresh
      const t = findTrade(id)
      // Same as the real route: trade parties only (an assigned arbiter reads the escrow/dispute, not the trade).
      if (!isParty(t, needMe())) throw notFound('Trade')
      return clone(tradeWithOffer(t))
    },
    async getMessages(tradeId) {
      const items = clone(state.messages.filter((m) => m.tradeId === tradeId))
      return { items, total: items.length, hasMore: false, nextOffset: null }
    },
    // Local echo only: there is no counterparty on the other end in demo mode.
    chat(tradeId) {
      const handlers: ((m: ChatMessageEvent) => void)[] = []
      const channel = {
        onMessage: (h: (m: ChatMessageEvent) => void) => { handlers.push(h) },
        onEvent: () => {}, leave: () => {}, close: () => {},
        send: ({ content, msgType = 'TEXT' }: { content: string; msgType?: string }) => {
          const m: Message = { id: crypto.randomUUID(), tradeId, senderId: needMe(), content, msgType, readAt: null, createdAt: now() }
          state.messages.push(m)
          save()
          handlers.forEach((h) => h({ messageId: m.id, tradeId, senderId: m.senderId, content, msgType, timestamp: m.createdAt }))
        },
      }
      return channel as unknown as WebSocketChannel
    },
  } satisfies Partial<typeof c.openp2p>)

  Object.assign(c.settlement, {
    // Always MOCK: no real SettlementProvider, no deposit address, no signatures.
    async create(input) { return createEscrow(input.tradeId, needMe()) },
    async get(id) {
      const me = needMe()
      const e = findEscrow(id)
      // Trade parties and the dispute's assigned arbiter, like the real route.
      if (!isParty(findTrade(e.tradeId), me) && !(e.disputes ?? []).some((d) => d.arbiterId === me)) throw notFound('Escrow')
      return clone(e)
    },
    async lock(id) { return step(id, needMe(), 'lock') },
    async markPaymentSent(id) { return step(id, needMe(), 'markPaymentSent') },
    async release(id) { return step(id, needMe(), 'release') },
    // MOCK escrows have no signing round: the real "nothing pending" answer is a 404.
    async getPendingTransaction() { throw notFound('Transação pendente', true) },
    async dispute(id, reason, initialEvidence) {
      const me = needMe()
      const e = findEscrow(id)
      if (!isParty(findTrade(e.tradeId), me)) throw notFound('Escrow')
      if (!['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'].includes(e.status)) throw new Error(`Não é possível abrir disputa com o escrow em ${e.status}`)
      const d = newDispute(e.tradeId, id, me, JUDGE, reason, now(), { evidence: initialEvidence ?? [] })
      setEscrowStatus(e, 'DISPUTED', { disputes: [d] })
      return clone(d)
    },
    async listDisputes(pagination) {
      const me = needMe()
      const mine = allDisputes().filter((d) => d.arbiterId === me).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const offset = pagination?.offset ?? 0, limit = pagination?.limit ?? 50
      return { disputes: clone(mine.slice(offset, offset + limit)), total: mine.length, hasMore: offset + limit < mine.length }
    },
    async getDispute(id) {
      const me = needMe()
      const d = findDispute(id)
      if (d.arbiterId !== me && !isParty(findTrade(d.tradeId), me)) throw notFound('Disputa', true)
      return clone(d)
    },
    // Reached through the real resolveDisputeWithWallet(), which signs the authority decision with the user's own key.
    // shortcut: the signature is required but not cryptographically verified here (the real server verifies it).
    async resolveDispute(id, ruling, _releaseTo, _refundTo, splitBuyerBps, authoritySignature, authorityIssuedAt) {
      const d = findDispute(id)
      if (d.arbiterId !== needMe()) throw new Error('Somente o árbitro atribuído pode decidir esta disputa')
      if (!authoritySignature || !authorityIssuedAt) throw new Error('Decisão sem assinatura do árbitro')
      if (ruling === 'SPLIT' && splitBuyerBps === undefined) throw new Error('SPLIT requer splitBuyerBps')
      return applyRuling(d, ruling)
    },
    async submitDisputeEvidence(id, descriptor) {
      const d = findDispute(id)
      return addEvidence(d, requireParty(d), descriptor)
    },
    async contestAutoResolution(id) {
      const d = findDispute(id)
      requireParty(d)
      if (d.status !== 'AUTO_PROPOSED') throw new Error(`Não há sugestão automática pendente para contestar (status: ${d.status})`)
      if (d.autoResolutionDeadline && Date.parse(d.autoResolutionDeadline) < Date.now()) throw new Error('O prazo para contestar já terminou')
      return touch(d, { status: 'EVIDENCE_SUBMITTED' })
    },
    async appealDispute(id) {
      const d = findDispute(id)
      requireParty(d)
      if (d.status !== 'RESOLVED') throw new Error(`Só uma disputa resolvida pode ser apelada (status: ${d.status})`)
      const dispute = touch(d, {
        status: 'APPEALED', appealRound: d.appealRound + 1, previousRuling: d.ruling, previousArbiterId: d.arbiterId,
        arbiterId: APPEAL_PANEL, ruling: null, resolvedAt: null,
      })
      // MOCK escrows charge no fee, so the informational appeal fee is zero.
      return { dispute, appealFeeRequired: '0.00000000' }
    },
    async getPayoutAddress(participantId, asset) {
      const a = state.payoutAddresses.find((x) => x.participantId === participantId && x.asset === asset)
      if (!a || participantId !== needMe()) throw notFound('Endereço de recebimento')
      return clone(a)
    },
    async setPayoutAddress({ asset, address }) {
      const participantId = needMe()
      state.payoutAddresses = state.payoutAddresses.filter((x) => !(x.participantId === participantId && x.asset === asset))
      state.payoutAddresses.push({ participantId, asset, address })
      save()
      return { id: `${participantId}-${asset}`, participantId, asset, address, createdAt: now(), updatedAt: now() }
    },
  } satisfies Partial<typeof c.settlement>)

  // Simulated counterparties need a payout address so "seller releases" works when the PM is the seller.
  for (const p of state.participants.filter((x) => x.id.startsWith('demo-0'))) {
    for (const asset of new Set(state.offers.map((o) => o.asset))) {
      if (!state.payoutAddresses.some((a) => a.participantId === p.id && a.asset === asset)) {
        state.payoutAddresses.push({ participantId: p.id, asset, address: `endereco-ficticio-${p.id}-${asset.toLowerCase()}` })
      }
    }
  }
  save()
}
