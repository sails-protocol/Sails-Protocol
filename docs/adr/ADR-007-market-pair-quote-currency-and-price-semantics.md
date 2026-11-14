# ADR-007 — Market Pair, Quote Currency and Price Semantics

- **Status:** Proposed for CTO Gate (records a founder/CTO scope decision; a Draft documentation PR was authorized by CTO 30; this is not an adoption and does not homologate criterion B7)
- **Date:** 2026-11-14 (date of registration; earlier records are not altered)
- **Owner:** criterion B7 of Issue #105 / `docs/BACKLOG.md` item 21
- **Related:** Issue #105 (B7, C8, E21, E22, F28, item 41), Issue #623 (Price Reference Feed, MF-05, with CTO 30 and CTO 32 decisions), ADR-001 §3, ADR-002 §5A and §5B, RFC-009
- **Baseline:** `main@b8068020aaae9cf269279ea172a04e4f27934ebc`
- **Numbering note:** ADR-006 is reserved by open PR #529; renumber at merge if that changes.
- **Identifier note:** "B7" always means the criterion of Issue #105, not item B7 of `AUTHORITY_MODEL_DISCOVERY.md` §16. MF-01 to MF-07 (with MF-05a, MF-05b and MF-05c) are names of the Multi-Fiat plan; they do not rename earlier GitHub missions (for example M5, M7 and M8.6 in code comments, or M9-R).

## Context

The Beta must be commercially competitive, with no artificial restriction to one quote currency. Today:

- `Offer.priceUsd` is required and is the only canonical stored quote; `Offer.priceBrl` is optional, unvalidated and not signed (`prisma/schema.prisma`, `liquidity.routes.ts:52-53`).
- The signed `OfferEnvelope` v1 carries `priceUsd` and no rail, quote currency or `priceBrl` (domain tag `sails-offer-envelope-v1`, `offer-envelope.ts:57,342-359`).
- `TradeIntentPayload.currency` accepts eight codes but is a declarative label: no matching, pricing or commitment reads it.
- No operation changes the price of an existing offer (routes: create and `PATCH .../status` only).
- No price or FX source exists; the Reference UI derives `priceUsd` from an illustrative table, and the original currency is not stored.
- `toOfferSchema` infers BRL from the presence of `priceBrl`; the exported helper and its test lock that behavior.

## Decision

**D1 — Multi-fiat from the Beta.** The Beta quotes in more than one fiat currency. The earlier USD-only orientation is not adopted.

**D2 — Explicit market pair.** Every offer, signed envelope v2, trade and discovery row carries a pair `{ base, quote }`.
- `base` = `(asset, rail)` as defined by ADR-002. Where `AssetType` already encodes the rail, the explicit rail is still required and must agree.
- `quote` = a closed tagged value. Only `FIAT:<ISO 4217 code>` is accepted; `ASSET:<asset>@<rail>` is reserved (D14).
- Canonical pair identifier: `BASE@RAIL/QUOTE`, for example `BTC@BITCOIN_L1/FIAT:BRL`.

**D3 — Units are always explicit.** No monetary value travels without its unit, in any API field, event, signed object or UI. Nothing is inferred from locale, geography, payment method, display currency or node.

**D4 — Exact arithmetic.**
- `price` is the amount of quote currency per one base unit: a decimal string with exactly 8 fractional digits (the canonical form of `priceUsd` today).
- `quoteTotal = price x baseAmount`, computed with exact decimals and rounded to the minor unit of the quote currency (0, 2 or 3 fractional digits per ISO 4217).
- `quoteTotal` is the exact fiat amount owed outside the protocol and is immutable once the trade is accepted.
- The rounding mode and the acceptance time-to-live are open decision O1.

**D5 — Five distinct concepts, never collapsed.**

| Concept | Meaning | Binding? | Where it lives |
|---|---|---|---|
| Quote currency | Unit of `price` and `quoteTotal` | Yes | pair, price, total |
| Settlement asset | The asset the escrow locks and releases | Yes | pair base, `lockedAmount` |
| Payment method | The fiat channel used outside the protocol | Yes | `paymentMethod` |
| Display currency | How a client renders values to a user | No | client or session only |
| Risk valuation currency | Internal unit of limits and exposure, if any | No; never a quote | operator policy |

`TradeIntentPayload.currency` remains a declarative label. It is never reinterpreted as a quote; Intent price bounds are expressed in new explicit fields (quote currency, minimum and maximum price) and the USD aliases `maxPriceUsd`/`minPriceUsd` keep their meaning.

**D6 — Binding price and reference price are different things.**
- The **binding price** is the price the advertiser defines and signs (`FIXED`), in the quote currency of the pair. It is the only price that can bind a trade. It is frozen, together with `quoteTotal`, at trade-open (E21), with no external repricing.
- The **reference price** is an informational observation from an external source: a rate with `asOf`, source identity, method and quality status. It is never executable, never binds, never gates any operation, and never rewrites an Offer or a Trade.
- The **comparative spread** is informational: `(advertised price / reference price - 1) x 100`, computed with exact decimals over the same pair and unit, contextualized by BUY or SELL, and kept apart from the protocol fee.
- A stale, unavailable or uncovered reference must not look executable. Reference and spread are hidden, with a warning.
- **Unavailability of external sources never blocks a valid `FIXED` offer.** Publishing, revising, discovering and accepting a valid `FIXED` offer work with every source unreachable. A source outage is never a suspension trigger and never changes any state in D10.

| Attribute | Binding price | Reference price |
|---|---|---|
| Author | The advertiser | An external source |
| Signed | Yes (envelope revision) | No |
| Binds a trade | Yes, frozen at trade-open | Never |
| Can block an operation | Not applicable | Never |
| Failure behavior | Not applicable | Hidden with a warning |

**D7 — Signed price revision is a Beta requirement.** The owner signs a new envelope revision for the same `logicalOfferId` and the same pair (new price, limits or expiry). The operation is atomic, monotonic in `revision` and rate-limited (O2). **The pair is immutable per `logicalOfferId`** (ratified by the CTO); changing it requires a new offer. An accept against a superseded revision is refused with a price-changed conflict. The accept request carries the offer revision, the pair and the expected price.

**D8 — `FIXED` is the initial mode; `REFERENCE_PREMIUM` is specified and not activated.**
- `FIXED`: the signed price is the price.
- `REFERENCE_PREMIUM`: `price = clamp(reference x (1 + premiumBps/10000), floorPrice, ceilingPrice)`, rounded to the price scale. The signed envelope carries the mode, a named reference policy, `premiumBps` (signed), floor, ceiling, maximum reference age and maximum slippage. The binding price is still derived from advertiser-signed parameters; the reference supplies only an input snapshot.
- Acceptance under `REFERENCE_PREMIUM`: the taker computes the price from a reference snapshot and sends offer hash, revision, snapshot and expected total. The counterparty validates bounds, snapshot age and slippage, and otherwise answers with a reprice-required conflict and its own snapshot.
- In both modes the accepted `price` and `quoteTotal` are frozen at trade-open (E21), with the snapshot when one was used, and are never repriced.
- **No automatic activation.** Envelope v2 rejects any mode other than `FIXED`, fail-closed, until a recorded decision allows `REFERENCE_PREMIUM` for a specific pair. Activation requires a named reference series, a minimum number of independent sources (O6) and recorded evidence. Pairs without a reliable single reference (for example currencies with parallel exchange rates) stay `FIXED`. The price reference feed (D9, Issue #623) does not activate it.

**D9 — Pluggable reference price sources, operator-configured, no mandatory vendor.**
- The interface is `ReferencePriceProvider`, per pair `base(asset + rail) / quote`. A source returns a rate with `asOf`, `validUntil`, source identity, method, class (`MARKET` or `OFFICIAL`) and quality status. Independent sources are preferred when available; two reads of one source are not independent.
- **The model is decentralized (F1, approved).** Each operator configures its own providers and credentials. The project ships no shared credential and runs no central feed.
- **Total source failure cannot affect `FIXED` offers (approved).** If every configured source fails, or none is configured, the feed reports the reference as unavailable and every valid `FIXED` publication, revision, discovery, acceptance and replay behaves exactly as with a healthy feed. The request path reads a cache only and never calls an external source.
- Allowed uses: non-binding display, comparative spread, advisory warnings, optional `REFERENCE_PREMIUM`, optional risk valuation. Forbidden uses: gating publication, revision, discovery, acceptance or settlement of a `FIXED` offer. Any binding use needs a recorded snapshot and fails closed when sources are stale, divergent or unavailable.
- **No provider is selected by this ADR, commercial or not.** Selection happens only after license, coverage, rate limits, methodology and freshness are verified (F5). Issue #623 names candidates for evaluation: CoinGecko and other independent crypto sources, and official FX sources such as the Banco Central do Brasil and the Banco Central del Paraguay.
- **Provider data permissions are explicit, evidenced and default to `UNVERIFIED`.** The operator's configuration records, for each provider, a permission policy by audience and by purpose. Audiences: the operator's own authenticated clients; other authenticated clients; unauthenticated clients; other developers or systems that consume the data through an API. Purposes: internal use; display to end users; caching or storage; re-serving through an API; derived data such as the comparative spread. Each combination has a state, `PERMITTED`, `PROHIBITED` or `UNVERIFIED`, and `PERMITTED` or `PROHIBITED` requires its documentary evidence: the document and its version or date, the clause, and who reviewed it and when. **`UNVERIFIED` means the absence of authorization, not a neutral state:** any combination without a recorded policy, and any provider without one, is `UNVERIFIED`. **Authenticating a client does not by itself permit anything:** an authenticated audience is a distinct audience, and serving, caching or re-serving provider data to it requires its own `PERMITTED` state.
- **No route exposes provider data without a verified permission for that use.** No read route, public or authenticated, and no SDK or UI that depends on one, may serve, cache or re-serve the data of a provider, or data derived from it, for an audience and purpose whose state is not `PERMITTED`; `UNVERIFIED` has the same effect as `PROHIBITED`. In that case the feed reports the reference as unavailable for that audience, and every valid `FIXED` operation is unaffected. This rule applies to whichever access model F6 may eventually adopt.
- An official reference that is stale must not be shown as an executable price.
- Availability is tracked per provider and pair; payment-method granularity is used only where the method economically or technically changes the applicable reference (F4 conditional). A source outage never suspends a currency, automatically or otherwise.
- The feed is MF-05 of the Multi-Fiat plan (Issue #623, linked to Project #3, Priority P2 ratified by CTO 30; the issue title is now "[B7 / MF-05]"; its body retains the historical alias "B7 / M5"). PR #422 (old stack) is a historical design reference, not code authorized for cherry-pick.

**D10 — Enablement registry and states, per currency, per pair and per payment method.**
- States: `PLANNED`, `REGISTERED`, `STAGING`, `ENABLED`, `SUSPENDED`.
- Three scopes carry a state: the currency, the pair, and the (payment method, quote currency) combination. Base-asset eligibility (ADR-002 §5B, B4) is a separate, additional condition.
- An operation (publish, revise, accept) is permitted only if all applicable scopes are `ENABLED` (or `STAGING` in a non-production deployment). An absent entry is `PLANNED` and is refused. The effective state is the most restrictive of the scopes.
- Every transition is recorded durably with actor, date and evidence reference. `ENABLED` requires a CTO decision and Gatekeeper evidence against the activation checklist in `docs/BACKLOG.md` item 21, and is an economic activation requiring its own authorization. Nothing is `ENABLED` by default or by a configuration default; listing a currency in the registry does not enable it.
- **Operational suspension (ordinary).**
  - Purpose: a payment-rail or operational incident, such as a rail outage or a loss of arbitration capacity.
  - Set by the designated operator, at the narrowest affected scope: a pair or a (payment method, quote currency) combination. It is never set automatically at currency level, and a reference price source outage is never a trigger.
  - Effect: refuses new offers, revisions and accepts under the scope. Existing offers stay visible, marked suspended and not acceptable; their owners may cancel them. Trades already accepted continue to settle.
  - Recorded with reason, start time and expected review time. Lifted by the operator when the condition clears, with a record.
- **Emergency suspension (separate).**
  - Purpose: a security, integrity, legal or economic-safety incident.
  - Set immediately by the CTO or by an authority the CTO designated in writing. It may apply at any scope, including a whole currency, a base asset and rail, or all scopes.
  - Effect: everything in the operational suspension, and in addition the offers under the scope are removed from discovery and not served to any client, and any acceptance not yet committed is refused. Owners may still cancel.
  - Trades already accepted are not altered by this ADR; their settlement stays governed by escrow, dispute and settlement authority, which this ADR does not change.
  - It supersedes any operational state beneath it. An operational suspension may be raised to an emergency one by the CTO or the designated authority. **An emergency suspension is lifted only by a CTO decision, with recorded evidence and an incident record** (cause, scope, actor, time, evidence); the operator cannot lift it.
- Neither suspension alters the snapshot of any accepted trade.

**D11 — Planned scope; planned is not proven.**
- **T1 (planned): BRL, USD, PYG.**
- **T2 (planned expansion): EUR, GBP, ARS, MXN, COP, PEN, CLP, UYU.**
- **T3 (planned expansion, observation): VES, BOB, NGN, INR, EGP.**
- No tier claims readiness. Today no currency has proven end-to-end multi-fiat capability: USD is the historical quote of every trade; BRL has partial support (`priceBrl`, PIX and TED in the method enum, a UI flow); the others exist only as labels. Readiness is claimed per scope, only after D10 activation evidence.

**D12 — Legacy offers: classification without presumed migration.**
- No existing offer is assumed to be a commercial USD quote because it has `priceUsd`, or a BRL quote because it has `priceBrl`.
- Each offer is classified by recorded evidence, read-only:

| Class | Evidence | Action |
|---|---|---|
| L-A | `priceBrl` present; `priceUsd` matches `priceBrl / 5.05` (the UI's illustrative factor); method PIX, TED or bank transfer | Candidate BRL quote; owner confirmation |
| L-B | `priceBrl` present; no such match | Owner attestation; otherwise not migrated |
| L-C | `priceBrl` absent; method PIX or TED | Owner attestation |
| L-D | `priceBrl` absent; other methods (USD-native and UI-converted offers are indistinguishable by data) | Owner attestation |
| L-E | Offer with trades | History is never rewritten; no retroactive quote |
| L-F | Terminal offer (cancelled, completed, expired) | Kept as history |
| L-G | Test, seed or development data | Operator decision |

- Attestation is the owner republishing with an explicit pair. New columns on `Offer` are nullable, with no default. Legacy trades keep their legacy fields; no `quoteTotal` is back-filled.
- Signed v1 envelopes are the exception: the signed field is named `priceUsd`, so they are USD-quoted by construction.
- The inventory that counts offers per class is read-only, runs per environment under explicit authorization, and precedes any migration design. The time limit for unconfirmed offers is open decision O7.

**D13 — Compatibility.**
- The verifier keeps accepting `sails-offer-envelope-v1` and interprets it as base `(asset, rail unspecified)`, quote `FIAT:USD`, mode `FIXED`. Nothing is re-signed. Envelope v2 uses its own domain tag `sails-offer-envelope-v2` and its own canonical form, so a signature never validates across versions.
- A write-once envelope table (C9) receives only additive columns with constant defaults, never an `UPDATE`.
- SDK and API changes are additive. No existing field changes meaning. A client that does not declare multi-quote capability keeps receiving the legacy view; it never receives a pair it cannot interpret (O4).
- Removing legacy fields is a separate decision, outside this ADR.

**D14 — Extensibility to stablecoin pairs, outside B7.** The tagged quote reserves `ASSET:<asset>@<rail>`; it is rejected in the Beta. A stablecoin as base, priced in fiat, is in scope (it is already a base in ADR-002 §5B). A stablecoin as quote needs two-leg settlement and its own RFC. A stablecoin is never aliased to its fiat unit.

**D15 — Criteria stay separate.**

| Criterion | Scope |
|---|---|
| B7 | The scope decision recorded by this ADR, `docs/BACKLOG.md` item 21, the Project README and Issue #105 |
| C8 | Envelope v2 (pair, price, mode), v1 verification, integration with C9 persistence |
| Item 41 | Canonical quote-currency semantics and the Multi-Fiat Quote-Currency Disambiguation Test (mandatory for each enabled scope) |
| E21 | Trade-open anchor: envelope hash and revision, pair, price, `quoteTotal`, rounding rule, payment method, snapshot |
| E22 | Payment-destination commitment bound to quote currency and payment method |
| F28 | Replay or duplicate trade-open does not double-commit; replay with a different price or pair is refused |
| Signed price revision (D7) | Beta requirement, delivered through MF-02 and MF-03, bound at trade-open by MF-04 |
| Price reference feed (MF-05, #623) | Informational; not a Day-0 criterion; never part of acceptance or replay |
| Per-scope activation (D10) | Not a Day-0 criterion; governed by its own checklist and authorization |

**D16 — Dependencies that must not block each other.**
- The M9-R chain (dispute dispatch recovery, execution gates, funding binding) touches escrow, dispute and settlement code only. It does not block this ADR, the legacy inventory, MF-01, MF-05 design or the price-revision design. Shared constraints are ordering of database migrations and one heavy test run at a time.
- Lote 1b (transactional trade admission) does not depend on this ADR and this ADR does not depend on it. Lote 1b may proceed on the existing fields. MF-02 and MF-03 proceed in parallel and join Lote 1b only at the trade-open anchor (MF-04, E21 and F28), which needs both.
- The hard technical dependency of MF-05 is the MF-01 contract. Provider design may start earlier, but its implementation must not block the M9-R chain or Lote 1b.
- Migration order follows timestamps, never a prerequisite between lots.

**D17 — Delivery planning references (MF-01 to MF-07).**

| Id | Scope | Depends on |
|---|---|---|
| MF-01 | Monetary base and decimals: registry of currencies and pairs, exact decimal arithmetic (coordinate with PR #557) | Decisions of this ADR |
| MF-02 | Offer and Trade model: nullable pair columns, legacy classification, pair-aware discovery with capability declaration, price-revision operation (API side) | MF-01; the legacy inventory |
| MF-03 | Envelope v2: domain tag, pair, price, mode; v1 verification; C9 integration; price revision as signed revisions | MF-02 |
| MF-04 | Trade-open anchor (E21, F28): pair, price, `quoteTotal`, rounding rule, payment method, snapshot | Lote 1b and MF-03 |
| MF-05a | Price Reference Feed, foundation: `ReferencePriceProvider` interface, operator-configured provider registry, fake provider, aggregator, cache and health records, with no network access | MF-01 contract (hard); provider design may start earlier |
| MF-05b | Price Reference Feed, real connectors. **Gated by F5**: no connector is built for a provider before its license, coverage, rate limits, methodology and freshness are verified and the legal review is done. PYG is gated by F7. | MF-05a; F5; F7 for PYG |
| MF-05c | Price Reference Feed, read route and SDK methods; capability-gated (O4); access model pending F6 | MF-05a; F6 decision; verified provider permissions (D9) |
| MF-06 | SDK and Reference UI: pair and price fields; display of reference, source, time and comparative spread; never an illustrative value as real; reference and spread hidden with a warning when stale, unavailable or uncovered | MF-02 and MF-03 for fields; MF-05c for the feed |
| MF-07 | Tests per pair and currency, Gatekeeper audit of the evidence, per-scope activation checklist | MF-01 to MF-06 |

- MF-05 does not rewrite Offer or Trade, does not impose a price and does not activate `REFERENCE_PREMIUM`. The binding price stays signed and is frozen at trade-open; the feed never affects acceptance or replay.
- Acceptance for MF-05 and MF-06 (per Issue #623): tests for pair and currency, precision (PYG 0 fractional digits; BRL and USD 2 digits for the total), staleness, divergent sources, timeout, rate limit, cache and fallback; SDK and UI tests for provenance, unavailability and spread; documentation of the sources actually integrated, with CI and Gatekeeper evidence. **A test with every provider unreachable, and one with no provider configured, must show that valid `FIXED` offers still publish, revise, display, accept and replay.**
- The Multi-Fiat plan names are not GitHub missions; earlier names such as M5 and M7 keep their original meaning.

**D18 — Price Reference Feed decisions F1–F7 and their status.**
Legend: **Approved** = recorded as a decision of the approved design. **Conditional** = approved subject to the stated gate. **Pending evidence** = a value, hypothesis or decision to be validated before any reliance.

| F | Decision | Status | Gate or evidence |
|---|---|---|---|
| F1 | Decentralized model: each operator configures its own providers and credentials; no central feed, no shared credential | **Approved** | None |
| F2 | Maximum reference age is set per class (`MARKET`, `OFFICIAL`); an older reference is hidden | **Approved** as a rule; limits **pending evidence** | Calibrate against real provider cadence and latency (MF-05b, MF-07); candidate values are hypotheses recorded outside this ADR and no default is active |
| F3 | On divergence beyond the limit, hide the spread and warn; per-source values only in a detail view | **Approved as behavior; conditional display** | The per-source detail view depends on the F5 license outcome; the divergence limit is pending evidence; candidate thresholds are hypotheses recorded outside this ADR and no default is active |
| F4 | Availability tracked per provider and pair; payment method adds a dimension only with economic or technical justification; never suspends a currency | **Conditional** | Document why a payment method changes the applicable reference at the MF-05a design review |
| F5 | No provider is selected before license, coverage, limits, methodology and freshness are verified; legal review of the terms precedes MF-05b | **Mandatory gate** (not provider approval) | Documented verification per candidate; legal review; no provider selected by this ADR |
| F6 | Access model of the read route (public, authenticated or hybrid) | **Open decision; pending evidence** | No access model is chosen or presumed. It requires an abuse and rate-limit assessment (the route is cache-only by design) and, for every audience it would serve, the verified provider permissions required by D9 |
| F7 | The official PYG reference is a hypothesis to validate | **Pending evidence** | See below |

**F7 — validation criteria for the PYG official reference.** F7 stays open. Until every criterion below is met, PYG has no operational reference coverage: the hypothesis is not claimed as available, and `FIXED` offers are unaffected.
1. Observed (2026-11-14, from the official pages): the Banco Central del Paraguay publishes a daily reference sheet for 26 currencies against the guaraní, an interbank reference series for USD (window 08:30 to 13:00 of the business day) and a client-market series for USD. Pending: which international information services feed the currencies computed by arbitrage, and the publication time of each final value.
2. Pending: the BCP pages offer HTML and a PDF only; no API, spreadsheet or open-data listing was found. A third-party mirror reproduced the sheet value on a verified date, but it is not the official source and its own terms for the BCP data are unpublished.
3. Observed through a third-party mirror, not verified day by day against the official history: no value on non-business days, no carry-forward, and a longest gap of 5 calendar days in 2026, with two weekday gaps unexplained. Pending: the official holiday calendar and publication time.
4. Pending: no terms of use or license were found; the absence of a finding at the site is not evidence that none exist.
5. Hypothesis to validate: a BTC/PYG reference would combine a `MARKET` BTC/USD leg with the `OFFICIAL` daily USD/PYG leg, labeled with the date of the official value. No direct PYG source was identified. This is not a rule.
6. Tests for the above under MF-05a and MF-07.

## Ratified and approved decisions

- **O3 — the pair is immutable per `logicalOfferId`** (ratified by the CTO; recorded in D7).
- **F1 — operator-configured providers, decentralized model** (CTO 32; D9 and D18).
- **Total source failure does not affect valid `FIXED` offers** (CTO 32; D6, D9 and D17).

## Decisions that remain open and require detail and evidence

| # | Decision | Detail still required | Evidence required to close |
|---|---|---|---|
| O1 | Rounding mode of `quoteTotal` and acceptance time-to-live | The rounding mode as a formal rule; the time-to-live and its behavior after expiry | Rounding vectors for 0, 2 and 3 fractional digits; property tests; the effect on payment amounts in the rails of T1 |
| O2 | Rate limit for price revisions | Limits per offer, per owner and per time window, with burst rules | A load test of write-once persistence and discovery under frequent revisions |
| O4 | Capability-declaration mechanism for multi-quote clients | The mechanism (header, parameter or client version), its default, and its sunset | Contract tests against legacy SDK versions and existing consumers |
| O6 | Minimum number of independent sources for `REFERENCE_PREMIUM` | The definition of independence (operator, host, methodology) and the number per pair | The coverage, license and methodology evaluation of #623; divergence tests |
| O7 | Time limit for unconfirmed legacy offers | The limit, the notification path, and the effect at expiry | The per-environment class inventory (D12) |

The status of the feed decisions F2 to F7 is in D18, as clarified by CTO 35. The emergency authority formerly listed as O5 is specified in D10; the designation is a written CTO act.

## Non-goals

This ADR does not: change code, schema or any public contract; enable any currency, pair, payment method or pricing mode; migrate any offer; select any price provider, commercial or not; decide stablecoin-quote settlement; assert operational readiness of any rail; or homologate criterion B7 or any other criterion. Per-jurisdiction compliance remains with the operator; the protocol only provides the enablement switch.
