# Product/UI Reality Return

**Status:** Live audit + source-code cross-reference, not implementation.
**Baseline:** `main@ff40c83e0e672d0b04506885808e5ef41a4665cc`. No frozen
architecture reopened — every finding below is checked against already-
frozen semantic/authority/identity/settlement/error/recovery/multi-
operator truth (Mission 3, Mission 4, PR #153, PR #154, PR #156), never
against a redesign.

**Method:** the real `packages/sails-ui` app was run against a real local
Postgres/Redis and the real Fastify backend (no mocks) — the same
"real over mocked, always disclosed when it isn't" discipline
`packages/sails-ui/PRODUCT.md` already commits this package to. Findings
below are evidenced by live screenshots, live console/network logs, and
direct source reads — not opinion.

## 1. Baseline Inspected

`git log -1 --format="%H %s" origin/main` → `ff40c83e0e672d0b04506885808e5ef41a4665cc`.
Local environment: `postgres:16-alpine` + `redis:7-alpine` (ephemeral,
removed after this audit), real `npm run dev` backend on `:3000`, real
`npm run dev -w @sails/ui` on `:5173`.

## 2. Current Product/UI Architecture Map

Per `packages/sails-ui/PRODUCT.md`/`DESIGN.md` (already-established
product context, not re-derived): nine screens — Marketplace, Offer
Detail, Trade, Login, Profile, Publish Offer (3-step wizard), Trade
History, Disputes (arbiter-scoped), plus a settings/theme surface.
Design system: black + burnt-orange (`#c2410c`), Space Grotesk display /
system-font body, full symmetric light/dark themes, semantic status
colors (green/red/yellow/blue/orange/violet) kept explicitly separate
from the brand accent — confirmed in `StatusBadges.tsx` and `DESIGN.md`
directly, already satisfying the brief's own "semantic colors separate
from brand color" requirement. Reference points cited in `DESIGN.md`:
Binance P2P/Airtm/El Dorado — not literally Zest, but the same
"trading-floor density, not consumer warmth" register the brief asks
for; no contradiction found.

## 3. Journey Audit

### Journey A — Browse First

**Live, confirmed working.** Anonymous load of `/` renders the full
Market screen — offer grid, asset/currency/payment filters, buy/sell
toggle, sort, seller search — with only a "Conectar" affordance in the
header, no forced gate. Tapping "Ativos" (My active trades) correctly
gates with a specific, honest reason: *"Conecte sua carteira para ver
seus trades ativos"* — not a generic block. `Browsing ≠ Authentication`
holds exactly as required.

### Journey B — Create Offer

**Mixed — one real, precise finding.** The offer wizard's own asset
picker (`PublishOffer.tsx`) already imports the *narrower*, real-backend-
values-only `ASSETS` list (`data/mock.ts`), not the wider `ASSETS_FILTERABLE`
list that includes purely UI-invented assets (ETH/BNB/SOL/WBTC/USDC
variants — confirmed these exist only as a disclosed, commented,
deliberate UI-only addition for filter/display contexts, and are
correctly excluded from the real submission path). `SPARK` is also
already correctly excluded, with its own comment citing a direct grep
confirming zero settlement-provider wiring. **This existing discipline
should be preserved, not reopened.**

**R1 correction (CTO Gate Corrective, 2026-09-14) — the finding below is
corrected, not withdrawn: real gap, wrong claimed strength.** The
original version of this finding said assets without a registered
provider "will fail" / "cannot settle at all," and named the fix a
"Settlement Maturity Signal." Re-read directly against
`src/common/execution-candidates.ts` and
`src/common/settlement-provider-registry.ts` (both written this same
session, Mission 4): `discoverExecutionCandidates()` computes
**structural registration / capability compatibility only** — it
explicitly does not evaluate permission, runtime availability, maturity/
evidence, risk policy, full settlement eligibility, or production
eligibility (that file's own header, and ADR-002 §6's frozen four-layer
distinction: Technical Capability ≠ Protocol Permission ≠ Economic
Authority ≠ Settlement Eligibility). Claiming a `SINGLE_STRUCTURALLY_COMPATIBLE_CANDIDATE`
result means "sellable now," or that Candidate Discovery alone provides
a "maturity signal," is the exact overclaim Mission 4 R1 already
corrected once at the architecture layer (renaming `...Eligible...` to
`...StructurallyCompatible...` throughout) — re-committed here at the
Product/UI layer. Corrected below, using only what is actually proven.

**The real, corrected gap:** among the 9 real, in-scope-enum assets
`PublishOffer` *does* offer — `BTC`, `LN_BTC` (labeled "Bitcoin
(Ark/Arkade)"), `LIQUID_BTC`, `RSK_BTC`, `STACKS`, `USDT_ERC20`,
`USDT_LIGHTNING`, `USDT_LIQUID`, `USDT_TRC20` — only **three** (`BTC`,
`LN_BTC`, `USDT_ERC20`) resolve to a `SINGLE_STRUCTURALLY_COMPATIBLE_CANDIDATE`
via `discoverExecutionCandidates()` today. `LIQUID_BTC`/`USDT_TRC20`/
`USDT_LIQUID` resolve to `SCOPE_REGISTERED_NO_PROVIDER`; `RSK_BTC`/
`STACKS` are not even canonical Day-0 `SettlementScope` per ADR-002 §11
(no legacy-to-scope mapping is authorized for either). **Corrected
statement of the gap:** *`PublishOffer` allows offer creation using
legacy asset/network values without checking whether the corresponding
current `SettlementScope` has any structurally registered settlement
implementation — the UI can publish an offer whose selected asset/
network representation has no currently registered structural
settlement path.* This is **not** the same claim as "can never settle" —
that would require evidence this document does not have (e.g. proof no
future provider registration or manual resolution path exists); the
proven fact is narrower and is stated at exactly its proven strength.
The picker presents all nine options with identical visual weight — no
signal distinguishes a structurally registered path from an
unregistered one, which is still a real Product Reality gap, just not
the stronger one originally claimed.

**Deeper architecture mismatch, classified explicitly, not silently
folded into the finding above:** `PublishOffer.tsx` operates entirely on
legacy `AssetType` values (`LN_BTC`, `LIQUID_BTC`, `USDT_ERC20`,
`USDT_TRC20`, etc.) and derives network via its own `NETWORK_BY_ASSET`
mapping — a representation that predates, and does not use, ADR-002's
frozen `Asset ≠ SettlementRail ≠ SettlementScope` decomposition at all.
This is **both** classification **B** (Engineering convenience promoted
to Product decision — the flat legacy enum was the only representation
available when this screen was built, and has not been revisited since
ADR-002 froze the real decomposition) **and** classification **C**
(Implementation truth mislabeled protocol/product truth — the picker's
own "Bitcoin (Liquid)"-style labels imply a settled, canonical asset+
rail model to the user, when the code underneath is still the
pre-ADR-002 flat enum, not `{Asset, SettlementRail}`). **Not redesigned
here** — named and classified only, per this correction's own
instruction not to automatically redesign the picker in this audit.

### Journey C — Take Offer / Trade

Not exercised live this pass (no seed offers existed to take — `0
ofertas disponíveis` throughout, confirmed genuine, not a defect: this
is a fresh database with no seed script run). Deferred to source-level
evidence: `Trade.tsx`'s own escrow-status rendering (§5 below) and
Mission 3's own frozen `PayoutAddress`/destination-authority work
already establish price/amount/counterparty/settlement fields are real
and Postgres-backed, not synthesized client-side. No live journey
evidence gathered — disclosed, not fabricated.

### Journey D — Settlement

Source-verified against `StatusBadges.tsx`'s real, exhaustive
(TypeScript-enforced) `EscrowStatus` mapping: `CREATED` → "Criado"
(Circle icon, neutral), `FUNDS_LOCKED` → "Fundos travados" (Lock icon,
blue), `PAYMENT_PENDING` → "Aguardando pagamento" (Clock icon, yellow),
`COMPLETED` → "Concluído" (CheckCircle2, green), `DISPUTED` → "Em
disputa" (AlertTriangle, red), `REFUNDED` → "Reembolsado" (RotateCcw,
neutral), `EXPIRED` → "Expirado" (XCircle, orange — a deliberate,
disclosed semantic reuse of the brand's own orange for an unrelated
"expiry" meaning, per that file's own comment), `SPLIT` → "Dividido
entre as partes" (Scissors, violet). Every state has a distinct color
*and* icon *and* text label — never color-only. **This is a real,
well-built domain state system and should be preserved.**

**What it does not yet do:** none of these states is `UNAVAILABLE` or
`INELIGIBLE` in the `CapabilityDenialReason` sense (§6 below) — those
never reach this badge system at all today, confirmed by direct search
(§6). "Unknown" (the idempotency-protected `WdkTransferAttempt`
`SUBMISSION_UNKNOWN` state) also has no distinct badge — a genuinely
ambiguous outcome would currently render through whichever generic
status the escrow was last confirmed at, not as its own state. This
does not invent a universal state machine (correctly avoided, per PR
#156's own R1 correction) — it is a disclosed, real gap in what this
already-good badge system covers.

### Journey E — Interrupted Journey

Source-verified against Mission 3's own frozen, tested mechanism
(`sessionEpochGate.ts`, `AuthContext.tsx`) — not re-derived. Live-
confirmed one real behavior this pass: a hard page reload drops the
in-memory session state entirely (`user`/`keypair` reset to `null`),
confirming the session truly is memory-only, not persisted — a real,
consistent architectural fact (the encrypted keypair *is* persisted in
`localStorage`, the *unlocked* session is not). This matches PR #156's
own frozen invariant precisely: a locally active authenticated context
is not proof of a currently-valid remote session, and here a full reload
doesn't even leave a locally active context behind — it requires
re-entering the passphrase, which decrypts the *same* stored keypair
(confirmed directly: `localStorage`'s `sails_ui_keypair_secret_hex`/
`sails_ui_kdf_salt` persist across reload; a wrong passphrase against
that stored ciphertext correctly produces "Senha incorreta," never a
silent wrong-identity login).

### Journey F — Capability / Eligibility Denial

**Real, confirmed gap, already disclosed by prior missions, not newly
discovered but newly evidenced with a precise UI-side check.** Direct
search of every `.tsx`/`.ts` file in `packages/sails-ui/src` for any
read of `.reason` (the `CapabilityDenialReason` field —
`UNSUPPORTED`/`UNAVAILABLE`/`FORBIDDEN`/`INELIGIBLE`/`DISABLED`/
`NOT_IMPLEMENTED`, real and shipped server/SDK-side since
CROSS-LAYER-SEMANTIC-CORRECTIVE-1) found **zero** matches — every real
`.reason` usage in the codebase is unrelated (dispute *reason text*,
local passphrase-decrypt-failure reasons). This means all six denial
reasons currently reach the user, if they reach them at all, through
whatever generic error-toast path exists — indistinguishable from each
other and from an unrelated network failure. This exact gap was already
named in `docs/BACKLOG.md` item 40's own text ("no existing UI code
reads `.reason` today") — this pass confirms it is still true on the
current baseline, not a regression, and not yet closed.

### Journey G — Dispute / Evidence

Source-checked `Disputes.tsx`: the screen is explicitly arbiter-scoped
(confirmed in Mission-era product context — "Disputes (arbiter-scoped,
not an admin console)," `PRODUCT.md`'s own operating-context line), and
renders a `dispute.reason` (the initiating party's stated reason) plus a
sheet detail view — a real, working screen, not a stub. Not exercised
live this pass (no seeded dispute existed). Deferred: whether evidence
submission UI copy anywhere implies automatic factual authority (RFC-021
D8's own auto-resolution path exists server-side per this session's
extensive prior audit trail) — not verified against live UI copy this
pass; flagged as unverified, not asserted clean.

## 4. Product Reality Findings

| # | Journey | USER INTENT | UI CLAIMS | PROTOCOL KNOWS | AUTHORITY | EVIDENCE | ACTION POSSIBLE | CAN GO WRONG | USER SHOULD UNDERSTAND | Class |
|---|---|---|---|---|---|---|---|---|---|---|
| PR-1 | B | List an asset I can actually sell | All 9 listed assets are equally selectable | Only 3 of 9 resolve to a `SINGLE_STRUCTURALLY_COMPATIBLE_CANDIDATE`; the rest are `SCOPE_REGISTERED_NO_PROVIDER` or outside Day-0 `SettlementScope` entirely (Mission 4's own Candidate Discovery — structural fact, not a maturity/eligibility claim) | None differentiated | None shown | Publish for any of the 9 | Offer goes live for an asset/network representation with no currently registered structural settlement path — the real, downstream consequence is not asserted beyond that structural fact | Which of these currently has a registered structural settlement path | B, C, E (R1: corrected from "will fail" to the proven structural fact only — see Journey B) |
| PR-2 | F | Understand why an action was denied | Whatever generic error text exists | A typed, 6-way reason (`CapabilityDenialReason`) | N/A | Reason exists, unused | None — no differentiated recovery guidance | User can't tell "try again later" from "this will never work" apart | Which denials are permanent vs. transient | A |
| PR-3 | Any | Not be permanently locked out by a typo | — | Passphrase is a local AES-256-GCM key with no recovery path | Full — losing it loses fund access permanently | Disclosed, but only inside a tooltip | User can dismiss the tooltip without reading it | User loses funds access with no recourse, having never seen the warning surfaced prominently | The passphrase is unrecoverable *before* they commit to one | A |
| PR-4 | Browse | See the market load reliably | Loading spinner, then results | The discovery fan-out (every asset × side) can exceed the backend's own rate limit under normal load | N/A | 267+ console errors, 1200+ requests observed in one session | Retries happen invisibly | A real user on a slower link could see a degraded/empty market with no explanation | (Engineering-facing, not user-facing per se) — **institutionally landed, see §12a: OPEN, not sequenced first, must not be lost** | B |

## 5. Authority-Collapse Findings

Checked against the required chain `View → Authenticate → Identify →
Connect wallet → Authorize → Sign → Execute → Recommend`:

- **Identify + Authenticate + Connect wallet are structurally one user
  action** ("Conectar Carteira") — verified this is not a false
  collapse but a real architectural fact of this specific reference
  wallet: the passphrase deterministically derives/decrypts the same
  Ed25519 keypair used both as Economic Identity and as the session's
  signing key, confirmed directly in `Login.tsx`'s own code comment
  ("Real Ed25519 challenge-response... `passphrase` never reaches the
  SDK/backend"). For an external-wallet-style integration this would be
  three separate steps; for this specific keypair-derived reference
  wallet, unifying them is honest, not collapsed-for-convenience.
- **Economic Identity vs. Transport Identity are correctly kept
  distinct** on the Profile screen — the displayed key is explicitly
  labeled "Sua chave de identidade (Pears / P2P)," naming it as the
  transport/P2P identity specifically, not presented as *the* identity
  with no qualifier. No collapse found.
- **Authorize/Sign/Execute** (submitting an escrow key, signing a PSBT,
  approving a release) were not exercised live this pass (no active
  trade existed) — deferred, not asserted clean or collapsed.
- **Recommendation ≠ Authority:** the "Sails Agent" (Market Negotiation)
  panel is visually distinct from the offer list and labeled as AI-
  generated intent/auto-search — not exercised deeply enough this pass
  to confirm its action buttons never silently escalate to execution;
  flagged as unverified.

## 6. State/Error-Semantic Findings

Restates §3 Journeys D/F precisely, cross-checked against PR #156's own
frozen invariants (not reopened):

- `UNKNOWN ≠ FAILED` — the backend-level guarantee is real and frozen;
  **no UI surface currently renders an `UNKNOWN` state distinctly at
  all** (§3 Journey D) — not a violation of the invariant (nothing
  mislabels `UNKNOWN` as `FAILED`), but the state has no UI existence
  yet, which is its own, narrower, disclosed gap.
- `CapabilityDenialReason`'s six values have zero UI consumption (§3
  Journey F, §4 PR-2) — confirmed by direct search, not inferred.
- Trade/Escrow status badges are a real, well-built, non-color-only
  system (§3 Journey D) — no defect found here; **preserve as-is.**

## 7. Mobile/Responsive Findings

Not exercised via a dedicated mobile-viewport pass this session (the
Browser pane defaulted to a narrow ~480-600px width throughout, which
incidentally exercised mobile-adjacent layouts for every screen visited
— Market, Login, Profile, Publish Offer wizard all rendered cleanly at
that width with no horizontal overflow or broken layout observed). A
dedicated desktop-width pass and a true `resize_window` mobile/tablet
comparison were not run this pass — disclosed as unverified, not
asserted complete.

## 8. Design-System Findings

No defect found. `StatusBadges.tsx`'s color+icon+text discipline,
`DESIGN.md`'s already-documented WCAG 2.1 AA contrast pass, and the
real/UI-only asset and payment-method list separation (`data/mock.ts`)
are all real, already-good engineering — explicitly preserved, not
reopened.

## 9. What Is Already Good and Should Be Preserved

- `Browsing ≠ Authentication` — live-confirmed, correct.
- The real-vs-UI-only asset/payment-method list split, including the
  already-correct exclusion of `SPARK` (zero provider) from the
  submission path.
- Economic Identity vs. Transport Identity correctly labeled, not
  collapsed, on the Profile screen.
- Trade/Escrow status badge system — real domain states, never
  color-only, TypeScript-enforced exhaustiveness.
- Honest, accurate non-custodial/no-recovery copy on Login — the
  *content* is correct; only its prominence is the finding (§4 PR-3).
- The passphrase-derived keypair's honest single-action framing for
  Identify+Authenticate+Connect (§5) — not a false collapse for this
  wallet type.

## 10. What Must Change Before Adding New Surfaces

**R1 correction:** item 1 below is restated at its proven strength —
structural scope-awareness, not a maturity/availability/eligibility
claim. Two real, bounded, evidence-backed items — both consume already-
frozen architecture, neither requires new mechanism:

1. **PublishOffer's asset picker must surface structural `SettlementScope`
   registration status**, consuming Mission 4's already-frozen
   `discoverExecutionCandidates()`. **Property, not mechanism, frozen
   here, and the property itself is narrower than previously stated:**
   the picker must distinguish "has a structurally registered settlement
   implementation" from "does not" — it must **not** label either state
   "eligible," "available," "mature," or "production-ready" unless
   separate evidence for that specific claim exists (none does today).
   This also does not yet resolve §3 Journey B's own deeper finding
   (the picker's legacy `AssetType`/`NETWORK_BY_ASSET` representation
   predates ADR-002's `Asset ≠ SettlementRail ≠ SettlementScope`
   decomposition, classified B+C there) — that mismatch is named, not
   fixed, by this item.
2. **`CapabilityDenialReason` needs a first UI consumer** — even a
   minimal one (map the six reasons to six distinct, honest copy
   strings, never a shared generic message) before any new surface that
   creates more denial-shaped error paths is added.

Explicitly **not** required before new surfaces: a universal re-entry
state model (PR #156 already correctly declined to invent one); a
multi-node presentation vocabulary (still Watchlist, no real multi-node
deployment exists); any change to the passphrase/identity flow itself
(honest and correctly scoped as-is).

## 11. Next Bounded Product/UI Implementation Mission

**R1 correction — renamed and re-scoped, not to overclaim maturity:**

**"Settlement Scope Awareness in Offer Creation"** (replaces "Settlement
Maturity Signal in Offer Creation," which claimed more than Candidate
Discovery proves). **Objective:** make offer creation consume the
already-frozen `Asset / SettlementRail / SettlementScope / Candidate
Discovery` truth without exposing unnecessary infrastructure complexity
to the ordinary user (`Progressive disclosure of complexity. Constant
sovereignty.`). The mission must answer, not assume:

- How the current legacy `AssetType` picker (`PublishOffer.tsx`'s
  `NETWORK_BY_ASSET`) maps to canonical `SettlementScope` — the B+C
  architecture mismatch named in §3 Journey B is this mission's own
  starting evidence, not a pre-decided redesign.
- When rail choice is explicit vs. implicit to the user.
- What `discoverExecutionCandidates()` can *truthfully* communicate —
  and no more.
- How to distinguish, in whatever the UI eventually shows: scope not
  registered; scope registered, no provider; provider exists but
  capability mismatch; one structural candidate; multiple structural
  candidates — **without calling any of those "eligible," "available,"
  "mature," or "production-ready" unless additional evidence exists**
  for that specific claim.

Does not require solving Selection among multiple candidates (no real
case exists), does not touch the rate-limit fan-out (§12a — a separate,
`discover()`-mechanism-level concern, not a picker concern), and does
not build the `CapabilityDenialReason` UI consumer (a second,
separately-scoped mission — related, not the same bounded slice).

## 12. Backlog Delta

Both items in §10 are genuinely new, UI-specific obligations not
previously registered anywhere in `docs/BACKLOG.md`'s own numbered
items (confirmed: neither the asset-scope-awareness gap nor the
zero-UI-consumption-of-`CapabilityDenialReason` gap is named there
today, only the *existence* of `CapabilityDenialReason` itself and the
disclosure that no UI reads it — item 40's own text already says this,
this document adds the concrete Product/UI consequence, not a duplicate
registration). Recommend a future `docs/BACKLOG.md` entry cross-
referencing this document once the next mission (§11) is authorized —
not registered as a new top-level item here, since this mission's own
scope is audit + next-mission-scoping, not backlog editing.

### 12a. Institutional Landing — Rate-Limit Finding (OPEN, must not be lost)

**R1 addition, per explicit instruction: a finding must land
institutionally even when it is not the next sequenced slice.** PR-4
(§4) — the Market discovery fan-out (`lib/realOffers.ts`'s per-asset×side
loop) generating 267+ console errors and 1200+ requests in one session,
tripping the backend's own rate limiter under normal use — is accepted,
real Product Reality / reliability evidence, **not fixed in this
document, and explicitly not permitted to disappear because
"Settlement Scope Awareness" (§11) is sequenced first.** Status:
**OPEN, distinct obligation**, not previously registered in
`docs/BACKLOG.md` (checked: no existing item names this fan-out/rate-
limit interaction). Cross-reference for future pickup: this is a
`discover()`-call-site-level concern (`packages/sails-ui/src/lib/realOffers.ts`),
independent of, and not blocking, §11's own scope. Whichever mission
next touches either `docs/BACKLOG.md` or `packages/sails-ui`'s Market
data layer should register it as its own numbered item, cross-
referencing this document rather than re-discovering it.

## 13. Harness Root Cause (R1)

Recorded per the harness's own requirement, not skipped: a structurally
compatible candidate (`SINGLE_STRUCTURALLY_COMPATIBLE_CANDIDATE`, real
and correctly named at the architecture layer since Mission 4 R1) was
promoted into a maturity/availability/product-readiness claim ("sellable
now," "Settlement Maturity Signal") one layer up, in this document's own
Product/UI framing, because that framing was convenient for describing
a UI decision. **Classification: E — maturity overclaim**, compounded by
**C — implementation vocabulary (structural registration) treated as
broader Product truth (settlement readiness)** where the legacy
`AssetType`/`NETWORK_BY_ASSET` mismatch (§3 Journey B) was additionally
folded into the same finding without being separately named. Both are
corrected above (§3 Journey B, §4 PR-1, §10, §11) — the underlying
Product Reality gap is real and kept; only its claimed strength and its
architectural framing are corrected.

## 14. Verdict

Findings are real but narrow and bounded — two concrete, evidence-backed
Product/UI gaps (§10), corrected to their proven strength (R1), both
resolvable by consuming already-frozen architecture, neither requiring
new mechanism, cryptographic work, or protocol change. The rate-limit
finding (§12a) is institutionally landed as its own OPEN obligation, not
lost by sequencing. No finding contradicts or requires reopening Mission
3/4/PR #153/PR #154/PR #156's frozen semantics; no new blocker was
discovered by this correction.

**PRODUCT/UI FOUNDATION COHERENT — IMPLEMENT NEXT SLICE**

PRODUCT/UI REALITY RETURN R1 — READY FOR CTO RE-GATE
