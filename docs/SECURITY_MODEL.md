# SECURITY_MODEL.md
### Sails Protocol — Security Architecture & Current Controls

> Where `THREAT_MODEL.md` catalogs *what could go wrong*, this document
> describes the *trust mechanisms* that make the protocol usable between
> two strangers in the first place, and what happens when something does
> go wrong (dispute resolution). Two companion documents narrow further:
> `TRUST_BOUNDARY.md` maps *where* in the request flow each mechanism
> below sits, and `CRYPTOGRAPHIC_MODEL.md` covers the actual cryptographic
> mechanics (signature scheme, replay protection, encryption) this
> document only names in passing (e.g. "Ed25519 keypair" in §1.3).

---

## 0. Coordination, Custody, and Evaluation Boundaries

Security reviews MUST distinguish the protocol's coordination role from the
custody/signing authority of a concrete wallet or settlement rail.

- **Sails coordinates economic actions; it does not make every integrated
  wallet or provider custodially equivalent.** Wallet/adapters bridge Sails
  semantics to a wallet stack or settlement provider. In non-custodial rails,
  user signing authority remains with the participant's wallet/key material;
  the adapter coordinates construction, verification, authorization,
  evidence, and submission without turning Sails into the user's custodian.
- **SDK cryptographic code is not, by itself, evidence of server custody.**
  Client-side key generation, transaction verification, and signing helpers
  belong in a consumer-facing SDK when the participant is expected to sign
  locally. A security finding must identify which principal actually controls
  the signing key and which signatures/authorities can move funds.
- **Reference/test implementations do not define the normative custody
  model.** Evaluate each rail independently and preserve its explicit
  production-eligibility classification. In particular,
  `WDK_USDT_EVM` is a server-custodial reference implementation and
  production-ineligible under RFC-019; that fact MUST NOT be generalized to
  non-custodial rails such as participant-key multisig or to the protocol
  architecture as a whole.
- **Test fixtures are not production credentials.** Seeds, private keys, and
  deterministic material intentionally used by tests, demos, local
  rehearsals, or published vectors must be classified as such before being
  reported as credential exposure. Conversely, anything that was ever a real
  operational credential MUST be treated as compromised if committed to
  public history, regardless of whether it was later removed from HEAD.
- **Production eligibility requires evidence.** Implemented, registered,
  executable, reference-only/test-only, and production-eligible are distinct
  states. No rail inherits production eligibility merely because its adapter,
  SDK primitives, or provider implementation exists.

For audits, the minimum classification question is therefore:

> **Who holds the signing authority, which rail/provider is being evaluated,
> is the material test-only or operational, and is that exact implementation
> production-eligible?**

This boundary does not reduce supply-chain risk. Client signing code and
dependencies remain part of the adversarial surface and must be evaluated
under the security audit; the point is to assess the authority they can
actually exercise rather than infer custody from code location alone.

---

## 1. Trust Without a Trusted Third Party

The central question any evaluator will ask: **why would a participant
trust an unknown counterparty in a non-custodial system?** Four concrete
mechanisms answer this — "non-custodial" alone is not a sufficient answer.

### 1.1 Non-Custodial Escrow

Funds are locked in a smart contract or multisig *before* fiat is sent. No
single party can access the funds alone — release requires bilateral or
arbitrated action.

- **Multisig 2-of-3:** Buyer + Seller + Arbiter — real as of 2026-07-27
  (`multisig.provider.ts`). Buyer/seller each hold their own client-side
  key as of the same day's follow-up pass (`@satsails/p2p-trading-sdk`'s
  `generateEscrowKeypair()` + `POST /v1/settlement/escrow/:id/submit-key`)
  — the server only ever derives the arbiter's own key, the same split
  HodlHodl's real design uses. Release/refund go through a real
  client-signature-collection flow (Phase 2, same day): the server builds
  an unsigned PSBT (`POST .../initiate-release`/`initiate-refund`), each
  required party signs their own copy client-side (`@satsails/p2p-trading-sdk`'s
  `signEscrowPsbt()`) and submits it
  (`POST .../submit-transaction-signature`); once every required
  signature has arrived, the server combines and finalizes for real
  (verified end-to-end against the live server + real Postgres —
  `TODO.md` §4 has the full disclosure, including what's still deferred:
  `LIGHTNING_HODL`'s equivalent Phase 2)
- **Lightning HODL HTLC:** time-locked — real as of 2026-07-27, via Arkade
  (Ark protocol) rather than a literal LND hold-invoice
  (`lightning-hodl.provider.ts`) — plain Lightning HTLCs genuinely have no
  multi-party escrow primitive (confirmed from HodlHodl's own docs), but
  Arkade does, and HodlHodl/Lendasat both already build on it in
  production. Same client-held-keys upgrade as Multisig above, and — as
  of the same day's second follow-up pass — the same real
  client-signature-collection Phase 2 too: `@arkade-os/sdk`'s `SingleKey`
  (a raw-private-key signer, no ASP/wallet machinery needed) was verified
  to bundle cleanly for a browser target before this was built. Release/
  refund go through `POST .../initiate-release`/`initiate-refund` +
  `.../submit-transaction-signature`, same routes MULTISIG uses — the
  server never inspects the signed-payload format, so both providers
  share one generic orchestration layer (`TODO.md` §4 has the full
  disclosure, including what's still unverified: a live run against a
  real funded mutinynet VTXO, which this environment cannot originate)
- **Liquid Covenant:** script-enforced — not implemented at all yet, same
  live-infrastructure blocker as Lightning above

### 1.2 Portable Reputation

Score tied to the Ed25519 keypair — not to a platform account. Built from
completed trades, settlement speed, dispute history, and volume over time.

- **Trade Score** — mutual ratings, 1-5
- **Volume Score** — BTC-equivalent volume over time
- **Dispute Rate** — inversely proportional; penalizes bad-faith disputes

### 1.3 Verifiable Identity

Participants prove control of their keypair via digital signature. No
email, no phone number required at the base level — optional verification
levels unlock higher trust limits.

- **Level 0:** keypair only
- **Level 1:** phone verified
- **Level 2:** optional documents + on-chain history

### 1.4 Trade Limits by Trust

Higher-value trades unlock as reputation score increases. New or
low-reputation peers can only trade small amounts until they build real
history.

| Reputation | Max trade size |
|---|---|
| New peer (score 0-20) | 0.001 BTC |
| Score 21-50 | 0.01 BTC |
| Score 51-89 | 0.05 BTC |
| Score 90+ (verified) | No protocol-imposed limit |

---

## 2. Six Security Principles

1. **Non-Custodial by Design** — Sails never holds funds. No hot wallet,
   cold wallet, or treasury exists anywhere in the architecture.
2. **User Always Signs** — every action that moves funds requires the
   user's own WDK signature. No server can initiate a transaction on a
   user's behalf.

   **Real-implementation gap found 2026-07-19** (a CTO-directed fidelity
   audit comparing this principle against the actual code, not just its
   design): the one real, tested `SettlementProvider` —
   `WdkSettlementProvider` (`wdk-settlement.provider.ts`) — does not
   satisfy either principle 1 or 2 as written. It derives every escrow's
   signing key from **one server-held seed phrase**
   (`config.wdk.seedPhrase`, env var `WDK_SEED_PHRASE`) that also
   controls a treasury account — the file's own header comment states
   this plainly: "single-seed, two-hop escrow, not a trustless multisig
   ... the same key that can lock funds can also move them anywhere."
   `releaseFunds()` needs no user-supplied signature or credential at
   all; the server signs unilaterally. This is a genuine violation of
   `PROTOCOL_INVARIANTS.md`'s Constitutional Invariant 2 ("The Protocol
   Never Custodies Assets") **in the one real settlement path this
   codebase ships today** — not a documentation phrasing issue, a real
   custody gap. It is explicitly disclosed at the code level (not
   hidden), is testnet-only, and **RFC-019**
   (`rfcs/RFC-019-settlement-custody-reference-vs-normative.md`) is the
   accepted, registered migration plan — see `CRYPTOGRAPHIC_MODEL.md`
   §5 for the full technical detail. **RFC-020**
   (`rfcs/RFC-020-non-custodial-evm-settlement.md`, RFC-019's Phase 2)
   registers real engineering progress toward the fix — a Safe
   Transaction Guard + ERC-4337 escrow with a KMS-backed co-signer,
   specified and tested but not deployed or wired into
   `WdkSettlementProvider`'s actual release path — see that RFC's
   Threat Matrix (§6) for the full risk breakdown. The `MOCK` `SettlementProvider`
   (the only other implementation) and the protocol's own design
   (multisig 2-of-3, per §1.1 above) are unaffected — this is specific
   to `WDK_USDT_EVM`'s current implementation, not a design flaw.
3. **Escrow Isolation** — escrow logic is architecturally separate from the
   application layer (see the layer-violation fix documented in
   `ARCHITECTURE.md`). Compromising reference-implementation infrastructure
   does not expose escrowed funds.
4. **Distributed transport does not imply distributed economic truth** — HyperDHT/Secretstream provide distributed/E2E transport properties, but current economic state is still materially node-local in the Reference Implementation. Day-0 multi-operator/shared-market resilience is an explicit open completion gate under ADR-001 / #105. Do not claim "no single server holds critical state" until that evidence exists.
5. **AI-Assisted Fraud Detection (future)** — QVAC will monitor patterns
   locally: new accounts with high volume, repeated PIX keys across
   accounts, coordinated rating manipulation. Not yet implemented — see
   `THREAT_MODEL.md` section 4.
6. **Open & Auditable** — the protocol spec and implementation are reviewable. Protocol invariants define intended security semantics, but each implementation/integration must still prove that it preserves them. Integrators do not inherit implementation-level security merely by adopting the protocol.

---

## 3. Dispute Resolution Layer

Even without custody, disputes are inevitable in any real market. The
protocol has a planned resolution layer — not custodial arbitration, but
verifiable, evidence-based mechanisms.

### Scenario A: Payment sent, asset not released

Buyer provides fiat receipt via Secretstream chat. QVAC (future) analyzes
the payment proof. A 24-hour timeout auto-escalates. Multisig requires the
arbiter to co-sign the release if the seller is unresponsive or acting in
bad faith.

### Scenario B: Asset locked, payment not received

Seller provides no evidence of non-payment beyond the timeout. The
escrow's protocol expiry deadline passes → escrow refunds the seller
automatically. The buyer's suspicious non-payment pattern is logged to
the reputation system.

**Terminology note, Missão 11 Fase 9.1 §9 (2026-08-24):** "Timelock" in
this document (and this codebase's `timelockHours`/`DEFAULT_TIMELOCK_HOURS`
naming) means an **administrative protocol deadline** —
`Escrow.expiresAt`, a plain server wall-clock value
(`lockedAt + timelockHours`) checked by application logic. It has no
Bitcoin-native (CLTV/CSV) counterpart in `MultisigProvider`'s actual
P2WSH script for Gen-1 — the script itself enforces nothing about time at
all. Expiry never grants the server, or anyone, unilateral spending
authority: the automatic refund below still routes through
`sweepExpiredEscrows()` → the same `refundFunds()` path a manual refund
uses, `triggeredBy` always the trade's own seller (never a fabricated
"system" actor), and for MULTISIG specifically still requires the normal
cooperative buyer+seller signature pair — an expired timelock with no
cooperative resolution can *only* be recovered via a dispute (arbiter
co-signature), never unilaterally by the server. Retrofitting a real
on-chain CLTV/CSV timelock into Gen-1 is explicitly out of scope for this
phase (see RFC-024 for the documented Gen-2 target architecture where
that changes); this note exists so no reader mistakes "timelock" here for
cryptographic, on-chain enforcement.

**Corrected/Implemented 2026-08-24 — the paragraph below was stale.**
This section previously said "the automatic part of this scenario is not
implemented... no proactive sweeper exists," which was accurate when
written (2026-07-19) but has since been closed: `escrow.service.ts`'s
`sweepExpiredEscrows()` is real, queries every `Escrow` still
`FUNDS_LOCKED` past its own `expiresAt`, and calls the existing
`refundFunds()` for each (per-escrow try/catch, one failure doesn't block
the rest) — wired into `app.ts`'s `startServer()` as a `setInterval`
(`config.trade.timelockSweepIntervalMs`, default 5 min), gated behind
`config.features.escrowTimelockSweeper`
(`ESCROW_TIMELOCK_SWEEPER`, default `false`). See `BACKLOG.md`'s "Escrow
timelock proactive sweeper" row (closed 2026-08-01) for the full detail
and test coverage. The scenario described above is now real when that
flag is enabled, not aspirational.

### Scenario C: Disputed payment proof

A **Trusted Arbitrator** — assigned via `ArbitrationProvider`, registered
per application (never a protocol-native role, per RFC-007 D4 and
`PROTOCOL_SPECIFICATION.md` §1.9's own explicit reasoning: this
deliberately avoids implying the protocol itself governs or controls
arbitration outcomes) — reviews the evidence in the chat history. Their
decision triggers the multisig 2-of-3 release, recorded as the `Dispute`
primitive's `ruling`. **Corrected 2026-07-19 (consolidation audit):**
this scenario previously described a permissionless "community volunteer
holding a reputation bond, fee drawn from bonded collateral" model — an
earlier vision that RFC-007 D4 replaced with the application-registered
Trusted Arbitrator model actually implemented
(`open-settlement/arbitration-provider.ts`'s `TrustedArbitratorProvider`,
`API_REFERENCE.md`'s `TRUSTED_ARBITRATORS` config). No bonding/collateral
mechanism exists in code; an arbiter's incentive today is their own
`ReputationScore`, publicly and permanently damaged by a ruling the
network judges unfair (`THREAT_MODEL.md`'s "Malicious Arbiter Collusion"
entry) — reputation-as-bond, not collateral-as-bond.

**Corrected 2026-07-29 (RFC-021 implementation):** the "earlier vision"
the 2026-07-19 correction above describes as unbuilt is now real, not
speculative — `docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md`
is the deliberate, documented revival of exactly that permissionless
model, built because the original blocker ("no bonding/collateral
mechanism exists in code") no longer applies. `MarketArbitrationProvider`
(`open-settlement/market-arbitration.provider.ts`) implements real
collateral-and-reputation-weighted registration (`register()`), eligibility
(`eligibleFor()`), first-instance selection (`assign()`), a
reputation-weighted appeal panel that grows per round (`assignAppealPanel()`),
and real slashing on an overturned ruling (`slash()` — forfeits
`SLASH_COLLATERAL_FRACTION` of posted collateral plus a reputation
penalty, `docs/DATABASE.md`'s `ArbiterProfile` model). `TrustedArbitratorProvider`
is **not deleted** — a deployment chooses between the two via
`config.settlement.arbitrationMode` (`'trusted-list'` default,
`'market'` opt-in), the same "off by default, explicit env var" pattern
`MOCK_ESCROW`/`REQUIRE_DUAL_APPROVAL_RELEASE` already use. The residual
risk this doesn't close — capital-based Sybil attacks on the market
model itself, no closed-form solution — is disclosed in RFC-021's own
"Known Risks — Mitigated, Not Solved" section, not implied fixed by this
correction.

### Resolution Principles

- QVAC assists analysis locally and privately — no cloud dependency (future)
- Multisig 2-of-3 prevents any unilateral fund release
- Reputation penalties apply to bad-faith disputes
- A Trusted Arbitrator's own reputation is the incentive for a fair
  ruling — a bad ruling is visible and permanent, not just a lost fee
- Protocol-expiry fallbacks handle no-response scenarios automatically —
  **real since 2026-08-01** (`sweepExpiredEscrows()`, gated behind
  `ESCROW_TIMELOCK_SWEEPER`; see Scenario B's own correction above and
  `BACKLOG.md`'s "Escrow timelock proactive sweeper" row). An
  administrative deadline, not a Bitcoin-native on-chain timelock — see
  Scenario B for the full terminology note
- Dispute history is public on the reputation layer — repeat bad actors
  become visible to the whole network, not just one counterparty

---

## 4. Privacy by Design

Privacy is architecture, not policy — a deliberate constraint on what data
the protocol collects, not a promise about how collected data is handled.

1. **Data Minimization** — protocol semantics should require only the data necessary for coordination. Reference applications/providers may handle additional identity, payment, network or compliance data; those product/provider obligations must not be misrepresented as protocol-global storage.
2. **Direct P2P communication target / current transport** — Pears/Secretstream provides E2E P2P transport capability, but deployment/runtime paths must be evaluated individually. Do not infer from the transport primitive that no Sails runtime can ever observe metadata or participate in connection/session coordination.
3. **No Mandatory Identity** — a keypair is sufficient to participate.
   Phone/document verification is optional, only needed for higher trust
   limits.
4. **Local AI Intelligence** — QVAC agents (future) run entirely on the
   user's device. Matching, fraud detection, and counterparty scoring never
   send data to the cloud.
5. **User / operator data boundaries** — current Reference Implementation trade/economic history is materially persisted in node/runtime storage, not solely on the user's device. Reputation is tied to economic participant identity and its provenance; external applications/providers may also associate real-world identity under their own policies.
6. **Permissionless Participation** — no account creation, email, or KYC
   required at the protocol level. Applications built on the protocol may
   add their own requirements, but the protocol itself stays open.
7. **Verifiability Does Not Require Identity Disclosure** — a public,
   hash-gated read exists to let a counterparty verify a *property* (has
   this payment rail been used before, is it signed, what trade limit does
   it carry), never to let anyone resolve *which platform identity* stands
   behind that property. Public-by-hash is a deliberate design choice
   (Bisq's own account-age-witness precedent — a hash both sides can check
   without either seeing the other's real account data) and is not itself
   a privacy leak; treating "someone knows the hash" as authorization to
   see participant identities *is* a leak. Every public projection in this
   protocol is scoped to exactly the fields a caller needs to verify the
   claim, never the raw underlying row. Case study, closed Missão 11 Fase
   9.3.1: `GET /v1/settlement/payment-accounts/:accountHash` (RFC-021 D5)
   stayed intentionally unauthenticated — matching its own documented
   contract (`docs/API_STABLE.md`, "no session required") — but its
   response was narrowed from the raw `PaymentAccount` row to
   `PublicPaymentAccountView` (`payment-account.service.ts`), removing
   `ownerId`/`signedBy` (platform User ids), the internal `id`, and
   operator bookkeeping (`moduleId`/`protocolVersion`/`updatedAt`).
   `accountHash`/`paymentMethod`/`signed`/`signedAt`/`firstUsedAt`/
   `completedTrades`/`chargebacks`/`tradeLimit` all remained — each is
   either the literal subject of the age-witness verification or lets an
   independent client recompute the server's own trade-limit formula
   (its constants are public SDK exports) without ever learning who owns
   or attested the account. The corresponding SDK type is
   `PublicPaymentAccount`, distinct from the full `PaymentAccount` row
   `register()`/`sign()` return to their own authenticated, self-
   referential caller (the owner registering their own account; the
   signer attesting one) — a full row is never a privacy leak when the
   only recipient is the person it's already about.

   Second case study, closed Missão 11 Fase 9.3.4, same sweep: `GET
   /v1/settlement/payout-addresses/:participantId/:asset` had the
   identical bug (raw `PayoutAddress` row, including `id`/
   `moduleId`/`protocolVersion`/`createdAt`/`updatedAt`) — fixed the
   same way (`PublicPayoutAddressView`/`PublicPayoutAddress`, keeping
   only `participantId`/`asset`/`address`, the committed payout
   destination itself). The SAME sweep independently re-checked `GET
   /v1/settlement/arbitration/profile/:participantId` and found it
   already conformant — it has returned a real, purpose-built
   projection (`ArbiterCandidate`) since before this rule was written,
   never the raw row.

   Third case study, closed Missão 11 Fase 9.3.5: `GET /v1/identity/
   participants/:id` (a public, unauthenticated lookup of ANY
   participant — needed so a counterparty can verify a signature or
   open a P2P connection) had the same bug, plus a distinct one:
   reputation stats (`reputationScore`/`totalTrades`/`disputeCount`/
   `totalVolumeBtc`) were also returned, even though three of the four
   already have their own dedicated, canonical, already-public surface
   (`GET /v1/reputation/:participantId`) — duplicating them on an
   identity-lookup route is scope creep, not a privacy decision.
   `totalVolumeBtc` turned out to have no equivalent public surface at
   all (`ReputationScore` carries `cumulativeFeesObserved`, a fee
   total, not a BTC-volume figure) — disclosed rather than assumed
   covered, the same discipline this section's own prior case study
   established. Fixed via `getPublicView()`/`PublicParticipantIdentity`
   (`identity.service.ts`), keeping only `id`/`publicKey`/`displayName`/
   `peerId`/`verified` — each is either the literal subject of the
   lookup or required to verify a signature/open a connection.
   `GET /v1/identity/me` (authenticated, self-referential) is
   unaffected — it correctly stays the full row, same exception this
   section's opening paragraph already carves out. The SDK's
   `identity.get()` narrowed from `Participant` to `PublicParticipant`
   accordingly; the one real internal consumer
   (`packages/sails-ui`'s Trade page) now sources reputation stats from
   `reputation.get()` — its actual canonical home — instead.

   Fourth case study, closed Missão 11 Fase 9.6: `POST /v1/settlement/
   payment-accounts` and `POST /v1/settlement/payment-accounts/:accountHash/sign`
   had the identical bug on the WRITE side of the payment-account
   surface, un-swept by the Fase 9.3.1 pass that closed the sibling GET
   route — `getOrCreate()`/`signPaymentAccount()`'s raw row (`ownerId`/
   `signedBy` included) was echoed verbatim whenever the caller wasn't
   the account's owner (an arbiter/peer attesting someone else's
   account via `/sign`; any authenticated caller who supplied a
   counterparty's real `accountHash` via the POST create route — RFC-021
   D5's own design already requires knowing the correct hash to
   register/attest an account, so this wasn't a public/anonymous leak,
   but an authenticated one). Found while investigating an independent
   red-team's (Kimi K3 R2) unrelated "hash collision" claim — refuted
   (SHA-256 collision is not what a shared `accountHash` requires, and
   `getOrCreate()` never mutates `ownerId`) — but tracing the claim
   surfaced this real, different, adjacent gap. Fixed via
   `PaymentAccountService.toPublicView()`, applied on both POST routes
   whenever `account.ownerId !== caller`; a self-referential response
   (new registration, or an owner re-submitting their own hash) stays
   full, unchanged.

   See `docs/PROTOCOL_INVARIANTS.md`'s `INV-OP-10` entry for the
   complete field-by-field accounting of all four surfaces.
