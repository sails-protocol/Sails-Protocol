import { withPersistedFundingAddress } from './helpers/persistedFundingAddress'
/**
 * Missão 10 — Outpoint Integrity: provider-level UTXO selection tests.
 *
 * Bitcoin identifies a UTXO by outpoint (txid:vout), not txid alone.
 * Before this mission, buildUnsignedSpend() (shared by release/refund/
 * split) matched a funding UTXO by `txid === escrow.txLockId` only,
 * trusting whatever vout the explorer happened to report first. These
 * tests prove: (1) once a vout has been persisted, selection is
 * outpoint-exact, immune to a funding transaction paying the same
 * address more than once; (2) an escrow with no persisted vout (every
 * row that predates this migration, including the real Missão 09
 * mainnet escrow) still resolves via the original txid-only fallback,
 * disclosed and unchanged.
 *
 * Same mocked-explorer-API convention tests/multisigProvider.test.ts
 * already established — no live infrastructure needed, every assertion
 * here is pure and deterministic.
 */
export {}

const ORIGINAL_ENV = process.env

const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

function loadProvider(env: Record<string, string | undefined> = {}) {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV, MOCK_ESCROW: 'false', MULTISIG_SEED: 'seed-a', TRUSTED_ARBITRATORS: 'arb-1', ...env }
  return withPersistedFundingAddress(require('../src/modules/open-settlement/multisig.provider'))
}

afterAll(() => {
  process.env = ORIGINAL_ENV
})

const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const crypto = require('crypto')
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.testnet
const buyerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('outpoint-buyer').digest(), { network })
const sellerKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update('outpoint-seller').digest(), { network })
const REFUND_ADDRESS_UNUSED = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  ;(global as any).fetch = fetchMock
})

function mockExplorerThenFee(utxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed: boolean } }>, feeRateSatsPerVByte = 10) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => utxos.map((u) => ({ status: { confirmed: true }, ...u })) })
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ halfHourFee: feeRateSatsPerVByte }) })
}

// Missão 11 Fase 9.3 §4 — partiesFor() now rejects an escrow with no
// persisted arbiter commitment.
const ARBITER_PUBKEY_HEX: string = loadProvider().multisigProvider.getArbiterPubkeyHex('arb-1')

describe('MultisigProvider.lockFunds — now returns vout alongside txid', () => {
  it('returns the exact vout of the matched UTXO', async () => {
    const { multisigProvider } = loadProvider()
    const arbiterPubkey = multisigProvider.getArbiterPubkeyHex('arb-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ txid: 'a'.repeat(64), vout: 3, value: 100_000, status: { confirmed: true } }],
    })
    // Missão 11 Fase 8.1 LB-02 — lockFunds() now re-verifies confirmation
    // depth via two more explorer calls (fetchTransactionConfirmationStatus,
    // fetchChainTipHeight); required defaults to 1 (MULTISIG_NETWORK
    // unset -> testnet), so a single confirmation is exactly sufficient.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ confirmed: true, block_height: 100 }) })
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '100' })
    const result = await multisigProvider.lockFunds({ tradeId: 't1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey, lockedAmount: '0.0005' })
    expect(result.txId).toBe('a'.repeat(64))
    expect(result.vout).toBe(3)
  })
})

describe('MultisigProvider — outpoint-exact spend selection (buildUnsignedRelease)', () => {
  const baseEscrow = { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey: ARBITER_PUBKEY_HEX, lockedAmount: '0.001', status: 'PAYMENT_PENDING' as const }

  it('1. txid correto + vout correto → PASS (spends the exact persisted outpoint)', async () => {
    const { multisigProvider } = loadProvider()
    const txid = '1'.repeat(64)
    mockExplorerThenFee([{ txid, vout: 2, value: 100_000 }])
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: txid, txLockVout: 2 }, REFUND_ADDRESS_UNUSED)
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    expect(psbt.txInputs[0].index).toBe(2)
  })

  it('2. txid correto + vout errado → REJECT (does not silently spend a different output of the same tx)', async () => {
    const { multisigProvider } = loadProvider()
    const txid = '2'.repeat(64)
    mockExplorerThenFee([{ txid, vout: 0, value: 100_000 }]) // only vout 0 exists at the explorer
    await expect(
      multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: txid, txLockVout: 5 }, REFUND_ADDRESS_UNUSED)
    ).rejects.toThrow(`${txid}:5`)
  })

  it('3. txid errado + vout correto → REJECT', async () => {
    const { multisigProvider } = loadProvider()
    const realTxid = '3'.repeat(64)
    mockExplorerThenFee([{ txid: realTxid, vout: 0, value: 100_000 }])
    await expect(
      multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: 'f'.repeat(64), txLockVout: 0 }, REFUND_ADDRESS_UNUSED)
    ).rejects.toThrow('not found by the explorer')
  })

  it('6. UTXO já gasto (absent from the explorer\'s unspent list) → REJECT', async () => {
    const { multisigProvider } = loadProvider()
    const txid = '6'.repeat(64)
    mockExplorerThenFee([]) // nothing unspent at the address — already spent
    await expect(
      multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: txid, txLockVout: 0 }, REFUND_ADDRESS_UNUSED)
    ).rejects.toThrow('not found by the explorer')
  })

  it('8. múltiplos UTXOs no mesmo endereço → seleciona SOMENTE o outpoint explicitamente persistido', async () => {
    const { multisigProvider } = loadProvider()
    const txid = '8'.repeat(64)
    // Same address funded three times (three distinct outputs across the
    // explorer's response) — this is exactly the ambiguity txid-only
    // matching could not resolve.
    mockExplorerThenFee([
      { txid, vout: 0, value: 50_000 },
      { txid, vout: 1, value: 100_000 },
      { txid, vout: 2, value: 150_000 },
    ])
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: txid, txLockVout: 1 }, REFUND_ADDRESS_UNUSED)
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    expect(psbt.txInputs[0].index).toBe(1)
    expect(psbt.data.inputs[0].witnessUtxo!.value).toBe(100_000n)
  })

  it('9. dois escrows com valores iguais no mesmo txid → sem cross-attribution (cada um gasta seu próprio vout)', async () => {
    const { multisigProvider } = loadProvider()
    const sharedTxid = '9'.repeat(64)
    const sharedUtxos = [
      { txid: sharedTxid, vout: 0, value: 100_000 },
      { txid: sharedTxid, vout: 1, value: 100_000 }, // identical value — value alone cannot disambiguate these
    ]

    mockExplorerThenFee(sharedUtxos)
    const escrowA = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, tradeId: 'tA', txLockId: sharedTxid, txLockVout: 0 }, REFUND_ADDRESS_UNUSED)
    mockExplorerThenFee(sharedUtxos)
    const escrowB = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, tradeId: 'tB', txLockId: sharedTxid, txLockVout: 1 }, REFUND_ADDRESS_UNUSED)

    const psbtA = bitcoin.Psbt.fromBase64(escrowA.psbtBase64, { network })
    const psbtB = bitcoin.Psbt.fromBase64(escrowB.psbtBase64, { network })
    expect(psbtA.txInputs[0].index).toBe(0)
    expect(psbtB.txInputs[0].index).toBe(1)
  })

  it('11. escrow histórico sem vout (txLockVout ausente) → continua legível via o fallback original', async () => {
    const { multisigProvider } = loadProvider()
    const txid = 'b'.repeat(64)
    mockExplorerThenFee([{ txid, vout: 0, value: 100_000 }])
    // No txLockVout at all — exactly the shape of every pre-Missão-10 row,
    // including the real Missão 09 mainnet escrow.
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: txid }, REFUND_ADDRESS_UNUSED)
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    expect(psbt.txInputs[0].index).toBe(0)
  })

  it('11b. escrow histórico com txLockVout explicitamente null → mesmo fallback', async () => {
    const { multisigProvider } = loadProvider()
    const txid = 'c'.repeat(64)
    mockExplorerThenFee([{ txid, vout: 0, value: 100_000 }])
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, txLockId: txid, txLockVout: null }, REFUND_ADDRESS_UNUSED)
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
    expect(psbt.txInputs[0].index).toBe(0)
  })
})

describe('Missão 10 items 12-14 — release/refund/split all use the exact persisted outpoint', () => {
  const baseEscrow = { tradeId: 't1', buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY, arbiterPubkey: ARBITER_PUBKEY_HEX, lockedAmount: '0.001' }
  const utxos = [
    { txid: 'd'.repeat(64), vout: 0, value: 100_000 },
    { txid: 'd'.repeat(64), vout: 1, value: 200_000 }, // decoy — must never be picked
  ]

  it('12. release spends txLockVout exactly', async () => {
    const { multisigProvider } = loadProvider()
    mockExplorerThenFee(utxos)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRelease({ ...baseEscrow, status: 'PAYMENT_PENDING', txLockId: 'd'.repeat(64), txLockVout: 1 }, REFUND_ADDRESS_UNUSED)
    expect(bitcoin.Psbt.fromBase64(psbtBase64, { network }).txInputs[0].index).toBe(1)
  })

  it('13. refund spends txLockVout exactly', async () => {
    const { multisigProvider } = loadProvider()
    mockExplorerThenFee(utxos)
    const { psbtBase64 } = await multisigProvider.buildUnsignedRefund({ ...baseEscrow, status: 'FUNDS_LOCKED', txLockId: 'd'.repeat(64), txLockVout: 1 }, REFUND_ADDRESS_UNUSED)
    expect(bitcoin.Psbt.fromBase64(psbtBase64, { network }).txInputs[0].index).toBe(1)
  })

  it('14. split spends txLockVout exactly', async () => {
    const { multisigProvider } = loadProvider()
    mockExplorerThenFee(utxos, 10)
    const { psbtBase64 } = await multisigProvider.buildUnsignedSplit(
      { ...baseEscrow, status: 'DISPUTED', txLockId: 'd'.repeat(64), txLockVout: 1 },
      REFUND_ADDRESS_UNUSED, REFUND_ADDRESS_UNUSED, 5000
    )
    expect(bitcoin.Psbt.fromBase64(psbtBase64, { network }).txInputs[0].index).toBe(1)
  })
})
