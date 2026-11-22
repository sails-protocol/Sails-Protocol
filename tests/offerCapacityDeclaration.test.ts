import nacl from 'tweetnacl'
import {
  OFFER_CAPACITY_DOMAIN_TAG, canonicalizeOfferCapacity, signOfferCapacity, verifyOfferCapacity, validateOfferCapacityFields,
  OfferCapacityDeclarationContent, SignedOfferCapacityDeclaration, signUnblockDecision, verifyUnblockDecision, OFFER_CAPACITY_UNBLOCK_DOMAIN_TAG,
} from '../src/modules/open-liquidity/offer-capacity-declaration'
import { signOfferEnvelope, OfferEnvelopeContent } from '../src/modules/open-liquidity/offer-envelope'

const kp = (seedByte: number) => { const k = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte)); return { pub: Buffer.from(k.publicKey).toString('hex'), sec: Buffer.from(k.secretKey).toString('hex') } }
const owner = kp(1)
const other = kp(2)
const content = (over: Partial<OfferCapacityDeclarationContent> = {}): OfferCapacityDeclarationContent => ({
  ownerPublicKey: owner.pub, logicalOfferId: 'offer-1', asset: 'USDT', capacityTotal: '100.00000000', capacityRevision: 1, networkId: 'testnet', issuedAt: '2026-11-20T12:00:00.000Z', ...over,
})
const signed = (c = content(), sec = owner.sec): SignedOfferCapacityDeclaration => ({ ...c, signature: signOfferCapacity(c, sec) })

describe('sails-offer-capacity-v1 declaration', () => {
  it('a declaration signed by the owner key verifies on its own network', () => {
    expect(verifyOfferCapacity(signed(), 'testnet')).toEqual({ valid: true })
  })

  it('canonical bytes start with the capacity domain tag, which is not the envelope tag (no cross-class replay)', () => {
    expect(canonicalizeOfferCapacity(content()).toString('utf8').startsWith(OFFER_CAPACITY_DOMAIN_TAG + '\x1f')).toBe(true)
    expect(OFFER_CAPACITY_DOMAIN_TAG).not.toBe('sails-offer-envelope-v1')
  })

  it('deterministic test vector (two implementations must agree on these exact bytes)', () => {
    expect(JSON.stringify(canonicalizeOfferCapacity(content()).toString('utf8'))).toBe(
      JSON.stringify(['sails-offer-capacity-v1', owner.pub, 'offer-1', 'USDT', '100.00000000', '1', 'testnet', '2026-11-20T12:00:00.000Z'].join('\x1f')))
  })

  it('MUTANT: a signature from another key is refused', () => {
    expect(verifyOfferCapacity({ ...content(), signature: signOfferCapacity(content(), other.sec) }, 'testnet').valid).toBe(false)
  })

  it('MUTANT: an operational/other key standing in for the owner (ownerPublicKey swapped, owner signature kept) is refused', () => {
    expect(verifyOfferCapacity({ ...signed(), ownerPublicKey: other.pub }, 'testnet').valid).toBe(false)
  })

  it('MUTANT: a declaration for another network/environment is refused even with a valid signature', () => {
    const v = verifyOfferCapacity(signed(content({ networkId: 'testnet' })), 'mainnet')
    expect(v.valid).toBe(false)
  })

  it.each([
    ['capacityTotal', { capacityTotal: '999.00000000' }],
    ['capacityRevision', { capacityRevision: 2 }],
    ['logicalOfferId', { logicalOfferId: 'offer-2' }],
    ['asset', { asset: 'BTC' }],
    ['issuedAt', { issuedAt: '2026-11-21T12:00:00.000Z' }],
    ['networkId', { networkId: 'testnet2' }],
  ])('MUTANT: altering %s after signing invalidates the signature', (_n, over) => {
    expect(verifyOfferCapacity({ ...signed(), ...over } as SignedOfferCapacityDeclaration, (over as { networkId?: string }).networkId ?? 'testnet').valid).toBe(false)
  })

  it('MUTANT: an Offer-envelope signature is not a capacity signature (same key, other message class)', () => {
    const env: OfferEnvelopeContent = { logicalOfferId: 'offer-1', ownerPublicKey: owner.pub, asset: 'USDT', side: 'SELL', priceUsd: '1.00000000', minAmount: '1.00000000', maxAmount: '100.00000000', paymentMethod: 'PIX', revision: 1, createdAt: '2026-11-20T12:00:00.000Z', revisedAt: '2026-11-20T12:00:00.000Z', expiresAt: '2026-12-20T12:00:00.000Z', status: 'ACTIVE' } as unknown as OfferEnvelopeContent
    expect(verifyOfferCapacity({ ...content(), signature: signOfferEnvelope(env, owner.sec) }, 'testnet').valid).toBe(false)
  })

  it('shape: separator injection, non-canonical decimal, zero capacity, bad revision and network are rejected before any crypto', () => {
    for (const bad of [{ logicalOfferId: 'a\x1fb' }, { capacityTotal: '100' }, { capacityTotal: '0.00000000' }, { capacityRevision: 0 }, { capacityRevision: 1.5 }, { networkId: 'Main Net' }, { issuedAt: '2026-11-20' }, { ownerPublicKey: 'AB' }]) {
      expect(validateOfferCapacityFields({ ...signed(), ...bad } as SignedOfferCapacityDeclaration).valid).toBe(false)
    }
  })

  it('a missing signature is refused', () => {
    expect(verifyOfferCapacity(content() as SignedOfferCapacityDeclaration, 'testnet').valid).toBe(false)
  })

  describe('reorg-unblock decision signature (decision A)', () => {
    const digest = 'a1'.repeat(32)
    it('a reviewer signature over the request digest verifies; another digest, another key or the capacity class do not', () => {
      const sig = signUnblockDecision(digest, owner.sec)
      expect(verifyUnblockDecision(digest, owner.pub, sig)).toEqual({ valid: true })
      expect(verifyUnblockDecision('b2'.repeat(32), owner.pub, sig).valid).toBe(false) // replay on another request
      expect(verifyUnblockDecision(digest, other.pub, sig).valid).toBe(false)
      expect(verifyUnblockDecision(digest, owner.pub, signOfferCapacity(content(), owner.sec)).valid).toBe(false) // other message class
      expect(verifyUnblockDecision(digest, owner.pub, 'xyz').valid).toBe(false)
      expect(OFFER_CAPACITY_UNBLOCK_DOMAIN_TAG).not.toBe(OFFER_CAPACITY_DOMAIN_TAG)
    })
  })
})
