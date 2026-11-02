/**
 * Sails OpenSettlement — LIGHTNING_HODL SettlementProvider, real via Arkade
 *
 * Replaces the previous throw-only stub (`EscrowError('Lightning HODL
 * escrow not yet implemented')`). Real Lightning (plain HTLCs) has no
 * genuine multi-party escrow primitive — confirmed directly from HodlHodl's
 * own docs: their Lightning mode is plain custodial holding on their own
 * LND node, not cryptographic escrow ("currently there are no multisig
 * escrow addresses on the Lightning Network"). Arkade (Ark protocol) is
 * different: a real, live Bitcoin L2 (VTXOs, Taproot-script-based) that
 * BOTH HodlHodl and Lendasat use today to build genuine multi-party escrow
 * on top of — same production precedent this file follows.
 *
 * Verified experimentally before writing this file, against the real
 * `@arkade-os/sdk` package and Ark Labs' own public mutinynet ASP
 * (`https://mutinynet.arkade.sh`, confirmed reachable — real `getInfo()`
 * response, real signer pubkey): deterministic key derivation via
 * `SeedIdentity`, 3-leaf `VtxoScript` construction (buyer+seller,
 * buyer+arbiter, seller+arbiter `MultisigTapscript` pairs, plus a
 * `CSVMultisigTapscript` unilateral-exit leaf), and a real Arkade address
 * produced from a live server pubkey — all confirmed working, not assumed.
 *
 * Custody model — updated 2026-07-27 (client-held keys pass, same change
 * `multisig.provider.ts` got): the buyer and seller each generate their
 * own key CLIENT-SIDE (`@satsails/p2p-trading-sdk`'s escrow-key module) and submit only
 * the public key (`POST /v1/settlement/escrow/:id/submit-key`, persisted
 * as `EscrowParticipantKey`) — this provider never sees, derives, or
 * holds either of their private keys. Only the arbiter key is still
 * server-derived. The submitted pubkey is the same 33-byte compressed
 * secp256k1 format `MultisigProvider` uses (one client key genuinely
 * serves both providers — verified experimentally that
 * `compressed[1:] === x-only`, same normalization `getServerPubKey()`
 * below already does for the ASP's own pubkey); this file strips the
 * leading byte to get the 32-byte x-only form `MultisigTapscript` wants.
 *
 * Consequence, now resolved (Phase 2, 2026-07-27 — same day as
 * MULTISIG's own Phase 2): `releaseFunds()`/`refundFunds()` used to
 * co-sign with 2 of 3 keys server-side in one call — no longer possible
 * now that buyer/seller keys are client-held. Both `SettlementProvider`
 * methods still throw below (not directly callable), but the REAL
 * release/refund path now exists: `buildUnsignedRelease()`/
 * `buildUnsignedRefund()` build (but do not fully sign) the Ark tx +
 * checkpoint(s) via the same `buildOffchainTx()` this file always used;
 * each required party independently signs their own copy client-side
 * (`@satsails/p2p-trading-sdk`'s `signEscrowArkTx()`, using `@arkade-os/sdk`'s
 * `SingleKey` — a raw-private-key signer, verified experimentally to
 * need nothing but the same private key `generateEscrowKeypair()`
 * already produces for MULTISIG, no ASP/wallet machinery, and to bundle
 * cleanly for a browser target with zero Node-core imports); once every
 * required signature has arrived, `finalizeRelease()`/`finalizeRefund()`
 * combine (`combineTapscriptSigs`), verify (`verifyTapscriptSignatures`),
 * and submit for real (`RestArkProvider.submitTx`+`finalizeTx`).
 *
 * Wire format: the unsigned/signed "PSBT" string this provider hands
 * back and forth is a JSON bundle
 * (`{ arkTxPsbtBase64, checkpointsPsbtBase64[], expectedPubkeys[] }`),
 * not a bare PSBT — Ark's offchain tx needs the main tx AND one
 * checkpoint tx per input signed/combined together, unlike a single
 * Bitcoin PSBT. Verified experimentally that `@scure/btc-signer`'s
 * `Transaction` (what `buildOffchainTx()` actually returns) round-trips
 * through `.toPSBT()`/`Transaction.fromPSBT()` with everything
 * `SingleKey.sign()` needs intact — the same PSBT wire format
 * `multisig.provider.ts` uses, just serialized per-tx and bundled as
 * JSON here since there's more than one tx per signing round. On a
 * `DISPUTED` release/refund, the arbiter's own required signature is
 * pre-embedded into the bundle at build time (its key is still
 * server-derived, unchanged from Phase 1) — only the other required
 * party is a real pending client submission in that case.
 *
 * Testnet (mutinynet) only. ARKADE_SEED empty by default — same
 * "surface a clear config error, don't refuse to boot" pattern as
 * WDK_SEED_PHRASE/MULTISIG_SEED.
 */
import {
  SeedIdentity,
  MultisigTapscript,
  CSVMultisigTapscript,
  VtxoScript,
  RestArkProvider,
  RestIndexerProvider,
  buildOffchainTx,
  combineTapscriptSigs,
  verifyTapscriptSignatures,
  type ArkTxInput,
} from '@arkade-os/sdk'
import { Transaction } from '@scure/btc-signer'
import { createHash } from 'crypto'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import type { SettlementProvider } from './escrow.service'
import { ensureFinalizationAttempt, recordFinalizationOutcome } from './signature-collection-finalization-truth'

type ArkParties = { buyerPubkey: Uint8Array; sellerPubkey: Uint8Array; arbiterId: string }

export type ArkEscrowInput = {
  // Issue #240 - optional/additive: the real Escrow row escrow-pending-tx.ts's submitTransactionSignature()
  // passes always carries it; only this type's own declaration was narrower. Needed to bind this
  // provider's durable finalization-attempt evidence (signature-collection-finalization-truth.ts) to
  // the exact escrow.
  id?: string
  tradeId: string
  lockedAmount: string
  buyerPubkey?: string   // hex, 33-byte compressed — from EscrowParticipantKey
  sellerPubkey?: string  // hex, 33-byte compressed — from EscrowParticipantKey
  // Trade's own party ids — needed by buildUnsignedRelease()/
  // buildUnsignedRefund() below to know WHICH participant id each
  // required client signature must come from. See multisig.provider.ts's
  // identical MultisigEscrowInput fields for the same reasoning.
  buyerId?: string
  sellerId?: string
  txLockId?: string | null
  status?: string
  triggeredBy?: string
}

// The JSON bundle this provider's unsigned/signed "PSBT" strings actually
// contain — see this file's header comment for why (an Ark offchain tx
// needs its main tx AND a per-input checkpoint tx signed/combined
// together, unlike a single Bitcoin PSBT).
type ArkPendingBundle = {
  arkTxPsbtBase64: string
  checkpointsPsbtBase64: string[]
  // Only meaningful on the UNSIGNED bundle (the server-authoritative one
  // stored in EscrowPendingTransaction.unsignedPsbtBase64) — signed
  // submissions don't need to carry this, finalizeArk() only ever reads
  // it off the unsigned bundle.
  expectedPubkeys?: string[]
}

// Kept for the arbiter role only now — buyer/seller salts are unused
// (their keys are client-submitted, not derived). Exported for direct
// unit testing, same reason it always was.
export function seedFor(role: 'buyer' | 'seller' | 'arbiter', id: string): Uint8Array {
  return createHash('sha512').update(`arkade:${role}:${id}`).digest()
}

// 33-byte compressed -> 32-byte x-only — same point, different
// serialization (verified experimentally: compressed[1:] === schnorr
// x-only pubkey for the same private key). Shared by parsePubkey() below
// and getServerPubKey()'s identical normalization of the ASP's own key.
function toXOnly(compressed: Buffer): Buffer {
  return compressed.length === 33 ? compressed.subarray(1) : compressed
}

export class LightningHodlProvider implements SettlementProvider {
  name = 'LIGHTNING_HODL'
  readonly custodyModel = 'client-held-buyer-seller-keys-server-held-arbiter' as const

  private ark: RestArkProvider | null = null
  private indexer: RestIndexerProvider | null = null
  private cachedServerPubKey: Uint8Array | null = null

  private requireSeed(): string {
    if (!config.arkade.seed) {
      throw new EscrowError(
        'LIGHTNING_HODL (Arkade) provider requires ARKADE_SEED configured (.env.example) — refusing to derive the arbiter key from an empty seed'
      )
    }
    return config.arkade.seed
  }

  private defaultArbiterId(): string {
    const arbiter = config.settlement.trustedArbitrators[0]
    if (!arbiter) {
      throw new EscrowError(
        'LIGHTNING_HODL (Arkade) provider requires at least one TRUSTED_ARBITRATORS entry configured (.env.example) — no arbiter key to derive for the 2-of-3 script'
      )
    }
    return arbiter
  }

  private getArkProvider(): RestArkProvider {
    if (!this.ark) this.ark = new RestArkProvider(config.arkade.asp)
    return this.ark
  }

  private getIndexer(): RestIndexerProvider {
    if (!this.indexer) this.indexer = new RestIndexerProvider(config.arkade.asp)
    return this.indexer
  }

  private async getServerPubKey(): Promise<Uint8Array> {
    if (this.cachedServerPubKey) return this.cachedServerPubKey
    const info = await this.getArkProvider().getInfo()
    this.cachedServerPubKey = toXOnly(Buffer.from(info.signerPubkey, 'hex'))
    return this.cachedServerPubKey
  }

  // Arbiter is the only role this provider still derives itself — buyer
  // and seller keys are client-submitted (see partiesFor()).
  private deriveArbiterKey(id: string): SeedIdentity {
    this.requireSeed()
    const material = createHash('sha512').update(config.arkade.seed).update(seedFor('arbiter', id)).digest()
    return SeedIdentity.fromSeed(material, { isMainnet: false })
  }

  private parsePubkey(hex: string | undefined, role: 'buyer' | 'seller', tradeId: string): Buffer {
    if (!hex) {
      throw new EscrowError(
        `LIGHTNING_HODL (Arkade) provider requires a submitted ${role} pubkey for trade ${tradeId} — call POST /v1/settlement/escrow/:id/submit-key first (see EscrowParticipantKey)`
      )
    }
    const buf = Buffer.from(hex, 'hex')
    if (buf.length !== 33) {
      throw new EscrowError(`LIGHTNING_HODL (Arkade) provider: ${role} pubkey for trade ${tradeId} must be a 33-byte compressed secp256k1 key, got ${buf.length} bytes`)
    }
    return buf
  }

  private partiesFor(escrow: ArkEscrowInput): ArkParties {
    return {
      buyerPubkey: toXOnly(this.parsePubkey(escrow.buyerPubkey, 'buyer', escrow.tradeId)),
      sellerPubkey: toXOnly(this.parsePubkey(escrow.sellerPubkey, 'seller', escrow.tradeId)),
      arbiterId: this.defaultArbiterId(),
    }
  }

  // Same single-arbiter limitation as multisig.provider.ts's
  // assertArbiterMatchesScript() — the script's arbiter key is fixed at
  // creation time and cannot depend on whichever arbiter
  // TrustedArbitratorProvider's round-robin later assigns to an actual
  // dispute.
  private assertArbiterMatchesScript(escrow: ArkEscrowInput) {
    if (escrow.status !== 'DISPUTED') return
    const scriptArbiter = this.defaultArbiterId()
    if (escrow.triggeredBy && escrow.triggeredBy !== scriptArbiter) {
      throw new EscrowError(
        `LIGHTNING_HODL (Arkade) provider: dispute arbiter '${escrow.triggeredBy}' does not match the arbiter key ('${scriptArbiter}') baked into this escrow's script at creation time. ` +
        'This reference implementation only supports a single-arbiter TRUSTED_ARBITRATORS configuration.'
      )
    }
  }

  // See this file's header comment on the JSON bundle wire format.
  private serializeBundle(arkTx: Transaction, checkpoints: Transaction[], expectedPubkeys?: string[]): string {
    const bundle: ArkPendingBundle = {
      arkTxPsbtBase64: Buffer.from(arkTx.toPSBT()).toString('base64'),
      checkpointsPsbtBase64: checkpoints.map((cp) => Buffer.from(cp.toPSBT()).toString('base64')),
      ...(expectedPubkeys ? { expectedPubkeys } : {}),
    }
    return JSON.stringify(bundle)
  }

  private deserializeBundle(json: string): { arkTx: Transaction; checkpoints: Transaction[]; expectedPubkeys?: string[] } {
    const parsed = JSON.parse(json) as ArkPendingBundle
    return {
      arkTx: Transaction.fromPSBT(Buffer.from(parsed.arkTxPsbtBase64, 'base64')),
      checkpoints: parsed.checkpointsPsbtBase64.map((b) => Transaction.fromPSBT(Buffer.from(b, 'base64'))),
      expectedPubkeys: parsed.expectedPubkeys,
    }
  }

  private async buildScript(parties: ArkParties) {
    const arbiterIdentity = this.deriveArbiterKey(parties.arbiterId)
    const arbiterPk = await arbiterIdentity.xOnlyPublicKey()
    const buyerPk = parties.buyerPubkey
    const sellerPk = parties.sellerPubkey

    // OR-of-AND-pairs — same technique multisig.provider.ts uses for real
    // Bitcoin P2WSH, here building a real Ark Taproot VtxoScript instead.
    const buyerSeller = MultisigTapscript.encode({ pubkeys: [buyerPk, sellerPk] })
    const buyerArbiter = MultisigTapscript.encode({ pubkeys: [buyerPk, arbiterPk] })
    const sellerArbiter = MultisigTapscript.encode({ pubkeys: [sellerPk, arbiterPk] })
    // Unilateral buyer exit after ~24h of blocks (144 blocks/day) — so the
    // buyer can always recover funds even with zero cooperation, per
    // VtxoScript.exitPaths()'s documented convention. Confirmed
    // experimentally that this leaf is picked up by exitPaths().
    const buyerExit = CSVMultisigTapscript.encode({ timelock: { type: 'blocks', value: 144n }, pubkeys: [buyerPk] })

    const vtxoScript = new VtxoScript([buyerSeller.script, buyerArbiter.script, sellerArbiter.script, buyerExit.script])
    const serverPubKey = await this.getServerPubKey()
    const address = vtxoScript.address(undefined, serverPubKey)

    return { vtxoScript, address, arbiterIdentity, buyerSeller, buyerArbiter, sellerArbiter, buyerExit }
  }

  // Not part of SettlementProvider — called by escrow.service.ts's
  // submitParticipantKey() once BOTH buyer and seller pubkeys have been
  // submitted, to populate Escrow.multisigAddr. Same role as
  // MultisigProvider.getDepositAddress() — takes raw submitted hex
  // directly for the same reason that one does.
  async getDepositAddress(tradeId: string, buyerPubkeyHex: string, sellerPubkeyHex: string): Promise<{ address: string }> {
    const parties: ArkParties = {
      buyerPubkey: toXOnly(this.parsePubkey(buyerPubkeyHex, 'buyer', tradeId)),
      sellerPubkey: toXOnly(this.parsePubkey(sellerPubkeyHex, 'seller', tradeId)),
      arbiterId: this.defaultArbiterId(),
    }
    const { address } = await this.buildScript(parties)
    // Missão 11 Fase 5.2 — return shape widened to match
    // NON_CUSTODIAL_PROVIDERS' shared interface (escrow-providers.ts's own
    // comment). This provider's arbiter commitment is NOT persisted here —
    // out of this phase's explicit MULTISIG-only scope, disclosed as an
    // analogous gap in this mission's report, not fixed.
    return { address: address.encode() }
  }

  private expectedSats(lockedAmount: string): number {
    return Math.round(parseFloat(lockedAmount) * 1e8)
  }

  async lockFunds(escrow: ArkEscrowInput): Promise<{ txId: string; address: string }> {
    const parties = this.partiesFor(escrow)
    const { vtxoScript, address } = await this.buildScript(parties)
    const expected = this.expectedSats(escrow.lockedAmount)

    const scriptHex = Buffer.from(vtxoScript.pkScript).toString('hex')
    const { vtxos } = await this.getIndexer().getVtxos({ scripts: [scriptHex], spendableOnly: true })
    const funding = vtxos.find((v) => v.value >= expected)
    if (!funding) {
      throw new EscrowError(
        `No spendable VTXO of at least ${expected} sats found at ${address.encode()} yet. This is a non-custodial provider — ` +
        `it verifies external funding, it does not move funds itself. Send the trade's collateral to ${address.encode()} first, then retry lockFunds.`
      )
    }
    return { txId: funding.txid, address: address.encode() }
  }

  // Shared by buildUnsignedRelease()/buildUnsignedRefund() below — fetches
  // the escrow's recorded funding VTXO and builds (does not sign) the Ark
  // offchain tx spending it to toScript via the given leaf.
  private async buildUnsignedSpend(
    escrow: ArkEscrowInput,
    parties: ArkParties,
    leaf: { script: Uint8Array },
    toScriptHex: string
  ): Promise<{ arkTx: Transaction; checkpoints: Transaction[] }> {
    this.assertArbiterMatchesScript(escrow)
    const { vtxoScript, buyerExit } = await this.buildScript(parties)

    if (!escrow.txLockId) {
      throw new EscrowError(`Escrow for trade ${escrow.tradeId} has no recorded funding txid (txLockId) — cannot spend before lockFunds() has confirmed one`)
    }
    const scriptHex = Buffer.from(vtxoScript.pkScript).toString('hex')
    const { vtxos } = await this.getIndexer().getVtxos({ scripts: [scriptHex], spendableOnly: true })
    const vtxo = vtxos.find((v) => v.txid === escrow.txLockId)
    if (!vtxo) {
      throw new EscrowError(`Funding VTXO ${escrow.txLockId} for this escrow's Arkade script not found by the indexer — it may already be spent`)
    }

    const tapLeafScript = vtxoScript.findLeaf(Buffer.from(leaf.script).toString('hex'))
    const input: ArkTxInput = {
      tapLeafScript,
      tapTree: vtxoScript.encode(),
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
    }
    const toScript = Buffer.from(toScriptHex, 'hex')
    return buildOffchainTx([input], [{ script: toScript, amount: BigInt(vtxo.value) }], buyerExit)
  }

  // Real Phase 2 (2026-07-27) — see this file's header comment for the
  // full flow. Normal path returns the tx bundle fully unsigned with both
  // buyer and seller as required signers; disputed path pre-signs with
  // the server-held arbiter key (mirroring the old pre-Phase-1 signer
  // selection — arbiter co-signs with the buyer, favoring RELEASE) and
  // returns only the buyer as a required (real, client) signer.
  //
  // Missão 11 Fase 4 — rail-parity audit: fee-aware output construction
  // (the seller-funded reserve, Sails collection output, waived-fee
  // handling) is implemented for MULTISIG only this phase — see
  // multisig.provider.ts's own buildUnsignedRelease()/buildUnsignedSplit().
  // This provider's economic SEMANTICS remain identical (the same
  // recordObligationForEscrowSettlement() call in escrow-pending-tx.ts
  // still fires for any LIGHTNING_HODL escrow), but this method's actual
  // transaction construction is deliberately UNCHANGED — a policy-aware
  // LIGHTNING_HODL escrow would need the same lockFunds() exact-funding
  // treatment and output-construction extension MULTISIG
  // received, not yet built. Disclosed here rather than silently
  // assumed identical.
  async buildUnsignedRelease(escrow: ArkEscrowInput, toAddress: string): Promise<{ psbtBase64: string; requiredSigners: string[] }> {
    const parties = this.partiesFor(escrow)
    const { buyerSeller, buyerArbiter } = await this.buildScript(parties)
    const leaf = escrow.status === 'DISPUTED' ? buyerArbiter : buyerSeller
    const { arkTx, checkpoints } = await this.buildUnsignedSpend(escrow, parties, leaf, toAddress)

    if (escrow.status === 'DISPUTED') {
      const arbiterIdentity = this.deriveArbiterKey(parties.arbiterId)
      const arbiterPk = await arbiterIdentity.xOnlyPublicKey()
      const signedArkTx = await arbiterIdentity.sign(arkTx, [0])
      const signedCheckpoints = await Promise.all(checkpoints.map((cp) => arbiterIdentity.sign(cp, [0])))
      if (!escrow.buyerId) {
        throw new EscrowError(`LIGHTNING_HODL (Arkade) provider: missing buyerId for disputed release of trade ${escrow.tradeId}`)
      }
      const expectedPubkeys = [Buffer.from(parties.buyerPubkey).toString('hex'), Buffer.from(arbiterPk).toString('hex')]
      return { psbtBase64: this.serializeBundle(signedArkTx, signedCheckpoints, expectedPubkeys), requiredSigners: [escrow.buyerId] }
    }

    if (!escrow.buyerId || !escrow.sellerId) {
      throw new EscrowError(`LIGHTNING_HODL (Arkade) provider: missing buyerId/sellerId for release of trade ${escrow.tradeId}`)
    }
    const expectedPubkeys = [Buffer.from(parties.buyerPubkey).toString('hex'), Buffer.from(parties.sellerPubkey).toString('hex')]
    return { psbtBase64: this.serializeBundle(arkTx, checkpoints, expectedPubkeys), requiredSigners: [escrow.buyerId, escrow.sellerId] }
  }

  // Mirror of buildUnsignedRelease() above, for refund-to-seller. Refund
  // address = a real single-key Ark address built from the seller's own
  // CLIENT-SUBMITTED pubkey — same reference stand-in
  // multisig.provider.ts's buildUnsignedRefund() uses for its own P2WPKH
  // equivalent, and only needs the seller's PUBLIC key (VtxoScript.address()
  // takes a pubkey, not a private key), so it stays derivable even though
  // this provider never holds the seller's private key.
  async buildUnsignedRefund(escrow: ArkEscrowInput): Promise<{ psbtBase64: string; requiredSigners: string[]; toAddress: string }> {
    const parties = this.partiesFor(escrow)
    const { buyerSeller, sellerArbiter } = await this.buildScript(parties)
    const serverPubKey = await this.getServerPubKey()
    const sellerScript = new VtxoScript([
      CSVMultisigTapscript.encode({ timelock: { type: 'blocks', value: 1n }, pubkeys: [parties.sellerPubkey] }).script,
    ])
    const sellerAddress = sellerScript.address(undefined, serverPubKey)
    const toScriptHex = Buffer.from(sellerAddress.pkScript).toString('hex')

    const leaf = escrow.status === 'DISPUTED' ? sellerArbiter : buyerSeller
    const { arkTx, checkpoints } = await this.buildUnsignedSpend(escrow, parties, leaf, toScriptHex)

    if (escrow.status === 'DISPUTED') {
      const arbiterIdentity = this.deriveArbiterKey(parties.arbiterId)
      const arbiterPk = await arbiterIdentity.xOnlyPublicKey()
      const signedArkTx = await arbiterIdentity.sign(arkTx, [0])
      const signedCheckpoints = await Promise.all(checkpoints.map((cp) => arbiterIdentity.sign(cp, [0])))
      if (!escrow.sellerId) {
        throw new EscrowError(`LIGHTNING_HODL (Arkade) provider: missing sellerId for disputed refund of trade ${escrow.tradeId}`)
      }
      const expectedPubkeys = [Buffer.from(parties.sellerPubkey).toString('hex'), Buffer.from(arbiterPk).toString('hex')]
      return { psbtBase64: this.serializeBundle(signedArkTx, signedCheckpoints, expectedPubkeys), requiredSigners: [escrow.sellerId], toAddress: toScriptHex }
    }

    if (!escrow.buyerId || !escrow.sellerId) {
      throw new EscrowError(`LIGHTNING_HODL (Arkade) provider: missing buyerId/sellerId for refund of trade ${escrow.tradeId}`)
    }
    const expectedPubkeys = [Buffer.from(parties.buyerPubkey).toString('hex'), Buffer.from(parties.sellerPubkey).toString('hex')]
    return { psbtBase64: this.serializeBundle(arkTx, checkpoints, expectedPubkeys), requiredSigners: [escrow.sellerId, escrow.buyerId], toAddress: toScriptHex }
  }

  // RFC-021 D9 (2026-08-02) — not supported, for a real structural reason
  // specific to this provider (found by reading buildScript() below, not
  // assumed from the EscrowType's name): unlike MULTISIG's flexible 2-of-3
  // P2MS script (any 2 of the 3 keys validate a spend regardless of its
  // output structure), this VtxoScript has exactly THREE FIXED 2-of-2
  // leaves — buyerSeller, buyerArbiter, sellerArbiter — and a spend must
  // pick one leaf and provide exactly that leaf's two signatures; a
  // buyer's signature is not even checkable under the sellerArbiter leaf.
  // A disputed SPLIT needs the arbiter's signature to be enforceable
  // without both parties' voluntary cooperation (the same property that
  // makes disputed release/refund work today — the arbiter co-signs with
  // only the WINNING party, the loser cannot block it), but there is no
  // leaf where the arbiter co-signs a transaction paying BOTH buyer and
  // seller — buyerArbiter excludes the seller, sellerArbiter excludes the
  // buyer, and buyerSeller excludes the arbiter entirely. Building this
  // for real would mean adding a genuinely new leaf/script construction
  // (e.g. a 3-key threshold leaf), a real protocol-level change, not a
  // service-layer wire-up — not attempted here.
  async buildUnsignedSplit(escrow: ArkEscrowInput, _buyerToScriptHex: string, _sellerToScriptHex: string, _buyerBps: number): Promise<{ psbtBase64: string; requiredSigners: string[] }> {
    throw new EscrowError(
      `LIGHTNING_HODL (Arkade) provider: SPLIT is not supported for trade ${escrow.tradeId} — this provider's VtxoScript only has ` +
      'fixed 2-of-2 leaves (buyer+seller, buyer+arbiter, seller+arbiter), none of which let the arbiter co-sign a payout to both ' +
      'parties at once. See this method\'s own comment for the full reasoning. Use RELEASE or REFUND instead.',
      'UNSUPPORTED' // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — a real, structural rail limitation, not a config/policy/maturity gap
    )
  }

  // Shared finalize: combines the unsigned bundle with every
  // independently-signed copy submitted by the required signers
  // (combineTapscriptSigs — the Ark equivalent of Psbt.combine()),
  // verifies the result actually carries every expected signature
  // (verifyTapscriptSignatures — combine itself does not validate, unlike
  // bitcoinjs-lib's finalizeAllInputs()), then submits for real. On the
  // disputed path, the unsigned bundle already carries the arbiter's
  // partial signature (embedded by buildUnsignedRelease/Refund above), so
  // combining it with the single client-submitted copy still yields both
  // required signatures.
  private async finalizeArk(escrow: ArkEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId: string | undefined, kind: 'release' | 'refund'): Promise<{ txId: string }> {
    // Issue #240 - durable pre-submission evidence, written in the SAME call as the decision to
    // proceed (no `await` gap before it) — see signature-collection-finalization-truth.ts's own
    // header comment. escrow.id/pendingTxId are always present on the real call path
    // (escrow-pending-tx.ts's submitTransactionSignature()); only a direct unit-test call without
    // them skips this (harmless — the same "not directly callable outside this flow" contract
    // releaseFunds()/refundFunds() below already document).
    if (escrow.id && pendingTxId) {
      const ensured = await ensureFinalizationAttempt(escrow.id, pendingTxId, kind)
      if (ensured.action === 'RESUME_CONFIRMED') return { txId: ensured.txHash }
    }
    try {
      const base = this.deserializeBundle(unsignedPsbtBase64)
      const signedBundles = signedPsbtBase64List.map((s) => this.deserializeBundle(s))
      const expectedPubkeys = base.expectedPubkeys ?? []

      let finalArkTx = base.arkTx
      for (const b of signedBundles) finalArkTx = combineTapscriptSigs(finalArkTx, b.arkTx)
      verifyTapscriptSignatures(finalArkTx, 0, expectedPubkeys)

      const signedCheckpoints = base.checkpoints.map((cp, i) => {
        let combined = cp
        for (const b of signedBundles) combined = combineTapscriptSigs(combined, b.checkpoints[i])
        verifyTapscriptSignatures(combined, 0, expectedPubkeys)
        return combined.hex
      })

      const submitted = await this.getArkProvider().submitTx(finalArkTx.hex, signedCheckpoints)
      await this.getArkProvider().finalizeTx(submitted.arkTxid, submitted.signedCheckpointTxs)
      // finalizeTx() has no further async confirmation step in this codebase - a successful return
      // is recorded CONFIRMED directly (signature-collection-finalization-truth.ts's own header
      // comment explains why this differs from SAFE_GUARD_EVM's SUBMITTED).
      if (escrow.id) await recordFinalizationOutcome(escrow.id, 'CONFIRMED', submitted.arkTxid)
      return { txId: submitted.arkTxid }
    } catch (err) {
      // The durable attempt row (if one was created above) is deliberately left at
      // SUBMISSION_UNKNOWN — see wdk-execution-truth.ts's own corrected-lesson comment this file's
      // header points to: a thrown error here cannot distinguish "never reached the ASP" from
      // "reached it and the response was lost," so nothing further needs writing.
      throw new EscrowError(
        `LIGHTNING_HODL (Arkade) provider: failed to combine/finalize signatures for trade ${escrow.tradeId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async finalizeRelease(escrow: ArkEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId?: string): Promise<{ txId: string }> {
    return this.finalizeArk(escrow, unsignedPsbtBase64, signedPsbtBase64List, pendingTxId, 'release')
  }

  async finalizeRefund(escrow: ArkEscrowInput, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId?: string): Promise<{ txId: string }> {
    return this.finalizeArk(escrow, unsignedPsbtBase64, signedPsbtBase64List, pendingTxId, 'refund')
  }

  // Not directly callable — the SettlementProvider interface still
  // requires these methods, but buyer/seller keys are client-held, so a
  // real release needs the multi-step flow above instead of a single
  // synchronous call. Kept as loud, explanatory throws (not silently
  // wrong) rather than removed, since escrow.service.ts's own
  // releaseFunds()/refundFunds() (the MOCK/WDK_USDT_EVM path) still calls
  // through this same interface for every SettlementProvider.
  async releaseFunds(_escrow: ArkEscrowInput, _toAddress: string): Promise<{ txId: string }> {
    throw new EscrowError(
      'LIGHTNING_HODL (Arkade) provider: releaseFunds() is not directly callable — buyer/seller keys are client-held. ' +
      'Use POST /v1/settlement/escrow/:id/initiate-release, then submit-transaction-signature, instead (see escrow.service.ts).'
    )
  }

  async refundFunds(_escrow: ArkEscrowInput): Promise<{ txId: string }> {
    throw new EscrowError(
      'LIGHTNING_HODL (Arkade) provider: refundFunds() is not directly callable — buyer/seller keys are client-held. ' +
      'Use POST /v1/settlement/escrow/:id/initiate-refund, then submit-transaction-signature, instead (see escrow.service.ts).'
    )
  }
}

export const lightningHodlProvider = new LightningHodlProvider()
