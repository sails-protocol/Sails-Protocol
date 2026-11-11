# Partner Wallet Integration & Identity Continuity (Mission 3)

**Status:** Design (sections 1-14, 16-17) + one bounded implementation slice
(section 15, Slice 1). **Not a Protocol Freeze.** Recovery-model content
(§9) is explicitly hypotheses, not decisions — see that section's own
banner.

**Corrected 2026-09-14 (Mission 3 R1, CTO precision/reconciliation
review):** this document's original version incorrectly equated Economic
Identity with `User.id`, contradicting this repo's own already-
institutionalized truth (Economic Identity is currently represented by
`User.publicKey` — `DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5,
`CRYPTOGRAPHIC_MODEL.md` §1) — corrected throughout, see §1.4's own
precise four-way terminology. It also incorrectly claimed
`CRYPTOGRAPHIC_MODEL.md` §1 was still stale and registered a duplicate
backlog obligation for a correction PR #93 (merged 2026-09-08) had
already made — removed, see §6.2/§17. The session-expiry hook (§15) was
also corrected to require an actually-established session token at
dispatch time, not merely `auth: true` — see §15's own updated text.

**Corrected 2026-09-14 (Mission 3 R2, CTO concurrency review):** this
document previously implied (never stated outright, but never
contradicted either) that `onSessionExpired` fires once, globally, per
session expiry. **False, and now stated precisely:** the SDK hook fires
once per QUALIFYING REQUEST — since multiple authenticated requests can
legitimately share one session token, several of them can independently
401 and each correctly invoke it for the SAME underlying expiry. A real
concurrency defect followed from this in the reference UI's own reaction:
the original guard (`userRef.current`, synced only via a `useEffect`
running after React commits) could let more than one of those
invocations pass before React ever caught up, each treating one expiry as
a NEW episode. Fixed with `lib/sessionEpochGate.ts`, a small, pure,
unit-tested, React-free mutual-exclusion mechanism — `login()`/`logout()`
now update the authoritative session-active truth SYNCHRONOUSLY (never via
an effect), and the handler synchronously claims the current episode
before doing anything else, so concurrent observations of one expiry
converge onto exactly one UI reaction. `sessionExpiry.at` (a `Date.now()`
value inaccurately called "monotonic") is replaced by `sessionExpiry.episode`,
a real, locally-unique, strictly-increasing counter — see §7/§15's own
updated text.

**Baseline:** `main@351ccea88815144ca4a805a10de6875558c1a4ac` (PR #146,
CROSS-LAYER-SEMANTIC-CORRECTIVE-1 item 37, merged 2026-09-14).

**Mission objective (verbatim from the CTO brief):** define and implement
the first trustworthy integration model for how Sails enters a third-party
wallet or financial application without taking possession of its UX, keys,
custody model, or wallet stack, while preserving continuity of economic
identity, reputation, and authority.

**Method:** this document is built entirely from direct inspection of this
repository's own code and docs (five parallel research passes, each
independently verified against source), not from invented vocabulary. Where
the mission's own terms ("Product/Reference/White-label/Sails Market
layering," "Actor model") don't exactly match what the repo actually calls
these things, that mismatch is called out explicitly rather than papered
over.

---

## 1. Current-State Truth

Six load-bearing facts, each independently verified against source, not
assumed from prior docs:

**1.1 — `WalletAdapter` is a real, already-shippable, client-side-only
interface.** `packages/sails-sdk/src/wallet-adapter.ts`:

```typescript
export interface WalletAdapter {
  getPeerId(): Promise<string>
  getAddress(asset: string): Promise<string>
  getBalance(asset: string): Promise<string>
  signTransaction(asset: string, tx: unknown): Promise<unknown>
  broadcastTransaction(asset: string, signedTx: unknown): Promise<string>
  getCapabilities(): Promise<WalletCapabilitiesDeclaration>
  signMessage(message: Uint8Array): Promise<Uint8Array>
  disconnect?(): Promise<void>
}
```

Two implementations exist today, both public SDK code: `LocalKeypairWalletAdapter`
(demo-only, `signMessage` only, throws on every asset method — its own
header says "NOT a template for production wallet custody") and
`MockWalletAdapter` (deterministic test double, all methods). Neither
implementation, nor the interface itself, is imported by any server-side
module — confirmed by grep across all four settlement provider files
(`multisig.provider.ts`, `lightning-hodl.provider.ts`,
`safe-guard-evm.provider.ts`, `wdk-settlement.provider.ts`). `WalletAdapter`
is optional at the SDK boundary (`SailsClientOptions.wallet?`); every v0.1
module already works without one.

**1.2 — `WalletAdapter ≠ SettlementProvider` is already an explicit,
written boundary, not new vocabulary this mission invents.** Found
verbatim in three places: `docs/PARTNER_BETA_INTEGRATION_REALITY.md:352`,
`docs/PROJECT_CONTEXT.md:1149`, `docs/BACKLOG.md:2780`, all citing
`docs/SAILS_MARKET_DISTRIBUTION_FLYWHEEL.md` as the institutionalizing
source. `SettlementProvider` is server-side infrastructure
(`src/common/settlement-provider-registry.ts`, ADR-002) that "supplies or
executes an economic settlement capability (lock/release/refund/split) for
one or more registered `SettlementScope` rows" — it has no wallet/signing
concept at all. ADR-002's own frozen line: **"Asset ≠ SettlementRail ≠
SettlementAdapter ≠ SettlementProvider."** A third layer exists in the SDK,
introduced by RFC-020: `CustodyProvider` — "the client-SDK-side mirror of
what `SettlementProvider` already is server-side," explicitly distinguished
from `WalletAdapter` in that RFC's own text: *"`WalletAdapter` is 'how does
a user's own wallet sign for them,' `CustodyProvider` is 'how does the
ESCROW itself get held and released.'"* This boundary is documentation-only
— no lint rule or type constraint enforces it — but no violation of it was
found anywhere in the four settlement provider implementations.

**1.3 — Economic Identity / Funds Authority / Transport Identity is real,
frozen (2026-09-09 CTO Gate) vocabulary, not new for this mission — but the
binding between the pieces is a named, registered, not-yet-built gap.**
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5 freezes an A/B/C/D taxonomy:
**A. Participant Economic Identity** ("non-custodial by requirement...
Current reference implementation: represented by `User.publicKey`"),
**B. Participant Transport Identity** ("one participant's own stable,
transport-scoped identity... represented by a participant `peerId`"),
C. Operational Sails Node Identity (not built), D. Operator Economic
Recipient. `docs/adr/ADR-001-day0-multi-operator-network.md` §7.1 names
"Economic Identity ↔ Transport Identity Binding" as a distinct, explicitly
**not-yet-built** obligation. `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`
(1200 lines, evidence-gathering only, explicit **"B/STOP — evidence does
not yet cleanly support committing to a single final model"** verdict)
confirms the current reality: the three domains have **zero cryptographic
binding** today — association between a `User` row's `publicKey` and its
`peerId` is "entirely server-mediated (a database row)," not proven by any
signature or derivation.

**Correction (Mission 3 R1, 2026-09-14): an earlier version of this
document claimed `CRYPTOGRAPHIC_MODEL.md` §1 still carried a stale
"one primitive, not two" claim about transport keys. That claim itself was
stale — PR #93 (merged 2026-09-08, "institutional cold sweep... close
#60") already corrected `CRYPTOGRAPHIC_MODEL.md` §1 directly, closing
`docs/TECHNICAL_DEBT_AUDIT.md` item 60, with its own dated
"Corrected/Current-truth update (2026-09-08, TECHNICAL_DEBT_AUDIT.md item
60)" block stating, verbatim: "Economic identity = `User.publicKey`...
Transport identity = a separate, ephemeral Ed25519 keypair (`User.peerId`)...
The association between the two is server-mediated — a database row... not
an independent cryptographic binding." This is EXACTLY §1.3's own citation
above, already institutionalized. No further doc correction is owed here —
see §17's own reconciliation of the duplicate obligation this earlier
version mistakenly registered.**

**1.4 — Terminology this document uses precisely from here on (the exact
distinction Mission 3 R1 requires, stated once and then held to
consistently) — four DIFFERENT things, never collapsed into one:**

- **Participant record / durable database identifier** = `User.id` (a
  UUID, `@id @default(uuid())`). This is what a Prisma foreign key
  actually references, what reputation columns (`reputationScore`,
  `totalTrades`, `disputeCount`, `cumulativeFeesObserved`) live on the
  same row as, and what persists across sessions regardless of which key
  authenticated into it.
- **Current reference representation of Participant Economic Identity**
  = `User.publicKey` (per §1.3's own DAY0_COMPLETENESS_COLD_SWEEP.md
  citation and `CRYPTOGRAPHIC_MODEL.md` §1's own corrected text). This is
  what a challenge-response login actually proves control of, and what an
  outside observer verifies — nobody presents a UUID to authenticate.
- **Participant Transport Identity** = `User.peerId`, a separate,
  ephemeral Ed25519 keypair, cryptographically unrelated to `publicKey`
  (§1.3 above).
- **Funds Authority** = a distinct, transaction/settlement-specific
  authority, proven per-transaction against whatever key a
  `WalletAdapter`/`CustodyProvider` used to sign an `EscrowPendingTransaction`
  — never assumed from either of the identity representations above (§5's
  own Q3 answer covers this in full).

**Database row identity ≠ automatically protocol Economic Identity** —
stated explicitly because an earlier version of this document violated it:
`User.id` is the durable record; `User.publicKey` is what this repo's own
already-institutionalized truth (§1.3) currently designates as the
Economic Identity representation attached to that record. This document
does NOT invent a new semantic identity primitive, and does not silently
promote `User.id` to be "the" Economic Identity — whether `User.id` SHOULD
eventually become the canonical Economic-Identity abstraction (with
`publicKey` demoted to "the currently-authenticating key," rotatable) is a
real, undecided question, registered as an Architecture Decision Required
in §14, not decided here. `src/modules/open-identity/identity.service.ts`'s
`register()` creates the `User` row with both fields; `packages/sails-sdk/src/modules/identity.ts`'s
`create()`/`createWithPublicKey()` never touch or transmit a secret key;
auth is Ed25519 challenge-response, not wallet-address-based. A partner
wallet can reproduce registration/auth with its own Ed25519 keypair without
any Sails-specific linkage.

**1.5 — Partner Parity Review result: no privileged-capability leak found
in the reference UI.** Mechanical audit of `packages/sails-ui` against
`packages/sails-sdk/src/index.ts`'s public export barrel: zero raw
`fetch`/`WebSocket`/`axios` calls, zero imports reaching into the backend's
own `src/`, zero imports bypassing the SDK's `index.ts` into its internals
(`SailsTransport`, `SailsIntentFacade`, `InMemoryEscrowKeyIndexStore` are
correctly excluded from the barrel and correctly unused by the UI), zero
hardcoded credentials or internal-only headers. `sailsClient` is
constructed with only `{ baseUrl }}` — identical constructor surface any
partner has. `@satsails/p2p-trading-sdk`'s `package.json` has no `private`
field, a real semver, `exports` map, and `prepublishOnly` — genuinely
`npm install`-able externally, not repo-internal-only. **See §10 (Partner
Parity Matrix) for the one real, but non-structural, asymmetry found: the
reference UI's own `login()` derives both the session's Authentication
artifact and its `WalletAdapter` from the identical keypair — a
reference-UI convenience, not a protocol-level privilege (System Coherence
Audit finding F-09).**

**1.6 — P3-F08.1 and P3-F08.2 are confirmed still open, with concrete,
worse-than-previously-documented evidence.** `packages/sails-ui/src/context/AuthContext.tsx`
has no listener for a 401 anywhere; `user` state is only ever cleared by an
explicit `logout()` call (line 187-192) — a server-side session expiry
leaves `user` truthy indefinitely. No app-wide interceptor exists in
`sailsClient.ts`, `transport.ts`, or `App.tsx`. Worse: `Trade.tsx`'s
**primary** trade-data fetch (`sailsClient.openp2p.getTrade(id)`,
lines 190-254) has **no `.catch()` at all** on its outer async IIFE — only
the two *speculative* escrow-signing calls are caught
(`ignoreExceptWrongPassphrase`). A session expiring while a user has
`Trade.tsx` open today produces an **unhandled promise rejection with zero
user-visible reaction** on the single page where funds are actively moving
— not merely "no interceptor," but total silence on the primary fetch
path. `OfferDetail.tsx:148-156` already has a working return-path
convention for the *initial* auth gate (`navigate('/login', { state: { from,
amount } })`, consumed by `Login.tsx`'s own `navigate(state?.from ?? '/',
...)` on success) — but no equivalent exists for a **mid-flow forced
re-auth**. See §15 for the bounded fix.

---

## 2. Partner Integration Architecture

Three cooperating boundaries, none of which collapse into one another —
this is the architecture, not a new invention, since §1 confirms all three
already exist independently:

```
┌─────────────────────────────────────────────────────────────────┐
│  Partner Application (their UX, their brand, their users)         │
│                                                                     │
│   ┌───────────────────────────────────────────────────────────┐  │
│   │  @satsails/p2p-trading-sdk  (published, public, versioned)  │  │
│   │                                                               │  │
│   │   SailsClient ── identity / liquidity / openp2p / settlement │  │
│   │                  / reputation / proof / peers / capabilities │  │
│   │                                                               │  │
│   │   WalletAdapter (optional, injected)  ◄── partner's OWN      │  │
│   │   ├─ getAddress / getBalance / signTransaction /             │  │
│   │   │  broadcastTransaction / signMessage / getCapabilities    │  │
│   │   └─ partner's wallet stack lives HERE, entirely client-side │  │
│   │                                                               │  │
│   │   CustodyProvider (optional, RFC-020) ◄── how an escrow      │  │
│   │   │  is held/released — independent of WalletAdapter          │  │
│   └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │  HTTP + WS, versioned public routes
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Sails Protocol backend (this repo's `src/`)                     │
│                                                                     │
│   Identity (User.id record; User.publicKey = Economic Identity's    │
│   current representation, §1.4)                                     │
│   Session (Ed25519 challenge-response, bearer token) — Transport   │
│                                                          auth        │
│   SettlementProvider registry (MULTISIG / LIGHTNING_HODL /          │
│   WDK_USDT_EVM / SAFE_GUARD_EVM) — Funds Authority execution,       │
│   entirely server-side, never touches a partner's private key      │
└─────────────────────────────────────────────────────────────────┘
```

The load-bearing property this diagram must preserve (Hard Constraint):
**nothing crosses from the right column into the left one that a
partner's own `WalletAdapter`/`CustodyProvider` couldn't equally supply.**
§10 verifies this holds today.

---

## 3. End User Journey (as it exists today, annotated with gaps)

| Step | Current reality | Gap? |
|---|---|---|
| Discover/enter P2P | `Marketplace.tsx` — browsable with no auth (`Layout.tsx` renders `<Outlet/>` regardless of `user`). Confirms "Browsing ≠ Authentication." | none |
| Authenticate where required | `OfferDetail.tsx`'s "Iniciar Trade" checks `user`, redirects to `/login` with `{state:{from, amount}}` if absent | none — this is the working precedent §15 generalizes |
| Establish/recover Economic Identity | `Login.tsx` → `AuthContext.login(passphrase)` → decrypt-or-generate Ed25519 keypair → `identity.create()` (once) → `identity.authenticate()` (every login) | recovery-across-a-different-wallet is **not implemented and not frozen** — §9 |
| Connect partner wallet authority | Reference UI: `LocalKeypairWalletAdapter` wraps the SAME identity keypair (F-09, §10) — a real partner would inject their OWN `WalletAdapter` here instead | none structurally; reference UI's convenience conflation is disclosed, not hidden |
| Create/accept economic intent | `sailsClient.liquidity.publish()` / `.openp2p.trade()` | none |
| Fund/sign | `EscrowPendingTransaction` (real name, not `FundingInstruction`/`SigningRequest` — see §6.1) via `initiateRelease()`/`initiateRefund()`/`getPendingTransaction()`, signed via `submitTransactionSignature()` | none in the mechanism; naming mismatch with mission brief noted |
| Preserve trade context across interruption/re-auth | **Does not exist today for mid-flow expiry** (P3-F08.2) | **real gap — closed by Slice 1, §15** |
| Complete/recover | Trade lifecycle unaffected by this mission | none |
| Retain identity and reputation continuity | The durable Participant record (`User.id`) persists across sessions, and reputation columns live on that same row — but today the ONLY way back to that row is re-authenticating with the SAME `publicKey` (no rotation mechanism exists), so continuity is, in practice, continuity of the key, not yet a property of `User.id` independent of it | continuity across a **different** keypair/wallet is the unresolved recovery question — §9; whether `User.id` should become an abstraction independent of its authenticating key is §14's new architecture-decision item |

---

## 4. Partner Integration Journey (as the SDK supports it today)

| Step | Current reality | Gap? |
|---|---|---|
| Install SDK | `npm install @satsails/p2p-trading-sdk` — genuinely publishable (§1.5) | none |
| Initialize Sails | `new SailsClient({ baseUrl })` | none |
| Provide wallet capability | Pass `{ wallet: MyWalletAdapter }` to the constructor, or call `sailsClient.setSessionToken`-style setters later | none |
| Handle session/auth | `identity.create()`/`identity.authenticate()`; session token held in `SailsTransport`, sent as `Authorization: Bearer` on every `auth:true` call | **no app-wide session-expiry SIGNAL exists in the SDK today** — §15 adds one, generically, for every SDK consumer, not just `sails-ui` |
| Expose Economic Identity | `identity.me()` / `identity.get()` return `PublicParticipant`/`Participant` — carries `id` (the durable record), `publicKey` (Economic Identity's current representation), and `peerId` (Transport Identity) together, §1.4 | none |
| Receive `FundingInstruction`/`SigningRequest` | Real equivalent is `EscrowPendingTransaction` (§6.1) | naming only — mechanism is real and already public |
| Sign through partner's own wallet stack | `WalletAdapter.signTransaction`/`signMessage`, or the escrow-key helpers in `packages/sails-sdk/src/...` (`generateEscrowKeypair`, `signEscrowPsbt`, `verifyAndSignEscrowPsbt`, etc.) — all public exports | none |
| Observe settlement state | `settlement.get(escrowId)`, `getPendingTransaction()`, WS events | none |
| Handle recovery/unknown/interruption | Error taxonomy is public and complete (§6.2) — but **no documented caller-reaction contract** exists for `SailsAuthError` (checked `docs/API_STABLE.md` directly: absent) | real, but bounded — §15 gives the SDK a hook; the *contract* (what a caller SHOULD do) becomes this doc §7 |
| Render partner-owned UX | Fully partner-controlled; nothing in the SDK dictates presentation | none |

---

## 5. WalletAdapter Responsibility Boundary

Answering Key Architecture Questions 1-2 directly, from §1.1/§1.2 evidence:

**What a `WalletAdapter` actually owns (confirmed, not proposed):**
- Producing an address for a given asset (`getAddress`)
- Reporting a balance (`getBalance`)
- Signing a transaction or an arbitrary message with the user's own key
  material (`signTransaction`, `signMessage`) — the key never leaves the
  adapter's own implementation
- Broadcasting an already-signed transaction (`broadcastTransaction`)
- Declaring what it supports (`getCapabilities`) so the SDK/caller can
  branch on asset/rail support without guessing
- Optionally, its own peer-transport identity (`getPeerId`) and disconnect
  lifecycle

**What must never be delegated to a `WalletAdapter` (derived from what
NO implementation or server code asks it to do):**
- Escrow lock/release/refund/split logic — that is `SettlementProvider`'s
  job, server-side, and no `WalletAdapter` method resembles it
- Deciding *which* `SettlementProvider`/rail a trade uses — that is a
  server-side registry decision (`settlement-provider-registry.ts`)
  against a `SettlementScope`, not something a client-side adapter is ever
  asked
- Holding or attesting to Economic Identity — `WalletAdapter` signs
  TRANSACTIONS; it does not register a Participant, does not create a
  `User` row, and does not itself claim to BE the durable record OR the
  Economic Identity representation attached to it (§1.4's own four-way
  distinction)
- Enforcing authorization/capability checks — those are `capabilityRegistry`
  checks server-side (RFC-013/RFC-005), never something a `WalletAdapter`
  is consulted about
- Escrow-key derivation/custody bookkeeping — that is `CustodyProvider`'s
  job (RFC-020), a **separate**, also-optional SDK abstraction

**Q3 — How is Funds Authority proven without equating wallet key with
Economic Identity?** Today's actual mechanism: Funds Authority is proven
per-transaction, at signature-verification time, against whatever key a
`WalletAdapter`/`CustodyProvider` used to sign — the protocol never asks
"is this the SAME key as your Economic Identity's `publicKey`?" A
participant's Economic Identity (`User.publicKey`) can, in principle, be
associated with signing authority delegated to a *different* key entirely
for a given escrow (this is exactly what `SAFE_GUARD_EVM`/`RFC-020`'s KMS
co-signer model already does — the escrow's signing key is not the
participant's own identity key). The binding is: Economic Identity says
WHO is trading (backed by the durable `User.id` record it's attached to);
a `WalletAdapter`/`CustodyProvider` signature proves WHOSE FUNDS moved for
this specific transaction — the protocol verifies the signature against
the transaction's own required-signer set, never against the identity
record itself. **This separation already holds in code** (RFC-019/RFC-020's
own stated purpose is closing the one place it didn't: `WdkSettlementProvider`
signing from one server-held seed — a disclosed, in-progress-remediation
gap, not a design flaw in the adapter boundary itself).

---

## 6. Economic Identity / Funds Authority / Transport Identity Boundary

**6.1 — Naming correction, made explicitly (not silently):** the mission
brief's `FundingInstruction`/`SigningRequest` do not exist under those
names anywhere in this codebase. The real, shipped, frozen (`docs/API_STABLE.md`)
equivalent is `EscrowPendingTransaction` (`packages/sails-sdk/src/types.ts:287-315`):
`{ id, escrowId, kind: 'release'|'refund'|'split', toAddress, unsignedPsbtBase64,
requiredSigners, signedBy?, ... }` (`signatures?` is deprecated and no longer returned since Issue #239 — the
server never hands out another participant's signed PSBT), produced by `initiateRelease()`/`initiateRefund()`,
consumed via `getPendingTransaction()`, and closed via
`submitTransactionSignature()`. This document uses the mission's vocabulary
where it clarifies intent, but the actual integration contract a partner
implements against is `EscrowPendingTransaction`, not an invented type.

**6.2 — The three-identity boundary, stated as this repo's own frozen,
ALREADY-CORRECTED truth (§1.3/§1.4) — no correction owed here:**

- **Economic Identity** — currently represented by `User.publicKey`,
  attached to the durable Participant record `User.id`. Non-custodial by
  requirement. `User.publicKey` is WHO the protocol currently recognizes a
  participant to be across sessions, trades, and reputation history (in
  practice, via that same durable row) — see §1.4's own explicit
  "database row identity ≠ automatically protocol Economic Identity"
  statement and §14's new architecture-decision item on whether that
  should change.
- **Funds Authority** = whoever can produce a valid signature satisfying an
  `EscrowPendingTransaction`'s `requiredSigners` for a specific asset/rail.
  Proven per-transaction, never assumed from either identity
  representation above.
- **Transport Identity** = `User.peerId`, today an ephemeral, per-session
  P2P transport identifier (`pear.service.ts`, HyperDHT/Hyperswarm-based),
  **regenerated every session** since the 2026-08-09 fix that made
  `PearNode.start()` produce a fresh keypair each time.

**`CRYPTOGRAPHIC_MODEL.md`'s own corrected status (verified directly,
2026-09-14):** `docs/CRYPTOGRAPHIC_MODEL.md` §1 carries a dated
"Corrected/Current-truth update (2026-09-08, TECHNICAL_DEBT_AUDIT.md item
60)" block (added by PR #93, merged 2026-09-08) stating exactly the
`publicKey`/`peerId` split above, verbatim, including "the association
between the two is server-mediated... not an independent cryptographic
binding." **This document previously, incorrectly, claimed that file was
still stale and registered a duplicate correction obligation — removed;
see §17.**

**6.3 — Q4/Q5, answered honestly as unresolved (see §9 for why this is not
decided here):** there is currently **no relationship** between a recovery
root/seed and Economic Identity beyond "whichever key currently holds the
`User.publicKey` slot can authenticate as that identity" — and there is no
key-rotation or recovery mechanism at all today (`IDENTITY_ARCHITECTURE_DISCOVERY.md`
§3.2/§10, confirmed). A returning user recovering Economic Identity across
a *different* compatible wallet is **not implemented, and the repo's own
identity-architecture research explicitly says it is not yet safe to
freeze a derivation scheme** (B/STOP verdict). This mission's Hard
Constraints (never derive Economic Identity from a wallet address for
convenience; never equate a recovery seed with public identity; never
freeze cryptographic derivation before evidence/privacy analysis) are
fully consistent with that existing B/STOP — Mission 3 does not override
it, and should not.

**6.4 — Q6, unlinkability:** the one piece of this boundary already
proven privacy-sound is Transport Identity's ephemerality — a fresh
`peerId` per session means past P2P transport activity cannot be
correlated across sessions by transport identity alone. What is **not**
yet analyzed (and therefore not decided) is whether a future Economic
Identity ↔ Transport Identity binding (ADR-001 §7.1's named, unbuilt
obligation) could re-introduce linkability — this is exactly why §9 keeps
that binding a hypothesis, not a design.

---

## 7. Session and Re-Auth Model

**Current model (confirmed, §1.6):** session = a bearer token issued by
`identity.authenticate()`, held only in `SailsTransport`'s in-memory field,
never persisted (a page refresh always forces re-authentication by design,
since the AES key that would unlock the stored keypair cannot be
re-derived without the passphrase). Nothing observes the token going
stale; the only failure signal is a `SailsAuthError` (401) thrown from
whichever specific call happened to be in flight when the server rejected
it.

**Q7, answered by the design in §15:** re-authentication and session
expiry preserve active trade context via the SAME mechanism the initial
auth gate already uses — a router-level `{ state: { from } }` payload
consumed by `Login.tsx`'s existing post-login redirect. The **new** piece
is a **generic, SDK-level signal** (`onSessionExpired`) that fires
regardless of which specific call site detected the 401, so the reaction
doesn't depend on every future call site remembering to handle it
individually (the failure mode found in §1.6 — one page's primary fetch
had literally no `.catch()` at all).

**Governing property (Mission 3 R2, stated explicitly so it is never
re-violated by a future change):** many failed requests may observe one
expired session. They must converge on one session-expiry episode.
Request failure multiplicity ≠ session-expiry multiplicity. The SDK-level
signal (`onSessionExpired`) is deliberately per-request — it does not,
and should not, try to deduplicate at the transport layer, since the
transport has no concept of "the same session episode" beyond the token
value itself, which a UI consumer is better positioned to reason about
alongside its own login/logout lifecycle. Convergence is therefore a
product/UI-layer responsibility, done once, centrally, in
`lib/sessionEpochGate.ts` — not re-implemented per call site, and not
assumed away by treating the SDK hook as if it already had once-only
semantics.

**Q8, answered:** an SDK consumer (including `sails-ui`) can observe that
a session expired (`onSessionExpired` fires) without gaining any new
authority — the callback receives only the thrown `SailsAuthError`
(message + code), never a new token, never elevated access. Observing
expiry and reacting to it (clear local state, redirect) requires nothing
the partner wouldn't already have (the SDK already surfaces `SailsAuthError`
to every caller; this only widens WHERE it's observable, from "wherever
the call happened to be" to "one central place too").

---

## 8. Trade-Context Continuity Model

Scope, stated precisely (to avoid inventing more than is justified): "trade
context" that Slice 1 preserves is **which page/trade the user was on**,
via the URL itself (`/trade/:id` already encodes the trade), returned to
via the existing `{state:{from}}` convention. This is **sufficient** for
`Trade.tsx`'s own re-fetch-on-mount behavior (§1.6 shows the whole page
state is rebuilt from `getTrade(id)` on every mount, keyed only by the URL
param) — remounting the SAME URL after re-auth reconstructs the same view.

**Explicitly NOT covered by Slice 1 (disclosed, not hidden):** ephemeral,
un-persisted in-memory form state (a half-typed chat message, an
in-progress dispute-evidence textarea, a not-yet-submitted payout address)
is lost on remount, same as it would be on any hard refresh today. Building
a generic draft-preservation mechanism was considered and rejected for
Slice 1 as scope creep beyond what P3-F08.2 actually asked for
("trade-context-preserving... return path," which `OfferDetail.tsx`'s own
existing precedent already defines as "which page, plus one or two
primitive fields," not full form-state serialization) — registered in §17
as a real, separate, future backlog item if product wants it.

---

## 9. Recovery Model — Hypotheses Only (NOT FROZEN)

**This entire section is explicitly not a decision.** Per Hard Constraints
("do not freeze cryptographic derivation before evidence and privacy
analysis") and the repo's own existing B/STOP verdict
(`IDENTITY_ARCHITECTURE_DISCOVERY.md`), Mission 3 does not resolve Q4/Q5.
What follows are candidate directions surfaced for a future, dedicated
evidence-gathering pass — not a menu to pick from casually.

- **Hypothesis R1 — Server-side recovery, out-of-band re-linking.** A
  participant proves control of their EXISTING durable Participant record
  (`User.id`) via some out-of-band channel (not yet specified —
  email/social/hardware-key are all unexamined for this protocol's own
  threat model) and the server re-associates a NEW `publicKey` (a new
  Economic Identity representation) with that same `User.id`. Preserves
  reputation continuity trivially (it's the same row). Risk: this is a
  centralization point and a real attack surface (account-takeover via
  whatever the out-of-band channel is) — explicitly flagged, not
  minimized. **Note:** R1 only makes sense as a recovery mechanism if
  `User.id` is treated as a stable abstraction independent of whichever
  key currently authenticates it — exactly the §14 architecture question
  this document declines to pre-decide; R1 is presented as a hypothesis
  that WOULD depend on that decision going a particular way, not as
  evidence the decision has already been made.
- **Hypothesis R2 — Deterministic derivation from a recovery root, with a
  DIFFERENT key per protocol/purpose.** A BIP-32-style hierarchical
  derivation where the Economic Identity key is one leaf and a wallet's
  own funds-authority key is a sibling leaf — satisfying "same recovery
  root ≠ same key" literally. Unexamined here: what root, held by whom,
  and what privacy consequence a shared root creates if two supposedly
  "different" identities are ever provably derived from the same root
  (a correlation risk, not a made-up one — this is exactly the class of
  question `IDENTITY_ARCHITECTURE_DISCOVERY.md` flagged as unresolved).
- **Hypothesis R3 — No recovery across wallets; recovery is wallet-scoped,
  identity is wallet-scoped.** The simplest, most conservative option:
  Economic Identity is genuinely 1:1 with a key for its lifetime, and
  "switching wallets" means starting a NEW Economic Identity (losing
  reputation continuity, by design, not by accident). This trades user
  convenience for a much smaller cryptographic/privacy surface. Worth
  taking seriously precisely because it adds nothing new to reason about.

**Recovery relationship ≠ public identity relationship (mission's own
constraint)**, restated as a requirement any of R1-R3 must satisfy: even
if a future scheme lets a user recover access to their OWN identity via a
shared root/relationship, that relationship must never become discoverable
by a third party observing two participants' PUBLIC identities (i.e., no
scheme is acceptable if it lets an outside observer prove "these two
`User.id`s share a recovery root" from public protocol data alone).

**Recommendation:** do not decide among R1/R2/R3 in this mission. Register
as a dedicated future evidence-gathering item (§17), explicitly scoped to
threat-model and privacy analysis BEFORE any derivation scheme is
prototyped, per the Hard Constraint.

---

## 10. Partner Parity Matrix

Direct output of the mechanical audit (§1.5), classified per the mission's
own required categories:

| Satsails-Wallet-visible capability | Available to a partner via public SDK? | Classification |
|---|---|---|
| `SailsClient` construction (`{ baseUrl }`) | Yes, identical constructor | **No gap** |
| Every SDK module (identity/liquidity/openp2p/settlement/reputation/proof/peers/capabilities/arbitration/paymentAccounts/agents) | Yes, all exported from `index.ts` | **No gap** |
| `WalletAdapter` injection | Yes, same optional constructor field | **No gap** |
| Escrow signing helpers (`generateEscrowKeypair`, `signEscrowPsbt`, `verifyAndSignEscrowPsbt`, `signEscrowArkTx`, `signEscrowSafeUserOp`, etc.) | Yes, all public exports | **No gap** |
| `CustodyProvider`/RFC-020 types (`ERC4337CustodyProvider`, `BitcoinCustodyProvider`, `SailsSignerService`) | Yes, all public exports | **No gap** |
| Reference UI's `login()` deriving BOTH session auth AND `WalletAdapter` from one identical keypair | No partner is required to do this — it's a convenience shortcut of the reference UI's OWN demo key-management, not a capability the protocol grants only to Satsails Wallet | **Implementation shortcut** (System Coherence Audit F-09) — a partner using a REAL external wallet would naturally keep these separate, which is the MORE correct pattern, not a privilege gap |
| App-wide session-expiry reaction | **Did not exist for anyone, including Satsails Wallet's own reference UI**, before this mission (§1.6) | **Missing public capability** — closed for everyone simultaneously by Slice 1 (§15), added to the SDK itself, not `sails-ui`-only |
| Trade-context-preserving re-auth return path | Existed only for the initial auth gate (`OfferDetail.tsx`), not mid-flow | **Missing public capability**, same fix, same scope note |
| Any raw backend `src/` access, internal headers, or bypass of the SDK barrel | None found anywhere in `sails-ui` | **No gap (verified negative)** |

**Bottom line (the mission's own required Partner Parity question,
answered directly):** as of this baseline, Satsails Wallet's reference UI
is NOT using any Sails capability a third-party wallet could not access
through the public integration model. The two real findings (F-09's
convenience conflation, and the two session/re-auth gaps) are (a) an
implementation shortcut that a real partner wouldn't even reproduce, and
(b) missing capabilities that were missing for Satsails Wallet too, not
privileges reserved for it. **No architecture leak or product-decision-
required asymmetry was found.**

---

## 11. Failure / Interruption Matrix

| Failure | Current behavior | Behavior after Slice 1 |
|---|---|---|
| Session expires while browsing (no active trade) | Silent — `user` stays truthy, next authenticated action fails with an uncaught or locally-handled 401 depending on the page | Global interceptor clears state, one toast, redirect to `/login` (no `from` needed — nothing to return to) |
| Session expires while `Trade.tsx` is open (primary fetch) | **Unhandled promise rejection, zero user feedback** (§1.6) | Interceptor fires from the SDK transport layer regardless of the calling code's own catch coverage; toast + redirect to `/login` with `{state:{from: '/trade/:id'}}`; `Login.tsx`'s existing logic returns the user to the same trade on success |
| Session expires during a speculative background escrow-signing check | Previously: local toast only ("sessão expirou... para continuar acompanhando"), page stays put with a now-dead session | Global interceptor's redirect supersedes the local toast (removed to avoid a double reaction) — same outcome, now with an actual path back to a live session instead of a static toast |
| Login itself fails (wrong passphrase, wrong signature, network) | `Login.tsx`'s own catch block, unaffected | **Unchanged** — the interceptor only fires when a PREVIOUSLY-active session (`user` truthy) goes stale, never for a fresh login attempt's own failure (see §15's exact guard) |
| Network failure / timeout (`SailsTransportError`) mid-trade | Existing `classifySigningWatchError` → `'unknown'` toast for the two speculative calls; primary fetch still uncaught | **Unchanged by Slice 1** — this is a distinct, already-partially-handled failure class, not in scope for this bounded fix (registered as a related but separate gap in §17 if the primary-fetch uncaught-rejection issue should be generalized beyond just auth errors) |
| Wrong passphrase (local decrypt failure, not a server rejection) | `WrongPassphraseError`, already handled distinctly everywhere it's checked | **Unchanged** — never routed through the new interceptor, since it never reaches the transport/server at all |
| Forbidden (403, wrong actor) | Local classification only, per call site | **Unchanged** — only `SailsAuthError` (401) triggers the new interceptor; `SailsForbiddenError` is a different, already-correctly-distinguished failure mode that does not mean "your session is dead" |

---

## 12. Security and Privacy Implications

- **The new SDK hook (`onSessionExpired`) receives only the error object,
  never a new credential** — it cannot be used to escalate authority, only
  to observe that authority was lost. Reviewed against Hard Constraint
  "What can an SDK observe without gaining authority?" — satisfied by
  construction.
- **The hook is opt-in and additive** — omitting it preserves today's exact
  behavior (an uncaught rejection or locally-handled error, depending on
  the call site), so no existing integrator's behavior changes without
  their own code change to register a handler.
- **No new PII crosses the wire** — the redirect-with-return-path pattern
  carries only a client-side route path (already visible in the browser's
  own address bar) through React Router's in-memory navigation state,
  never sent to the server, never logged server-side.
- **Recovery (§9) is deliberately NOT implemented** in this mission —
  this is itself a privacy-positive choice: no new correlation surface
  between identities is introduced until the unlinkability analysis Q6
  requires has actually been done.
- **`WrongPassphraseError` and `SailsForbiddenError` are deliberately
  excluded from the new interceptor** — conflating "your password was
  wrong" or "you're not allowed to do this specific thing" with "your
  session expired" would be a real information-quality regression (a user
  told "session expired, please log in again" when they actually typed
  the wrong passphrase would be actively misled about what to fix).

---

## 13. Product Decisions Required

1. **Recovery model direction (§9)** — R1 vs. R2 vs. R3, or a fourth
   option not yet surfaced. Explicitly not decided here; needs a dedicated
   evidence-and-privacy pass, per the Hard Constraint, before any
   engineering commitment.
2. **Whether "switching wallets loses reputation continuity" (R3) is an
   acceptable default answer** for V1, even temporarily, while R1/R2 are
   evaluated — a real product-facing tradeoff between honesty (R3 is
   simplest and safest) and user experience (R1/R2 preserve continuity but
   carry unresolved centralization/privacy costs).
3. **Whether the reference UI's F-09 conflation (identity key = wallet
   adapter key) should be corrected in the reference implementation
   itself** to more faithfully demonstrate the intended separation for
   anyone reading `sails-ui`'s source as a integration example — currently
   correct-by-absence-of-restriction, but potentially misleading as a
   worked example.
4. **Whether draft/in-progress trade-context state (chat drafts, evidence
   text, un-submitted payout addresses) is worth preserving across forced
   re-auth** beyond what Slice 1 does (§8) — a real UX investment decision,
   not an architecture question.

---

## 14. Architecture Decisions Required

1. **Where the Economic Identity ↔ Transport Identity binding (ADR-001
   §7.1) should live, if it's ever built** — this mission does not design
   it (§6.4/§9), only confirms it remains unbuilt and named.
2. **Whether `onSessionExpired` should eventually become part of a richer,
   general "SDK lifecycle events" surface** (session restored, token
   refreshed, rate-limited, etc.) rather than a single-purpose hook — Slice
   1 deliberately ships the single-purpose version now (smallest correct
   mechanism) rather than speculatively building a generic event bus; if
   more lifecycle signals are needed later, this is the natural extension
   point, not a redesign.
3. **Whether `User.id` (the durable Participant record) should become the
   CANONICAL Economic Identity abstraction, with `User.publicKey` demoted
   to "the key currently authenticating it" (rotatable), rather than
   `publicKey` itself being the Economic Identity representation as it is
   today (§1.4/§6.2).** Raised directly by Hypothesis R1 (§9) — R1 only
   makes sense as a recovery mechanism under this reframing. Explicitly
   NOT decided by this mission (Mission 3 R1's own correction instruction:
   "do not silently freeze it") — this is a real architectural fork with
   consequences for the recovery-model evidence pass (§9/§17) and for
   every place this document (and this repo's own `DAY0_COMPLETENESS_COLD_SWEEP.md`
   §3.5 taxonomy) currently states Economic Identity's representation.

---

## 15. Implementation Slice Recommendation — Slice 1: Session-Expiry Interceptor + Return-Path Continuity

**Why this slice, and only this slice:** every other candidate piece of
this mission (recovery model, cryptographic identity binding, a new
partner-facing example wallet) either touches something this repo's own
research explicitly marks B/STOP (§9) or requires a product decision not
yet made (§13). P3-F08.1/P3-F08.2, by contrast, are (a) explicitly named in
the mission's own Mandatory Inputs as things Mission 3 must consume, (b)
already scoped by the PRE-M3 gate text itself ("Mission 3 may reason about
and resolve F-08.1/F-08.2"), (c) backed by a clear, already-proven design
precedent in this same codebase (`OfferDetail.tsx`'s return-path pattern),
and (d) implementable without touching identity, custody, or recovery
semantics at all — a pure session-lifecycle/UX fix, fully reversible, zero
protocol-level risk.

**Exact design:**

1. **SDK (`packages/sails-sdk`):** `SailsTransport` gains an optional
   `onSessionExpired?: (err: SailsAuthError) => void` constructor option
   and a `setOnSessionExpired()` setter (mirroring the existing
   `setSessionToken()` pattern). The transport's own request-handling code
   invokes it only when a request that **actually dispatched carrying an
   established session token** receives a response that maps to
   `SailsAuthError` — invoked before the error is thrown, wrapped in its
   own try/catch so a broken handler can never break the real request
   flow. **Corrected (Mission 3 R1):** the original condition
   (`opts.auth === true`) was insufficient — an `auth: true` request can
   exist with no session token at all, and "no session ≠ expired session."
   The transport now captures whether THIS SPECIFIC request dispatched
   with a real token in a local variable at header-construction time
   (`dispatchedWithSessionToken`), and gates the hook on THAT captured
   value — never on a later, possibly-mutated read of the transport's
   current token (which could have changed, e.g. via a concurrent
   `logout()`, while this same request's retries were still in flight).
   `SailsClient` exposes the same option/setter, delegating to the
   transport, exactly like `setSessionToken()` already does. **This is a
   generic SDK capability, available to every integrator, not a
   `sails-ui`-only mechanism** — directly satisfying §10's parity
   requirement for this fix.
2. **`sails-ui`'s `AuthContext.tsx`:** registers the handler once — but
   the handler itself can be CALLED more than once for the same
   underlying expiry. **Stated precisely (Mission 3 R2 correction): the
   SDK's `onSessionExpired` fires once per QUALIFYING REQUEST, not once
   globally.** Multiple authenticated requests legitimately share one
   session token; if it goes stale, several of them can independently
   401 and each correctly reach this handler for the SAME episode — the
   SDK is not wrong to call it more than once here, and this document
   does not claim otherwise. Convergence to ONE UI reaction is a
   **product/UI-layer responsibility**, not an SDK one: `lib/sessionEpochGate.ts`
   (a small, pure, React-free module, unit-tested directly) is the sole
   authoritative "is there an active session, and which one" truth —
   `login()`/`logout()` call its `activate()`/`deactivate()` synchronously,
   at the exact point they change session state (never inside a
   `useEffect`, which only runs after React commits and cannot provide
   mutual exclusion against several handler invocations arriving before
   it does), and the handler calls its `claimExpiry()` — an atomic
   check-then-clear, synchronous by construction — so only the FIRST
   invocation for a given episode ever clears state and records a
   `sessionExpiry` signal; every other concurrent invocation for that
   same episode (and any late invocation after an explicit `logout()`)
   correctly no-ops. `sessionExpiry.episode` is a real, locally-unique,
   strictly-increasing counter, not a wall-clock timestamp (`Date.now()`
   is neither guaranteed unique nor strictly monotonic for near-
   simultaneous calls — precisely the case this mechanism has to get
   right).
3. **New `sails-ui` component** (mounted once, inside `<BrowserRouter>`,
   so it has router context): watches that signal, and on a NEW expiry
   (not already handled), shows one toast and navigates to `/login` with
   `{ state: { from: <path the user was on> } }` — reusing, not
   reinventing, `Login.tsx`'s existing post-login return logic.
4. **`Trade.tsx`:** removes its own now-redundant local `'session-expired'`
   toast case (the global interceptor supersedes it with a strictly better
   outcome — a real path back to a live session, not just a toast).

**Explicitly out of scope for Slice 1** (per this mission's own Hard
Constraints and §8's scope statement): no draft-state preservation, no
change to `SailsForbiddenError`/`WrongPassphraseError` handling, no change
to the primary-fetch uncaught-rejection pattern for NON-auth errors (a
related but distinct gap, registered in §17), no recovery-model work.

---

## 16. Evidence Plan

- `npx tsc --noEmit` clean at repo root, `packages/sails-sdk`,
  `packages/sails-ui`.
- New SDK-level unit tests in `packages/sails-sdk/tests/` proving the
  corrected (Mission 3 R1) firing condition exactly: (1) `auth:true` +
  a real session token + a 401 response → fires exactly once; (2)
  `auth:true` + NO session token + a 401 → does not fire (this is the
  case the original condition missed — "no session ≠ expired session");
  (3) `auth:false` + a 401 → does not fire; (4) a 403 (or other error
  class) on an authenticated call with a real session → does not fire;
  (5) a handler that itself throws never replaces the real request's own
  thrown error.
- `packages/sails-ui` has no test runner (TD#62/#63, disclosed, pre-existing,
  unchanged by this mission) — verified instead via `tsc --noEmit` plus a
  live dev-server browser check: simulate an expired session (clear the
  transport's session token while `user` is still set, or force a 401 via
  a mocked response) while on `/trade/:id`, confirm the toast fires and the
  browser lands on `/login`, then confirm a successful login returns to
  the SAME `/trade/:id` URL.
- Mission 3 R2 — the ONE piece of UI concurrency logic this mission
  needed to prove could not honestly be left to "no test runner, so no
  test": `lib/sessionEpochGate.ts` was extracted specifically so it could
  be unit-tested directly (same extraction reasoning
  `escrowErrorClassification.ts` already established), proving: (1) one
  active session + one claim → exactly one non-null episode; (2) one
  active session + several "concurrent" claims (simulating multiple
  requests independently 401ing on the same expired token) → exactly ONE
  claim succeeds, every other returns null; (3) a genuine re-login after
  a claimed expiry produces a fresh, distinct, later episode, handled
  normally; (4) logout followed by a late claim from a stale in-flight
  request never manufactures a new episode; (5) a claim before any login
  ever happened also returns null. Repeated the live browser re-auth
  journey with GENUINE concurrent authenticated requests (not simulated
  one-at-a-time) against the corrected mechanism.
- Full backend unit suite unaffected (this slice touches no `src/` file) —
  re-run anyway as a regression check, since `packages/sails-sdk` is a
  workspace dependency of tests that import it.

---

## 17. Master Backlog Delta

**Corrected 2026-09-14 (Mission 3 R1) — rebuilt after removing a duplicate
obligation this document had mistakenly registered.** Each item below is
classified per the CTO's own required categories: genuinely new
obligation; already registered obligation / cross-reference only; Product
Decision required; Architecture Decision required. Numbers remain
placeholders, assigned at `docs/BACKLOG.md` registration time.

**Reconciled, NOT a new obligation (duplicate found and removed):** the
original version of this document registered a **[NEW-C]** item claiming
`docs/CRYPTOGRAPHIC_MODEL.md` §1 still carried a stale identity claim and
needed a correction PR. **This was wrong** — PR #93 (merged 2026-09-08,
"institutional cold sweep... close #60") already corrected that exact
file directly, closing `docs/TECHNICAL_DEBT_AUDIT.md` item 60, with a
dated correction block already stating the current `publicKey`/`peerId`
split this document itself relies on (§1.3, §6.2). **No backlog item is
registered for this** — it is **already registered obligation / cross-
reference only**, satisfied by PR #93 and TD#60, both closed. Any future
reader of this document should treat `CRYPTOGRAPHIC_MODEL.md` §1 as
current, not stale.

**Genuinely new obligations:**

- **[NEW-A] P3-F08.1/F08.2 closure — Slice 1 implementation record.**
  Closed by this mission's Slice 1 (§15); full evidence per §16. Register
  as a closure record (these were escalated gaps, not previously-numbered
  `BACKLOG.md` items, so this is the first formal entry for them).
- **[NEW-B] Recovery model evidence-and-privacy pass (§9).** Dedicated
  future mission: evaluate R1/R2/R3 (or others) against the unlinkability
  requirement in §9's own closing paragraph, BEFORE any derivation scheme
  is prototyped. Explicitly blocked on nothing in this mission — can start
  independently, whenever prioritized. Depends on **[NEW-G]** below being
  decided first, or at least held open alongside it (R1 specifically only
  makes sense under one answer to that question — §9's own note).
- **[NEW-E] Primary-fetch uncaught-rejection pattern, generalized beyond
  auth (§11).** `Trade.tsx`'s (and possibly other pages') top-level
  data-fetch effects have no `.catch()` for non-auth errors either
  (network failure, 5xx, etc.) — Slice 1 only closes the auth-specific
  case via the new global interceptor; the broader "every page's primary
  fetch should have SOME user-visible failure state" pattern is a real,
  separate, larger UI-hardening item, not attempted here.

**Product Decision required:**

- **[NEW-D] Reference-UI F-09 conflation (§10, §13.3).** Whether
  `sails-ui`'s demo `login()` should visibly separate identity-key
  creation from `WalletAdapter` construction, so the reference
  implementation more faithfully models the intended partner pattern (a
  real wallet's OWN key, not the same key twice).
- **[NEW-F] Draft/in-progress trade-context preservation (§8, §13.4).**
  Whether chat drafts / evidence text / unsubmitted form state should
  survive a forced re-auth, beyond the URL-level continuity Slice 1
  already provides.

**Architecture Decision required:**

- **[NEW-G] Canonical Economic Identity abstraction — `User.id` vs.
  `User.publicKey` (§1.4, §6.2, §9's R1 note, §14.3).** Whether the
  durable Participant record (`User.id`) should become the canonical
  Economic Identity abstraction (with `publicKey` demoted to "the key
  currently authenticating it," rotatable), or whether `publicKey` itself
  should remain the Economic Identity representation, as this repo's own
  `DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5 and `CRYPTOGRAPHIC_MODEL.md` §1
  currently state. Explicitly NOT decided by this mission — raised by,
  and blocking a real choice in, Hypothesis R1 of the recovery-model pass
  (**[NEW-B]**).
