# ADR-002: Asset / SettlementRail / Adapter / Provider Architecture

**Status:** Accepted (architecture decision only — no implementation
authorized by this document). **Type:** Architecture Decision Record.
**Origin:** CTO mission chain, 2026-09-12 — Asset / Network / Settlement
Architecture Discovery → ARCH-DESIGN → ARCH-FREEZE. Full evidence:
`docs/ASSET_SETTLEMENT_RAIL_ARCHITECTURE_DISCOVERY_2026-09-12.md` (this
mission's own institutionalized discovery+design record, created
alongside this ADR — see that document for every file:line citation
this ADR's decisions rest on). Institutionalizes the Product Decision
recorded in `docs/PROJECT_CONTEXT.md`'s own dated section (§2C, added
alongside this ADR) and the frozen scope list restated in `docs/BACKLOG.md`
item 20.6.

**Not authorized by this document:** any change to `AssetType`,
`EscrowType`, `prisma/schema.prisma`, any SDK runtime contract, any QVAC
schema, the Reference UI, any provider or registry code, or
`docs/SEMANTIC_KERNEL.md`. This is architecture freeze only — property
and vocabulary first, implementation is a separate, later, separately-
authorized mission (see §12, Suggested Sequencing).

---

## 1. Context

The reference implementation's `AssetType` enum (`src/common/types/index.ts`
and four independently-maintained copies) conflates three distinct
concepts into one flat 10-value string — asset identity, settlement
network/protocol, and (implicitly) rail — confirmed directly from code
during the discovery pass this ADR is built on (`escrow-providers.ts`'s
own `RECOMMENDED_ESCROW_TYPE` maps only 3 of those 10 values to any real
provider; the other 7 have no provider at all, and `LN_BTC`'s own name
claims Lightning while its one real provider, `LIGHTNING_HODL`, is
Arkade-backed — already corrected in prose by the 2026-09-10 Product
Truth Sweep, never in the type itself).

`docs/BACKLOG.md` item 20 already named the problem precisely and left
its mechanism deliberately open: *"the current flat `AssetType`...
demonstrably does not scale to \[the Day-0] matrix without either a
combinatorial explosion of new flat values or a genuine Asset × Network
× Settlement-Capability decomposition. Which of those (or another
option) is correct is an **open architecture question**, deliberately
not decided by this freeze."* This ADR is that decision.

`docs/PROTOCOL_SPECIFICATION.md` §4B already anticipated part of the
answer — an additive `chain` field on a `SettlementAdapter` extending
`SettlementProvider` — but the reference implementation never adopted
it, and the extension relationship itself does not match the
Adapter/Provider distinction this ADR now freezes (see §6).

## 2. Frozen Distinctions

> **Asset ≠ SettlementRail ≠ SettlementAdapter ≠ SettlementProvider**

- **Asset** — the economic unit being transferred, independent of how it
  moves. Examples: `BTC`, `USDT`, `USDC`, `DEPIX`, `XAUT`.
- **SettlementRail** — the settlement domain/network/protocol through
  which an Asset is represented or settled. Deliberately one dimension,
  not two (§3). Examples: `BITCOIN_L1`, `LIGHTNING`, `ARKADE`, `LIQUID`,
  `SPARK`, `ETHEREUM`, `BASE`, `TRON`, `SOLANA`, `TON`.
- **SettlementScope** — a registered, valid `{asset, rail}` product
  combination. Registration is explicit and sparse (§4) — never a
  computed Asset×Rail cross-product.
- **SettlementAdapter** — translates Sails settlement semantics into a
  concrete external implementation/client/SDK (e.g. the Ark/VTXO
  translation logic, the WDK EVM translation logic, the Bitcoin PSBT
  translation logic).
- **SettlementProvider** — supplies or executes an economic settlement
  capability (lock/release/refund/split) for one or more registered
  `SettlementScope` rows, using a `SettlementAdapter`.

**Adapter and Provider may be implemented by the same runtime class
today, and this is explicitly allowed to continue** — every one of the
five current provider files (`multisig.provider.ts`,
`lightning-hodl.provider.ts`, `safe-guard-evm.provider.ts`,
`wdk-settlement.provider.ts`, `MockSettlementProvider`) co-locates both
concerns, and nothing in this ADR requires splitting them into separate
classes. What is frozen is the *conceptual* relationship: a Provider
**uses** an Adapter (composition), an Adapter **may eventually serve
multiple** Provider registrations (different treasuries, collateral, or
fee policy over the same underlying client library — `RFC-021 D2`'s
`MarketArbitrationProvider`, many arbiter registrations sharing one
mechanism family, is already a live precedent for this shape in a
different capability family). Today every real Adapter backs exactly
one Provider; this ADR's types tolerate that without requiring it to
stay that way.

## 3. Why SettlementRail Is One Dimension, Not Two

Considered and rejected: splitting "Protocol" from "Network" as two
separate required dimensions. No row in the frozen Day-0 matrix (§5)
needs it — `docs/BACKLOG.md` item 20's own BTC row already lists
on-chain/Spark/Lightning/Arkade/Liquid as five *siblings*, never as
chain+protocol pairs, and every institutional document surveyed during
discovery talks about these the same way. Splitting them would add a
dimension that exists only for taxonomic purity, not because any
concrete Day-0 case forces it — rejected per this repository's own
"complexity must earn its place" discipline.

## 4. SettlementScope Is Sparse and Explicitly Registered

A `SettlementScope` row's **absence** means "not Day-0 Product Scope."
Its **presence with zero registered Providers** means "in scope, not
yet implemented" — a valid, expected, non-error state, not a defect.
Validity is registration, not computation: no Asset×Rail cross-product
is auto-valid merely because both values independently exist (e.g.
`XAUT × ARKADE` is invalid simply because no one has ever registered
that row — the registry's own sparseness is the guard, not a combinatorial
enum). **Scope registration does not by itself imply implementation,
evidence, beta eligibility, or production eligibility** (§7).

## 5. Frozen Canonical Day-0 Scopes (25 rows)

*(Historical as of 2026-11-01: superseded as the Day-0 **commitment** by
§5A below. The table and the surrounding text are preserved verbatim —
they record what was frozen on 2026-09-10/12 and why.)*

Restates `docs/BACKLOG.md` item 20's own canonical Day-0 target,
re-expressed as `{asset, rail}` rows — no scope change, a re-expression
only:

| Asset | Rails |
|---|---|
| **BTC** | `BITCOIN_L1`, `LIGHTNING`, `SPARK`, `ARKADE`, `LIQUID` (5) |
| **DEPIX** | `LIQUID`, `SPARK` (2) |
| **USDT** | `ETHEREUM`, `BASE`, `OPTIMISM`, `POLYGON`, `AVALANCHE`, `SOLANA`, `TRON`, `TON`, `BNB_CHAIN`, `ARBITRUM`, `LIQUID` (11) |
| **USDC** | `ETHEREUM`, `BASE`, `OPTIMISM`, `ARBITRUM`, `AVALANCHE`, `POLYGON` (6) |
| **XAUT** | `ETHEREUM` (1) |

**25 total rows.** No `SettlementScope`/Provider registry is implemented
yet (§12) — concrete, current provider implementations correspond to
these scopes: `{BTC,BITCOIN_L1}` → MULTISIG, `{BTC,ARKADE}` →
LIGHTNING_HODL (see §11 on why this is `ARKADE`, not `LIGHTNING`), and
`{USDT,ETHEREUM}` → WDK_USDT_EVM (testnet, server-custodial);
`{USDT,TRON}` has schema-only representation, zero provider. The
remaining ~21 rows have zero implementations today — all valid Day-0
scope under this architecture, none an error.

*(2026-09-11 correction: this row previously read "Real registered
Providers exist today," implying a live `SettlementScope` registry.
No such registry is implemented — §12 item 1 is the first step that
would create one. The sentence above corrects this to describe current
code reality without implying the registry exists.)*

## 5A. Successor Decision — Day-0 Commitment of 14 Native P2P Combinations (2026-11-01)

**Status:** recorded from the Product Owner + CTO decision of 2026-11-01
(relayed by the EPM). Documentation only: no code, registry, test, schema,
SDK, PR, gate, acceptance criterion, deploy or homologation status
changes with this section. Divergences D1–D4 found while reconciling were
decided by the CTO the same day (Issue #105, issuecomment-6561714306);
the decisions are recorded at the end of this section.

**Successor to §5, not a deletion of it.** §5 remains the historical
record of the 2026-09-10 Product Direction Freeze (`docs/BACKLOG.md`
item 20). From 2026-11-01 the Day-0 **commitment** is the following
set, as a whole — not an "initial wave" of the 25 rows in §5:

| Asset | Rails | Count |
|---|---|---|
| **BTC** | `BITCOIN_L1`, `LIQUID` | 2 |
| **USDT** | `ETHEREUM`, `POLYGON`, `BASE`, `ARBITRUM`, `TON`, `TRON`, `SOLANA` | 7 |
| **USDC** | `ETHEREUM`, `POLYGON`, `BASE`, `ARBITRUM`, `SOLANA` | 5 |

**14 total rows.**

**Left the Day-0 commitment (12 rows of §5, kept here for traceability —
not erased):** `{BTC, LIGHTNING}`, `{BTC, SPARK}`, `{BTC, ARKADE}`,
`{DEPIX, LIQUID}`, `{DEPIX, SPARK}`, `{USDT, OPTIMISM}`,
`{USDT, AVALANCHE}`, `{USDT, BNB_CHAIN}`, `{USDT, LIQUID}`,
`{USDC, OPTIMISM}`, `{USDC, AVALANCHE}`, `{XAUT, ETHEREUM}`. All twelve
are native P2P **roadmap, with no date commitment** (D4 below).

**Added by this decision (1 row not in §5):** `{USDC, SOLANA}`,
intentionally (D1 below). Arithmetic: 25 − 12 + 1 = 14, i.e. 13 retained
rows plus 1 new row.

**Binding directives carried by the decision:**

1. Sails Protocol stays fully non-custodial and permissionless.
2. Sails Market is the web reference implementation and has an
   independent commercial layer for swaps, direct purchase, routing and
   partner integrations.
3. Commercial swaps and direct purchase are **not** native P2P
   settlement providers.
4. Adapters and infrastructure are shared where possible, especially
   across the EVM networks, with **explicit network and provider
   selection preserved** (§2, §4: shared implementation ≠ shared
   maturity).
5. The 14 rows are the complete Day-0 commitment.
6. Cross-cutting requirements — security, recovery, external
   integration, multi-operator operation and evidence — are **not**
   reduced by this narrowing.
7. Membership in this table homologates nothing. Product Scope,
   Representability, Implementation, Evidence, Beta Eligibility and
   Production Eligibility remain the separate facts of §7.

**What does not change.** §4 (sparse, explicitly registered scopes) is
untouched: leaving the commitment does not remove a row from the
canonical `SettlementScope` registry. The registry in
`src/common/settlement-scope-registry.ts` still holds the 25 rows of §5
and `{USDC, SOLANA}` is not in it; aligning code and tests is a separate,
separately-authorized implementation mission (D2 below). Implementation
facts are unchanged:
`MULTISIG` → `{BTC, BITCOIN_L1}` and `WDK_USDT_EVM` → `{USDT, ETHEREUM}`
(testnet, server-custodial) are inside the commitment; `{USDT, TRON}`
stays schema-only and inside it; `LIGHTNING_HODL` → `{BTC, ARKADE}` keeps
its testnet evidence but its scope is outside the commitment. Mentions of
"the 25 rows" in §§7 and 12 below read historically.

**Decisions on the divergences found while reconciling (CTO, 2026-11-01,
Issue #105 issuecomment-6561714306):**

- **D1 — arithmetic.** The historical matrix has 25 rows; 12 leave the
  Day-0 commitment and `{USDC, SOLANA}` is added intentionally: 25 − 12 +
  1 = 14 (13 retained, 1 new). The earlier "11 withdrawn" wording is
  corrected by this record.
- **D2 — registry preserved.** The 12 entries stay in the registry and
  the tests that verify the 25-row catalog are not touched. Four facts are
  kept separate: the architectural catalog (25 rows), the Day-0
  commitment (14), the registered provider, and beta/production
  eligibility. `LIGHTNING_HODL` → `{BTC, ARKADE}` keeps its registration
  and existing proofs without being mandatory for Day 0. An explicit
  validation of the Day-0 commitment matrix will be created in a
  separately authorized implementation mission; this section changes no
  code or test.
- **D3 — successor decision.** The 2026-09-10 clause against scope
  reduction (`docs/BACKLOG.md` item 20) was valid for that freeze and is
  preserved as history. The 2026-11-01 decision succeeds it and revises
  its reach: **none of the 14 Day-0 combinations may be withdrawn silently
  — withdrawing one requires a new Product Owner + CTO approval, with
  justification and traceability.**
- **D4 — destination of the 12.** Native roadmap with no date commitment
  (all twelve rows listed above). Sails Market may offer routes, swaps and
  direct purchase through commercial partners; that is not native P2P
  support of the protocol. DePix may have commercial coverage through
  Sails Market provided approved partners exist.

**Effect on the Gate B decisions recorded on 2026-11-01 in Issue #105 and
the Project README.** Items incompatible with this section — "the 25
combinations are kept", `{BTC, ARKADE}` as a later wave, DePix as
mandatory native P2P — are superseded and stay as history. No Gate B
criterion is marked concluded, and nothing is homologated.

## 6. Capability, Property, and Eligibility — Four Layers, Never Collapsed


> **Permission Capability ≠ Settlement Capability ≠ Security Property ≠
> Production Eligibility**

- **Permission Capability** (`RFC-005`'s `CapabilityGrant`) — what an
  Identity/Agent is allowed to *do* (an authorization concept). Unrelated
  to settlement rails. Never reused as Provider Selection Policy (§8).
- **Settlement Capability** — a *structural*, self-declared execution
  feature of a Provider registration. This ADR freezes the distinction
  only, **not a final vocabulary** — illustrative, non-exhaustive
  examples: transfer, escrow, refund, split, requires-signature-collection,
  unilateral-recovery, invoice-payout, address-payout, on-chain-fallback.
  A future implementation mission may name the exact set actually
  needed; none is frozen here beyond these being the right *category* of
  fact.
- **Security/Evidence Property** — a claim (e.g. "beneficiary-bound
  destination proven," "retry-safe," "recovery proven") that may **only**
  exist because cited Evidence (a test, an audit, an operational
  incident record) demonstrated it. **A Provider may never self-declare
  a Security Property** — this is the same `OUTPUT ≠ EVIDENCE ≠ PROPERTY
  ≠ CLAIM` discipline already frozen in `ENGINEERING_GOVERNANCE.md` §10,
  applied here by name to this domain.
- **Production Eligibility** — **a governed decision informed by
  evidence plus operational/security/product constraints, never a
  computed function of evidence alone.** Explicitly rejected:
  `productionEligible = evidencePassed` as an automatic derivation.
  Evidence is necessary input to a Production Eligibility decision; it
  is never sufficient by itself, and no mechanism in this ADR treats it
  as sufficient.

## 7. Maturity — Separable Facts, Not One Ordered Enum

The following remain **independently trackable facts/decisions**, never
collapsed into a single mutable field or a strictly linear progression:

- Product Scope (§5)
- Representability (does the architecture in this ADR express it — true
  by construction for every registered `SettlementScope` row)
- Implementation (does a real Adapter/Provider exist)
- Evidence (what has been directly demonstrated, and for what — §6)
- Beta Eligibility
- Production Eligibility (§6 — a governed decision, not a derivation)

**A regression in Evidence must never imply Implementation
disappeared.** (Precedent already real in this codebase:
`multisig-funding-reorg-sweep.ts` detects exactly this class of
regression — evidence invalidated by a reorg, code unchanged.)
**Absence of Implementation must never imply absence from Product
Scope** (§4/§5 — most of the 25 rows have zero implementation today and
remain fully in scope).

## 8. Provider Selection Is Not Permission Policy

> **Permission Policy ≠ Provider Selection Policy**

`RFC-005`'s `CapabilityGrant`/`CapabilityRegistry` governs what an actor
is *permitted to do* — it is explicitly **not** reused, by this ADR, as
the mechanism for constraining *which Provider* serves a request. An
agent or wallet may express `Asset=USDT, Rail=BASE` without naming or
knowing a Provider; Provider pinning/restriction may exist later as an
**explicit, separate policy layer**, but only if a future ADR
demonstrates Permission Policy and Provider Selection Policy are
genuinely the same concept — not assumed here. Provider selection,
however it is eventually implemented, must never itself confer Economic
Disposition Authority, Destination Authority (`docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`
— F1, already closed), or Agent Authority.

## 9. Interoperability Is Relationship Metadata, Never Identity

A rail satisfying another rail's payment path (e.g. Spark satisfying a
Lightning-compatible invoice path) is recorded as relationship metadata
between two independently-identified `SettlementRail` values — it never
changes either rail's own identity. `SettlementRail = SPARK` remains
`SPARK` regardless of what it can interoperate with. This restates,
applied to this specific architecture, the governing rule already
frozen in `docs/PRODUCT_TRUTH_SWEEP_2026-09-10.md` and `docs/BACKLOG.md`
item 20: protocol/network family ≠ implementation/client ≠ settlement
capability/provider ≠ interoperability path.

## 10. Specification Conflict — `PROTOCOL_SPECIFICATION.md` §4B

`docs/PROTOCOL_SPECIFICATION.md:1241-1243` reads:

```typescript
interface SettlementAdapter extends SettlementProvider {
  chain: 'bitcoin' | 'liquid' | 'lightning' | 'evm' | 'solana' | 'ton' | string
}
```

This IS-A relationship (Adapter extends Provider) does not match §2's
now-frozen composition relationship (Provider *uses* an Adapter). **Not
rewritten by this ADR** — per this repository's own never-silently-edit
discipline, `docs/PROTOCOL_SPECIFICATION.md` receives a dated
clarification note directly beside the original text (added in this
same PR, original preserved verbatim), stating: this section's IS-A
wording is superseded in spirit by ADR-002's composition relationship;
the `chain`-qualification concept survives, relocated conceptually onto
the Adapter (or the `SettlementScope` key) rather than onto Provider
itself; **current runtime co-location of Adapter and Provider in one
class remains fully allowed** and is not what this note corrects. No
implementation follows from this note.

## 11. Legacy Identifier Treatment (recorded, not implemented)

**High-confidence translation candidates** (recorded for a future,
separately-authorized migration mission — no translation code is
authorized here):

| Legacy `AssetType` | `{asset, rail}` |
|---|---|
| `BTC` | `{BTC, BITCOIN_L1}` |
| `USDT_ERC20` | `{USDT, ETHEREUM}` |
| `USDT_TRC20` | `{USDT, TRON}` |
| `USDT_LIQUID` | `{USDT, LIQUID}` |
| `LIQUID_BTC` | `{BTC, LIQUID}` |

**Ambiguous — no automatic mapping authorized:**

- **`LN_BTC`** — its name implies Lightning; its one real, testnet-evidenced
  implementation (`LIGHTNING_HODL`) is Arkade-backed (already corrected
  in prose by the 2026-09-10 Product Truth Sweep; never corrected in the
  type itself). Under this architecture, `{BTC, LIGHTNING}` and
  `{BTC, ARKADE}` are **separate, independently-registered scopes** —
  the current Arkade implementation belongs to `{BTC, ARKADE}`.
  `LN_BTC`'s own historical meaning is not rewritten by this ADR; a
  future migration mission must make an explicit Product/Architecture
  Decision about how (or whether) the legacy value maps to either scope,
  never a silent default.
- **`STACKS`, `RSK_BTC`** — legacy identifiers that fall **outside** the
  currently frozen Day-0 scope (§5). No automatic mapping is authorized.
  A future Product Decision is required (plausibly, but not decided
  here, analogous to RGB's own settled Roadmap/Future status) before any
  migration or deprecation of these values.

## 12. Suggested Sequencing (not authorized by this ADR)

1. A future, separately-authorized mission builds the `SettlementScope`/
   Provider registry **additively** — zero changes to `AssetType`,
   `EscrowType`, or `prisma/schema.prisma`.
2. QVAC's schema is wired to derive its asset/rail enum from the new
   registry instead of hand-duplicating `AssetType`. Wiring QVAC to the
   authoritative asset/rail source is the **expected implementation
   path** to resolve `BACKLOG.md` 20.5; **20.5 closes only after
   implementation and evidence confirm contract drift is eliminated** —
   this step alone does not close it.
3. The Reference UI's Day-0 scope display is wired to the new registry.
   Wiring the Reference UI to `SettlementScope` **removes the
   scope-visibility/product-truth defect and is a prerequisite/input**
   to `BACKLOG.md` 20.2, but **does not itself close** Day-0 capability
   integration coverage. **20.2 remains OPEN** until the required
   journeys/capabilities are actually implemented and evidenced to
   their claimed maturity.
4. Legacy enum deprecation is explicitly **out of scope** for any near
   mission — a separate, later, CTO-authorized step, contingent on the
   `LN_BTC`/`STACKS`/`RSK_BTC` Product Decisions above.

**Implementation status (2026-09-12, ARCH-IMPL-1, boundary-corrected
ARCH-IMPL-1-R1): IMPLEMENTATION FOUNDATION STARTED.** Item 1 above has
a first, additive, bounded implementation: `Asset`/`SettlementRail`/
`SettlementScope` types (`src/common/types/settlement-scope.ts`), the
canonical 25-row registry with a pure query API
(`src/common/settlement-scope-registry.ts`), and the §11
legacy-translation subset in its own file
(`src/common/settlement-scope-legacy.ts`) — split out so the canonical
registry has no dependency on the legacy `AssetType`, and deliberately
placed in `src/common/`, not `src/core/`, since `src/core/README.md`
reserves that folder for formal Core components and this foundation is
Product/Domain representation infrastructure, not a Core primitive
(§13). Tested in `tests/settlementScopeRegistry.test.ts`, including a
static dependency-boundary guard. **No ProviderRegistration exists
yet** — items 2-4 above remain future, separately-authorized missions,
and this status note does not close `BACKLOG.md` 20.2 or 20.5 (see
that item's own 2026-09-12 ARCH-IMPL-1 status update).

**Implementation status (2026-09-12, ARCH-IMPL-2): the "No
ProviderRegistration exists yet" sentence above is no longer current —
preserved verbatim, corrected here, not silently rewritten.** A first
`SettlementProviderRegistration` layer now exists
(`src/common/settlement-provider-registry.ts`), additive over the
`SettlementScope` registry — a provider registration can never create
Product Scope (enforced by a module-load-time invariant checked against
`isSettlementScopeRegistered`, not just left as convention). Registered,
each verified directly against its provider file: `MULTISIG` →
`{BTC,BITCOIN_L1}`, `LIGHTNING_HODL` → `{BTC,ARKADE}`, `WDK_USDT_EVM` →
`{USDT,ETHEREUM}`. Deliberately not registered: `MOCK` (test
infrastructure — `getCustodyModelForType()` already returns `null` for
it by design), `SAFE_GUARD_EVM` (real code, but its `lockFunds()`
performs a native-EVM-currency balance check, not an ERC-20 USDT/USDC
transfer — no canonical Day-0 `Asset` corresponds to native EVM
currency, so registering it against any existing scope would be
factually wrong; a genuine open question for a future Product/
Architecture Decision, not guessed here), and `LIQUID_COVENANT` (an
`EscrowType` value with zero implementation — no entry in
`escrow-providers.ts`'s `PROVIDERS` map, no provider file). Items 2-4
above (QVAC/Reference UI wiring, legacy deprecation) remain future,
separately-authorized missions; this status note still does not close
`BACKLOG.md` 20.2 or 20.5.

*(2026-09-11 correction: items 2 and 3 previously implied that wiring
QVAC or the Reference UI to the new registry would itself "close"
20.5/20.2. Corrected per CTO review — ARCH-FREEZE-R1 — to state that
wiring is a necessary but not sufficient step; both items close only
once implementation is complete and evidenced against their originally
claimed maturity, consistent with §6/§7's evidence-never-automatic
discipline applied to Backlog closure itself.)*

## 13. Non-Goals of This ADR

Does not: change `docs/SEMANTIC_KERNEL.md` or add a fourth Kernel
property (§14, Product Decision, confirms this explicitly); change any
Core primitive; authorize any code, schema, or documentation edit beyond
this ADR, its companion Product Decision section, and the dated
clarification/cross-link notes named in §10 and the accompanying report;
decide the final Settlement Capability vocabulary (§6); decide the
`LN_BTC`/`STACKS`/`RSK_BTC` legacy disposition (§11); decide whether
Provider Selection Policy and Permission Policy are ever unified (§8).
