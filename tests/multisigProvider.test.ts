import { withPersistedFundingAddress } from './helpers/persistedFundingAddress'
/**
 * MultisigProvider — real 2-of-3 Bitcoin P2WSH script/PSBT logic.
 *
 * Client-held-keys pass (2026-07-27): buyer/seller pubkeys are now
 * client-submitted (33-byte compressed secp256k1 hex, real fixtures
 * generated once via @noble/curves — see the constants below), not
 * server-derived. Only the arbiter key is still derived from
 * MULTISIG_SEED. releaseFunds()/refundFunds() now throw a clear "Phase 2
 * not built" error unconditionally, since this provider no longer holds
 * either counterparty's private key to sign with — see
 * multisig.provider.ts's own header comment for the full disclosure.
 *
 * Unlike WdkSettlementProvider (tests/wdkSettlementProvider.test.ts),
 * whose lock/release/refund calls need a live funded testnet wallet to
 * verify for real, everything testable here (key derivation for the
 * arbiter, script/address construction, UTXO verification) is pure and
 * fully verifiable without any live infrastructure — only the explorer
 * API network call is mocked.
 *
 * config.multisig.seed / config.settlement.trustedArbitrators are read
 * once at module-load time (src/config/index.ts), so each test that
 * needs a specific configuration resets modules and re-requires with
 * process.env set first.
 */
export {} // forces module scope — without this, top-level `const` here and in
// lightningHodlProvider.test.ts (also script-scoped, no imports of its own)
// collide as the SAME global binding under isolatedModules-style checking.

const ORIGINAL_ENV = process.env

// Real, valid 33-byte compressed secp256k1 pubkeys — generated once via
// @noble/curves (deterministic sha256-derived private keys), not random,
// so test failures are reproducible.
const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'
const BUYER2_PUBKEY = '03a8f0fdc9911d8e33f58b1fced67b769189f2188431515e5171462522cb1be87b'
const SELLER2_PUBKEY = '022704740d198905f841d3c4a82afd828398130d62190d9142761158eb893c9419'

function loadProvider(env: Record<string, string | undefined>) {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV, MOCK_ESCROW: 'false', ...env }
  return withPersistedFundingAddress(require('../src/modules/open-settlement/multisig.provider'))
}

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('keyIndexFor (deterministic per-role-and-id derivation)', () => {
  it('is deterministic — same role+id always derives the same index', () => {
    const { keyIndexFor } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    expect(keyIndexFor('arbiter', 'user-1')).toBe(keyIndexFor('arbiter', 'user-1'))
  })

  it('produces different indexes for different ids (distinct salt)', () => {
    const { keyIndexFor } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    expect(keyIndexFor('arbiter', 'arb-1')).not.toBe(keyIndexFor('arbiter', 'arb-2'))
  })

  it('always stays within the valid BIP-32 non-hardened index range', () => {
    const { keyIndexFor } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    for (const id of ['u1', 'a-very-long-user-id-uuid-like-string-1234567890', '']) {
      const index = keyIndexFor('arbiter', id)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(0x80000000)
    }
  })
})

describe('MultisigProvider.custodyModel', () => {
  it('declares itself client-held-buyer-seller-keys, not server-derived', () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    expect(multisigProvider.custodyModel).toBe('client-held-buyer-seller-keys-server-held-arbiter')
  })
})

describe('MultisigProvider config gating — inert without MULTISIG_SEED/TRUSTED_ARBITRATORS', () => {
  it('throws a clear error when MULTISIG_SEED is empty', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: '', TRUSTED_ARBITRATORS: 'arb-1' })
    await expect(multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)).rejects.toThrow('MULTISIG_SEED')
  })

  it('throws a clear error when no TRUSTED_ARBITRATORS entry is configured', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: '' })
    await expect(multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)).rejects.toThrow('TRUSTED_ARBITRATORS')
  })

  it('rejects a malformed (wrong-length) pubkey with a clear error', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    await expect(multisigProvider.getDepositAddress('trade-1', '02aabb', SELLER_PUBKEY)).rejects.toThrow('33-byte compressed')
  })
})

describe('MultisigProvider.getDepositAddress (real P2WSH address derivation from submitted pubkeys)', () => {
  it('is deterministic — same buyer/seller pubkeys always derive the same address', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const a = await multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    const b = await multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    expect(a.address).toBe(b.address)
    expect(a.address).toMatch(/^tb1/) // testnet bech32 (P2WSH) prefix
  })

  it('derives a different address for a different buyer/seller pubkey pair', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const a = await multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    const b = await multisigProvider.getDepositAddress('trade-2', BUYER2_PUBKEY, SELLER2_PUBKEY)
    expect(a.address).not.toBe(b.address)
  })

  it('derives a different address under a different arbiter seed (same buyer/seller pubkeys)', async () => {
    const { multisigProvider: p1 } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const a = await p1.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    const { multisigProvider: p2 } = loadProvider({ MULTISIG_SEED: 'seed-b', TRUSTED_ARBITRATORS: 'arb-1' })
    const b = await p2.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    expect(a.address).not.toBe(b.address)
  })

  // Missão 11 Fase 5.2 §2/§5 — the return now also carries the arbiter
  // commitment (arbiterPubkeyHex/arbiterId) that escrow.service.ts
  // persists as this escrow's immutable cryptographic record.
  it('also returns the arbiterPubkeyHex/arbiterId used to build the script — the exact value that gets persisted', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const { arbiterPubkeyHex, arbiterId } = await multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    expect(arbiterId).toBe('arb-1')
    expect(arbiterPubkeyHex).toBe(multisigProvider.getArbiterPubkeyHex('arb-1'))
  })

  // §5 — the persisted key must be byte-for-byte the same key actually
  // embedded in the script: reconstruct the P2WSH address from the three
  // raw pubkeys (buyer, seller, and the RETURNED arbiterPubkeyHex) exactly
  // the way a remote wallet would, and confirm it equals what
  // getDepositAddress() itself returned as the deposit address.
  it('the returned arbiterPubkeyHex, combined with buyer/seller pubkeys, reconstructs the SAME address getDepositAddress() returned', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const { address, arbiterPubkeyHex } = await multisigProvider.getDepositAddress('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)

    const bitcoin = require('bitcoinjs-lib')
    const ecc = require('tiny-secp256k1')
    bitcoin.initEccLib(ecc)
    const pubkeys = [BUYER_PUBKEY, SELLER_PUBKEY, arbiterPubkeyHex].map((hex) => Buffer.from(hex, 'hex')).sort(Buffer.compare)
    const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys, network: bitcoin.networks.testnet })
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: bitcoin.networks.testnet })
    expect(p2wsh.address).toBe(address)
  })
})

// Missão 11 Fase 5.2 §6/§9 — server-side historical-stability proof: once
// an escrow's arbiterPubkey is persisted (simulating what escrow.service.ts
// does at getDepositAddress() time), does a LATER live-config change
// (TRUSTED_ARBITRATORS reordered/replaced, or MULTISIG_SEED rotated) get
// silently trusted, or does the escrow's own persisted commitment win and
// fail the operation closed? A legacy escrow (no persisted commitment) is
// exercised the same way for direct comparison — it must behave exactly as
// it always has (oblivious to any of this), proving the compatibility path
// is untouched.
describe('MultisigProvider — Missão 11 Fase 5.2 arbiter-commitment drift detection (assertArbiterMatchesScript)', () => {
  const ecc = require('tiny-secp256k1')
  const bitcoin = require('bitcoinjs-lib')
  const { ECPairFactory } = require('ecpair')
  const crypto = require('crypto')
  bitcoin.initEccLib(ecc)
  const ECPair = ECPairFactory(ecc)
  const network = bitcoin.networks.testnet
  const buyerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('fase52-buyer').digest(), { network })
  const sellerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('fase52-seller').digest(), { network })
  const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
  const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')
  const REFUND_ADDRESS_UNUSED = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

  it('no drift: a persisted commitment matching the current live arbiter allows a disputed release to proceed', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const { arbiterPubkeyHex } = await multisigProvider.getDepositAddress('trade-1', buyerPubkeyHex, sellerPubkeyHex)

    const fetchMock = jest.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid: 'aa'.repeat(32), vout: 0, value: 100_000, status: { confirmed: true } }] })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: 5 }) })
    ;(global as any).fetch = fetchMock

    const { requiredSigners } = await multisigProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: arbiterPubkeyHex, lockedAmount: '0.001', txLockId: 'aa'.repeat(32), status: 'DISPUTED', triggeredBy: 'arb-1' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['buyer-1'])
  })

  it('TRUSTED_ARBITRATORS changed after creation (same seed): the persisted commitment no longer matches the new live arbiter — fails closed, never silently trusts today\'s config', async () => {
    const { multisigProvider: creationTimeProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const { arbiterPubkeyHex: persistedCommitment } = await creationTimeProvider.getDepositAddress('trade-1', buyerPubkeyHex, sellerPubkeyHex)

    // Config drift: arb-1 -> arb-2, same seed. A real deployment would
    // reach this new provider instance on the next request/process.
    const { multisigProvider: driftedProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-2' })

    await expect(
      driftedProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: persistedCommitment, lockedAmount: '0.001', txLockId: 'bb'.repeat(32), status: 'DISPUTED', triggeredBy: 'arb-2' },
        REFUND_ADDRESS_UNUSED
      )
    ).rejects.toThrow('does not match the arbiter public key committed')
  })

  it('MULTISIG_SEED rotated after creation (same arbiter id): the persisted commitment no longer matches the new live key — fails closed', async () => {
    const { multisigProvider: creationTimeProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const { arbiterPubkeyHex: persistedCommitment } = await creationTimeProvider.getDepositAddress('trade-1', buyerPubkeyHex, sellerPubkeyHex)

    // Config drift: the master seed itself rotated, same arbiter identity.
    const { multisigProvider: driftedProvider } = loadProvider({ MULTISIG_SEED: 'seed-ROTATED', TRUSTED_ARBITRATORS: 'arb-1' })

    await expect(
      driftedProvider.buildUnsignedRefund(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: persistedCommitment, lockedAmount: '0.001', txLockId: 'cc'.repeat(32), status: 'DISPUTED', triggeredBy: 'arb-1' },
        REFUND_ADDRESS_UNUSED
      )
    ).rejects.toThrow('does not match the arbiter public key committed')
  })

  it('legacy escrow (no persisted arbiterPubkey) is rejected outright, not silently derived from live config (Missão 11 Fase 9.3 §4)', async () => {
    // Missão 11 Fase 9.3 §4 (independently-reproduced red-team finding,
    // Kimi K3 R1 MULTI-01) — this used to fall back to live-config
    // derivation ("compatibility path preserved byte-for-byte"); that
    // fallback was removed since production never launched (no real
    // escrow anywhere is legacy-shaped) and it let a future
    // TRUSTED_ARBITRATORS/MULTISIG_SEED change silently redefine what an
    // uncommitted escrow's script means. partiesFor() now rejects an
    // escrow with no persisted arbiterPubkey before ever building a
    // script, so buildUnsignedRelease() never reaches the network or
    // assertArbiterMatchesScript() at all — the fetch mock below is set
    // up but never consumed, proving the rejection happens first.
    const { multisigProvider: driftedProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-2' })
    const fetchMock = jest.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid: 'dd'.repeat(32), vout: 0, value: 100_000, status: { confirmed: true } }] })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: 5 }) })
    ;(global as any).fetch = fetchMock

    await expect(
      driftedProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, lockedAmount: '0.001', txLockId: 'dd'.repeat(32), status: 'DISPUTED', triggeredBy: 'arb-2' },
        REFUND_ADDRESS_UNUSED
      )
    ).rejects.toThrow(/no persisted arbiter public-key commitment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Missão 11 Fase 7.3.1 §B — real P0 fix proof: triggeredBy is now
  // checked cryptographically against the PERSISTED commitment, never
  // against live config's defaultArbiterId(). Before this fix, this exact
  // scenario incorrectly THREW (triggeredBy 'arb-1' !== live scriptArbiter
  // 'arb-2') even though 'arb-1' is the only identity that can ever
  // validly sign this specific escrow's script — a real dispute stuck
  // forever the moment an operator ever rotated TRUSTED_ARBITRATORS.
  it('config rotation cannot rewrite historical authority: the ORIGINAL committed arbiter can still execute a ruling after TRUSTED_ARBITRATORS rotates away from them', async () => {
    const { multisigProvider: creationTimeProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const { arbiterPubkeyHex: persistedCommitment } = await creationTimeProvider.getDepositAddress('trade-1', buyerPubkeyHex, sellerPubkeyHex)

    // dispute.service.ts's raiseDispute()/appeal() (Fase 7.3.1 §B) always
    // assign the escrow's own persisted committed identity as arbiterId —
    // never assign()'s independent, live-config-driven pick — so
    // triggeredBy here is still 'arb-1' even though the deployment's
    // TRUSTED_ARBITRATORS has since rotated to a different arbiter.
    const { multisigProvider: driftedProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-2' })

    const fetchMock = jest.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid: 'ee'.repeat(32), vout: 0, value: 100_000, status: { confirmed: true } }] })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: 5 }) })
    ;(global as any).fetch = fetchMock

    const { requiredSigners } = await driftedProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: persistedCommitment, lockedAmount: '0.001', txLockId: 'ee'.repeat(32), status: 'DISPUTED', triggeredBy: 'arb-1' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['buyer-1'])
  })

  // Missão 11 Fase 7.3.1 §B — defense in depth: even a genuinely
  // configured, "authorized" trusted arbiter (present in
  // TRUSTED_ARBITRATORS) is still rejected if it isn't the SPECIFIC
  // identity actually baked into this escrow's script — proves a
  // multi-arbiter trusted-list configuration can never produce an
  // unexecutable ruling that reaches this far (dispute.service.ts's own
  // Fase 7.3.1 §B fix should never let this be reached in practice; this
  // is the structural backstop for a caller that bypasses it).
  it('multi-arbiter configuration cannot create an unexecutable ruling: a real but non-committed trusted arbiter is still rejected', async () => {
    const { multisigProvider: creationTimeProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1,arb-2' })
    const { arbiterPubkeyHex: persistedCommitment } = await creationTimeProvider.getDepositAddress('trade-1', buyerPubkeyHex, sellerPubkeyHex)

    await expect(
      creationTimeProvider.buildUnsignedRefund(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey: persistedCommitment, lockedAmount: '0.001', txLockId: 'ff'.repeat(32), status: 'DISPUTED', triggeredBy: 'arb-2' },
        REFUND_ADDRESS_UNUSED
      )
    ).rejects.toThrow('does not match the arbiter public key committed')
  })
})

describe('MultisigProvider — lockFunds() against a mocked explorer API', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    ;(global as any).fetch = fetchMock
  })

  it('lockFunds finds a sufficient confirmed UTXO and returns its txid', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } }],
    })
    // Missão 11 Fase 8.1 LB-02 — lockFunds() now re-verifies confirmation
    // DEPTH (not just the listing's own confirmed boolean) via two more
    // real explorer calls: fetchTransactionConfirmationStatus (this
    // UTXO's own block height) then fetchChainTipHeight. required
    // defaults to 1 here (MULTISIG_NETWORK unset -> testnet), so a single
    // confirmation (tip == block height) is exactly sufficient.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ confirmed: true, block_height: 100 }) })
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '100' })
    const result = await multisigProvider.lockFunds({ tradeId: 't1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey, lockedAmount: '0.0005' })
    expect(result.txId).toBe('a'.repeat(64))
    expect(result.address).toMatch(/^tb1/)
  })

  it('lockFunds throws when the funding UTXO exists but has not yet reached the required confirmation depth', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '3' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } }],
    })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ confirmed: true, block_height: 100 }) })
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '101' }) // only 2 confirmations, 3 required
    await expect(
      multisigProvider.lockFunds({ tradeId: 't1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey, lockedAmount: '0.0005' })
    ).rejects.toThrow(/has 2 of the required 3 confirmation/)
  })

  it('lockFunds throws (non-custodial — never fakes a lock) when no sufficient UTXO exists yet', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] })
    await expect(
      multisigProvider.lockFunds({ tradeId: 't1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey, lockedAmount: '0.0005' })
    ).rejects.toThrow('No funding UTXO')
  })

  it('lockFunds throws when no pubkeys have been submitted yet', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    await expect(
      multisigProvider.lockFunds({ tradeId: 't1', lockedAmount: '0.0005' })
    ).rejects.toThrow('requires a submitted buyer pubkey')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // F6 (docs/TECHNICAL_DEBT_AUDIT.md #53, 2026-09-07) — the 4 tests
  // previously here exercised verifyLock() directly (a "confirmed UTXO
  // meeting expected amount" check, plus 3 F1 bounded-retry proofs).
  // verifyLock() has been removed from the interface entirely — it
  // duplicated findFundingCandidate()/confirmationDepth() (lockFunds()'s
  // own logic, exercised by this describe block's other tests above)
  // with no real caller anywhere. The F1 bounded-retry/timeout property
  // those 3 tests proved is not lost: it's a property of boundedFetch()
  // itself (tests/boundedRpc.test.ts, provider-agnostic), not something
  // specific to verifyLock() — fetchUtxos() (used by both lockFunds()
  // and the now-removed verifyLock()) calls the identical shared helper
  // either way.
})

describe('MultisigProvider — releaseFunds()/refundFunds() are not directly callable (superseded by Phase 2 signature collection)', () => {
  it('releaseFunds() throws a clear, honest error pointing at the real flow', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    await expect(
      multisigProvider.releaseFunds(
        { tradeId: 't1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, lockedAmount: '0.0005', txLockId: 'a'.repeat(64), status: 'PAYMENT_PENDING' },
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
      )
    ).rejects.toThrow('not directly callable')
  })

  it('refundFunds() throws the same clear error', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    await expect(
      multisigProvider.refundFunds({ tradeId: 't1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, lockedAmount: '0.0005', txLockId: 'a'.repeat(64), status: 'FUNDS_LOCKED' })
    ).rejects.toThrow('not directly callable')
  })
})

// Phase 2 (2026-07-27) — real signature-collection flow: buildUnsignedRelease/
// buildUnsignedRefund build a real PSBT against a mocked explorer UTXO;
// finalizeRelease/finalizeRefund combine real independently-signed copies
// and broadcast. Needs actual private keys (not just the pubkey fixtures
// above) to produce real signatures — a separate deterministic keypair
// derived directly via tiny-secp256k1/ecpair (already real deps at the
// repo root, same libraries multisig.provider.ts itself uses), mirroring
// the psbt-combine-experiment.js verification done before this file was
// written.
describe('MultisigProvider — Phase 2 signature collection (buildUnsignedRelease/buildUnsignedRefund/finalizeRelease/finalizeRefund)', () => {
  const ecc = require('tiny-secp256k1')
  const bitcoin = require('bitcoinjs-lib')
  const { ECPairFactory } = require('ecpair')
  const crypto = require('crypto')
  bitcoin.initEccLib(ecc)
  const ECPair = ECPairFactory(ecc)
  const network = bitcoin.networks.testnet

  const buyerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('phase2-buyer').digest(), { network })
  const sellerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('phase2-seller').digest(), { network })
  const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
  const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')
  const REFUND_ADDRESS_UNUSED = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

  const fetchMock = jest.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    ;(global as any).fetch = fetchMock
  })

  // Real fee estimation (2026-08-02) — every buildUnsigned*() call now
  // does two fetches, in order: the UTXO lookup, then the real
  // mempool.space fee-rate lookup (multisig.provider.ts's own
  // fetchFeeRateSatsPerVByte()). Default rate (10 sat/vB) is a plausible
  // real-world value that doesn't matter for tests that don't assert
  // exact output amounts; pass an explicit rate for those that do.
  function mockUtxoFetch(txid: string, value: number, feeRateSatsPerVByte = 10) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ txid, vout: 0, value, status: { confirmed: true } }],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ halfHourFee: feeRateSatsPerVByte }),
    })
  }

  // Real fee estimation (2026-08-02) — closes this provider's own former
  // "a real deployment would query the explorer's fee-estimate endpoint"
  // placeholder now that a real deployment is exactly what's happening.
  describe('real fee estimation (mempool.space /v1/fees/recommended)', () => {
    it('uses the real fee rate to compute a non-flat fee — a higher rate produces a smaller spendable value from the same UTXO', async () => {
      const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')

      const txidLow = 'b1'.repeat(32)
      mockUtxoFetch(txidLow, 100_000, 2)
      const lowRate = await multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txidLow, status: 'PAYMENT_PENDING' },
        REFUND_ADDRESS_UNUSED
      )
      const txidHigh = 'b2'.repeat(32)
      mockUtxoFetch(txidHigh, 100_000, 50)
      const highRate = await multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txidHigh, status: 'PAYMENT_PENDING' },
        REFUND_ADDRESS_UNUSED
      )

      const outputValue = (psbtBase64: string) => bitcoin.Psbt.fromBase64(psbtBase64, { network }).txOutputs[0].value
      expect(outputValue(highRate.psbtBase64)).toBeLessThan(outputValue(lowRate.psbtBase64))
    })

    it('throws a clear error rather than guessing a fee when the fee-estimate endpoint is unreachable — F1: bounded safe retry (3 attempts) exhausted first', async () => {
      const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const txid = 'c1'.repeat(32)
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] })
      // F1 (docs/TECHNICAL_DEBT_AUDIT.md #51) — a network-level rejection
      // is retryable on this read-only call; all 3 bounded attempts must
      // be exhausted before the same "refusing to guess a fee" error the
      // caller always threw resurfaces.
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))

      await expect(
        multisigProvider.buildUnsignedRelease(
          { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
          REFUND_ADDRESS_UNUSED
        )
      ).rejects.toThrow(/refusing to guess a fee.*ECONNRESET/)
      expect(fetchMock).toHaveBeenCalledTimes(4) // 1 UTXO fetch + 3 fee-rate attempts
    })

    it('throws a clear error rather than guessing a fee when the endpoint returns no usable rate', async () => {
      const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const txid = 'c2'.repeat(32)
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] })
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })

      await expect(
        multisigProvider.buildUnsignedRelease(
          { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
          REFUND_ADDRESS_UNUSED
        )
      ).rejects.toThrow(/no usable rate/)
    })
  })

  it('buildUnsignedRelease returns a fully unsigned PSBT requiring both buyer and seller on the normal path', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = 'd'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['buyer-1', 'seller-1'])
    expect(typeof psbtBase64).toBe('string')
    // Fully unsigned — neither party's signature is embedded yet.
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    expect(() => psbt.finalizeAllInputs()).toThrow()
  })

  it('end-to-end: two independently-signed copies combine and finalize to a real broadcast txid', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = 'e'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['buyer-1', 'seller-1'])

    // Buyer and seller each independently load the SAME unsigned PSBT and
    // sign their own copy, without seeing the other's signature.
    const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    buyerCopy.signInput(0, buyerKey)
    const sellerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    sellerCopy.signInput(0, sellerKey)

    // Sails Core Implementation Program M9-R (R6, provider txid
    // integrity) — the broadcast response's own claimed txid ('f'.repeat(64))
    // is DELIBERATELY wrong here, proving finalizeRelease() ignores it:
    // the persisted txId must be the one Sails itself derived from the
    // exact transaction it constructed and sent, never the provider's
    // claim.
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => 'f'.repeat(64) })
    const result = await multisigProvider.finalizeRelease({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [buyerCopy.toBase64(), sellerCopy.toBase64()])
    expect(result.txId).not.toBe('f'.repeat(64))
    expect(result.txId).toBe(bitcoin.Transaction.fromHex(result.rawTxHex).getId())
  })

  it('finalizeRelease fails to combine/finalize with only one of two required signatures', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '1'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
      REFUND_ADDRESS_UNUSED
    )
    const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    buyerCopy.signInput(0, buyerKey)

    await expect(
      multisigProvider.finalizeRelease({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [buyerCopy.toBase64()])
    ).rejects.toThrow('failed to combine/finalize')
  })

  it('disputed release: arbiter pre-signs immediately, only the buyer remains a required client signer', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '2'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'DISPUTED', triggeredBy: 'arb-1' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['buyer-1'])

    // Missão 11 Fase 9.3 §7 — minimal false-positive regression assertion
    // for Kimi K3 R1 MULTI-05 ("PSBT verification bypass via witness
    // script malleability"). Reproduced as a false positive by direct
    // inspection of bitcoinjs-lib's own installed source: psbt.signInput()
    // enforces an allowlist defaulting to [SIGHASH_ALL] and throws for
    // anything else (checkSighashTypeAllowed(), node_modules/bitcoinjs-lib/
    // src/cjs/psbt.cjs) — combined with the fact this codebase's every
    // signInput() call (grep-verified, 3 call sites in this file) passes
    // no explicit sighashTypes override, every signature this provider
    // produces is bound to SIGHASH_ALL (commits the entire transaction,
    // not just this input) by construction. Asserted directly here rather
    // than only inferred: the arbiter's own pre-signature's DER-encoded
    // signature bytes must end in the SIGHASH_ALL byte (0x01).
    const arbiterSig = bitcoin.Psbt.fromBase64(psbtBase64, { network }).data.inputs[0].partialSig![0].signature
    expect(arbiterSig[arbiterSig.length - 1]).toBe(bitcoin.Transaction.SIGHASH_ALL)

    // The returned "unsigned" PSBT already carries the arbiter's own
    // signature — only the buyer needs to add theirs.
    const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    buyerCopy.signInput(0, buyerKey)

    // R6 — same deliberately-wrong-provider-response proof as above.
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '3'.repeat(64) })
    const result = await multisigProvider.finalizeRelease({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [buyerCopy.toBase64()])
    expect(result.txId).not.toBe('3'.repeat(64))
    expect(result.txId).toBe(bitcoin.Transaction.fromHex(result.rawTxHex).getId())
  })

  it('disputed release rejects a mismatched dispute arbiter before ever building a PSBT', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    await expect(
      multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: 'x'.repeat(64), status: 'DISPUTED', triggeredBy: 'not-the-arbiter' },
        REFUND_ADDRESS_UNUSED
      )
    ).rejects.toThrow('does not match')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('buildUnsignedRelease throws when the escrow has no recorded funding txid yet', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    await expect(
      multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', status: 'PAYMENT_PENDING' },
        REFUND_ADDRESS_UNUSED
      )
    ).rejects.toThrow('no recorded funding txid')
  })

  // Sails Core Implementation Program M8-R2 (Destination Authority
  // Conformance, 2026-09-11) — provider-boundary proof (adversarial
  // item 8): even a genuinely beneficiary-authorized destination (real
  // Destination Authority, resolved from a real registered PayoutAddress
  // — never a caller-supplied override) must still be REJECTED by the
  // rail if it's malformed for that rail. Protocol truth (who owns
  // Destination Authority) and Provider responsibility (translating the
  // bound reference into a rail-valid execution target) are independent
  // — a resolved-and-authorized reference is not automatically a
  // valid one. `bitcoinjs-lib`'s own address decoding is the real,
  // unmocked mechanism doing the rejecting here, exactly like the
  // pubkey-length check above.
  it('M8-R2: buildUnsignedRelease fails closed when the resolved destination is not a valid address for this network — wrong address family (an EVM-shaped hex string)', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '5'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    await expect(
      multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
        '0x000000000000000000000000000000000000dead' // an EVM address — wrong family for a BTC output
      )
    ).rejects.toThrow()
  })

  it('M8-R2: buildUnsignedRelease fails closed when the resolved destination is a mainnet address on a testnet-configured network — real network mismatch, not just a malformed string', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '6'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    await expect(
      multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' // real mainnet bech32 address — this provider is configured testnet
      )
    ).rejects.toThrow()
  })

  it('M8-R2: buildUnsignedRelease fails closed on a plain malformed string', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '7'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    await expect(
      multisigProvider.buildUnsignedRelease(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'PAYMENT_PENDING' },
        'not-a-real-address'
      )
    ).rejects.toThrow()
  })

  // Sails Core Implementation Program M8-RF (Destination Consistency,
  // 2026-08-31) — REPLACES the prior test of the same name area, which
  // proved buildUnsignedRefund() DERIVED the seller's refund address
  // internally from their multisig pubkey. That behavior was a
  // pre-M8.5 placeholder (verified via `git log`/`git show`, see this
  // function's own updated header comment) and has been removed: the
  // Provider now TRANSLATES an already-authorized destination, exactly
  // like buildUnsignedRelease()/buildUnsignedSplit() already do, and
  // never invents one. Two properties proved here: (1) the returned
  // toAddress is EXACTLY the authorizedDestination passed in, never a
  // pubkey-derived one, and (2) omitting it entirely fails closed rather
  // than silently falling back to the old derivation.
  it('M8-RF: buildUnsignedRefund() translates the authorized destination it is given — never derives one from the seller pubkey', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '4'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const authorizedDestination = REFUND_ADDRESS_UNUSED
    const pubkeyDerivedAddress = bitcoin.payments.p2wpkh({ pubkey: sellerKey.publicKey, network }).address!
    expect(authorizedDestination).not.toBe(pubkeyDerivedAddress) // the two really are different addresses in this test

    const { psbtBase64, requiredSigners, toAddress } = await multisigProvider.buildUnsignedRefund(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'FUNDS_LOCKED' },
      authorizedDestination
    )
    expect(toAddress).toBe(authorizedDestination)
    expect(toAddress).not.toBe(pubkeyDerivedAddress)
    expect(requiredSigners).toEqual(['seller-1', 'buyer-1'])
    expect(typeof psbtBase64).toBe('string')
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    expect(bitcoin.address.fromOutputScript(psbt.txOutputs[0].script, network)).toBe(authorizedDestination)
  })

  it('M8-RF: buildUnsignedRefund() fails closed with no fabricated destination when none is supplied', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    await expect(
      multisigProvider.buildUnsignedRefund(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: '4'.repeat(64), status: 'FUNDS_LOCKED' },
      )
    ).rejects.toThrow('requires an authorized destination')
  })

  it('end-to-end refund: two independently-signed copies combine and finalize', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '5'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedRefund(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'FUNDS_LOCKED' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['seller-1', 'buyer-1'])

    const sellerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    sellerCopy.signInput(0, sellerKey)
    const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    buyerCopy.signInput(0, buyerKey)

    // R6 — same deliberately-wrong-provider-response proof as above.
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '6'.repeat(64) })
    const result = await multisigProvider.finalizeRefund({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [sellerCopy.toBase64(), buyerCopy.toBase64()])
    expect(result.txId).not.toBe('6'.repeat(64))
    expect(result.txId).toBe(bitcoin.Transaction.fromHex(result.rawTxHex).getId())
  })

  it('disputed refund: arbiter pre-signs immediately, only the seller remains a required client signer', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    const txid = '7'.repeat(64)
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedRefund(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'DISPUTED', triggeredBy: 'arb-1' },
      REFUND_ADDRESS_UNUSED
    )
    expect(requiredSigners).toEqual(['seller-1'])

    const sellerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    sellerCopy.signInput(0, sellerKey)

    // R6 — same deliberately-wrong-provider-response proof as above.
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '8'.repeat(64) })
    const result = await multisigProvider.finalizeRefund({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [sellerCopy.toBase64()])
    expect(result.txId).not.toBe('8'.repeat(64))
    expect(result.txId).toBe(bitcoin.Transaction.fromHex(result.rawTxHex).getId())
  })

  // RFC-021 D9 (2026-08-02) — real 2-output PSBT construction. Always the
  // disputed shape (SPLIT is only ever reached via a dispute ruling) — the
  // arbiter pre-signs, and only ONE more required signer (the buyer, by
  // convention — mirrors buildUnsignedRelease()'s own arbiter+buyer
  // disputed pairing). Real constraint found writing these tests, not a
  // design choice: this is still a 2-of-3 script, so a third independent
  // signature (e.g. also collecting the seller's) would exceed the
  // threshold and fail to finalize ("Too many signatures") — see
  // multisig.provider.ts's buildUnsignedSplit() own comment.
  describe('buildUnsignedSplit/finalizeSplit', () => {
    it('builds a 2-output PSBT — buyer/seller shares sum exactly to the fee-adjusted UTXO value, split per buyerBps', async () => {
      const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const txid = '9'.repeat(64)
      // 1 sat/vB keeps the expected fee a clean, exact number: 11 + 110 +
      // 43*2 (2 outputs) = 207 vBytes * 1 = 207 sats — matches multisig.
      // provider.ts's own estimateFeeSats() formula exactly.
      mockUtxoFetch(txid, 100_000, 1)
      const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedSplit(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'DISPUTED', triggeredBy: 'arb-1' },
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        bitcoin.payments.p2wpkh({ pubkey: sellerKey.publicKey, network }).address,
        6000
      )
      expect(requiredSigners).toEqual(['buyer-1'])

      const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
      const spendableValue = 100_000 - 207 // fee-adjusted, real estimateFeeSats(1, 2)
      expect(psbt.txOutputs).toHaveLength(2)
      expect(psbt.txOutputs[0].value).toBe(BigInt(Math.floor(spendableValue * 0.6)))
      expect(psbt.txOutputs[1].value).toBe(BigInt(spendableValue) - psbt.txOutputs[0].value)
      expect(psbt.txOutputs[0].value + psbt.txOutputs[1].value).toBe(BigInt(spendableValue))

      // Already pre-signed by the arbiter — the buyer's signature alone
      // (2 of 3 total) is enough to finalize.
      const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
      buyerCopy.signInput(0, buyerKey)
      expect(() => buyerCopy.finalizeAllInputs()).not.toThrow()
    })

    it('end-to-end: the buyer signature combines with the arbiter pre-signature and broadcasts to a real txid', async () => {
      const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const txid = 'aa'.repeat(32)
      mockUtxoFetch(txid, 100_000)
      const { psbtBase64, requiredSigners } = await multisigProvider.buildUnsignedSplit(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'DISPUTED', triggeredBy: 'arb-1' },
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        bitcoin.payments.p2wpkh({ pubkey: sellerKey.publicKey, network }).address,
        3000
      )
      expect(requiredSigners).toEqual(['buyer-1'])

      const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
      buyerCopy.signInput(0, buyerKey)

      // R6 — same deliberately-wrong-provider-response proof as above.
      fetchMock.mockResolvedValueOnce({ ok: true, text: async () => 'bb'.repeat(32) })
      const result = await multisigProvider.finalizeSplit({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [buyerCopy.toBase64()])
      expect(result.txId).not.toBe('bb'.repeat(32))
      expect(result.txId).toBe(bitcoin.Transaction.fromHex(result.rawTxHex).getId())
    })

    it('finalizeSplit fails to combine/finalize with only the arbiter pre-signature and no client signature at all', async () => {
      const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
      const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
      const txid = 'cc'.repeat(32)
      mockUtxoFetch(txid, 100_000)
      const { psbtBase64 } = await multisigProvider.buildUnsignedSplit(
        { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, status: 'DISPUTED', triggeredBy: 'arb-1' },
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        bitcoin.payments.p2wpkh({ pubkey: sellerKey.publicKey, network }).address,
        5000
      )

      await expect(
        multisigProvider.finalizeSplit({ tradeId: 't1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey }, psbtBase64, [])
      ).rejects.toThrow('failed to combine/finalize')
    })
  })
})

// Missão 11 Fase 9.6 — CONC-03 crash recovery (Kimi K3 R2, CONFIRMED/P1
// during Fase 9.5's independent triage). reconcilePendingSettlement() is
// the on-chain-truth decision procedure a crash-recovery reconciliation
// run uses to determine whether a terminal-status MULTISIG escrow with
// no persisted txReleaseId already had its real transaction broadcast
// (Estado B) or never did (Estado A) — see that method's own header
// comment in multisig.provider.ts for the full four-step design and
// escrow-settlement-reconciliation.service.ts's header comment for why
// a blind retry is unsafe. These tests exercise the decision procedure
// directly, using real signed PSBTs (same ECPair/bitcoinjs-lib pattern
// this file's own "Phase 2 signature collection" describe block already
// established) so the "expected txid" these tests assert against is the
// SAME deterministic computation the real code performs — never a value
// the test simply asserts by fiat.
describe('MultisigProvider — reconcilePendingSettlement() (Missão 11 Fase 9.6, CONC-03 crash recovery)', () => {
  const ecc = require('tiny-secp256k1')
  const bitcoin = require('bitcoinjs-lib')
  const { ECPairFactory } = require('ecpair')
  const crypto = require('crypto')
  bitcoin.initEccLib(ecc)
  const ECPair = ECPairFactory(ecc)
  const network = bitcoin.networks.testnet

  const buyerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('conc03-buyer').digest(), { network })
  const sellerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('conc03-seller').digest(), { network })
  const buyerPubkeyHex = Buffer.from(buyerKey.publicKey).toString('hex')
  const sellerPubkeyHex = Buffer.from(sellerKey.publicKey).toString('hex')
  const REFUND_ADDRESS_UNUSED = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

  const fetchMock = jest.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    ;(global as any).fetch = fetchMock
  })

  function mockUtxoFetch(txid: string, value: number, feeRateSatsPerVByte = 10) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value, status: { confirmed: true } }] })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: feeRateSatsPerVByte }) })
  }

  // Builds a real unsigned PSBT (via buildUnsignedRelease, same as the
  // real initiate-release flow), has both parties independently sign
  // their own copy (same combine pattern the "Phase 2" describe block
  // above already proves is correct), and independently computes the
  // exact txid the real code's buildFinalizedTransaction() would compute
  // — WITHOUT calling reconcilePendingSettlement() itself, so the
  // expectation isn't circular.
  async function buildRealSignedRelease(multisigProvider: any, txid: string) {
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    mockUtxoFetch(txid, 100_000)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease(
      { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey, lockedAmount: '0.001', txLockId: txid, txLockVout: 0, status: 'PAYMENT_PENDING' },
      REFUND_ADDRESS_UNUSED
    )
    const buyerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    buyerCopy.signInput(0, buyerKey)
    const sellerCopy = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    sellerCopy.signInput(0, sellerKey)

    const independentlyMerged = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    independentlyMerged.combine(buyerCopy)
    independentlyMerged.combine(sellerCopy)
    independentlyMerged.finalizeAllInputs()
    const expectedTxId = independentlyMerged.extractTransaction().getId()

    const escrow = {
      tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1',
      buyerPubkey: buyerPubkeyHex, sellerPubkey: sellerPubkeyHex, arbiterPubkey,
      lockedAmount: '0.001', txLockId: txid, txLockVout: 0, status: 'COMPLETED',
    }
    return { escrow, unsignedPsbtBase64: psbtBase64, signedList: [buyerCopy.toBase64(), sellerCopy.toBase64()], expectedTxId }
  }

  it('Estado B (funds already moved) — the reconstructed transaction is already known to the network — converges WITHOUT a new broadcast', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const txid = 'a1'.repeat(32)
    const { escrow, unsignedPsbtBase64, signedList, expectedTxId } = await buildRealSignedRelease(multisigProvider, txid)
    fetchMock.mockClear() // discard buildUnsignedRelease()'s own setup fetches — only reconcilePendingSettlement()'s own calls should count below

    // Only ONE fetch call expected: the existence check. No UTXO lookup,
    // no broadcast — this is the whole point of asking the chain first.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ confirmed: true }) })

    const result = await multisigProvider.reconcilePendingSettlement(escrow, unsignedPsbtBase64, signedList)

    expect(result.outcome).toBe('ALREADY_BROADCAST')
    expect(result.txId).toBe(expectedTxId)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/tx/${expectedTxId}/status`)
  })

  it('Estado A (funds never moved) — reconstructed transaction unknown to the network, funding outpoint still unspent — broadcasts it for the first time', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const txid = 'a2'.repeat(32)
    const { escrow, unsignedPsbtBase64, signedList, expectedTxId } = await buildRealSignedRelease(multisigProvider, txid)
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce({ status: 404, ok: false }) // existence check: not found
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] }) // outpoint still unspent
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => expectedTxId }) // broadcast

    const result = await multisigProvider.reconcilePendingSettlement(escrow, unsignedPsbtBase64, signedList)

    expect(result.outcome).toBe('NEWLY_BROADCAST')
    expect(result.txId).toBe(expectedTxId)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // The broadcast call must carry the SAME deterministic transaction —
    // never a re-derived or re-signed one.
    const [, broadcastInit] = fetchMock.mock.calls[2]
    expect(typeof broadcastInit.body).toBe('string')
  })

  // Sails Core Implementation Program M9-R (R6, provider txid integrity)
  // — the reconciliation NEWLY_BROADCAST path independently derives
  // expectedTxId BEFORE ever calling broadcast(); if the explorer's own
  // POST /tx response disagrees with it, that disagreement must never be
  // persisted as the recovered txId.
  it('R6: a provider broadcast response that disagrees with the locally-derived txid is ignored — the locally-derived one is always what is returned', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const txid = 'a5'.repeat(32)
    const { escrow, unsignedPsbtBase64, signedList, expectedTxId } = await buildRealSignedRelease(multisigProvider, txid)
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce({ status: 404, ok: false }) // existence check: not found
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] }) // outpoint still unspent
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => 'ff'.repeat(32) }) // broadcast — deliberately wrong txid in the response body

    const result = await multisigProvider.reconcilePendingSettlement(escrow, unsignedPsbtBase64, signedList)

    expect(result.outcome).toBe('NEWLY_BROADCAST')
    expect(result.txId).toBe(expectedTxId)
    expect(result.txId).not.toBe('ff'.repeat(32))
  })

  it('anomaly — reconstructed transaction unknown to the network AND the funding outpoint is no longer unspent — fails closed, no broadcast attempted', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const txid = 'a3'.repeat(32)
    const { escrow, unsignedPsbtBase64, signedList } = await buildRealSignedRelease(multisigProvider, txid)
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce({ status: 404, ok: false }) // existence check: not found
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] }) // outpoint no longer in the unspent set

    const result = await multisigProvider.reconcilePendingSettlement(escrow, unsignedPsbtBase64, signedList)

    expect(result.outcome).toBe('ANOMALY')
    expect(result.detail).toMatch(/unexpected spend/i)
    // Exactly two calls — existence check + UTXO check. No third
    // (broadcast) call under any circumstance in this branch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('anomaly — no funding txLockId recorded at all', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const txid = 'a4'.repeat(32)
    const { escrow, unsignedPsbtBase64, signedList } = await buildRealSignedRelease(multisigProvider, txid)
    fetchMock.mockClear()
    escrow.txLockId = null as any

    fetchMock.mockResolvedValueOnce({ status: 404, ok: false })

    const result = await multisigProvider.reconcilePendingSettlement(escrow, unsignedPsbtBase64, signedList)

    expect(result.outcome).toBe('ANOMALY')
    expect(fetchMock).toHaveBeenCalledTimes(1) // never even reaches the outpoint check
  })

  it('a genuine 404 vs. every other explorer failure are NOT treated the same way — a non-404 error still throws loud, never silently reads as "not found"', async () => {
    const { multisigProvider } = loadProvider({ MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1' })
    const txid = 'a5'.repeat(32)
    const { escrow, unsignedPsbtBase64, signedList } = await buildRealSignedRelease(multisigProvider, txid)
    fetchMock.mockClear()

    // F1 (docs/TECHNICAL_DEBT_AUDIT.md #51) — a 503 is retryable on this
    // read-only existence check; all 3 bounded attempts must be
    // exhausted before the same "explorer API returned 503" error the
    // caller always threw resurfaces.
    fetchMock.mockResolvedValueOnce({ status: 503, ok: false })
    fetchMock.mockResolvedValueOnce({ status: 503, ok: false })
    fetchMock.mockResolvedValueOnce({ status: 503, ok: false })

    await expect(
      multisigProvider.reconcilePendingSettlement(escrow, unsignedPsbtBase64, signedList)
    ).rejects.toThrow(/explorer API returned 503/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
