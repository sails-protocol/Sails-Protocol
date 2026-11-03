import { AssetType } from '../../common/types'
import { EscrowType } from '../../common/types/trade'
import { EscrowError } from '../../common/errors'
import { config } from '../../config'
import { assertArbitrationPolicyCompatible, resolveArbitrationModeForImplementation, type ArbitrationMode } from './arbitration-policy'
import { randomUUID as uuidv4 } from 'crypto'
import { wdkSettlementProvider } from './wdk-settlement.provider'
import { multisigProvider } from './multisig.provider'
import { lightningHodlProvider } from './lightning-hodl.provider'
import { safeGuardEvmProvider } from './safe-guard-evm.provider'

/**
 * Sails OpenSettlement — SettlementProvider registry (ARCHITECTURE_AUDIT_REPORT.md
 * §2's "escrow.service.ts" finding, recommendation #1: "extrair em pelo
 * menos 4 módulos focados: ciclo de vida, registry de providers,
 * dual-approval, transações pendentes" — closed 2026-08-08).
 *
 * Everything in this file was previously inline in escrow.service.ts.
 * Moved verbatim (no behavior change) — this is the "which real
 * settlement backend handles this escrow type" concern, genuinely
 * separable from the lifecycle state machine in escrow.service.ts that
 * calls into it.
 */

export type EscrowRecord = {
  id: string
  tradeId: string
  type: string
  status: string
  lockedAmount: string   // decimal string — RFC-009, never a JS number
  asset: string
  network: string | null
  multisigAddr: string | null
  redeemScript: string | null
  txLockId: string | null
  // Missão 10 — the funding UTXO's vout, alongside txLockId's own
  // (unchanged) txid. Null for every escrow that locked funds before
  // this migration, and for every non-Bitcoin provider (EVM/mock
  // providers have no outpoint concept) — multisig.provider.ts's
  // buildUnsignedSpend() falls back to its pre-existing txid-only match
  // only when this is null.
  txLockVout: number | null
  txReleaseId: string | null
  timelockHours: number
  lockedAt: Date | null
  expiresAt: Date | null
  releasedAt: Date | null
  createdAt: Date
  updatedAt: Date
  // Trade's own parties — Escrow itself has no buyer/seller columns
  // (OpenSettlement must never own Trade's data, see escrow.service.ts's
  // header comment), so these are attached by lockFunds()/releaseFunds()/
  // refundFunds() below from a Trade row they already fetch for the
  // isPartyOrAgent() authorization check.
  buyerId?: string
  sellerId?: string
  // Client-submitted pubkeys (EscrowParticipantKey, hex, 33-byte
  // compressed) — attached by lockFunds() for MULTISIG/LIGHTNING_HODL,
  // the only two providers that need them (they no longer derive
  // buyer/seller keys server-side, see each provider's own header
  // comment). Optional so every other provider keeps ignoring them.
  buyerPubkey?: string
  sellerPubkey?: string
  // Set only for releaseFunds()/refundFunds() — the arbiter id
  // (resolveDispute()'s triggeredBy) an arbitrated call was authorized
  // with, so MultisigProvider can refuse a mismatched dispute-arbiter
  // signature instead of attempting one that would fail to validate. See
  // multisig.provider.ts's assertArbiterMatchesScript().
  triggeredBy?: string
  // Missão 11 Fase 4 — the escrow's own immutable fee-policy snapshot
  // (Escrow columns, Fase 2.2/2.3). Already carried through by every real
  // call site's existing `{ ...escrow, ... }` spread (escrow.service.ts/
  // escrow-pending-tx.ts) — declared here so provider code can read them
  // with real types instead of an unsafe cast. Null/undefined for every
  // legacy escrow, unchanged behavior.
  feePolicyVersionId?: string | null
  snapshotProtocolFeeRate?: string | null
  fundedAmount?: string | null
  // Missão 11 Fase 4.1 — the frozen collection destination and
  // pre-funding-waiver decision (see multisig.provider.ts's own
  // MultisigEscrowInput comment for the full explanation). Same
  // null/undefined-for-legacy convention as the other snapshot fields.
  snapshotFeeCollectionAddress?: string | null
  snapshotFeeCollectionWaivedPreFunding?: boolean | null
}

// ─── SettlementProvider — the protocol interface (Sails Protocol Spec) ────────
//
// F6 (docs/TECHNICAL_DEBT_AUDIT.md #53) — `verifyLock(escrow): Promise<boolean>`
// was removed from this interface (2026-09-07). It had no real caller
// anywhere in src/ — every real implementation (MULTISIG, LIGHTNING_HODL,
// SAFE_GUARD_EVM, WDK_USDT_EVM) duplicated the exact same funding-check
// logic `lockFunds()` below already performs (and, for MULTISIG,
// duplicated it with a WEAKER confirmation-depth guarantee at one point —
// see that file's own git history), and MOCK's own implementation was a
// bare `return true`, contributing no property at all. The real funding
// condition for each rail is established, and re-verified where recovery
// exists, entirely through the methods already below:
//   - MULTISIG: `lockFunds()` (initial lock) and `rescanFunding()`
//     (multisig-funding-reorg-sweep.ts's own re-verification path)
//   - LIGHTNING_HODL / SAFE_GUARD_EVM: `lockFunds()` only — no reorg-sweep
//     equivalent exists for these rails today (a real, disclosed,
//     pre-existing gap, unrelated to this removal and not created by it)
//   - WDK_USDT_EVM: `lockFunds()` itself moves the funds (custodial); the
//     resulting balance is a direct consequence of that same call, not a
//     separately-verifiable external fact
// No public route, SDK method, or normative RFC ever exposed or required
// `verifyLock()` — confirmed by repository-wide search before removal.
//
// Precision note (CTO Gate, 2026-09-07): `escrow.service.ts`'s
// `lockFunds()` claims the CREATED->FUNDS_LOCKED status PROVISIONALLY,
// atomically, BEFORE calling `provider.lockFunds()` below — the real
// verification (or fund movement) happens AFTER that claim, inside the
// provider call itself, and a failed provider call reverts the claim.
// `FUNDS_LOCKED` can therefore exist in the database while the provider
// call is still executing; it is not itself durable settlement
// evidence. The real, unchanged property is: a lock is only
// finalized/evidenced (result persisted, funding evidence recorded,
// `settlement.escrow.locked` emitted) once `provider.lockFunds()`
// succeeds.
export interface SettlementProvider {
  name: string
  // Missão 10 — vout is optional and additive: only providers with a
  // real Bitcoin-style outpoint (MULTISIG) populate it; every other
  // provider's existing return shape ({txId, address}) still satisfies
  // this type unchanged.
  // Missão 11 Fase 4 — fundedAmount is optional/additive: only providers
  // that observe a real external funding amount (MULTISIG) populate it;
  // every other provider's existing return shape stays valid unchanged.
  // Purely observational (escrow.service.ts persists it to Escrow.fundedAmount
  // for policy-aware escrows only) — never the source of truth for
  // construction, which always re-reads the real chain/provider state.
  // Missão 11 Fase 9.1 §1 — confirmedAtHeight/tipHeightAtObservation are
  // optional, same "MULTISIG today" shape as vout/fundedAmount above:
  // only a provider with a real Bitcoin-style confirmation-depth concept
  // populates them, so escrow.service.ts can record the initial
  // EscrowFundingEvidence.OBSERVED_CONFIRMED row with real height data
  // when available, and simply omit it (still valid — see that model's
  // nullable columns) for every other provider.
  lockFunds(escrow: EscrowRecord): Promise<{
    txId: string; address: string; vout?: number; fundedAmount?: number
    confirmedAtHeight?: number; tipHeightAtObservation?: number
  }>
  releaseFunds(escrow: EscrowRecord, toAddress: string): Promise<{ txId: string }>
  refundFunds(escrow: EscrowRecord): Promise<{ txId: string }>
  // RFC-021 D9 — optional: only the providers where a partial payout is
  // actually representable implement this (MOCK, WDK_USDT_EVM this pass).
  // buyerBps is the buyer's share in basis points out of 10000 (the
  // seller gets the remainder) — strictly between 0 and 10000; a caller
  // wanting an all-or-nothing outcome should use release/refund instead.
  // Two real transfers, not one, since neither of this pass's direct
  // providers has an atomic multi-recipient primitive.
  splitFunds?(escrow: EscrowRecord, buyerAddress: string, sellerAddress: string, buyerBps: number): Promise<{ txIds: string[] }>
}

class MockSettlementProvider implements SettlementProvider {
  name = 'MOCK'
  async lockFunds(escrow: EscrowRecord) {
    await new Promise((r) => setTimeout(r, 100))
    return { txId: `mock-lock-${uuidv4()}`, address: `mock-addr-${escrow.id.slice(0, 8)}` }
  }
  async releaseFunds(_escrow: EscrowRecord, toAddress: string) {
    await new Promise((r) => setTimeout(r, 100))
    return { txId: `mock-release-${uuidv4()}-to-${toAddress.slice(0, 8)}` }
  }
  async refundFunds(_escrow: EscrowRecord) {
    await new Promise((r) => setTimeout(r, 100))
    return { txId: `mock-refund-${uuidv4()}` }
  }
  async splitFunds(_escrow: EscrowRecord, buyerAddress: string, sellerAddress: string) {
    await new Promise((r) => setTimeout(r, 100))
    return {
      txIds: [
        `mock-split-${uuidv4()}-to-${buyerAddress.slice(0, 8)}`,
        `mock-split-${uuidv4()}-to-${sellerAddress.slice(0, 8)}`,
      ],
    }
  }
}

export const PROVIDERS: Record<string, SettlementProvider> = {
  MOCK: new MockSettlementProvider(),
  // Real Arkade (Ark protocol) VTXO/Taproot escrow — lightning-hodl.provider.ts's
  // own doc comment has the full custody-model caveat (server-derived
  // keys, single-arbiter limitation, release/refund verification scope,
  // testnet/mutinynet only). Previously a throw-only stub inline in this
  // file; extracted to its own file and implemented for real.
  LIGHTNING_HODL: lightningHodlProvider,
  // Real @tetherto/wdk-wallet-evm USDT settlement — wdk-settlement.provider.ts's
  // own doc comment has the full custody-model caveat (single-seed
  // two-hop escrow, testnet only).
  WDK_USDT_EVM: wdkSettlementProvider,
  // Real 2-of-3 Bitcoin PSBT construction/signing — multisig.provider.ts's
  // own doc comment has the full custody-model caveat (server-derived
  // keys, single-arbiter limitation, testnet only). Previously absent
  // from this map entirely, meaning getProvider() silently fell through
  // to MOCK for every MULTISIG escrow ever created (fixed below too —
  // that fallback no longer exists for any type).
  MULTISIG: multisigProvider,
  // Real Safe Transaction Guard + ERC-4337 escrow (RFC-020) —
  // safe-guard-evm.provider.ts's own doc comment has the full
  // custody-model caveat (client-held buyer/seller keys, KMS-backed
  // arbiter co-signer, and the real-but-not-yet-deployable boundary:
  // lockFunds/broadcast all require live EVM RPC + ERC-4337 bundler
  // infrastructure this environment doesn't have; F6, 2026-09-07 —
  // verifyLock() has since been removed from the interface entirely,
  // see this file's own SettlementProvider header comment).
  SAFE_GUARD_EVM: safeGuardEvmProvider,
}

// Providers that never push funds into escrow themselves (MULTISIG,
// LIGHTNING_HODL/Arkade, SAFE_GUARD_EVM) and whose buyer/seller keys are
// client-held — their deposit address can only be derived once both
// pubkeys have been submitted (submitParticipantKey() below), not at
// creation time. SAFE_GUARD_EVM added 2026-08-01 (real CREATE2 address
// prediction landed, safe-guard-evm.provider.ts's own header comment) —
// previously absent here entirely, meaning submitParticipantKey() never
// derived/persisted a Safe address for it and lockFunds() had no
// multisigAddr to verify a balance against.
// Missão 11 Fase 5.2 §2 — getDepositAddress()'s return shape widened from a
// bare address string to include the arbiter commitment MultisigProvider
// now resolves as part of the SAME script-building call (never a second,
// independent derivation — see its own header comment). arbiterPubkeyHex/
// arbiterId are optional: LIGHTNING_HODL/SAFE_GUARD_EVM don't populate them
// (out of this phase's scope — their own analogous arbiter-commitment gap
// is disclosed, not fixed, in this mission's report), so they simply wrap
// their existing address in `{ address }` and leave the rest undefined.
export const NON_CUSTODIAL_PROVIDERS: Record<string, { getDepositAddress(tradeId: string, buyerPubkey: string, sellerPubkey: string): Promise<{ address: string; arbiterPubkeyHex?: string; arbiterId?: string }> }> = {
  MULTISIG: multisigProvider,
  LIGHTNING_HODL: lightningHodlProvider,
  SAFE_GUARD_EVM: safeGuardEvmProvider,
}

// Missão 11 Fase 9.1 §10 — Phase 9.0's audit found every real provider
// already states its own honest, distinctly-worded `custodyModel` field
// (each provider's own header comment has the full disclosure), but it
// was never serialized into any HTTP/SDK response — only knowable from
// reading source code. Not part of the `SettlementProvider` interface
// itself (deliberately: MOCK has no real custody claim to make, so
// requiring every implementation to set one would force a meaningless
// placeholder onto the one provider where "custody" doesn't apply at
// all). `null` for MOCK and any unregistered type — never a fabricated
// or marketing label; a client that gets `null` should treat that as
// "no disclosed custody model," not "fully custodial" or "fully
// non-custodial." Read via a live index signature access (not the
// PROVIDERS map's own static type) since custodyModel isn't declared on
// SettlementProvider itself.
export function getCustodyModelForType(type: string): string | null {
  const provider = PROVIDERS[type] as { custodyModel?: string } | undefined
  return provider?.custodyModel ?? null
}

// Phase 2 (2026-07-27) — providers whose release/refund now goes through
// client-signature collection instead of a single synchronous provider
// call. Both MULTISIG and LIGHTNING_HODL as of the same day's follow-up
// pass — verified experimentally first that @arkade-os/sdk's SingleKey
// (a raw-private-key signer, the same private key generateEscrowKeypair()
// already produces for MULTISIG) needs no ASP/wallet machinery to sign,
// and bundles cleanly for a browser target with zero Node-core imports.
// The "psbtBase64" field is generic across both providers — MULTISIG's is
// a literal Bitcoin PSBT, LIGHTNING_HODL's is a JSON bundle of Ark tx +
// checkpoint PSBTs (see lightning-hodl.provider.ts's own header comment)
// — this service never inspects the string's contents itself, only
// stores/relays it, so the difference is invisible here.
// Missão 11 Fase 4 — populated only by a provider that actually implements
// fee-aware output construction (MULTISIG this pass); null/absent for a
// legacy (non-policy-aware) escrow, and for any provider that hasn't been
// extended yet (LIGHTNING_HODL/SAFE_GUARD_EVM — see this mission's own
// rail-parity audit for why their construction is deliberately unchanged
// this phase). Lets escrow-pending-tx.ts persist the real, actually-built
// fee amount as collection evidence, rather than a second independent
// recomputation.
export interface FeeCollectionResult {
  feeSats: number
  waived: boolean
}

export interface SignatureCollectionProvider {
  // Missão 11 Fase 9.1.1 §3 — minerFeeSats is optional/additive: only
  // MULTISIG has a real, precomputed miner-fee concept worth persisting
  // for an independent verifier to read back (see EscrowPendingTransaction.minerFeeSats's
  // own schema comment) — LIGHTNING_HODL/SAFE_GUARD_EVM's existing return
  // shapes stay valid unchanged.
  buildUnsignedRelease(escrow: unknown, toAddress: string): Promise<{ psbtBase64: string; requiredSigners: string[]; feeCollection?: FeeCollectionResult | null; minerFeeSats?: number }>
  // Sails Core Implementation Program M8-RF (Destination Consistency) —
  // `authorizedDestination` is optional/additive at the INTERFACE level
  // only: LIGHTNING_HODL/SAFE_GUARD_EVM's own implementations keep their
  // existing single-parameter signatures unchanged (TypeScript structural
  // typing allows a narrower implementation of a wider interface method),
  // still deriving their own refund destination internally — genuinely
  // out of this mission's scope (M8-R never migrated those two rails).
  // MultisigProvider's own implementation REQUIRES it — see that file's
  // own header comment for why: the Provider translates an already-
  // authorized destination, it does not get to invent one.
  buildUnsignedRefund(escrow: unknown, authorizedDestination?: string): Promise<{ psbtBase64: string; requiredSigners: string[]; toAddress: string; minerFeeSats?: number }>
  // Sails Core Implementation Program M8.6 — rawTxHex is optional/
  // additive, same precedent as minerFeeSats above: only MULTISIG has a
  // real, independently-decodable finalized transaction worth returning
  // for live correspondence evaluation (dispute-correspondence.ts) —
  // LIGHTNING_HODL/SAFE_GUARD_EVM's existing return shapes stay valid
  // unchanged (they simply omit it).
  // Issue #240 - pendingTxId is optional/additive, same precedent buildUnsignedRefund()'s own
  // authorizedDestination already established just above: MULTISIG's implementation keeps its
  // existing 3-parameter signature unchanged (structural typing allows a narrower implementation of
  // a wider interface method) - Bitcoin broadcast needs no durable pre-submission attempt tracking
  // (idempotent by construction). LIGHTNING_HODL/SAFE_GUARD_EVM's own implementations use it to bind
  // their new signature-collection-finalization-truth.ts durable evidence to the exact live pending
  // operation, the same operation-binding discipline persistSettlementResult() already established
  // (Issue #291).
  finalizeRelease(escrow: unknown, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId?: string): Promise<{ txId: string; rawTxHex?: string }>
  finalizeRefund(escrow: unknown, unsignedPsbtBase64: string, signedPsbtBase64List: string[], pendingTxId?: string): Promise<{ txId: string; rawTxHex?: string }>
  // RFC-021 D9 — optional, same reasoning as SettlementProvider.splitFunds
  // above. Unlike that direct-call version, this is a single PSBT with two
  // real outputs (one transaction, one txid) — a signature-collection
  // provider's own script (2-of-3, output-structure-agnostic) doesn't care
  // how many outputs it spends to. Only MULTISIG implements this pass;
  // LIGHTNING_HODL/SAFE_GUARD_EVM each have a real, provider-specific
  // reason they can't (see each one's own buildUnsignedSplit() override).
  buildUnsignedSplit?(escrow: unknown, buyerAddress: string, sellerAddress: string, buyerBps: number): Promise<{ psbtBase64: string; requiredSigners: string[]; feeCollection?: FeeCollectionResult | null; minerFeeSats?: number }>
  finalizeSplit?(escrow: unknown, unsignedPsbtBase64: string, signedPsbtBase64List: string[]): Promise<{ txId: string; rawTxHex?: string }>
}
export const SIGNATURE_COLLECTION_PROVIDERS: Record<string, SignatureCollectionProvider> = {
  MULTISIG: multisigProvider,
  LIGHTNING_HODL: lightningHodlProvider,
  SAFE_GUARD_EVM: safeGuardEvmProvider,
}

// 33-byte compressed secp256k1 pubkey, hex — the canonical client-submitted
// format both MULTISIG and LIGHTNING_HODL derive their own required
// representation from (see each provider's own header comment).
export const PUBKEY_HEX_PATTERN = /^0[23][0-9a-fA-F]{64}$/

// Found during the multisig-coverage-per-asset audit: createEscrow() used
// to default an omitted `type` to a hardcoded 'MULTISIG' regardless of
// `asset` — the real live call site (sails-ui's Trade.tsx) never sends
// `type` at all, so in a non-mock deployment EVERY trade of EVERY asset
// silently became a Bitcoin PSBT escrow, correct only by accident for BTC.
// This is the single source of truth for "which real provider actually
// fits this asset" — BTC/LN_BTC map to the two genuinely non-custodial
// (client-held-keys, 2-of-3) providers; USDT_ERC20 maps to WDK_USDT_EVM,
// the best REAL option today even though its own header discloses it's
// single-seed, not multisig (SAFE_GUARD_EVM would be the right answer but
// its lockFunds/broadcast were still throw-only at the time this was
// written — routing USDT there would just fail every trade; F6,
// 2026-09-07 — verifyLock() has since been removed from the interface
// entirely). Every other AssetType has no real
// provider at all yet (LIQUID_COVENANT/SPARK/STACKS/etc. — see
// BACKLOG.md's asset x custody coverage note) and intentionally has no
// entry here, so createEscrow() throws instead of guessing.
const RECOMMENDED_ESCROW_TYPE: Partial<Record<AssetType, EscrowType>> = {
  BTC: 'MULTISIG',
  LN_BTC: 'LIGHTNING_HODL',
  USDT_ERC20: 'WDK_USDT_EVM',
}

// Missão 11 Fase 5 §10 — Rail Activation Gating. Fee-collection capability
// is SEPARATE from settlement capability: implementing SettlementProvider
// (every rail in PROVIDERS above) does not imply real, atomic Protocol Fee
// construction. Only MULTISIG builds a real Sails fee output today (Fase
// 4/4.1) — this is the ONE place that truth is declared, consumed by both
// escrow-fee-snapshot.service.ts's pre-funding check and
// fee-policy.service.ts's publish()-time activation gate, so the two
// questions ("is this rail collection-capable" and "can this rail's
// policy go live") can never independently drift. Extend this set only
// once a rail's own buildUnsignedRelease()/buildUnsignedSplit() actually
// construct a real, tested fee output — never in anticipation of one.
export const FEE_COLLECTION_CAPABLE_RAILS: ReadonlySet<string> = new Set(['MULTISIG'])

// The five real EscrowType values this gate applies to — deliberately
// NOT every possible railScope string. FeePolicyVersion.railScope is
// intentionally free-form (this file's own EscrowRecord/PROVIDERS
// comments explain why), and this codebase's own isolated accounting
// tests (Fase 2.2/3) legitimately publish policies against fixture rail
// names that were never meant to represent a real settlement rail — this
// gate must never reject those. It only ever fires for a railScope that
// IS one of these five real, addressable rails.
const REAL_ESCROW_TYPES: ReadonlySet<string> = new Set(['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM', 'WDK_USDT_EVM', 'MOCK'])

// Missão 11 Fase 4.2's own Activation Blocker B, closed here: a
// FeePolicyVersion must not become active for a rail with no real
// fee-aware collection — publishing one for LIGHTNING_HODL/SAFE_GUARD_EVM/
// WDK_USDT_EVM/MOCK would silently create FeeObligation rows reporting a
// real, positive computedFee while the underlying settlement never
// collects a single unit. Two real call sites use this identically:
// fee-policy.service.ts's publish() (the real production activation gate)
// and escrow-fee-snapshot.service.ts's computeSnapshotFields() (a second,
// defense-in-depth check — catching a policy that somehow reached
// PUBLISHED status without going through publish(), e.g. a raw-SQL
// insert, which should never happen via any real application path but
// must fail loudly, not silently snapshot, if it ever does).
export function assertRailCanActivateFeeCollection(railScope: string): void {
  if (REAL_ESCROW_TYPES.has(railScope) && !FEE_COLLECTION_CAPABLE_RAILS.has(railScope)) {
    throw new EscrowError(
      `Fee policy activation is not supported for rail '${railScope}' — it has no real, atomic Protocol Fee collection implementation ` +
      `(Missão 11 Fase 5 rail-activation gating). Only ${[...FEE_COLLECTION_CAPABLE_RAILS].join(', ')} may activate a real fee policy today.`
    )
  }
}

// Missão 11 Fase 7.3.2 §1 (CTO-approved) — the rail-capability layer for
// arbitration, same shape as FEE_COLLECTION_CAPABLE_RAILS above: an
// explicit, narrow, extensible set rather than a single global boolean,
// so a future rail with its OWN different arbitration capability never
// needs a new kind of check invented, just a membership change here.
//
// A rail belongs in this set when its settlement script commits exactly
// ONE specific, executable arbiter identity at escrow-creation time — no
// other identity is ever cryptographically capable of executing a ruling
// on that script (multisig.provider.ts's own header comment has the full
// single-arbiter-limitation disclosure). Only MULTISIG actually persists
// such a commitment today (EscrowParticipantKey{role:'arbiter'},
// escrow.service.ts's submitParticipantKey()) — LIGHTNING_HODL/
// SAFE_GUARD_EVM have their own analogous, disclosed-but-not-yet-fixed
// arbiter-commitment gap (NON_CUSTODIAL_PROVIDERS's own comment above),
// so they are deliberately NOT included here until they actually persist
// one; adding them prematurely would make this guard fire for a rail
// that doesn't yet have the underlying commitment to protect.
export const SCRIPT_COMMITTED_ARBITER_RAILS: ReadonlySet<string> = new Set(['MULTISIG'])

// Missão 11 Fase 7.3.2 §1 (CTO decision) — real P0 follow-up from Fase
// 7.3.1 §B: that fix made a script-committed rail's dispute resolution
// structurally SAFE under ARBITRATION_MODE=market (the committed
// identity always wins over market's own draw), but "safe" there means
// market's entire selection mechanism is silently never actually
// exercised for that rail — a real semantics mismatch an operator
// deploying market mode deserves to be told about loudly at boot, not
// left to discover by reading dispute-resolution logs later. Unlike
// config/index.ts's own RT-001/ENFORCE_CAPABILITIES guards (evaluated as
// a module-load-time side effect, since they only ever need
// process.env), this is a plain, directly-callable function — it needs
// SCRIPT_COMMITTED_ARBITER_RAILS, which lives here, and config/index.ts
// cannot import this file without a real circular import (this file
// already imports config). app.ts's buildApp() calls this once,
// unconditionally, at boot — deliberately NOT deferred to
// getDisputeService()'s own lazy-construction pattern, since the whole
// point is to fail before any traffic is served, matching the mandate's
// "loud startup validation failure, not silently ignored semantics."
//
// Every rail in this set is ALWAYS creatable today (MULTISIG is
// registered unconditionally in PROVIDERS above, no feature flag gates
// it) — so this check is currently equivalent to "market mode is never
// compatible with this deployment," which is the honest, current truth,
// expressed in a form that stops being true automatically the day a real
// feature flag to disable a specific rail's availability is ever added,
// with zero change needed here.
export function assertArbitrationModeCompatibleWithAvailableRails(
  defaultMode: ArbitrationMode,
  overrides: Readonly<Record<string, ArbitrationMode>> = {},
): void {
  for (const implementation of Object.keys(PROVIDERS)) {
    const effectiveMode = resolveArbitrationModeForImplementation(implementation, defaultMode, overrides)
    assertArbitrationPolicyCompatible(implementation, effectiveMode)
  }
}

// Issue #229 R2 (CTO corrective mission) — the one canonical concept for
// "is this escrow type economically eligible for the CURRENT deployment",
// deliberately kept separate from three adjacent, already-existing
// concepts it must not be confused with:
//   - protocol representability   → ESCROW_TYPE_VALUES (p2p-schemas) —
//     whether the wire format even allows this type. Untouched by this.
//   - provider implementation existence → PROVIDERS (above) — whether a
//     SettlementProvider is registered at all for this type. Untouched.
//   - deployment/environment eligibility → THIS set. Whether an already-
//     representable, already-implemented type may economically EXECUTE
//     in the deployment currently running.
// `MOCK` is the only entry today: it makes no real custody claim and
// fabricates lock/release/refund/split success unconditionally
// (mock-settlement.provider.ts) — safe as a deliberate dev/test/sandbox
// choice, never safe as something a production node treats as real.
// #220 may register other production-ineligible (reference-only/
// testnet-only) rails here later without inventing a second mechanism —
// deliberately a plain Set, not a broader eligibility framework, since
// nothing today needs more than "in production, this type is refused."
const PRODUCTION_INELIGIBLE_TYPES: ReadonlySet<string> = new Set(['MOCK'])

// Single enforcement point for the policy above. Called from BOTH:
//   1. escrow.service.ts's resolveEscrowType() — creation time, before
//      any row is persisted (an explicit type: 'MOCK' request in
//      production never reaches the database at all).
//   2. getSettlementProvider() below — every economically active
//      dispatch (lockFunds/releaseFunds/refundFunds/splitFunds, and any
//      future caller) funnels through this one function, so this is the
//      single choke point that also covers an escrow row that was
//      PERSISTED before this gate existed, or otherwise reached the
//      database out-of-band (e.g. a promoted staging DB) — restart,
//      reconciliation, and dispute resolution all resolve their provider
//      through this exact call, so none of them can reactivate a
//      persisted MOCK row's fake economic execution in production either.
// Two call sites, one policy function — never a scattered per-method
// `if (production && type === 'MOCK')`.
export function assertDeploymentEligible(type: string): void {
  if (config.isProduction && PRODUCTION_INELIGIBLE_TYPES.has(type)) {
    throw new EscrowError(
      `Escrow type '${type}' is not economically eligible in production — it fabricates settlement success ` +
      "without moving real funds (see MockSettlementProvider). The historical/persisted fact that this escrow's " +
      "type is what it is remains unaffected by this refusal; only economic execution against it is refused.",
      'DISABLED'
    )
  }
}

export function recommendedEscrowType(asset: AssetType): EscrowType {
  const type = RECOMMENDED_ESCROW_TYPE[asset]
  if (!type) {
    throw new EscrowError(
      `No real SettlementProvider is wired for asset '${asset}' yet — refusing to guess an escrow type. ` +
      "Pass type: 'MOCK' explicitly if a fake/test escrow for this asset is actually intended.",
      'UNAVAILABLE' // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — this deployment hasn't wired a provider for this asset, not a technical impossibility or a policy denial
    )
  }
  return type
}

export function getSettlementProvider(type: string): SettlementProvider {
  // Missão 11 Fase 7.3.1 §A — real P0 closed here (Fase 7.3 audit):
  // `config.features.mockEscrow` used to short-circuit THIS function
  // before `type` was even consulted, so a persisted, real MULTISIG
  // escrow silently resolved to MockSettlementProvider whenever
  // MOCK_ESCROW was unset/true (its own default) and NODE_ENV wasn't the
  // exact literal string 'production' (config/index.ts's RT-001 boot
  // guard only fires on that one literal value — 'staging', a typo, or
  // simply leaving NODE_ENV unset all sailed straight past it).
  //
  // Fix is structural, not another environment-name check (the CTO
  // mandate's own instruction: prefer fail-closed selection over
  // convention): `mockEscrow` is a CREATION-time convenience default for
  // what type an escrow gets ASSIGNED when a caller omits `type`
  // entirely (see escrow.service.ts's createEscrow(), which still reads
  // it for exactly that, unchanged) — it has no business also overriding
  // PROVIDER RESOLUTION for an escrow that already has a real, persisted
  // type. Once `type` is anything other than the literal string 'MOCK',
  // this function now always returns that type's real, registered
  // provider — full stop, regardless of NODE_ENV, MOCK_ESCROW, or any
  // other global flag. A caller that genuinely wants a fake escrow must
  // say so explicitly, at creation time, via `type: 'MOCK'` — never
  // implicitly, later, at settlement time.
  //
  // Corrected/Implemented 2026-09-19 (Issue #229 R2, CTO corrective
  // mission) — "regardless of NODE_ENV... or any other global flag" above
  // still holds EXACTLY as written for every real, registered type below
  // (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM/WDK_USDT_EVM keep resolving
  // unconditionally off the persisted `type`, so reconciliation/restart
  // for those is completely unaffected by this change). MOCK is today the
  // one type whose provider FABRICATES settlement success rather than
  // doing real economic work, so it's the one entry currently in
  // PRODUCTION_INELIGIBLE_TYPES — but the check below applies to
  // WHATEVER that set contains, not to the literal string 'MOCK'.
  //
  // Corrected/Implemented 2026-09-19 (Issue #229 R3, CTO corrective
  // mission) — R2 called assertDeploymentEligible() only inside an
  // `if (type === 'MOCK')` branch, which made the "canonical, generic
  // policy" claim false in practice: a future #220 addition to
  // PRODUCTION_INELIGIBLE_TYPES would silently do nothing here unless a
  // second provider-specific `if` were also added. Moved to the top of
  // this function, unconditionally, so the policy actually governs every
  // `type` this function ever resolves — this is now the single choke
  // point every economically active dispatch (lockFunds/releaseFunds/
  // refundFunds/splitFunds, reconciliation, restart/recovery) funnels
  // through, for ANY type #220 later classifies, with zero new code here.
  assertDeploymentEligible(type)
  if (type === 'MOCK') return PROVIDERS['MOCK']
  const provider = PROVIDERS[type]
  if (!provider) {
    // Correctness fix (found during the MULTISIG provider build): this
    // used to fall through to `?? PROVIDERS['MOCK']` for ANY
    // unregistered type — MULTISIG and LIQUID_COVENANT both silently
    // mock-processed real-money-shaped escrows with no error, unlike
    // LIGHTNING_HODL which at least throws "not yet implemented".
    // MULTISIG is now real (above); LIQUID_COVENANT still has no
    // provider, and now fails the same loud way LIGHTNING_HODL always
    // has, instead of quietly faking it.
    throw new EscrowError(
      `No SettlementProvider registered for escrow type '${type}' — refusing to silently fall back to MOCK for a type that claims to be real. ` +
      "Create the escrow with type: 'MOCK' explicitly if a fake escrow is actually intended.",
      'UNAVAILABLE' // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 39) — this deployment has no registered provider for this escrow type, not a technical impossibility or a policy denial
    )
  }
  return provider
}

// Issue #242 (CTO corrective mission, follow-up to #229/#230) — the #220
// audit found SIGNATURE_COLLECTION_PROVIDERS above is a SECOND, parallel
// provider-resolution registry, consumed directly by
// escrow-pending-tx.ts's initiateSignatureCollectionCore() (the unsigned
// RELEASE/REFUND/SPLIT construction step, shared by initiateRelease/
// initiateRefund/initiateSplit) and submitTransactionSignature() (the
// finalization step, reached once every required signature has arrived —
// including on a restart/resume, since a pending row's signatures can be
// submitted at any later wall-clock time by design). Neither of those
// call sites ever went through getSettlementProvider(), so neither ever
// ran assertDeploymentEligible() — today harmless only because MOCK
// happens to have no entry in SIGNATURE_COLLECTION_PROVIDERS at all, not
// because of any actual check. This is the single canonical accessor
// both call sites now use instead of indexing the raw map directly,
// mirroring getSettlementProvider()'s own shape immediately above: same
// policy function, same "checked once, centrally, for whatever type is
// actually being resolved for economic use" property, applied to this
// registry too. Deliberately NOT a throw-on-missing helper like
// getSettlementProvider() — the two call sites already have their own
// differently-worded "not a signature-collection type" error messages
// tailored to their own context (initiate vs a pending row that
// shouldn't be able to reach this state at all); this stays a thin
// resolver so neither message needs to change.
//
// SIGNATURE_COLLECTION_PROVIDERS itself stays exported and untouched:
// escrow.service.ts's isSignatureCollectionType() (a read-only
// membership check informing which settlement path a ruling should take)
// and sweepExpiredEscrows() (a read-only query-filter exclusion) both
// only ever classify a type — they never resolve a provider for
// execution, so gating them here would be exactly the "scatter checks
// blindly" the mission explicitly warned against.
export function getSignatureCollectionProvider(type: string): SignatureCollectionProvider | undefined {
  assertDeploymentEligible(type)
  return SIGNATURE_COLLECTION_PROVIDERS[type]
}
