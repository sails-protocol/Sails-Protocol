# PROVIDER_SUBSTITUTION_INVARIANCE_EVIDENCE.md

### Provider Substitution Invariance Mission — Evidence Record

> Follows this repository's own evidence-artifact convention
> (`docs/MAINNET_MULTISIG_PROOF.md`'s "What was proven" / "What was NOT
> proven" structure, `docs/CONDITION_ALGEBRA_CONFORMANCE_EVIDENCE.md`'s
> layered claim discipline). This is evidence, not a marketing document
> — `OUTPUT != EVIDENCE != PROPERTY != CLAIM`.

## 1. Baseline

- **Commit at mission start:** `35cfcbf59076b0ee50ecdd6ec92b14260e99f446`
  (`main`, clean working tree — verified via `git status --short` before
  any file was touched)
- **`@satsails/p2p-trading-sdk` version:** `0.1.3` (unchanged)
- **Protocol fee:** `PROTOCOL_FEE_RATE` default `0` (unchanged, not touched)
- **PR #59 baseline present:** confirmed — `sails-condition-algebra@1.0`
  registered in `scripts/run-conformance-harness.ts`, evidence doc present.

## 2. Sources Inspected

`docs/SEMANTIC_KERNEL.md` (§6-24, K2/K3, Non-Custody/Recovery
Classification, Specification Reconciliation, Current Implementation
Conformance tables), `docs/CORE_ARCHITECTURE.md`, `docs/rfcs/RFC-019-settlement-custody-reference-vs-normative.md`,
`packages/sails-core/src/outcome.ts`, `correspondence.ts`,
`correspondence-result.ts`, `evaluator-identity.ts`,
`src/modules/open-settlement/escrow-providers.ts`,
`escrow.service.ts` (`releaseFunds`/`refundFunds`),
`escrow-lifecycle.ts` (`resolvePayoutAddress`, `claimEscrowTransition`,
`revertEscrowStatus`), `destination-correspondence.ts`,
`economic-outcome.ts`, `dispute-correspondence.ts`,
`dispatch-translation-guard.ts`, `dispatch-gate-adapter.ts`,
`dispute.service.ts` (`resolveDispute`), `discretionary-authority.ts`,
`escrow-settlement-reconciliation.service.ts`,
`dispute-pending-reconciliation.ts`, `wdk-settlement.provider.ts`,
`multisig.provider.ts`, `lightning-hodl.provider.ts`,
`safe-guard-evm.provider.ts`, `src/config/index.ts` (boot-time
production gates), and the existing test suites named in §7/§9 below.
Conformance infrastructure (`conformance/evaluators/`,
`conformance/vectors/`, `scripts/run-conformance-harness.ts`) reused
without modification.

## 3. Documented / Implemented / Tested / Demonstrated Matrix

| Layer | Documented | Implemented | Tested | Demonstrated live |
|---|---|---|---|---|
| K3 (Semantic Settlement Independence) | Yes (`SEMANTIC_KERNEL.md` §7/§17) | N/A (Kernel-level statement) | N/A | Kernel's own Current Implementation Conformance table: **PARTIAL** — "not every provider's translation discipline has been independently re-verified against K3's exact wording" |
| `Outcome`/`DestinationBinding` (Core, M1) | Yes | Yes (`packages/sails-core/src/outcome.ts`) | Yes (Core unit tests) | Not itself the live settlement authority for any provider (see row below) |
| `Correspondence` evaluator (Core, M6) | Yes | Yes (`correspondence.ts`), conformance-tested (`sails-destination-correspondence-evaluator@1.0`, 4/4 identities conformant per `npm run check:conformance`) | Yes (`tests/correspondenceEvaluator.test.ts`) | Structurally provider-agnostic (verified: the file imports nothing but Core's own `outcome`/`correspondence-result`/`evaluator-identity` — no Prisma, no network, no Provider type) |
| Runtime correspondence adapter (`destination-correspondence.ts`) | Yes | Yes | Yes (`tests/destinationCorrespondence.test.ts`) | Own header: **"NOT WIRED INTO ANY LIVE PATH"** as a general-purpose adapter — but see next row for its one real live consumer |
| MULTISIG live correspondence (`dispute-correspondence.ts`, M8.6) | Yes | Yes | Yes (`tests/disputeCorrespondence.test.ts`, 94/94 across the reran suite) | **Live**, but scoped to MULTISIG **disputed/arbitrated** releases only; detection-only (never blocks/reverses an already-broadcast settlement) |
| Pre-dispatch translation guard (`dispatch-translation-guard.ts`, M8-R) | Yes | Yes | Yes (`tests/dispatchTranslationGuard.test.ts`) | **Live**, MULTISIG only, runs before signature collection/broadcast |
| Signed-authority-to-destination binding (`dispatch-gate-adapter.ts`) | Yes | Yes | Yes | Own header: **"NOT WIRED INTO ANY LIVE PATH"** — `resolveDispute()` still lets a caller's raw `releaseToAddress`/`refundToAddress` override a registered payout address with **no cryptographic or durable-provenance check at all**, for every non-MULTISIG rail |
| `SettlementProvider` registry/dispatch (`escrow-providers.ts`) | Yes | Yes | Yes (`tests/settlementProviderSelection.test.ts`) | **Live**, universal (all 5 providers), fail-closed (no silent MOCK fallback — a real historical violation of this exact property, closed) |
| Recovery/reconciliation (`escrow-settlement-reconciliation.service.ts`) | Yes | Yes | Yes | **Live**, MULTISIG-only chain-verified recovery; every other rail fails closed (no automated recovery attempted) — this is Class D substitution, already tracked as the separate "Recovery/Reconciliation Conformance" gap (F02 item 3), not duplicated here |

## 4. Substitution Classes — Which Is Actually Testable

Per the mission's own Phase 3 taxonomy (A: same-mechanism/different-provider,
B: different-mechanism/same-disposition, C: infrastructure substitution,
D: execution-instance substitution):

- **Class A (provider substitution, same rail)** — **UNTESTABLE.** No
  rail in this repository has a second legitimate implementation. Each
  of `MULTISIG`, `LIGHTNING_HODL`, `WDK_USDT_EVM`, `SAFE_GUARD_EVM` is
  the sole implementation of its own rail.
- **Class B (mechanism substitution, same disposition)** — **UNTESTABLE
  operationally.** `RECOMMENDED_ESCROW_TYPE` (`escrow-providers.ts`) is
  a strict 1:1 asset-to-provider map (`BTC -> MULTISIG`,
  `LN_BTC -> LIGHTNING_HODL`, `USDT_ERC20 -> WDK_USDT_EVM`); nothing in
  production ever chooses between two mechanisms for the same
  disposition. `MOCK` can stand in for any asset, but a mock is
  explicitly excluded by this mission's own governing principle from
  counting as a second legitimate mechanism.
- **Class C (infrastructure substitution)** — no dual-infrastructure
  configuration (e.g. multiple RPC endpoints per provider) was found
  represented as a substitutable unit anywhere inspected.
- **Class D (execution-instance substitution — retry/recovery realizing
  the same already-authorized Outcome)** — the one class with real,
  testable material (`claimEscrowTransition`/`revertEscrowStatus`
  atomic claims; `escrow-settlement-reconciliation.service.ts`;
  `dispute-pending-reconciliation.ts`). **Already claimed by the
  separate, previously-tracked "Recovery/Reconciliation Conformance"
  gap (FOUNDATIONS-02 item 3)** — per this mission's own explicit
  instruction, not counted as new here and not pursued further in this
  document.

**Conclusion: genuine two-implementation Provider/Mechanism Substitution
(Classes A/B) has no real, legitimate pair to test in this repository
today.** This is not a testing-methodology gap this mission can close by
writing more tests — it is a fact about what actually exists. Per Phase
7 (Testability Gate), the mission proceeds by testing **boundary
enforcement** (does the architecture structurally prevent a provider
from authoring economic meaning, and does it detect a provider that
violates the boundary), not **operational replaceability** (swapping two
real implementations), which is impossible to demonstrate today without
manufacturing a fake second provider — explicitly forbidden.

## 5. Property Definition

**Candidate property, attacked and retained:** *For a fixed authoritative
destination/amount/asset, no legitimate `SettlementProvider` may itself
decide or alter that destination/amount/asset; it may only execute
against whatever the caller supplied, and — where a live correspondence
mechanism exists — any execution that reaches a different destination or
amount than authorized must be detectable, never silently treated as a
match.*

### MUST REMAIN INVARIANT (derived from repository truth)

- The authorized destination address, resolved once via
  `resolvePayoutAddress()` (`escrow-lifecycle.ts:501`) **before** any
  provider is selected — identical for whichever provider
  `getSettlementProvider(escrow.type)` returns.
- The escrow's locked amount/asset, read from the same `Escrow` record
  regardless of provider.
- For MULTISIG specifically (the only rail with a real, durable,
  Outcome-shaped authority record): the full economic disposition
  (`ArbitrationOutcomeContent` — ruling, basis-point allocations,
  `remainderBeneficiary`) — checked **pre-dispatch**
  (`dispatch-translation-guard.ts`) and **post-execution**
  (`dispute-correspondence.ts`), though the latter is detection-only.

### MAY LEGITIMATELY VARY

Provider name/identity; transaction id/hash; network/miner fee (bounded
by `execution-cost-policy.ts`'s deterministic ceiling for MULTISIG);
timing; PSBT/tx internal structure; retry/attempt count;
provider-specific metadata (`vout`, `confirmedAtHeight`,
`tipHeightAtObservation`).

Not underspecified — proceeding past this phase.

## 6. Authority vs. Execution Attack (Phase 5)

- **No path found where a provider itself supplies or derives the
  destination.** `releaseFunds(escrow, toAddress)`/`refundFunds(escrow)`
  always receive the destination (or derive the refund destination from
  the escrow's own already-known participant) from the caller, never
  from provider-internal state. Confirmed directly in
  `escrow.service.ts:595-598` and `wdk-settlement.provider.ts:154-165`
  (the `recipient` field passed straight through to the WDK SDK call is
  the caller's own `toAddress`, never provider-computed).
- **The authority mechanism itself is not provider-uniform.**
  `dispute.service.ts`'s `resolveDispute()` branches explicitly on
  `escrowForBranch.type === 'MULTISIG'`
  (`dispute.service.ts:603-630`): MULTISIG disputes go through
  `applyRulingCoreAuthoritative()` (signed `AuthorityDecisionPayload`,
  Core-authoritative `Outcome`, both guards above); every other provider
  (LIGHTNING_HODL, SAFE_GUARD_EVM, WDK_USDT_EVM, MOCK) goes through the
  legacy `applyRuling()`, which — per `destination-correspondence.ts`'s
  own header — passes `releaseToAddress`/`refundToAddress` as **plain,
  unsigned parameters**, never inside the signed decision payload. This
  is a pre-existing, already-disclosed residual (Mission13/M6/M7/M8
  material, restated by `dispatch-gate-adapter.ts`'s own header: "NO
  cryptographic or durable-provenance check at all" for this path), not
  newly discovered by this mission — cited here because it is directly
  relevant to why Structural Replaceability is not uniform across
  providers.
- **A real historical provider-substitution violation existed and was
  fixed.** `getSettlementProvider()`'s own comment block
  (`escrow-providers.ts:428-449`) documents that this function used to
  silently substitute `MockSettlementProvider` for *any* real,
  registered escrow type whenever `MOCK_ESCROW` was left at its default
  — i.e., a real instance of "a provider ends up authoring economic
  meaning it was never authorized to" (a mock provider silently
  standing in for a real one). Now fail-closed: an unregistered type
  throws rather than falling back; `type === 'MOCK'` only ever resolves
  MOCK when explicitly requested at creation time. Regression-guarded by
  `tests/settlementProviderSelection.test.ts` (reran, passing — §9).
- **Custody is a separate, already-disclosed axis, not conflated here.**
  `WDK_USDT_EVM` is frozen (RFC-019, 2026-08-24) as **"SERVER-CUSTODIAL
  REFERENCE IMPLEMENTATION / PRODUCTION-INELIGIBLE"** — a real, current
  violation of `PROTOCOL_INVARIANTS.md` Constitutional Invariant 2, not
  a K3/destination-meaning violation. Custody (who can move funds at
  all) and destination-meaning-preservation (does the mover redirect
  where funds go) are distinct properties; this mission concerns only
  the latter, consistent with §13 of `SEMANTIC_KERNEL.md`'s own
  "Non-Custody Classification."

## 7. Actual Provider Inventory

| Provider | Type | Status label (verbatim, own header/RFC) |
|---|---|---|
| `MockSettlementProvider` | MOCK | No formal label; `config/index.ts`'s own comment calls unmocked escrow with this active "theater" |
| `LightningHodlProvider` | LIGHTNING_HODL | "real via Arkade... Replaces the previous throw-only stub"; "Testnet (mutinynet) only" |
| `MultisigProvider` | MULTISIG | "Real, testable Bitcoin script/PSBT construction"; "Non-custodial in the fund-movement sense — unlike MOCK/WDK_USDT_EVM"; testnet only |
| `WdkSettlementProvider` | WDK_USDT_EVM | RFC-019: **"SERVER-CUSTODIAL REFERENCE IMPLEMENTATION / PRODUCTION-INELIGIBLE"** — boot-time FATAL guard in `config/index.ts` refuses production with a real seed configured |
| `SafeGuardEvmProvider` | SAFE_GUARD_EVM | RFC-019: **"CURRENT EVM AUTHORITY CANDIDATE / NOT PRODUCTION-ACTIVATED"** — `lockFunds`/`verifyLock`/`broadcast` are real code but never exercised against live infrastructure |

No `HodlHodlProvider` implementation exists in this codebase (referenced
only as an external design precedent in comments).

**Correction/addendum, 2026-09-06 (Cross-Rail Guard-Maturity Disclosure
mission) — a real guard this table did not originally surface.**
`MULTISIG` has a fail-closed capability-profile enforcement mechanism
(`capability-profile.ts`'s `REQUIRED_CAPABILITY_PROFILE` /
`findCapabilityCommitBlocker()`, Missão 11 Fase 9.1.1): a MULTISIG
deposit address is never derived unless both participants have declared
a known, compatible client capability profile — "unknown capability =
unsupported" with no silent-pass path. `LIGHTNING_HODL`, `SAFE_GUARD_EVM`,
`WDK_USDT_EVM`, and `MOCK` have **no requirement wired in this map at
all** — `findCapabilityCommitBlocker()` returns `null` (no blocker) for
any escrow type absent from `REQUIRED_CAPABILITY_PROFILE`, unconditionally.
This is a distinct property from the correspondence/translation-guard
asymmetry already documented elsewhere in this file (§9's P7 row,
`dispatchTranslationGuard.test.ts`) — capability-profile enforcement
checks *client declaration compatibility before commitment*;
correspondence/translation guards check *the constructed transaction
against the authorized rule before signing*. Both are real, both are
MULTISIG-only today, and this document previously named only the
second. Registered here as a factual addition to this table's own
scope — it does not change any conclusion already reached in §15/§16
below (operational substitution remains NOT DEMONSTRATED; this is a
disclosure correction, not a new equivalence or substitution claim).

## 8. Testability Gate (Phase 7)

Direct substitution testing (Classes A/B) is not possible — no
legitimate pair exists (§4). Boundary-enforcement testing through
**already-existing, real, non-mock-invented mechanisms** is possible and
was used: the `SettlementProvider` registry/dispatch chokepoint
(universal, all 5 providers) and the MULTISIG correspondence/guard pair
(scoped, one rail). No new test double was manufactured for this
mission; every piece of evidence below cites code and tests that already
existed prior to this mission starting.

**Preserved distinction:** Boundary enforcement evidence (below) proves
the architecture *would* reject/expose a violation where a live check
exists — it does not prove *operational* replaceability across real
distinct providers, which remains undemonstrated (§4).

## 9. Metamorphic Relations and Wrong-Provider/Mutant Evidence (Phases 8-9)

No new test code was written for this mission. The following
already-committed tests were **rerun fresh** against the current `main`
baseline to confirm they still pass (not assumed from memory):

```
npx jest tests/disputeCorrespondence.test.ts tests/destinationCorrespondence.test.ts \
  tests/correspondenceEvaluator.test.ts tests/settlementProviderSelection.test.ts \
  tests/dispatchTranslationGuard.test.ts tests/economicOutcome.test.ts

Test Suites: 6 passed, 6 total
Tests:       94 passed, 94 total
```

Mapped against the mission's own candidate attacks:

| Attack | Evidence | Result |
|---|---|---|
| M1 — Provider identity substitution (Outcome/DestinationBinding invariant under a provider-identity change) | `correspondence.ts`'s own import list contains no Provider/Prisma/network dependency (structural, verified by inspection — the evaluator cannot distinguish providers because it never receives one) | **Provider-identity architectural independence: SUPPORTED.** **Metamorphic execution across two real providers: NOT DEMONSTRATED** — this is absence-of-coupling evidence (the evaluator has no way to depend on a provider), not a runtime execution that actually substituted one real provider for another and compared results. No two real providers exist to run such an execution against (§4). Absence of provider coupling supports separation; it does not itself demonstrate operational substitution. |
| P1 — Destination mutation | `disputeCorrespondence.test.ts` "CORR-2/P25: wrong destination -> UNKNOWN... never MATCH" | PASS (correctly rejects) |
| P3/P4 — Amount mutation / skim | `disputeCorrespondence.test.ts` "COST-18/P26: an extreme single-beneficiary skim disguised as fee is DIVERGENT"; "CORR-5/P26: a delivered-value shortfall... is DIVERGENT"; SPLIT ratio-substitution ("70/30 shifted to 60/40... is DIVERGENT on both legs") | PASS (correctly rejects) |
| P6 — Success laundering | `destinationCorrespondence.test.ts` "P9. Provider SUCCESS never automatically becomes MATCH" — a provider reporting only "reached the rail" with no real detail normalizes to UNKNOWN, never MATCH | PASS (correctly rejects) |
| Historical P1-shaped attack — silent Mock substitution for a real provider | `settlementProviderSelection.test.ts` — MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM/WDK_USDT_EVM always resolve to their real provider regardless of the `mockEscrow` flag; an unregistered type throws rather than silently falling back | PASS (regression-guards a real, previously-fixed violation) |
| P7 — Correspondence bypass (translation-level, pre-dispatch) | `dispatchTranslationGuard.test.ts` — validates `multisig.provider.ts`'s own PSBT construction against the authorized rule before signing/broadcast | PASS |

All results scoped to MULTISIG (correspondence/guard-specific attacks)
or to the universal provider-dispatch chokepoint (the historical
Mock-substitution attack, which applies to all 5 providers equally).

## 10. Correspondence Role (Phase 10)

```
Authorized Outcome (destination/amount resolved once, upstream of provider choice)
      |
DestinationBinding
      |
Provider execution (uniform interface, provider cannot see/alter the destination it was handed)
      |
External observation
      |
Correspondence evaluation  <-- LIVE only for MULTISIG + disputed/arbitrated releases
```

- **Before execution:** enforced universally (destination resolved
  independent of provider; fail-closed dispatch). Enforced with
  translation fidelity only for MULTISIG (`dispatch-translation-guard.ts`).
- **After execution (correspondence):** live only for MULTISIG disputed
  releases (`dispute-correspondence.ts`), and even then **detection-only
  — "NEVER ALLOWED TO FAIL THE SETTLEMENT," logged, never reversed.**
  MULTISIG **cooperative** (non-disputed) releases and **all** releases
  on LIGHTNING_HODL, WDK_USDT_EVM, and SAFE_GUARD_EVM have **no live
  after-the-fact correspondence check at all** — a provider on any of
  those paths that executed successfully but diverged from the
  authorized destination/amount would go completely undetected by this
  architecture today.
- **Is correspondence itself provider-independent?** Yes, structurally
  (§9, M1) — the Core evaluator and its runtime adapter never reference
  a specific provider. **Is it operationally applied across providers?**
  No — its one live wiring point is single-rail, single-path.

## 11. Structural vs. Operational Replaceability (Phase 11)

```
STRUCTURAL PROVIDER SEMANTIC BOUNDARIES
                !=
OPERATIONAL PROVIDER REPLACEABILITY
```

- **Structural** — the tested architecture prevents selected
  provider/execution behavior from becoming authoritative economic
  meaning on the demonstrated surface.
- **Operational** — two legitimate, distinct providers/mechanisms have
  actually been substituted while preserving the declared property.

```
Structural: SUPPORTED (for the boundary the architecture actually enforces — see scope below)
Operational: NOT DEMONSTRATED
```

**Structural Provider Replaceability — SUPPORTED, with an exact,
disclosed scope:** the `SettlementProvider` interface is uniform and
fail-closed across all 5 registered providers; the authorized
destination is resolved independent of, and prior to, provider
selection; a historical violation of this exact boundary was found and
closed, with a regression test. Within MULTISIG specifically, pre- and
post-execution checks exist and adversarially reject destination/amount
mutation. This support does **not** extend uniformly: the
signed-authority-to-destination binding itself
(`dispatch-gate-adapter.ts`) is not live for non-MULTISIG rails, and
post-execution correspondence is live for exactly one rail and one path.

**Operational Provider Replaceability — NOT DEMONSTRATED:** no two
legitimate distinct providers or mechanisms were substituted for one
another while preserving a checked property, because no such pair exists
in this repository today (§4). This is not a gap this mission could
close without manufacturing a fake second implementation, which is
explicitly out of scope.

## 12. Conformance Surface (Phase 12)

No new conformance architecture was created. The existing
Core-level correspondence conformance surface
(`sails-destination-correspondence-evaluator@1.0`,
`conformance/evaluators/`, `conformance/vectors/`,
`scripts/run-conformance-harness.ts`) already represents the one
provider-agnostic primitive this property depends on, and remains
unmodified — reused, not reinvented. Provider Substitution Invariance
itself (Classes A/B) has no artifact gap to report, because it is not
representable as a conformance vector set without a real second
provider to generate genuine, non-fabricated expected values from — the
same "the implementation is the defendant, not the oracle" discipline
`CONDITION_ALGEBRA_CONFORMANCE_EVIDENCE.md` established would be
violated by inventing one.

## 13. Implementation Performed

**None beyond this evidence artifact.** No new test file, no Core
change, no Kernel change, no schema change, no provider change, no SDK
change. Every piece of evidence in §9 cites tests that already existed
on `main` before this mission started; they were rerun, not written.

## 14. Regression Results

- `npx jest tests/disputeCorrespondence.test.ts tests/destinationCorrespondence.test.ts tests/correspondenceEvaluator.test.ts tests/settlementProviderSelection.test.ts tests/dispatchTranslationGuard.test.ts tests/economicOutcome.test.ts` — 6/6 suites, 94/94 tests passed.
- No file under `src/` or `packages/` was modified by this mission — no
  broader regression run is required (documentation-only change).

## 15. Smallest Defensible Claim

**Confirmed final claim (CTO-reviewed wording):**

**"Sails demonstrates tested structural boundaries that prevent
settlement providers from redefining selected authoritative economic
meaning. Operational substitution between two distinct legitimate
providers has not been demonstrated."**

Attacked against the evidence above and confirmed, not narrowed further
— every clause is directly supported: "tested structural boundaries"
(§6, §9, §11), "selected" (not universal — §7/§10's per-provider scope
table), "has not been demonstrated" (§4, §11). A broader claim would not
survive; this exact wording is retained as the governing sentence for
this evidence artifact and any future freeze record.

**Supporting elaboration (same claim, with the specific mechanisms
named):** Sails enforces a uniform, fail-closed `SettlementProvider`
dispatch boundary across all five registered providers, under which no
provider receives or decides the authorized destination it executes
against; a real historical violation of this boundary was found and
closed, with a regression test. For the one rail with a live
post-execution check (MULTISIG disputed releases), destination and
amount mutation are demonstrated — via already-existing,
rerun-and-passing tests — to be detected, never silently treated as a
match. No two legitimate, distinct providers or mechanisms have been
substituted for one another in this repository, because no such pair
currently exists to test.

Deliberately not "provider independence" or "provider substitution
demonstrated" as unqualified claims — those would conflate the
structural boundary that is enforced with the operational
replaceability that has not been, and would use `SettlementProvider`'s
own existence as if it were evidence of the property this mission
exists to check (`K3 architectural meaning != provider abstraction
exists != provider substitution demonstrated`, this mission's own
opening caution).

## 16. NOT PROVEN

- Universal provider independence, or independence for any rail beyond
  the scope disclosed above.
- All settlement rails — LIGHTNING_HODL, WDK_USDT_EVM, and
  SAFE_GUARD_EVM have zero live post-execution correspondence coverage;
  a destination/amount-diverging execution on any of them would go
  undetected today.
- Arbitrary mechanism substitution — no two mechanisms are
  interchangeable for the same disposition in production configuration.
- Production provider interchangeability — no real provider is production-authorized, and the status differs per provider (Corrected/Implemented 2026-11-27): `MULTISIG` is the only one with a supported mainnet configuration and has one disclosed micro-value mainnet rehearsal, but is not decided or homologated for production; `LIGHTNING_HODL` and `SAFE_GUARD_EVM` are testnet only; `WDK_USDT_EVM` and `MOCK` are production-ineligible (RFC-019).
- Operational failover, censorship resistance, or operator independence.
- Interoperability.
- Recovery/Reconciliation Conformance (Class D substitution) — separate,
  already-tracked gap (F02 item 3), not pursued here.
- Independent (second-language) implementation.
- Economic equivalence across different rails, or identical
  fees/timing/finality across providers.
- Full K3 conformance — `SEMANTIC_KERNEL.md`'s own Current
  Implementation Conformance table already states K3 is PARTIAL; this
  mission narrows, but does not close, that gap.
- Production readiness of any kind.

## 17. COBRA / Goodhart Check

- **Did we prove semantic substitution or merely dependency injection?**
  Neither claimed as proven — dependency injection (the uniform
  interface) is reported as structural support only; semantic
  substitution across real providers is explicitly NOT DEMONSTRATED.
- **Did we create two test doubles and call that operational provider
  replaceability?** No — no test double was created at all; MOCK is
  explicitly excluded from counting as a legitimate second
  implementation.
- **Did we define "equivalent" as "returns the same object"?** No — the
  property tested is destination/amount preservation under real
  transaction decoding (Bitcoin PSBT bytes via `bitcoinjs-lib`), not
  object identity.
- **Did we ignore economically meaningful differences because the API
  shape matches?** No — §11 explicitly discloses the boundary is
  non-uniform across rails despite the interface being uniform.
- **Did we choose invariants based on what the current provider already
  happens to preserve?** No — MUST-REMAIN-INVARIANT (§5) was derived
  from `SEMANTIC_KERNEL.md` §7/§17 (K3's own text) and `outcome.ts`'s
  own design intent, before re-reading provider code to check
  conformance, matching the same non-circularity discipline
  `CONDITION_ALGEBRA_CONFORMANCE_EVIDENCE.md` established.
- **Did we let provider success stand in for correspondence?** No — §9's
  P6 evidence (`destinationCorrespondence.test.ts`) is precisely the
  test that rejects this.
- **Did we manufacture a second provider to obtain an A?** No — this is
  the central reason the verdict is B, not A.
- **Did we treat absence of imports as direct substitution evidence?**
  Corrected — §9's M1 row now explicitly separates "provider-identity
  architectural independence: SUPPORTED" (what the import-absence check
  actually shows) from "metamorphic execution across two real providers:
  NOT DEMONSTRATED" (what it does not show).
- **Did we broaden "selected authoritative economic meaning" into
  universal K3?** No — §16 explicitly lists "Full K3 conformance" under
  NOT PROVEN, and every claim sentence (§15) uses "selected," never
  "universal" or "full."
- **Did we confuse interface modularity with decentralization?** No —
  §6 explicitly separates custody (RFC-019, a different axis) from
  destination-meaning preservation (this mission's actual scope).
- **Did we optimize for passing tests rather than preserving economic
  meaning?** No new tests were written to pass; existing ones were
  rerun and their actual scope (not their existence) was audited.

No STOP triggered by this check.
