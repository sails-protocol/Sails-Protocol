// tests/multisigSigningIntentUi.test.ts
//
// Missão 11 Fase 9.1.1 §3 — CTO decision: sails-ui must not blind-sign a
// settlement-critical MULTISIG PSBT. Proves, with real cryptography (no
// mocks for the PSBT/signature logic — same discipline
// packages/sails-sdk/tests/wallet-verification.test.ts already
// established), that:
//   1. buildMultisigSigningIntent() (packages/sails-ui/src/lib/multisigSigningIntent.ts)
//      correctly assembles an ExpectedSigningIntent from ONLY public SDK
//      data (Escrow + EscrowPendingTransaction shapes), for both release
//      and refund, and REFUSES (never guesses) for split or missing data.
//   2. Routing a real PSBT through this builder + verifyAndSignEscrowPsbt()
//      accepts a correct PSBT and rejects a tampered one (wrong
//      recipient, wrong amount, unexpected extra output, wrong script) —
//      the exact adversarial matrix wallet-verification.test.ts already
//      proves for the underlying primitive, now proven again through
//      sails-ui's own real assembly code, not a hand-built fixture.
//   3. useEscrowKey.ts (the hook this module was built to fix) no longer
//      references the raw, unverified signEscrowPsbt() at all for
//      MULTISIG — a structural proof it cannot silently fall back to it.
//
// Root jest's own moduleNameMapper resolves @satsails/p2p-trading-sdk to
// its real TypeScript source (jest.config.js) — no sails-ui build step,
// no SDK dist rebuild, needed for this test to run.

import * as fs from 'fs'
import * as path from 'path'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { verifyAndSignEscrowPsbt, SigningIntentVerificationError, type Escrow, type EscrowPendingTransaction } from '../packages/sails-sdk/src/index'
import { buildMultisigSigningIntent, MultisigSigningIntentError } from '../packages/sails-ui/src/lib/multisigSigningIntent'

bitcoin.initEccLib(ecc)
const network = bitcoin.networks.testnet

function keypair() {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = Buffer.from(secp256k1.getPublicKey(privateKey, true))
  return { privateKey, publicKey }
}

const buyer = keypair()
const seller = keypair()
const arbiter = keypair()
const pubkeys = [buyer.publicKey, seller.publicKey, arbiter.publicKey].sort(Buffer.compare)
const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys, network })
const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network })
const multisigAddress = p2wsh.address!

const REAL_TXID = 'b'.repeat(64)
const REAL_VOUT = 0
const INPUT_VALUE = 100_000n
const RELEASE_ADDR = bitcoin.payments.p2wpkh({ pubkey: buyer.publicKey, network }).address!
const OTHER_ADDR = bitcoin.payments.p2wpkh({ pubkey: seller.publicKey, network }).address!
const MINER_FEE = 200n
const OUTPUT_VALUE = INPUT_VALUE - MINER_FEE

function baseEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING',
    lockedAmount: '0.001', asset: 'BTC', network: 'testnet',
    multisigAddr: multisigAddress, txLockId: REAL_TXID, txLockVout: REAL_VOUT,
    fundedAmount: '0.001', txReleaseId: null, timelockHours: 24,
    lockedAt: null, expiresAt: null, releasedAt: null, createdAt: '', updatedAt: '',
    feePolicyVersionId: null, snapshotProtocolFeeRate: null, snapshotPayerModel: null,
    snapshotEconomicBasis: null, snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: null,
    participantKeys: [
      { participantId: 'buyer-1', role: 'buyer', publicKeyHex: buyer.publicKey.toString('hex') },
      { participantId: 'seller-1', role: 'seller', publicKeyHex: seller.publicKey.toString('hex') },
      { participantId: 'arbiter-1', role: 'arbiter', publicKeyHex: arbiter.publicKey.toString('hex') },
    ],
    ...overrides,
  } as Escrow
}

function basePending(overrides: Partial<EscrowPendingTransaction> = {}): EscrowPendingTransaction {
  return {
    id: 'ptx-1', escrowId: 'escrow-1', kind: 'release', toAddress: RELEASE_ADDR,
    unsignedPsbtBase64: '', requiredSigners: ['buyer-1', 'seller-1'], triggeredBy: 'seller-1',
    createdAt: '', minerFeeSats: Number(MINER_FEE),
    ...overrides,
  } as EscrowPendingTransaction
}

function buildRealPsbt(outputs: Array<{ address: string; value: bigint }>): string {
  const psbt = new bitcoin.Psbt({ network })
  psbt.addInput({
    hash: REAL_TXID, index: REAL_VOUT,
    witnessUtxo: { script: p2wsh.output!, value: INPUT_VALUE },
    witnessScript: p2ms.output!,
  })
  for (const o of outputs) psbt.addOutput({ address: o.address, value: o.value })
  return psbt.toBase64()
}

describe('buildMultisigSigningIntent() — assembly from public SDK data only', () => {
  it('assembles a correct RELEASE intent (no fee policy)', () => {
    const intent = buildMultisigSigningIntent(baseEscrow(), basePending())
    expect(intent.operation).toBe('RELEASE')
    expect(intent.network).toBe('testnet')
    expect(intent.input).toEqual({ txid: REAL_TXID, vout: REAL_VOUT, value: INPUT_VALUE, multisigAddress })
    expect(intent.outputs).toEqual([{ address: RELEASE_ADDR, value: OUTPUT_VALUE }])
    expect(intent.minerFee).toBe(MINER_FEE)
    expect(intent.threshold).toBe(2)
    expect(intent.requiredSigners).toEqual(['buyer-1', 'seller-1'])
  })

  it('assembles a correct REFUND intent — full spendable value to the seller, no fee leg', () => {
    const intent = buildMultisigSigningIntent(baseEscrow(), basePending({ kind: 'refund', toAddress: OTHER_ADDR }))
    expect(intent.operation).toBe('REFUND')
    expect(intent.outputs).toEqual([{ address: OTHER_ADDR, value: OUTPUT_VALUE }])
  })

  it('assembles a correct fee-aware RELEASE intent when the escrow is policy-aware and collectible', () => {
    const feeAddr = bitcoin.payments.p2wpkh({ pubkey: arbiter.publicKey, network }).address!
    const escrow = baseEscrow({
      feePolicyVersionId: 'policy-1', snapshotProtocolFeeRate: '0.004', snapshotFeeCollectionAddress: feeAddr,
      snapshotFeeCollectionWaivedPreFunding: false,
    })
    const intent = buildMultisigSigningIntent(escrow, basePending())
    // fee = floor(100000 * 0.004) = 400 sats; buyer gets input - minerFee - fee's own accounting
    // (buildExpectedFeeAwareReleaseOutputs computes buyerPool = input - minerFee, fee = 400)
    expect(intent.outputs).toEqual([
      { address: RELEASE_ADDR, value: INPUT_VALUE - MINER_FEE },
      { address: feeAddr, value: 400n },
    ])
  })

  it('REFUSES a SPLIT pending transaction — never guesses its construction', () => {
    expect(() => buildMultisigSigningIntent(baseEscrow(), basePending({ kind: 'split' }))).toThrow(MultisigSigningIntentError)
    expect(() => buildMultisigSigningIntent(baseEscrow(), basePending({ kind: 'split' }))).toThrow(/SPLIT/)
  })

  it('REFUSES when fundedAmount is missing — never falls back to lockedAmount silently', () => {
    expect(() => buildMultisigSigningIntent(baseEscrow({ fundedAmount: null }), basePending())).toThrow(MultisigSigningIntentError)
  })

  it('REFUSES when minerFeeSats is missing — never re-estimates a live fee rate as a substitute', () => {
    expect(() => buildMultisigSigningIntent(baseEscrow(), basePending({ minerFeeSats: null }))).toThrow(/minerFeeSats/)
  })

  it('REFUSES when the escrow has no multisigAddr yet', () => {
    expect(() => buildMultisigSigningIntent(baseEscrow({ multisigAddr: null }), basePending())).toThrow(MultisigSigningIntentError)
  })

  it('REFUSES when participantKeys has fewer than 2 entries', () => {
    expect(() => buildMultisigSigningIntent(baseEscrow({ participantKeys: [] }), basePending())).toThrow(MultisigSigningIntentError)
  })
})

describe('sails-ui end-to-end: real PSBT verification through buildMultisigSigningIntent() + verifyAndSignEscrowPsbt()', () => {
  it('a correctly-built PSBT verifies and signs successfully', () => {
    const escrow = baseEscrow()
    const pending = basePending()
    const psbtBase64 = buildRealPsbt([{ address: RELEASE_ADDR, value: OUTPUT_VALUE }])
    const intent = buildMultisigSigningIntent(escrow, pending)

    const signed = verifyAndSignEscrowPsbt(psbtBase64, intent, pending.requiredSigners, buyer.privateKey)
    expect(typeof signed).toBe('string')
    expect(signed.length).toBeGreaterThan(0)
  })

  it('a PSBT paying the WRONG recipient is rejected before signing', () => {
    const escrow = baseEscrow()
    const pending = basePending()
    const psbtBase64 = buildRealPsbt([{ address: OTHER_ADDR, value: OUTPUT_VALUE }]) // wrong destination
    const intent = buildMultisigSigningIntent(escrow, pending)

    expect(() => verifyAndSignEscrowPsbt(psbtBase64, intent, pending.requiredSigners, buyer.privateKey))
      .toThrow(SigningIntentVerificationError)
  })

  it('a PSBT paying the WRONG amount is rejected before signing', () => {
    const escrow = baseEscrow()
    const pending = basePending()
    const psbtBase64 = buildRealPsbt([{ address: RELEASE_ADDR, value: OUTPUT_VALUE - 5000n }]) // skimmed
    const intent = buildMultisigSigningIntent(escrow, pending)

    expect(() => verifyAndSignEscrowPsbt(psbtBase64, intent, pending.requiredSigners, buyer.privateKey))
      .toThrow(SigningIntentVerificationError)
  })

  it('a PSBT with an UNEXPECTED extra output is rejected before signing', () => {
    const escrow = baseEscrow()
    const pending = basePending()
    const impostor = keypair()
    const impostorAddr = bitcoin.payments.p2wpkh({ pubkey: impostor.publicKey, network }).address!
    const psbtBase64 = buildRealPsbt([
      { address: RELEASE_ADDR, value: OUTPUT_VALUE - 1000n },
      { address: impostorAddr, value: 1000n }, // value-extraction attempt
    ])
    const intent = buildMultisigSigningIntent(escrow, pending)

    expect(() => verifyAndSignEscrowPsbt(psbtBase64, intent, pending.requiredSigners, buyer.privateKey))
      .toThrow(SigningIntentVerificationError)
  })

  it('a PSBT built against the WRONG script (different participant set) is rejected before signing', () => {
    const escrow = baseEscrow()
    const pending = basePending()
    const impostorArbiter = keypair()
    const wrongPubkeys = [buyer.publicKey, seller.publicKey, impostorArbiter.publicKey].sort(Buffer.compare)
    const wrongP2ms = bitcoin.payments.p2ms({ m: 2, pubkeys: wrongPubkeys, network })
    const wrongP2wsh = bitcoin.payments.p2wsh({ redeem: wrongP2ms, network })
    const psbt = new bitcoin.Psbt({ network })
    psbt.addInput({
      hash: REAL_TXID, index: REAL_VOUT,
      witnessUtxo: { script: wrongP2wsh.output!, value: INPUT_VALUE }, // different script than the escrow's known multisigAddr
      witnessScript: wrongP2ms.output!,
    })
    psbt.addOutput({ address: RELEASE_ADDR, value: OUTPUT_VALUE })
    const intent = buildMultisigSigningIntent(escrow, pending)

    expect(() => verifyAndSignEscrowPsbt(psbt.toBase64(), intent, pending.requiredSigners, buyer.privateKey))
      .toThrow(SigningIntentVerificationError)
  })
})

describe('useEscrowKey.ts cannot silently fall back to raw signing (structural proof)', () => {
  it('no longer imports or calls the raw, unverified signEscrowPsbt() for MULTISIG', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'packages', 'sails-ui', 'src', 'hooks', 'useEscrowKey.ts'),
      'utf8'
    )
    // Strips comments first — this file's own prose legitimately still
    // MENTIONS signEscrowPsbt by name (e.g. contrasting it with
    // signEscrowSafeUserOp's routine), which is fine; what must be
    // structurally absent from the real CODE is an import of it or a
    // call to it.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const importLine = codeOnly.match(/^import\s*\{[^}]*\}\s*from\s*['"]@satsails\/p2p-trading-sdk['"]/m)?.[0] ?? ''
    expect(importLine).not.toMatch(/(?<![A-Za-z0-9_])signEscrowPsbt(?![A-Za-z0-9_(])/)
    expect(codeOnly).not.toMatch(/\bsignEscrowPsbt\(/)
    expect(importLine).toMatch(/\bverifyAndSignEscrowPsbt\b/)
    expect(codeOnly).toMatch(/\bverifyAndSignEscrowPsbt\(/)
  })
})
