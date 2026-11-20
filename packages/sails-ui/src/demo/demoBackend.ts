/**
 * DEV-ONLY demonstration mode ("modo demonstração").
 *
 * Replaces the network-facing methods of the shared `sailsClient`
 * singleton with an in-memory, sessionStorage-persisted fake backend so
 * the whole Sails Market journey can be clicked through with no server.
 * Loaded only from main.tsx behind `import.meta.env.DEV`, so production
 * builds never contain it. Client-side cryptography (keypair generation,
 * passphrase encryption) stays real; only the server round trips are fake.
 * Every escrow is type MOCK (single-call release, no PSBT, no signatures).
 */
import { SailsNotFoundError } from '@satsails/p2p-trading-sdk'
import type {
  ChatMessageEvent, Dispute, Escrow, Message, Offer, Participant, PublicOfferDetail,
  ReputationScore, Trade, WebSocketChannel,
} from '@satsails/p2p-trading-sdk'
import { sailsClient } from '../lib/sailsClient'

const FLAG_KEY = 'sails_demo_mode'
const STATE_KEY = 'sails_demo_state'
// The real identity/escrow keys AuthContext/useEscrowKey keep in localStorage.
// Redirected to sessionStorage while demo mode is on, so a demo login never
// overwrites (or needs the passphrase of) a real stored key.
const SHADOWED_KEYS = new Set(['sails_ui_keypair_secret_hex', 'sails_ui_escrow_keypair'])
const SHADOW_PREFIX = 'sails_demo_shadow:'
/** Trade id the demo controls navigate through to make Trade.tsx refetch. */
export const REFRESH_TRADE_ID = 'demo-refresh'
export const UNAVAILABLE = 'Não disponível no modo demonstração'

interface DemoState {
  participants: Participant[]
  offers: Offer[]
  trades: Trade[]
  escrows: Escrow[]
  messages: Message[]
  payoutAddresses: { participantId: string; asset: Trade['asset']; address: string }[]
}

const now = () => new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

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

// Obviously fictional traders and offers; prices in USD like the real discover() route.
function seed(): DemoState {
  const g = 'demo-0a11', f = 'demo-0b22', m = 'demo-0c33', a = 'demo-0d44'
  return {
    participants: [
      participant(g, 'Gaivota Demo', 92, 148, 1, true),
      participant(f, 'Farol Norte Demo', 85, 63, 2, true),
      participant(m, 'Maré Mansa Demo', 78, 21, 0, false),
      participant(a, 'Âncora Demo', 96, 312, 3, true),
    ],
    offers: [
      offer('demo-offer-1', g, { asset: 'BTC', side: 'SELL', priceUsd: '97450', minAmount: '0.001', maxAmount: '0.05', paymentMethod: 'PIX', paymentDetails: 'Chave PIX fictícia: gaivota@exemplo.invalid', description: 'Oferta de exemplo do modo demonstração.' }, 2),
      offer('demo-offer-2', f, { asset: 'BTC', side: 'BUY', priceUsd: '96900', minAmount: '0.005', maxAmount: '0.2', paymentMethod: 'BANK_TRANSFER', paymentDetails: null, description: 'Compro BTC — exemplo fictício.' }, 1),
      offer('demo-offer-3', m, { asset: 'USDT_TRC20', side: 'SELL', priceUsd: '1.002', minAmount: '50', maxAmount: '2000', paymentMethod: 'PIX', paymentDetails: 'Chave PIX fictícia: mare-mansa@exemplo.invalid', description: null }, 3),
      offer('demo-offer-4', a, { asset: 'USDT_ERC20', side: 'BUY', priceUsd: '0.998', minAmount: '100', maxAmount: '5000', paymentMethod: 'TED', paymentDetails: null, description: 'Compro USDT — exemplo fictício.' }, 5),
      offer('demo-offer-5', a, { asset: 'BTC', side: 'SELL', priceUsd: '97800', minAmount: '0.0005', maxAmount: '0.01', paymentMethod: 'TED', paymentDetails: 'Banco Fictício 000, ag. 0001, conta 12345-6', description: null }, 4),
      offer('demo-offer-6', g, { asset: 'USDT_LIQUID', side: 'SELL', priceUsd: '1.004', minAmount: '20', maxAmount: '1500', paymentMethod: 'CASH', paymentDetails: 'Encontro combinado pelo chat (exemplo).', description: null }, 6),
    ],
    trades: [], escrows: [], messages: [], payoutAddresses: [],
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
    for (const k of SHADOWED_KEYS) sessionStorage.removeItem(SHADOW_PREFIX + k)
  } catch { /* nothing persisted */ }
  window.location.href = '/?demo=1'
}

function shadowIdentityStorage() {
  const proto = Storage.prototype
  const { getItem, setItem, removeItem } = proto
  const target = (store: Storage, key: string): [Storage, string] =>
    store === window.localStorage && SHADOWED_KEYS.has(key) ? [window.sessionStorage, SHADOW_PREFIX + key] : [store, key]
  proto.getItem = function (key: string) { const [s, k] = target(this, key); return getItem.call(s, k) }
  proto.setItem = function (key: string, value: string) { const [s, k] = target(this, key); setItem.call(s, k, value) }
  proto.removeItem = function (key: string) { const [s, k] = target(this, key); removeItem.call(s, k) }
}

// ---------- lookups ----------

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const notFound = (what: string) => new SailsNotFoundError(`${what} não encontrado (modo demonstração)`)
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
function reputationOf(p: Participant): ReputationScore {
  return {
    participantId: p.id, total: p.reputationScore, tradeScore: p.reputationScore, volumeScore: p.reputationScore,
    settlementScore: p.reputationScore, disputeRate: p.totalTrades ? p.disputeCount / p.totalTrades : 0,
    totalTrades: p.totalTrades, cumulativeFeesObserved: '0',
  }
}
const tradeWithOffer = (t: Trade): Trade => ({ ...t, offer: state.offers.find((o) => o.id === t.offerId) })
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function registerPublicKey(publicKey: string): Participant {
  let p = state.participants.find((x) => x.publicKey === publicKey)
  if (!p) {
    p = { ...participant(`demo-me-${publicKey.slice(0, 8)}`, `Você (demo ${publicKey.slice(0, 6)})`, 50, 0, 0, false), publicKey, createdAt: now() }
    state.participants.push(p)
    save()
  }
  return p
}

// ---------- escrow lifecycle (shared by the UI actions and the counterparty simulation) ----------

function setEscrowStatus(e: Escrow, status: Escrow['status'], patch: Partial<Escrow> = {}) {
  Object.assign(e, patch, { status, updatedAt: now() })
  const t = findTrade(e.tradeId)
  if (status === 'COMPLETED') Object.assign(t, { status: 'COMPLETED', completedAt: now(), updatedAt: now() })
  if (status === 'DISPUTED') Object.assign(t, { status: 'DISPUTED', updatedAt: now() })
  save()
  return clone(e)
}

function createEscrow(tradeId: string, actorId: string): Escrow {
  const t = findTrade(tradeId)
  if (actorId !== t.sellerId) throw new Error('Somente o vendedor cria o escrow')
  if (t.escrowId) return clone(findEscrow(t.escrowId))
  const e: Escrow = {
    id: crypto.randomUUID(), tradeId, type: 'MOCK', status: 'CREATED', lockedAmount: t.amount, asset: t.asset,
    network: null, multisigAddr: null, txLockId: null, txLockVout: null, fundedAmount: null, txReleaseId: null,
    timelockHours: 72, lockedAt: null, expiresAt: null, releasedAt: null, createdAt: now(), updatedAt: now(),
    disputes: [], participantKeys: [], feePolicyVersionId: null, snapshotProtocolFeeRate: null, snapshotPayerModel: null,
    snapshotEconomicBasis: null, snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: null, custodyModel: null,
  }
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

// ---------- counterparty simulation (DemoControls) ----------

export interface DemoTradeView {
  role: 'buyer' | 'seller' | 'none' | 'signed-out'
  escrowStatus: Escrow['status'] | null
  /** What the counterparty would do next, or null when it is not their turn. */
  nextCounterpartyStep: string | null
}

function counterpartyStep(t: Trade, e: Escrow | undefined, viewer: string) {
  const buyerView = viewer === t.buyerId
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
  if (currentId !== t.buyerId && currentId !== t.sellerId) return { role: 'none', escrowStatus, nextCounterpartyStep: null }
  return { role: currentId === t.buyerId ? 'buyer' : 'seller', escrowStatus, nextCounterpartyStep: counterpartyStep(t, e, currentId)?.label ?? null }
}

/** Performs the counterparty's next permitted step; throws with a readable message when it cannot. */
export function simulateCounterparty(tradeId: string): string {
  const t = findTrade(tradeId)
  const viewer = needMe()
  const next = counterpartyStep(t, t.escrowId ? findEscrow(t.escrowId) : undefined, viewer)
  if (!next) throw new Error('Não há ação pendente da contraparte agora.')
  next.run()
  return next.label
}

// ---------- install ----------

function rejectAll(target: object, keep: string[] = []) {
  const record = target as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
    if (name === 'constructor' || keep.includes(name) || typeof record[name] !== 'function') continue
    record[name] = () => Promise.reject(new Error(UNAVAILABLE))
  }
}

export function installDemoBackend() {
  load()
  shadowIdentityStorage()
  const c = sailsClient

  // Anything not implemented below fails loudly instead of hitting the network.
  for (const mod of [c.identity, c.reputation, c.liquidity, c.openp2p, c.settlement, c.peers, c.capabilities, c.arbitration, c.paymentAccounts, c.proof, c.agents]) rejectAll(mod)
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
  Object.assign(c.reputation, { async get(id) { return reputationOf(findParticipant(id)) } } satisfies Partial<typeof c.reputation>)
  Object.assign(c.agents, {
    async assessIntentRisk() {
      return { risk: 'low', recommendation: 'proceed', reasoning: 'Exemplo do modo demonstração — nenhum modelo foi consultado.' }
    },
  } satisfies Partial<typeof c.agents>)

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
      if (!o) throw notFound('Oferta')
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
      if (!o) throw notFound('Oferta')
      Object.assign(o, { status, updatedAt: now() })
      save()
      return clone(o)
    },
  } satisfies Partial<typeof c.liquidity>)

  Object.assign(c.openp2p, {
    async trade(offerId, amount) {
      const me = needMe()
      const o = state.offers.find((x) => x.id === offerId)
      if (!o) throw notFound('Oferta')
      if (o.userId === me) throw new Error('Você não pode negociar com sua própria oferta')
      const [buyerId, sellerId] = o.side === 'SELL' ? [me, o.userId] : [o.userId, me]
      const t: Trade = {
        id: crypto.randomUUID(), offerId, buyerId, sellerId, asset: o.asset, amount, priceUsd: o.priceUsd,
        totalUsd: (Number(amount) * Number(o.priceUsd)).toFixed(2), status: 'PENDING', escrowId: null, network: null,
        completedAt: null, cancelledAt: null, createdAt: now(), updatedAt: now(),
      }
      state.trades.push(t)
      save()
      return clone(t)
    },
    async getTrades(pagination) {
      const me = needMe()
      const mine = state.trades.filter((t) => t.buyerId === me || t.sellerId === me).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const offset = pagination?.offset ?? 0, limit = pagination?.limit ?? 10
      return { trades: clone(mine.slice(offset, offset + limit).map(tradeWithOffer)), total: mine.length, hasMore: offset + limit < mine.length }
    },
    async getTrade(id) {
      if (id === REFRESH_TRADE_ID) return new Promise<Trade>(() => {}) // never settles; see DemoControls' refresh
      const me = needMe()
      const t = findTrade(id)
      if (me !== t.buyerId && me !== t.sellerId) throw notFound('Trade')
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
      const e = findEscrow(id)
      const t = findTrade(e.tradeId)
      if (needMe() !== t.buyerId && needMe() !== t.sellerId) throw notFound('Escrow')
      return clone(e)
    },
    async lock(id) { return step(id, needMe(), 'lock') },
    async markPaymentSent(id) { return step(id, needMe(), 'markPaymentSent') },
    async release(id) { return step(id, needMe(), 'release') },
    // MOCK escrows have no signing round: the real "nothing pending" answer is a 404.
    async getPendingTransaction() { throw notFound('Transação pendente') },
    async dispute(id, reason) {
      const me = needMe()
      const e = findEscrow(id)
      if (!['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'].includes(e.status)) throw new Error(`Não é possível abrir disputa com o escrow em ${e.status}`)
      const d: Dispute = {
        id: crypto.randomUUID(), tradeId: e.tradeId, escrowId: id, openedBy: me, reason, evidence: [], arbiterId: null,
        status: 'OPENED', ruling: null, resolvedAt: null, appealRound: 0, previousRuling: null, previousArbiterId: null,
        autoResolutionRecommendation: null, autoResolutionConfidence: null, autoResolutionReasoning: null,
        autoResolutionDeadline: null, autoResolved: false, createdAt: now(), updatedAt: now(),
      }
      setEscrowStatus(e, 'DISPUTED', { disputes: [d] })
      return clone(d)
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
