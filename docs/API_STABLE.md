# @satsails/p2p-trading-sdk — Stable API (pre-v1 compatibility contract)

> **Role in the canonical developer journey (Missão 07.4):** "the
> version/freeze contract." Not a tutorial — read this to know exactly
> what will and won't change under you before v1. If any other doc
> (`API_REFERENCE.md`, `SDK_GUIDE.md`) disagrees with this one on an SDK
> method's real shape, this document wins.

This is the CTO-directed SDK hardening commitment. It originated with the v0.1 freeze and continues to govern the current pre-v1 package line (repository package currently 0.2.0):
now that `@satsails/p2p-trading-sdk` is the primary product surface, the goal is no
longer "add more" — it's "make every name below safe for a wallet to
build against and never have it move." Everything listed here is public,
stable, real (not aspirational — verified against the actual source
files at the paths given, not against older prose docs known to have
drifted, see SDK_GUIDE.md's/liquidity.ts's own header comments), and
tested.

## The freeze commitment

**No breaking changes to anything in this document until v1.** That
means, for every name below: the property will keep existing on
`SailsClient`, will keep pointing at a module with these methods, and
those methods' parameter/return shapes will not change incompatibly.
New optional parameters, new methods, and new modules may be added —
those are additive, not breaking. If a real design mistake is found
before v1 that genuinely requires a breaking change, it will be called
out explicitly as an exception here, not made silently.

**Tier legend (Missão 07.4)** — every method below is tagged with one of:
- 🔒 **FROZEN** — the freeze commitment above applies in full; a
  parameter/return shape change here is a breaking change.
- ➕ **ADDITIVE** — real and callable today, but explicitly not yet
  frozen (usually because its shape is still expected to gain fields,
  same category `releaseAsset` and `proposeTrade` were in before they
  stabilized). Safe to build against; expect only additive changes, not
  removals, before it graduates to 🔒.
- 🧪 **EXPERIMENTAL** — real, but throws/behaves as an explicit
  placeholder today (`negotiate`) rather than doing the thing its name
  suggests. No freeze commitment at all; the shape itself may change,
  not just gain fields.
Untagged methods are 🔒 FROZEN by default (the pre-existing surface covered by the original v0.1 freeze) — only methods added or reclassified since Missão 02.5
onward carry an explicit tag, to avoid re-annotating the entire document.

## Two names, one client — why

Different integrators reach for different vocabulary. A developer
building specifically for the P2P trading vertical thinks in
"offers/trades/escrow." A developer coming from general wallet/fintech
SDKs (Auth0, Stripe-style) thinks in "auth." Both should land on working
code without learning protocol-internal module names first — so every
module below has a **protocol name** (matches this repo's own
`src/modules/open-*` folder names, RFC-accurate) and, where one makes
sense, a **friendly alias**. An alias is not a separate module and is
never "the old name being deprecated" — `sdk.auth` and `sdk.identity`
are the literal same object (`packages/sails-sdk/src/client.ts`,
enforced by `packages/sails-sdk/tests/client.test.ts`'s
`client.auth === client.identity`-style assertions). Both names are
frozen together, permanently, since the original v0.1 freeze.

Every property listed below (both names, in every pair) carries its own
JSDoc `@see`/alias pointer in `packages/sails-sdk/src/client.ts`, which
`tsc`'s `declaration: true` output preserves into the published
`.d.ts` — so hovering `sdk.auth` in an editor shows "alias for
`sdk.identity`, same instance" directly, without needing this document
open. The goal: two names in autocomplete should never be confusing,
only convenient.

One deliberate non-alias: `reputation` has **no** `profile` alias. This
module only returns a numeric trust score plus a leaderboard and rating
submission (`get`/`leaderboard`/`rate`) — it has no displayName, avatar,
or trade history (that data lives on `identity`). Calling it `profile`
would promise more than it returns, so the friendly name is
`trustScore` instead — it says what the module actually is.

## Modules

| Protocol name | Friendly alias | Source | What it does |
|---|---|---|---|
| `sdk.identity` | `sdk.auth` | `modules/identity.ts` | Register a Participant, Ed25519 challenge-response auth, session management |
| `sdk.liquidity` | `sdk.offers` | `modules/liquidity.ts` | Publish/discover/manage Offers, the order book |
| `sdk.openp2p` | `sdk.trades` | `modules/openp2p.ts` | Open/manage a Trade, real-time chat (`sdk.trades.chat(tradeId)` — chat has no separate module or alias, it lives here) |
| `sdk.settlement` | `sdk.escrow` | `modules/settlement.ts` | Escrow lifecycle: create, lock, release, refund, dispute |
| `sdk.reputation` | `sdk.trustScore` | `modules/reputation.ts` | Reputation score, leaderboard, rating submission |
| `sdk.peers` | — | `modules/peers.ts` | P2P transport node (start/stop, topic/trade rooms, direct offer broadcast) |
| `sdk.capabilities` | — | `modules/capabilities.ts` | RFC-013 Capability Registry: register/list/revoke capability grants |
| `sdk.arbitration` | — | `modules/arbitration.ts` | RFC-021 D2 permissionless arbiter registration — only meaningful when the server runs `ARBITRATION_MODE=market` |
| `sdk.paymentAccounts` | — | `modules/payment-account.ts` | RFC-021 D5 payment-account trust ramp (register/get/sign) |
| `sdk.proof` | — | `modules/proof.ts` | OpenProof: assert claims, submit proofs, verify, read evidence bundles |
| `sdk.agents` | — | `modules/agents.ts` | OpenAgents: QVAC-backed structured Intent/Offer generation and risk assessment from a plain-language goal (real local LLM — see Missão 07.3's QVAC truthfulness note in `SDK_GUIDE.md`) |
| `sdk.intents` (private; see below) | — | `intent-facade.ts` | The Intent-oriented facade — SDK_GUIDE.md's original six canonical verbs, plus `proposeTrade`/`proposeTradeOutcome` (RFC-023) |

`arbitration`/`paymentAccounts`/`proof`/`agents` have no friendly alias
(none read as more natural in either integrator vocabulary than the
protocol name itself) — same reasoning `peers`/`capabilities` already
had. **Documentation gap closed here, not a code change**: all four have
existed as real, wired `SailsClient` properties (`client.ts`) since
before this document was last updated — this table was simply never
kept in sync (found during Missão 07's golden-path audit).

`sdk.peers` and `sdk.capabilities` have no friendly alias — both names
are already the plain-English word for what they do; a second name
would just be a synonym, not a real accessibility gain.

## Method inventory

### `identity` / `auth`
- `create(keypair?, displayName?)` → `{ participant, keypair }`
- `createWithWallet(publicKeyHex, wallet, displayName?)` → `Participant` *(wallet-backed registration with proof of possession via `wallet.signMessage()`; Issue #302, 2026-09-20 — additive)*
- `registerChallenge(publicKeyHex)` → `{ challenge, expiresIn }` *(Issue #302, additive)*
- `createWithPublicKey(publicKeyHex, displayName?)` → `Participant` *(**deprecated 2026-09-20, Issue #302**: the server now requires proof of possession, which this signature cannot produce — use `createWithWallet()`; wallet-backed registration — no keypair object, no secretKey; closes `PRODUCTION_READINESS_REVIEW.md`'s finding #3, 2026-08-02)*
- `get(participantId)` → `PublicParticipant` *(public lookup of another participant — narrowed from `Participant` Missão 11 Fase 9.3.5, INV-OP-10: no reputation stats, no bookkeeping fields; use `reputation.get(participantId)` for reputation facts. `me()` below is unaffected — authenticated, self-referential, stays full `Participant`)*
- `me()` → `Participant` *(requires session)*
- `challenge(publicKeyHex)` → `{ challenge, expiresIn }`
- `authenticate(keypair)` → `{ participantId, sessionToken }` — also stores the session on the client
- `authenticateWithWallet(publicKeyHex, wallet)` → `{ participantId, sessionToken }` *(wallet-backed sign-in — `wallet: { signMessage(message: Uint8Array): Promise<Uint8Array> }`, never touches a raw secretKey; same session-storage side effect as `authenticate()`)*
- Standalone helper: `generateKeypair()` (not a method — a top-level SDK export)

### `liquidity` / `offers`
- `discover({ asset, side, limit?, offset?, paymentMethod?, priceMin?, priceMax? })` → `{ offers, sources, total, hasMore }` (`limit`/`offset` added 2026-07-20, historical SDK hardening record — default `limit` 10, max 50; `total`/`hasMore` and the three filter params were already real but missing from this line — Missão 07.4 doc-sync fix, no code change; `total`/`hasMore` also fixed to be *correct*, not just present, by Missão 07.1's pagination bug fix)
- `getOffer(offerId)` → `Offer & { user: Participant }`
- `publish(input)` → `Offer` *(requires session)*
- `book(asset)` → `OrderBook`
- `updateStatus(offerId, status)` → `Offer` *(requires session)*
- `match({ asset, side, amount })` → `LiquidityOfferSummary | null`
- `getMyOffers()` → `Offer[]` *(requires session; additive, 2026-08-01 —
  the authenticated caller's own offers including non-ACTIVE ones, real
  `Offer` rows, not the `LiquidityOfferSummary` aggregation shape
  `discover()`/`book()` return. Added for a real caller,
  `packages/sails-ui`'s Profile screen — `GET /v1/liquidity/offers/mine`)*

### `openp2p` / `trades`
- `trade(offerId, amount)` → `Trade` *(requires session)*
- `getTrade(tradeId)` → `Trade`
- `getTradeByIntent(intentId)` → `Trade`
- `updateTradeStatus(tradeId, status)` → `Trade` *(requires session)*
- `getMessages(tradeId)` → `Message[]` *(requires session)*
- `chat(tradeId, options?)` → `WebSocketChannel` *(requires session)* — `.onMessage()`, `.onEvent()`, `.send()`, `.leave()`, `.close()`, `.onConnectionStateChange()`. Real reconnect-with-backoff by default as of 2026-08-02 (`options: WebSocketChannelOptions` — additive, `chat()`'s own signature was never frozen beyond its return type); `WebSocketChannel`'s own constructor changed shape (a socket factory, not a bare `WebSocket`) to make that possible — a disclosed, deliberate exception, not something `chat()` callers ever see

### `settlement` / `escrow`
- `create(input)` → `Escrow` *(requires session)*
- `get(escrowId)` → `Escrow` *(requires session + trade party/assigned arbiter — was a public read until Missão 06.8 closed a real privacy gap; this line was stale until Missão 07.4)*
- `submitKey(escrowId, pubkeyHex)` → `{ escrow, buyerKeySubmitted, sellerKeySubmitted }` *(requires session; MULTISIG/LIGHTNING_HODL client-held-keys path)*
- `lock(escrowId)` → `Escrow` *(requires session)*
- `markPaymentSent(escrowId)` → `Escrow` *(requires session)*
- `release(escrowId, toAddress)` → `Escrow` *(requires session; `toAddress` is accepted for source compatibility only — undocumented on this line until 2026-09-13, P3-F06/Pre-M3 Reality Gate: M8-R2, 2026-09-11, made the server ignore any caller-supplied value and always resolve the buyer's own registered `PayoutAddress` instead, closing the caller-supplied-execution-time-destination pattern `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` Model E rejects. Passing it has no effect; kept in the signature only so existing call sites don't break.)*
- `dispute(escrowId, reason, evidence?)` → `Dispute` *(requires session)*
- `refund(escrowId)` → `Escrow` *(requires session)*
- `initiateRelease(escrowId, toAddress)` → `EscrowPendingTransaction` *(requires session; MULTISIG multi-signer release, does not itself move funds. `toAddress` — same accepted-but-inert status as `release()`'s own above, undocumented on this line until 2026-09-13, P3-F06/Pre-M3 Reality Gate: the buyer's registered `PayoutAddress` is resolved and persisted onto the pending transaction at this call and never re-resolved afterward, so a later `PayoutAddress` rotation cannot change where an already-initiated release pays out.)*
- `initiateRefund(escrowId)` → `EscrowPendingTransaction` *(requires session; mirror of `initiateRelease`)*
- `submitTransactionSignature(escrowId, signedPsbtBase64)` → `{ complete }` *(requires session)*
- `getPendingTransaction(escrowId)` → `EscrowPendingTransaction` *(requires session + trade party/assigned arbiter — corrected 2026-09-13, P3-F01/Pre-M3 Reality Gate: this line previously carried no auth annotation at all, describing the method as if it took none, while the server route had independently required `requireAuth` + party/arbiter scoping since "Missão 07.6" — the SDK method itself did not send the session token until this same correction, so every real caller 401'd unconditionally until now. Throws `SailsNotFoundError` if no signing round is in flight for this escrow — a genuine absence, not an error.)*
- `getReleaseApprovals(escrowId)` → `ReleaseApprovalsResult` (`{ approvals: ReleaseApproval[], readyToRelease: boolean }`) *(requires session + trade party/assigned arbiter — undocumented on this line until 2026-09-13, P3-F02/Pre-M3 Reality Gate: same class of gap as `getPendingTransaction()` above, same fix, same date)*
- `approveRelease(escrowId)` → `{ approval: ReleaseApproval, readyToRelease: boolean }` *(requires session; RFC-015 two-person control — records the caller's own approval for a MULTISIG release; undocumented on this line until 2026-09-13, Pre-M3 Reality Gate documentation sweep — the method itself already sent auth correctly, only this doc's own coverage was missing)*
- `listDisputes(pagination?)` → `PaginatedDisputes` *(requires session; UI-audit gap closed 2026-08-03 — always scoped to the caller's own arbiterId, never a client-supplied filter)*
- `getDispute(disputeId)` → `Dispute` *(requires session + trade party/assigned arbiter — was a public read until Missão 06.8; this line was stale until Missão 07.4, same as `get()` above)*
- `resolveDispute(disputeId, ruling, releaseToAddress?, refundToAddress?, splitBuyerBps?, authoritySignature?, authorityIssuedAt?)` → `Dispute` *(requires session + assigned arbiter; `releaseToAddress`/`refundToAddress`/`splitBuyerBps` — both required together, only for `ruling: 'SPLIT'`, RFC-021 D9. Missão 13 Fase 2 (INV-12, 2026-08-29) added the two trailing params, additive per this doc's own freeze commitment: the server now independently verifies a signed authority decision before executing any ruling, so these two are effectively required in practice — omitting them throws a clear client-side `SailsValidationError` rather than sending a request the server would reject anyway. Most callers should use `resolveDisputeWithWallet()` below instead of constructing the signature by hand.)*
- `resolveDisputeWithWallet(disputeId, ruling, wallet, releaseToAddress?, refundToAddress?, splitBuyerBps?)` → `Dispute` *(requires session + assigned arbiter; Missão 13 Fase 2, new method — fetches the dispute, builds the canonical authority decision (`canonicalizeAuthorityDecision()`/`hashAuthorityDecision()`, also exported), and asks `wallet.signMessage()` to sign it before calling `resolveDispute()`. The caller's private key never leaves their own `WalletAdapter`, same shape as `proof.attachEvidence()`.)*
- `appealDispute(disputeId)` → `{ dispute, appealFeeRequired }` *(requires session + trade party; RFC-021 D6, market arbitration mode only)*
- `submitDisputeEvidence(disputeId, descriptor)` → `Dispute` *(requires session + trade party; RFC-021 D8, may trigger a QVAC auto-resolution attempt server-side)*
- `contestAutoResolution(disputeId)` → `Dispute` *(requires session + trade party; RFC-021 D8, rejects a proposed automated ruling)*
- `parseSafeGuardBundle(unsignedPsbtBase64)` → `SafeGuardBundle` *(pure parsing helper, no transport call; SAFE_GUARD_EVM only — decodes the Safe Guard deployment info a `create()`/`initiateRelease()` response carries for that escrow type)*
- `signEscrowSafeUserOp(unsignedPsbtBase64, privateKey)` → `string` *(top-level SDK export, not a `settlement` method — same client-held-key pattern as `signEscrowPsbt()`/`signEscrowArkTx()`; produces a `0x`-prefixed 65-byte ECDSA signature over the bundle's `userOpHash`, ready for `submitTransactionSignature()`; UI-audit gap closed 2026-08-03 — SAFE_GUARD_EVM disputes were previously stuck forever with no way to actually produce this signature client-side)*
- `setPayoutAddress({ asset, address })` → `PayoutAddress` *(requires session; missing from this line until Missão 07.4 — real since the "Participant payout address" gap closed)*
- `getPayoutAddress(participantId, asset)` → `PublicPayoutAddress` *(requires session, self-scoped — corrected 2026-09-13, F-06/System Coherence & Integration Audit: previously documented here as public/no-session, which described no real caller — every real release path resolves the beneficiary's own registered address server-side, and this SDK's own only real consumer always calls it with the logged-in user's own id. Missão 11 Fase 9.3.4: narrowed from `PayoutAddress` — no `id`/`createdAt`/`updatedAt` here, ever; only `participantId`/`asset`/`address`, the committed payout destination itself — unaffected by the auth correction)*

### `arbitration`
- `register(monetaryCollateral, collateralAsset?)` → `ArbiterCandidate` *(requires session; registers or tops up the caller's own ArbiterProfile — permissionless, no approval step)*
- `getProfile(participantId)` → `ArbiterCandidate` *(no session required; throws `SailsNotFoundError` if this participant never registered)*

### `paymentAccounts`
- `register(accountHash, paymentMethod)` → `PaymentAccount` *(requires session; idempotent for an already-registered hash — hash the raw account identifier client-side first via the top-level `hashPaymentAccount()` export, never send the raw value)*
- `get(accountHash)` → `PublicPaymentAccount` *(no session required — deliberately public-by-hash, RFC-021 D5's own age-witness design. Missão 11 Fase 9.3.1: narrowed from `PaymentAccount & { tradeLimit }` — no `ownerId`/`signedBy`/`id` here, ever. Verifying a payment rail's trust history never requires knowing which platform identity owns or attested it — see `docs/SECURITY_MODEL.md`'s privacy-boundary section)*
- `sign(accountHash)` → `PaymentAccount` *(requires session; RFC-021 D1 — attests a specific completed trade, not a general vouch for the account owner)*

### `proof`
- `assertClaim(input)` → `Proof` *(requires session; `input: { claimType, assertion, tradeId? }`)*
- `submitProof(input)` → `Proof` *(requires session; `input: { claimId, evidence, claimedHash? }` — distinct from the top-level Intent-facade `submitProof(intentId, proof)` below, same name, different module)*
- `issueVerificationNonce(proofId)` → `{ nonce }` *(requires session)*
- `verifyProof(proofId, { verdict, nonce, reason? })` → `Verification` *(requires session)*
- `getEvidenceBundle(claimId)` → `EvidenceBundle` *(requires session)*
- `attachEvidence(proofId, media, mimeType, wallet)` → `EvidenceReference` *(requires session + a `WalletAdapter`; signs the media's own sha256 digest client-side, RFC-007 D2)*
- `anchorEvidence(evidenceReferenceId)` → `EvidenceReference` *(requires session; submits to a real, live OpenTimestamps calendar server — a genuine network call/cost, not automatic)*
- `getTradeEvidenceBundle(tradeId)` → `TradeEvidenceBundle` *(requires session + trade party — was a public read until Missão 06.6 closed a real privacy gap; SDK call itself didn't send auth until Missão 07.1 fixed it)*

### `agents`
➕ **ADDITIVE** (real since the `open-agents` module shipped, not yet
carrying the same multi-mission stability history as the original v0.1
surface). Missão 07.3 truthfulness note applies to all three: each is a
single, real local-LLM call (QVAC, llama.cpp) — none of them negotiate,
converse with a counterparty, or hold state across calls.
- `generateTradeIntent(goal)` → `GeneratedTradeIntent` *(requires session; real QVAC call)*
- `generateOfferIntent(goal)` → `GeneratedOfferIntent` *(requires session; real QVAC call)*
- `assessIntentRisk(intent)` → `IntentRiskAssessment` *(requires session; real QVAC call)*

### `reputation` / `trustScore`
- `get(participantId)` → `ReputationScore` *(exception per this doc's own freeze-commitment clause, Missão 11 Fase 9.3.6: `ReputationScore` has declared `id`/`publicKey`/`displayName`/`reputationScore`/`disputeCount` since the SDK's first commit — none of which `reputation.service.ts`'s real `getScore()` has ever actually returned. Corrected to the real, always-been-true wire shape — `participantId`/`total`/`tradeScore`/`volumeScore`/`settlementScore`/`disputeRate`/`totalTrades`/`cumulativeFeesObserved` — a PRE-LAUNCH BREAKING API CORRECTION, no version bump, not published. A caller wanting displayName/publicKey calls `identity.get()` separately, same composition pattern `sails-ui`'s Trade page and `sdk-react`'s `ReputationBadge` now both use)*
- `leaderboard(pagination?: { limit?, offset? })` → `LeaderboardResult` (`{ items, total, hasMore, nextOffset }`, each `items[]` entry a `LeaderboardEntry`, not the full `ReputationScore` shape — stale signature/return type fixed here Missão 07.4, no code change)
- `rate(input)` → informational only, does not affect the score `get()` returns *(requires session)*
- `vouchFor(voucheeId)` → `Vouch` *(requires session; RFC-021 D7 peer vouching — caller must have real trade history, own reputation is slashed if the vouchee's first payment account is later abused)*

### `peers`
- `start(secretKeyBase64)` → `{ peerId }`
- `stop()` → `void`
- `status()` → `PeerStatus`
- `joinTopic(topic)` → `void`
- `joinTrade(tradeId)` → `void`
- `broadcastOffer(input)` → `{ deliveredTo }`

### `capabilities`
- `register(input)` → `CapabilityGrant`
- `list(participantId)` → `CapabilityGrant[]`
- `revoke(grantId)` → `void`
- `ensureCanonicalGrants(participantId)` → `CapabilityGrant[]` *(Issue #303, additive: idempotent self-issued onboarding of the canonical `trade-coordination` + `settlement` grants)*
- `registerFromWallet(wallet)` → `CapabilityGrant` *(**deprecated 2026-09-21, Issue #303**: ignores the wallet's technical capabilities and self-issues both canonical grants; returns the `trade-coordination` one)*

### Top-level (Intent facade, delegated straight off `SailsClient`)
🔒 `createIntent`, `cancelIntent`, `dispute`, `submitProof(intentId,
proof)`, and `releaseAsset(intentId, toAddress)` are all real as of
2026-08-01 — the last two were previously believed blocked
(`submitProof` on a missing Proof-primitive route that turned out to
already exist; `releaseAsset` on a missing `toAddress` parameter, now
added). `releaseAsset` gaining a required `toAddress` parameter is this
document's own precedent for why that kind of change is additive, not
breaking, for these six-verb methods specifically.

🧪 **EXPERIMENTAL** — `negotiate` still throws `SailsNotImplementedError`
unconditionally — the canonical fire-and-forget signature can't
represent the real `WebSocketChannel` negotiation channel
(`intent-facade.ts`'s own header has the full reasoning; use
`openp2p.chat(tradeId)` for the real, working channel today). Not
frozen — its throw-vs-real status, and even its shape, are expected to
change before v1. Per Missão 07.3's QVAC-truthfulness pass: this is not
"AI negotiation" that's merely unimplemented — no version of this
protocol has ever done interactive agent-to-agent negotiation; see
`proposeTrade`/`proposeTradeOutcome` below for what QVAC-assisted
discovery actually does today.

🔒 **FROZEN** — `proposeTrade(intentId, amount)` → `TradeProposal | null` — a 7th
top-level delegate, **not** part of the original six-verb facade above
(RFC-023, `rfcs/RFC-023-qvac-negotiated-trade-proposal.md`). Given a
persisted TradeIntent's own declared `maxPriceUsd`/`minPriceUsd`/
`minReputationRating`, finds a real matching `Offer` and returns it for
the caller to approve — `null` is a legitimate "nothing matched within
your limits" outcome, not an error. Never creates a `Trade` and has no
authority over escrow/settlement; approve a returned proposal by calling
the existing, unmodified `openp2p.trade(proposal.offerId, amount)`
directly. **This method's return type is frozen as-is** — it cannot
represent a `counterProposal` without a breaking change, which is exactly
why the method below exists instead of extending this one in place.

➕ **ADDITIVE** — `proposeTradeOutcome(intentId, amount)` → `{ proposal, counterProposal }`
— an 8th delegate, added Missão 02.5 (2026-08-15), calling the exact same
route as `proposeTrade` above but returning everything the route sends
back. `counterProposal` (`referenceOfferId`/`listedPriceUsd`/
`suggestedPriceUsd`/`reasoning`) is populated only when no real `Offer`
cleared every limit but one cleared amount/reputation and missed only on
price — `suggestedPriceUsd` is always exactly the Intent's own declared
bound, never worse than what the caller already authorized. Informational
only: `referenceOfferId` is not accepted by `openp2p.trade()` or any
other trade-creation/settlement call — trading against it directly still
executes at its own *listed* price. Not yet frozen (new this pass, same
as `proposeTrade` was when it first shipped); expected to stabilize
alongside it.

### Escape hatch
`setSessionToken(token)` / `getSessionToken()` — direct session control,
shared by every module and every alias (same transport underneath).

## What "v1" means for this document

Once the integration-test and dogfooding passes (historical SDK hardening record and
its follow-ups) are done and this SDK has had real external usage, `0.1`
becomes `1.0` and this document's freeze becomes the literal SemVer
contract: a breaking change to anything above requires a major version
bump. Nothing here changes about how frozen it already is — v0.1 is
being held to the same bar starting now, deliberately, so there is no
last-minute scramble of breaking changes right before the version
number changes.
