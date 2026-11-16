/**
 * Sails Protocol — Ensaio: MULTISIG real (Bitcoin testnet/regtest/mainnet)
 *
 * A full non-custodial MULTISIG escrow lifecycle (createEscrow → client
 * keys → real funding → lockFunds → cooperative release), run against
 * whichever real Bitcoin network `MULTISIG_NETWORK`/`MULTISIG_EXPLORER_API_URL`
 * point at (testnet3, regtest, or mainnet) via multisig.provider.ts and a
 * real public explorer — not a simulation of the provider, the actual
 * provider. Originally written testnet-only; extended in Missão 09
 * (2026-08-17/18) into a genuine mainnet rehearsal, and used to produce a
 * real, independently-verified Bitcoin mainnet MULTISIG release (see
 * `docs/MAINNET_MULTISIG_PROOF.md`) — the amendments below are not
 * speculative, they were exercised against real BTC. On mainnet, funds
 * sent to the derived address are real money with no faucet refund; on
 * testnet3/regtest, zero financial risk.
 *
 * Requires MOCK_ESCROW=false (createEscrow()'s own `recommendedEscrowType`
 * fallback and submitParticipantKey()'s deposit-address derivation both
 * gate on this — see escrow.service.ts) plus a real MULTISIG_SEED and one
 * TRUSTED_ARBITRATORS entry (multisig.provider.ts's getMaster()/
 * defaultArbiterId() throw a clear error naming exactly what's missing
 * otherwise — this script does not work around that, it relies on it).
 * None of these three values need to be secret for a rehearsal — still
 * generate a real MULTISIG_SEED rather than reusing a well-known string,
 * since it derives the on-chain arbiter key baked into the script this
 * run actually broadcasts against.
 *
 * The buyer/seller secp256k1 keypairs are generated with the exact same
 * @satsails/p2p-trading-sdk helper (`generateEscrowKeypair()`) a real client integration
 * uses — this script plays both roles locally only because it's rehearsing
 * the full cooperative lifecycle in one process, not because the server
 * ever sees a private key. Both signatures in the final broadcast are
 * produced by `signEscrowPsbt()`, the same client-side SDK call a real
 * wallet integration would make.
 *
 * Funding step: this script derives the real deposit address and then
 * polls the same explorer API lockFunds() itself uses
 * (`{explorerApiUrl}/address/{addr}/utxo`) until a matching UTXO appears —
 * it does not move funds itself (non-custodial by construction, same as
 * the provider it drives). On testnet3/regtest, send test coins from any
 * public faucet. On mainnet (as this script now really supports), the
 * operator sends real BTC manually — this script never requests or
 * automates a mainnet funding action itself.
 *
 * Amended 2026-08-17 (Missão 09, mainnet-readiness pass) — the network
 * was never actually hardcoded to testnet at the bitcoinjs-lib level
 * (multisig.provider.ts's networkFor() already handled 'bitcoin'/
 * 'mainnet'/'regtest'/testnet correctly); this script's own DISPLAY
 * strings were the only hardcoded part (offer/escrow `network` field,
 * console.log labels, the hardcoded mempool.space/testnet confirmation
 * URL) — now derived from config.multisig.network so the same script
 * genuinely supports testnet3, regtest, or mainnet without a silent
 * mislabel next to a real address/txid. `DEMO_LOCKED_AMOUNT_BTC` is now
 * required explicitly (no default) — a real-money mainnet run must
 * never silently fall back to a value someone chose for worthless
 * testnet coins.
 */
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { BIP32Factory } from 'bip32'
import { createHash } from 'crypto'
import { config } from '../../src/config'
import { connectDatabase } from '../../src/common/database'
import { connectRedis } from '../../src/common/redis'
import nacl from 'tweetnacl'
import { identityService } from '../../src/modules/open-identity/identity.service'
import { issueRegistrationChallenge, registrationProofMessage } from '../../src/common/middleware/auth'
import { liquidityRouter } from '../../src/modules/open-liquidity/liquidity.service'
import { tradeService } from '../../src/modules/open-p2p/trade.service'
import { escrowService } from '../../src/modules/open-settlement/escrow.service'
import { keyIndexFor, multisigProvider } from '../../src/modules/open-settlement/multisig.provider'
import { intentEngine } from '../../src/core/intent-engine'
import { OpenP2PTradeIntentHandler } from '../../src/modules/open-p2p/intent-handler'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
// Lazy require() (CODE_STYLE.md §8) — @satsails/p2p-trading-sdk is a heavy ESM-adjacent
// package; no other demo script imports it, so it stays out of every path
// that doesn't need it.
// Missão 11 Fase 5 §12 — the canonical SDK verification module, not an ad-
// hoc re-implementation. Lazy require() (CODE_STYLE.md §8), same reasoning
// as this file's other heavy/ESM-adjacent imports.
function loadWalletVerificationModule(): typeof import('../../packages/sails-sdk/src/modules/wallet-verification') {
  return require('../../packages/sails-sdk/src/modules/wallet-verification')
}

const bip32 = BIP32Factory(ecc)

/**
 * Missão 09 (2026-08-17) — real gap found running this rehearsal on
 * mainnet: `generateEscrowKeypair()` (the real SDK export, correct for
 * its own purpose) uses pure OS randomness with zero backup — fine for
 * the SDK itself (a real wallet integration is expected to already have
 * its own key-management/backup layer wrapping it), but this rehearsal
 * script has none, so a killed/crashed process loses buyer/seller keys
 * permanently. For a real-money mainnet rehearsal that is an
 * unacceptable loss-of-funds risk (CTO STOP GATE, 2026-08-17).
 *
 * Fix, scoped to this demo script only (no SDK/protocol/server change):
 * derive buyer/seller keys deterministically from a seed the operator
 * already holds client-side (`DEMO_BUYER_SEED`/`DEMO_SELLER_SEED`),
 * via the exact same bip32-derivation pattern multisig.provider.ts
 * already uses server-side for the arbiter key
 * (`bip32.fromSeed(sha256(seed)).derivePath(...)`) — applied
 * symmetrically to the client side instead. The seed is never printed,
 * logged, sent to the server, or written to any file by this function —
 * same non-custodial guarantee generateEscrowKeypair() already had, plus
 * recoverability. A real wallet integration would derive this from its
 * own already-backed-up HD seed (e.g. a BIP39 mnemonic) the same way —
 * this is not a new custody concept, just the client half of a pattern
 * the server side already established.
 *
 * Amended 2026-08-17 (same day, CTO STOP GATE #2) — the first version of
 * this function derived from a FIXED path (`m/0'/0/0`), so it depended
 * only on the seed, not on which escrow it was for. Two escrows built
 * with the same buyer/seller seeds (e.g. this rehearsal, restarted
 * against the same two dedicated seeds) produced byte-identical
 * buyer/seller pubkeys, and therefore the exact same 2-of-3 address —
 * confirmed directly (escrow `418d10d8...` and escrow `67738ec6...`
 * both derived `bc1q7jvjavwg...`). That mirrors a real risk: address
 * reuse across unrelated escrows, with no attribution mechanism telling
 * `lockFunds()` which escrow a given UTXO was meant for (verified by
 * reading `multisig.provider.ts`'s `lockFunds()`/`verifyLock()` — they
 * match by amount only, and neither `Escrow.multisigAddr` nor
 * `Escrow.txLockId` has a uniqueness constraint in schema.prisma).
 *
 * Root cause: in the real, unmodified production path,
 * `generateEscrowKeypair()`'s pure randomness is what actually
 * guarantees per-escrow uniqueness — the arbiter key alone is legitimately
 * shared across every escrow that arbiter is assigned to
 * (`keyIndexFor('arbiter', arbiterId)` depends only on the arbiter's own
 * id, by design, same as an arbitrator having one persistent identity in
 * HodlHodl's real model). Replacing buyer/seller's fresh randomness with
 * a fixed-path deterministic derivation removed the one thing carrying
 * that uniqueness guarantee, without substituting anything in its place.
 *
 * Fix: bind the derivation path to `escrowId` via `keyIndexFor()` — the
 * exact same exported primitive `multisig.provider.ts` already uses for
 * the arbiter (no new primitive invented, no protocol/schema change).
 * `escrowId` is already known client-side by the time keys are derived
 * (step 3 creates the escrow before step 4 derives keys — this ordering
 * was already true before this fix). This gives both properties at once:
 * same seed + same escrowId → same keys after restart (recoverable);
 * same seed + different escrowId → different keys/address (unique).
 */
function deriveClientKeypair(seedHex: string, role: 'buyer' | 'seller', escrowId: string): { privateKey: Uint8Array; publicKey: Uint8Array; publicKeyHex: string } {
  const seedBuffer = createHash('sha256').update(seedHex).digest()
  const master = bip32.fromSeed(seedBuffer, bitcoin.networks.bitcoin)
  const index = keyIndexFor(role, escrowId)
  const node = master.derivePath(`m/0'/0/${index}`)
  if (!node.privateKey) throw new Error('BIP32 derivation did not yield a private key')
  const privateKey = Buffer.from(node.privateKey)
  const publicKey = Buffer.from(node.publicKey)
  return { privateKey, publicKey, publicKeyHex: publicKey.toString('hex') }
}

function fingerprint(pub: Uint8Array): string {
  return createHash('sha256').update(pub).digest('hex').slice(0, 16)
}

const FUNDING_POLL_INTERVAL_MS = 15_000
// Missão 09 (2026-08-17) — configurable via DEMO_FUNDING_POLL_TIMEOUT_MINUTES.
// A real mainnet rehearsal needs this process to stay alive from key
// generation through to signing (buyer/seller keys are client-held,
// in-memory only, by design — killing this process between funding-wait
// and signing permanently loses them, there is no persistence to recover
// from). 30 min is too tight for human-coordinated manual funding; default
// raised to 2h for this rehearsal, still overridable either way.
const FUNDING_POLL_TIMEOUT_MS = (Number(process.env.DEMO_FUNDING_POLL_TIMEOUT_MINUTES) || 120) * 60 * 1000

function step(n: number, total: number, label: string) {
  console.log(`\n[${n}/${total}] ${label}`)
}

// Issue #302 — registration now requires real proof of possession
// (common/middleware/auth.ts's verifyRegistrationProof()); this demo
// previously registered these two identities with arbitrary,
// non-Ed25519 placeholder strings ("demo-multisig-seller-<ts>") as
// their "public key," which can no longer satisfy that requirement.
// Generates a real, throwaway keypair for each demo participant
// instead — a strict improvement (a real identity, not a fake string)
// with the same net effect the old code had: an isolated,
// disposable User row for this one rehearsal run.
async function registerDemoParticipant(displayName: string) {
  const keypair = nacl.sign.keyPair()
  const publicKey = Buffer.from(keypair.publicKey).toString('hex')
  const { challenge } = await issueRegistrationChallenge(publicKey)
  const signature = Buffer.from(
    nacl.sign.detached(registrationProofMessage(challenge, displayName), keypair.secretKey)
  ).toString('hex')
  return identityService.register({ publicKey, signature, displayName })
}

type FundingUtxo = { txid: string; vout: number; value: number; status: { confirmed: boolean } }

// Missão 09 (2026-08-17/18) — returns the actual matched UTXO (not just
// void) so the CTO-required pre-signature report (txid, vout, value,
// confirmation status) can be built from the same observation that
// triggered the rest of the flow, not a second, possibly-inconsistent query.
async function waitForFunding(address: string, expectedSats: number): Promise<FundingUtxo> {
  const deadline = Date.now() + FUNDING_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    // Real bug found running this rehearsal on mainnet: a single transient
    // network failure (explorer connect timeout, DNS blip, etc.) here used
    // to throw and crash the whole process, silently destroying the
    // buyer/seller private keys held only in this process's memory — the
    // exact key-continuity failure this rehearsal exists to avoid. A
    // long-running poll loop must treat network errors as "try again," not
    // "give up entirely."
    try {
      const res = await fetch(`${config.multisig.explorerApiUrl}/address/${address}/utxo`)
      if (res.ok) {
        const utxos = (await res.json()) as FundingUtxo[]
        const funding = utxos.find((u) => u.value >= expectedSats)
        if (funding) {
          console.log(`   UTXO detectado: ${funding.txid}:${funding.vout} — ${funding.value} sats (confirmado: ${funding.status.confirmed})`)
          return funding
        }
        console.log(`   Ainda sem UTXO em ${address} — aguardando ${FUNDING_POLL_INTERVAL_MS / 1000}s antes de checar de novo...`)
      } else {
        console.log(`   Explorer respondeu ${res.status} — aguardando ${FUNDING_POLL_INTERVAL_MS / 1000}s antes de checar de novo...`)
      }
    } catch (err) {
      console.log(`   Falha de rede consultando o explorer (${err instanceof Error ? err.message : String(err)}) — aguardando ${FUNDING_POLL_INTERVAL_MS / 1000}s antes de tentar de novo...`)
    }
    await new Promise((resolve) => setTimeout(resolve, FUNDING_POLL_INTERVAL_MS))
  }
  throw new Error(`Timeout de ${FUNDING_POLL_TIMEOUT_MS / 60_000}min esperando financiamento em ${address}`)
}

export async function main() {
  console.log('=== Sails Protocol — Ensaio MULTISIG real (Bitcoin testnet) ===')

  if (config.features.mockEscrow) {
    throw new Error('MOCK_ESCROW deve ser "false" para este ensaio — sem isso o endereço de depósito nunca é derivado de verdade (ver submitParticipantKey em escrow.service.ts).')
  }

  await connectDatabase()
  await connectRedis()

  // Missão 09 (2026-08-17) — real, repo-wide gap found running this
  // script for the first time since RFC-018 Phase 3's TradeIntentHandler
  // refactor: app.ts's real boot path calls
  // intentEngine.registerHandler(OpenP2PTradeIntentHandler) (§2.7's
  // plugin pattern) before any route can create a TradeIntent; this
  // script (like its sibling pix-to-usdt-flow.ts) never calls buildApp(),
  // so intentEngine.create('TradeIntent', ...) — invoked transitively by
  // liquidityRouter.createOffer() below — threw "Unsupported intent
  // type: TradeIntent (no handler registered yet)" every time. Same
  // registration app.ts already does for the real server; this script
  // was simply never updated after that refactor landed.
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)

  // Missão 09 (2026-08-17, mainnet-readiness pass) — real gap found
  // running this script with MULTISIG_NETWORK=bitcoin for the first
  // time: every "testnet" string below was hardcoded (createOffer()'s/
  // createEscrow()'s own `network` field, and the deposit-address print
  // label further down) instead of reflecting the network the script is
  // actually configured for — config.multisig.network already drives
  // the real bitcoinjs-lib address derivation correctly, this was only
  // ever a display/metadata mislabel, never a wrong-address bug (verified
  // independently, see Missão 09's report), but a script rehearsing a
  // real-money mainnet flow must not print "(testnet3)" next to a real
  // mainnet address — that is exactly the kind of mislabel an operator
  // could act on incorrectly.
  // Missão 11 Fase 8.1 LB-01 — 'bitcoin' is now normalized to 'mainnet' at config load (normalizeBitcoinNetwork()), so this is just a direct check.
  const networkLabel = config.multisig.network === 'mainnet' ? 'mainnet' : config.multisig.network

  // Missão 09 (2026-08-17) — CTO STOP GATE: buyer/seller keys must survive
  // a process restart without ever touching the server. Deterministic
  // derivation from a client-held seed (see deriveClientKeypair() above)
  // instead of generateEscrowKeypair()'s pure randomness — recovery after
  // a kill/crash is re-running with the same DEMO_BUYER_SEED/
  // DEMO_SELLER_SEED (and, per the amendment above, the same escrowId).
  // No default: a real-money rehearsal must never silently derive from an
  // empty/well-known seed.
  const buyerSeed = process.env.DEMO_BUYER_SEED
  const sellerSeed = process.env.DEMO_SELLER_SEED
  if (!buyerSeed || !sellerSeed) {
    throw new Error('DEMO_BUYER_SEED and DEMO_SELLER_SEED must both be set explicitly (32-byte hex, client-held, never sent to the server) — no default is assumed.')
  }

  const TOTAL = 8

  // Missão 09 (2026-08-17, CTO STOP GATE #2) — DEMO_RESUME_ESCROW_ID lets a
  // restarted process recover the SAME escrow instead of creating a new
  // one for what would otherwise be a second, orphaned deposit address.
  // Skips steps 1-3 entirely (no new identities/offer/trade/escrow) and
  // re-derives the same buyer/seller keys against the escrow's real,
  // already-assigned id.
  const resumeEscrowId = process.env.DEMO_RESUME_ESCROW_ID

  let escrowId: string
  let buyerId: string
  let sellerId: string
  let lockedAmountBtc: string
  let depositAddress: string
  let buyerKeys: { privateKey: Uint8Array; publicKey: Uint8Array; publicKeyHex: string }
  let sellerKeys: { privateKey: Uint8Array; publicKey: Uint8Array; publicKeyHex: string }

  if (resumeEscrowId) {
    step(1, TOTAL, `Retomando escrow existente ${resumeEscrowId} (nenhum escrow novo é criado)...`)
    const existing = await escrowService.getEscrow(resumeEscrowId)
    const trade = await tradeService.getTrade(existing.tradeId)
    if (!existing.multisigAddr) {
      throw new Error(`Escrow ${resumeEscrowId} ainda não tem multisigAddr — não há um depósito existente para retomar (as duas chaves públicas nunca foram submetidas com sucesso nesse escrow).`)
    }
    escrowId = existing.id
    buyerId = trade.buyerId
    sellerId = trade.sellerId
    lockedAmountBtc = existing.lockedAmount.toString()
    depositAddress = existing.multisigAddr
    console.log(`   Escrow: ${escrowId} (retomado — trade ${trade.id})`)

    step(4, TOTAL, 'Recuperando chaves secp256k1 client-held (mesmo seed + mesmo escrowId)...')
    buyerKeys = deriveClientKeypair(buyerSeed, 'buyer', escrowId)
    sellerKeys = deriveClientKeypair(sellerSeed, 'seller', escrowId)
    console.log(`   Buyer pubkey:  ${buyerKeys.publicKeyHex} (fingerprint ${fingerprint(buyerKeys.publicKey)})`)
    console.log(`   Seller pubkey: ${sellerKeys.publicKeyHex} (fingerprint ${fingerprint(sellerKeys.publicKey)})`)

    // Real-code-path verification (not a side reimplementation): ask the
    // actual provider singleton to re-derive the deposit address from
    // these freshly-recovered pubkeys, via the exact same method
    // submitParticipantKey() itself calls, and compare against the
    // escrow's already-stored multisigAddr (submitParticipantKey() only
    // ever computes it once, so this check is not implicitly repeated by
    // resubmitting the keys — it has to be done explicitly here).
    // Missão 11 Fase 5.2 — getDepositAddress() now returns { address,
    // arbiterPubkeyHex, arbiterId }, not a bare string (see its own header
    // comment in multisig.provider.ts).
    const { address: rederived } = await multisigProvider.getDepositAddress(escrowId, buyerKeys.publicKeyHex, sellerKeys.publicKeyHex)
    if (rederived !== depositAddress) {
      throw new Error(`Recovery FAILED: re-derived address (${rederived}) does not match the escrow's stored multisigAddr (${depositAddress}) — do not fund this escrow.`)
    }
    console.log(`   Endereço re-derivado (via multisigProvider.getDepositAddress, código real de produção): ${rederived} — CONFERE com o multisigAddr já armazenado.`)
  } else {
    step(1, TOTAL, 'Registrando identidades (Sails OpenIdentity)...')
    const seller = await registerDemoParticipant('Vendedor BTC (MULTISIG)')
    const buyer = await registerDemoParticipant('Comprador BTC (MULTISIG)')
    console.log(`   Vendedor: ${seller.id}`)
    console.log(`   Comprador: ${buyer.id}`)

    step(2, TOTAL, 'Oferta + Trade (Sails OpenLiquidity / OpenP2P)...')
    // Configurable (Missão 09) — was a hardcoded '0.0001' (fine for
    // worthless testnet coins, not something a real-money mainnet rehearsal
    // should ever default to silently). No default value is assumed for a
    // real network; the caller must set it explicitly.
    const amountBtc = process.env.DEMO_LOCKED_AMOUNT_BTC
    if (!amountBtc) {
      throw new Error('DEMO_LOCKED_AMOUNT_BTC must be set explicitly (a decimal BTC string) — no default is assumed, especially not on a real network.')
    }
    const offer = await liquidityRouter.createOffer({
      userId: seller.id,
      asset: 'BTC',
      side: 'SELL',
      priceUsd: '60000',
      minAmount: amountBtc,
      maxAmount: amountBtc,
      paymentMethod: 'OTHER',
      network: networkLabel,
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: amountBtc })
    console.log(`   Trade: ${trade.id} (${amountBtc} BTC)`)

    step(3, TOTAL, 'Criando escrow MULTISIG (OpenSettlement)...')
    const escrow = await escrowService.createEscrow({
      tradeId: trade.id,
      type: 'MULTISIG',
      lockedAmount: amountBtc,
      asset: 'BTC',
      network: networkLabel,
    }, seller.id)
    console.log(`   Escrow: ${escrow.id}`)

    escrowId = escrow.id
    buyerId = buyer.id
    sellerId = seller.id
    lockedAmountBtc = amountBtc

    step(4, TOTAL, 'Derivando chaves secp256k1 client-held e recuperáveis (deriveClientKeypair)...')
    buyerKeys = deriveClientKeypair(buyerSeed, 'buyer', escrowId)
    sellerKeys = deriveClientKeypair(sellerSeed, 'seller', escrowId)
    console.log(`   Buyer pubkey:  ${buyerKeys.publicKeyHex} (fingerprint ${fingerprint(buyerKeys.publicKey)})`)
    console.log(`   Seller pubkey: ${sellerKeys.publicKeyHex} (fingerprint ${fingerprint(sellerKeys.publicKey)})`)

    step(5, TOTAL, 'Submetendo chaves públicas (deriva o endereço P2WSH real)...')
    // Missão 11 Fase 9.1.1 — fail-closed capability declaration required
    // for a real MULTISIG commit; this rehearsal declares the real
    // profile it actually implements.
    await escrowService.submitParticipantKey(escrowId, buyerId, buyerKeys.publicKeyHex, MULTISIG_CAPABILITY_PROFILE_V1)
    const { escrow: withAddress } = await escrowService.submitParticipantKey(escrowId, sellerId, sellerKeys.publicKeyHex, MULTISIG_CAPABILITY_PROFILE_V1)
    if (!withAddress.multisigAddr) throw new Error('multisigAddr não foi derivado — ver MULTISIG_SEED/TRUSTED_ARBITRATORS')
    depositAddress = withAddress.multisigAddr
  }

  console.log(`\n   >>> ENDEREÇO DE DEPÓSITO (${networkLabel}): ${depositAddress}`)
  console.log(
    networkLabel === 'mainnet'
      ? `   >>> Envie ao menos ${lockedAmountBtc} BTC REAL para este endereço. Fundos reais, sem reembolso automático de faucet — confirme o valor antes de enviar.`
      : `   >>> Envie ao menos ${lockedAmountBtc} tBTC para este endereço via um faucet público de Bitcoin ${networkLabel}.`
  )

  const network = config.multisig.network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet
  const buyerPayoutAddress = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(buyerKeys.publicKey), network }).address!

  // Missão 09 (2026-08-18, CTO STOP GATE #3) — a prior run may already have
  // gotten through initiateRelease() (which only BUILDS+persists the
  // unsigned PSBT, no signature, no fund movement) before this process was
  // restarted. Re-calling initiateRelease() would be a real transition
  // error (escrow status has already moved past CREATED) — reuse the
  // already-persisted pending transaction instead of rebuilding it.
  type PendingRelease = { unsignedPsbtBase64: string; requiredSigners: string[]; toAddress: string }
  let pending: PendingRelease | undefined
  try {
    pending = await escrowService.getPendingTransaction(escrowId)
  } catch {
    pending = undefined
  }

  let fundingUtxo: FundingUtxo | undefined
  if (!pending) {
    const expectedSats = Math.round(parseFloat(lockedAmountBtc) * 1e8)
    step(6, TOTAL, `Aguardando financiamento real em ${depositAddress}...`)
    fundingUtxo = await waitForFunding(depositAddress, expectedSats)

    step(7, TOTAL, 'lockFunds → markPaymentSent → initiateRelease (constrói PSBT não assinado, sem assinar)...')
    await escrowService.lockFunds(escrowId, sellerId)
    await escrowService.markPaymentSent(escrowId, buyerId)
    console.log(`   Endereço de payout do comprador (derivado da própria chave de escrow, só para este ensaio): ${buyerPayoutAddress}`)
    pending = await escrowService.initiateRelease(escrowId, buyerPayoutAddress, sellerId)
  } else {
    step(6, TOTAL, 'Escrow já financiado e PSBT já construído em execução anterior — reaproveitando, sem reconstruir.')
    const existing = await escrowService.getEscrow(escrowId)
    if (existing.txLockId) {
      const utxos = (await (await fetch(`${config.multisig.explorerApiUrl}/address/${depositAddress}/utxo`)).json()) as FundingUtxo[]
      fundingUtxo = utxos.find((u) => u.txid === existing.txLockId)
    }
  }

  // Missão 09 (2026-08-18, CTO STOP GATE #3) — with real BTC now approved
  // for this escrow, a mandatory manual checkpoint BEFORE any signature:
  // decode the actual unsigned PSBT and print every field the CTO asked
  // for, then STOP unless DEMO_AUTHORIZE_SIGN is explicitly set. No prior
  // run of this script ever signed or broadcast automatically after
  // funding — that already only happened right after this same process
  // built the PSBT, with no human checkpoint in between. This closes that.
  if (!pending) throw new Error('unreachable — pending is always assigned in both branches above')

  step(8, TOTAL, 'Relatório pré-assinatura (obrigatório antes de qualquer assinatura real)...')
  const escrowDetails = await escrowService.getEscrow(escrowId)
  const psbt = bitcoin.Psbt.fromBase64(pending.unsignedPsbtBase64)
  const txInput = psbt.txInputs[0]
  const inputTxid = Buffer.from(txInput.hash).reverse().toString('hex')
  const inputVout = txInput.index
  const inputValueSats = psbt.data.inputs[0].witnessUtxo!.value
  const outputs = psbt.txOutputs
  const totalOutputSats = outputs.reduce((sum, o) => sum + BigInt(o.value), 0n)
  const feeSats = BigInt(inputValueSats) - totalOutputSats
  // Same conservative 2-of-3 P2WSH vByte estimate multisig.provider.ts's
  // own estimateFeeSats() uses (11 + 110 + 43*outputCount) — reported here
  // for the human report only; the REAL independent verification below
  // recomputes its own expected fee from a fresh explorer query, never
  // from this display-only estimate.
  const estimatedVBytes = 11 + 110 + 43 * outputs.length

  console.log('\n=== RELATÓRIO PRÉ-ASSINATURA — NENHUMA ASSINATURA FOI FEITA ===')
  console.log(`   Funding txid: ${fundingUtxo?.txid ?? '(não observado nesta execução — reaproveitado de execução anterior, ver Escrow.txLockId)'}`)
  console.log(`   Funding vout: ${fundingUtxo?.vout ?? '(ver input outpoint abaixo)'}`)
  console.log(`   Valor detectado: ${fundingUtxo?.value ?? '?'} sats`)
  console.log(`   Confirmado: ${fundingUtxo?.status.confirmed ?? '?'}`)
  console.log(`   PSBT (base64): ${pending.unsignedPsbtBase64}`)
  console.log(`   Input outpoint (o que será gasto): ${inputTxid}:${inputVout}`)
  console.log(`   Input value: ${inputValueSats} sats`)
  console.log(`   Destination esperado (payout): ${pending.toAddress}`)
  outputs.forEach((o, i) => console.log(`   Output[${i}]: ${o.address} — ${o.value} sats`))
  console.log(`   Fee absoluta: ${feeSats} sats`)
  console.log(`   Fee rate (estimado, ${estimatedVBytes} vB conservador p/ 2-of-3 P2WSH): ~${(Number(feeSats) / estimatedVBytes).toFixed(2)} sat/vB`)
  console.log(`   Required signers: ${pending.requiredSigners.join(', ')} (buyerId=${buyerId}, sellerId=${sellerId})`)
  console.log(`   Escrow com fee policy ativa: ${!!escrowDetails.feePolicyVersionId} (waivedPreFunding=${escrowDetails.snapshotFeeCollectionWaivedPreFunding})`)

  // Missão 11 Fase 5 §12 (Fase 4.2 Activation Blocker D, closed for this
  // real client flow): REAL, independent pre-signature verification via
  // the canonical SDK helper (verifyAndSignEscrowPsbt()) — replacing the
  // prior ad-hoc "onlyExpectedOutput" check, which also only ever handled
  // the legacy single-output shape and never verified the input/outpoint,
  // miner fee, threshold, or participant pubkeys at all. Every expected
  // value below is reconstructed independently — from this escrow's own
  // frozen fee-policy snapshot, the buyer's own known payout address, and
  // a fresh, second fee-rate query against the SAME public explorer
  // estimateFeeSats() itself queries — never by reading the PSBT and
  // re-asserting what it already claims. Disclosed limitation: the
  // arbiter's pubkey (needed for the threshold/participantPubkeys check)
  // is obtained here via multisigProvider.getArbiterPubkeyHex(), which
  // only works because this rehearsal script is co-located with
  // MULTISIG_SEED — a genuinely remote wallet has no API to learn this
  // today; that gap is real and tracked separately (Fase 5's own final
  // report), not solved by this demo.
  const { verifyAndSignEscrowPsbt, buildExpectedFeeAwareReleaseOutputs } = loadWalletVerificationModule()
  const escrowKeyNetwork = config.multisig.network === 'mainnet' ? 'mainnet' : 'testnet'
  const lockedAmountSats = BigInt(Math.round(parseFloat(lockedAmountBtc) * 1e8))
  const isPolicyAware = !!escrowDetails.feePolicyVersionId && escrowDetails.snapshotProtocolFeeRate !== null && escrowDetails.snapshotProtocolFeeRate !== undefined
  const feeCollectible = isPolicyAware && !escrowDetails.snapshotFeeCollectionWaivedPreFunding

  const feeRateBody = (await (await fetch(`${config.multisig.explorerApiUrl}/v1/fees/recommended`)).json()) as { halfHourFee: number }
  const outputCountForFeeEstimate = feeCollectible ? 2 : 1
  const expectedMinerFee = BigInt(Math.ceil(feeRateBody.halfHourFee * (11 + 110 + 43 * outputCountForFeeEstimate)))

  const expectedOutputs = feeCollectible
    ? buildExpectedFeeAwareReleaseOutputs({
        lockedAmountSats,
        protocolFeeRate: escrowDetails.snapshotProtocolFeeRate!, // Missão 11 Fase 9.1 §13 — exact decimal string, no lossy Number() conversion
        minerFee: expectedMinerFee,
        buyerAddress: buyerPayoutAddress,
        secondOutputAddress: escrowDetails.snapshotFeeCollectionAddress!,
      })
    : [{ address: buyerPayoutAddress, value: lockedAmountSats - expectedMinerFee }]

  const arbiterId = config.settlement.trustedArbitrators[0]
  if (!arbiterId) throw new Error('TRUSTED_ARBITRATORS must have at least one entry for this rehearsal to verify the multisig script')
  const arbiterPubkeyHex = multisigProvider.getArbiterPubkeyHex(arbiterId)

  const expectedIntent = {
    operation: 'RELEASE' as const,
    network: escrowKeyNetwork as 'mainnet' | 'testnet',
    escrowId,
    input: { txid: inputTxid, vout: inputVout, value: BigInt(inputValueSats), multisigAddress: depositAddress },
    outputs: expectedOutputs,
    minerFee: expectedMinerFee,
    threshold: 2,
    participantPubkeys: [buyerKeys.publicKeyHex, sellerKeys.publicKeyHex, arbiterPubkeyHex],
    requiredSigners: pending.requiredSigners,
  }

  console.log(`   Verificação independente esperada: outputs=${JSON.stringify(expectedOutputs.map((o: { address: string; value: bigint }) => ({ address: o.address, value: o.value.toString() })))}, minerFee=${expectedMinerFee} sats`)

  if (process.env.DEMO_AUTHORIZE_SIGN !== 'true') {
    console.log('\n>>> STOP GATE: DEMO_AUTHORIZE_SIGN não está definido como "true" — nenhuma assinatura ou broadcast será feito.')
    console.log(`>>> Para assinar e transmitir depois de nova autorização explícita, rode novamente com DEMO_RESUME_ESCROW_ID=${escrowId} DEMO_AUTHORIZE_SIGN=true.`)
    process.exit(0)
  }

  step(8, TOTAL, 'Autorizado — verificando (SDK real, cada parte independentemente) e assinando as 2 assinaturas (buyer + seller), a 2ª dispara combine + broadcast real...')
  // verifyAndSignEscrowPsbt() makes signing STRUCTURALLY unreachable when
  // verification fails — signEscrowPsbt() is never called directly here
  // anymore. Both buyer and seller run the identical check independently,
  // exactly as two separate real wallets would.
  const buyerSigned = verifyAndSignEscrowPsbt(pending.unsignedPsbtBase64, expectedIntent, pending.requiredSigners, buyerKeys.privateKey)
  const sellerSigned = verifyAndSignEscrowPsbt(pending.unsignedPsbtBase64, expectedIntent, pending.requiredSigners, sellerKeys.privateKey)
  await escrowService.submitTransactionSignature(escrowId, buyerId, buyerSigned)
  const result = await escrowService.submitTransactionSignature(escrowId, sellerId, sellerSigned)
  if (!result.complete || !result.escrow) {
    throw new Error(`Esperava a 2ª assinatura completar o release, mas recebi: ${JSON.stringify(result)}`)
  }

  // Derived from the same explorer base the provider itself uses
  // (config.multisig.explorerApiUrl), not a second hardcoded mempool.space
  // URL — follows whatever explorer is actually configured instead of
  // assuming mempool.space specifically.
  const explorerWebBase = config.multisig.explorerApiUrl.replace(/\/api\/?$/, '')
  console.log(`\n=== Ensaio completo — escrow MULTISIG liberado via 2-de-3 real em ${networkLabel} ===`)
  console.log(`   Escrow status: ${result.escrow.status}`)
  console.log(`   Tx de release (real, ${networkLabel}): ${result.escrow.txReleaseId}`)
  console.log(`   Confirme em: ${explorerWebBase}/tx/${result.escrow.txReleaseId}`)

  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n[demo] Falhou:', err)
    process.exit(1)
  })
}
