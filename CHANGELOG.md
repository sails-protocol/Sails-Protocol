# Changelog

All notable changes to this project will be documented in this file.

> **Current-truth note (2026-09-19):** This changelog is a historical change record, not an architecture or production-readiness authority. For current system truth, start with `README.md`, `docs/PROJECT_CONTEXT.md`, `docs/SYSTEM_DESIGN.md`, governing ADR/RFC/specification documents, and live GitHub Issues/Project state. Older entries below may describe implementation states that were true when recorded but have since evolved.

### September 2026 — current development highlights

- Current pre-v1 SDK source/package line is **0.2.0** for `@satsails/p2p-schemas`, `@satsails/p2p-trading-sdk`, and `@satsails/sdk-react`; publication/release claims remain governed by release evidence rather than this changelog alone.
- Added `docs/SYSTEM_DESIGN.md` as the consolidated current system-level technical map and aligned the repository entry path around it.
- Reconciled the canonical Protocol Whitepaper, Technical Paper, and P2P Trading SDK Paper with current institutional truth.
- Froze the current Capability Authority and Economic Disposition Authority architecture through ADR-004 / ADR-005 and continued path-specific hardening.
- Hardened production eligibility so protocol-representable settlement mechanisms do not silently become deployment-eligible.
- Hardened OpenProof/evidence authorization boundaries and direct trade-evidence bundle access.
- Established explicit distinctions between participant/economic identity, transport/communication identity, wallet funds authority, and optional external identity interoperability.
- Institutionalized the Day-0 multi-operator/shared-market target and the distinction between open/public and private/permissioned market contexts without redefining protocol semantics.
- Completed repository current-truth reconciliation across primary and specialized documentation.
- Production EvidenceProvider durability/provenance, cross-evidence integrity, upload controls, and remaining Day-0 production owners remain active under dedicated Issues; this changelog does not round active work up to completed readiness.


### Security
- **#235 R7H-E3 — seller authorization, PaymentAccount binding and payment-method reconciliation of escrow creation.**
  - **Seller only:** only the trade's seller creates its escrow (`escrow.service.ts` `createEscrow`). The caller is
    the authenticated session, or the DB-derived `trade.sellerId` for internal callers; a payload field never
    counts. The buyer, unrelated participants and unauthenticated callers are refused, with zero side effects.
  - **Binding on governed rails:** migration `20261017120000_escrow_seller_payment_binding`. A rail is governed
    once any policy version has listed it (V1: MULTISIG/BTC), monotonically. A new escrow on a governed rail
    requires, under the version in force, all of:
    - the rail is eligible;
    - the trade's seller is the one its offer committed;
    - the trade is bound to a payment account the seller owns, whose method equals the offer's;
    - that method is eligible.
  - **Where it is checked:** in the repository transaction under the trade lock, with row locks on the trade,
    offer and account (clean 409s). The escrow INSERT/rail-change trigger runs the same check, so direct writes
    are held to it too.
  - **Committed terms frozen:**
    - a payment account's owner, hash and method never change;
    - a traded offer's owner, side, asset, method and account are fixed;
    - an escrowed trade's parties, offer, asset and amount are fixed.
  - **Production:** creating an escrow on a rail no policy governs is refused.
  - **Retry:** a retry before `Trade.escrowId` is projected now gets a clean "already has an escrow" (409), not a
    unique-constraint error.
  - **Offer API:** `paymentMethod` is validated against the database's canonical enum, so a UI display-only method
    is refused with 400.
  - #235 is **not** closed.
  - **R7H-E3A:** 38 integration suites were migrated onto valid E3 preconditions through
    `tests/integration/economicFixtures.ts`. Each now uses a seller-owned PIX account bound to its offer and trade,
    and the seller creates the escrow.
    - This is a test-only change. No assertion was removed or relaxed, and no production code changed.
    - E1 test 3/C3 plants its non-PIX and unbound escrows as explicit historical rows: the E3 creation guard is
      lifted only inside that fixture's transaction.
  - **R7H-E3B — the UI binds the seller's receiving account:**
    - **SELL offer** (`PublishOffer.tsx`): on a governed rail, the maker types their key and explicitly confirms
      the binding. The UI then registers the account, verifies the returned row names the authenticated seller,
      and publishes with `paymentAccountHash`.
    - **BUY offer** (`OfferDetail.tsx`): the taker is the seller, so the taker does the same and the trade
      request carries the hash. The publisher's own account is never used.
    - **Trade page** (`Trade.tsx`): a legacy unbound trade, or an ineligible method, shows the seller why no
      protected escrow can exist instead of a "Criar Escrow" button. E3 refusals are shown in plain language.
    - **Policy source:** eligibility comes from a new public read-only endpoint, `GET
      /v1/settlement/economic-policy` (SDK `settlement.economicPolicy()`), backed by the database's own policy
      functions. Without it the UI publishes and trades nothing. The server remains the authority.
    - **Fix — duplicate registration:** two concurrent registrations of one new account hash (a double submit,
      or two participants) returned a 500. The unique-index loser now receives the winning row.
    - **Privacy:** a BUY taker's raw key never reaches the server. A SELL maker's key is persisted only as the
      offer's payment details, where it is shown to the buyer by design. The account hash is unsalted, so it does
      not keep a known or guessable key secret.
  - **R7H-E3C — canonical trade admission (CTO D-E3C-1, Option A):**
    - **Rule.** A new trade whose canonical escrow route is governed (V1: BTC → MULTISIG) is admitted only if
      that escrow could be authorized. `trade-repository.ts` evaluates the E3 function
      `escrow_economic_binding_violation()` on the new trade row, inside the transaction that inserts it. Any
      violation rolls the insert back and returns 409 `TRADE_ADMISSION_REFUSED`.
    - **Effect.** A refused admission leaves no trade, event, offer Intent walk, escrow or reservation. Legacy
      unbound governed SELL offers, unbound BUY takes and ineligible methods no longer admit trades that can never
      be escrowed.
    - **Rail.** The canonical route is the production one. A test-only MOCK escrow never makes such a trade
      admissible, in any environment. Assets without a governed canonical route are unchanged.
    - **No new authority.** No new policy engine and no migration (in E3C). Historical trades are untouched: their
      escrow stays refused.
    - **Public offer view** gains `paymentAccountBound`: whether a SELL offer carries its seller's committed
      account, never which one. It is not evidence of PIX-key control or identity. The UI shows such offers as
      non-executable and maps admission refusals to plain language.
    - **Tests.** Test-only fixture migration: 12 settlement suites now use bound PIX offers (identical test sets
      and assertions), and the E3 guard suites plant their invalid trades as historical rows after proving the
      new admission is refused.
  - **R7H-NF-E3C-5 (B2) — trade-scoped Intents and atomic trade admission** (RFC-018 Amendment A1;
    SDK minor: additive `Trade.tradeIntentId`, caller-scoped `getTradeByIntent()`):
    - **Defect fixed.** Every trade taken from an offer shared the offer's single, single-shot Intent. The second and
      later takers got an error (400/500) for a trade that existed and could be escrowed (deterministic, not a
      race), and one trade's cancellation or escrow lock rewrote the Intent every sibling depended on.
    - **Each new trade owns an Intent** (`trades.tradeIntentId`, migration `20261018120000_trade_scoped_intent`:
      additive, nullable, unique, foreign-keyed `RESTRICT`, fixed at creation; historical trades keep `NULL`, nothing
      is back-filled). `Trade.intentId` / `Offer.intentId` keep their meaning. The offer's Intent is the
      advertisement's and is no longer transitioned by trades.
    - **Atomic admission.** One PostgreSQL transaction commits the idempotency result, the trade's Intent with its
      hash-chained history, the trade, the unchanged E3C admission check and the durable trade / negotiation /
      Intent events. A refusal or crash before commit leaves nothing; anything after commit (event dispatch) is
      non-authoritative and can no longer become an error for a committed trade. No `IN_PROGRESS` claim is created
      in this scope any more; a refused admission leaves no claim row. Other idempotency scopes are unchanged.
    - **F-1.** `DELETE /v1/intents/:id` refuses (409 `INTENT_BOUND`) an Intent that an offer or a trade references,
      atomically with the cancellation. Free-standing Intents stay owner-cancellable.
    - **F-7.** `GET /v1/openp2p/trades/by-intent/:id` is scoped to the caller's own trades: one → 200, none or not a
      party → 404 (no longer a 403 naming another participant's trade), several → 409 `AMBIGUOUS_INTENT` with only
      the caller's own trade ids. For `dispute()` / `releaseAsset()` pass `trade.tradeIntentId`.
    - **Legacy.** Cancelling a pre-B2 trade leaves the Intent it shares with live sibling trades (or an already
      terminal one) untouched and records `openp2p.trade.intent_unchanged`; every economic cancellation guard and
      R7G-B1's "an Intent that cannot be cancelled refuses the whole cancellation" are unchanged otherwise. Legacy
      `IN_PROGRESS` claims are **never** attributed to a trade (see the Gate C corrective below): they are observed
      (append-only `idempotency_reconciliation_audit`, migration `20261018130000_idempotency_reconciliation_audit`) and
      replay as 409 `IDEMPOTENCY_OUTCOME_UNKNOWN`.
    - **Gate C corrective (CTO FREEZE: "correlation is not causation").** *Corrigido 2026-10-10:* the first build of
      this entry resolved a legacy `IN_PROGRESS` claim when exactly one trade matched its owner, its payload hash and a
      30 s window. An independent audit reproduced false attribution (another claim's trade, a keyless trade, a trade
      of the claimant's own offer made by someone else) and double attribution under concurrency, because a legacy
      trade carries no reference to the claim that produced it. A legacy claim now stays `IN_PROGRESS` — never
      `COMPLETED`, never `FAILED`, no `resultRef` — and replays as 409 `IDEMPOTENCY_OUTCOME_UNKNOWN`, whose
      `details` are `{ authoritative: false, unverifiedCandidateTradeIds }`: only the caller's own legacy trades
      created shortly after the claim, as hints and never a result. The audit table records only `UNRESOLVED`
      observations, at most one per claim, enforced by the database (migration
      `20261018140000_legacy_claim_unresolved_only`); there is no operator override. Every time comparison on this
      path is UTC-explicit, so the database session time zone cannot change what is observed or gated.
    - **Technical freeze (CTO, 2026-10-10).** The audited B2 scope is frozen at `c51b8bb8da47048fac7fce8968e45c51950d1df9`: the ten invariants are
      recorded in RFC-018 Amendment A1, the residual findings in `docs/BACKLOG.md`, and the deployment prerequisites
      (not satisfied) in `docs/DEPLOYMENT.md` section 2.2. Not a merge, a deployment, an E3 global freeze or an E4
      authorization; #235 stays open.
    - **Tests.** RFC-018 A1 retargets, as approved: the Intent assertions of `fullTradeLifecycle` and `routes.test`
      follow the trade's own Intent; the E3C refusal test expects no claim row. New real-PostgreSQL suites:
      `intentBindingAndLookup`, `tradeIntentSchema`, `tradeIntentAtomicAdmission`, `tradeClaimReconciliation` (after
      the Gate C corrective: the adversarial C1–C7 suite that enforces the policy above).

- **#235 R7H-E2 — canonical BTC/USD price authority: real collector, database writer-role separation.**
  - New module `src/modules/open-valuation/`.
  - **Adapters for four exchanges:** Kraken, Coinbase Exchange and Bitstamp as primaries; Gemini as a reserve,
    used only when the primaries do not agree.
    - Operator identity comes from the adapter, never from the payload.
    - A source list with a repeated operator or a shared endpoint host is refused.
    - Prices stay decimal strings end to end. A JSON-number, non-positive or over-precise price is malformed.
  - **Selection:**
    - stale and future source timestamps are excluded first;
    - the largest price-contiguous group within 100 bps of its median, with at least 2 operators, is accepted,
      so an extreme price is excluded and reported;
    - two equally large disagreeing groups publish nothing;
    - the quote's authorization price is the group's maximum.
  - **Collector:**
    - asOf is the database clock;
    - sources are fetched concurrently, each bounded, outside any transaction;
    - nothing is published past the 10 s bound (1 s margin);
    - publication is one transaction (`ON CONFLICT (id) DO NOTHING` on the deterministic id, then the
      observations), so losers yield and never overwrite, and a crash leaves nothing.
    - `readAuthorizationQuote()` returns the newest quote only if it is current and fresh, otherwise null
      (fail closed).
  - **Migration `20261016120000_economic_authority_roles`:**
    - `sails_app`: full DML except on economic evidence. Read-only on quotes, observations and policy rows;
      insert-only on reservations.
    - `sails_quote_collector`: reads the policy, inserts quotes and observations, nothing else.
  - **Operational behaviour:**
    - The collector runs only with its own credential (`QUOTE_COLLECTOR_DATABASE_URL`). In production it refuses
      an over-privileged one.
    - The application logs an error at every start while its own credential can still publish quotes.
  - `npm run price:smoke` checks the live sources. CI uses local HTTP fixtures.
  - Deployment steps: `docs/DEPLOYMENT.md` §2.1. #235 is **not** closed.

- **#235 R7H-E1 — economic authorization foundation (schema only; no enforcement yet).**
  - Additive migration `20261015120000_economic_authority_foundation`. It adds versioned trade-limit policy rows
    (`R7_TRADE_AUTHORIZATION_POLICY_V1`, experimental), canonical BTC/USD valuation quotes with their source
    observations, and immutable per-escrow exposure reservations. No existing table gains a column and no row is
    backfilled: an escrow without a reservation stays "unclassified", never "zero exposure".
  - V1 values:
    - open settlement cap 250.00 USD; rolling fiat cap 750.00 USD;
    - quote max age 120 s; publication window 30 s; publication ≤ 10 s after a quote's asOf (checked at insert
      and again at commit); source disagreement ≤ 100 bps; ≥ 2 operators;
    - rail MULTISIG/BTC only; payment method PIX only (90-day fiat window);
    - no tiers, no promotion, no unlimited.
  - A payment method or rail without a policy row is not eligible.
  - The database enforces every invariant, including against direct SQL:
    - policy versions, rails, methods, quotes, observations and reservations are immutable (no UPDATE, DELETE or
      TRUNCATE);
    - a version's rows can only be written in its creating transaction;
    - a quote commits only with observations that exactly support its declared max, median, count and spread,
      checked at commit and re-checked for every added observation;
    - a quote's id is deterministic (`BTC:<window epoch>`), and that primary key is the window's only unique key, so
      concurrent publishers yield via `ON CONFLICT (id) DO NOTHING`;
    - a reservation must match the trade's seller, bound payment account, method, escrow, asset and amount; it uses
      the newest fresh quote under the version in force; its value is `ceil(amount × max price)` to the cent, at
      most the open cap;
    - a reservation can only be written for a new, unfunded escrow;
    - the trade, escrow, payment-account and offer fields a reservation snapshotted are frozen once it exists.
  - No production flow writes these tables yet. Collectors, seller-only creation, owner-wide caps and fiat/reorg
    accounting are later R7H slices, so #235 is **not** closed.
  - New real-PostgreSQL suite: `tests/integration/economicAuthorityFoundation.test.ts`.

- **#235 R7G F8G — canonical / residual input separation, mechanically proven; legacy locks without a vout
  surfaced by the residual preflight.**
  - **NF-F8G-1 (evidence):** a canonical MULTISIG settlement spends exactly the persisted canonical outpoint and
    never another output at the same script. This was true in code but no test protected it: a mutation that also
    spent every other UTXO at the address passed CI.
    - New real-PostgreSQL / real-PSBT tests cover cooperative release and refund, and the arbiter's signed release,
      refund and split, each on an escrow whose script also holds a confirmed residual output.
    - Each test asserts that the round's PSBT and the broadcast transaction have exactly one input, the canonical
      outpoint, and that the residual output stays unspent, RESIDUAL, and recoverable only by both original
      participants.
    - That mutation now fails all five tests.
  - **NF-F8G-2 (legacy):** a lock that recorded its funding txid but no vout (before the Missão 10 vout column)
    leaves the canonical outpoint ambiguous. Runtime treats every output of that txid at the script as canonical,
    so a second one could never become residual, and the preflight reported SAFE.
    - `npm run multisig:residual-preflight` now raises `CANONICAL_OUTPOINT_VOUT_UNKNOWN` (REVIEW_REQUIRED) from the
      database alone, so an explorer outage cannot hide it.
    - It lists every output of that txid the explorer shows, chooses none, and repairs nothing.
    - New locks always record the vout.
- **#235 R7G F8C — a signing round executes only under current-state authority, claimed before any broadcast;
  a failed ruling never reopens a dispute beside a final escrow (SIGNING_ROUND_STATE_COMPATIBILITY, candidate).**
  - **NF-F8B-1 (economic ordering):**
    - What happened: under a cooperative REFUND round created at FUNDS_LOCKED, the buyer could still mark payment,
      moving the escrow to PAYMENT_PENDING. Once both parties signed, the live finalize refused the round, because
      PAYMENT_PENDING → REFUNDED is invalid.
    - But C8 (reconciliation PASS 0) broadcast the refund **before** its claim checked the transition. The result
      was an on-chain refund while the escrow stayed PAYMENT_PENDING.
    - The fix: PASS 0 now claims the transition against the escrow's current status inside its existing pre-broadcast
      gate, exactly as the live finalize does (claim → broadcast; a failed broadcast reverts). A crash after that
      claim leaves the live path's existing window, which PASS 1 closes from chain truth.
    - The round itself stays frozen. A ruling never replaces a bilaterally signed round (#239D). It executes only
      once a state that authorizes its transition exists, e.g. after a dispute.
    - A transaction already on the network whose transition the escrow no longer authorizes (an ambiguous earlier
      broadcast) is reported for manual review and never claimed.
  - **#239D (dispute/escrow consistency):**
    - What happened: a ruling commits RESOLVED, C8 completes the escrow (MOOT skips RESOLVED disputes), and then the
      ruling's dispatch fails. The revert restored OPENED beside a COMPLETED escrow.
    - The fix: the revert now runs under the escrow's lock. If the escrow's terminal transition record already
      exists, the dispute becomes MOOT, bound to that record — the existing #239D rule. APPEALED stays as it is.
    - A narrow DB guard (`disputes_terminal_escrow_not_open_guard`) refuses inserting a dispute into, or moving one
      into, an open status once its escrow has a terminal transition record. Historical rows are not rewritten.
  - **Legacy:** `npm run signing-round:preflight` (read-only) reports, as SAFE / REVIEW_REQUIRED / UNVERIFIABLE:
    - terminal escrows with an open dispute;
    - rounds whose transition the current status does not allow;
    - terminal escrows holding a round of another kind.
    It never repairs anything.
- **#235 R7G F8B — a refused direct release / refund / split on a signature-collection rail leaves no
  disposition provenance (SIGNATURE_COLLECTION_DISPOSITION_AUTHORITY_V1).**
  - **Defect:** on MULTISIG / LIGHTNING_HODL / SAFE_GUARD_EVM, `releaseFunds()` / `refundFunds()` claimed the
    transition, freezing `cooperativeDisposition` (or, from DISPUTED, `arbitratedDisposition`), before the
    provider refused the direct call. The status was reverted but the frozen intent stayed: a false, immutable
    disposition. A refused REFUND attempt on a still-locked escrow left a durable "REFUNDED" intent beside the
    signing round that later COMPLETED it. Reconciliation's downstream-effects recovery falls back to that slot's
    actor when the round row is gone, so the false slot could also misattribute who triggered the outcome.
  - **Not affected:** `splitFunds()` already refused these rails before the claim (no provider `splitFunds`).
  - **Service:** the three direct calls refuse a signature-collection escrow right after authorization, before any
    claim or write, and name the `initiate-*` route to use. Dispute rulings, the timelock sweep and the
    orchestrator already route these rails to signature collection and are unchanged.
  - **Database:** a narrow guard (`escrows_signature_collection_no_direct_disposition_guard`) refuses creating or
    changing any direct-execution intent slot on a signature-collection row. Direct-execution rails (WDK, MOCK) and
    their slots are untouched. A pre-F8B row that already carries a value keeps settling and is never rewritten.
  - **Legacy rows:** `npm run disposition:preflight` (read-only) reports signature-collection escrows carrying
    such a slot, and terminal escrows whose slot contradicts the outcome. Every hit is REVIEW_REQUIRED; nothing
    is repaired.
- **#235 R7G F8A — residual value on a MULTISIG script is recovered only by both original participants
  (MULTISIG_RESIDUAL_VALUE_RECOVERY_V1); no MULTISIG economic state without its funding outpoint.**
  - **What counts as residual:** value on an escrow's original 2-of-3 script that is not, and can no longer
    become, its canonical funding outpoint:
    - a wrong or partial amount while CREATED;
    - an extra or duplicate deposit;
    - anything that arrives after COMPLETED / REFUNDED / SPLIT.
  - **Classification:** each output at the persisted address is CANONICAL, CANONICAL_CANDIDATE (lockFunds may
    still claim it), UNCONFIRMED (below the MULTISIG confirmation policy), or RESIDUAL. Nothing is recovered while
    the canonical funding is reorg-uncertain.
  - **Who decides:** Sails never attributes residual value to the seller, the buyer, the treasury, the operator
    or the arbiter, and it never enters normal settlement.
  - **How it is recovered (one recovery per outpoint):**
    - either participant proposes it with an explicit destination;
    - the unsigned PSBT (outpoint, value, script, destination, fee) is frozen before anyone signs;
    - the buyer AND the seller each sign it with their persisted escrow keys;
    - the one transaction those two signatures produce, and its txid, are persisted before broadcast;
    - retries send the same bytes; the server never signs; a fully signed recovery is never withdrawn.
  - **The commercial escrow is never touched:** a COMPLETED escrow stays COMPLETED while its late residual value
    is recovered.
  - **Routes:**
    - `GET /v1/settlement/escrow/:id/residual-value`;
    - `POST /v1/settlement/escrow/:id/residual-recoveries`;
    - `GET` / `POST .../residual-recoveries/:id/signature` / `cancel`.

    The settlement recovery tick converges signed recoveries.
  - **Database guarantees:**
    - one live recovery per outpoint;
    - a canonical outpoint is never residual, and a claimed residual outpoint never becomes canonical;
    - a recovery is bound to its escrow's unshared address;
    - the intent is frozen, evidence is write-once, and rows are never deleted;
    - a MULTISIG escrow never holds PAYMENT_PENDING / DISPUTED / EXPIRED / COMPLETED / REFUNDED / SPLIT without
      its `txLockId`;
    - a trade whose MULTISIG / LIGHTNING_HODL escrow has a funding address is never manually CANCELLED.
  - Migration `20261012120000_multisig_residual_recovery`. Read-only `npm run multisig:residual-preflight`.

- **#235 R7G NF-B1 — no settlement path uses the legacy buyer sub-account; AUTO_SETTLE_ON_MATCH never moves real
  value.**
  - The legacy buyer account (`buyerIndexFor()`, `0'/0/<sha256('buyer:' + id) % (2^31-1)>` under the Sails seed)
    collides between distinct buyers (a pair turns up in about 18k random ids) and is held by the server, not the
    buyer. Since F6C no release could pay it (caller-supplied WDK destinations are refused), but the auto-settle
    handler still derived it.
  - `executeSettlement()` (the auto-settle handler and the demo) now refuses every rail except MOCK, before any
    escrow, LOCK, claim or event. It acts for both parties: it locks as the seller, records "payment sent" as the
    buyer (which also ends the seller's FUNDS_LOCKED expiry path), and releases on an emulated PIX confirmation.
    The handler derives no destination; on MOCK the release resolves the buyer's registered payout.
  - Every WDK release pays the buyer's registered payout address, frozen once the obligation is recorded
    (PREPARED). Later payout changes, crashes, fresh nodes and concurrent recoverers never redirect it, and the
    database refuses a rewritten destination.
  - `npm run wdk:lock-preflight` reports `LEGACY_OUTBOUND_UNREGISTERED_DESTINATION`: a legacy `transfer()`
    release that may have paid an address other than the buyer's registered payout (manual review; nothing is
    moved).

- **#235 R7G-F6C — WDK release, refund and split are signed transactions of the escrow's own account, with
  gas funded once per leg, and an ambiguous outcome never reverts the escrow or creates a transaction B (DF1).**
  - The provider's `transfer()` path is gone: it let the RPC choose the nonce, learned the hash only after the
    broadcast, and reverted the escrow claim on any error.
  - **The obligation** (frozen before anything is signed, from durable authority only):
    - RELEASE pays the full locked amount to the buyer's registered payout address;
    - REFUND pays it back to the treasury that funded the LOCK;
    - SPLIT pays floor(amount × buyerBps / 10000) to the buyer and the exact remainder to the seller, in order —
      the seller leg is signed only after the buyer leg is final.
  - **Caller-supplied destinations are refused for this rail** (the auto-settle buyer sub-account: NF-B1). A
    CREATED escrow is never refunded on-chain.
  - **Each leg:**
    - signed by the escrow account from that account's governed nonce lane;
    - persisted before any broadcast;
    - final only on corroborated evidence (both RPCs), the same rules as the F6B LOCK.
  - **Gas:** one GAS_FUNDING treasury transaction per signed leg, worth exactly the leg's maximum gas cost minus
    the account's balance. It is itself signed, persisted and corroborated, and must be final before the leg is
    broadcast.
  - **Gas policy** (no defaults; WDK outbound is refused until set): `WDK_OUTBOUND_MAX_GAS_LIMIT` and
    `WDK_OUTBOUND_MAX_FEE_PER_GAS_WEI` cap what a leg may be signed with.
  - **When a call fails:**
    - nothing signed yet: the escrow claim is reverted;
    - anything signed: the claim stays and reconciliation (PASS 1, or `npm run wdk:lane -- reconcile --escrow`)
      continues the same transactions;
    - a final revert or a nonce consumed elsewhere stops the obligation for manual review — nothing is re-signed;
    - the process dies after the claim, before the obligation is recorded: reconciliation records it once from
      the same durable authority (registered payout addresses, treasury, frozen buyerBps) and drives it.
  - **Database guarantees:**
    - one economic outbound family per escrow (no RELEASE beside a REFUND);
    - no signed obligation beside a legacy `transfer()` attempt that may have moved funds;
    - recorded legs are frozen;
    - one immutable funding per leg.
  - **Lane gaps:** a nonce lane initialized past a foreign pending transaction that later disappears stays fail
    closed and is shown as `laneGap` by `wdk:lane status` (UNFILLABLE_LANE_GAP_V1).
  - Migration `20261011120000_wdk_outbound_signed_authority`. `npm run wdk:lock-preflight` reports unresolved
    outbound legs and fundings.

- **#235 R7G-F6B-P1 — no irreversible WDK conclusion rests on one RPC; treasury lanes halt and resume under
  governance; a stuck lowest nonce stops new signing.** CONFIRMED (→ FUNDS_LOCKED), a final REVERTED and
  NONCE_CONSUMED_ELSEWHERE now need a second, distinct observer (`WDK_CORROBORATING_RPC_URL`, evidence only,
  never broadcasts) to agree — same transaction, status, block number and block hash, final under the same
  rule at its own head; for NONCE_CONSUMED_ELSEWHERE, the nonce consumed at a block final for both and no
  receipt on either. Both source labels and the corroborator's head are persisted with the terminal state and
  are immutable; the database refuses a terminal state without them. Missing, lagging or unreachable
  corroboration leaves the attempt unresolved; a contradiction (`RPC_DISAGREEMENT`) is surfaced for review.
  Unset corroborator: nothing becomes terminal (fail closed). Lane halts are now structured
  (`wdk_lane_halts`: OPERATOR_PAUSE, STUCK_LOWEST_NONCE, SUSPECTED / PROVEN_EXTERNAL_NONCE_CONSUMPTION),
  never deleted, cleared only with an append-only audit record (`wdk_lane_audit`) in the same transaction.
  An operator removes only an operator pause, and only while no economic halt is active; economic halts
  clear only through a mechanical resume (both RPCs agree on the final treasury nonce, nothing pending,
  every signed transaction of the lane terminal), which realigns the lane forward to that nonce atomically —
  no force option, no nonce setter (`npm run wdk:lane -- status|pause|unpause|resume|reconcile`).
  `WDK_LANE_STUCK_BLOCKS` (no default): once the lowest unmined signed transaction has waited that many
  blocks the lane halts — the transaction is not failed, reverted or replaced and keeps being rebroadcast.
  The production network and confirmation depth remain unfrozen (CTO). Migration
  `20261010120000_wdk_rpc_corroboration_lane_governance` (existing halts carried over);
  `npm run wdk:lock-preflight` reports halts and the corroborator / threshold configuration.

- **#235 R7G-F6B-P — WDK LOCK finality is evidenced, a single RPC never decides an irreversible anomaly, and
  a nonce lane advances only by allocation.** A signed LOCK becomes CONFIRMED / REVERTED only together with
  the evidence that made its receipt final — receipt block number and hash, observed head, and the rule
  applied (`CONFIRMATIONS:<n>`, which they must satisfy) — immutable afterwards; the database refuses a
  terminal state without it. One RPC showing the treasury nonce consumed by another transaction no longer
  writes NONCE_CONSUMED_ELSEWHERE (irreversible, and a stale/forked endpoint can show exactly that): the
  attempt stays unresolved and the lane is halted for operator review; the database refuses that terminal
  state until corroborated evidence exists. `wdk_nonce_lanes.nextNonce` moves only by one, in the
  transaction that persists the signed transaction using that nonce. The production finality value and
  target network remain a CTO decision (`WDK_FINALITY_CONFIRMATIONS` still has no default). Migration
  `20261009120000_wdk_lock_finality_evidence`; `npm run wdk:lock-preflight` lists rows it would refuse.

- **#235 R7G-F6B — a WDK LOCK is one signed transaction, persisted before it is broadcast; the escrow is
  FUNDS_LOCKED only once that transaction is final.** WDK `transfer()` let the RPC choose the treasury
  nonce and exposed the hash only after broadcast, so a lost response, a crash or a retry could not tell
  whether funds had moved; the escrow was claimed FUNDS_LOCKED up front and reverted to CREATED on any
  error, and any receipt status other than 1 counted as a revert (a malformed receipt could start a second
  treasury transfer). Now the LOCK is: nonce allocated from a PostgreSQL lane per (chain, treasury), the
  transaction built with every field explicit (pinned `WDK_CHAIN_ID`), signed locally, decoded and checked,
  and persisted with its hash in the same transaction — then broadcast with ethers (pinned 6.17.0; WDK has
  no safe raw-broadcast primitive). Every broadcast and rebroadcast sends those exact bytes after
  re-verifying them; nothing ambiguous ever produces a new transaction. Only receipt status 0x1 / 0x0
  decide; finality is `WDK_FINALITY_CONFIRMATIONS` (no default: unset means never final). A final success
  projects FUNDS_LOCKED with its transition in one transaction; a final revert allows a new LOCK; a nonce
  consumed by a foreign transaction is NONCE_CONSUMED_ELSEWHERE, and foreign treasury activity halts the
  lane (operator review). Reconciliation advances signed LOCKs from durable state on any node. A committed
  signed LOCK blocks cancellation and refund-from-CREATED; WDK `markPaymentSent` requires the final LOCK;
  WDK release/refund/split are refused until outbound authority exists (F6C). Prisma `Decimal` amounts now
  reach providers as exact decimal strings (NF1); amounts finer than USDT's 6 decimals are refused.
  Migration `20261008120000_wdk_signed_lock_authority`; run `npm run wdk:lock-preflight` (read-only)
  against production first.

- **#235 R7G-F6A-1 — every WDK escrow has its own account, allocated and frozen by the database.** A
  WDK_USDT_EVM escrow's account was derived on every use as `m/44'/60'/0'/0/<sha256(tradeId) % (2^31-1)>`.
  Distinct trades map to the same index (a real pair was found after ~50k trade ids; on a local EVM the
  second trade's account spent the first trade's locked USDT), and that namespace also holds the treasury
  (index 0) and the auto-settle buyer accounts. Now each escrow carries `wdkAccountScheme` +
  `wdkAccountPath`: new escrows get `1'/0/<n>` from a database sequence on INSERT (unique, never reused,
  never wraps — creation fails when the non-hardened range is exhausted); escrows that already existed keep
  exactly their historical account, persisted once as `LEGACY_TRADE_HASH_V0`. The identity is set by the
  database only and is immutable together with the escrow it belongs to (trigger + CHECK + unique index).
  Lock, release, refund, split and reconciliation derive the account from that path only, and fail closed
  when it is missing or when a persisted escrow address is not what it derives. Migration
  `20261007120000_wdk_escrow_account_identity` refuses to install if two existing WDK escrows share an
  account or one uses the treasury's; run `npm run wdk:account-preflight` (read-only) against production
  first. Buyer accounts (`buyerIndexFor`, auto-settle only) still use the hashed namespace and are reported
  by the preflight, not changed.

- **#235 R7G-B2A — a MULTISIG escrow's script authority is frozen and every signature is verified.** The
  buyer/seller keys could be replaced at any time after they had derived the deposit address — even after
  funding — while lock, refund, release and recovery re-derived the script from those mutable rows: a swap
  blocked settlement, misdirected funding (lockFunds then overwrote the address), and duplicate keys were
  accepted (one key listed twice lets its holder, or the server for the arbiter key, spend alone). Partial
  signatures were never verified by Sails: a well-formed signature over the wrong message was accepted,
  finalized and broadcast. Now: once the address exists the keys that derived it and the address itself are
  immutable (service check plus database triggers; resubmitting the same key is a no-op); the three keys
  must be distinct; every lock, rescan, spend and reconciliation asserts the keys still derive the persisted
  address and fails closed otherwise; each submitted signature is verified against the stored signing round
  and the signer's key (SIGHASH_ALL) before it is stored or counted, and every signature is verified again
  before finalization. Migration `20261006120000_multisig_script_authority` refuses to install over any
  inconsistent MULTISIG escrow; run `npm run multisig:preflight` (read-only) against production first.
  LIGHTNING_HODL and SAFE_GUARD_EVM have no signature validator and now refuse signature submissions.

- **#235 R7G-B1 — a trade is cancelled unilaterally only while no funds can exist for it.** A manual
  cancellation used to be accepted while the escrow was CREATED, FUNDS_LOCKED, PAYMENT_PENDING or EXPIRED,
  marking the trade CANCELLED while funds stayed locked (or a buyer had already paid). It is now refused once
  funds may exist: any escrow status other than CREATED, a MULTISIG escrow with a deposit address, or a
  WDK_USDT_EVM escrow with a transfer attempt that may have been submitted (even if the escrow reads CREATED).
  Those trades end through refund, dispute or settlement, which are unchanged. Submitting a participant key
  and locking funds now take the same trade-lifecycle lock and refuse a CANCELLED trade. A cancellation that
  fails leaves nothing behind: the trade's Intent is cancelled in the same transaction as the trade (an Intent
  that cannot be cancelled refuses the whole request), and events are published only after the commit.

- **#235 R7G-A — a cancelled trade takes no new escrow.** `createEscrow()` never checked the trade's
  status, and a manual cancellation (#294) only serialized against an escrow that already existed, so a
  CANCELLED trade could still get an escrow, including one created after the cancellation committed. A
  trade now takes its first escrow only while PENDING or ACTIVE, and the cancellation and the escrow insert
  take one trade-scoped PostgreSQL advisory lock before reading the trade: either the cancellation wins (no
  escrow) or the escrow commits first and the cancellation then follows #294's rules. Existing rows are not
  touched.

- **#235 R7F-B (N3/N3b) — an escrow commits exactly its trade's economic intent.** `createEscrow()`
  took `asset` and `lockedAmount` from the caller unchecked, and for five legacy assets the caller also
  chose the rail — so a BTC 0.001 trade could get a USDT 500 escrow, or a SPARK trade lock BTC, USDT or
  native ETH. Now `Escrow.asset = Trade.asset` and `Escrow.lockedAmount = Trade.amount` (the principal T;
  the fee reserve stays separate), compared as exact Decimals; the caller's values are assertions and a
  mismatch is refused before anything is written. Trades in LN_BTC, USDT_LIGHTNING, SPARK, STACKS or RSK_BTC
  (no authorized translation, ADR-002 §11) cannot be escrowed, and SAFE_GUARD_EVM never backs a trade.
  Existing escrow rows are not rewritten.

- **#235 R7D (N2) — payment-account trust ramp counts real completions.** `completedTrades` had no
  production writer. The seller's bound account now gains one completed trade per clean completion
  (escrow COMPLETED, no dispute ever), exactly once across replay, concurrency, nodes and crash
  recovery (projection claim + PASS 3). The unguarded helpers `recordCompletedTrade()`
  / `recordChargeback()` were removed; chargebacks stay unwired (no canonical fiat-reversal fact).

- **#235 R7C — payment-account binding and peer-attestation authority.** Any authenticated
  participant could sign any payment account, including their own, raising its trade-limit tier.
  The seller's account is now bound to the trade at creation (SELL offer: declared on the offer;
  BUY offer: by the taker), checked for ownership and payment method, and fixed. Only the buyer of a
  clean COMPLETED trade (no dispute) may attest that trade's bound account, once, atomically
  (`POST /v1/settlement/payment-accounts/:hash/sign` now requires `tradeId`). Provenance is recorded
  (PEER / VOUCHER / LEGACY for rows signed before). Trade-limit enforcement is not part of this change.

- **Master Backlog R6 — security windows fail closed.** A window configured as 0 or negative
  silently disabled the protection it bounds: the Redis-shared auth/critical rate limits (a
  non-positive PEXPIRE deletes the counter), the WebSocket message limit, the escrow circuit
  breaker and suspicious-activity detection (a max <= 0 also never fired). Those settings are now
  strict positive integers; an invalid value refuses to boot. Defaults are unchanged.

- **Master Backlog R5 — escrow timelock authority.** A trade party could set `timelockHours` on
  `POST /v1/settlement/escrow` (0 or negative made the escrow expire as soon as funds locked; a
  huge value made it never expire). The field is now accepted but ignored: `createEscrow()` freezes
  `DEFAULT_TIMELOCK_HOURS` on the escrow, `lockFunds()` keeps deriving `expiresAt` from that frozen
  value, and existing escrows are never recomputed. `DEFAULT_TIMELOCK_HOURS` must be a positive
  integer in every environment and is required in production.

- **Issues #291 / #294 / #298 — settlement result integrity, authoritative projection, replay
  safety.** `Escrow.txReleaseId`/`releasedAt` are now write-once (one `persistSettlementResult()`
  primitive for every writer + a database trigger); a provider-success/local-failure no longer
  reverts the escrow; Trade status is projected monotonically from the persisted Escrow (manual
  transitions are CAS-guarded); downstream event effects are idempotent per
  `(eventId, projectionKey, subjectId)` (`event_projection_claims`), with recovery of claimed-but-
  unprojected transitions (PASS 3). Two migrations. See `PROTOCOL_INVARIANTS.md` INV-OP-12.

- **Issue #303 - Capability Authority is a production-eligibility invariant.** A
  `NODE_ENV=production` process now refuses to boot unless
  `ENFORCE_CAPABILITIES=true` exactly (dev/test/reference unchanged). Only canonical
  `(capabilityName, scope)` pairs (`trade-coordination`: `intent.created`,
  `intent.discovering`; `settlement`: `settlement.escrow.{released,refunded,split}`)
  can be registered; anything else is 400. SDK `capabilities.ensureCanonicalGrants()`
  added (run by the reference UI on login); `registerFromWallet()` deprecated
  (its old grant shape matched no gate). Self-issued grants remain the participant's
  own consent, not independent authorization. ADR-004/INV-08 amended.

- **Issue #302 — registration now requires proof of possession.** `POST
  /v1/identity/participants` requires `signature`: an Ed25519 signature over
  `sails-registration-proof-of-possession:v1:<challenge>:<displayName>` for a
  challenge from the new `POST /v1/identity/register-challenge`. Knowledge of a
  public key no longer allows squatting its canonical `User` row. Verification
  precedes consumption; the exact verified challenge is consumed atomically
  (reusing #301's `atomicCompareAndConsume`); `User.publicKey @unique` remains
  the independent final barrier. SDK: `create()` signs transparently;
  `createWithWallet()` and `registerChallenge()` added; `createWithPublicKey()`
  deprecated (cannot produce a proof). React: `useSailsIdentity().createWithWallet`.

### Added
- `docs/PRODUCTION_READINESS_FIXES.md` — a complete document with 22 fixes
  organized by priority (P0/P1/P2), each with file, exact line, and
  before/after code.
- `docs/TECHNICAL_DEBT_AUDIT.md` — an audit of invisible technical debt with
  45 items organized by impact (Critical/High/Medium/Low) and area
  (maintenance, scalability, onboarding, SDK, tests, modularization).
- `.github/workflows/ci.yml` — CI/CD with typecheck, tests, and build (Node 22).
- `SECURITY.md` — security policy and vulnerability reporting.
- `CODE_OF_CONDUCT.md` — community code of conduct.
- `SUPPORT.md` — support guide and communication channels.
- `.gitignore` updated — added `graphify-out/`, `GITHUB_ORGANIZATION.md`, `*.txt`.
- `CLAUDE.md` updated with Production Readiness audit status.
- `SailsClient.proof` module (`SailsProofModule`) with `assertClaim()`,
  `submitProof()`, `issueVerificationNonce()`, `verifyProof()`, and
  `getEvidenceBundle()` — now wired onto `SailsClient` as `client.proof`
  and exported from the public API.
- `Proof` and `Verification` types exported from `@satsails/p2p-trading-sdk`'s public API.
- `useSailsProof()` React hook in `@satsails/sdk-react` — TanStack Query-backed
  wrapper for all `SailsProofModule` methods (10 tests incl. error paths).
- `useSailsIdentity`, `useSailsLiquidity`, `useSailsReputation`,
  `useSailsCapabilities` React hooks.
- `useSailsLiquidityDiscover` React hook with customizable filter params.
- Expanded `useSailsLiquidity` hook — `book` and `match` now accept custom
  parameters via `UseSailsLiquidityOptions`.
- Settlement RFC-021 gap closures: `approveRelease()`, `getReleaseApprovals()`,
  `registerArbiter()`, `getArbiterProfile()` with `ArbiterProfile`,
  `ReleaseApproval`, `ReleaseApprovalsResult` types.
- `openp2p.reconcileTrade()` — RFC-011 client-side reconciliation.
- `reputation.getScoreByPeerId()` — RFC-021 peer-based score lookup.
- Prisma migrations: `20260807_init` (schema completo) e `20260807_add_indices`
  (Dispute.arbiterId+status, User.reputationScore).
- React hook tests: `useSailsTrade` (3 tests) and `useSailsTrades` (4 tests).
- Pagination on `GET /v1/reputation/leaderboard` (limit/offset).
- Pagination on `GET /v1/openp2p/chat/:tradeId/messages` (limit/offset).
- `CLAUDE.md` — document defining Claude Code's engineering role for this project.
- `config/index.ts`: `requiredInt()` helper for numeric env var validation
  (throws instead of silently returning NaN).
- `config/index.ts`: production guard for `mockSettlement` (warns when
  `mockEscrow=false` but `mockSettlement=true`).

### Changed
- `liquidity.discover()` and backend `getAggregatedOffers()` now return
  `{ offers, sources, total, hasMore }` with proper global pagination applied
  after aggregating and sorting across all providers.
- `docs/SDK_GUIDE.md` section 2 updated with all new method signatures.
- `package.json` scripts: `db:migrate` now uses `prisma migrate deploy`;
  added `db:migrate:dev` for development.
- `docker-compose.yml`: migrate service uses `prisma migrate deploy`.
- `GET /v1/reputation/leaderboard` response: now returns
  `{ items, total, hasMore, nextOffset }` instead of a bare array.
- `GET /v1/openp2p/chat/:tradeId/messages` response: now returns
  `{ items, total, hasMore, nextOffset }` instead of a bare array.
- `identity.routes.ts`: `publicKey` now validates 64-character hex via regex.
- `trade.routes.ts`: `listTradesSchema` now has `limit` (1-100) and `offset` (>=0) bounds.
- `chat.routes.ts`: `sendMessageSchema` now has `content.max(10000)` and `msgType` as an enum.
- `settlement.routes.ts`: `createEscrowSchema.asset` now uses `z.enum(...)` instead of `z.string()`.
- `settlement.routes.ts`: `disputeSchema.evidence` now validates against a typed schema.
- `liquidity.service.ts`: removed 3 unnecessary `as any` casts (input was already typed).
- `config/index.ts`: `mockEscrow`/`mockSettlement` now case-insensitive.
- `config/index.ts`: removed duplicate `config.server` (identical to `config.app`).
- `proof.service.ts`: removed redundant `as any` on `verdict` (already typed as `'ACCEPTED' | 'REJECTED'`).
- `proof.service.ts`: replaced `as any` with `as unknown as Prisma.InputJsonValue` for JSON fields.
- `liquidity.routes.ts`: replaced `as any` with `as AssetType` in 3 places.
- `dispute.service.ts`: replaced `dispute.status as any` with `as DisputeStatus`.
- `settlement.routes.ts`: removed redundant `as any` on `body.paymentMethod` (already typed by the Zod schema).
- `routes.test.ts`: fixed 14 pre-existing reputation tests (publicKeys now valid hex, pagination limits respected, assets use a valid enum).
- `escrow.service.ts`: extracted `initiateSignatureCollection()` — eliminates ~180 lines of duplication across `initiateRelease/Refund/Split`.
- `auth.ts`: added `AuthenticatedRequest` interface — eliminates 25 `(request as any).participantId` casts across 9 route files.
- `client.ts` (SDK): extraído `requireWallet()` — elimina boilerplate repetido em 5 métodos.

### Fixed
- `trade.mock.ts` `ReputationScore` missing `total`/`tradeScore`/`volumeScore`/
  `settlementScore`/`disputeRate`/`cumulativeFeesObserved` fields caused
  TypeScript errors in dependent tests.
- `StatusBadge.tsx` missing `SPLIT` escrow status.
- `liquidity.service.ts`'s `getAggregatedOffers()` had the sort comparator
  reversed for both BUY and SELL sides — BUY offers were sorted ascending
  (lowest bid first) instead of descending (highest bid first); SELL offers
  were sorted descending (highest ask first) instead of ascending (lowest
  ask first). Corrected to standard order-book convention.
- `routes.test.ts` dispute config-error tests expected 400 (ValidationError
  from `getDisputeService()` with empty `TRUSTED_ARBITRATORS`) but got 404
  due to `.env`'s `TRUSTED_ARBITRATORS=k6-test-arbiter` setting. Fixed by
  clearing `process.env.TRUSTED_ARBITRATORS` before config import — dotenv
  does not override existing env vars.
- **CRITICAL**: `event-bus.ts` `SocialEngineeringRiskDetectedEvent.pattern`
  union tinha `| string` que colapsava todo o mapa de eventos tipados para
  `string` genérico — removido.
- `escrow.service.ts`: adicionado null check antes de chamar `provider.finalizeSplit!`.

### Security
- **`escrow.service.ts`'s `createEscrow()` had no membership check at
  all** — any authenticated participant could create an escrow against
  ANY trade, with attacker-chosen `type`/`lockedAmount`/`asset`. Since
  `Trade.escrowId` is set on the first successful call and a trade can
  only ever have one escrow, this let a stranger permanently block the
  real parties from ever settling a trade they could merely
  guess/observe the id of. Fixed: requires `participantId`, checked
  against `trade.buyerId`/`trade.sellerId`.
- **`GET /v1/openp2p/trades/:id` and `.../trades/by-intent/:intentId`
  had no auth at all** — both include the trade's full message history
  and the seller's real payment details (`Offer.paymentDetails`).
  Anyone who merely guessed or leaked a trade UUID could read a
  stranger's negotiation and payment instructions. Fixed: `requireAuth`
  + buyer/seller check, same as every other trade-detail route.

### Fixed (2026-08-08, verify-then-fix sweep of accumulated uncommitted work)
- `packages/sails-sdk/src/client.ts` had literal dead code: an orphaned
  `if (!this.wallet) {...}` block floating in the class body right
  after `signMessage()`'s closing brace, left over from an old
  `getAddresses()` implementation. Never caught because
  `packages/sails-sdk` isn't covered by the root `tsconfig`'s
  `include` — `npx tsc --noEmit -p packages/sails-sdk` is a distinct
  check the root `npm run build` doesn't run. Consolidated into
  `getWalletAddresses()` + a shared `requireWallet()` helper.
- `Dockerfile` and `docker-compose.yml` both had a UTF-8 BOM and every
  apostrophe in every comment doubled (`''` instead of `'`) — an
  encoding-roundtrip artifact. Not cosmetic: the same corruption hit
  the `HEALTHCHECK`'s embedded JS one-liner in both files, turning
  `require('http')` into `require(''http'')` — invalid syntax that
  would have made the container's own health check fail permanently in
  production. Rewrote both files clean.
- `reputation.leaderboard()` and `openp2p.getMessages()` in
  `@satsails/p2p-trading-sdk` still typed their return as a bare array
  (`ReputationScore[]`/`Message[]`) after their backend routes had
  already moved to `{items, total, hasMore, nextOffset}` pagination —
  would have shipped broken against the real response shape. Fixed
  both, added `LeaderboardEntry`/`LeaderboardResult`/`PaginatedMessages`
  types.
- `tests/useSailsCapabilities.test.tsx` and
  `tests/useSailsLiquidity.test.tsx` (sdk-react) were written against
  an imagined API shape that doesn't match the real types
  (`granteeId`/string `scope` instead of `CapabilityGrant`'s real
  `grantedTo`/`scope: string[]`/`capabilityName`; `assetSell`/
  `assetBuy`/`amountSell` instead of `Offer`'s real `asset`/`side`/
  `priceUsd`/`minAmount`/`maxAmount`). Neither ever ran under
  `packages/sdk-react`'s own `tsc` for the same "not in root tsconfig"
  reason as `client.ts` above.
- `scripts/sdk-pressure-test.ts` (a real end-to-end SDK-level load
  script) had 5 type errors that would have blocked `ts-node` from
  ever running it. Fixed; wired as `npm run loadtest:sdk`.
