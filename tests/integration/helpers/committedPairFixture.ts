/**
 * F4 corpus helper (TEXT, written 2026-11-20 against the recomposed stack @50aeecc4; NOT YET TYPE-CHECKED OR RUN).
 *
 * `committedPairFixture` builds a REAL COMMITTED commitment pair, the way production does, for suites that need an escrow of a type
 * other than MOCK (deny-by-default, CTO Despacho 029): an E21-admitted trade (its OWN Intent in trades.tradeIntentId, status
 * PENDING), pointing at the exact signed OfferEnvelope it accepted (trades.acceptedEnvelopeId, R1), and a pair created by the F3
 * service (proposePair by the taker, signPair by the maker, real Ed25519 signatures over the real digests). Nothing here writes
 * commitment_pairs or escrows.commitmentPairId by raw SQL and nothing disables a trigger: any bypass would void the proof (GK).
 * TEST-ONLY: it lives under tests/ and is never imported by src/.
 *
 * It works with a Prisma client connected as the superuser OR as sails_runtime: it only uses the operations the application itself
 * performs (intent/trade/offer/feePolicy creation is the suite's own business as before; the pair goes through the F3 service).
 *
 * Usage:
 *   const fx = await createCommitmentFixture(prisma, { asset: 'BTC', rail: 'MULTISIG' })
 *   const { tradeId, pairId } = await fx.committedPair()                      // a new admitted trade + its COMMITTED pair
 *   const escrow = await fx.createTestEscrow({ type: 'MULTISIG', lockedAmount: '0.005', asset: 'BTC' })  // bound to a fresh pair
 */
import nacl from 'tweetnacl'
import { randomUUID } from 'crypto'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const kp = (byte: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(byte))
const sign = (digestHex: string, k: nacl.SignKeyPair) => hex(nacl.sign.detached(new Uint8Array(Buffer.from(digestHex, 'hex')), k.secretKey))
const iso = (ms: number) => new Date(ms).toISOString()

export interface CommitmentFixtureOptions {
  /** The asset of the published Offer envelope and of every trade of this fixture (envelope, trade and commitment must agree). */
  asset?: string
  /** The rail of the pair (must be enabled in the service the fixture builds). */
  rail?: string
  /** Seed bytes for the three keys, so concurrent fixtures in one database do not collide on users.publicKey. */
  seed?: number
  /** Decimal strings in the Offer's min..max window. */
  amount?: string
  /** The Offer's minimum (default 0.00100000), for suites whose trade is below it. */
  minAmount?: string
  /** Commit to this EXISTING fee policy (e.g. the rail's live one) instead of a fresh fixture policy of its own rail scope. */
  feePolicyVersionId?: string
  /** Use EXISTING registered participants (id + 64-byte Ed25519 secret key, hex) instead of seed-derived users: the pair must be signed by the real parties. */
  maker?: { id: string; secretKey: string }
  taker?: { id: string; secretKey: string }
}

export async function createCommitmentFixture(prisma: any, opts: CommitmentFixtureOptions = {}) {
  const asset = opts.asset ?? 'BTC'
  const rail = opts.rail ?? 'MULTISIG'
  const amount = opts.amount ?? '0.00500000'
  const minAmount = opts.minAmount ?? '0.00100000'
  const seed = opts.seed ?? 0x51
  const fromSecret = (h: string) => nacl.sign.keyPair.fromSecretKey(new Uint8Array(Buffer.from(h, 'hex')))
  const maker = opts.maker ? fromSecret(opts.maker.secretKey) : kp(seed), taker = opts.taker ? fromSecret(opts.taker.secretKey) : kp(seed + 1), arbiter = kp(seed + 2)
  const RUN = randomUUID().slice(0, 8)
  const svcMod = require('../../../src/modules/open-p2p/commitment-pair.service')
  const envMod = require('../../../src/modules/open-liquidity/offer-envelope')
  const { offerEnvelopeRepository } = require('../../../src/modules/open-liquidity/offer-envelope-repository')
  const tc = require('../../../src/modules/open-p2p/trade-commitment')
  const ac = require('../../../src/modules/open-p2p/arbitration-commitment')

  const upsertUser = async (k: nacl.SignKeyPair) => (await prisma.user.upsert({ where: { publicKey: hex(k.publicKey) }, update: {}, create: { publicKey: hex(k.publicKey), displayName: 'fixture' } })).id
  const makerId = opts.maker?.id ?? await upsertUser(maker), takerId = opts.taker?.id ?? await upsertUser(taker)

  const fee = opts.feePolicyVersionId
    ? await prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: opts.feePolicyVersionId } })
    : await prisma.feePolicyVersion.create({
      data: { label: `fx-fee-${RUN}`, railScope: `FX-${RUN}`, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, createdBy: 'fixture' },
    })
  // Same reading as commitment-pair.service.ts's loadFeePolicy(), so the declared digest always matches the row.
  const feePolicyDigest = tc.feePolicyDigestV1({ protocolFeeRate: fee.protocolFeeRate.toFixed(8).replace(/\.?0+$/, ''), payerModel: fee.payerModel, economicBasis: fee.economicBasis, requiredConfirmations: fee.requiredConfirmations, smallTradeRule: fee.smallTradeRule })
  const legacyOffer = await prisma.offer.create({ data: { userId: makerId, asset, side: 'SELL', priceUsd: '65000', minAmount, maxAmount: '0.01', paymentMethod: 'PIX' } })

  // The signed Offer envelope the trades accept: ACTIVE, latest revision, owner = maker, terms equal to the trade's.
  const logicalOfferId = `fx-offer-${RUN}`
  let revision = 1
  const now = Date.now()
  const envelopeContent = {
    logicalOfferId, ownerPublicKey: hex(maker.publicKey), asset, side: 'SELL', priceUsd: '65000.00000000', minAmount, maxAmount: '0.01000000',
    paymentMethod: 'PIX', revision, createdAt: iso(now - 120_000), revisedAt: iso(now - 60_000), expiresAt: iso(now + 86_400_000), status: 'ACTIVE',
  }
  const ingest = await offerEnvelopeRepository.ingest({ ...envelopeContent, signature: envMod.signOfferEnvelope(envelopeContent, hex(maker.secretKey)) })
  if (!ingest.accepted) throw new Error(`fixture: the offer envelope was not accepted (${JSON.stringify(ingest)})`)
  const envelopeDigest = envMod.hashOfferEnvelope(envelopeContent).toString('hex')
  const envelopeRow = await prisma.offerEnvelope.findFirst({ where: { ownerPublicKey: hex(maker.publicKey), logicalOfferId, revision } })
  if (!envelopeRow) throw new Error('fixture: the accepted envelope row was not found')

  const service = new svcMod.CommitmentPairService({ enabledRails: () => new Set([rail]) })

  // The Offer envelope the NEXT pair names. Defaults to this fixture's own envelope; commitExistingTrade() points it at the envelope the
  // trade really accepted (trades.acceptedEnvelopeId, R1), because the COMMITTED transition reserves capacity of THAT logical Offer (M-1b).
  const env = { logicalOfferId, revision, digest: envelopeDigest, side: 'SELL', priceUsd: '65000.00000000', paymentMethod: 'PIX' }

  /** An E21-admitted trade: its OWN Intent, bound to the exact envelope it accepted (R1). Returns { tradeId, anchorRef }. */
  async function admitTrade(status: 'PENDING' | 'ACTIVE' = 'PENDING') {
    const intent = await prisma.intent.create({ data: { type: 'TradeIntent', participantId: takerId, moduleId: 'openp2p', payload: {}, status } })
    const trade = await prisma.trade.create({
      data: { offerId: legacyOffer.id, sellerId: makerId, buyerId: takerId, asset, amount: String(Number(amount)), status, priceUsd: '65000', totalUsd: String(Number(amount) * 65000), tradeIntentId: intent.id, acceptedEnvelopeId: envelopeRow.id },
    })
    return { tradeId: trade.id as string, anchorRef: intent.id as string }
  }

  /** A real PARTIALLY_SIGNED pair for `anchorRef` (taker proposed) plus `signMaker()`, the maker's COMMITTED transition (one call, once). */
  async function proposePartialPair(anchorRef: string) {
    const t = Date.now()
    const commitment = {
      anchorRef, offerEnvelopeDigest: env.digest, offerLogicalId: env.logicalOfferId, offerRevision: env.revision,
      makerPublicKey: hex(maker.publicKey), takerPublicKey: hex(taker.publicKey), side: env.side, asset, rail, network: 'bitcoin-testnet',
      amount, priceUsd: env.priceUsd, paymentMethod: env.paymentMethod, feePolicyVersionId: fee.id, feePolicyDigest,
      proposedAt: iso(t - 5_000), expiresAt: iso(t + 1_800_000),
    }
    const policy = { policyVersion: '1', capability: 'FIXED_ARBITER_COMMITMENT', rail, hosting: 'PARTIES_HOLD_COPIES_HOST_CONVENIENCE_FAILOVER_OPEN', mode: 'trusted-list', arbiterSelection: 'fixed', appeal: 'NONE_SCRIPT_FIXED', liveness: 'NONE_UNDER_CURRENT_SCRIPT' }
    const cd = tc.hashTradeCommitment(commitment)
    const arbitration = {
      commitmentDigest: cd, commitmentDomainTag: 'sails-trade-commitment-v1', anchorRef, makerPublicKey: commitment.makerPublicKey, takerPublicKey: commitment.takerPublicKey, rail,
      arbitrationCapability: 'FIXED_ARBITER_COMMITMENT', arbitrationPolicyDigest: ac.hashArbitrationPolicy(policy), arbiterRef: hex(arbiter.publicKey), proposedAt: commitment.proposedAt, expiresAt: commitment.expiresAt,
    }
    const ad = ac.hashArbitrationCommitment(arbitration)
    const proposed = await service.proposePair({
      participantId: takerId, idempotencyKey: randomUUID(),
      trade: { commitment, declaredDigest: cd, takerSignature: sign(cd, taker) },
      arbitration: { commitment: arbitration, declaredDigest: ad, policy, takerSignature: sign(ad, taker) },
    })
    const pairId = proposed.pairId as string
    return { pairId, makerSignatures: { trade: sign(cd, maker), arbitration: sign(ad, maker) }, signMaker: () => service.signPair({ participantId: makerId, idempotencyKey: randomUUID(), pairId, role: 'maker', tradeSignature: sign(cd, maker), arbitrationSignature: sign(ad, maker) }) }
  }

  /**
   * M-1b: a REAL owner-signed capacity declaration (sails-offer-capacity-v1, maker's key) stored for this fixture's logical Offer,
   * once. Every COMMITTED transition reserves capacity, so a fixture that commits pairs declares a large one first (same SQL
   * shape the service writes; the audit re-verifies it). No-op when the Offer already has a row (a suite may set its own).
   */
  async function declareCapacity(total = '1000000.00000000'): Promise<void> {
    const cap = require('../../../src/modules/open-liquidity/offer-capacity-declaration')
    const owner = hex(maker.publicKey)
    const content = { ownerPublicKey: owner, logicalOfferId: env.logicalOfferId, asset, capacityTotal: total, capacityRevision: 1, networkId: 'testnet', issuedAt: iso(Date.now()) }
    const signature = cap.signOfferCapacity(content, hex(maker.secretKey))
    await prisma.$executeRaw`INSERT INTO "offer_capacity" ("ownerPublicKey","logicalOfferId","capacityTotal","capacityRevision","declaredAt","declaration","declarationSignature")
      VALUES (${owner}, ${env.logicalOfferId}, ${total}::numeric, 1, ${new Date(content.issuedAt)}, ${JSON.stringify(content)}::jsonb, ${signature}) ON CONFLICT DO NOTHING`
  }

  /** A real COMMITTED pair for `anchorRef` (taker proposes, maker signs; real signatures). */
  async function commitPair(anchorRef: string): Promise<string> {
    await declareCapacity()
    const { pairId, signMaker } = await proposePartialPair(anchorRef)
    const committed = await signMaker()
    if (committed.state !== 'COMMITTED') throw new Error(`fixture: the pair did not reach COMMITTED (${committed.state})`)
    return pairId
  }

  return {
    makerId, takerId, legacyOfferId: legacyOffer.id as string, feePolicyVersionId: fee.id as string, logicalOfferId, envelopeRow,
    admitTrade, proposePartialPair, declareCapacity,
    /** The COMMITTED pair of a trade that already exists and is admitted (its tradeIntentId is the anchor), e.g. one made by tradeService.createTrade. */
    async commitExistingTrade(tradeId: string): Promise<string> {
      const t = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } })
      if (!t.tradeIntentId) throw new Error('fixture: the trade is not admitted (no tradeIntentId)')
      // CTO Despacho 050: a trade with acceptedEnvelopeId NULL cannot originate an executable escrow. Create it with acceptedEnvelopeFor().
      if (!t.acceptedEnvelopeId) throw new Error('fixture: the trade has no acceptedEnvelopeId (pass acceptedEnvelopeFor(prisma, seller, offer) to tradeService.createTrade)')
      const e = await prisma.offerEnvelope.findUniqueOrThrow({ where: { id: t.acceptedEnvelopeId } })
      Object.assign(env, { logicalOfferId: e.logicalOfferId, revision: e.revision, digest: e.contentDigest, side: String(e.side), priceUsd: Number(e.priceUsd).toFixed(8), paymentMethod: String(e.paymentMethod) })
      return commitPair(t.tradeIntentId)
    },
    /** A new admitted trade with its COMMITTED pair. */
    async committedPair(status: 'PENDING' | 'ACTIVE' = 'PENDING') {
      const { tradeId, anchorRef } = await admitTrade(status)
      return { tradeId, anchorRef, pairId: await commitPair(anchorRef) }
    },
    /**
     * An escrow bound to a REAL COMMITTED pair (fresh trade unless `tradeId` is given together with its `pairId`). `data` carries the
     * suite's own escrow fields (type, lockedAmount, asset, status, ...); the fixture only adds tradeId and commitmentPairId.
     */
    async createTestEscrow(data: Record<string, unknown> & { type?: string }, bound?: { tradeId: string; pairId: string }) {
      const { tradeId, pairId } = bound ?? (await this.committedPair())
      return prisma.escrow.create({ data: { lockedAmount: amount, asset, ...data, tradeId, commitmentPairId: pairId } })
    },
  }
}

/**
 * A signed ACTIVE Offer envelope that mirrors a legacy Offer row exactly (owner = the seller's own key, same asset/side/price/payment
 * method, same amount window), for suites that build the trade through tradeService.createTrade: pass the returned id as
 * `acceptedEnvelopeId` so the trade names the revision it accepted (R1) and its COMMITTED pair can reserve capacity (M-1b).
 */
export async function acceptedEnvelopeFor(prisma: any, seller: { id: string; secretKey: string }, offer: any): Promise<string> {
  const envMod = require('../../../src/modules/open-liquidity/offer-envelope')
  const { offerEnvelopeRepository } = require('../../../src/modules/open-liquidity/offer-envelope-repository')
  const kpSeller = nacl.sign.keyPair.fromSecretKey(new Uint8Array(Buffer.from(seller.secretKey, 'hex')))
  const dp8 = (v: unknown) => Number(String(v)).toFixed(8)
  const now = Date.now()
  const content = {
    logicalOfferId: `acc-${offer.id}`, ownerPublicKey: hex(kpSeller.publicKey), asset: String(offer.asset), side: String(offer.side), priceUsd: dp8(offer.priceUsd),
    minAmount: dp8(offer.minAmount), maxAmount: dp8(offer.maxAmount), paymentMethod: String(offer.paymentMethod), revision: 1,
    createdAt: iso(now - 120_000), revisedAt: iso(now - 60_000), expiresAt: iso(now + 86_400_000), status: 'ACTIVE',
  }
  const ingest = await offerEnvelopeRepository.ingest({ ...content, signature: envMod.signOfferEnvelope(content, hex(kpSeller.secretKey)) })
  if (!ingest.accepted) throw new Error(`acceptedEnvelopeFor: the envelope was not accepted (${JSON.stringify(ingest)})`)
  const row = await prisma.offerEnvelope.findFirst({ where: { ownerPublicKey: content.ownerPublicKey, logicalOfferId: content.logicalOfferId, revision: 1 } })
  if (!row) throw new Error('acceptedEnvelopeFor: the accepted envelope row was not found')
  return row.id as string
}

/**
 * For suites that build a trade through tradeService.createTrade and then call escrowService.createEscrow with a real rail (deny-by-default):
 * commits the pair of that admitted trade with the REAL parties' keys (registerTestParticipantWithKey). Call it before createEscrow.
 */
export async function commitTradePair(
  prisma: any,
  tradeId: string,
  seller: { id: string; secretKey: string },
  buyer: { id: string; secretKey: string },
  opts: { asset?: string; rail?: string; amount?: string; minAmount?: string; feePolicyVersionId?: string } = {}
): Promise<string> {
  const fx = await createCommitmentFixture(prisma, { asset: opts.asset ?? 'BTC', rail: opts.rail ?? 'MULTISIG', amount: opts.amount ?? '0.00100000', minAmount: opts.minAmount, feePolicyVersionId: opts.feePolicyVersionId, maker: seller, taker: buyer })
  return fx.commitExistingTrade(tradeId)
}

/**
 * For suites that used to build a raw trade between two throwaway users and then create an escrow on it: the same shape, but with real
 * Ed25519 identities and an E21-admitted trade (own Intent, accepted envelope). `commit()` creates the COMMITTED pair of that trade (once)
 * and returns its id: pass it as `commitmentPairId` of a raw escrow row, or call it before escrowService.createEscrow() (the service finds the pair by anchor).
 */
export async function createBoundTrade(prisma: any, opts: { asset?: string; rail?: string; amount?: string; minAmount?: string; feePolicyVersionId?: string } = {}) {
  const seller = nacl.sign.keyPair(), buyer = nacl.sign.keyPair()
  const sellerUser = await prisma.user.create({ data: { publicKey: hex(seller.publicKey) } })
  const buyerUser = await prisma.user.create({ data: { publicKey: hex(buyer.publicKey) } })
  const sellerP = { id: sellerUser.id as string, secretKey: hex(seller.secretKey) }, buyerP = { id: buyerUser.id as string, secretKey: hex(buyer.secretKey) }
  const fx = await createCommitmentFixture(prisma, { asset: opts.asset ?? 'BTC', rail: opts.rail ?? 'MULTISIG', amount: opts.amount ?? '0.00500000', minAmount: opts.minAmount, feePolicyVersionId: opts.feePolicyVersionId, maker: sellerP, taker: buyerP })
  const { tradeId, anchorRef } = await fx.admitTrade('PENDING')
  const trade = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } })
  let pairId: string | null = null
  return {
    seller: sellerUser, buyer: buyerUser, trade, anchorRef,
    async commit(): Promise<string> { return (pairId ??= await fx.commitExistingTrade(tradeId)) },
  }
}
