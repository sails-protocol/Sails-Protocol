# WDK_USDT_EVM `lockFunds()` — Unknown-Outcome / Retry-Safety Investigation

**Mission:** CTO Mission #56 (`docs/TECHNICAL_DEBT_AUDIT.md` #56, `docs/BACKLOG.md`'s
"`WDK_USDT_EVM`'s `lockFunds()` — unknown-outcome / retry-safety evidence gap"
delta, discovered during Bounded Remediation F6's own review, 2026-09-07).
**Type:** Production-safety investigation / external side-effect semantics.
**Status:** Evidence only. No production code changed. No mechanism authorized
or implemented. **Corrected/Implemented 2026-11-27 (temporal delimitation):** this status describes the original investigation of 2026-09-07. A bounded remediation was implemented afterwards (sections 22 and 22.1 of this document: the provider-local execution-truth layer), and the reconciler later gained restart convergence for this rail. The findings below are preserved as the dated record of what was demonstrated before that work. `WDK_USDT_EVM` remains `PRODUCTION-INELIGIBLE`
(`docs/rfcs/RFC-019-settlement-custody-reference-vs-normative.md`,
`docs/PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md`) — that classification is
unchanged by this document.

**Evidence-status legend (used throughout):** DEMONSTRATED (proven by reading
the real, unmodified source and/or by a test exercising the real, unmocked
**Sails orchestration** code — `escrow.service.ts`/`escrow-lifecycle.ts`) /
SIMULATED (a test double stands in for the external, side-effecting call
itself — the orchestration around it is real and unmocked, but the external
economic side effect is a fake recorded in-memory, never a real network
call) / UPSTREAM DOCUMENTED (confirmed directly in the installed
`@tetherto/wdk-wallet-evm` or `ethers` package source) / REPOSITORY OBSERVED
(confirmed directly in this repository's own source) / INFERRED (a reasoned
conclusion from the above, not itself directly observed) / UNKNOWN (not
determinable from the evidence available in this environment) / NOT TESTED
(a scenario this mission did not execute, including any real network/live
RPC scenario).

**CTO Gate Correction (2026-09-07, this pass):** this document's original
text used "real external transfer"/"genuinely successful external
transfer" language for scenarios that were, in fact, produced by a mocked
`wdkSettlementProvider` inside a Jest test — no real network call was ever
made. Every such phrase below has been corrected to explicitly say
SIMULATED. **DEMONSTRATED remains true and unweakened for what it always
actually meant: the real Sails orchestration code (`claimEscrowTransition`
→ provider call → catch → `revertEscrowStatus` → retry) genuinely runs,
unmocked, in every test in this document — it is only the external
economic side effect itself that is, and always was, simulated.** This
correction narrows wording, not conclusions: no claim in this document ever
required a real network call to be true, and none is weakened by stating
plainly that none was made.

---

## 1. Property Under Investigation

**Primary property:** a side-effecting external funding action must not be
repeated merely because the caller cannot determine whether the first attempt
succeeded.

**Secondary properties investigated:** whether retries distinguish FAILED
from UNKNOWN; whether reconciliation is possible before repeating a side
effect; how precisely any idempotence claim can be scoped; whether protocol
state silently treats uncertainty as final failure; whether recovery
re-decides economic authority.

This document does not start from a mechanism. It reports what the current,
real, unmodified code does — and does not do — against this property.

---

## 2. Real Call Path (traced from source, not inferred from naming)

```
POST /v1/settlement/escrow/:id/lock  (settlement.routes.ts:271-278)
  -> escrowService.lockFunds(escrowId, triggeredBy)   (escrow.service.ts:376-471)
       -> repo.findById(escrowId)                      [read: current status]
       -> tradeRepository.findById(escrow.tradeId)      [read: buyer/seller]
       -> isPartyOrAgent() authorization check
       -> claimEscrowTransition(escrowId, 'CREATED', 'FUNDS_LOCKED')  (escrow-lifecycle.ts:289-310)
            -> escrowRepository.claimTransition()  -- prisma.escrow.updateMany({ where: { id, status: 'CREATED' }, data: { status: 'FUNDS_LOCKED' } })
            -- ATOMIC: only one concurrent caller's WHERE clause matches; the loser gets count:0 and throws BEFORE reaching the provider.
       -- try {
       ->   provider.lockFunds(...)                     (WdkSettlementProvider.lockFunds, wdk-settlement.provider.ts:129-142)
              -> treasuryAccount() -> getWallet().getAccount(0)
              -> escrowAccount(tradeId) -> getWallet().getAccountByPath(`0'/0/${escrowIndexFor(tradeId)}`)
              -> treasury.transfer({ token, recipient: escrowAddress, amount })   (@tetherto/wdk-wallet-evm, WalletAccountEvm.transfer())
                   -> quoteSendTransaction() -- gas estimate, provider.getFeeData()  [read-only, no side effect]
                   -> sendTransaction()
                        -> populateTransactionEvm() -- provider.getTransactionCount(from, 'pending') [fresh nonce, every call, no cache]
                        -> signer.signTransaction()                                [local, no network]
                        -> provider.send('eth_sendRawTransaction', [signed])       *** THE EXTERNAL SIDE EFFECT ***
                        -> returns { hash }                                        -- hash is the RPC's ack of receipt into its mempool, NOT a confirmation
       ->   repo.updateLockResult(escrowId, { txLockId: result.txId, ... })   -- prisma.escrow.update(...) [no status field — already FUNDS_LOCKED]
       ->   (result.vout is always undefined for WDK_USDT_EVM -- escrowFundingEvidenceRepository.record() skipped)
       ->   emitEscrowTransition(...)                                         -- withEscrowFundingLock() -> escrowEvent create -> eventBus.emit('settlement.escrow.locked', ...)
       ->   return updated
       -- } catch (err) {
       ->   revertEscrowStatus(escrowId, escrow.status)   -- prisma.escrow.update({ where: { id }, data: { status: 'CREATED' } }), UNCONDITIONAL, swallows its own failure
       ->   throw err
       -- }
```

Every arrow above was read directly from `escrow.service.ts`, `escrow-lifecycle.ts`,
`escrow-repository.ts`, `wdk-settlement.provider.ts`, and
`node_modules/@tetherto/wdk-wallet-evm/src/{wallet-account-evm.js,wallet-account-read-only-evm.js,utils/tx-populator-evm.js}`
(installed version `1.0.0-beta.16`) — not assumed from either file's naming or
its own header comments.

---

## 3. Economic Action Boundary

**The first point at which external economic reality can diverge from local
Sails state is `provider.send('eth_sendRawTransaction', [signed])` inside
`WalletAccountEvm.sendTransaction()`.** DEMONSTRATED (source reading): this is
a single `await` on the underlying `ethers.JsonRpcProvider`'s JSON-RPC call.
Once the target node has received and accepted this call into its own mempool,
the transaction is externally real and visible to that node (and, once
propagated, to the wider network) — regardless of whether the JSON-RPC
*response* (the tx hash) ever reaches this process.

Bounded state model (analytical only — **not implemented, not authorized**):

| State | Meaning |
|---|---|
| `NOT_ATTEMPTED` | `provider.lockFunds()` never called |
| `PRE_SUBMISSION_FAILURE` | threw before `eth_sendRawTransaction` was ever sent (config error, gas quote failure, signing failure — DEMONSTRATED safe to retry, see §13) |
| `SUBMISSION_UNKNOWN` | `eth_sendRawTransaction` was sent; the response was lost/timed out/errored before this process observed a hash |
| `SUBMITTED` | a hash was returned to this process (mempool-accepted, not yet confirmed) |
| `CONFIRMED` | the transaction was mined (this repository's WDK integration never checks for this — see §7) |
| `REVERTED` | the transaction was mined but failed on-chain (an ERC-20 `transfer()` can revert; the current code never checks the call's return value or a receipt — see §7) |

`WdkSettlementProvider.lockFunds()` treats `SUBMITTED` (a hash was returned)
as the ONLY success signal. It has no representation at all for `CONFIRMED`
or `REVERTED`, and `SUBMISSION_UNKNOWN` is REPOSITORY OBSERVED to collapse,
unconditionally, into the same bucket as `PRE_SUBMISSION_FAILURE` the moment
the promise rejects — see §5.

---

## 4. Current Sails State Model — What Is Actually Written, and When

DEMONSTRATED by direct reading of `escrow.service.ts:376-471` and
`escrow-repository.ts`:

| Point in the flow | DB write | Persists `txLockId`? |
|---|---|---|
| Before `claimEscrowTransition` | none | no |
| `claimEscrowTransition` succeeds | `status: CREATED -> FUNDS_LOCKED` (atomic `updateMany`) | no — status only |
| `provider.lockFunds()` throws (any point, any reason) | `revertEscrowStatus`: `status -> ` (the escrow's pre-claim status, e.g. `CREATED`) | **no — the real external `txId`, if one exists, is discarded** |
| `provider.lockFunds()` succeeds, `repo.updateLockResult()` throws | same unconditional revert as above | **no — same discard, even though the transfer genuinely succeeded** |
| `provider.lockFunds()` succeeds, `repo.updateLockResult()` succeeds, `emitEscrowTransition()` throws | same unconditional revert | **no — same discard, even though both the transfer AND the txLockId write succeeded; the write is not rolled back, but the escrow's *status* is reverted underneath it** |
| Full success | `txLockId`, `txLockVout: null`, `multisigAddr` (escrow address), `lockedAt`, `expiresAt` persisted; `settlement.escrow.locked` emitted | yes |

**Process crash:** REPOSITORY OBSERVED — nothing in this path uses a
database transaction spanning the provider call. A crash between "external
transfer accepted by the RPC node" and "any of the three subsequent writes"
leaves the escrow durably at `FUNDS_LOCKED` (the claim already committed)
with **no `txLockId`, no `lockedAt`, no `expiresAt`** — an escrow claiming to
be locked with none of the evidence that would normally accompany that claim,
and the real transfer's hash is nowhere in Sails at all. A crash strictly
before the RPC call (e.g., during `getWallet()`, `escrowAccount()`, or gas
quoting) leaves the escrow durably `FUNDS_LOCKED` with no external transfer
having happened — the opposite divergence, and also unrecoverable without an
external chain check, since nothing distinguishes this state from the crash
case above by looking at the database alone.

**Timeout:** identical to "provider throws" from `escrow.service.ts`'s own
point of view — a timeout surfaces as a rejected promise, indistinguishable
in the catch block from a `PRE_SUBMISSION_FAILURE`. See §6.

---

## 5. WDK API Contract — Return Type, Hash Timing, Confirmation Semantics

All UPSTREAM DOCUMENTED, from direct reading of the installed
`@tetherto/wdk-wallet-evm@1.0.0-beta.16` source (no version claim is made
about any other release):

- `WalletAccountEvm.transfer(options)` returns `Promise<{ hash: string, fee: bigint }>`.
- `hash` comes from `this._provider.send('eth_sendRawTransaction', [signed])`
  — this is `ethers.JsonRpcProvider`'s raw pass-through of the JSON-RPC call.
  Per the JSON-RPC/Ethereum execution-API specification (not this
  repository's code — UPSTREAM DOCUMENTED against the wider EVM ecosystem,
  not against WDK specifically), this method returns as soon as the node
  accepts the transaction into its own transaction pool — **it does not wait
  for mining, confirmation, or even successful propagation to peers.**
- **Nothing in `transfer()`/`sendTransaction()` calls `provider.waitForTransaction()`
  or polls a receipt.** DEMONSTRATED by direct reading — `sendTransaction()`
  returns `{ hash, fee }` the instant `eth_sendRawTransaction` resolves; no
  further await exists in that function.
- **No idempotency key, request identity, or client-generated nonce is ever
  passed by `WdkSettlementProvider`.** `treasury.transfer({ token, recipient,
  amount })` supplies no `nonce` field (confirmed: `wdk-settlement.provider.ts`'s
  three call sites for `transfer()` never set one) — `populateTransactionEvm()`
  therefore always falls through to `Number(await provider.getTransactionCount(from, 'pending'))`,
  a **fresh RPC read on every single call**, never a client-cached sequence
  number.
- **Error behavior:** `sendTransaction()`/`transfer()` throw a plain `Error`
  (or whatever `ethers.JsonRpcProvider.send()` throws — a JSON-RPC error
  object, a network error, or an abort) with **no distinction anywhere in
  this call chain between "the node rejected the request outright" and "the
  request may have been accepted but the response was lost."** This is the
  single most direct piece of evidence for this mission's central question:
  the WDK wrapper itself provides no signal to distinguish these two cases.
- **Timeout behavior (CTO Gate Correction, 2026-09-07 — the original text
  here overclaimed "no timeout at all"/"hang indefinitely," corrected
  below):** `WalletManagerEvm`'s provider is constructed as `new
  JsonRpcProvider(rpcUrl)` (a bare URL string — `wallet-manager-evm.js:97/107`)
  — REPOSITORY+UPSTREAM OBSERVED. Unlike `safe-guard-evm.provider.ts` (F1,
  `docs/TECHNICAL_DEBT_AUDIT.md` #51), which explicitly constructs its
  `ethers` provider with an EXPLICIT, Sails-configured `FetchRequest.timeout`,
  **`wdk-settlement.provider.ts`/`config.wdk` configure no Sails-specific
  RPC timeout** (`src/config/index.ts:533-537`: `wdk: { seedPhrase, rpcUrl,
  usdtContract }` — three plain strings, no `FetchRequest`/timeout option).
  Correct, precise classification: `WDK_USDT_EVM` **does not configure a
  Sails-specific RPC timeout and inherits `ethers`' own default
  `FetchRequest` timeout behavior instead.** This is NOT "unbounded" —
  UPSTREAM DOCUMENTED, confirmed by direct reading of the installed
  `ethers@6.17.0` source (`node_modules/ethers/lib.commonjs/utils/fetch.js:402`):
  `FetchRequest`'s own constructor sets a default `#timeout = 300000`
  (300,000ms = 5 minutes) whenever no explicit override is supplied. So the
  actual, correct fact is: an RPC call here is bounded by `ethers`' own
  ~5-minute default, not zero and not infinite. This is a new, directly
  observed finding, not previously covered by F1 (F1's own scope named
  only `multisig.provider.ts`/`safe-guard-evm.provider.ts`, and both use an
  EXPLICIT, shorter, Sails-chosen bound instead of this default). **Not
  automatically registered as its own production-safety backlog delta**
  (removed from §21 in this correction pass) — a ~5-minute inherited default
  is not, by itself, evidence of a concrete property violation; it would
  only become a corrective priority if a future mission demonstrates a
  concrete reason the inherited default is inadequate for this call site
  (e.g., a measured operational impact of a 5-minute-bounded hang). Correct
  classification for any future reference: **NO SAILS-SPECIFIC TIMEOUT
  CONFIGURED**, not **UNBOUNDED RPC**. Regardless of the exact bound, a
  bounded timeout does not, by itself, resolve the retry-safety property
  this mission investigates — it only determines how soon an UNKNOWN
  outcome is reached, not whether Sails can safely act on it once reached.
- **Request identity / idempotency key:** UPSTREAM DOCUMENTED — none exists
  anywhere in `@tetherto/wdk-wallet-evm@1.0.0-beta.16`'s `transfer()`/
  `sendTransaction()` API surface.

---

## 6. EVM Nonce Analysis — Does It Provide Effective Idempotence Here?

**No — not as this specific caller uses it.** Central conclusion preserved
from the original pass; epistemic labels tightened below per CTO Gate
Correction (2026-09-07) so an inferred behavior is never read as a
live-demonstrated fact.

**UPSTREAM/SOURCE OBSERVED** (direct reading of `tx-populator-evm.js:107`):

```js
nonce: (tx.nonce != null) ? Number(tx.nonce) : Number(await provider.getTransactionCount(from, 'pending'))
```

- Nonce is **automatically managed**, freely queried fresh from the RPC node
  on every call — never cached client-side, never explicitly supplied by
  `WdkSettlementProvider`.
- **Does WDK cache nonce state across process restart?** No — SOURCE
  OBSERVED: there is no persisted nonce anywhere in this integration; every
  call queries the RPC node fresh. A process restart changes nothing about
  this (nothing was cached to lose).

**INFERRED** (a reasoned consequence of the observed code, not itself
directly observed or live-tested against a real node):

- **If the first transfer was genuinely broadcast and the RPC node the
  second call reaches has that transaction in its own mempool view**, the
  second call's `getTransactionCount(from, 'pending')` would return a nonce
  ONE HIGHER than the first — the second call would become a fully
  independent, valid transaction, and both could confirm. This is a
  plausible duplicate-transfer pathway given the observed code — it is
  **INFERRED**, not itself demonstrated against a live node in this
  mission (see NOT LIVE TESTED below).
- **If the second call reaches the RPC node BEFORE the first transaction has
  propagated into that node's mempool view** (a narrower race), the second
  call could receive the SAME nonce. Ethereum nodes generally require a
  strictly higher fee to accept a same-nonce replacement (informally
  ~10%+ bump on most clients, a general EVM-ecosystem fact — not this
  repository's code); `WdkSettlementProvider` never bumps a fee for a
  retry — it re-quotes fresh fee data every call, which is not a
  guaranteed increase. In this branch, the second call is more likely to
  be rejected outright ("replacement transaction underpriced" or
  equivalent) — but the FIRST transaction may still confirm normally,
  meaning the escrow is left at `CREATED` locally while the treasury has,
  in fact, already sent the funds. This is a distinct risk from the
  duplicate-transfer case — a false-negative state divergence, not a
  double-spend — but still **INFERRED**, not live-tested.

**NOT LIVE TESTED:** the exact mempool-visibility timing of any real RPC
node under Sails' actual infrastructure, and whether a real duplicate
confirmation would actually occur in practice, were not tested against a
live network in this mission (see §11's own disclosure). The two bullets
above describe plausible, code-consistent outcomes — they are not claimed
as observed facts from a live run.

**Conclusion, stated at the correct level of confidence:** EVM nonce
semantics do **not** provide retry idempotence for the current
`WDK_USDT_EVM` caller. This conclusion rests on SOURCE-OBSERVED facts (no
caching, fresh query every call, no client-supplied identity) — the
specific branch of outcomes that would follow from that (double-confirm
vs. rejected-but-original-confirms) is INFERRED and NOT LIVE TESTED, not
itself demonstrated. **Semantic Idempotence ≠ Operational Identicalness**,
as the mission brief itself states: nothing about "the EVM has nonces"
makes THIS caller's specific, cache-free, identity-free usage of them
safe — but the exact real-world failure mode this produces remains
INFERRED, not demonstrated against a live node.

---

## 7. Failure Window Matrix

**CTO Gate Correction (2026-09-07):** rows I and J below were corrected —
the original text incorrectly treated row I as impossible and conflated
two distinct scenarios in row J. Rows A/D/H's evidence pointers were also
corrected (they cited a nonexistent "§13, test N" — the actual test
evidence lives in §11).

| # | Window | External funds moved? | Local state after | Retry safe? | Reconciliation possible? | Evidence |
|---|---|---|---|---|---|---|
| A | Failure before signing (config error, gas quote failure) | No | Reverted to pre-claim status | **Yes** | N/A — nothing to reconcile | DEMONSTRATED (§11, Test 3; also `tests/escrowReleaseControls.test.ts`'s existing "provider lock failure... Retry" test, for a different provider) |
| B | Failure after signing, before RPC send (a Node-local exception, e.g. `_provider` undefined) | No | Reverted | **Yes** | N/A | INFERRED from source structure — not independently tested; behaviorally identical to A from `escrow.service.ts`'s point of view |
| C | RPC rejects before accepting into mempool (invalid nonce far out of range, insufficient balance the node checks pre-admission, malformed tx) | No | Reverted | **Yes** | N/A | INFERRED — a clean RPC-level rejection with no side effect; not distinguished from D by the current code, but genuinely safe if the rejection is real |
| D | RPC accepts the tx into its mempool but the response to `eth_sendRawTransaction` is lost (network drop, timeout, proxy/load-balancer failure) | **Unknown at call time — likely yes (INFERRED, NOT LIVE TESTED — see §6)** | Reverted (identical code path to A) | **No — DEMONSTRATED unsafe for the Sails orchestration, SIMULATED side effect** (§11, Test 2) | Correlation hint only, not durable operation identity — see §12 | This is the mission's "submit then throw" scenario — DEMONSTRATED for Sails' orchestration via a SIMULATED provider side effect, §11 Test 2. No live network duplicate was produced or claimed |
| E | Tx enters mempool, local process dies before the JS-level response is even processed | Yes | Escrow durably `FUNDS_LOCKED` (claim already committed) with **no** `txLockId`/`lockedAt`/`expiresAt` | **No further "retry" is even offered by `assertEscrowTransition`** — a `FUNDS_LOCKED` escrow with no lock evidence is stuck, not retryable via the normal `lockFunds()` route, and not automatically flagged as anomalous | Correlation hint only — see §12 | REPOSITORY OBSERVED (§4) — not independently tested (would require an actual process-kill against a live RPC, out of this mission's safe-testing scope) |
| F | Tx confirms but the caller (HTTP client) times out first | Yes | Depends entirely on whether the SERVER-SIDE `lockFunds()` call itself also times out or completes — if it completes, state is correct (full success path); if the server-side call ALSO times out (e.g., waiting on a slow but eventually-successful RPC round trip), same as D | Same as D if the server-side call also errored; otherwise **N/A — this window resolves to full success**, only the HTTP client is confused | Client could `GET /v1/settlement/escrow/:id` to check current status rather than blindly retrying — REPOSITORY OBSERVED that route exists (`settlement.routes.ts`) and is a safe, non-mutating way to check; **nothing forces a client to do this**, and the route (§10) has no idempotency-key protection if it doesn't | INFERRED from route structure |
| G | Tx reverts on-chain (e.g., insufficient token balance in the treasury account, a real ERC-20-level failure) | No net funds moved (revert), but gas was spent | `WdkSettlementProvider` has **no receipt check at all** — a reverted transaction still returns a hash from `eth_sendRawTransaction` (the RPC accepted the tx; on-chain execution failure is a separate, later fact this code never queries) — **Sails would record this as a SUCCESSFUL lock, `FUNDS_LOCKED`, with a real txLockId, when in fact no USDT ever moved to the escrow address.** | N/A — this is a silent-success-that-was-actually-a-failure, not a retry question | Only externally (checking the tx's on-chain receipt status) | DEMONSTRATED by source reading — `lockFunds()` uses only `result.hash`, never checks `result.status`/a receipt. **This is a separate, independent finding from the retry-safety question this mission was scoped to** — flagged in §21 as its own backlog delta, not conflated with the retry-safety property, and not fixed here |
| H | Provider returns tx hash, but the subsequent DB write (`updateLockResult`) fails | Yes | Reverted to pre-claim status, txId discarded | **No — DEMONSTRATED unsafe for the Sails orchestration, SIMULATED side effect** (§11, Test 1 — this is the exact scenario tested) | Same as D — correlation hint only, see §12 | DEMONSTRATED (Sails orchestration) / SIMULATED (the side effect itself) |
| I | `claimEscrowTransition` commits the provisional `FUNDS_LOCKED` claim, then the process crashes BEFORE `provider.lockFunds()` even begins (e.g., between the two sequential `await`s in `lockFunds()`'s own function body — a GC pause, an OOM kill, any interruption at that exact point) | **No** | `FUNDS_LOCKED` with `txLockId: null`, `lockedAt: null`, `expiresAt: null` — **the same resulting DB shape as row E, where funds WERE moved**, meaning this window is indistinguishable from E by looking at the database alone | Not retryable via the normal `lockFunds()` route (same reasoning as E — `assertEscrowTransition` blocks a second `lockFunds()` call once status is already `FUNDS_LOCKED`) | Correlation hint only — see §12 | **REPOSITORY-OBSERVED CRASH WINDOW.** CTO Gate Correction (2026-09-07): the original text called this window "impossible" because the claim and the provider call are sequential `await`s in one function body rather than decoupled by a queue — that reasoning was wrong. A process crash can occur between ANY two sequential statements, in-process or not; sequential code does not itself rule out a crash window. This window is REPOSITORY OBSERVED (reasoned directly from the code's structure — a genuine gap between two awaits exists), **not reproduced via an actual process kill** in this mission. §4's own text already described this correctly ("the opposite divergence") — only this table's row was previously wrong, now corrected to match |
| J | Two genuinely distinct scenarios previously conflated — **corrected, CTO Gate, 2026-09-07:** | | | | | |
| J-A | **Scenario A — crash after claim, before/during the provider call, escrow left at `FUNDS_LOCKED`** (rows E/I above) | Uncertain — could be either | `FUNDS_LOCKED`, no `txLockId` | **A further `lockFunds()` call is BLOCKED by `assertEscrowTransition`** (DEMONSTRATED, §11 Test 4 proves this rejection for an already-`FUNDS_LOCKED` escrow) — this is stuck/requires reconciliation, not silently retryable, and NOT where a duplicate provider invocation can occur via the normal route | Correlation hint only — see §12 | DEMONSTRATED (the block) + REPOSITORY OBSERVED (the stuck state, rows E/I) |
| J-B | **Scenario B — the provider call itself resolved or threw AFTER its side effect, and the catch block reverted the escrow to `CREATED`** (rows D/H above) | Uncertain — could be either | `CREATED` — genuinely retryable | **No — DEMONSTRATED unsafe for the Sails orchestration, SIMULATED side effect** (§11, Tests 1 and 2 — this is exactly the scenario those tests exercise, including the case of a restart followed by an operator or script reissuing `POST .../lock` against an escrow correctly observed to be `CREATED`) | Correlation hint only — see §12 | DEMONSTRATED (Sails orchestration) / SIMULATED (the side effect) |

---

## 8. Retry Surfaces — Repository-Wide Search

REPOSITORY OBSERVED (`grep -rniE "retry|queue|redelivery|BullMQ"` across `src/`):

| Surface | Classification | Applies to `lockFunds()`? |
|---|---|---|
| `bounded-rpc.ts`'s `withBoundedRetry()` | Automatic, opt-in per call site | **No** — `wdk-settlement.provider.ts` never imports or uses `bounded-rpc.ts` at all. This file's own header comment already states the exact governing principle ("a mutating/broadcast/submission call must never request it... retrying could duplicate an already-accepted economic action") but `WdkSettlementProvider.lockFunds()` isn't wired through this module either way — **it has no automatic retry and no Sails-configured timeout; the underlying `ethers` transport remains bounded by its own inherited default timeout** (NO SAILS-SPECIFIC TIMEOUT CONFIGURED — see §5) |
| `multisig.provider.ts`'s `EXPLORER_READ_RETRY` | Automatic, but explicitly scoped to read-only explorer calls (F1) | No — different provider, read-only calls only |
| `RedisStreamsEventStore.subscribe()`'s XCLAIM-based redelivery | Automatic, at-least-once, **but this store is a documented Reference implementation** (`event-store.ts`'s own header: "Redis Streams, BullMQ, a Postgres outbox table... is a Reference") | **Not connected today** — `SailsEventBus`'s default/active store is `PostgresEventStore` (confirmed, Missão 05.7), whose own `subscribe()` is "deliberately unchanged from `InMemoryEventStore`'s own [approach]" (event-store.ts:210-219) — a plain in-process listener list, no ack/redelivery. See §9 |
| `POST /v1/settlement/escrow/:id/lock` (HTTP) | Manual/client-driven | **Yes** — no idempotency-key header, no request-identity mechanism, nothing beyond `escrowService.lockFunds(id, participantId)`. A client that times out and resubmits reaches this exact code path again |
| `executeSettlement()` (`settlement-orchestrator.ts:134`), invoked from `eventBus.on('openp2p.trade.created', ...)` (`handlers.ts:553-562`, gated by `config.features.autoSettleOnMatch`, off by default) | Event-driven | **Yes, in principle** — see §9 for whether this event can actually be redelivered under the active store |
| Operator/API replay (a human resubmitting the same HTTP request, or a script retrying on a 5xx/timeout) | Manual | **Yes** — nothing in this path (route, service, repository) rejects a semantically-duplicate request beyond the atomic status claim, which only protects CONCURRENT attempts, not sequential ones after a completed-and-reverted attempt |
| Process-restart/operator replay after a caught failure reverted the escrow to `CREATED` (Scenario J-B, §7 — NOT a crash: a caught exception ran `revertEscrowStatus()` and returned the escrow to `CREATED` before or after the restart) | Manual | **Yes** |

**No automatic retry library, queue, or job-redelivery mechanism is wired to
`WdkSettlementProvider.lockFunds()` today.** The exposure is entirely
**manual/logical retry** (a human or a client-side retry policy resubmitting
the same HTTP request) plus the event-driven `autoSettleOnMatch` path — not
"no retry risk merely because no retry library is used," per the mission's
own explicit caution.

---

## 9. Event/Handler Duplication — `openp2p.trade.created` → `executeSettlement`

DEMONSTRATED, by direct reading of `event-bus.ts` and `event-store.ts`:

- `SailsEventBus.on(event, listener)` calls `this.store.subscribe(event, ...)` (`event-bus.ts:491-495`).
- The active, default store is `PostgresEventStore` (confirmed elsewhere this
  session, F7's own closure evidence: `event-bus.ts`'s constructor default,
  no config/env override exists anywhere in `src/`).
- `PostgresEventStore.subscribe()`'s own header comment states it is
  "deliberately unchanged from `InMemoryEventStore`'s own [approach]... not a
  new consumer-group mechanism" (`event-store.ts:210-219`) — i.e., a plain,
  synchronous, in-process listener registry. `publish()` is the durable part
  (writes `durableEventRecord`); delivery to `on()` listeners is NOT durable,
  NOT acknowledged, and NOT redelivered.
- **Classification for this specific path, under the confirmed active store:
  AT-MOST-ONCE / BEST-EFFORT.** A crash between `eventBus.emit('openp2p.trade.created', ...)`
  and the listener completing simply loses that invocation — it is not
  automatically redelivered, and `executeSettlement()`/`lockFunds()` is not
  automatically re-invoked by any mechanism this repository has wired up
  today.
- **Caveat, not overclaimed as impossible:** `RedisStreamsEventStore` (same
  file) DOES implement genuine at-least-once/XCLAIM redelivery, and if a
  future deployment configuration ever switched `SailsEventBus`'s active
  store to it, this specific handler WOULD become subject to that
  redelivery — this document does not assert no configuration could ever
  create event-driven duplication, only that the confirmed, current, active
  configuration does not.
- Separately: `handlers.ts`'s own comment on this listener states the
  `emit()` call site (`trade.service.ts`) does not await it — a slow or
  failing `executeSettlement()` cannot block trade creation, and any error
  is caught and logged (`handlers.ts:559-561`), not silently retried.

**Net finding:** the event-driven path does not, today, add an automatic
redelivery-based duplication risk beyond what §8's manual/logical retry
surface already covers. It is disclosed here in full rather than dismissed,
per the mission's own instruction not to assume "no retry library = no
risk."

---

## 10. API Duplication — `POST /v1/settlement/escrow/:id/lock`

DEMONSTRATED, `settlement.routes.ts:271-278`:

```ts
app.post('/v1/settlement/escrow/:id/lock', {
  preHandler: requireAuth,
  ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
}, async (request, reply) => {
  const { id } = idParam.parse(request.params)
  const escrow = await escrowService.lockFunds(id, participantId(request))
  return reply.code(200).send(success(escrow))
})
```

- The route has no request body and therefore no operation-id field in its
  payload. Separately, it does not inspect, accept as protocol semantics,
  or persist an `Idempotency-Key` header — checked repository-wide: no
  match for `idempotency` anywhere in `requireAuth`, the shared route
  middleware, or this route itself, outside this document and the mission
  brief that produced it. **No request identity / idempotency mechanism
  currently protects sequential retry of this economic action.**
- The ONLY guard against a duplicate request is `claimEscrowTransition`'s
  atomic status claim — which, as established throughout this document,
  protects CONCURRENT duplicate requests (both racing against the same
  `CREATED` status) but not a SEQUENTIAL retry issued after the first
  request's own catch block already reverted the escrow back to `CREATED`.
- No unique DB constraint exists on anything that would catch a duplicate
  lock attempt for the same escrow (the `@@unique([txLockId, txLockVout])`
  constraint `updateLockResult()`'s own catch block handles is for a
  DIFFERENT escrow claiming the SAME on-chain outpoint — a MULTISIG/Bitcoin
  concept; `WdkSettlementProvider` never populates `txLockVout` at all, so
  this constraint cannot fire for `WDK_USDT_EVM`).

**Conclusion:** a duplicate user/client/operator request against this route
can repeat the logical lock action, precisely in the window this document's
§7 failure matrix identifies (D/H/J) — confirmed as a state guard
(`claimEscrowTransition`), not an external-side-effect idempotence
mechanism, per the mission's own explicit "do not confuse state guard with
external idempotence" instruction.

---

## 11. Adversarial Tests — Real Orchestration, Simulated Side Effect

New file: `tests/wdkLockFundsRetrySafety.test.ts`. Only the provider boundary
(`wdkSettlementProvider`) and the database (`../src/common/database`) are
mocked — `escrow.service.ts`, `escrow-lifecycle.ts`, and `escrow-repository.ts`
run for real, unmocked, matching this repository's own established
"mock the boundary, test what's actually new" convention
(`tests/escrowProviderWiring.test.ts`, `tests/escrowReleaseControls.test.ts`).
**DEMONSTRATED**, throughout this section, refers to the real, unmocked Sails
orchestration's behavior. The provider's external economic side effect
itself is always **SIMULATED** — an in-memory test double, never a real
network/RPC call. See §0's legend correction for why this distinction is
stated explicitly rather than left implicit.

**Test 1 — provider call resolves, a LATER step fails — DEMONSTRATED RETRY-SAFETY GAP (variant: post-success local failure):**

1. The mocked provider resolves successfully with a txId
   (`0xSIMULATED_TX_1`) — a SIMULATED side effect, not a real transfer.
2. The following `prisma.escrow.update()` call (the real `updateLockResult()`
   persistence write) is made to reject, simulating an ordinary operational
   fault (a dropped DB connection) — deliberately NOT a provider-specific or
   exotic failure.
3. `escrowService.lockFunds()` is confirmed to reject with that exact
   simulated error.
4. Confirmed: the provider was called exactly once. The first `update()` call
   did attempt to persist `txLockId: '0xSIMULATED_TX_1'` (proving the attempt
   was genuinely made) — and that exact call is the one that rejected, so the
   value it attempted to carry was never durably written. The second
   `update()` call (`revertEscrowStatus`) reverts `status` to `CREATED` with
   no `txLockId` field at all — confirmed by direct inspection of its call
   arguments.
5. A subsequent, independent call to `escrowService.lockFunds()` for the
   SAME escrow (a retry against the now-`CREATED` status) is confirmed to
   succeed, and — the dispositive assertion — **the mocked provider is
   confirmed called a SECOND time**, with a second, different simulated txId
   (`0xSIMULATED_TX_2`).

**Test 2 — the true "submit then throw" / lost-response scenario — DEMONSTRATED RETRY-SAFETY GAP (variant: provider call itself rejects after its side effect):**

Unlike Test 1 (where the provider call *resolves* and a later step fails),
this models the provider's own call *rejecting* after its side effect
already occurred — the lost-response case this mission specifically asks
for.

1. A fake provider implementation records that its (simulated) side effect
   happened — pushed to an in-memory `externalEffects` array visible only
   to the test, standing in for "a real RPC node accepted the broadcast" —
   and THEN throws, before ever returning a txId to the caller.
2. `escrowService.lockFunds()` is confirmed to reject with that exact
   simulated error. Confirmed: `externalEffects` has exactly one entry (the
   side effect happened), and `prisma.escrow.update()` was called exactly
   once — the revert to `CREATED` — because the provider call itself threw
   before `updateLockResult()` was ever reached.
3. A retry of the same logical operation is issued. The fake provider
   records a second side effect and succeeds this time.
4. **The dispositive assertion: `externalEffects.length === 2` for the same
   `escrowId`** — the same logical operation caused the (simulated) side
   effect twice.

**Permitted claim (both tests):** Sails orchestration demonstrates retry
after a simulated post-submission unknown outcome — the real, unmocked
`claimEscrowTransition` → provider call → catch → `revertEscrowStatus` →
retry path genuinely allows a second invocation to reach the provider for
one logical operation.

**Forbidden claim, NOT made:** neither test demonstrates "a real on-chain
duplicate transfer" or that "real funds were duplicated in live
infrastructure" — no network call occurs anywhere in this test file.

**Precise result, both tests together:** Sails cannot currently distinguish
all definitely-failed attempts from post-submission unknown outcomes for
`WDK_USDT_EVM`, and its current revert-to-retryable behavior can permit the
same logical funding operation to reach the provider again. This is a
property of the real, unmocked orchestration code — not an inference from
reading it, and not a live-network finding.

**Test 3 — contrast case, the scenario the existing design DOES handle safely:**
a provider failure that occurs before any side effect at all (a
configuration error) is confirmed safe to retry — the provider is called
once for the failure, once for the successful retry, never twice
successfully. This mirrors `tests/escrowReleaseControls.test.ts`'s own
pre-existing "a provider lock failure leaves the escrow unpersisted...
Retry" test (written for a different provider) — included here in the same
file specifically so the boundary between "safe" and "not yet proven safe"
is explicit in one place, not just asserted in prose.

**Test 4 — the boundary that IS already protected:** once an escrow has
genuinely, durably reached `FUNDS_LOCKED` (persisted, not merely claimed), a
further `lockFunds()` call is correctly rejected by `assertEscrowTransition`
before the provider is ever touched. This is not in question, and this
document does not claim otherwise — the gap is bounded strictly to the
window between "the provider call resolved or threw after its side effect"
and "the resulting state was durably persisted," not the whole lifecycle.

All four tests pass against the real, unmodified orchestration code as it
exists on this branch today (see §17 for the exact validation run).

**Not executed in this mission (disclosed, not silently skipped):**
- **Duplicate invocation via true concurrency** (two simultaneous calls) —
  already covered by the EXISTING, pre-dated `claimEscrowTransition` design
  and its own established test coverage (`tests/escrowReleaseControls.test.ts`,
  the 2026-07-20 robustness-audit fix); not re-proven here since it is not
  the property in question.
- **A real testnet lost-response reproduction** (actually broadcasting a
  Sepolia transaction, then simulating a lost RPC response, then observing a
  real second broadcast) — NOT TESTED. This mission's own scope explicitly
  forbids sending real (even testnet) transactions as new infrastructure
  build-out beyond what's minimally needed, and the mocked-boundary tests
  above already demonstrate the exact code-level mechanism without that
  infrastructure cost. If a future mission wants ground-truth confirmation
  against a real Sepolia node's actual mempool-visibility timing, that is a
  distinct, larger piece of evidence this document does not claim to have
  produced — real duplicate confirmation on a live network remains
  entirely NOT TESTED and NOT DEMONSTRATED by this document.
- **A literal process-kill mid-flight** (failure window E) — NOT TESTED, for
  the same reason; the DB-write-ordering analysis in §4 is REPOSITORY
  OBSERVED (read directly from the code's lack of a spanning transaction),
  not independently reproduced by killing a real process.

---

## 12. Reconciliation — What Would Let Sails Check Before Retrying?

**CTO Gate Correction (2026-09-07):** the original text here claimed the
escrow's re-derivable destination address plus an approximate time window
was "sufficient" for manual/external reconciliation. That overclaimed —
what actually survives is *correlation material*, not a *durable operation
identity*. Corrected below.

**Durable operation identity: ABSENT / NOT DEMONSTRATED.** DEMONSTRATED
(§4): no `txLockId`, no nonce, no request timestamp, no operation
identifier of any kind survives a reverted attempt. Nothing in the current
schema or code produces or persists a value that would let a future
reconciliation step say, with certainty, "this specific attempt either did
or did not land on-chain."

**Correlation material available (a search aid, not a durable identity):**
- the escrow's destination address (`escrowIndexFor(tradeId)` —
  deterministic, re-derivable from `tradeId` alone, no persisted secret
  required);
- the chain id (`config.wdk.rpcUrl`'s configured network, REPOSITORY
  OBSERVED, static per deployment);
- the sender address (`treasuryAccount()`'s account 0, also
  deterministically re-derivable);
- the intended amount (`Escrow.lockedAmount`, already persisted regardless
  of outcome);
- an approximate time window (roughly "since this escrow was created").

Together, these could let an operator manually query external chain data
(e.g., `eth_getLogs` for `Transfer` events into that address, or a
block-explorer API call) to NARROW a search — but this is a **search
aid / correlation hint**, not proof of correspondence to one specific
attempt. If the same escrow generated two SIMULATED (or, in a live
deployment, real) side effects for the same amount to the same address in
close succession (exactly the scenario §11's tests demonstrate for Sails'
own orchestration), the correlation material above cannot by itself
distinguish which of two matching transfers corresponds to which logical
attempt — that distinction would require a genuine deterministic operation
identity (candidates named, not authorized, below), which does not exist
today.

**Analytical candidates for a deterministic operation identity (NOT
authorized, NOT chosen, recorded for a future mission only):** a
transaction hash persisted before the caller could lose it; the
`(sender, nonce, chainId)` triple, persisted before broadcast; a
`logicalOperationId` generated by Sails itself before calling the
provider; a `providerOperationId` if the provider ever exposed one; or an
equivalent combination. Selecting or implementing any of these is
explicitly out of this mission's scope (§19).

**Does Sails persist enough to reconcile automatically today? No.**
DEMONSTRATED (§4): the ONLY thing that survives a reverted attempt is the
escrow row itself (hence the re-derivable correlation material above) —
useful for a MANUAL, EXTERNAL, human-driven search, but not sufficient for
an automated reconciliation step to draw a certain conclusion, and nothing
this codebase currently automates.

**Does current rollback/failure handling overwrite uncertainty as FAILED?**
**Yes — DEMONSTRATED.** `revertEscrowStatus()` is unconditional; there is no
`UNKNOWN`/`SUBMISSION_UNKNOWN` state anywhere in `Escrow.status`'s real enum
(`CREATED | FUNDS_LOCKED | PAYMENT_PENDING | DISPUTED | COMPLETED | REFUNDED
| SPLIT | EXPIRED` — `escrow-lifecycle.ts`'s `VALID_TRANSITIONS`). Every
provider failure, regardless of cause, is treated identically: revert to the
pre-claim status, exactly as if nothing had happened.

---

## 13. Failure Classification — Does Sails Need to Distinguish These?

**Analytical conclusion only — no enum/state change authorized or made.**

Yes: the evidence above supports that a genuine distinction exists between
at least `DEFINITELY_FAILED` (windows A/B/C — no side effect, safe to
retry as-is today), `UNKNOWN_OUTCOME` reached via a caught-and-reverted
attempt (windows D/H/J-B — a side effect may have occurred, current code
cannot tell, and retrying is not proven safe — DEMONSTRATED for Sails'
orchestration, SIMULATED for the side effect itself), and a distinct,
non-retryable stuck state (windows E/I/J-A — the escrow is left at
`FUNDS_LOCKED` with no lock evidence, and the normal `lockFunds()` route
correctly refuses a further attempt, but nothing reconciles the stuck
state either). `CONFIRMED_SUCCESS` and `CONFIRMED_REVERT` (window G) are a
related but distinct gap — this integration never checks a transaction
receipt at all, so it cannot today distinguish "confirmed and succeeded"
from "confirmed and reverted on-chain," independent of the retry-safety
question.

---

## 14. Recovery/Reconciliation Relation to the Frozen Baseline

This document does not import the MULTISIG reorg-sweep mechanism
(`multisig-funding-reorg-sweep.ts`) by assumption. **Interface Uniformity ≠
Security Uniformity**, per the mission's own instruction: MULTISIG's
`lockFunds()` is a read-only verification against externally-already-funded
collateral (the buyer/seller fund the address themselves; the provider only
observes) — a thrown error there genuinely has no new side effect, which is
exactly why the existing #56 debt-ledger entry (before this mission)
correctly named this as WDK-specific, not a general pattern. `WDK_USDT_EVM`
is a fundamentally different case: `lockFunds()` itself is the funding
action (`treasury.transfer()`), custodial and self-initiated, not an
observation of someone else's action.

**Can `WDK_USDT_EVM` currently satisfy the already-established
recovery/reconciliation property this repository expects of a production
settlement rail?** No — provider-specific evidence, not an assumption: it
has no reorg-sweep equivalent, no funding-evidence ledger equivalent to
`escrowFundingEvidenceRepository` (that table is only ever populated when
`result.vout !== undefined`, which `WdkSettlementProvider` never sets), and
no receipt/confirmation check at all (§7, window G).

---

## 15. Cross-Rail Maturity — Preserved, Not Silently Upgraded

Unchanged by this document, restated for the record:

- `WDK_USDT_EVM`: server-custodial-reference-implementation; legacy
  destination authority; no capability-profile enforcement; recovery **NOT
  DEMONSTRATED** (this document adds evidence of WHY, it does not change the
  verdict); correspondence **NOT DEMONSTRATED**; **PRODUCTION-INELIGIBLE**
  (enforced today by a real, fail-closed boot-time check —
  `src/config/index.ts:777-784` — refusing to start if
  `NODE_ENV=production && MOCK_ESCROW=false && WDK_SEED_PHRASE` is set).

---

## 16. PRODUCTION-INELIGIBLE Containment Assessment

**YES, operationally** — the fail-closed boot guard (§15) means this
provider cannot be activated in a real production deployment today; the
retry-safety gap this document demonstrates cannot currently cause real
financial harm in production because the provider cannot run there at all.

**NO, architecturally** — the property gap is real, demonstrated against the
provider's actual code, and would need to be resolved (or the provider
would need to remain permanently non-production, a separate decision this
document does not make) before any future production eligibility could be
considered. `PRODUCTION-INELIGIBLE` is not used here as a reason to delete
or soften this finding — it is registered in full, as the mission requires.

---

## 17. Validation

- `git diff --check`: clean.
- `package.json`/`package-lock.json`: unchanged (no diff).
- No production source file changed. Only additions: this document, one new
  test file (`tests/wdkLockFundsRetrySafety.test.ts`), and the BACKLOG/audit
  sync described in §19.
- Isolated run (`--runInBand`) of `tests/wdkLockFundsRetrySafety.test.ts`
  alone (now 4 tests, after this correction pass added the true
  submit-then-throw/lost-response test): **4/4 passed.**
- Targeted run (`--runInBand`): `tests/wdkLockFundsRetrySafety.test.ts`,
  `tests/wdkSettlementProvider.test.ts`, `tests/escrowProviderWiring.test.ts`,
  `tests/escrowReleaseControls.test.ts`, `tests/escrowCircuitBreaker.test.ts`,
  `tests/escrowEventHashChain.test.ts` — **6 suites, 130 tests, 0 failures.**
- `npx tsc --noEmit` (root): clean (re-run after this correction pass).
- **Disclosed environmental condition, not caused by this mission's
  changes:** this local machine currently has multiple stale
  `.claude/worktrees/agent-*` directories (full repository copies, including
  `packages/sails-sdk`) left behind by unrelated parallel Agent-tool
  sessions on this same host. Their presence collides with Jest's Haste
  module map (`@satsails/p2p-trading-sdk` resolves to 5 different
  `package.json` files) and breaks any test file that transitively imports
  anything touching that package, independent of anything in this
  mission's own diff. Every targeted/isolated run in this document was
  performed with a **local, non-committed** CLI override
  (`--modulePathIgnorePatterns='<rootDir>/.claude/worktrees/'` in addition
  to the repository's own existing `<rootDir>/dist/` entry) to work around
  this — `jest.config.js` itself was not modified, since permanently fixing
  this collision is unrelated to WDK retry-safety and belongs to whoever
  owns those other sessions' worktree cleanup.
- **`npm test` (plain, no workaround) was run once in this correction pass
  to confirm the condition at full-suite scale, per the mission's own
  instruction to try it "if the environment allows."** It ran to
  completion (not merely errored immediately) in ~193s:
  `Test Suites: 441 failed, 299 passed, 740 total` /
  `Tests: 933 failed, 2692 passed, 3625 total`. Every observed failure
  carried the identical symptom (`ModuleMap._assertNoDuplicates`, the same
  `@satsails/p2p-trading-sdk` collision) — the 299 passing suites are
  exactly those that never import anything touching that package. This
  result is reported as direct confirmation of the disclosed environmental
  condition, not as this branch's real test outcome — the targeted,
  workaround-enabled run above (6 suites, 130 tests, 0 failures) is the
  actual evidence for this mission's own changes. `jest.config.js` remains
  unmodified; this condition is not fixed here.

---

## 18. Property Verdict

**Claude recommendation: C — STRUCTURAL GAP.**

**Precise scope statement (the claim this document actually supports, no
more and no less):** Sails cannot currently distinguish all
definitely-failed attempts from post-submission unknown outcomes for
`WDK_USDT_EVM`, and its current revert-to-retryable behavior can permit the
same logical funding operation to reach the provider again. This is NOT a
claim that real funds were duplicated in live infrastructure — that was
never tested and is not asserted.

The current `WdkSettlementProvider`/`escrow.service.ts` design cannot safely
distinguish an unknown outcome from a definite failure, and cannot
reconcile an ambiguous prior attempt before retrying, without an
architectural change (some form of persisted pre-broadcast intent and/or
post-broadcast identity, reconciled before any retry is permitted — no
specific mechanism is chosen here, see §19). This is not a narrow,
single-line fix: the gap exists precisely because `lockFunds()`'s current
design persists nothing about the external call until AFTER it fully
succeeds, and reverts unconditionally on any failure at any point in
between.

This verdict is **Claude's recommendation only.** The CTO decides final
disposition, per the mission's own governing rule.

**Demonstrated vs. simulated vs. inferred vs. unknown, summarized (CTO Gate
Correction, 2026-09-07 — this breakdown replaces the prior version, which
did not separate DEMONSTRATED from SIMULATED):**
- **DEMONSTRATED** (the real, unmocked Sails orchestration's behavior,
  proven by a real test): the claim/provider-call/catch/revert/retry
  sequence genuinely allows a second provider invocation for one logical
  operation, in two distinct variants (§11, Tests 1 and 2); the contrast
  safe case, where a pre-side-effect failure is genuinely safe to retry
  (§11, Test 3); the already-protected concurrent-claim boundary, and the
  fact that an escrow stuck at `FUNDS_LOCKED` is correctly blocked from a
  further `lockFunds()` call (§11, Test 4).
- **SIMULATED** (a test double stands in for the external side effect — no
  real network call was ever made): the specific "provider call resolves
  successfully" and "provider call performs its effect then throws"
  scenarios in §11's Tests 1 and 2. The Sails orchestration around them is
  real and DEMONSTRATED; the side effect itself is not.
- **REPOSITORY/UPSTREAM OBSERVED** (direct source reading, no test needed):
  the full call path (§2); the DB-write ordering and crash windows,
  including the corrected Window I crash scenario (§4, §7); the WDK API's
  hash-timing and no-idempotency-key contract (§5); `ethers@6.17.0`'s own
  ~5-minute default `FetchRequest` timeout, inherited by `WDK_USDT_EVM`
  with no Sails-specific override (§5); the nonce auto-management with no
  caching (§6); the retry-surface inventory (§8); the event-delivery
  semantics under the active store (§9); the API route's lack of any
  idempotency mechanism (§10); the missing receipt/confirmation check (§7,
  window G — a related but separate finding).
- **INFERRED**: the qualitative outcome ranges in §6's nonce analysis
  (which exact branch occurs depends on RPC-node-internal timing this
  environment cannot directly observe); windows B/C/F's classification.
- **UNKNOWN / NOT TESTED**: whether any currently-configured deployment
  uses `RedisStreamsEventStore` instead of `PostgresEventStore` (this
  document confirms the default/observed configuration, not every possible
  one); real-world RPC-node mempool-visibility timing under Sails' actual
  infrastructure; whether a real duplicate confirmation would actually
  occur on a live network — no live adversarial network test was run, and
  none is claimed.

---

## 19. Minimum Mechanism Candidates — NOT AUTHORIZED, Recorded Only

Per the mission's explicit instruction, no mechanism is chosen or
implemented here. For the record, so a future authorized mission does not
re-derive this from scratch:

- **PROPERTY:** a side-effecting external funding action must not be
  repeated merely because the caller cannot determine the first attempt's
  outcome.
- **Candidate mechanism classes** (examples only, not authorized, not
  ranked as a recommendation):
  - Persist a pre-broadcast intent (e.g., the populated-but-unsigned
    transaction's nonce, or a locally-generated idempotency key) BEFORE
    calling `transfer()`, so a retry can first check "did my last attempt's
    nonce already land on-chain?" before broadcasting a new one.
  - Introduce an explicit `UNKNOWN`/`SUBMISSION_UNKNOWN` intermediate
    `Escrow.status` (or a parallel field) that `revertEscrowStatus()` moves
    to instead of `CREATED` whenever the failure occurred after
    `provider.lockFunds()` was actually invoked — distinguishing "never
    tried" from "tried, outcome unclear."
  - A provider-specific operation journal (WDK-only, not a cross-provider
    abstraction) recording `{ tradeId, nonce, timestamp }` before broadcast,
    reconciled against the chain (via the deterministically-derivable escrow
    address) before any retry proceeds.
  - Add a receipt/confirmation wait (`provider.waitForTransaction()`) to
    close window G (§7) — a related, not identical, property.
- **Alternatives considered and why they are not proposed:** a generic
  cross-provider `IdempotencyManager`/transaction registry (rejected by
  this document's own COBRA/Rube Goldberg check, §20 — no second provider
  has this exact problem today, since MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM's
  `lockFunds()` calls are read-only verifications, not self-initiated
  transfers).
- **Tradeoffs, migration impact, test obligations:** explicitly not
  evaluated here — that is the next mission's work, only if the CTO
  authorizes pursuing a specific candidate.

---

## 20. Checks

**Goodhart Check:** this document does not conclude "duplicate transfer
proven, funds definitely at risk" merely because that would be a more
dramatic finding — the actual conclusion (STRUCTURAL GAP, with the specific,
bounded windows named) is what the evidence supports, no more and no less.
Windows A/B/C/F are explicitly reported as safe or likely-safe, not
inflated to match the unsafe windows.

**COBRA Check:** no new QVAC/agent/AI responsibility was invented; no
deterministic validation, replay protection, or settlement truth was moved
to AI. No mechanism was implemented — only investigated and documented.

**Rube Goldberg Check:** the property is answerable, and any future fix is
almost certainly answerable, provider-locally (inside `wdk-settlement.provider.ts`/
`escrow.service.ts`'s WDK-specific branch) — no cross-protocol machinery,
generic idempotency framework, or new orchestration abstraction is proposed
or needed to describe this finding.

**Sacrifice Check:**
- **Safety property currently missing:** retry-after-ambiguous-failure
  safety for `WDK_USDT_EVM`'s `lockFunds()` specifically.
- **Evidence proving that:** §11 (a real test against the unmocked
  orchestration code, not a hypothetical).
- **Minimum mechanism that could close it:** not chosen here — §19 names
  candidate classes only.
- **What it would cost:** unknown until a specific candidate is chosen and
  scoped — at minimum, additional persisted state and a reconciliation step
  before every retry, which adds latency/complexity to the happy path in
  proportion to how it's built.
- **What would be sacrificed:** none of this document's findings require
  sacrificing anything today — no behavior changed.
- **Does it belong in this provider or the core?** In this provider
  specifically, per the Rube Goldberg check above — nothing here suggests
  the other three real providers share this exact exposure (their
  `lockFunds()` calls are read-only verifications, not self-initiated
  transfers), so a shared/core mechanism is not evidenced as necessary.

---

## 21. New Backlog Deltas Registered By This Mission

**CTO Gate Correction (2026-09-07):** item 2 below (the RPC timeout finding)
is downgraded from a standalone backlog delta to an OBSERVATION, per CTO
direction — a ~5-minute inherited `ethers` default is not, by itself,
evidence of a concrete property violation, and item 2 must not be read as
implying "unbounded RPC" or as automatically warranting future remediation.

1. **The retry-safety gap itself — now DEMONSTRATED (for the real Sails
   orchestration; SIMULATED for the external side effect itself), not
   merely a hypothesis.** Supersedes (does not delete) the original
   7-open-question framing in `docs/TECHNICAL_DEBT_AUDIT.md` #56 — that
   entry is preserved verbatim below its original text, with a dated
   pointer to this document. Precise scope: Sails cannot currently
   distinguish all definitely-failed attempts from post-submission unknown
   outcomes for `WDK_USDT_EVM`, and its current revert-to-retryable
   behavior can permit the same logical funding operation to reach the
   provider again — NOT a claim that real funds were duplicated in live
   infrastructure, which was never tested.
2. **OBSERVATION, not a registered backlog delta:** `WDK_USDT_EVM` does not
   configure a Sails-specific RPC timeout and inherits `ethers@6.17.0`'s
   own default `FetchRequest` timeout (~5 minutes, UPSTREAM DOCUMENTED —
   §5). Correct classification: **NO SAILS-SPECIFIC TIMEOUT CONFIGURED**,
   not **UNBOUNDED RPC**. Not registered as its own evidence obligation —
   would only become one if a future mission demonstrates a concrete
   property violation the inherited default actually causes.
3. **New, independent finding, registered as its own backlog item: no
   on-chain receipt/confirmation check exists** — a reverted (but
   RPC-accepted) transfer would be recorded as a successful lock with a
   real `txLockId`, even though no USDT actually moved (§7, window G).
   Related to, but analytically distinct from, the retry-safety property
   this mission was scoped to investigate. EVIDENCE OBLIGATION /
   IMPLEMENTATION DEFECT candidate for a future mission — not fixed here.
4. **New, independent finding, registered as its own backlog item: durable
   operation identity is ABSENT / NOT DEMONSTRATED** (§12) — only
   correlation material (re-derivable address, chain id, sender, amount,
   approximate time) survives a reverted attempt, which is a search aid,
   not a mechanism that could reliably distinguish two matching side
   effects for the same escrow. EVIDENCE OBLIGATION for a future mission
   choosing among §19's named (not authorized) candidates.
5. **Environmental/infrastructure finding, not a code defect:** stale
   `.claude/worktrees/` directories from unrelated parallel sessions
   currently break both a plain `npx jest` AND a plain `npm test` on this
   machine via a Haste module-map collision (§17) — confirmed at full-suite
   scale in this correction pass (`npm test` ran to completion in ~193s
   with 441/740 suites failing, all with the identical Haste-collision
   symptom; the 299 suites that never import anything touching
   `@satsails/p2p-trading-sdk` passed normally). Not this mission's to fix
   (ownership ambiguous, out of WDK-retry-safety scope) — disclosed in full
   so it is never mistaken for a regression introduced by this branch.

None of these items authorize or imply any implementation. All are evidence
obligations, observations, or disclosed conditions for a future, separately
authorized mission.

---

## 22. Remediation (Bounded Remediation, WDK Fund-Moving Safety, 2026-09-08)

**Finding demonstrated → remediation implemented → evidence → residual.**
The original finding above (§18's DEMONSTRATED RETRY-SAFETY GAP for
`lockFunds()`) is preserved verbatim, unmodified — this section records
what was subsequently built against it, not a rewrite of the finding
itself.

**Remediation implemented:** a new provider-local execution-truth layer
(`src/modules/open-settlement/wdk-execution-truth.ts` +
`wdk-transfer-attempt-repository.ts`, backed by a new `WdkTransferAttempt`
Prisma model) now sits inside `WdkSettlementProvider.lockFunds()` (and,
in the same pass, `releaseFunds()`/`refundFunds()`/`splitFunds()` —
`docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` §14 has that document's own
parallel remediation section). Before every real `transfer()` call,
`ensureAttempt()` persists durable identity for the logical operation and
refuses a second submission when a prior attempt's outcome is
`SUBMITTED` (reconciled via a real `getTransactionReceipt()` query) or
`SUBMISSION_UNKNOWN` (no hash was ever obtained — blocked pending manual
reconciliation, no automatic resolution invented). After a fresh
broadcast, `waitForReceiptOutcome()` polls for a real receipt (bounded,
not a background worker) before the caller is ever told the operation
succeeded — a bare returned hash is never treated as economic success.

**Evidence:** `tests/wdkExecutionTruth.test.ts` (new, 11 tests) exercises
the real, unmocked `WdkSettlementProvider`/`wdk-execution-truth.ts`
directly (only the WDK account object and the database are mocked — no
live network call anywhere) and DEMONSTRATES: an unknown-outcome attempt
blocks a second `transfer()` call; a receipt confirming `REVERTED` never
resolves as success; a receipt confirming `CONFIRMED` is the only path to
a returned `txId`; a stale `PREPARED` row (simulating a crashed prior
process) is durably reused rather than duplicated, without relying on any
in-memory state; a `CONFIRMED` operation is idempotently protected —
resumed without ever calling `transfer()` again. Full regression: the
pre-existing `#56` test file (`tests/wdkLockFundsRetrySafety.test.ts`,
which mocks `wdkSettlementProvider` entirely to test `escrow.service.ts`'s
own orchestration layer) still passes unchanged — that layer was not
modified, and its own findings about `escrow.service.ts`'s claim/revert
behavior remain true statements about that layer; the new protection
lives one level lower, inside the real provider.

**Residuals, disclosed, not fixed by this pass:**
- **Pre-submission vs. post-submission classification is conservative,
  not precise.** The installed WDK's `transfer()` is an opaque call (gas
  quote + broadcast bundled); this remediation cannot cheaply distinguish
  "failed before ever reaching the network" from "reached it and the
  response was lost" from outside that call. Every throw after an attempt
  is marked `PREPARED` is conservatively classified `SUBMISSION_UNKNOWN`
  — this is SAFE (never permits a blind duplicate) but has a real
  operational cost: a genuinely pre-submission failure (e.g. a bad gas
  quote) now also requires manual reconciliation rather than being
  auto-retryable, which was not true before this remediation.
- **`SUBMISSION_UNKNOWN` has no automated reconciliation path.** With no
  `txHash` to query, this state can only be resolved by an operator
  manually correcting the durable row after external investigation (e.g.
  checking the deterministic escrow/treasury address's on-chain history)
  — no operator-facing API/endpoint for this was built in this pass (out
  of scope: no new module, no new RFC).
- **Confirmation depth is 1 receipt, not N.** `waitForReceiptOutcome()`
  accepts the first real receipt it observes — no guard against a shallow
  reorg reversing a very-recently-mined block. Disclosed as future
  hardening per this mission's own explicit instruction, not built now.
- **The bounded receipt-poll window (default ~30s,
  `WDK_RECEIPT_POLL_ATTEMPTS`/`WDK_RECEIPT_POLL_INTERVAL_MS`) means a
  transaction that eventually mines outside that window is reported to
  the caller as "submitted but not yet confirmed," not as success** —
  correct, not a bug, but a real behavior a caller must be prepared to
  retry/reconcile against, including for transfers that ultimately
  succeed.
- **`chainId` is left unpopulated** on every `WdkTransferAttempt` row —
  the installed WDK package exposes no public method to read it without
  reaching into a private field; not implemented in this pass.
- **The new Prisma migration
  (`prisma/migrations/20260908000000_wdk_transfer_attempt`) was hand-authored
  to match this repository's own established migration format.** Locally,
  it could only be validated via `npx prisma validate`/`npx prisma
  generate` — no live Postgres was reachable in this session
  (`localhost:5432` connection refused). **Update: CI's own `build`/`test`
  workflow (`.github/workflows/ci.yml`) provisions a real, ephemeral
  Postgres 16 service and runs `npm run db:migrate` (`prisma migrate
  deploy`) against this exact migration before running any tests — both
  checks PASSED on this PR's HEAD, DEMONSTRATING (not merely validated
  offline) that the migration applies cleanly to a real Postgres instance
  and is consistent with `schema.prisma`.** Residual, still real: no test
  in this pass exercises `WdkTransferAttempt`'s own read/write behavior
  against that live database directly (every unit test still mocks
  `common/database`) — CI's green result proves the migration *applies*
  and the schema *compiles*, not that the table's own query shapes have
  been exercised against real Postgres data.

**Production eligibility: unchanged.** `WDK_USDT_EVM` remains
`PRODUCTION-INELIGIBLE` (RFC-019) — this remediation closes the retry-safety
and receipt-verification blockers this document and
`docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md` demonstrated; it does not by
itself constitute a production-eligibility review, and no such review is
claimed or authorized by this section.

### 22.1 CTO Gate Correction (2026-09-08) — closing the `PREPARED → transfer() → SUBMITTED` crash window

The remediation above (§22) is preserved verbatim — this is a correction
to a real gap found in it during CTO Gate review, not a rewrite.

**The gap:** the original `ensureAttempt()` only wrote `SUBMISSION_UNKNOWN`
from inside a `catch` block, *after* `transfer()` had already thrown. A
crash *during* the `transfer()` call itself — after a real broadcast may
already have occurred, before the JS promise ever settled either way —
left the attempt row at `PREPARED`, and the original code treated
`PREPARED` as unconditionally safe to reuse, reasoning (wrongly) that
`SUBMITTED`/`SUBMISSION_UNKNOWN` are "always written synchronously,
immediately following the one and only `transfer()` call attempt." That
reasoning silently assumed the function invocation completed at all — it
said nothing about a crash mid-`await`. `PREPARED` alone never actually
proved `transfer()` hadn't been called; it only proved the row's *last
write* was "identity recorded."

**The fix:** `wdk-execution-truth.ts` now exports
`markSubmissionAttempted()` — a durable, conservative pre-commit to
`SUBMISSION_UNKNOWN`, called by `wdk-settlement.provider.ts`'s
`executeTransfer()` **immediately before** `transfer()` is ever invoked
(no other `await` in between). Reusing the existing `SUBMISSION_UNKNOWN`
value rather than inventing a new status is deliberate: "the outcome of
any submission is unknown" is exactly true both before the call (nothing
has happened yet) and during/after a crash mid-call (the real outcome is
genuinely unknown) — the caller overwrites it to `SUBMITTED` with the
real hash the instant `transfer()` actually resolves. A crash at any
point from that pre-commit onward — including mid-`transfer()`, after a
real broadcast, or even during the *subsequent* `SUBMITTED` write itself
— now leaves the row durably at `SUBMISSION_UNKNOWN`, which
`ensureAttempt()`'s existing `SUBMISSION_UNKNOWN` branch already blocked
unconditionally; no change was needed there for this to become safe. No
new status value, no schema/migration change, no worker, no generic
`EconomicOperation`/cross-rail journal — the smallest change that closes
the window (Fase 2's own minimal-mechanism discipline, honored again).

**`PREPARED` now means something narrower, honestly stated:** a row can
only still be found at `PREPARED` if the crash happened strictly between
`ensureAttempt()` returning and that immediately-next, synchronous
pre-commit write — a real, disclosed, but now minimal residual window,
not eliminated by construction (that would require a distributed/2PC
mechanism this mission does not authorize). `ensureAttempt()`'s own
`PREPARED` case comment was corrected to state this precisely instead of
the original overclaim.

**Exact decimal comparison:** the integrity guard comparing a reused
attempt row's `destination`/`amount` against the current call's own
computed values used `Number(a) !== Number(b)` — a floating-point
comparison on values that must be compared exactly, since this check
exists specifically to catch a real anomaly on money. Replaced with
`decimalAmountsEqual()`, a pure string-normalization comparison (strips
leading zeros from the whole part, trailing zeros from the fraction) that
never parses through a float — `"5"`, `"5.0"`, and `"5.00000000"` all
normalize identically.

**New adversarial evidence:** `tests/wdkExecutionTruth.test.ts` gained 2
new tests (13 total, all passing) plus an extension to the existing
`REVERTED` test:
- A row already at `SUBMISSION_UNKNOWN` (standing in for a prior process
  that reached the pre-commit and then crashed mid-`transfer()`, with no
  "first call that threw" anywhere in the test itself) blocks a retry —
  `transfer()` is never called at all.
- `transfer()` genuinely resolves with a real hash, but the subsequent
  `SUBMITTED` write itself fails (a simulated DB error) — the row remains
  at the pre-commit's `SUBMISSION_UNKNOWN`, and a further retry still
  blocks — `transfer()` is invoked exactly once, ever, across both calls.
- The existing `REVERTED` test was extended to prove a fresh retry
  *after* a definitively reverted receipt is genuinely safe and succeeds
  (not merely that the first attempt fails correctly).
- `splitFunds()`'s per-leg protection inherits this same fix
  automatically, since both legs go through the identical, shared
  `executeTransfer()` — already covered by the 3 existing split tests
  (their assertions target `transfer()` call counts, unaffected by the
  extra pre-commit write).

Full regression (13 suites, 248 tests) passes unchanged otherwise. No new
`BACKLOG DELTA` — this is a correction to an already-registered
remediation, not a new finding.
