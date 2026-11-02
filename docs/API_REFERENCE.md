# API_REFERENCE.md
### Sails Protocol — Detailed Reference API

> **Authority / status:** detailed Reference Implementation API/reference surface. For the frozen public SDK method contract, `API_STABLE.md` wins. For current route existence, authentication and behavior, current implementation/tests win over historical route notes in this file.
>
> Base URL (reference implementation, local dev): `http://localhost:3000`
>
> **Role in the canonical developer journey (Missão 07.4):** "the
> detailed reference" — every field and edge case. Not where to start;
> start at `docs/GETTING_STARTED.md` or `examples/simple-wallet`. If
> this document and `docs/API_STABLE.md` ever disagree on an SDK method
> shape, `API_STABLE.md` is the frozen contract — trust it.

---

## 0. The API Is Intent-Oriented, Not Resource-Oriented (v7.2 — CTO review finding)

**This is the single most important correction in this document.** An
earlier version of this API was designed around module resources —
`POST /v1/settlement/escrow`, `POST /v1/openp2p/trades` — which mirrors
how the reference implementation's database is organized, not how the
protocol thinks. That is backwards. Per Principle 2 (`PRINCIPLES.md`,
"Intent Driven"), every application-facing interaction should read as an
Intent-lifecycle verb, never as a module-specific CRUD action.

**Wrong (what this document used to imply):**
```typescript
const trade = api.createTrade(offerId, amount)
const result = api.buyBitcoin(sellerId, amount)
```

**Right (what any SDK or direct API integration must expose):**
```typescript
const intent = protocol.openP2P.createIntent({ asset: 'BTC', side: 'BUY', maxValue: 2000 })
protocol.negotiate(intent.id, { type: 'MESSAGE_EXCHANGED', by: myId, content: 'Sending payment now', at: now() })
protocol.submitProof(intent.id, { claimType: 'payment_sent', evidence: '...' })
protocol.releaseAsset(intent.id)
protocol.dispute(intent.id, { reason: '...' })
protocol.cancelIntent(intent.id)
```

This is the protocol's own conceptual verb shape, not a literal copy-paste
of `@satsails/p2p-trading-sdk` today (Missão 07.3 note, 2026-08-16):
**`negotiate()` currently throws `SailsNotImplementedError`** — the
canonical single-call signature can't represent the real negotiation
channel, which is a persistent `WebSocketChannel`
(`openp2p.chat(tradeId)`), not a fire-and-forget event. Use
`openp2p.chat(tradeId)` directly for the real, working channel; see
`docs/API_STABLE.md`'s own note that `negotiate` is deliberately not
frozen while this gap is open. Every other verb in this example
(`createIntent`/`submitProof`/`releaseAsset`/`dispute`/`cancelIntent`) is
real and callable as shown.

### Canonical Intent Verbs

| Verb | Maps to (internally) | Primitive it invokes |
|---|---|---|
| `createIntent` | `POST /v1/{module}/intents` | Intent (`PROTOCOL_SPECIFICATION.md` §1.2) |
| `cancelIntent` | `PATCH /v1/{module}/intents/:id` (status → CANCELLED) | Intent |
| `negotiate` | **Not implemented in the SDK today** — throws `SailsNotImplementedError`; use `openp2p.chat(tradeId)`'s real `WebSocketChannel` instead | Negotiation (§1.4) |
| `submitProof` | Submits a `Proof` — `claimType` is open-ended (`payment_sent`, `invoice_paid`, `oracle_verified`, `delivery_confirmed`, `collateral_held`, ...), never hardcoded at the API level | Proof (§1.8) |
| `releaseAsset` | `POST /v1/settlement/escrow/:id/release` | Settlement (§1.5) |
| `dispute` | `POST /v1/settlement/escrow/:id/dispute` | Dispute (§1.9) |

**RFC-007 note:** an escrow's status is *designed* to eventually pass
through `PENDING_BANK_SETTLEMENT` between `payment-sent` and `release`
(§4 below) — a payment held/processing at the payer's financial
institution, not a failure state — but this value has not actually been
migrated into the real `EscrowStatus` enum yet (`DATABASE.md`, noted
2026-07-19). `dispute` now resolves through an explicit escalation order
(Policy Engine → OpenAgents → a Trusted Arbitrator via
`ArbitrationProvider` → Settlement) before ever reaching human
arbitration — the verb and its route are unchanged, only what happens
internally after the call.

**Revision note (Protocol Freeze, v8.3):** this verb table used to have
`confirmFiat`, hardcoding one specific `claimType` (`payment_sent`) into
the top-level API surface — a P2P-trading-specific leak into what's
supposed to be the universal Intent interface, flagged by the Protocol
Quality Review and confirmed correct. `submitProof` replaces it: a
`SwapIntent` submitting an `oracle_verified` proof, or a future
`LoanIntent` submitting `collateral_held`, use the exact same verb — the
Core never needs to know a new `claimType` exists.

**Why both layers exist:** the module-namespaced REST routes in the rest
of this document (`/v1/openp2p/`, `/v1/settlement/`, etc.) are the
*implementation* — how the reference implementation's Fastify server
actually routes HTTP requests, module by module, matching
`ARCHITECTURE.md`'s layer separation. The Intent verbs above are the
*interface* — what `@satsails/p2p-trading-sdk` (`SDK_GUIDE.md`) exposes to an
application, and what any future non-TypeScript implementation must expose
too, regardless of how its own internal routing is organized. An
application built on Sails should never need to know that `releaseAsset`
happens to be implemented by calling into the OpenSettlement module — that
is exactly the kind of module-awareness the protocol is supposed to hide.

---

## 1. Namespacing Convention (mandatory going forward)

All routes follow: **`/v1/{module}/{resource}`**

This lets any integrator know exactly which protocol module they're calling
into. The legacy routes below (`/offers`, `/trade/*`, `/escrow/*` with no
module prefix) are what currently exists in old code fragments — they must
be migrated to the namespaced form as part of the `Meses 1-3` roadmap phase.
Keep a temporary alias layer during migration so existing integrators don't
break; do not delete the legacy path until a deprecation window has passed.

---

## 1B. Intent Engine — `/api/v1/intents` (legacy/reference cross-cutting coordination infrastructure)

This route sits outside the `/v1/{module}` convention because Intent is a
cross-cutting protocol primitive and the legacy/reference Intent Engine
(`intent-engine.ts`) owns this implementation path rather than any one
module. This describes the historical/reference implementation topology; it
does not assign the Intent Engine to the modern Pure Sails Core, Runtime, or
a Module.

| Method | Path | Description |
|---|---|---|
| POST | `/v1/intents` | `{ type: 'TradeIntent', payload, agentId? }`. Requires auth — `participantId` is derived from the session (`requireAuth`), never accepted from the body. Runs the full `CREATED → VALIDATED → COORDINATED` lifecycle (RFC-012) before returning. |
| DELETE | `/v1/intents/:id` | Requires auth. Only the Intent's own `participantId` may cancel it — `403` otherwise. |

Not documented here until a gap audit found `POST`/`DELETE` had no auth
at all (`THREAT_MODEL.md` §4) — added alongside that fix rather than
left undocumented once it was corrected.

---

## 2. Sails OpenIdentity — `/v1/identity/`

| Method | Path | Description |
|---|---|---|
| POST | `/v1/identity/register-challenge` | Issue a one-time registration challenge for a public key (unauthenticated; Issue #302) |
| POST | `/v1/identity/participants` | Register a new identity — requires `{ publicKey, signature, displayName? }`: proof of possession of the key over the registration challenge, signed message `sails-registration-proof-of-possession:v1:<challenge>:<displayName or empty>` (UTF-8). Already-registered keys are rejected (400); missing/invalid/stale/consumed proof is 401 (Issue #302) |
| GET | `/v1/identity/participants/:id` | Fetch a participant's profile |
| POST | `/v1/identity/challenge` | Issue an auth challenge |
| POST | `/v1/identity/authenticate` | Verify the signed challenge, issue session token |
| POST | `/v1/identity/logout` | Requires auth; revokes the current bearer session in Redis |

Legacy equivalents (pre-namespacing): `POST /identity/create`, `GET
/identity/:id`, `POST /identity/challenge`, `POST /identity/authenticate`,
`POST /identity/verify-signature` (dev utility), `GET /identity/keypair`
(⚠️ dev-only, generates test keypairs — must never be exposed in production).

---

## 3. Sails OpenLiquidity — `/v1/liquidity/`

| Method | Path | Description |
|---|---|---|
| GET | `/v1/liquidity/offers` | List offers, filterable by asset/side/paymentMethod/price range |
| POST | `/v1/liquidity/offers` | Publish a new offer |
| GET | `/v1/liquidity/offers/id/:id` | Single offer, including the seller's public profile fields |
| GET | `/v1/liquidity/offers/:asset/book` | Order book: bids + asks + spread for one asset |
| GET | `/v1/liquidity/offers/mine` | *(new 2026-08-01)* The authenticated caller's own offers, including non-ACTIVE ones — never a query param, always derived from the session |
| PATCH | `/v1/liquidity/offers/:id/status` | Pause / activate / cancel an offer |
| POST | `/v1/liquidity/match` | Find the best match for a given Intent |

Legacy equivalents: `POST /offers`, `GET /offers`, `GET
/offers/orderbook/:asset`, `PATCH /offers/:id/status`.

---

## 4. Sails OpenSettlement — `/v1/settlement/`

**Custody note (RFC-019):** the `WDK_USDT_EVM` `SettlementProvider`
these routes call into when active is a server-custodial reference
implementation, not the protocol's normative custody model — see
`CRYPTOGRAPHIC_MODEL.md` §5 for the full mechanics and
`rfcs/RFC-019-settlement-custody-reference-vs-normative.md` for the
registered migration plan.

**RFC-020 (`SAFE_GUARD_EVM`) — wired in, no new routes needed
(2026-07-28):** RFC-020 §4's own OpenAPI draft sketched new
`/v1/openp2p/escrows/:escrowId/evm/...` paths, but the real
implementation (`safe-guard-evm.provider.ts`) reuses the exact same
`initiate-release`/`initiate-refund`/`submit-transaction-signature`/
`pending-transaction` routes documented below — they're already generic
over `escrow.type` via `SIGNATURE_COLLECTION_PROVIDERS`, so `SAFE_GUARD_EVM`
picked them up automatically once registered. Its stored payload is a
JSON bundle (an unsigned `PackedUserOperation` + real `userOpHash`,
opaque to this service exactly like `LIGHTNING_HODL`'s own bundle), and
each `submit-transaction-signature` body is a bare 65-byte hex ECDSA
signature over that `userOpHash`, not a PSBT. **Still not callable
end-to-end:** `lockFunds`/`verifyLock`/the bundler-submission step of
`finalize` all throw a clear error — no live EVM RPC/bundler in this
environment. See `rfcs/RFC-020-non-custodial-evm-settlement.md` and
`CRYPTOGRAPHIC_MODEL.md` §5.1.

| Method | Path | Description |
|---|---|---|
| POST | `/v1/settlement/escrow` | Create an escrow for a trade |
| GET | `/v1/settlement/escrow/:id` | Escrow detail + event history. `data.disputes` (added 2026-08-03) — at most one entry in practice (`Dispute.@@unique([tradeId])`), the only way for a trade party who didn't open a dispute to ever learn its `disputeId` (previously only the opener's own `POST .../dispute` response carried it). `data.distributionPolicyFreezes[]` (added 2026-08-23, Missão 11 Fase 7.2) — one entry per confirmed fee-collection generation this escrow's `FeeObligation` has ever had (normally one; more than one only after a reorg + reconfirmation), each carrying the `DistributionPolicyVersion` (`id`, `label`, `publishedAt`, `recipients[]`: `recipientId`/`class`/`label`/`weightPct`) that was independently frozen for THAT generation at the moment it was confirmed — `null` `distributionPolicy` is a real, permanent outcome when zero policy was published at confirmation time, never backfilled. This is the historical-verification surface: it proves what governed a *specific past* generation, immune to a later policy rotation, unlike a "current live policy" lookup. No internal accounting data (`EntitlementLedgerEntry`) or `createdBy`/internal metadata is exposed. `data.custodyModel` (added 2026-08-24, Missão 11 Fase 9.1 §10) — this escrow type's own disclosed custody model, a real, distinctly-worded string per `SettlementProvider` implementation (e.g. `client-held-buyer-seller-keys-server-held-arbiter` for MULTISIG/LIGHTNING_HODL, `client-held-buyer-seller-keys-server-held-kms-arbiter` for SAFE_GUARD_EVM, `server-custodial-reference-implementation` for WDK_USDT_EVM) — `null` for MOCK and any provider that hasn't stated one; never a fabricated or marketing-only label. **Scope, not a completeness claim (2026-09-06):** `custodyModel` discloses key-custody topology only — MULTISIG and LIGHTNING_HODL sharing this exact string does not mean they share equivalent guard maturity. MULTISIG additionally has fail-closed capability-profile enforcement (`capability-profile.ts`) that LIGHTNING_HODL does not; see `docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md` for the current per-rail guard disclosure. |
| POST | `/v1/settlement/escrow/:id/submit-key` | `MULTISIG`/`LIGHTNING_HODL` only (2026-07-27 client-held-keys pass). Buyer or seller submits only their own public key (generated client-side, `@satsails/p2p-trading-sdk`'s `generateEscrowKeypair()`) — `403` if the caller isn't a counterparty. Once both have submitted, the real deposit address is derived and persisted onto `Escrow.multisigAddr` (null until then). Idempotent per role. `SAFE_GUARD_EVM` reuses this same route/mechanism for its own buyer/seller keys (the compressed secp256k1 pubkey is decompressed and turned into a real Ethereum address, see `safe-guard-evm.provider.ts`'s `ethereumAddressFromCompressedHex()`) — but `Escrow.multisigAddr` is never actually populated for it, since deploying the real Safe needs live EVM RPC infrastructure this environment doesn't have. |
| POST | `/v1/settlement/escrow/:id/lock` | `CREATED → FUNDS_LOCKED` |
| POST | `/v1/settlement/escrow/:id/payment-sent` | `FUNDS_LOCKED → PAYMENT_PENDING` |
| POST | `/v1/settlement/escrow/:id/release` | `PAYMENT_PENDING → COMPLETED` (the `PENDING_BANK_SETTLEMENT` source state below is designed, not yet a real starting point — see the note below the table). Body: `{ toAddress? }` — **optional as of 2026-08-04**, falls back to the buyer's own registered `PayoutAddress` for this escrow's asset if omitted (see `POST /v1/settlement/payout-addresses` below), throwing a clear error only if neither exists. When `ENFORCE_CAPABILITIES=true` (RFC-014) and/or `REQUIRE_DUAL_APPROVAL_RELEASE=true` (RFC-015, both default `false`), `escrow.service.ts`'s `releaseFunds()` — the single real choke point this route, `executeSettlement()`, and arbitrated `resolveDispute()` all funnel through — checks a capability grant and/or (on the non-disputed path only) two recorded counterparty approvals before proceeding. **`MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM` reject this route** (`EscrowError`, "not directly callable") — buyer/seller keys are client-held for all three, so release goes through `initiate-release`/`submit-transaction-signature` below instead. |
| POST | `/v1/settlement/escrow/:id/initiate-release` | `MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM` only (Phase 2, 2026-07-27; `SAFE_GUARD_EVM` added 2026-07-28). Body: `{ toAddress? }` (a bech32 testnet address for `MULTISIG`, a raw script hex for `LIGHTNING_HODL`, a 0x-prefixed Ethereum address for `SAFE_GUARD_EVM`) — same optional/`PayoutAddress`-fallback behavior as `release` above. Runs the same authorization `release` above does, then builds and persists an unsigned release transaction (`EscrowPendingTransaction`) — does **not** transition the escrow or move funds yet. The stored payload is a bare PSBT for `MULTISIG`, a JSON bundle (`{arkTxPsbtBase64, checkpointsPsbtBase64[], expectedPubkeys[]}`) for `LIGHTNING_HODL`, or a JSON bundle (`{path, userOp, userOpHash, toAddress, preEmbeddedSignature?}`) for `SAFE_GUARD_EVM` — opaque to this service in every case. Response's `requiredSigners` lists which participant ids must each call `submit-transaction-signature` below (on a `DISPUTED` release, only one — the arbiter's own required signature is pre-embedded at build time; for `SAFE_GUARD_EVM` this pre-signing call needs a real `AWS_KMS_KEY_ID` configured, see `.env.example`). `409`-equivalent `EscrowError` if a signing round is already in flight. |
| POST | `/v1/settlement/escrow/:id/initiate-refund` | Mirror of `initiate-release` above, for refund. For `SAFE_GUARD_EVM`, `toAddress` in the response is derived automatically from the seller's own submitted pubkey — not supplied by the caller. |
| POST | `/v1/settlement/escrow/:id/submit-transaction-signature` | Body: `{ signedPsbtBase64 }` — the caller's own independently-signed copy of the pending transaction's unsigned payload (sign client-side with `@satsails/p2p-trading-sdk`'s `signEscrowPsbt()` for `MULTISIG`, `signEscrowArkTx()` for `LIGHTNING_HODL`; for `SAFE_GUARD_EVM` this is a bare 0x-prefixed 65-byte ECDSA signature over the bundle's `userOpHash`, despite the field's PSBT-shaped name — genuinely opaque to this service). `403` if the caller isn't one of `requiredSigners`. Once every required signer has submitted, combines and finalizes for real — the response's `complete: true` means the escrow has actually transitioned (`COMPLETED`/`REFUNDED`) with a real `txReleaseId`; `complete: false` means still waiting on other signers. For `SAFE_GUARD_EVM` (real as of 2026-08-01: CREATE2 address prediction, on-chain balance checks, real `eth_sendUserOperation` bundler submission), `complete: true` requires `SAFE_GUARD_EVM_BUNDLER_URL` configured — without it, combining succeeds but the final broadcast throws a clear config error rather than silently stalling. |
| GET | `/v1/settlement/escrow/:id/pending-transaction` | The in-flight signature-collection round for this escrow, if any (`404` otherwise). |
| POST | `/v1/settlement/escrow/:id/approve-release` | RFC-015 two-person control. Records the caller as having approved this escrow's release — only `Trade.buyerId`/`sellerId` may call it, `403` otherwise. Idempotent (calling twice is a no-op). Response includes `readyToRelease` (`true` once both counterparties have approved). Has no effect unless `REQUIRE_DUAL_APPROVAL_RELEASE=true`. |
| GET | `/v1/settlement/escrow/:id/release-approvals` | Lists recorded approvals for an escrow plus `readyToRelease`. |
| POST | `/v1/settlement/escrow/:id/dispute` | `→ DISPUTED`. Delegates to `dispute.service.ts`'s `raiseDispute()` (persists a `Dispute` row + assigns an arbiter), not `escrow.service.ts`'s `openDispute()` directly — that's the lower-level transition `raiseDispute()` calls as its first step. |
| POST | `/v1/settlement/escrow/:id/refund` | `→ REFUNDED`. Same `MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM`-rejects/use-`initiate-refund`-instead note as `release` above. |
| GET | `/v1/settlement/disputes` | UI-audit gap, closed 2026-08-03 — every dispute action below was already real and callable, but nothing let an arbiter discover which disputes are actually assigned to them. Requires auth; always scoped to the caller's own `arbiterId` (never a client-supplied filter — same "scoped to whoever is authenticated" rule `GET /v1/openp2p/trades`/`GET /v1/liquidity/offers/mine` already follow). Query: `limit`/`offset` (same 1-50/default-10 pagination convention). |
| GET | `/v1/settlement/disputes/:id` | Requires authentication and is scoped to the trade parties or assigned arbiter. `404` for an unknown id. |
| POST | `/v1/settlement/disputes/:id/resolve` | Only the assigned arbiter (RFC-007 D4) may call this. `ruling`: `RELEASE` (releases to `releaseToAddress`), `REFUND`, or `SPLIT` (RFC-021 D9, 2026-08-02 — also takes `refundToAddress`/`splitBuyerBps`; real for `MOCK`/`WDK_USDT_EVM`/`MULTISIG`, rejected with a specific error for `SAFE_GUARD_EVM`/`LIGHTNING_HODL` — see that RFC's own D9 section). **`releaseToAddress`/`refundToAddress` are optional as of 2026-08-04** — if omitted, `escrow.service.ts` falls back to the buyer's/seller's own registered `PayoutAddress` (`POST /v1/settlement/payout-addresses` below) for the escrow's asset, throwing a clear error only if neither an explicit address nor a registered one exists. `splitBuyerBps` has no such fallback and is still required up front for `SPLIT`. Requires `TRUSTED_ARBITRATORS` configured (`.env.example`) — returns a config error otherwise, not a boot failure. **`authoritySignature`/`authorityIssuedAt` are now REQUIRED (Missão 13 Fase 2, INV-12, 2026-08-29)** — an Ed25519 signature (hex) over the canonical decision (`disputeId`, `escrowId`, `appealRound`, the caller's own `authorityId`, `ruling`, the SPLIT `buyerBps` or `null`, and `authorityIssuedAt` itself), verified server-side against the caller's own registered `User.publicKey` before any settlement action runs — a request with a matching `arbiterId` but no valid signature is rejected (`403`), never falling back to trusting the request body alone. The SDK's `resolveDisputeWithWallet()` builds and signs this automatically; see `docs/API_STABLE.md` and `src/modules/open-settlement/arbitration-authority.ts` for the full construction. |
| POST | `/v1/settlement/disputes/:id/appeal` | RFC-021 D6. Either trade party may reopen a `RESOLVED` dispute for a larger, more reputation-weighted appeal panel — only meaningful under `ARBITRATION_MODE=market`. Response includes `appealFeeRequired` (real, collected — `DisputeAppealFee`, settled FORFEITED/REFUNDED once the appeal panel rules). |
| POST | `/v1/settlement/disputes/:id/evidence` | RFC-021 D8, added 2026-08-02. Either trade party attaches more evidence (`{ type, uri?, note? }`) to their own open dispute — `raiseDispute()`'s own initial `evidence` param only covers what existed at open time. Transitions `OPENED`/`EVIDENCE_SUBMITTED` → `EVIDENCE_SUBMITTED`. May trigger a QVAC auto-resolution attempt server-side (`QVAC_AUTO_RESOLUTION_ENABLED`, off by default) — this call itself only ever returns the updated `Dispute` row, never a ruling. |
| POST | `/v1/settlement/disputes/:id/contest` | RFC-021 D8. Either trade party rejects a proposed automated ruling (`status: AUTO_PROPOSED`) before its `autoResolutionDeadline`, reverting to `EVIDENCE_SUBMITTED` and falling back to the already-assigned human arbiter — no new arbiter assignment happens. `400` once the window has closed or if there is no pending automated resolution. |
| POST | `/v1/settlement/payout-addresses` | BACKLOG.md's own "Participant payout address" gap, closed 2026-08-04. Body: `{ asset, address }` — registers/overwrites (idempotent upsert) the caller's own payout address for that asset. One row per (participant, asset); a BTC address and an EVM address are unrelated values, not one field. |
| GET | `/v1/settlement/payout-addresses/:participantId/:asset` | Requires auth, self-scoped — `403` unless the caller's own id matches `:participantId` (corrected 2026-09-13, F-06/System Coherence & Integration Audit; was public/no-session, which described no real caller). `404` if the caller has never registered an address for that asset. |

`PENDING_BANK_SETTLEMENT` (RFC-007 D3) is a *designed* additive status
between `PAYMENT_PENDING` and `COMPLETED` — no new route would be needed
once it lands, the existing `release`/`dispute` routes would handle it
as a valid source state. **Not yet migrated into the real `EscrowStatus`
enum** (`DATABASE.md`, noted 2026-07-19) — this paragraph previously
read as if it already were.

Legacy equivalents: `POST /escrow/create`, `GET /escrow/:id`, `GET
/escrow/trade/:tradeId`, `POST /escrow/lock`, `POST /escrow/payment-sent`,
`POST /escrow/release`, `POST /escrow/dispute`, `POST /escrow/refund`.

**Note:** these routes exist now (`modules/open-settlement/settlement.routes.ts`),
wrapping `escrow.service.ts`'s class methods (`createEscrow`, `lockFunds`,
`markPaymentSent`, `releaseFunds`, `refundFunds`, `getEscrow`,
`getEscrowByTrade`) and `dispute.service.ts`'s `raiseDispute()`/
`resolveDispute()` directly — this was previously the gap `TODO.md`
tracked; see that file's "Resolved Items" section.

---

## 5. Sails OpenP2P — `/v1/openp2p/`

| Method | Path | Description |
|---|---|---|
| POST | `/v1/openp2p/trades` | Start a trade from an offer |
| GET | `/v1/openp2p/trades/:id` | Trade detail with escrow + messages + originating offer |
| GET | `/v1/openp2p/trades/by-intent/:intentId` | Resolve an `intentId` to the Trade it produced (RFC-018) — new, backs `@satsails/p2p-trading-sdk`'s `dispute()` |
| PATCH | `/v1/openp2p/trades/:id/status` | Update trade status (ACTIVE/DISPUTED/CANCELLED) |
| WS | `/v1/openp2p/chat` | WebSocket negotiation channel (see below) |
| GET | `/v1/openp2p/chat/:tradeId/messages` | Message history for a trade |

Legacy equivalents: `POST /trade/create`, `GET /trade/:id`, `PATCH
/trade/:id/status`, `WS /ws`, `GET /chat/:tradeId/messages`, `GET
/chat/online`.

### WebSocket protocol (client → server)

```json
{ "type": "JOIN_TRADE", "payload": { "tradeId": "..." } }
{ "type": "SEND_MESSAGE", "payload": { "tradeId": "...", "content": "...", "msgType": "TEXT" } }
{ "type": "LEAVE_TRADE", "payload": { "tradeId": "..." } }
{ "type": "PING", "payload": {} }
```

### WebSocket protocol (server → client)

```
NEW_MESSAGE            — a new chat message in a joined trade room
TRADE_STATUS_UPDATE    — trade status changed
ESCROW_STATUS_UPDATE   — escrow status changed (auto-pushed via event bus)
RISK_WARNING           — SocialEngineeringAgent (RFC-007 D7 / RFC-017) flagged
                          a message; off by default (SOCIAL_ENGINEERING_DETECTION),
                          detection only — never blocks or alters the trade
USER_ONLINE / USER_OFFLINE
PONG
ERROR
```

---

## 6. Sails OpenReputation — `/v1/reputation/`

| Method | Path | Description |
|---|---|---|
| GET | `/v1/reputation/:participantId` | Full score breakdown |
| GET | `/v1/reputation/peer/:peerId` | Same score breakdown, looked up by portable Pears identity (RFC-013) instead of internal `participantId` |
| GET | `/v1/reputation/leaderboard` | Top participants by score |
| POST | `/v1/reputation/rate` | Rate a completed trade (score 1-5) |
| POST | `/v1/reputation/vouch` | RFC-021 D7, added 2026-08-02. Body: `{ voucheeId }`. Not a KYC/identity check — a real protocol-native attestation with the caller's own reputation on the line. `400` if the caller doesn't meet the eligibility bar (`>= 3` completed trades, positive reputation) or has already vouched for this vouchee. Pre-signs the vouchee's first `PaymentAccount` once they register one. |

Legacy equivalents: `GET /reputation/:userId`, `GET
/reputation/leaderboard`, `POST /reputation/rate`.

**RFC-007 note:** `POST /rate` is informational feedback only as of
RFC-007 — it no longer feeds the score `GET /:participantId` returns.
`ReputationScore` is computed exclusively from `recordOutcome()` /
`SettlementOutcome` events (`PROTOCOL_SPECIFICATION.md` §1.6). A trade
cancelled by agreement always classifies Neutral and can never reduce the
counterparty's score, regardless of any `rate()` call made against it.

**RFC-013 note:** `GET /v1/reputation/peer/:peerId` resolves
`User.peerId` → `participantId`, then returns the exact same
`ReputationScore` shape — no new scoring logic. `peerId` (Pears' real
contribution — a portable Ed25519 public key) is the identity substrate;
the score itself remains exclusively computed and stored by this module.

---

## 7. P2P Transport (Infrastructure — Pears/HyperDHT) — `/v1/peers/`

| Method | Path | Description |
|---|---|---|
| POST | `/v1/peers/start` | Start a HyperDHT node for the caller's userId (via `PearNodeRegistry`). No body — the server generates its own ephemeral per-session Ed25519 identity (key-custody fix, 2026-08-09; used to take a caller-supplied secret key here, no longer does). |
| POST | `/v1/peers/stop` | Stop the caller's node |
| GET | `/v1/peers/status` | Connection status: peer count, active topics |
| POST | `/v1/peers/join-topic` | Announce on an asset-specific topic |
| POST | `/v1/peers/join-trade` | Open a private per-trade P2P channel |
| POST | `/v1/peers/broadcast-offer` | Broadcast an offer to connected peers |

**Implementation note:** these routes must call into `pearNodeRegistry`
(the `Map<userId, PearNode>` registry — see `NODE_ARCHITECTURE.md`), never
instantiate `PearNode` directly. This was a specific architectural fix
applied during code review to correctly support multiple concurrent users
in a single server process.

---

## 7B. Sails OpenAgents — Capability Registry — `/v1/capabilities/`

*(new — RFC-013, `rfcs/RFC-013-capability-registry-and-wallet-adapter.md`)*

| Method | Path | Description |
|---|---|---|
| POST | `/v1/capabilities/register` | Self-issued `CapabilityGrant` — the caller declares and grants themselves scope over their own capabilities |
| GET | `/v1/capabilities/:participantId` | List active (non-revoked) grants |
| POST | `/v1/capabilities/:grantId/revoke` | Revoke a grant |

**RFC-013 note:** this is the real implementation of RFC-005's
`CapabilityGrant` (`PROTOCOL_SPECIFICATION.md` §1.10). The Capability
Registry is a historical/reference coordination component
(`core/capability-registry.ts` in the legacy topology), not an
OpenAgents-owned resource and not an assertion that it belongs to the
modern Pure Sails Core. The routes live here because capability declaration
maps onto RFC-005's own `agent-delegation` capability, the closest existing
module owner. Only self-issued grants exist today — a real multi-party
issuance flow (a module operator granting scope to an agent it doesn't
control) is separate follow-up work, not claimed done here.

---

## 7C. Sails OpenProof — `/v1/proof/` (RFC-006, RFC-007, RFC-008)

Not previously documented here despite being real, working routes
(`proof.service.ts`/`proof.routes.ts`) — added alongside the RFC-007
D1/D2/D6 and RFC-008 D1 work (2026-08-04) that extended this surface,
rather than leaving the new routes documented next to nothing.

| Method | Path | Description |
|---|---|---|
| POST | `/v1/proof/claims` | `{ claimType, assertion, tradeId? }` — `tradeId` (added 2026-08-04, RFC-007 D6) scopes this Claim into `GET /v1/proof/trades/:tradeId/bundle` below; optional, not every Claim is trade-related. |
| POST | `/v1/proof/proofs` | `{ claimId, evidence, claimedHash? }` — `evidenceHash` is always this server's own `sha256(canonicalize(evidence))`, never `claimedHash` as-is (a mismatch is recorded via `proof.hash_mismatch_detected`, not rejected). Also runs RFC-007 D1's duplicate check (`proof-registry.ts`) — a real match from a *different* trade emits `proof.duplicate_detected`, never blocks. |
| POST | `/v1/proof/proofs/:id/verify-nonce` | Issues a single-use nonce required before `verify` below accepts a verdict. |
| POST | `/v1/proof/proofs/:id/verify` | `{ verdict, nonce, reason? }` |
| GET | `/v1/proof/claims/:id/bundle` | Per-claim evidence bundle (claim + its proofs + their verifications). |
| POST | `/v1/proof/proofs/:id/evidence` | *(new, 2026-08-04, RFC-007 D2)* `{ mediaBase64, mimeType, signatureHex }` — stores real media bytes via `EvidenceProvider` (local filesystem by default) and persists an `EvidenceReference`. `signatureHex` must verify (Ed25519) against the authenticated caller's own registered `User.publicKey`, over the media's own sha256 digest — a caller cannot attach evidence "as" someone else. |
| POST | `/v1/proof/evidence/:id/anchor` | *(new, 2026-08-04, RFC-008 D1)* Submits the `EvidenceReference`'s hash to a real, live OpenTimestamps calendar server, persisting the resulting `AnchorProof`. A genuine network call/cost — not automatic on every `evidence` submission above; a caller (or a future real Policy Engine hook) decides when it's warranted. |
| GET | `/v1/proof/trades/:tradeId/bundle` | *(new, 2026-08-04, RFC-007 D6)* Public read, no session required. The real per-trade `EvidenceBundle` — every Claim/Proof/Verification/EvidenceReference for a trade, plus its real hash-chained Timeline (RFC-008 D2). Distinct from `GET /v1/proof/claims/:id/bundle` above (per-claim, already has its own real SDK/React-hook surface — kept unchanged). |

---

## 7D. Sails OpenAgents — Agent routes — `/v1/agents/` *(new, 2026-08-09)*

First HTTP surface for `QvacAgentProvider`'s structured-generation/risk
capabilities (`qvac-agent.provider.ts`) — real local LLM inference
(LLAMA_3_2_1B_INST_Q4_0, llama.cpp, no cloud dependency), previously
only reachable from the reference `BuyerAgent`/`SellerAgent`
implementations and `src/demo/pix-to-usdt-flow.ts`. Unblocked
`packages/sails-ui`'s "AI Negotiator" panel and `AgentRiskCard`, which
used to run a client-side simulation of these exact three calls
(disclosed as such in the UI) before this route existed — now call it
for real. **Scope note (Missão 07.3):** these three calls
(`generate-trade-intent`/`generate-offer-intent`/`assess-intent-risk`)
are the entire QVAC surface — a real LLM drafts a structured Intent/Offer
or assesses risk, once, given a goal/text. The subsequent offer search
(`POST /v1/intents/:id/propose`, `rfcs/RFC-023-qvac-negotiated-trade-proposal.md`)
that the "AI Negotiator" panel also drives is deterministic
price/reputation/amount matching against the Intent's own declared
limits — not a QVAC call. See that RFC for the real matching logic.

| Method | Path | Description |
|---|---|---|
| POST | `/v1/agents/generate-trade-intent` | `{ goal }` → `GeneratedTradeIntent` (`{ asset, side, maxValue, minValue, currency, fiatMethod }`). Acts for a buyer. |
| POST | `/v1/agents/generate-offer-intent` | `{ goal }` → `GeneratedOfferIntent` (`{ asset, side, minAmount, maxAmount, paymentMethod }`). Acts for a seller. |
| POST | `/v1/agents/assess-intent-risk` | `{ asset, side, maxValue?, minValue?, currency?, fiatMethod? }` (same restricted enums `POST /v1/intents`'s payload already validates, Fase 1 Red Team-hardened) → `IntentRiskAssessment` (`{ risk, reasoning, recommendation }`). |

All three require an active session (`requireAuth`) and share
`capability.routes.ts`'s revoke-route rate-limit tier
(`RATE_LIMIT_CRITICAL_MAX`/`_WINDOW`) — not because these calls carry
real authority or persist anything (they don't), but because each one
runs genuine local inference, a meaningfully more expensive operation
than a typical read or write even with no cloud cost involved.

---

## 8. Event Catalog (internal — mirrors `common/events/event-bus.ts`)

These are not HTTP endpoints — they are the internal typed events every
module emits/listens to. Documented here because API consumers using
webhooks will see these same names.

```
# Sails OpenP2P
openp2p.trade.created
openp2p.trade.status_changed
openp2p.trade.completed
openp2p.trade.disputed
openp2p.trade.cancelled
openp2p.message.sent

# Sails OpenSettlement
settlement.escrow.created
settlement.escrow.locked
settlement.escrow.payment_pending
settlement.escrow.pending_bank_settlement  # RFC-007 D3
settlement.escrow.released
settlement.escrow.disputed
settlement.escrow.refunded

# Sails OpenReputation
reputation.score.updated

# Sails OpenLiquidity
liquidity.offer.created
liquidity.offer.status_changed

# Sails OpenProof (RFC-007 addition; claim.*/proof.*/verification.*
# already exist per RFC-003/BACKLOG.md P0 but are not yet listed in this
# catalog — a pre-existing gap in this doc, not introduced by RFC-007)
proof.duplicate_detected  # RFC-007 D1 — real, closed 2026-08-04
                           # (proof-registry.ts). ProofRegistry found the
                           # same evidence fingerprint on a different
                           # tradeId (not this section's literal intentId
                           # — see core/timeline.ts's own header comment
                           # for the same real-world correction); a flag
                           # for Dispute/Policy Engine, not an auto-block

# Cross-module (P2P transport)
peer.connected
peer.disconnected
```

**Naming rule:** `{module}.{entity}.{action}`. This replaced an earlier,
unnamespaced convention (`trade.created`, `escrow.created`, etc.) found
during code review — the old names are dead, do not reintroduce them.

---

## 9. Error Response Shape

```json
{
  "success": false,
  "error": "VALIDATION_ERROR",
  "message": "Human-readable description",
  "details": [],
  "requestId": "req-1",
  "docsUrl": "https://github.com/alan-schramm/Sails-Protocol/blob/main/docs/API_REFERENCE.md#9-error-response-shape"
}
```

`requestId` is Fastify's own real per-request id (the same one in every
log line) — added 2026-08-08 so a caller can point support at "the
request that failed" with a matchable id instead of grepping logs by
timestamp. `docsUrl` — added 2026-08-10 — always points here; there's
no per-`error` code anchor since this table isn't independently
addressable on GitHub, so the caller lands on the full taxonomy below
rather than a fabricated deep link.

| `error` | HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body/query failed schema validation (`ZodError`, or a hand-thrown `ValidationError`) |
| `NOT_FOUND` | 404 | The referenced resource doesn't exist |
| `AUTH_ERROR` | 401 | Missing or invalid session |
| `FORBIDDEN` | 403 | Authenticated, but not authorized for this specific action |
| `ESCROW_ERROR` | 409 | An escrow/settlement action was attempted from an invalid state |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests — see `@fastify/rate-limit`'s response headers for retry timing |
| `REQUEST_ERROR` | 4xx | A well-behaved Fastify plugin rejected the request for a reason not covered above |
| `INTERNAL_ERROR` | 500 | Unexpected server error — `message` is redacted outside development mode |

`ZodError` → HTTP 400 with `VALIDATION_ERROR`. Custom `AppError` subclasses
(`NotFoundError`, `EscrowError`, etc.) → their own `statusCode`. Anything
else → HTTP 500, message redacted outside development mode.

---

## 10. Health / Meta Endpoints

```
GET /health   → { status, timestamp, version, protocol: "Sails Protocol",
                   module: "Sails OpenP2P", referenceImplementation: "Satsails Wallet",
                   features: { mockEscrow, mockSettlement } }
GET /         → { name, protocol, referenceImplementation, docs, ws, version }
```

`/health/live` is a process-only liveness probe and does not query PostgreSQL
or Redis. `/health/ready` checks both dependencies and returns only their
availability and latency; dependency error details stay in server logs. In
production, `/health` omits the internal `features` object. `/metrics` is
disabled in production unless `METRICS_ENABLED=true` is explicitly set; it
remains enabled by default outside production.