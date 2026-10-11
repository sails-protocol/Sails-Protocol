# AUD1X-R2 — dispatch authority and recovery

**Scope.** Findings AR-01 (High), AR-03 (Medium), AR-04 (Low) of the independent adversarial review of AUD1X-H1, and the
analysis of AR-05. Base: `9e7e3c363f0bfd6443b8c76dc321c1a9dbf0a48a` (PR #439). Not in scope and untouched: H1-R1 (legacy
PSBT policy), AR-02 (historical inventory), H1-R2, M1, M2, ST1-R1 (dead-generation reclaim), ST1-R2 (Gatekeeper).

## The defect

Three executors can build the signing round of one committed ruling: the live resolve flow
(`applyRulingCoreAuthoritative`), the C4 dispatch recovery and the assigned arbiter's own `initiate-*`. They are
serialized by the dispute lock (D) and the escrow lock (E), but the live flow treated "someone else already built it" as
**its own failure** and reverted the signed ruling and deleted its Outcome:

| | Before | Consequence |
|---|---|---|
| AR-01 | C4 builds between the Outcome commit and the live flow's dispatch (or its eligibility check) → the live flow throws, reverts the ruling | the round stays, the dispute can never be executed or re-ruled |
| AR-03 | the revert also runs after an authorization, a claim or a broadcast of that round | executed ruling, no ruling and no Outcome on record |
| AR-04 | the escrow status was read before the PSBT was built and not re-read under the locks | a round persisted on a terminal escrow; a second authorization minted for it |

## The policy implemented

An operational failure of the live dispatch is decided **inside one transaction, under D then E**
(`decideRulingRevert`, `src/modules/open-settlement/ruling-dispatch-authority.ts`). "This ruling" is the signed
generation: dispute, appeal round **and** the signed authority the round recorded.

| State (durable facts) | Decision | Why |
|---|---|---|
| 1. no round of this ruling, no executed disposition | **REVERT** (unchanged) | nothing depends on the ruling; the arbiter re-submits |
| 2. a round of this ruling exists and is **proven** its dispatch | **ADOPT** — the call succeeds, ruling and Outcome stand | the dispatch is done; signature, authorization, claim and broadcast only move this same round on |
| 3. a round of this ruling exists and is **not** its dispatch | **PRESERVE** — ruling and Outcome stand, the round is refused with the reasons | reverting would strand it; the guarded cleanup removes it if the guard fails and C4 re-dispatches |
| 4. no round left, escrow terminal, an authorization of this generation committed | **ADOPT** | the round was executed to the end |
| terminal escrow, **no** authorization of this generation (#239D bilateral) | **REVERT** as before (`rulingRevertTarget` restores MOOT) | unchanged contract |

*Proven* (`proveRoundIsThisDispatch`) means, under D, E and the dispute row `FOR UPDATE`: same escrow and dispute; the
dispute is RESOLVED; the round records the dispute's appeal round, arbiter, ruling, **signed authority and issue time**;
its kind, initiator, payout destinations and SPLIT allocation are those of the ruling; **and** the AUD-1 binding
(`assertRoundBoundToDisputeAuthority`: kind/bps, durable Outcome of that appeal round is the RESOLVED transition of that
ruling, destinations, amounts, output count, execution-cost ceiling) passes on the **stored** PSBT. Anything else is
refused with every reason; nothing is accepted by identifier or kind alone.

`initiate-*` itself is unchanged: one round per escrow, the caller that lost the race is told so (C4 keeps reporting it
as `alreadyResumedConcurrently`). The idempotency lives where the revert decision lives, so no second source of
authority and no new write path exists.

## Changes (production code)

| File | Change |
|---|---|
| `ruling-dispatch-authority.ts` (new) | `proveRoundIsThisDispatch`, `decideRulingRevert` |
| `dispute.service.ts` (`applyRulingCoreAuthoritative` failure handler only) | calls `decideRulingRevert` under D; the revert and the Outcome-record deletion are now **one transaction** |
| `dispute-outcome.ts` | `revertDisputeRulingRecord` accepts the transaction client (additive) |
| `escrow-pending-tx.ts` | AR-04: escrow status re-read `FOR UPDATE` inside the persisting transaction; `submit` refuses an impossible transition before the gate |
| `escrow-settlement-reconciliation.service.ts` | AR-05: PASS 1 produces the arbiter signature only under an authorization that still describes its round |

### Files shared with the Gatekeeper's ST1-R2 (PR #436, `ee38259`)

| File | #436 edits (hunks) | This change | Overlap |
|---|---|---|---|
| `dispute.service.ts` | import (+5 after `networkFor`), `pending` type (L701), guard-failure deletion (L722–757), top of the failure handler (+6) | one import line after `dispute-outcome`; the revert transaction body inside the same failure handler, ~30 lines below #436's hunk | none textually (`git merge-tree` trial merge: clean); composes semantically: #436 rethrows `St1R2DeletionRefused` **before** reaching this code |
| `dispute-dispatch-recovery.ts` | import, `pending` type, guard-failure deletion | **untouched** | — |
| `dispute-pending-reconciliation.ts` | one line (fee argument of the guard) | **untouched** | — |

Nothing of #436 was copied, rewritten or superseded.

## Locks

**Advisory (transaction-scoped), by acquisition order** — unchanged set, one new row lock.

| Lock | Key | Taken first by |
|---|---|---|
| T trade lifecycle | `trade-lifecycle:<tradeId>` | escrow create/lock/cancel paths (always first in their tx) |
| **D** | `economic-disposition:<disputeId>` | gate, Outcome commit, resolve claim, both reverts (incl. this one), appeal, ST-1 cleanup, **construction** |
| **E** | `hashtext(escrowId)` | after D when both are needed; alone for signature acceptance, claim records, result persistence |
| escrow **row** | `escrows` row `FOR UPDATE` | **new**: construction (after D, E). Only WDK rails take it elsewhere (never with D) |
| dispute **row** | `disputes` row `FOR UPDATE` | commit, resolve claim, construction, cleanup, `decideRulingRevert` (always after D) |

No path takes E before D, no path takes a dispute row before D, and nothing holds the escrow row while waiting for D
or E: no cycle. The behavioural proof is `tests/integration/staleDisputeCleanupSignatureRace` / AUD1X-H1 K1/L-tests plus
the audit's A4 probe (a reversed order produces PostgreSQL `40P01`).

**Linearization points.**

| Event | Point |
|---|---|
| ruling commit / revert / appeal | D, dispute row |
| construction of a round | D → E → escrow row → dispute row; the round exists at commit of that transaction |
| failure decision (ADOPT / PRESERVE / REVERT) | D → E → dispute row, one transaction; the verdict is what that transaction read |
| authorization | D (gate); precedes the claim by ADR-005 §4 |
| claim | escrow status compare-and-set (not under E); only after an authorization |
| signature acceptance, transition record | E |

Consequence: a failure decision that sees no round and reverts commits **before** any construction that takes D
afterwards (which then re-reads the dispute and refuses: H1 F3); a construction that commits first is seen by the
decision (ADOPT or PRESERVE). There is no interleaving in which both succeed.

## Residuals (stated, not hidden)

* The claim is a status compare-and-set without E. Between the gate (which mints the authorization) and the claim a
  concurrent execution can still make the claim fail; the authorization row then exists for a transition that never
  happens. No signature is produced (it follows the claim) and no broadcast. AR-04 closes the *construction* side and
  the early `submit` check; this window is narrower, not zero.
* A round of a **different** signed authority at the same appeal round (left by an earlier, reverted ruling) is not
  this ruling's: the failure is state 1 and the stale round remains. That is ST1-R1 (out of scope).
* A divergent round that passes the guard (a row whose `toAddress` differs but whose PSBT matches the Outcome) is
  refused for adoption by the live flow and stays executable by the participants through the gate, which judges the
  PSBT, not the row.
* AR-05: see below.

## AR-05 — PASS 1 and the committed authorization

**Question.** Can a durable authorization be reused in an economically contradictory state?

**Safe by construction post-AUD-1.** `economic_disposition_authorizations` has one writer, the ADR-005 gate, which
judges the AUD-1 binding before inserting; the row is keyed by the immutable round id and carries a digest of the
round's immutable content; the Outcome of an authorized generation can no longer be deleted (AR-03). So a contradiction
needs a row written by earlier code.

**Counter-proof (real PostgreSQL, `aud1xR2DispatchAuthority.test.ts` AR-05).** On `9e7e3c3`, with an authorization
whose ruling contradicts its round (Q3's shape, the pre-AUD-1 gate could leave it) or whose digest does not describe the
round, PASS 1 produced the arbiter signature and broadcast (1 broadcast). On this change: manual review, 0 broadcasts.
The control (a genuine authorization) still completes with 1 broadcast and a valid witness.

**Hardening included (purely technical).** `committedExecutionIdentity()` now makes, before returning an identity, the
two checks the gate's own reuse path makes: escrow/dispute/digest match, and the AUD-1 binding against the
authorization's ruling. It governs **signing only**: a transaction already on the network is still recovered without an
identity. No new authority, no change to what a valid authorization authorizes; the set of recoveries that complete can
only shrink in states that were contradictory. It is a separate commit and can be dropped independently.
