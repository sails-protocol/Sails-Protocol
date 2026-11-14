// tests/integration/pendingRoundLifecycleHarness.ts
//
// Issue #239 - shared fixtures for the signing-round lifecycle suites: REAL MULTISIG escrows built through the
// production services (keys, funding, payout addresses, initiate*), REAL 2-of-3 P2WSH PSBTs signed with keys this
// test controls, and a deterministic explorer stub. The explorer is the only simulated boundary (CTO GO: the real
// explorer is a separate gate before homologation).
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
export const NETWORK = bitcoin.networks.testnet
export type Key = ReturnType<typeof ECPair.makeRandom>
/** A fresh participant key pair for each escrow: a MULTISIG address is committed to one escrow only
 *  (escrows_multisig_addr_key), and integration files share one database, so fixed keys would collide. */
export function participantKeys() {
  const buyerKey = ECPair.makeRandom({ network: NETWORK }); const sellerKey = ECPair.makeRandom({ network: NETWORK })
  return { buyerKey, sellerKey, BUYER_PUBKEY: Buffer.from(buyerKey.publicKey).toString('hex'), SELLER_PUBKEY: Buffer.from(sellerKey.publicKey).toString('hex') }
}

export function testnetAddress(label: string): string {
  const pubkey = Buffer.from(ecc.pointFromScalar(createHash('sha256').update(label).digest(), true)!)
  return bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).address!
}

/** The chain as the explorer stub reports it. Mutate it inside a test; it is reset per test. */
export interface Chain {
  fundings: Set<string>
  spentBy: Map<string, string> // "txid:vout" -> spending txid
  confirmed: Set<string>
  mempool: Set<string>
  hex: Map<string, string>
  outspendUnreadable: boolean
  broadcasts: string[]
  /** The stub lists every funding for any address: while set, lockFunds() sees only this funding. */
  locking: string | null
  /** Every outspend lookup the explorer served, in order ("txid:vout"). */
  outspendCalls: string[]
}
export const newChain = (): Chain => ({ fundings: new Set(), spentBy: new Map(), confirmed: new Set(), mempool: new Set(), hex: new Map(), outspendUnreadable: false, broadcasts: [], locking: null, outspendCalls: [] })

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
const text = (body: string) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response
const missing = () => ({ ok: false, status: 404, text: async () => 'not found', json: async () => ({}) }) as unknown as Response

export function explorer(chain: Chain): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/tx')) {
      const txid = bitcoin.Transaction.fromHex(init.body as string).getId()
      chain.broadcasts.push(txid)
      return text(txid)
    }
    if (url.includes('/blocks/tip/height')) return text('101')
    if (url.includes('/v1/fees/recommended')) return json({ halfHourFee: 5, fastestFee: 8 })
    const outspend = url.match(/\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/)
    if (outspend) {
      chain.outspendCalls.push(`${outspend[1]}:${outspend[2]}`)
      if (chain.outspendUnreadable) return { ok: false, status: 503, text: async () => 'unavailable' } as unknown as Response
      const by = chain.spentBy.get(`${outspend[1]}:${outspend[2]}`)
      return json(by ? { spent: true, txid: by } : { spent: false })
    }
    const hex = url.match(/\/tx\/([0-9a-f]{64})\/hex$/)
    if (hex) return chain.hex.has(hex[1]) ? text(chain.hex.get(hex[1])!) : missing()
    const status = url.match(/\/tx\/([0-9a-f]{64})\/status$/)
    if (status) {
      if (chain.fundings.has(status[1])) return json({ confirmed: true, block_height: 90 })
      if (chain.confirmed.has(status[1])) return json({ confirmed: true, block_height: 101 })
      if (chain.mempool.has(status[1])) return json({ confirmed: false })
      return missing()
    }
    if (url.includes('/utxo')) return json((chain.locking ? [chain.locking] : [...chain.fundings]).map((txid) => ({ txid, vout: 0, value: 100_000, status: { confirmed: true } })))
    return missing()
  }) as typeof fetch
}

export function signRound(unsignedPsbtBase64: string, key: Key): string {
  const psbt = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network: NETWORK })
  psbt.signInput(0, key)
  return psbt.toBase64()
}

/** What a signer does outside Sails: combine the signatures it holds, finalize, broadcast. */
export function completeOutsideSails(unsignedPsbtBase64: string, signed: string[]): { txid: string; hex: string } {
  const merged = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network: NETWORK })
  for (const s of signed) merged.combine(bitcoin.Psbt.fromBase64(s, { network: NETWORK }))
  merged.finalizeAllInputs()
  const tx = merged.extractTransaction()
  return { txid: tx.getId(), hex: tx.toHex() }
}

/**
 * A REAL cooperative MULTISIG round built through the production services: keys, funding, (payment sent,) payout
 * address and initiate-release / initiate-refund by the seller. Release needs [buyer, seller]; refund [seller, buyer].
 */
export async function buildCooperative(
  deps: { prisma: any; escrowService: any; identityService: any; liquidityRouter: any; tradeService: any; payoutAddressService: any },
  chain: Chain,
  label: string,
  kind: 'release' | 'refund' = 'release'
) {
  const { registerTestParticipant } = require('./identityTestHelpers')
  const { MULTISIG_CAPABILITY_PROFILE_V1 } = require('@satsails/p2p-schemas')
  const { prisma, escrowService, identityService, liquidityRouter, tradeService, payoutAddressService } = deps
  const seller = await registerTestParticipant(identityService, 'Seller')
  const buyer = await registerTestParticipant(identityService, 'Buyer')
  const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
  const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
  const created = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
  await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: created.id } })
  const { buyerKey, sellerKey, BUYER_PUBKEY, SELLER_PUBKEY } = participantKeys()
  await escrowService.submitParticipantKey(created.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
  await escrowService.submitParticipantKey(created.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
  const funding = createHash('sha256').update(`i239-${label}-${Math.random()}-${Date.now()}`).digest('hex')
  chain.fundings.add(funding)
  chain.locking = funding
  await escrowService.lockFunds(created.id, seller.id)
  chain.locking = null
  if (kind === 'release') {
    await escrowService.markPaymentSent(created.id, buyer.id)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`${label}-buyer`))
    await escrowService.initiateRelease(created.id, undefined, seller.id)
  } else {
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', testnetAddress(`${label}-seller`))
    await escrowService.initiateRefund(created.id, seller.id)
  }
  const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: created.id } })
  const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: created.id } })
  return { escrow, trade, buyer, seller, round, funding, buyerKey, sellerKey } as {
    buyerKey: Key; sellerKey: Key
    escrow: { id: string; status: string; txLockId: string | null }; trade: { id: string }; buyer: { id: string }; seller: { id: string }
    round: { id: string; unsignedPsbtBase64: string; requiredSigners: string[]; disputeId: string | null; kind: string }; funding: string
  }
}

/** JSON form of a Chain, to hand the same explorer state to another OS process. */
export const chainToJson = (c: Chain) => JSON.stringify({ ...c, fundings: [...c.fundings], spentBy: [...c.spentBy], confirmed: [...c.confirmed], mempool: [...c.mempool], hex: [...c.hex] })
export function chainFromJson(text: string): Chain {
  const o = JSON.parse(text)
  return { ...o, fundings: new Set(o.fundings), spentBy: new Map(o.spentBy), confirmed: new Set(o.confirmed), mempool: new Set(o.mempool), hex: new Map(o.hex) }
}
