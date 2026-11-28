/**
 * @satsails/p2p-trading-sdk — client-held escrow key generation
 *
 * The buyer/seller half of the client-held-keys upgrade to MULTISIG/
 * LIGHTNING_HODL escrow (`src/modules/open-settlement/multisig.provider.ts`,
 * `lightning-hodl.provider.ts`) — a real secp256k1 keypair generated here,
 * in the caller's own environment, never sent to the server. Only the
 * 33-byte compressed public key (`publicKeyHex` below) is ever submitted,
 * via `SailsSettlementModule.submitKey()`.
 *
 * Same architecture as `identity.ts`'s Ed25519 keypair (generate
 * client-side, hold client-side, submit the public half only) — this is
 * a DIFFERENT curve (secp256k1, not Ed25519) because Bitcoin/Ark scripts
 * need it, so it's a separate module rather than reusing identity.ts's
 * keypair for both purposes.
 *
 * `@noble/curves` — pure JS, browser-safe, no WASM (unlike
 * `tiny-secp256k1`, the backend's own choice for the same curve, which
 * would complicate this package's browser bundle target). `package.json`
 * declares `^2.0.1`: `@arkade-os/sdk`'s own transitive tree
 * (`@bitcoinerlab/descriptors-core`, pulled in via
 * `@bitcoinerlab/descriptors-scure`) requires `@noble/curves` 2.x, and npm
 * cannot place two different major versions in the same
 * `packages/sails-sdk/node_modules` slot — confirmed via `npm ls
 * @noble/curves -w @satsails/p2p-trading-sdk --all` after both a clean reinstall and
 * `npm dedupe` still resolved 2.2.0 there. `secp256k1`'s real v2.x API
 * (`Signature.fromBytes`/`toBytes` with an explicit `format` argument,
 * `utils.randomSecretKey` replacing v1.x's `randomPrivateKey`, `sign`/
 * `verify` defaulting to `prehash: true`) was re-verified directly against
 * the actually-resolved package before this file's `randomPrivateKey()`
 * call was updated to `randomSecretKey()` — not assumed compatible with
 * the v1.x API this file originally targeted. Verified experimentally
 * before this file was written that a `@noble/curves`
 * private key produces a compressed pubkey directly compatible with
 * bitcoinjs-lib's multisig construction (`multisig.provider.ts` uses it
 * server-side) and, with the leading byte stripped, the x-only form
 * `@arkade-os/sdk`'s `MultisigTapscript` wants
 * (`lightning-hodl.provider.ts`) — one client key genuinely serves both
 * providers, not two separate ones.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import { bytesToHex } from '../encoding'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

export interface EscrowKeypair {
  /** Raw 32-byte secp256k1 private key — never sent anywhere. Keep this in the caller's own secure storage. */
  privateKey: Uint8Array
  /** 33-byte compressed public key — the only part ever submitted to the server (`submitKey()`). */
  publicKey: Uint8Array
  /** `publicKey`, hex-encoded — what `SailsSettlementModule.submitKey()` actually sends. */
  publicKeyHex: string
}

export function generateEscrowKeypair(): EscrowKeypair {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = secp256k1.getPublicKey(privateKey, true) // compressed, 33 bytes
  return { privateKey, publicKey, publicKeyHex: bytesToHex(publicKey) }
}

/**
 * Phase 2 (2026-07-27) — signs a MULTISIG escrow's unsigned release/refund
 * PSBT with a client-held `EscrowKeypair.privateKey`
 * (`generateEscrowKeypair()` above), for submission via
 * `SailsSettlementModule.submitTransactionSignature()`. The PSBT itself
 * comes from `initiateRelease()`/`initiateRefund()` (server-built,
 * base64-encoded, already carrying the correct `witnessUtxo`/
 * `witnessScript` for input 0 — this function only ever signs that one
 * input, matching every unsigned PSBT this flow produces).
 *
 * ⚠️ RAW PRIMITIVE — signs BLIND, with zero verification that the PSBT
 * actually pays what the caller expects (Missão 11 Fase 9.1 §11's own
 * audit). `wallet-verification.ts`'s own header comment states the rule
 * this function does NOT enforce on its own: "a wallet must never sign a
 * PSBT it hasn't independently checked against what it actually expects
 * to be signing." Prefer `verifyAndSignEscrowPsbt()` (`wallet-verification.ts`)
 * — the recommended entry point, where signing is STRUCTURALLY
 * unreachable until independent verification against your own expected
 * outputs/fee/threshold/participants passes. Call this function directly
 * only if you are implementing your own equivalent verification before
 * calling it — never as a shortcut to skip that step. (Missão 11 Fase
 * 9.1 §11 found this repo's own reference UI, `packages/sails-ui`'s
 * `useEscrowKey.ts`, calling this function directly without that
 * verification — closed by Fase 9.1.1 §3: it now routes through
 * `verifyAndSignEscrowPsbt()` instead, via `packages/sails-ui/src/lib/multisigSigningIntent.ts`.
 * See `BACKLOG.md`'s own entry for the full detail.)
 *
 * It does not check the protocol fee either: for a fee-aware MULTISIG escrow, call `verifyFeeAwarePsbt()`
 * (`fee-outputs.ts`) before signing, and sign only when it returns { ok: true }.
 *
 * `@bitcoinerlab/secp256k1` — pure JS, no WASM, built specifically to
 * integrate into the BitcoinJS ecosystem without WASM (same tradeoff
 * `escrow-key.ts`'s own header comment already made for `@noble/curves`
 * over `tiny-secp256k1`, applied here to bitcoinjs-lib's own ECC
 * interface). Verified experimentally before this was written: a PSBT
 * input signed with an `@bitcoinerlab/secp256k1`-backed `ECPair` combines
 * and finalizes correctly against the backend's own
 * `tiny-secp256k1`-backed verification — the two libraries interoperate
 * on the same PSBT bytes, which is the actual requirement here (this
 * function's signature and the arbiter/counterparty's signature end up in
 * the same finalized transaction).
 */
export function signEscrowPsbt(psbtBase64: string, privateKey: Uint8Array): string {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64)
  const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey))
  // Missão 11 Fase 9.6 — Kimi K3 R2's PROV-01 finding (independently
  // triaged as DESIGN DEBT, not a live exploit — this repository's own
  // provider registry is a closed, operator-curated set with no runtime
  // injection surface): this call previously relied on bitcoinjs-lib's
  // own undocumented default (SIGHASH_ALL) rather than asserting it, so
  // there was no test proving this signer would ever REFUSE to sign an
  // input requesting a different sighash type. Explicit now — this
  // function only ever produces a SIGHASH_ALL signature, and
  // psbt.signInput() itself throws if the PSBT's own sighash type isn't
  // in this list, rather than silently signing whatever was asked.
  psbt.signInput(0, keyPair, [bitcoin.Transaction.SIGHASH_ALL])
  return psbt.toBase64()
}
