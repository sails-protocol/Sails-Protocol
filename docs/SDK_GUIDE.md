# SDK_GUIDE.md
### Sails Protocol — SDK Integration Guide

> **Role in the canonical developer journey (Missão 07.4):** "how to
> build a real integration." Come here after `examples/simple-wallet`
> has already proven the golden path works for you — this document goes
> deeper (module layout, retry/timeout behavior, wallet-stack
> compatibility), it isn't a second quickstart.
>
> **Current package status:** `@satsails/p2p-trading-sdk@0.2.0` is the current repository package version. This guide contains both current integration guidance and dated historical notes from the v0.1 build-out; `API_STABLE.md` remains the authority for frozen SDK contract shape. `@satsails/p2p-trading-sdk`
> (`packages/sails-sdk`) now exists as a real npm workspace package —
> this document is no longer purely aspirational, it is the spec a real
> implementation is checked against. `SailsClient`'s Protocol SDK layer
> (`identity`, `reputation`, `liquidity`, `openp2p`, `settlement`,
> `peers`) is genuinely implemented against the reference
> implementation's real, tested HTTP/WS routes (verified route-by-route
> against each `*.routes.ts` file directly, not assumed from this doc's
> prose — see this file's own section 2 note on `createIntent`/`trade()`
> deviations found that way). Of the six-verb Intent facade,
> `createIntent`/`cancelIntent`/`dispute`/`submitProof`/`releaseAsset` are
> real and callable. `negotiate` remains the one experimental verb that
> throws `SailsNotImplementedError`; its fire-and-forget signature does
> not match the real stateful `WebSocketChannel`, so use
> `openp2p.chat(tradeId)` for the working negotiation/chat channel.
> `docs/API_STABLE.md` is the authoritative source for frozen SDK
> contract truth and wins if this onboarding guide ever drifts again.
> Its MVP release is branded **Sails P2P Trading SDK** — same package,
> scoped to what's actually being built first (P2P trading); see
> `PROJECT_CONTEXT.md` section 3 for the naming rule.
>
> **Correction (2026-07-20, release-audit finding — historical release-audit record):**
> despite the "verified route-by-route" claim above, section 2's
> `identity`/`reputation`/`liquidity`/`settlement`/`openp2p` interface
> block had drifted from the real implementation in most of its method
> signatures (wrong parameter shapes, a `liquidity.cancel()` that was
> never built, `identity.verify()` which doesn't exist). Rewritten to
> match `packages/sails-sdk/src/modules/*.ts` exactly. `docs/API_STABLE.md`
> is the actual frozen, no-breaking-changes contract as of v0.1 — this
> file is illustrative onboarding material, not the source of truth if
> the two ever disagree again.

The SDK is where the developer diagram (`PROJECT_CONTEXT.md` section 3,
"The developer diagram") lands in code — `SailsClient` is what sits at the
"Sails P2P Trading SDK" layer, the one thing a wallet imports to get every
module below it:

```
                    Wallet
                       │
                       ▼
            Sails P2P Trading SDK   ← SailsClient, this document
                       │
   ════════════════════════════════════
              Sails Protocol
   ════════════════════════════════════
   OpenP2P          OpenSettlement
   OpenIdentity     OpenProof
   OpenReputation   OpenAgents
   OpenLiquidity    OpenFinance (roadmap)
   ════════════════════════════════════
      WDK      ·      Pears      ·      QVAC
   ════════════════════════════════════
   Bitcoin · Liquid · Lightning · USDT
```

See `docs/DEVELOPER_JOURNEY.md` for this same shape walked step by step.
Multiple SDK/module surfaces below are implemented and callable today; this
onboarding diagram is not an implementation-status authority. For the current
frozen-vs-additive-vs-experimental SDK contract, `docs/API_STABLE.md` wins.

---

## 1. Why the SDK exists

The SDK is the developer-facing surface of the entire protocol. Instead of
an integrator learning 5 different module APIs and their event conventions,
they install one npm package and get a single typed client.

```bash
npm install @satsails/p2p-trading-sdk
```

The SDK adds **no new business logic** — it is a thin, typed wrapper around
the module APIs described in `API_REFERENCE.md`. If you ever find yourself
adding real logic inside the SDK that isn't already in a module's service
layer, that's a design smell: the logic belongs in the module, and the SDK
should just expose it.

Two references prove different parts of the integration surface:

- [`examples/simple-wallet`](../examples/simple-wallet) is the canonical
  **SDK golden path**: it proves the public SDK surface can drive a complete
  local trade flow against a real local Sails node.
- [`examples/wallet-integration`](../examples/wallet-integration) is the
  canonical **WalletAdapter / signing-boundary proof**: it shows how a real
  wallet keeps its own key management, signing, storage and broadcast
  responsibilities while implementing the interface Sails consumes.

The integration rule remains: **keep your wallet stack; plug into Sails.**
That slogan does not remove integration obligations. A real wallet must
implement the public `WalletAdapter` boundary for the operations it owns;
Sails provides the coordination/client surface and does not require the
wallet to surrender signing or key-management ownership.

---

## 2. The `SailsClient` Interface (illustrative onboarding view — `API_STABLE.md` wins)

The shape below is a developer-facing guide to the client surface, not a
stronger authority than the frozen compatibility contract. If this section
disagrees with `docs/API_STABLE.md` or current implementation evidence,
`API_STABLE.md` wins and this guide must be corrected.

```typescript
interface SailsClient {
  // ── Intent-oriented facade (v7.2 — the primary interface, per PRINCIPLES.md
  // "Intent Driven" and API_REFERENCE.md section 0). An application should
  // reach for the implemented facade methods first; `negotiate()` below is
  // still experimental, so use `openp2p.chat(tradeId)` for the real working
  // negotiation/chat channel today.
  createIntent<T extends IntentPayload>(payload: T): Promise<Intent<T>>
  cancelIntent(intentId: string): Promise<void>
  negotiate(intentId: string, event: NegotiationEvent): Promise<void>
  // EXPERIMENTAL today: throws SailsNotImplementedError. The real negotiation
  // path is the persistent WebSocketChannel returned by openp2p.chat(tradeId).
  // event is one of OFFER_PROPOSED | COUNTER_OFFERED | TERMS_ACCEPTED |
  // TERMS_REJECTED | MESSAGE_EXCHANGED — see PROTOCOL_SPECIFICATION.md §1.4.
  // A HumanChatChannel-backed application typically wraps the real chat
  // channel with a UI; do not treat this fire-and-forget facade signature as
  // equivalent to that implemented stateful channel.
  submitProof(intentId: string, proof: ProofSubmission): Promise<Proof>
  // proof.claimType is open-ended (PROTOCOL_SPECIFICATION.md §1.8) — well-known
  // conventional values include 'payment_sent', 'invoice_paid',
  // 'oracle_verified', 'delivery_confirmed', 'collateral_held'. The SDK and Core
  // never special-case any of these; a new claimType needs no protocol change.
  // Media evidence attached via submitProof() is stored through an
  // EvidenceProvider (RFC-007) the Reference Implementation configures —
  // the SDK/Core never receive or hold the raw media, only the resulting
  // signed EvidenceReference. See the proof: namespace below for reading
  // that evidence back.
  releaseAsset(intentId: string, toAddress: string): Promise<Escrow>
  // Designed (RFC-007 D3), not yet migrated: settlement status is intended
  // to eventually pass through PENDING_BANK_SETTLEMENT before COMPLETED —
  // representing a payment held/processing at the payer's financial
  // institution, not yet a failure state — but the real EscrowStatus enum
  // (prisma/schema.prisma) does not have this value today. Status note
  // added 2026-07-19 (consolidation audit) after this file, alongside
  // three others, described it as already live.
  dispute(intentId: string, reason: string): Promise<Dispute>
  // Escalation order (RFC-007 D4): Policy Engine → OpenAgents → a Trusted
  // Arbitrator via ArbitrationProvider → Settlement. Human arbitration is
  // the last stage, not the first — most disputes are expected to resolve
  // before ever reaching an ArbitrationProvider.

  // ── Real signatures, corrected 2026-07-20 (release-audit finding,
  // historical release-audit record) ─────────────────────────────────────────────────
  // Everything below this line was rewritten to match the actual
  // implemented code (packages/sails-sdk/src/modules/*.ts, read
  // directly, not assumed) — the previous version of this block was
  // aspirational pseudocode that had drifted from what got built:
  // wrong method names (identity.verify() was never built; the real
  // flow is challenge()+authenticate()), wrong signatures throughout
  // liquidity/settlement/reputation, and one method
  // (liquidity.cancel()) that was never implemented at all — the real
  // equivalent is updateStatus(offerId, status). This block is still
  // illustrative, not the frozen contract — docs/API_STABLE.md is the
  // one document making an actual no-breaking-changes commitment; if
  // the two ever disagree again, trust API_STABLE.md and file that as
  // a bug against this file.

  // Sails OpenIdentity (alias: auth)
  identity: {
    create(keypair?: Ed25519Keypair, displayName?: string): Promise<{ participant: Participant; keypair: Ed25519Keypair }>
    createWithWallet(publicKeyHex: string, wallet: { signMessage(m: Uint8Array): Promise<Uint8Array> }, displayName?: string): Promise<Participant>   // registration with proof of possession (Issue #302)
    registerChallenge(publicKeyHex: string): Promise<{ challenge: string; expiresIn: number }>   // Issue #302
    createWithPublicKey(publicKeyHex: string, displayName?: string): Promise<Participant>   // wallet-backed registration — no keypair object, no secretKey (2026-08-02)
    challenge(publicKeyHex: string): Promise<{ challenge: string; expiresIn: number }>
    authenticate(keypair: Ed25519Keypair): Promise<{ participantId: string; sessionToken: string }>
    authenticateWithWallet(publicKeyHex: string, wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> }): Promise<{ participantId: string; sessionToken: string }>   // wallet-backed sign-in — never touches a raw secretKey (2026-08-02)
    get(participantId: string): Promise<Participant>
    me(): Promise<Participant>   // requires an active session
  }

  // Sails OpenReputation (alias: trustScore — deliberately not
  // `profile`; this module has no displayName/avatar/trade history)
  reputation: {
    get(participantId: string): Promise<ReputationScore>
    // ReputationScore (RFC-007 D8) is computed exclusively from
    // recordOutcome() / SettlementOutcome events — rate() below never
    // feeds into it, and a CancelledByAgreement outcome always classifies
    // Neutral, never Negative.
    rate(input: { tradeId: string; ratedId: string; score: 1 | 2 | 3 | 4 | 5; comment?: string }): Promise<unknown>
    // Informational feedback only as of RFC-007 — stored, displayed, but
    // does not alter ReputationScore. Do not build UI that implies this
    // is "leaving a rating that affects reputation."
    leaderboard(pagination?: { limit?: number; offset?: number }): Promise<LeaderboardResult>
    // Missão 07.4 — this signature/return type was stale (used to say
    // `leaderboard(limit?): Promise<ReputationScore[]>`); see
    // docs/API_STABLE.md's own `reputation`/`trustScore` entry, the real
    // frozen-vs-not source of truth, for the exact `LeaderboardResult` shape.
    vouchFor(voucheeId: string): Promise<Vouch>   // requires an active session — RFC-021 D7 peer vouching. Caller must have real trade history; the caller's own reputation is slashed if the vouchee's first payment account is later abused
    getScoreByPeerId(peerId: string): Promise<ReputationScore>   // public read — returns the peer's aggregated reputation score (RFC-021 D8)
  }

  // Sails OpenLiquidity (alias: offers) — advanced/direct use.
  // The Intent-oriented facade remains the preferred abstraction where its
  // verb is implemented; `negotiate()` is not, so use openp2p.chat(tradeId)
  // for the real negotiation/chat channel.
  liquidity: {
    publish(input: PublishOfferInput): Promise<Offer>   // requires an active session
    discover(filter: { asset: AssetType; side: TradeSide; limit?: number; offset?: number }): Promise<DiscoverResult>
    // DiscoverResult includes total (total matching offers across all sources) and hasMore (whether more pages exist) —
    // backend getAggregatedOffers() now returns pagination metadata alongside offers/sources.
    getOffer(offerId: string): Promise<Offer & { user: Participant }>
    book(asset: AssetType): Promise<OrderBook>
    match(input: { asset: AssetType; side: TradeSide; amount: string }): Promise<LiquidityOfferSummary | null>
    // No dedicated cancel() — use the generic status transition:
    updateStatus(offerId: string, status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'): Promise<Offer>   // requires an active session
  }

  // Sails OpenSettlement (alias: escrow) — advanced/direct use;
  // releaseAsset()/dispute() above is the path most applications
  // should use instead
  settlement: {
    create(input: { tradeId: string; type?: EscrowType; lockedAmount: string; asset: AssetType; network?: string; timelockHours?: number }): Promise<Escrow>   // requires an active session
    get(escrowId: string): Promise<Escrow>   // requires an active session + trade party/assigned arbiter
    submitKey(escrowId: string, pubkeyHex: string, capabilityProfile?: string): Promise<{ escrow: Escrow; buyerKeySubmitted: boolean; sellerKeySubmitted: boolean }>   // requires an active session; capabilityProfile is enforced where the escrow type requires one
    lock(escrowId: string): Promise<Escrow>   // requires an active session
    markPaymentSent(escrowId: string): Promise<Escrow>   // requires an active session
    release(escrowId: string, toAddress?: string): Promise<Escrow>   // requires an active session; toAddress is retained for source compatibility but is inert under current destination-authority rules
    dispute(escrowId: string, reason: string, evidence?: unknown[]): Promise<Dispute>   // requires an active session
    refund(escrowId: string): Promise<Escrow>   // requires an active session
    initiateRelease(escrowId: string, toAddress?: string): Promise<EscrowPendingTransaction>   // requires an active session — MULTISIG multi-signer release; toAddress is retained for compatibility but current destination authority comes from the beneficiary's registered payout address
    initiateRefund(escrowId: string): Promise<EscrowPendingTransaction>   // requires an active session — mirror of initiateRelease
    submitTransactionSignature(escrowId: string, signedPsbtBase64: string): Promise<{ complete: boolean }>   // requires an active session
    getPendingTransaction(escrowId: string): Promise<EscrowPendingTransaction>   // requires an active session + trade party/assigned arbiter
    listDisputes(pagination?: { limit?: number; offset?: number }): Promise<PaginatedDisputes>   // requires an active session — always scoped to the caller's own arbiterId
    getDispute(disputeId: string): Promise<Dispute>   // requires an active session + trade party/assigned arbiter; not a public read
    resolveDispute(disputeId: string, ruling: DisputeRuling, releaseToAddress?: string, refundToAddress?: string, splitBuyerBps?: number, authoritySignature?: string, authorityIssuedAt?: string): Promise<Dispute>   // requires an active session + assigned arbiter; authoritySignature/authorityIssuedAt are required in practice for the manual path
    resolveDisputeWithWallet(disputeId: string, ruling: DisputeRuling, wallet: Pick<WalletAdapter, 'signMessage'>, releaseToAddress?: string, refundToAddress?: string, splitBuyerBps?: number): Promise<Dispute>   // recommended helper: builds and signs the authority decision with the caller-owned signer
    appealDispute(disputeId: string): Promise<{ dispute: Dispute; appealFeeRequired: string }>   // requires an active session + trade party — RFC-021 D6, market arbitration mode only
    submitDisputeEvidence(disputeId: string, descriptor: { type: string; uri?: string; note?: string }, idempotencyKey?: string): Promise<Dispute>   // requires an active session + trade party; optional idempotencyKey makes retries safe
    contestAutoResolution(disputeId: string): Promise<Dispute>   // requires an active session + trade party — RFC-021 D8, rejects a proposed automated ruling
    parseSafeGuardBundle(unsignedPsbtBase64: string): SafeGuardBundle   // pure parsing helper, no network call — SAFE_GUARD_EVM only
    // RFC-021 — two-person control for MULTISIG escrows. approveRelease() records the caller's approval; release() checks hasDualApproval() itself.
    approveRelease(escrowId: string): Promise<{ approval: ReleaseApproval; readyToRelease: boolean }>   // requires an active session
    getReleaseApprovals(escrowId: string): Promise<ReleaseApprovalsResult>   // requires an active session + trade party/assigned arbiter
    // Arbiter registration/profile are exposed by client.arbitration, not by client.settlement.
  }

  // Top-level exports (not under `settlement` above) — client-held-key
  // signing helpers, one per escrow type's wire format:
  generateEscrowKeypair(): EscrowKeypair   // raw secp256k1 keypair — MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM all use this same key format
  signEscrowPsbt(psbtBase64: string, privateKey: Uint8Array): string   // MULTISIG
  signEscrowArkTx(bundleJson: string, privateKey: Uint8Array): Promise<string>   // LIGHTNING_HODL
  signEscrowSafeUserOp(unsignedPsbtBase64: string, privateKey: Uint8Array): string   // SAFE_GUARD_EVM — added 2026-08-03 (UI-audit gap: parseSafeGuardBundle() could read a bundle's userOpHash but nothing could sign it, so a disputed SAFE_GUARD_EVM trade was stuck forever)

  // Sails OpenP2P (alias: trades) — advanced/direct use. The facade's
  // negotiate() method is experimental today; openp2p.chat(tradeId) is the
  // real working negotiation/chat path. Chat lives here — there is no separate
  // chat module.
  openp2p: {
    trade(offerId: string, amount: string): Promise<Trade>   // requires an active session — note the required amount, a real deviation from an earlier two-arg draft of this signature
    getTrade(tradeId: string): Promise<Trade>
    getTradeByIntent(intentId: string): Promise<Trade>
    updateTradeStatus(tradeId: string, status: 'ACTIVE' | 'CANCELLED'): Promise<Trade>   // requires an active session
    chat(tradeId: string, options?: WebSocketChannelOptions): WebSocketChannel   // requires an active session — real reconnect-with-backoff by default (2026-08-02); onConnectionStateChange() reports 'open'/'reconnecting'/'closed'
    getMessages(tradeId: string): Promise<Message[]>   // requires an active session
    reconcileTrade(tradeId: string, sinceMessageCreatedAt: Date | null): Promise<Message[]>   // requires an active session — RFC-011 client-side reconciliation, returns missed messages since the given timestamp
  }

  // Capability declaration/grants — RFC-005 (rfcs/RFC-005-capability-model.md),
  // real as of RFC-013 (rfcs/RFC-013-capability-registry-and-wallet-adapter.md).
  // Self-issued grants only today — a caller declares and grants
  // themselves scope over their own declared capabilities; a real
  // multi-party issuance flow (a module operator granting scope to an
  // agent it doesn't control) is separate follow-up work.
  capabilities: {
    register(input: { capabilityName: string; scope: string[]; constraints?: Record<string, unknown> }): Promise<CapabilityGrant>
    list(participantId: string): Promise<CapabilityGrant[]>
    revoke(grantId: string): Promise<void>
    // Convenience: derives scope directly from a WalletAdapter's own
    // getCapabilities() declaration instead of the caller re-assembling
    // it into a register() call by hand.
    ensureCanonicalGrants(participantId: string): Promise<CapabilityGrant[]>   // Issue #303 - idempotent onboarding
    registerFromWallet(wallet: WalletAdapter): Promise<CapabilityGrant>   // deprecated, Issue #303
  }

  // Sails OpenProof (RFC-006, RFC-007) — advanced/direct use; submitProof()
  // above is the path most applications should use to write evidence, this
  // namespace is for reading it back and managing proof lifecycle
  proof: {
    assertClaim(input: { claimType: string; assertion: unknown }): Promise<Proof>   // requires an active session
    submitProof(input: { claimId: string; evidence: unknown; claimedHash?: string }): Promise<Proof>   // requires an active session
    issueVerificationNonce(proofId: string): Promise<{ nonce: string }>   // requires an active session
    verifyProof(proofId: string, input: { verdict: 'ACCEPTED' | 'REJECTED'; nonce: string; reason?: string }): Promise<Proof>   // requires an active session
    getEvidenceBundle(claimId: string): Promise<EvidenceBundle>   // requires an active session — aggregates that Intent's Claims/Proofs/Verifications/Timeline/external references (RFC-007 D6)
  }
}
```

**Deviations found while implementing v0.1, not silently matched:**
- `createIntent(payload)` → real signature is `createIntent(type,
  payload, agentId?)` — `type` is required since more than one
  `IntentType` exists in the frozen shape even though only `TradeIntent`
  has a registered handler today; `agentId` is optional. **Closed since
  this section was first written:** a gap audit found `POST
  /api/v1/intents` accepted a bare `participantId` in the body with zero
  authentication — the route now derives it from the authenticated
  session (`requireAuth`) instead, the same pattern every other mutating
  route in this codebase uses, so `participantId` is no longer a caller
  argument at all. `createIntent()`/`cancelIntent()` both now send the
  real auth header — call `identity.authenticate()` (or
  `client.setSessionToken()`) first, same requirement every other
  authenticated SDK call already has.
- `openp2p.trade(offerId)` → real signature is `trade(offerId, amount)`
  — `POST /v1/openp2p/trades`'s body requires `amount`.

## 3. Fundamental Protocol Types (also part of `@sails/protocol-spec`)

```typescript
type Intent = TradeIntent | PaymentIntent | LoanIntent | SwapIntent | EarnIntent | AgentIntent

interface TradeIntent {
  type: 'trade'
  asset: AssetType
  side: 'BUY' | 'SELL'
  maxValue?: number
  minValue?: number
  currency?: string
  fiatMethod?: FiatMethod
  network?: Network
  slippageTolerance?: number
  // RFC-013 (rfcs/RFC-013-capability-registry-and-wallet-adapter.md) —
  // additive counterparty-matching constraint, not yet enforced during
  // matching (OpenLiquidity follow-up work) — this is the vocabulary.
  // kycRequired removed 2026-08-09 — this protocol does not do KYC.
  minReputationRating?: number // 0-5, mirrors ReputationScore's scale
}

// All six SettlementProvider types registered in src/modules/open-settlement/escrow.service.ts's PROVIDERS map.
// SAFE_GUARD_EVM (RFC-020) added 2026-07-28; previously absent here even though
// the EscrowType enum already had it — corrected by the same 2026-07-19
// consolidation audit that caught the WDK_USDT_EVM omission above.
type SettlementType = 'MOCK' | 'MULTISIG' | 'LIGHTNING_HODL' | 'LIQUID_COVENANT' | 'WDK_USDT_EVM' | 'SAFE_GUARD_EVM'

// RFC-005 (rfcs/RFC-005-capability-model.md) — the permission-grant side
// of the Capability model; real as of RFC-013. A 2026-07-19 audit
// claimed a field-name drift here (real API returns `id`, not
// `grantId`) — corrected 2026-08-01: that claim was wrong. It missed
// that core/capability-registry.ts's toCapabilityGrant() maps the
// Prisma row's `id` column to `grantId` before any response leaves the
// server — the real, live API has always returned `grantId`, exactly
// matching this interface. See PROTOCOL_SPECIFICATION.md §1.10 for the
// full correction.
interface CapabilityGrant {
  grantId: string
  grantedTo: string
  capabilityName: string
  scope: string[]
  constraints?: Record<string, unknown>
  issuedBy: string
}

// RFC-013 — optional `SailsClient` constructor argument. Lets a wallet's
// own signing/balance/address logic plug into the SDK; deliberately
// transport- and chain-agnostic (asset is a string key, tx/signedTx are
// unknown), same discipline SettlementProvider/TransportProvider already
// use server-side. `getPeerId()`, not `getNodeId()` — matches this
// codebase's own existing vocabulary (User.peerId, pearNodeRegistry).
interface WalletAdapter {
  getPeerId(): Promise<string>
  // Deliberate: one address per asset, not multi-address/HD rotation —
  // matches the server's own PayoutAddress table (@@unique([participantId,
  // asset])), which is what escrow settlement actually pays out to.
  // See wallet-adapter.ts's own comment for the full reasoning
  // (DX audit, 2026-08-10).
  getAddress(asset: string): Promise<string>
  getBalance(asset: string): Promise<string>
  signTransaction(asset: string, tx: unknown): Promise<unknown>
  broadcastTransaction(asset: string, signedTx: unknown): Promise<string>
  getCapabilities(): Promise<{
    assets: string[]
    fiatRails: string[]
    supportsP2PTrading: boolean
    supportsOnchainSettlement: boolean
  }>
  // Added 2026-08-02, required — lets identity.authenticateWithWallet()
  // sign the Ed25519 challenge-response flow without this SDK (or the
  // page it's running in) ever holding the raw secretKey. Generic on
  // purpose: works for an Ed25519 identity key, a secp256k1 one, or a
  // hardware-backed signer — the interface doesn't care which.
  signMessage(message: Uint8Array): Promise<Uint8Array>
}

interface ReputationScore {
  participantId: string
  total: number        // 0-100
  tradeScore: number
  volumeScore: number
  settlementScore: number
  disputeRate: number
}
```

Full definitions of `PaymentIntent`, `LoanIntent`, `SwapIntent`,
`EarnIntent`, `AgentIntent` payloads are in `PROTOCOL_SPECIFICATION.md`
section on the Intent Engine — copy them from there verbatim when
implementing the SDK types, do not redefine them independently.

`EvidenceBundle`, `EvidenceReference`, `Timeline`/`TimelineEntry`,
`ArbitrationProvider`, and `OperationalProfileGrant` (RFC-007,
`rfcs/RFC-007-real-world-p2p-requirements.md`) follow the same rule — copy
their shapes from `PROTOCOL_SPECIFICATION.md` §1.1/1.8/1.9 verbatim, they
are not redefined here.

---

## 4. Expected Usage (what "done" looks like)

**Missão 07.4 — this section used to keep its own copy of the full
identity → discover → trade → chat → escrow → release → reputation flow
here, in prose, unchecked by any compiler. That copy drifted from the
real SDK three separate times across Missões 07.1-07.3 (a wrong
`discover()` return shape, a `release()` call on an escrow type that
doesn't support it, a missing auth step) before anyone noticed, because
nothing ever ran it.** The fix isn't a fourth correction — it's not
keeping a second copy at all.

**`examples/simple-wallet/src/index.ts` is the canonical, continuously-
verified reference for this exact flow** — same ten steps, real
`@satsails/p2p-trading-sdk` package, real local node, `npx tsc --noEmit`
clean, and re-run against a live server as part of every Missão 07.x
pass. Read that file for the full flow with real error handling; run it
yourself with `npm run start -w @sails/example-simple-wallet`.

What's genuinely specific to *this* section — a minimal client, to show
the constructor shape, not the whole flow:

```typescript
import { SailsClient, generateKeypair } from "@satsails/p2p-trading-sdk"

const sails = new SailsClient({ baseUrl: "http://localhost:3000" })

const keypair = generateKeypair()
await sails.identity.create(keypair)
await sails.identity.authenticate(keypair) // required before any other call below

const matches = await sails.liquidity.discover({ asset: "BTC", side: "BUY", limit: 10, offset: 0 })
// discover() returns { offers, sources, total, hasMore } -- offers is
// the array, matches itself is not.
```

For the rest of the flow (trade → chat → escrow → mark payment →
release → reputation), see `examples/simple-wallet` — copying it here a
second time is exactly the duplication this fix removes.


## 4B. Internal SDK Layering (v7.4 — CTO review finding)

`SailsClient` (section 2) is the *public* interface — one flat object an
application imports. Internally, the SDK implementation should not be one
monolithic class behind that interface; it should be four layers, so that
adding a new module never requires touching the layers below it:

```
Wallet / Application
    ↓
Capability SDK    — checks/requests permissions before any call proceeds
                    (talks to the Capability Registry, ARCHITECTURE.md §1B)
    ↓
Intent SDK        — the createIntent/negotiate/submitProof/releaseAsset/
                    dispute/cancelIntent facade (API_REFERENCE.md §0)
    ↓
Protocol SDK       — module-specific methods (identity, reputation,
                    liquidity, settlement, openp2p) — what section 2's
                    interface calls "advanced/direct use"
    ↓
Transport          — HTTP/WebSocket client, retry logic, auth headers
```

**Why this ordering matters:** when Sails OpenFinance ships, its
`LoanIntent`/`EarnIntent` methods only need to be added at the Protocol SDK
layer — the Capability SDK, Intent SDK, and Transport layers underneath
need zero changes. This is the same "additive, never breaking" discipline
`moduleId`/`protocolVersion` enforces at the database level
(`DATABASE.md` section 1), applied to the SDK's own internal structure.

## 4C. Wallet Stack Compatibility (illustrative — WalletAdapter is real, most rows below are not)

`WalletAdapter` (section 3, real as of RFC-013,
`rfcs/RFC-013-capability-registry-and-wallet-adapter.md`) is deliberately
transport- and chain-agnostic, so it can sit in front of any wallet's own
signing stack. The canonical non-mock reference implementations and
end-to-end signing-boundary flows live in
[`examples/wallet-integration`](../examples/wallet-integration).

That reference is the next step after `examples/simple-wallet`: the
simple-wallet proves the SDK path; wallet-integration proves that a wallet
can keep its own signing/key ownership while plugging into Sails through
`WalletAdapter`.

This table is a roadmap/positioning reference for what that looks like
across common wallet toolkits — **only the interface itself, the explicit
non-mock examples above, and the reference implementation's documented
real paths are evidence of implementation; every compatibility target in
this table remains classified by its own status.** Do not cite this table
as evidence that unimplemented BDK/LDK/mobile adapters exist.

| SDK Toolkit | Primary Language | Asset Focus | Typical Fit | Status |
|---|---|---|---|---|
| WDK (Tether Wallet Development Kit) | TypeScript/JS | BTC, stablecoins, EVM assets | Corporate/consumer wallets, agent-driven automation | 🟢 Reference implementation (`wdk-settlement.provider.ts`, real signed testnet transfers) |
| BDK (Bitcoin Dev Kit) | Rust | Bitcoin on-chain | Security-focused/multisig wallets | 📋 Compatible in principle — no `WalletAdapter` implementation exists yet |
| LDK (Lightning Dev Kit) | Rust/C++ | Bitcoin Lightning | Instant/micro payments | 📋 Compatible in principle — Lightning would be exposed as a `WalletAdapter`-declared capability, not built |
| EVM wallet SDKs | TypeScript/Solidity | ERC-20 tokens | Web3/DApp wallets | 📋 Compatible in principle — no generic EVM-toolkit adapter is claimed by this row; use `examples/wallet-integration` for the repository's explicit non-mock EVM reference |
| Mobile SDKs | Kotlin/Swift | Whatever the host wallet supports | Consumer mobile wallets | 📋 Compatible in principle — `@satsails/p2p-trading-sdk` itself is JS/TS only (SDK_GUIDE.md section 6); a mobile wallet would bridge to it, not run it natively |
| Custodial APIs | Any | Custodial assets | Fintechs, OTCs, banks | 📋 Compatible in principle — a custodial `WalletAdapter` would need its own `CapabilityGrant` constraints (RFC-013) marking custody, not modeled yet |

## 4D. Retry, Timeout, and Rate Limiting (DX audit, 2026-08-10 — previously undocumented)

`SailsTransport` (`transport.ts`) handles this once, for every module —
callers never see raw `fetch`/`WebSocket` or write their own retry loop.

- **Timeout**: every request gets a real `AbortController`-backed
  timeout, `timeoutMs` (default 15000ms).
- **Retry — GET only**: `POST`/`PATCH`/`DELETE` are never auto-retried
  — this backend has no client-generated idempotency-key mechanism, so
  a retried mutating call after a timeout can't be told apart from "the
  first attempt actually succeeded, this is now a duplicate." `GET`
  requests retry automatically (`maxRetries`, default 2) on `502`/`503`/
  `504` (transient infra failures) and on **`429`** — using the real
  `Retry-After` header the server's `@fastify/rate-limit` sends (see
  `API_REFERENCE.md` §9's `RATE_LIMIT_EXCEEDED` row) when present,
  falling back to exponential backoff with jitter otherwise.
- **A `POST`/`PATCH`/`DELETE` that hits 429** is not retried
  automatically (same rule as any other mutating request) — it throws a
  `SailsRateLimitError` (`errors.ts`, `code: 'RATE_LIMIT_EXCEEDED'`,
  `statusCode: 429`); `catch` it specifically (`instanceof SailsRateLimitError`)
  to back off before your own retry.

## 5. Build Plan (roadmap-linked — see `ROADMAP.md` for exact timing)

1. **Meses 1-3**: `@sails/protocol-spec` npm package published — just the
   types and interfaces above, zero implementation. **Still not started**
   — `packages/sails-sdk/src/types.ts` currently defines its own response
   types locally (that file's own header explains why: reconciling them
   with `@satsails/p2p-schemas`'s differently-shaped `OfferSchema` is real,
   separate follow-up work, not done silently as part of v0.1).
2. **Meses 4-6**: `@satsails/p2p-trading-sdk` v1.0 — a real HTTP/WebSocket client
   implementing `SailsClient` against the namespaced `/v1/{module}/` API
   described in `API_REFERENCE.md`. **v0.1 landed 2026-07-17**, ahead of
   this doc's own roadmap timing — Transport + Protocol SDK layers are
   real and tested (`packages/sails-sdk/tests/`, 46 tests as of 2026-08-07: real
   `tweetnacl` Ed25519 signing verified against `auth.ts`'s exact byte
   encoding, every module's request shape checked against its real
   route). Intent facade is partial (see section 2's note above and
   `intent-facade.ts`'s header); `negotiate` remains the explicit
   experimental gap. Current frozen-vs-additive-vs-experimental contract
   truth is owned by `API_STABLE.md`, not by this roadmap paragraph.
3. **Meses 7-9 / 10-12**: SDK support for `AgentIntent` (OpenAgents) and
   `LoanIntent`/`SwapIntent`/`EarnIntent` (OpenFinance) as those modules
   ship specs.

## 6. Constraints for Whoever Builds This

- TypeScript-first. No required constructor arguments beyond `wdk` and
  `network` — sane defaults for everything else.
- Must work in both Node.js and browser environments (the reference wallet
  is a consumer-facing app).
- Must not hardcode `localhost:3000` — base URL is configurable.
- Errors thrown by the SDK should be typed subclasses matching the
  `AppError` hierarchy in the reference implementation, not raw HTTP error
  objects — see `API_REFERENCE.md` section 9 for the response shape to wrap.
