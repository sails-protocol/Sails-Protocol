/**
 * Sails OpenSettlement — Multisig (2-of-3 Bitcoin) SettlementProvider
 *
 * Real, testable Bitcoin script/PSBT construction (bitcoinjs-lib + bip32 +
 * ecpair + tiny-secp256k1) — TODO.md §4's "Real Multisig 2-of-3 Bitcoin
 * escrow — not implemented; only MOCK" gap. Verified experimentally before
 * writing this file: address derivation, P2WSH witness-script
 * construction, and 2-of-3 PSBT signing/finalization succeed with 2
 * signatures and correctly fail with only 1 — confirmed against the real
 * bitcoinjs-lib/bip32/ecpair APIs, not assumed from docs.
 *
 * Custody model — updated 2026-07-27 (client-held keys pass): the buyer
 * and seller each generate their own key CLIENT-SIDE (`@satsails/p2p-trading-sdk`'s
 * escrow-key module) and submit only the public key
 * (`POST /v1/settlement/escrow/:id/submit-key`, persisted as
 * `EscrowParticipantKey`) — this provider never sees, derives, or holds
 * either of their private keys. Only the THIRD key (arbiter) is still
 * derived from a server-held seed (`MULTISIG_SEED`) — the same role
 * HodlHodl's own real design has the platform hold (confirmed against
 * their public docs before this provider was built). This closes the
 * gap the provider's own header used to disclose here ("all three keys
 * derived from one server-held seed") for the address/script side.
 *
 * Consequence, now resolved (Phase 2, 2026-07-27): `releaseFunds()`/
 * `refundFunds()` used to sign with 2 of 3 keys server-side, synchronously,
 * in one call — no longer possible now that buyer/seller keys are
 * client-held. Both `SettlementProvider` methods still throw below (they
 * are not directly callable), but the REAL release/refund path now exists
 * as a signature-collection flow: `buildUnsignedRelease()`/
 * `buildUnsignedRefund()` build an unsigned PSBT (escrow.service.ts's
 * `initiateRelease()`/`initiateRefund()`); each required party
 * independently signs their own copy client-side (`@satsails/p2p-trading-sdk`'s
 * `signEscrowPsbt()`) and submits it back
 * (`POST .../submit-transaction-signature`); once every required signer
 * has submitted, `finalizeRelease()`/`finalizeRefund()` combine the
 * independently-signed copies and broadcast — verified experimentally
 * before this was written that `Psbt.combine()` correctly merges two
 * independently-signed copies of the same unsigned PSBT (and correctly
 * fails to finalize with only one). On a `DISPUTED` release/refund, the
 * arbiter's own required signature is pre-embedded into the unsigned PSBT
 * at build time (its key is still server-derived, see below) — only the
 * other required party (buyer or seller) is a real pending client
 * submission in that case.
 *
 * Non-custodial in the fund-movement sense — unlike MOCK/WDK_USDT_EVM,
 * this provider never pushes funds into escrow itself. The seller sends
 * BTC to the deterministic address (exposed via getDepositAddress(),
 * populated onto Escrow.multisigAddr by escrow.service.ts's
 * submitParticipantKey() once BOTH buyer and seller pubkeys have arrived
 * — no longer at creation time, since the address genuinely cannot exist
 * before both real pubkeys do) using their own wallet; lockFunds() only
 * verifies that funding arrived (queries a public block-explorer API)
 * rather than causing it.
 *
 * Single-arbiter limitation, stated plainly rather than silently wrong: the
 * P2WSH script's third key is fixed at escrow-creation time to
 * config.settlement.trustedArbitrators[0] (see defaultArbiterId()) — it
 * cannot depend on whichever arbiter TrustedArbitratorProvider's
 * round-robin later assigns to an actual dispute (arbitration-provider.ts),
 * since the script must exist before any dispute does. Relevant now that
 * Phase 2 (above) actually builds a disputed spend: `assertArbiterMatchesScript()`
 * below still refuses a mismatched dispute-arbiter signature loudly rather
 * than attempting one that would fail to validate against this escrow's
 * baked-in script.
 *
 * Testnet only. MULTISIG_SEED empty by default — same "surface a clear
 * config error, don't refuse to boot" pattern as WDK_SEED_PHRASE.
 *
 * **Corrected (Issue #220, 2026-09-27):** "Testnet only" described the
 * Phase-1 state and is stale. The code supports MULTISIG_NETWORK=mainnet
 * (networkFor() below, normalized at config load) behind a mainnet-specific
 * boot guard (config/index.ts LB-01), and #220 deliberately leaves MULTISIG
 * out of escrow-providers.ts's PRODUCTION_INELIGIBLE_TYPES — it is the only
 * production-selectable settlement rail. Evidence: a disclosed small-value
 * mainnet rehearsal (docs/MAINNET_MULTISIG_PROOF.md). This states what the
 * code allows and what was rehearsed, not an audit attestation: no
 * independent security audit of mainnet operation is recorded in this
 * repository.
 */
import * as ecc from 'tiny-secp256k1'
import { BIP32Factory, type BIP32Interface } from 'bip32'
import * as bitcoin from 'bitcoinjs-lib'
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import type { BitcoinNetwork } from '@satsails/p2p-schemas'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import type { SettlementProvider } from './escrow.service'
import { validateOutput, dustThresholdSats } from './bitcoin-dust-policy'
import { computeMaxProtocolFee, computeProtocolFee } from './fee-reserve-math'
import { estimatedVBytesForOutputCount, maxExecutionCostSats } from './execution-cost-policy'
import type { FeeCollectionResult } from './escrow-providers'
import { childLogger } from '../../common/logger'
import { boundedFetch } from './bounded-rpc'

// docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — bounded, safe retry for
// read-only explorer queries only. Never applied to broadcast() (a
// mutating/submission call) — see bounded-rpc.ts's own header.
const EXPLORER_READ_RETRY = { attempts: 3, backoffMs: 250 }

bitcoin.initEccLib(ecc)
const bip32 = BIP32Factory(ecc)
const log = childLogger('multisig-provider')

type ExplorerUtxo = { txid: string; vout: number; value: number; status: { confirmed: boolean } }

// Missão 11 Fase 5 — exported so escrow-pending-tx.ts's collection-
// recognition wiring can resolve the same network identifyFeeOutput()
// needs, without duplicating this mapping a second time.
//
// Missão 11 Fase 8.1 LB-01 — takes the canonical, already-validated
// BitcoinNetwork (config.multisig.network is normalized once at config
// load via normalizeBitcoinNetwork(), which throws on anything
// unrecognized) instead of a raw string. This function itself no longer
// has a silent "anything else means testnet" branch — the exhaustive
// switch below is total over BitcoinNetwork's 3 literals, and the
// `default` case is unreachable except via a type-system bypass (e.g. a
// future caller passing a raw string again), in which case it throws
// rather than silently choosing a network.
export function networkFor(name: BitcoinNetwork): (typeof bitcoin.networks)[keyof typeof bitcoin.networks] {
  switch (name) {
    case 'mainnet':
      return bitcoin.networks.bitcoin
    case 'testnet':
      return bitcoin.networks.testnet
    case 'regtest':
      return bitcoin.networks.regtest
    default: {
      const exhaustiveCheck: never = name
      throw new EscrowError(`MULTISIG provider: unrecognized Bitcoin network '${exhaustiveCheck}' — refusing to silently fall back to any network.`)
    }
  }
}

// Missão 11 Fase 4.1 §1/§3 — the pre-funding waiver decision
// (escrow-fee-snapshot.service.ts's computeSnapshotFields(), made ONCE
// before the seller ever funds anything) must ask the EXACT SAME question
// decideFeeCollection() below asks at settlement-construction time: "is a
// fee of N sats collectible against the currently configured collection
// destination, right now". Extracted to this one function so the two can
// never independently drift on what "collectible" means.
//
// Deliberately reads LIVE config — this IS the one legitimate place to
// consult it, at the single moment its value gets frozen onto an escrow
// forever (Escrow.snapshotFeeCollectionAddress). Every other read in this
// file (decideFeeCollection) uses that frozen snapshot, never this live
// value again — that split is what makes a later config change unable to
// redirect an already-funded escrow's fee (Fase 4.1 §9).
export function evaluateFeeCollectibility(candidateFeeSats: number): { collectible: boolean; collectionAddress: string | null } {
  if (candidateFeeSats <= 0) return { collectible: false, collectionAddress: null }
  const address = config.settlement.protocolFeeCollectionAddress
  if (!address) return { collectible: false, collectionAddress: null }
  const network = networkFor(config.multisig.network)
  let script: Buffer
  try {
    script = Buffer.from(bitcoin.address.toOutputScript(address, network))
  } catch (err) {
    // A configured-but-malformed address is a real infra bug, not a
    // sellerless/unconfigured rail — logged loudly so it's visible in
    // monitoring, but treated as "not collectible" (pre-funding-waived)
    // rather than blocking escrow creation outright: an operator typo in
    // this one setting should degrade to "no fee collected" for policy-
    // aware escrows, not take down trading for every escrow on this rail.
    log.error({
      msg: 'SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS is configured but invalid for the configured network — treating as pre-funding-uncollectible, not blocking escrow creation',
      address, network: config.multisig.network, err: err instanceof Error ? err.message : String(err),
    })
    return { collectible: false, collectionAddress: null }
  }
  if (BigInt(candidateFeeSats) < dustThresholdSats(script)) {
    return { collectible: false, collectionAddress: null }
  }
  return { collectible: true, collectionAddress: address }
}

export interface FeeOutputEvidence {
  vout: number
  amountSats: number
  address: string
  scriptPubKeyHex: string
}

// Missão 11 Fase 5 §5 — deterministic Sails-output identification. Matches
// by the FROZEN expected destination script + expected amount — never "the
// second output," "whatever isn't buyer/seller," or "whatever remains."
// Works identically for RELEASE and SPLIT: a finalized PSBT's outputs are
// byte-identical to the unsigned one construction produced (finalization
// only adds witness/signature data, never touches outputs), so this can be
// called against either `EscrowPendingTransaction.unsignedPsbtBase64`
// (before broadcast) or a decoded broadcast transaction (after). Fails
// closed — throws, never guesses — on zero matching outputs, more than one
// matching output, or an amount mismatch, exactly as Fase 5 §5 requires.
export function identifyFeeOutput(
  psbtBase64: string,
  expectedAddress: string,
  expectedAmountSats: number,
  network: bitcoin.Network
): FeeOutputEvidence {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network })
  let expectedScript: Buffer
  try {
    expectedScript = Buffer.from(bitcoin.address.toOutputScript(expectedAddress, network))
  } catch (err) {
    throw new EscrowError(`identifyFeeOutput: expected collection address '${expectedAddress}' is invalid for the configured network: ${err instanceof Error ? err.message : String(err)}`)
  }
  const matches = psbt.txOutputs
    .map((o, vout) => ({ vout, script: Buffer.from(o.script), value: Number(o.value) }))
    .filter((o) => o.script.equals(expectedScript))

  if (matches.length === 0) {
    throw new EscrowError(`identifyFeeOutput: no output pays the expected frozen collection destination '${expectedAddress}' — refusing to guess which output (if any) is the Protocol Fee.`)
  }
  if (matches.length > 1) {
    throw new EscrowError(`identifyFeeOutput: ${matches.length} outputs pay the expected frozen collection destination '${expectedAddress}' — ambiguous, refusing to guess which one is the Protocol Fee.`)
  }
  const match = matches[0]
  if (match.value !== expectedAmountSats) {
    throw new EscrowError(`identifyFeeOutput: the output paying the expected destination carries ${match.value} sats, but ${expectedAmountSats} sats was expected — refusing to record collection evidence for a mismatched amount.`)
  }
  return { vout: match.vout, amountSats: match.value, address: expectedAddress, scriptPubKeyHex: match.script.toString('hex') }
}

export interface TransactionConfirmationStatus {
  confirmed: boolean
  blockHeight: number | null
}

export interface TransactionExistence {
  exists: boolean
  confirmed: boolean
}

// Missão 11 Fase 9.6 — CONC-03 crash-recovery. The one query
// reconcilePendingSettlement() below actually needs that
// fetchTransactionConfirmationStatus() above can't answer safely: "is
// ANY transaction with this exact txid known to the network at all" —
// distinguishing a genuine 404 (never broadcast, or broadcast then
// evicted/never relayed) from every other failure mode, which must keep
// failing loud rather than being silently read as "doesn't exist."
// Esplora/mempool.space's own convention (same REST family every other
// explorer call in this file already relies on): `GET /tx/{txid}/status`
// 404s only when the txid is genuinely unknown; a known-but-unconfirmed
// (mempool) tx 200s with `confirmed: false`.
export async function fetchTransactionExistence(txid: string): Promise<TransactionExistence> {
  const res = await boundedFetch(`${config.multisig.explorerApiUrl}/tx/${txid}/status`, {}, {
    timeoutMs: config.multisig.explorerRequestTimeoutMs,
    retry: EXPLORER_READ_RETRY,
  })
  if (res.status === 404) return { exists: false, confirmed: false }
  if (!res.ok) {
    throw new EscrowError(`MULTISIG provider: explorer API returned ${res.status} checking existence for ${txid}`)
  }
  const body = (await res.json()) as { confirmed: boolean }
  return { exists: true, confirmed: !!body.confirmed }
}

// Missão 11 Fase 5 §7 — the one real chain query the confirmation-
// recognition job needs: is this specific, already-broadcast txid
// confirmed, and at what height. Same esplora/mempool.space-style REST
// shape (`GET /tx/{txid}/status`) this provider's own fetchUtxos()/
// broadcast() already rely on — no new explorer dependency introduced.
export async function fetchTransactionConfirmationStatus(txid: string): Promise<TransactionConfirmationStatus> {
  const res = await boundedFetch(`${config.multisig.explorerApiUrl}/tx/${txid}/status`, {}, {
    timeoutMs: config.multisig.explorerRequestTimeoutMs,
    retry: EXPLORER_READ_RETRY,
  })
  if (!res.ok) {
    throw new EscrowError(`MULTISIG provider: explorer API returned ${res.status} checking confirmation status for ${txid}`)
  }
  const body = (await res.json()) as { confirmed: boolean; block_height?: number }
  return { confirmed: !!body.confirmed, blockHeight: body.confirmed && typeof body.block_height === 'number' ? body.block_height : null }
}

export interface BroadcastTransactionOutput {
  vout: number
  /** Raw scriptPubKey, hex — esplora's own `scriptpubkey` field, always
   *  present regardless of whether the script decodes to a standard
   *  address. Comparing raw script bytes (never the human-readable
   *  address string) is what makes this directly comparable against
   *  identifyFeeOutput()'s own scriptPubKeyHex output. */
  scriptPubKeyHex: string
  valueSats: number
}

// Missão 11 Fase 5 §7 — fetches the REAL broadcast transaction's outputs
// from the chain itself (never trusts the previously-recorded
// FeeCollectionEvidence row on faith at confirmation time) so the
// confirmation job can independently re-verify the fee output's
// destination and amount against the escrow's own frozen snapshot before
// ever recognizing a collection. Same esplora/mempool.space REST shape
// (`GET /tx/{txid}`) every other explorer call in this file already uses.
export async function fetchTransactionOutputs(txid: string): Promise<BroadcastTransactionOutput[]> {
  const res = await boundedFetch(`${config.multisig.explorerApiUrl}/tx/${txid}`, {}, {
    timeoutMs: config.multisig.explorerRequestTimeoutMs,
    retry: EXPLORER_READ_RETRY,
  })
  if (!res.ok) {
    throw new EscrowError(`MULTISIG provider: explorer API returned ${res.status} fetching transaction ${txid}`)
  }
  const body = (await res.json()) as { vout: Array<{ scriptpubkey: string; value: number }> }
  return body.vout.map((o, vout) => ({ vout, scriptPubKeyHex: o.scriptpubkey, valueSats: o.value }))
}

export interface OutpointSpendStatus {
  spent: boolean
  /** The txid that spent this outpoint, when spent=true. Never trusted
   *  as "the escrow's own release" without an explicit comparison by the
   *  caller — a real, independent chain fact, nothing more. */
  spendingTxid: string | null
}

// Sails Core Implementation Program M9-F (Release-Leg Finality & Reorg
// Closure) — the ONE new chain-truth query this mission needs: "is this
// SPECIFIC funding outpoint currently spent, and by what txid." Same
// esplora/mempool.space-style REST family every other explorer call in
// this file already relies on (`GET /tx/:txid/outspend/:vout`, a real,
// documented endpoint on both hosts) — no new explorer dependency
// introduced. This is what lets the release-leg reorg sweep distinguish
// World C (funding outpoint still unspent — the confirmed release
// transaction genuinely disappeared) from World D (outpoint spent by
// something else — a conflict, never silently reinterpreted as success)
// WITHOUT needing to reconstruct the P2WSH funding address at all — the
// outpoint identity (txLockId:txLockVout) is already a durable,
// never-mutated fact on the Escrow row itself.
export async function fetchOutpointSpendStatus(txid: string, vout: number): Promise<OutpointSpendStatus> {
  const res = await boundedFetch(`${config.multisig.explorerApiUrl}/tx/${txid}/outspend/${vout}`, {}, {
    timeoutMs: config.multisig.explorerRequestTimeoutMs,
    retry: EXPLORER_READ_RETRY,
  })
  if (!res.ok) {
    throw new EscrowError(`MULTISIG provider: explorer API returned ${res.status} checking outspend status for ${txid}:${vout}`)
  }
  const body = (await res.json()) as { spent: boolean; txid?: string }
  return { spent: !!body.spent, spendingTxid: body.spent && typeof body.txid === 'string' ? body.txid : null }
}

// Missão 11 Fase 5 §7 — the second half of computing "how many
// confirmations does this transaction actually have": confirmations =
// tipHeight - blockHeight + 1. Same esplora/mempool.space REST shape
// (`GET /blocks/tip/height`, a bare integer response) every other
// explorer call in this file already relies on.
export async function fetchChainTipHeight(): Promise<number> {
  const res = await boundedFetch(`${config.multisig.explorerApiUrl}/blocks/tip/height`, {}, {
    timeoutMs: config.multisig.explorerRequestTimeoutMs,
    retry: EXPLORER_READ_RETRY,
  })
  if (!res.ok) {
    throw new EscrowError(`MULTISIG provider: explorer API returned ${res.status} fetching the chain tip height`)
  }
  const text = (await res.text()).trim()
  const height = Number(text)
  if (!Number.isFinite(height)) {
    throw new EscrowError(`MULTISIG provider: explorer API returned a non-numeric chain tip height: '${text}'`)
  }
  return height
}

// Same shape as wdk-settlement.provider.ts's escrowIndexFor/buyerIndexFor —
// sha256(role:id) -> a stable, evenly-distributed non-hardened BIP-32
// index. Exported for direct unit testing, same reason those are.
export function keyIndexFor(role: 'buyer' | 'seller' | 'arbiter', id: string): number {
  const hash = createHash('sha256').update(`${role}:${id}`).digest()
  return hash.readUInt32BE(0) % 0x7fffffff
}

export interface MultisigParties {
  buyerPubkey: Buffer   // 33-byte compressed secp256k1, client-submitted
  sellerPubkey: Buffer  // 33-byte compressed secp256k1, client-submitted
  // Missão 11 Fase 5.2, tightened Fase 9.3 §4 — the RESOLVED arbiter
  // public key bytes, not an id to re-derive from: always the escrow's own
  // persisted arbiterPubkey commitment, parsed once by partiesFor().
  // buildScript() below never derives an arbiter key itself — it only
  // ever consumes what partiesFor()/getDepositAddress() already resolved,
  // so there is exactly one place per call path where a live derivation
  // can ever happen (getDepositAddress(), before any commitment exists
  // yet to persist). See partiesFor()'s own comment for why an escrow with
  // no persisted commitment is now rejected outright rather than silently
  // falling back to live config.
  arbiterPubkey: Buffer
}

// Minimal shape this provider actually needs from an EscrowRecord — a
// structural subset, not the full type, so tests can construct fixtures
// without importing escrow.service.ts's internal type.
export type MultisigEscrowInput = {
  tradeId: string
  lockedAmount: string
  buyerPubkey?: string   // hex, 33-byte compressed — from EscrowParticipantKey
  sellerPubkey?: string  // hex, 33-byte compressed — from EscrowParticipantKey
  // Trade's own party ids (not pubkeys) — needed by buildUnsignedRelease()/
  // buildUnsignedRefund() below to know WHICH participant id each required
  // client signature must come from. Distinct from buyerPubkey/sellerPubkey
  // above (script material) the same way escrow.service.ts's EscrowRecord
  // already separates the two.
  buyerId?: string
  sellerId?: string
  txLockId?: string | null
  // Missão 10 — the persisted funding outpoint's vout, alongside
  // txLockId's own txid. Undefined/null for an escrow that locked funds
  // before this was introduced (buildUnsignedSpend() falls back to the
  // pre-existing txid-only match in that case, disclosed explicitly
  // there — never silently).
  txLockVout?: number | null
  status?: string
  triggeredBy?: string
  // Missão 11 Fase 4 — the escrow's own immutable fee-policy snapshot.
  // Undefined/null for a legacy escrow — every method below preserves
  // today's exact behavior in that case (see isPolicyAware()).
  feePolicyVersionId?: string | null
  snapshotProtocolFeeRate?: string | null
  // Missão 11 Fase 4.1 §1/§3 — the FROZEN collection destination and
  // pre-funding-waiver decision (escrow-fee-snapshot.service.ts's
  // computeSnapshotFields(), computed once before the seller ever funds
  // anything). maxFeeSats()/decideFeeCollection() below read these
  // exclusively — never config.settlement.protocolFeeCollectionAddress
  // directly — so a live config change after this escrow was created can
  // never redirect its fee to a different destination.
  snapshotFeeCollectionAddress?: string | null
  snapshotFeeCollectionWaivedPreFunding?: boolean | null
  // Missão 11 Fase 5.2 §2/§4 — the escrow-specific, immutable arbiter
  // public-key commitment (hex, 33-byte compressed), from
  // EscrowParticipantKey's role='arbiter' row. Never re-derived for an
  // escrow that has one: this is the one field that makes a future
  // TRUSTED_ARBITRATORS/MULTISIG_SEED change unable to silently redefine
  // what this specific escrow's script means.
  //
  // Missão 11 Fase 9.3 §4 — stays optional at the TYPE level (no schema
  // change, no destructive migration — see partiesFor()'s own comment for
  // why removing the RUNTIME fallback needed neither), but every real
  // call path (getDepositAddress(), used unconditionally by
  // submitParticipantKey()) has always populated this field: no NEW
  // MULTISIG escrow can reach FUNDS_LOCKED without one, and the DB-native
  // arbiter-immutability trigger (Fase 5.2) means an existing commitment
  // can never be deleted either. Since production never launched, no real
  // escrow anywhere lacks this field — undefined/null here now means
  // "reject," not "fall back to live config" (partiesFor() below).
  arbiterPubkey?: string | null
}

export class MultisigProvider implements SettlementProvider {
  name = 'MULTISIG'
  readonly custodyModel = 'client-held-buyer-seller-keys-server-held-arbiter' as const

  private masterNode: BIP32Interface | null = null

  private getMaster(): BIP32Interface {
    if (this.masterNode) return this.masterNode
    if (!config.multisig.seed) {
      throw new EscrowError(
        'MULTISIG provider requires MULTISIG_SEED configured (.env.example) — refusing to derive the arbiter key from an empty seed'
      )
    }
    const network = networkFor(config.multisig.network)
    const seedBuffer = createHash('sha256').update(config.multisig.seed).digest()
    this.masterNode = bip32.fromSeed(seedBuffer, network)
    return this.masterNode
  }

  private defaultArbiterId(): string {
    const arbiter = config.settlement.trustedArbitrators[0]
    if (!arbiter) {
      throw new EscrowError(
        'MULTISIG provider requires at least one TRUSTED_ARBITRATORS entry configured (.env.example) — no arbiter key to derive for the 2-of-3 script'
      )
    }
    return arbiter
  }

  // Missão 11 Fase 7.3.1 §B — real P0 fix: a disputed release/refund/split
  // must SIGN with the arbiter identity actually committed into THIS
  // escrow's script (escrow.triggeredBy, verified by
  // assertArbiterMatchesScript() above each of these call sites), never
  // unconditionally today's live-config defaultArbiterId(). Before this
  // fix, every signing call site derived the signing key via
  // `defaultArbiterId()` directly, silently assuming it always equals
  // whichever identity assertArbiterMatchesScript() had just verified —
  // true before Fase 7.3.1 (that check also always used
  // defaultArbiterId()), but no longer true once that check correctly
  // started accepting a historically-committed arbiter even after
  // TRUSTED_ARBITRATORS rotates away from them at index 0: signing would
  // then derive the WRONG (current-default) key and fail with a real
  // bitcoinjs-lib "Can not sign for this input with the key ..." error.
  // Falls back to defaultArbiterId() only when triggeredBy is genuinely
  // absent (defensive; every real dispute-resolution call site always
  // supplies it).
  private resolveArbiterSigningId(escrow: MultisigEscrowInput): string {
    return escrow.triggeredBy ?? this.defaultArbiterId()
  }

  // Arbiter is the only role this provider still derives itself — buyer
  // and seller keys are client-submitted (see partiesFor()).
  private deriveArbiterKey(id: string): BIP32Interface {
    const master = this.getMaster()
    const index = keyIndexFor('arbiter', id)
    return master.derivePath(`m/0'/0/${index}`)
  }

  // Missão 11 Fase 5 §12 — the ONE piece of information a real client-side
  // pre-signature verification (verifySigningIntent()'s participantPubkeys/
  // threshold check) needs that this provider derives itself rather than
  // receiving from a client: the arbiter's PUBLIC key. Exposed as its own
  // narrow, public-key-only method (never the private key, never the
  // master node) so a co-located rehearsal script — or, in a real
  // deployment, a future dedicated read endpoint, not built in this pass —
  // can construct a genuine, independently-verified expectation instead of
  // trusting the server's own PSBT on faith for the one pubkey it can't
  // otherwise learn. Disclosed limitation: this method call itself is only
  // meaningful when the caller is co-located with MULTISIG_SEED (as this
  // mission's own rehearsal script is) — a truly remote wallet has no real
  // way to call it today; see examples/demo/multisig-testnet-flow.ts's own
  // comment at its call site for the honest scope of what this proves.
  getArbiterPubkeyHex(arbiterId: string): string {
    return Buffer.from(this.deriveArbiterKey(arbiterId).publicKey).toString('hex')
  }

  // Sorted pubkey order (lexicographic, BIP67-style) — deterministic
  // regardless of submission order, so the same 3 parties always produce
  // the same script/address. Missão 11 Fase 5.2 — no longer derives the
  // arbiter key itself; consumes parties.arbiterPubkey exactly as resolved
  // by the caller (getDepositAddress() or partiesFor() below), so this
  // function can never itself be a point of divergence between what gets
  // persisted and what gets built into the script.
  private buildScript(parties: MultisigParties) {
    const network = networkFor(config.multisig.network)

    const pubkeys = [parties.buyerPubkey, parties.sellerPubkey, parties.arbiterPubkey]
      .sort(Buffer.compare)

    const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys, network })
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network })

    return { p2ms, p2wsh, network }
  }

  private parsePubkey(hex: string | undefined, role: 'buyer' | 'seller' | 'arbiter', tradeId: string): Buffer {
    if (!hex) {
      throw new EscrowError(
        `MULTISIG provider requires a submitted ${role} pubkey for trade ${tradeId} — call POST /v1/settlement/escrow/:id/submit-key first (see EscrowParticipantKey)`
      )
    }
    const buf = Buffer.from(hex, 'hex')
    if (buf.length !== 33) {
      throw new EscrowError(`MULTISIG provider: ${role} pubkey for trade ${tradeId} must be a 33-byte compressed secp256k1 key, got ${buf.length} bytes`)
    }
    return buf
  }

  // Missão 11 Fase 5.2 §2, tightened Fase 9.3 §4 — an escrow's script is
  // ALWAYS built from its own PERSISTED arbiter commitment, never
  // re-derived from live config: the only way a future
  // TRUSTED_ARBITRATORS/MULTISIG_SEED change can never silently redefine
  // what this escrow's script means. No live-config fallback for a
  // missing commitment (removed Fase 9.3 §4, an independently-reproduced
  // red-team finding — Kimi K3 R1 MULTI-01): "no persisted arbiter
  // commitment = not eligible for real MULTISIG settlement," fail closed
  // here rather than silently deriving a key from whatever
  // TRUSTED_ARBITRATORS/MULTISIG_SEED happen to be RIGHT NOW. Safe to
  // remove without a migration or synthesized history — production never
  // launched, and every real call path (getDepositAddress(), see
  // MultisigEscrowInput.arbiterPubkey's own comment) has always persisted
  // this field, so no genuine escrow anywhere is affected; only a
  // hand-crafted fixture bypassing submitParticipantKey() could ever
  // trigger this.
  private partiesFor(escrow: MultisigEscrowInput): MultisigParties {
    // Buyer/seller pubkey presence/shape checked first, unchanged priority
    // from before this method's arbiter check existed — a genuinely
    // pre-submission escrow (no client pubkeys at all yet) should still
    // surface ITS OWN, more specific problem ("submit your pubkey first")
    // rather than being masked by the arbiter-commitment check below.
    const buyerPubkey = this.parsePubkey(escrow.buyerPubkey, 'buyer', escrow.tradeId)
    const sellerPubkey = this.parsePubkey(escrow.sellerPubkey, 'seller', escrow.tradeId)
    if (!escrow.arbiterPubkey) {
      throw new EscrowError(
        `MULTISIG escrow for trade ${escrow.tradeId} has no persisted arbiter public-key commitment — this reference implementation refuses to derive an arbiter key from live config for an escrow that never recorded one. Call submitParticipantKey() for both parties first (it always persists this commitment via getDepositAddress()).`
      )
    }
    return {
      buyerPubkey,
      sellerPubkey,
      arbiterPubkey: this.parsePubkey(escrow.arbiterPubkey, 'arbiter', escrow.tradeId),
    }
  }

  // See this file's header comment on the single-arbiter limitation — only
  // relevant on the DISPUTED path, where `triggeredBy` is the arbiter
  // actually assigned to this dispute (dispute.service.ts's
  // resolveDispute()), which may not be the one baked into this escrow's
  // script if more than one TRUSTED_ARBITRATORS entry is configured.
  //
  // Missão 11 Fase 9.3 §4 — every caller of this method reaches it only
  // after buildUnsignedSpend()'s own caller has already called
  // partiesFor(escrow) first (buildUnsignedRelease/Refund/Split, each
  // line 987/1039/1101-ish), which now throws outright for an escrow with
  // no persisted arbiterPubkey commitment. The "legacy escrow, fall back
  // to a plain identity-string check against live config" branch this
  // method used to have below is therefore unreachable and was removed —
  // not because the check was wrong, but because the escrow shape it
  // existed for (arbiterPubkey undefined) can no longer reach this far.
  private assertArbiterMatchesScript(escrow: MultisigEscrowInput) {
    if (escrow.status !== 'DISPUTED') return
    const scriptArbiter = this.defaultArbiterId()

    // Missão 11 Fase 5.2 §6, revised Fase 7.3.1 §B — additive,
    // escrow-specific check. For a NEW escrow carrying a persisted
    // arbiterPubkey commitment, prefer that persisted cryptographic truth
    // over live config: does the identity actually ATTEMPTING this
    // operation (`escrow.triggeredBy`, when known) still derive the exact
    // key committed into THIS escrow's script at creation time? A future
    // TRUSTED_ARBITRATORS/MULTISIG_SEED change can never silently redefine
    // what a historical escrow's script means — if the live-derivable key
    // no longer matches the persisted commitment, this fails closed here,
    // before ever building a script or signing, rather than silently
    // trusting "the identity matches today's config" as a stand-in for
    // "the key matches what was actually committed."
    //
    // Fase 7.3.1 §B real fix: this used to always re-derive
    // `scriptArbiter` (live config's defaultArbiterId(), i.e. whatever
    // TRUSTED_ARBITRATORS[0] happens to be RIGHT NOW) regardless of who
    // was actually attempting the operation — so a TRUSTED_ARBITRATORS
    // list rotation/reorder after this escrow was created would falsely
    // reject the ORIGINAL, still-cryptographically-valid arbiter's own
    // ruling, permanently stuck, even though nothing about THEIR key
    // actually changed. Checking `escrow.triggeredBy`'s own derived key
    // (when known) instead of `scriptArbiter` fixes this while still
    // correctly catching a real MULTISIG_SEED rotation: if the seed
    // itself changed, `triggeredBy`'s live-derived key no longer
    // reproduces the persisted commitment either, so this still fails
    // closed for that case — it just no longer fails closed for the
    // harmless case (list order changed, same seed, same identity's key
    // is still exactly reproducible).
    // partiesFor() (called by every caller of buildUnsignedSpend(), always
    // before this method runs — see this method's own header comment)
    // already guarantees escrow.arbiterPubkey is present here; the
    // pre-Fase-9.3 branch for a missing commitment (falling back to a
    // plain identity-string check against live config) was removed since
    // it could no longer be reached.
    const checkedIdentity = escrow.triggeredBy ?? scriptArbiter
    const liveArbiterPubkeyHex = this.getArbiterPubkeyHex(checkedIdentity)
    if (liveArbiterPubkeyHex !== escrow.arbiterPubkey) {
      // Fase 7.3.1 §B — one honest message covering both real root
      // causes this single cryptographic check cannot itself
      // distinguish (both produce the exact same observable symptom,
      // "this identity's derived key isn't the one baked into the
      // script"): either `checkedIdentity` was simply never the right
      // identity for this escrow (a different, wrong arbiter attempted
      // this), or it IS the right identity but TRUSTED_ARBITRATORS/
      // MULTISIG_SEED changed since creation so it no longer derives
      // the same key. Deliberately does not guess which — guessing
      // wrong would be actively misleading to whoever reads this error.
      throw new EscrowError(
        `MULTISIG provider: identity '${checkedIdentity}' does not match the arbiter public key committed into trade ${escrow.tradeId}'s escrow at creation time ` +
        '— either this is not the identity whose key was actually baked into the script, or TRUSTED_ARBITRATORS/MULTISIG_SEED changed since creation. ' +
        'Refusing to sign against a script whose committed arbiter cannot be reproduced from the identity attempting this operation.'
      )
    }
  }

  // Not part of SettlementProvider — called by escrow.service.ts's
  // submitParticipantKey() once BOTH buyer and seller pubkeys have been
  // submitted, to populate Escrow.multisigAddr. Takes the raw submitted
  // hex directly (not an EscrowEscrowInput) since this runs before any
  // Escrow-shaped object with those fields necessarily exists in the
  // caller's hands.
  //
  // Missão 11 Fase 5.2 §2 — the arbiter key is derived EXACTLY ONCE here
  // (arbiterPubkey below) and that same Buffer feeds BOTH buildScript()
  // (script/address construction) AND the returned arbiterPubkeyHex
  // (what escrow.service.ts persists as this escrow's immutable
  // commitment) — there is no second, independent derivation anywhere in
  // this call, so the persisted value and the script's real embedded key
  // cannot diverge by construction.
  async getDepositAddress(tradeId: string, buyerPubkeyHex: string, sellerPubkeyHex: string): Promise<{ address: string; arbiterPubkeyHex: string; arbiterId: string }> {
    const arbiterId = this.defaultArbiterId()
    const arbiterPubkey = Buffer.from(this.deriveArbiterKey(arbiterId).publicKey)
    const parties: MultisigParties = {
      buyerPubkey: this.parsePubkey(buyerPubkeyHex, 'buyer', tradeId),
      sellerPubkey: this.parsePubkey(sellerPubkeyHex, 'seller', tradeId),
      arbiterPubkey,
    }
    const { p2wsh } = this.buildScript(parties)
    if (!p2wsh.address) throw new EscrowError(`Failed to derive a P2WSH address for trade ${tradeId}`)
    return { address: p2wsh.address, arbiterPubkeyHex: arbiterPubkey.toString('hex'), arbiterId }
  }

  private async fetchUtxos(address: string): Promise<ExplorerUtxo[]> {
    const res = await boundedFetch(`${config.multisig.explorerApiUrl}/address/${address}/utxo`, {}, {
      timeoutMs: config.multisig.explorerRequestTimeoutMs,
      retry: EXPLORER_READ_RETRY,
    })
    if (!res.ok) {
      throw new EscrowError(`MULTISIG provider: explorer API returned ${res.status} for ${address}`)
    }
    return res.json() as Promise<ExplorerUtxo[]>
  }

  private expectedSats(lockedAmount: string): number {
    return Math.round(parseFloat(lockedAmount) * 1e8)
  }

  // Missão 11 Fase 3.2-3.4 — the seller-funded Protocol Fee reserve. Every
  // method below that needs to distinguish "legacy" from "policy-aware"
  // funding/output behavior goes through this one check.
  private isPolicyAware(escrow: MultisigEscrowInput): boolean {
    return !!escrow.feePolicyVersionId && escrow.snapshotProtocolFeeRate !== null && escrow.snapshotProtocolFeeRate !== undefined
  }

  // A Decimal->sats conversion that trusts computeMaxProtocolFee()/
  // computeProtocolFee() to have already floored to 8 decimal places (=
  // satoshi precision for a BTC-denominated amount) — .toFixed(0) on an
  // already-integer-at-the-satoshi-level Decimal is an exact conversion,
  // not a second independent rounding step.
  private decimalBtcToSats(amount: Prisma.Decimal): number {
    return Number(amount.times(1e8).toFixed(0))
  }

  // Fmax — sized against the worst case (a full release, basis = the
  // entire trade notional T), computed from the SAME shared function
  // fee-obligation.service.ts uses, so a mismatch between what's built
  // into a real PSBT and what's recorded as the FeeObligation is
  // structurally impossible (Fase 4 §J).
  private maxFeeSats(escrow: MultisigEscrowInput): number {
    if (!this.isPolicyAware(escrow)) return 0
    // Missão 11 Fase 4.1 §1/§5 — the pre-funding waiver decision, frozen
    // at policy-snapshot time, is authoritative: if the maximum possible
    // fee was already known, before funding, to be uncollectible against
    // the frozen destination, Fmax is 0 and no reserve was ever funded —
    // never recomputed live from the raw rate. Distinct from a genuine
    // zero-rate policy (which reaches the same Fmax=0 result below via
    // the math itself, not this flag) — see the escrow column's own
    // schema comment for why the two are tracked separately.
    if (escrow.snapshotFeeCollectionWaivedPreFunding) return 0
    const lockedAmount = new Prisma.Decimal(escrow.lockedAmount)
    const rate = new Prisma.Decimal(escrow.snapshotProtocolFeeRate!)
    return this.decimalBtcToSats(computeMaxProtocolFee(lockedAmount, rate))
  }

  // R = T + Fmax. For a legacy escrow this equals expectedSats(T) exactly
  // (Fmax = 0), preserving today's behavior byte-for-byte.
  private requiredFundingSats(escrow: MultisigEscrowInput): number {
    return this.expectedSats(escrow.lockedAmount) + this.maxFeeSats(escrow)
  }

  // The one place the dust-vs-collectible decision is made (Fase 3.3/3.4
  // §E/§G): computes the ACTUAL fee for the given basis (T for a plain
  // release, the seller's own bps-portion of T for a split — never the
  // buyer's share), then checks it against the real dust threshold for
  // WHATEVER script the configured collection address actually is —
  // never a universal constant (bitcoin-dust-policy.ts's own governing
  // principle). Never alters basisSats/buyerBps to "make room" for a
  // collectible fee (Fase 3.3 §G's own hard rule) — a dust-doomed fee is
  // waived outright, never shrunk-then-forced.
  private decideFeeCollection(escrow: MultisigEscrowInput, basisAmountBtc: Prisma.Decimal, network: bitcoin.Network): { feeSats: number; waived: boolean; collectionAddress: string | null } {
    if (!this.isPolicyAware(escrow)) return { feeSats: 0, waived: false, collectionAddress: null }
    const rate = new Prisma.Decimal(escrow.snapshotProtocolFeeRate!)
    const feeSats = this.decimalBtcToSats(computeProtocolFee(basisAmountBtc, rate))
    if (feeSats <= 0) return { feeSats: 0, waived: true, collectionAddress: null }

    // Missão 11 Fase 4.1 §3/§9 — the FROZEN destination decided at
    // policy-snapshot time, never live config: this is what guarantees a
    // later config change can never redirect an already-funded escrow's
    // fee to a different destination. Callers only ever reach this line
    // with a caller-computed basis whose corresponding Fmax was > 0
    // (maxFeeSats() above already returns 0, short-circuiting the caller,
    // whenever the pre-funding decision found no viable frozen
    // destination) — reaching here with no frozen address is therefore a
    // real invariant violation, not a normal runtime condition.
    const collectionAddress = escrow.snapshotFeeCollectionAddress
    if (!collectionAddress) {
      throw new EscrowError(
        `MULTISIG provider: escrow for trade ${escrow.tradeId} has a collectible fee (${feeSats} sats) but no frozen snapshotFeeCollectionAddress — this should be structurally impossible once maxFeeSats() > 0 (escrow-fee-snapshot.service.ts's pre-funding decision should have prevented this).`
      )
    }
    let script: Buffer
    try {
      script = Buffer.from(bitcoin.address.toOutputScript(collectionAddress, network))
    } catch (err) {
      throw new EscrowError(`MULTISIG provider: frozen snapshotFeeCollectionAddress '${collectionAddress}' is invalid for the configured network: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (BigInt(feeSats) < dustThresholdSats(script)) {
      // SETTLEMENT-TIME WAIVER (Fase 4.1 §2) — distinct from the
      // PRE-FUNDING waiver maxFeeSats() already applies above. Only
      // reachable from a SPLIT, whose actual basis (the seller's own
      // bps-portion of T) can be smaller than the full-T basis the
      // pre-funding decision evaluated Fmax against — never reachable
      // from a plain RELEASE post-Fase-4.1 (its basis is always the same
      // full T the pre-funding check already verified against this exact
      // frozen destination). The unused reserve returns entirely to the
      // seller (handled by each caller below); Sails never attempts a
      // sub-dust output.
      return { feeSats, waived: true, collectionAddress: null }
    }
    return { feeSats, waived: false, collectionAddress }
  }

  // Missão 11 Fase 8.1 LB-02 — the real, load-bearing gate for
  // FUNDS_LOCKED (escrow.service.ts's lockFunds() calls this method)
  // previously accepted a value-matching UTXO regardless of
  // `status.confirmed` at all. F6 (docs/TECHNICAL_DEBT_AUDIT.md #53,
  // 2026-09-07) — this fix was originally described relative to a
  // sibling `verifyLock()` method that duplicated this same logic with a
  // weaker guarantee and had no real caller anywhere; that method has
  // since been removed from the interface entirely (see
  // escrow-providers.ts's own SettlementProvider header comment), not
  // merely left uncalled. This helper is the one place a candidate
  // funding UTXO is checked for real economic finality: confirmed AND at
  // or beyond config.multisig.requiredConfirmations deep, computed from
  // the actual chain tip the same way multisig-fee-confirmation-job.ts
  // already computes fee-collection depth (tipHeight - blockHeight + 1).
  // Returns the confirmation count (0 if genuinely unconfirmed) rather
  // than a boolean so lockFunds()'s error message can report real
  // progress ("2 of 3 confirmations") instead of a bare yes/no.
  //
  // Missão 11 Fase 9.1 §1 — also returns the raw blockHeight/tipHeight
  // (not just the derived depth count) so lockFunds() can record them
  // verbatim onto the initial EscrowFundingEvidence.OBSERVED_CONFIRMED
  // row — the same real numbers this check itself used to decide the
  // escrow was safe to lock, not re-derived or approximated later.
  private async confirmationDepth(txid: string): Promise<{ depth: number; blockHeight: number | null; tipHeight: number | null }> {
    const status = await fetchTransactionConfirmationStatus(txid)
    if (!status.confirmed || status.blockHeight === null) return { depth: 0, blockHeight: null, tipHeight: null }
    const tipHeight = await fetchChainTipHeight()
    return { depth: tipHeight - status.blockHeight + 1, blockHeight: status.blockHeight, tipHeight }
  }

  // Missão 11 Fase 9.1 §3/§8 — the exact UTXO-matching predicate lockFunds()
  // always used, extracted so multisig-funding-reorg-sweep.ts can re-scan
  // for a REPLACEMENT candidate at this escrow's own address using the
  // IDENTICAL matching rule, rather than a second, independently-written
  // heuristic that could subtly drift from this one (the CTO's own
  // "server must not maintain subtly different construction/matching
  // rules" principle, applied internally here too). Never throws — returns
  // null when nothing matches, since "not found" is a normal, expected
  // outcome for a re-scan (unlike lockFunds()'s own first-time call, where
  // it's a real error to surface to the caller).
  private async findFundingCandidate(escrow: MultisigEscrowInput): Promise<{ address: string; utxo: ExplorerUtxo } | null> {
    const parties = this.partiesFor(escrow)
    const { p2wsh } = this.buildScript(parties)
    const address = p2wsh.address!
    const utxos = await this.fetchUtxos(address)

    const utxo = this.isPolicyAware(escrow)
      ? utxos.find((u) => u.value === this.requiredFundingSats(escrow) && u.status.confirmed)
      : utxos.find((u) => u.value >= this.expectedSats(escrow.lockedAmount) && u.status.confirmed)
    return utxo ? { address, utxo } : null
  }

  private noFundingCandidateError(escrow: MultisigEscrowInput, address: string): EscrowError {
    if (this.isPolicyAware(escrow)) {
      const requiredSats = this.requiredFundingSats(escrow)
      return new EscrowError(
        `No funding UTXO of EXACTLY ${requiredSats} sats (trade amount + maximum Protocol Fee reserve) found at ${address}. ` +
        'This escrow is under a Protocol Fee policy and requires exact, single-outpoint funding — a value below, above, or split across ' +
        'multiple UTXOs is rejected, not silently accepted. This is a non-custodial provider — it verifies external funding, it does not move funds itself.'
      )
    }
    const expected = this.expectedSats(escrow.lockedAmount)
    return new EscrowError(
      `No funding UTXO of at least ${expected} sats found at ${address} yet. This is a non-custodial provider — ` +
      `it verifies external funding, it does not move funds itself. Send the trade's collateral to ${address} first, then retry lockFunds.`
    )
  }

  // Missão 10 — now returns vout alongside txId. This is still the ONE
  // place an outpoint is discovered by value/address heuristic (there is
  // no persisted outpoint yet to check against — that's exactly what
  // this call is establishing) — everything downstream of this
  // (buildUnsignedSpend()) must use the vout this returns exactly, never
  // re-discover it.
  async lockFunds(escrow: MultisigEscrowInput): Promise<{
    txId: string; vout: number; address: string; fundedAmount?: number
    confirmedAtHeight?: number; tipHeightAtObservation?: number
  }> {
    const required = config.multisig.requiredConfirmations
    const candidate = await this.findFundingCandidate(escrow)

    // Missão 11 Fase 3.4/4 — policy-aware escrows require EXACT,
    // single-outpoint funding (A = R = T + Fmax). This single strict-equality
    // predicate (inside findFundingCandidate() above) is what rejects
    // underfunding, overfunding, AND multi-UTXO funding uniformly (Fase
    // 3.4 §A/§F) — no separate cases needed. A mismatch throws BEFORE any
    // txLockId/txLockVout is ever persisted and BEFORE the escrow
    // transitions past its current status (escrow.service.ts's own
    // claimEscrowTransition()/revertEscrowStatus() flow, unchanged) —
    // confirmed structurally, not assumed (Fase 3.4 §4's own audit).
    if (!candidate) {
      const parties = this.partiesFor(escrow)
      const { p2wsh } = this.buildScript(parties)
      throw this.noFundingCandidateError(escrow, p2wsh.address!)
    }

    const { address, utxo: funding } = candidate
    const { depth, blockHeight, tipHeight } = await this.confirmationDepth(funding.txid)
    if (depth < required) {
      throw new EscrowError(
        `Funding UTXO ${funding.txid}:${funding.vout} at ${address} has ${depth} of the required ${required} confirmation(s). ` +
        'Refusing to lock funds on insufficient confirmation depth — a shallow reorg could invalidate this funding before Sails ' +
        'ever transitions the escrow to FUNDS_LOCKED. Retry once the required depth is reached.'
      )
    }
    return {
      txId: funding.txid, vout: funding.vout, address,
      ...(this.isPolicyAware(escrow) ? { fundedAmount: funding.value } : {}),
      ...(blockHeight !== null ? { confirmedAtHeight: blockHeight } : {}),
      ...(tipHeight !== null ? { tipHeightAtObservation: tipHeight } : {}),
    }
  }

  // Missão 11 Fase 9.1 §3 — used by multisig-funding-reorg-sweep.ts to
  // check whether a REPLACEMENT transaction now funds this escrow's own
  // committed address/script correctly, using the exact same matching
  // rule and confirmation-depth rigor lockFunds() itself required — never
  // a lighter-weight or best-effort re-check. Returns null (never throws)
  // when nothing currently matches — a normal, expected outcome for a
  // re-scan of an escrow whose original funding disappeared.
  async rescanFunding(escrow: MultisigEscrowInput): Promise<{
    txId: string; vout: number; depth: number; confirmedAtHeight: number | null; tipHeightAtObservation: number | null
  } | null> {
    const candidate = await this.findFundingCandidate(escrow)
    if (!candidate) return null
    const { depth, blockHeight, tipHeight } = await this.confirmationDepth(candidate.utxo.txid)
    return { txId: candidate.utxo.txid, vout: candidate.utxo.vout, depth, confirmedAtHeight: blockHeight, tipHeightAtObservation: tipHeight }
  }

  // docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — TIMEOUT_ONLY, deliberately no
  // retry: this submits a raw signed Bitcoin transaction. A timeout after
  // dispatch means the broadcast's real outcome is UNKNOWN, not FAILED —
  // the explorer may already have accepted and relayed it even though
  // the HTTP response never arrived. Retrying here is not authorized by
  // this mission (cross-backend duplicate-submission idempotence is not
  // proven); on timeout, the bounded error propagates unchanged to the
  // existing caller, which already treats a broadcast failure as
  // "did not confirm this attempt succeeded," never as "definitely
  // failed" — no escrow-state semantics are changed by this fix.
  private async broadcast(txHex: string): Promise<string> {
    const res = await boundedFetch(`${config.multisig.explorerApiUrl}/tx`, { method: 'POST', body: txHex }, {
      timeoutMs: config.multisig.explorerRequestTimeoutMs,
    })
    if (!res.ok) {
      throw new EscrowError(`MULTISIG provider: broadcast failed with ${res.status}: ${await res.text()}`)
    }
    return (await res.text()).trim()
  }

  // Real fee estimation (2026-08-02) — closes this provider's own former
  // "a real deployment would query the explorer's fee-estimate endpoint"
  // gap, now that a real deployment is exactly what's happening.
  // mempool.space's real, documented `/v1/fees/recommended` endpoint
  // works identically against both its mainnet and testnet hosts (same
  // path, config.multisig.explorerApiUrl already points at whichever
  // one is configured). `halfHourFee` — a real confirmation target, not
  // the priciest `fastestFee` tier — since an escrow release/refund/split
  // is not typically racing a mempool-fee war. Throws rather than
  // guessing on failure: a wrong fee for a real Bitcoin spend either
  // overpays or gets stuck unconfirmed, neither of which this provider
  // should ever silently risk by falling back to a made-up number.
  private async fetchFeeRateSatsPerVByte(): Promise<number> {
    let res: Response
    try {
      res = await boundedFetch(`${config.multisig.explorerApiUrl}/v1/fees/recommended`, {}, {
        timeoutMs: config.multisig.explorerRequestTimeoutMs,
        retry: EXPLORER_READ_RETRY,
      })
    } catch (err) {
      throw new EscrowError(
        `MULTISIG provider: failed to reach the fee-estimate endpoint (${config.multisig.explorerApiUrl}/v1/fees/recommended) — refusing to guess a fee for a real Bitcoin spend: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!res.ok) {
      throw new EscrowError(`MULTISIG provider: fee-estimate endpoint returned ${res.status}`)
    }
    const fees = (await res.json()) as { halfHourFee?: number; fastestFee?: number }
    const rate = fees.halfHourFee ?? fees.fastestFee
    if (!rate || rate <= 0) {
      throw new EscrowError(`MULTISIG provider: fee-estimate endpoint returned no usable rate (${JSON.stringify(fees)})`)
    }
    return rate
  }

  // Conservative, documented vByte estimate for a 2-of-3 P2WSH spend —
  // one witness input (base ~11 vB overhead + ~110 vB for the input:
  // two ~72-byte DER signatures plus the ~105-byte 2-of-3 witness
  // script, segwit-discounted) plus ~43 vB per output (the P2WSH-sized
  // figure, not the cheaper P2WPKH one, since a caller's address could
  // be either — generous rather than exact, the same "err toward
  // overpaying, never toward a stuck tx" bias the real rate lookup
  // above already has).
  //
  // Sails Core Implementation Program M8.6 — the vsize formula itself
  // moved to execution-cost-policy.ts (estimatedVBytesForOutputCount())
  // so it is the SAME single source of truth this file's own real
  // construction uses AND the one M8.6's independent skim-detection
  // bound (maxExecutionCostSats()) uses — never two copies that could
  // silently drift (INV-OP-9's own "exactly one normative algorithm"
  // principle).
  private estimateFeeSats(feeRateSatsPerVByte: number, outputCount: number): bigint {
    return BigInt(Math.ceil(feeRateSatsPerVByte * estimatedVBytesForOutputCount(outputCount)))
  }

  // Shared by buildUnsignedRelease()/buildUnsignedRefund()/
  // buildUnsignedSplit() below — builds the unsigned spend PSBT against
  // the escrow's recorded funding UTXO. Does not sign anything; the
  // caller decides whether the arbiter pre-signs (disputed path) before
  // handing the result to clients. Takes an output-computing callback
  // rather than a fixed toAddress/value (RFC-021 D9, 2026-08-02) so
  // buildUnsignedSplit() can add two outputs against the same
  // fee-adjusted spendable value release/refund each add just one against
  // — the script itself (2-of-3, no per-output covenant) doesn't care how
  // many outputs a valid spend has.
  private async buildUnsignedSpend(
    escrow: MultisigEscrowInput,
    parties: MultisigParties,
    outputCount: number,
    computeOutputs: (spendableValue: bigint) => Array<{ address: string; value: bigint }>
  ): Promise<{ psbt: bitcoin.Psbt; feeSats: bigint }> {
    this.assertArbiterMatchesScript(escrow)
    const { p2ms, p2wsh, network } = this.buildScript(parties)

    if (!escrow.txLockId) {
      throw new EscrowError(`Escrow for trade ${escrow.tradeId} has no recorded funding txid (txLockId) — cannot spend before lockFunds() has confirmed one`)
    }
    const utxos = await this.fetchUtxos(p2wsh.address!)

    // Missão 10 — outpoint-exact selection whenever a vout has been
    // persisted (every escrow locked from this point on). Bitcoin
    // identifies a UTXO by txid:vout, not txid alone — a funding
    // transaction with more than one output paying this same address
    // would otherwise be ambiguous. Only escrows that locked funds
    // BEFORE this migration (txLockVout is null — disclosed, not
    // silent) fall back to the original txid-only match; every new lock
    // always has a vout, so this fallback can never mask a real
    // ambiguity going forward.
    let utxo: ExplorerUtxo | undefined
    if (escrow.txLockVout !== null && escrow.txLockVout !== undefined) {
      utxo = utxos.find((u) => u.txid === escrow.txLockId && u.vout === escrow.txLockVout)
      if (!utxo) {
        throw new EscrowError(`Funding outpoint ${escrow.txLockId}:${escrow.txLockVout} for ${p2wsh.address} not found by the explorer — it may already be spent`)
      }
    } else {
      utxo = utxos.find((u) => u.txid === escrow.txLockId)
      if (!utxo) {
        throw new EscrowError(`Funding UTXO ${escrow.txLockId} for ${p2wsh.address} not found by the explorer — it may already be spent`)
      }
    }

    // Real fee estimation (2026-08-02) — see fetchFeeRateSatsPerVByte()/
    // estimateFeeSats()'s own comments for the reasoning.
    const feeRateSatsPerVByte = await this.fetchFeeRateSatsPerVByte()
    const feeSats = this.estimateFeeSats(feeRateSatsPerVByte, outputCount)
    // Sails Core Implementation Program M8.6 — a deterministic ceiling on
    // the fee this transaction may ever imply, independent of whatever
    // the live fee-estimate endpoint returned. Closes the same class of
    // gap this file's own fee-estimate lookup has always disclosed
    // ("a wrong fee for a real Bitcoin spend either overpays or gets
    // stuck unconfirmed") one step further: an explorer response that is
    // wrong in the OTHER direction (implausibly high) must not silently
    // become an unbounded value-diversion vector. See
    // execution-cost-policy.ts's own header for the full reasoning.
    const feeCeiling = maxExecutionCostSats(outputCount, BigInt(utxo.value))
    if (feeSats > feeCeiling) {
      throw new EscrowError(
        `MULTISIG provider: estimated fee ${feeSats} sats (${feeRateSatsPerVByte} sat/vB) exceeds the deterministic ceiling ${feeCeiling} sats for a ${outputCount}-output spend — refusing to build a transaction with an implausible fee. Check MULTISIG_EXPLORER_API_URL and MULTISIG_MAX_FEE_RATE_SATS_PER_VBYTE.`
      )
    }
    const spendableValue = BigInt(utxo.value) - feeSats
    if (spendableValue <= 0n) {
      throw new EscrowError(`UTXO value ${utxo.value} sats too small to cover the estimated ${feeSats} sat fee (${feeRateSatsPerVByte} sat/vB)`)
    }

    // Missão 10, Fase 4 — validate EVERY output (address decodes for this
    // network, clears the real dust-relay threshold for its own script
    // type) BEFORE building the PSBT at all. Centralized here since this
    // is the one function release/refund/split all funnel through — no
    // per-caller duplication, and rejection happens before a pending
    // transaction exists, before any signature is requested, before
    // broadcast. See bitcoin-dust-policy.ts's own header for why this is
    // script-derived rather than a universal DUST=546 constant, and why
    // it deliberately does not use feeRateSatsPerVByte (dust-relay policy
    // is a separate, static parameter from this transaction's own miner
    // fee).
    const computedOutputs = computeOutputs(spendableValue)
    for (const output of computedOutputs) {
      validateOutput(output.address, output.value, network)
    }

    const psbt = new bitcoin.Psbt({ network })
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: p2wsh.output!, value: BigInt(utxo.value) },
      witnessScript: p2ms.output!,
    })
    for (const output of computedOutputs) {
      psbt.addOutput({ address: output.address, value: output.value })
    }
    return { psbt, feeSats }
  }

  // Real Phase 2 (2026-07-27) — see this file's header comment for the
  // full flow. Builds but does NOT fully sign a release PSBT: normal path
  // returns it fully unsigned with both buyer and seller as required
  // signers; disputed path pre-signs with the server-held arbiter key
  // (mirroring the old pre-Phase-1 signer selection — arbiter co-signs
  // with the buyer, favoring the RELEASE ruling) and returns only the
  // buyer as a required (real, client) signer.
  // Missão 11 Fase 4.1 — fee-aware release, simplified from Fase 4's own
  // first cut. Legacy escrows are byte-for-byte unchanged (single output,
  // buyer gets the full spendableValue). A policy-aware escrow now has
  // only TWO shapes, not three:
  //   fmax = 0  — no reserve was ever funded for this escrow, either a
  //               genuine zero-rate policy OR the pre-funding waiver
  //               decision (escrow-fee-snapshot.service.ts) already
  //               determined, before the seller ever funded anything,
  //               that the maximum possible fee would be uncollectible.
  //               Single output, byte-for-byte the legacy shape.
  //   fmax > 0  — ALWAYS collectible: the pre-funding decision already
  //               verified the full-T fee clears dust against this
  //               escrow's frozen destination before funding, and a plain
  //               release's basis is always that same full T — so F=Fmax
  //               here, unconditionally. Two outputs: buyer gets T-M,
  //               Sails gets the fixed F=Fmax, never a residual.
  // The old third shape ("Fmax funded but turned out sub-dust at
  // settlement, refund the standalone reserve to the seller") is no
  // longer reachable and has been removed — it was Fase 4's own real,
  // CTO-flagged gap (a nonzero Fmax with no dust-safe way to construct
  // either the Sails leg or the seller-refund leg), closed by moving the
  // collectibility check before funding instead of discovering it at
  // settlement time.
  async buildUnsignedRelease(escrow: MultisigEscrowInput, toAddress: string): Promise<{ psbtBase64: string; requiredSigners: string[]; feeCollection?: FeeCollectionResult | null; minerFeeSats: number }> {
    const parties = this.partiesFor(escrow)
    const policyAware = this.isPolicyAware(escrow)
    const fmax = this.maxFeeSats(escrow)

    const outputCount = policyAware && fmax > 0 ? 2 : 1
    const { psbt, feeSats } = await this.buildUnsignedSpend(escrow, parties, outputCount, (spendableValue) => {
      if (!policyAware || fmax === 0) {
        return [{ address: toAddress, value: spendableValue }]
      }
      const buyerPool = spendableValue - BigInt(fmax) // = T - M (Fmax = F always, here)
      return [
        { address: toAddress, value: buyerPool },
        { address: escrow.snapshotFeeCollectionAddress!, value: BigInt(fmax) },
      ]
    })

    const feeCollectionResult: FeeCollectionResult | null = policyAware ? { feeSats: fmax, waived: fmax === 0 } : null

    if (escrow.status === 'DISPUTED') {
      const arbiterKey = this.deriveArbiterKey(this.resolveArbiterSigningId(escrow)) // Fase 7.3.1 §B — see resolveArbiterSigningId()'s own comment
      psbt.signInput(0, arbiterKey as unknown as bitcoin.Signer)
      if (!escrow.buyerId) {
        throw new EscrowError(`MULTISIG provider: missing buyerId for disputed release of trade ${escrow.tradeId}`)
      }
      return { psbtBase64: psbt.toBase64(), requiredSigners: [escrow.buyerId], feeCollection: feeCollectionResult, minerFeeSats: Number(feeSats) }
    }

    if (!escrow.buyerId || !escrow.sellerId) {
      throw new EscrowError(`MULTISIG provider: missing buyerId/sellerId for release of trade ${escrow.tradeId}`)
    }
    return { psbtBase64: psbt.toBase64(), requiredSigners: [escrow.buyerId, escrow.sellerId], feeCollection: feeCollectionResult, minerFeeSats: Number(feeSats) }
  }

  // Missão 11 Fase 4 — the CONSERVATION property is deliberately
  // UNCHANGED and still holds regardless of destination: a refund is
  // Sails=0 always, and the seller's single existing output still
  // receives 100% of spendableValue — which, under exact-funding, still
  // equals (T+Fmax) - M in full. The reserve cannot disappear, cannot
  // become revenue, and cannot go to the buyer — nothing below touches
  // that arithmetic, only WHERE the one output pays.
  //
  // Sails Core Implementation Program M8-RF (Destination Consistency,
  // 2026-08-31) — CORRECTED. Prior to this mission, the refund
  // destination was derived HERE, internally, from the seller's own
  // CLIENT-SUBMITTED multisig pubkey's P2WPKH form — a stand-in written
  // (2026-07-27, before PayoutAddress/M8.5 existed) because "no per-user
  // BTC payout address exists in the schema yet" (this file's own
  // original comment, verified via `git log`/`git show` before removing
  // it — a disclosed placeholder, never a deliberate destination-
  // authority decision; RELEASE/SPLIT's own `toAddress` parameters were
  // never given the same placeholder, which is exactly the asymmetry
  // M9-R's crash-recovery work surfaced). Controlling the multisig
  // settlement key proves SIGNING CAPABILITY, never DESTINATION
  // AUTHORITY (`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` §3/§12's own
  // "settlement-key holder" attack result) — the two are independent
  // axes, and this Provider translates an already-authorized destination
  // exactly like `buildUnsignedRelease`/`buildUnsignedSplit` above
  // already do; it never gets to invent one itself. `authorizedDestination`
  // is REQUIRED (not merely accepted) for this provider — every real
  // caller (`escrow-pending-tx.ts`'s `initiateRefund()`) always resolves
  // one, from either the beneficiary's own registered PayoutAddress (the
  // live/cooperative path, mirroring `initiateRelease()`'s own identical
  // rule) or the historical Outcome's own committed DestinationBinding
  // snapshot (the Core-authoritative disputed path, `dispute.service.ts`'s
  // `applyRulingCoreAuthoritative()`) — never re-derived here.
  async buildUnsignedRefund(escrow: MultisigEscrowInput, authorizedDestination?: string): Promise<{ psbtBase64: string; requiredSigners: string[]; toAddress: string; minerFeeSats: number }> {
    if (!authorizedDestination) {
      throw new EscrowError(`MULTISIG provider: buildUnsignedRefund() requires an authorized destination for trade ${escrow.tradeId} — the Provider never invents one`)
    }
    const parties = this.partiesFor(escrow)
    const sellerRefundAddress = authorizedDestination

    const { psbt, feeSats } = await this.buildUnsignedSpend(escrow, parties, 1, (spendableValue) => [{ address: sellerRefundAddress, value: spendableValue }])

    if (escrow.status === 'DISPUTED') {
      const arbiterKey = this.deriveArbiterKey(this.resolveArbiterSigningId(escrow)) // Fase 7.3.1 §B — see resolveArbiterSigningId()'s own comment
      psbt.signInput(0, arbiterKey as unknown as bitcoin.Signer)
      if (!escrow.sellerId) {
        throw new EscrowError(`MULTISIG provider: missing sellerId for disputed refund of trade ${escrow.tradeId}`)
      }
      return { psbtBase64: psbt.toBase64(), requiredSigners: [escrow.sellerId], toAddress: sellerRefundAddress, minerFeeSats: Number(feeSats) }
    }

    if (!escrow.buyerId || !escrow.sellerId) {
      throw new EscrowError(`MULTISIG provider: missing buyerId/sellerId for refund of trade ${escrow.tradeId}`)
    }
    return { psbtBase64: psbt.toBase64(), requiredSigners: [escrow.sellerId, escrow.buyerId], toAddress: sellerRefundAddress, minerFeeSats: Number(feeSats) }
  }

  // RFC-021 D9 (2026-08-02) — real, unlike SAFE_GUARD_EVM/LIGHTNING_HODL's
  // own buildUnsignedSplit() overrides: this script is a plain 2-of-3
  // P2WSH multisig with no per-output covenant, so it validates a spend
  // with two outputs exactly as readily as one. Always the disputed
  // shape (SPLIT is only ever reached via VALID_TRANSITIONS.DISPUTED ->
  // 'SPLIT' — escrow.service.ts's assertTransition already enforces this
  // before calling here) — the arbiter pre-signs, and (real constraint
  // found writing tests/multisigProvider.test.ts, not a design choice)
  // only ONE more party can be a required signer, same as a disputed
  // release/refund: this is still a 2-of-3 script, and finalizeSpend()
  // combines independently-signed copies sequentially — collecting BOTH
  // buyer's and seller's copies on top of the arbiter's already-embedded
  // signature yields 3 valid signatures for a threshold of 2, which
  // bitcoinjs-lib correctly refuses to finalize ("Too many signatures").
  // Picking the buyer here, mirroring buildUnsignedRelease()'s own
  // arbiter+buyer disputed pairing above — arbitrary (the split amounts
  // are already fixed by the arbiter's ruling either way), but consistent.
  // Missão 11 Fase 4.1 — fee-aware split, updated for the pre-funding
  // waiver. Legacy escrows are byte-for-byte unchanged. A policy-aware
  // escrow: the arbiter's own buyerBps ruling is NEVER altered by fee
  // logic (Fase 3.3/3.4 §G's own hard rule) — the fee basis is the
  // seller's bps-portion of T only (never the buyer's share), and
  // buyerPool = spendableValue - Fmax is the SAME T-M quantity
  // buildUnsignedRelease() uses, preserving M's existing proportional-by-
  // bps treatment exactly (Fase 3.4 §3's decision to leave miner-fee
  // economics unchanged). The seller's own output always absorbs both
  // their net share AND the unused reserve (Fmax - F) in one output — the
  // "residual computation" from Fase 3.3 §7, verified to conserve exactly
  // in this mission's own equations.
  //
  // decideFeeCollection() below is only ever consulted when fmax > 0 —
  // i.e. when a reserve actually exists. A SETTLEMENT-TIME waiver (Fase
  // 4.1 §2, distinct from the PRE-FUNDING waiver maxFeeSats() already
  // applies) remains a real, valid outcome HERE, unlike in a plain
  // release: SPLIT's actual basis (the seller's own bps-portion of T) can
  // be smaller than the full-T basis the pre-funding decision evaluated
  // Fmax against, so a funded reserve can still turn out sub-dust for a
  // specific buyerBps ruling. 3 outputs when the fee is collectible, 2
  // when either kind of waiver applies (never fewer for the buyer/seller
  // legs regardless).
  async buildUnsignedSplit(escrow: MultisigEscrowInput, buyerAddress: string, sellerAddress: string, buyerBps: number): Promise<{ psbtBase64: string; requiredSigners: string[]; feeCollection?: FeeCollectionResult | null; minerFeeSats: number }> {
    const parties = this.partiesFor(escrow)
    const network = networkFor(config.multisig.network)
    const policyAware = this.isPolicyAware(escrow)
    const fmax = this.maxFeeSats(escrow)
    const tSats = this.expectedSats(escrow.lockedAmount)
    // Seller's bps-portion of T, in BTC-decimal, for the fee basis —
    // computed the same truncating way fee-obligation.service.ts's own
    // Decimal arithmetic does (floor, never round), so the two never
    // disagree on the basis itself. Missão 11 Fase 5 §16 hardening: exact
    // BigInt arithmetic, not JS Number multiplication — the prior
    // `Math.floor((tSats * (10000 - buyerBps)) / 10000)` could lose
    // precision once `tSats * (10000 - buyerBps)` exceeded
    // Number.MAX_SAFE_INTEGER (~9,007 BTC in a single trade), a real gap
    // Fase 4.2's adversarial audit found. The final result (always ≤ tSats)
    // is safely representable as a Number regardless; only the
    // intermediate product needed BigInt exactness.
    const sellerBasisSats = Number((BigInt(tSats) * BigInt(10000 - buyerBps)) / 10000n)
    const sellerBasisBtc = new Prisma.Decimal(sellerBasisSats).dividedBy(1e8)
    const feeDecision = policyAware && fmax > 0
      ? this.decideFeeCollection(escrow, sellerBasisBtc, network)
      : { feeSats: 0, waived: true, collectionAddress: null }
    const collectedFee = feeDecision.waived ? 0 : feeDecision.feeSats
    const outputCount = policyAware && fmax > 0 ? (feeDecision.waived ? 2 : 3) : 2

    const { psbt, feeSats } = await this.buildUnsignedSpend(escrow, parties, outputCount, (spendableValue) => {
      const buyerPool = policyAware ? spendableValue - BigInt(fmax) : spendableValue
      const buyerValue = (buyerPool * BigInt(buyerBps)) / 10000n
      const sellerBase = buyerPool - buyerValue
      if (!policyAware || fmax === 0) {
        return [
          { address: buyerAddress, value: buyerValue },
          { address: sellerAddress, value: sellerBase },
        ]
      }
      const sellerFinal = sellerBase + BigInt(fmax) - BigInt(collectedFee)
      const outputs = [
        { address: buyerAddress, value: buyerValue },
        { address: sellerAddress, value: sellerFinal },
      ]
      if (!feeDecision.waived) {
        outputs.push({ address: feeDecision.collectionAddress!, value: BigInt(collectedFee) })
      }
      return outputs
    })

    const feeCollectionResult: FeeCollectionResult | null = policyAware ? { feeSats: collectedFee, waived: feeDecision.waived } : null

    const arbiterKey = this.deriveArbiterKey(this.resolveArbiterSigningId(escrow)) // Fase 7.3.1 §B — see resolveArbiterSigningId()'s own comment
    psbt.signInput(0, arbiterKey as unknown as bitcoin.Signer)
    if (!escrow.buyerId) {
      throw new EscrowError(`MULTISIG provider: missing buyerId for disputed split of trade ${escrow.tradeId}`)
    }
    return { psbtBase64: psbt.toBase64(), requiredSigners: [escrow.buyerId], feeCollection: feeCollectionResult, minerFeeSats: Number(feeSats) }
  }

  // Shared finalize: combines the unsigned PSBT with every independently-
  // signed copy submitted by the required signers (verified experimentally
  // — see this file's header comment — that Psbt.combine() correctly
  // merges independent copies of the SAME unsigned PSBT) and broadcasts.
  // On the disputed path, unsignedPsbtBase64 already carries the arbiter's
  // partial signature (embedded by buildUnsignedRelease/Refund above), so
  // combining it with the single client-submitted copy still yields both
  // required signatures.
  // Missão 11 Fase 9.6 — CONC-03 crash recovery split this into a pure,
  // deterministic half (this method — combine + finalize, no network
  // call) and finalizeSpend()'s own broadcast() call below, so
  // reconcilePendingSettlement() can recompute the EXACT SAME transaction
  // a crashed finalize attempt would have produced — same combine/
  // finalizeAllInputs/extractTransaction logic, zero duplication of the
  // signature-combining logic itself (the ECON-04 lesson: two independent
  // implementations of the same thing is exactly how basis-divergence
  // bugs happen, even when they turn out harmless on inspection — here
  // there is only ever one). Never re-derives or re-requests a signature;
  // only recombines what real signers already submitted and persisted.
  private buildFinalizedTransaction(tradeId: string, unsignedPsbtBase64: string, signedPsbtBase64List: string[]): bitcoin.Transaction {
    const network = networkFor(config.multisig.network)
    try {
      const merged = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network })
      for (const signed of signedPsbtBase64List) {
        merged.combine(bitcoin.Psbt.fromBase64(signed, { network }))
      }
      merged.finalizeAllInputs()
      return merged.extractTransaction()
    } catch (err) {
      throw new EscrowError(
        `MULTISIG provider: failed to combine/finalize signatures for trade ${tradeId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async finalizeSpend(escrow: MultisigEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[]): Promise<{ txId: string; rawTxHex: string }> {
    const tx = this.buildFinalizedTransaction(escrow.tradeId, unsignedPsbtBase64, signedPsbtBase64List)
    const rawTxHex = tx.toHex()
    // Sails Core Implementation Program M9-R (R6, provider txid
    // integrity) — a Bitcoin txid is the hash of the exact bytes that
    // were broadcast; Sails itself constructed `tx` and computed its id
    // BEFORE ever calling the provider, so that id is what gets
    // persisted, unconditionally. The explorer's own POST /tx response
    // body is never treated as the source of truth for what was
    // broadcast — a provider must not be able to make Sails persist a
    // different id than the one Sails itself derived from the
    // transaction it constructed and sent. A disagreement is logged as a
    // loud diagnostic (it would indicate something is wrong with the
    // explorer integration itself) but never allowed to override the
    // locally-derived value.
    const locallyDerivedTxId = tx.getId()
    const providerReturnedTxId = await this.broadcast(rawTxHex)
    if (providerReturnedTxId !== locallyDerivedTxId) {
      log.error({
        msg: 'MULTISIG provider: broadcast response txid disagrees with the locally-derived txid of the exact transaction that was sent — ignoring the provider-reported value, persisting the locally-derived one',
        locallyDerivedTxId, providerReturnedTxId,
      })
    }
    // Sails Core Implementation Program M8.6 — additive: the raw,
    // finalized transaction hex is what dispute-correspondence.ts needs
    // to independently decode real delivered outputs for the live
    // correspondence check. Never returned before this mission because
    // nothing needed it; every existing caller destructuring only
    // `{ txId }` is unaffected (structural typing).
    return { txId: locallyDerivedTxId, rawTxHex }
  }

  // Missão 11 Fase 9.6 — CONC-03 crash recovery. Called ONLY by
  // escrow-settlement-reconciliation.service.ts, ONLY for an escrow whose
  // status is already claiming a terminal outcome (COMPLETED/REFUNDED/
  // SPLIT) but whose txReleaseId never got persisted — i.e., a process
  // died somewhere between claimEscrowTransition() and
  // updateSignatureCollectionResult() in escrow-pending-tx.ts's
  // submitTransactionSignature(). That crash could have landed before OR
  // after the real broadcast succeeded (Estado A vs. Estado B — CTO's own
  // "Regra Zero" framing); this method never guesses which. It always
  // asks the chain first.
  //
  // Step 1: deterministically reconstruct the exact transaction the
  // crashed attempt would have produced (buildFinalizedTransaction()
  // above — same unsignedPsbtBase64 + same persisted signatures already
  // durably stored in EscrowPendingTransaction/EscrowTransactionSignature,
  // so this is not a guess, it is the one and only real spend this
  // escrow's already-collected signatures could ever produce).
  // Step 2: ask the network whether a transaction with that EXACT txid
  // already exists (mempool or confirmed) — fetchTransactionExistence().
  // If yes: Estado B. Funds already moved. Converge local state to that
  // observed truth WITHOUT broadcasting anything — a second broadcast of
  // an already-known txid is a harmless no-op to a Bitcoin node, but this
  // method never relies on that; it simply never calls broadcast() at
  // all in this branch, so there is structurally no second broadcast
  // attempt to reason about.
  // Step 3: if not found, check whether the funding outpoint is still
  // unspent (the same fetchUtxos() lockFunds()/buildUnsignedSpend()
  // already use). If still unspent: Estado A. The real broadcast never
  // happened — safe to issue it now, for the first and only time, of the
  // one transaction this escrow's signatures could ever produce.
  // Step 4: if not found AND the outpoint is no longer unspent, something
  // spent it that isn't the transaction these signatures produce — this
  // script only has three keys and only this escrow's own already-
  // collected signatures exist, so this should be structurally
  // impossible; if it ever happens, it is a genuine anomaly, not a case
  // to guess through. Fails closed, no funds moved by this method, full
  // diagnostic evidence returned for manual review — per the CTO's own
  // "fail closed + explicit manual recovery is preferable to unsafe
  // replay" instruction.
  //
  // Grants no new authority: never calls a signing key, never accepts a
  // caller-supplied txid, never trusts anything but (a) signatures the
  // real required signers already submitted and the DB already durably
  // recorded, and (b) what the Bitcoin network itself reports.
  async reconcilePendingSettlement(
    escrow: MultisigEscrowInput,
    unsignedPsbtBase64: string,
    signedPsbtBase64List: string[],
    beforeFirstBroadcast?: () => Promise<void>
  ): Promise<
    | { outcome: 'ALREADY_BROADCAST'; txId: string; rawTxHex: string; detail: string }
    | { outcome: 'NEWLY_BROADCAST'; txId: string; rawTxHex: string; detail: string }
    | { outcome: 'ANOMALY'; detail: string }
  > {
    const tx = this.buildFinalizedTransaction(escrow.tradeId, unsignedPsbtBase64, signedPsbtBase64List)
    const expectedTxId = tx.getId()
    // Sails Core Implementation Program M9 (Recovery) — additive, same
    // precedent as finalizeSpend()'s own M8.6 change: the recovery path
    // needs the real, exactly-reconstructed transaction bytes to
    // (re)evaluate M6 correspondence, exactly like the happy path
    // already does. Computed once here since `tx` already exists.
    const rawTxHex = tx.toHex()

    const existence = await fetchTransactionExistence(expectedTxId)
    if (existence.exists) {
      return {
        outcome: 'ALREADY_BROADCAST', txId: expectedTxId, rawTxHex,
        detail: `Transaction ${expectedTxId} is already known to the network (confirmed=${existence.confirmed}) — converging local state to this observed truth, no new broadcast.`,
      }
    }

    if (!escrow.txLockId) {
      return { outcome: 'ANOMALY', detail: `Escrow for trade ${escrow.tradeId} has no recorded funding txLockId — cannot determine outpoint status.` }
    }

    const parties = this.partiesFor(escrow)
    const { p2wsh } = this.buildScript(parties)
    if (!p2wsh.address) {
      return { outcome: 'ANOMALY', detail: `Failed to re-derive the P2WSH address for trade ${escrow.tradeId} during reconciliation.` }
    }
    const utxos = await this.fetchUtxos(p2wsh.address)
    const stillUnspent = escrow.txLockVout !== null && escrow.txLockVout !== undefined
      ? utxos.some((u) => u.txid === escrow.txLockId && u.vout === escrow.txLockVout)
      : utxos.some((u) => u.txid === escrow.txLockId)

    if (stillUnspent) {
      // Recovery is about to create the external effect rather than merely
      // converge to one already observed on-chain. Give the caller one last
      // fail-closed commit gate immediately before the first broadcast.
      // ALREADY_BROADCAST never reaches this callback, preserving recovery
      // of external truth after later authority changes.
      if (beforeFirstBroadcast) await beforeFirstBroadcast()

      // Sails Core Implementation Program M9-R (R6, provider txid
      // integrity) — same discipline as finalizeSpend(): `expectedTxId`
      // was already independently derived from `tx` before this
      // broadcast; the provider's own response text is never persisted
      // as the txid, only compared against it as a diagnostic.
      const providerReturnedTxId = await this.broadcast(tx.toHex())
      if (providerReturnedTxId !== expectedTxId) {
        log.error({
          msg: 'MULTISIG provider: reconciliation broadcast response txid disagrees with the locally-derived txid of the exact transaction that was sent — ignoring the provider-reported value, persisting the locally-derived one',
          escrowId: escrow.tradeId, expectedTxId, providerReturnedTxId,
        })
      }
      return {
        outcome: 'NEWLY_BROADCAST', txId: expectedTxId, rawTxHex,
        detail: `Funding outpoint ${escrow.txLockId}:${escrow.txLockVout ?? '(no vout)'} was still unspent — broadcast the deterministically-reconstructed transaction for the first time.`,
      }
    }

    return {
      outcome: 'ANOMALY',
      detail: `Funding outpoint ${escrow.txLockId}:${escrow.txLockVout ?? '(no vout)'} is no longer unspent, but no transaction matching the expected reconstructed txid ${expectedTxId} was found on the network — an unexpected spend. Manual review required; no funds moved by this reconciliation attempt.`,
    }
  }

  async finalizeRelease(escrow: MultisigEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[]): Promise<{ txId: string; rawTxHex: string }> {
    return this.finalizeSpend(escrow, unsignedPsbtBase64, signedPsbtBase64List)
  }

  async finalizeRefund(escrow: MultisigEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[]): Promise<{ txId: string; rawTxHex: string }> {
    return this.finalizeSpend(escrow, unsignedPsbtBase64, signedPsbtBase64List)
  }

  async finalizeSplit(escrow: MultisigEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[]): Promise<{ txId: string; rawTxHex: string }> {
    return this.finalizeSpend(escrow, unsignedPsbtBase64, signedPsbtBase64List)
  }

  // Not directly callable — the SettlementProvider interface still
  // requires these methods, but buyer/seller keys are client-held, so a
  // real release needs the multi-step flow above instead of a single
  // synchronous call. Kept as loud, explanatory throws (not silently
  // wrong) rather than removed, since escrow.service.ts's own
  // releaseFunds()/refundFunds() (the MOCK/WDK_USDT_EVM path) still calls
  // through this same interface for every SettlementProvider.
  async releaseFunds(_escrow: MultisigEscrowInput, _toAddress: string): Promise<{ txId: string }> {
    throw new EscrowError(
      'MULTISIG provider: releaseFunds() is not directly callable — buyer/seller keys are client-held. ' +
      'Use POST /v1/settlement/escrow/:id/initiate-release, then submit-transaction-signature, instead (see escrow.service.ts).'
    )
  }

  async refundFunds(_escrow: MultisigEscrowInput): Promise<{ txId: string }> {
    throw new EscrowError(
      'MULTISIG provider: refundFunds() is not directly callable — buyer/seller keys are client-held. ' +
      'Use POST /v1/settlement/escrow/:id/initiate-refund, then submit-transaction-signature, instead (see escrow.service.ts).'
    )
  }
}

export const multisigProvider = new MultisigProvider()
