# ADR-001: Day-0 Multi-Operator Sails Network

**Status:** Accepted (architecture decision only — no implementation
authorized by this document). **Type:** Architecture Decision Record.
**Origin:** CTO mission, 2026-09-08/09, following
`docs/DAY0_MULTI_OPERATOR_NETWORK_ARCHITECTURE_DISCOVERY.md` (PR #96)
and `docs/BACKLOG.md`'s "Day-0 Multi-Operator Sails Network / Node
Independence" entry (PR #93/#94). This ADR freezes the smallest correct
architecture for multiple independent Sails Nodes to share one economic
market at Day-0, without a mandatory central authority. **Not
authorized here:** any implementation, Core changes, Hyperbee/Hypercore
adoption, a node registry, node-reward code, gossip code, or new
schemas/APIs. Property first, mechanism second — every decision below
states the property it satisfies before naming the mechanism.

**CTO Gate Correction Pass (2026-09-09).** The original pass overclaimed
that Pears connections are already "keyed by participant public key" —
false; see the new §7.1 for the corrected current truth (economic
identity and transport identity are separate, unbound today) and the
new Day-0 requirement this creates. Also corrected in this pass: §10's
reputation claim (narrowed to evidence/facts, not the score itself),
§11's settlement-authorization precision (attribution ≠ funds
authority), §16's node-economics framing (reconciling "Day-0-capable"
with "not activated," adding a full verifiability classification), §6's
bootstrap independence from any Satsails default list, §7's persistent-
node-identity gap now classified as a Day-0 implementation obligation,
§12's privacy review of the new binding requirement, and the model-
naming ambiguity against the independent, parallel
`docs/SAILS_NODE_SHARED_LIQUIDITY_DISCOVERY.md` (PR #98) discovery
document. All corrections preserve the original decision (Model C,
signed gossip) — none reverses it.

**Second CTO Gate Correction Pass (2026-09-09, economics/institutional).**
Registers the Product Direction that independent Sails Nodes must be
economically viable participants from Day 0 (§16, distinguishing
capability/accounting/entitlement/payout as four separate decisions,
only the last deferred); narrows §17's no-cannibalization claim so it
no longer depends solely on node economics being disabled; adds two new
Day-0 sequence items, Node Contribution Accounting and Incentive
Compatibility Evidence (§21 (k)/(l), renumbered 2026-09-09 for the (d)
Sails Node Operator Identity insertion); extends §12's privacy review to
the new accounting mechanism. `docs/SAILS_NODE_SHARED_LIQUIDITY_DISCOVERY.md`
(PR #98) is rebased and merged as a historical/research/evidence
artifact in this same pass — this ADR remains the architecture decision
authority.

**Third CTO Gate Correction Pass (2026-09-09, implementation).** A
security/correctness review of step (a)'s implementation (PR #100)
found a real, confirmed owner-takeover vulnerability — a different key
could supersede an already-owned `logicalOfferId` by claiming a higher
revision, reproduced directly against the code before any fix — plus
six related correctness gaps (canonical-serialization injectivity,
decimal/timestamp canonical form, persistence round-trip fidelity,
revision domain bounds, shape-validation ordering). §21(a)'s status was
reverted from a premature `CLOSED` to `CORRECTION REQUIRED`, all seven
properties were fixed and re-evidenced, and the status is re-closed
below. Full narrative: `docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s own
"CTO Gate Correction (2026-09-09)" section. This pass changes no
architecture decision in this document — Model C is unchanged; it
corrects an implementation defect in an already-authorized step.

**Fourth CTO Gate Correction Pass (2026-09-09, implementation).** A
follow-up review found that the Third Pass's own owner-continuity fix
("the first accepted envelope establishes a `logicalOfferId`'s owner")
was itself a defect for a multi-operator network: it let **arrival
order** determine economic ownership. Reproduced directly: two
independent nodes ingesting the identical two independently-valid,
self-signed envelopes (one from "Alice," one from "Mallory," both for
the same creator-local `logicalOfferId`) in opposite arrival orders
converged on *different* owners. Root cause: `logicalOfferId` was never
a name for one shared object two owners could compete over — it is only
ever creator-local — so "first writer wins" was solving a problem that
did not exist while creating a real one (order-dependent authority).
Fixed by making the canonical offer identity the pair `(ownerPublicKey,
logicalOfferId)`: `prisma/schema.prisma`'s unique constraint, the
`ingest()`/`getLatest()` lookup, and revision-ordering scope all changed
accordingly (schema change: `@@unique([ownerPublicKey, logicalOfferId,
revision])` replacing `@@unique([logicalOfferId, revision])`, corrected
in place in the still-unmerged migration rather than adding a second
one). A related gap was fixed in the same pass: `createdAt` immutability
across an offer's own revisions (already stated at §3/§9 above) was not
previously enforced by `ingest()`; it now is. §21(a)'s status was
reverted to `CORRECTION REQUIRED` and re-closed below. Full narrative:
`docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s "CTO Gate Correction
(2026-09-09, Fourth Pass — Properties H, I)" section. This pass, like
the Third, changes no architecture decision in this document — it
corrects the earlier implementation-level fix, not Model C itself.

> **Superseded (2026-09-09, Fifth Pass below).** This paragraph's own
> `createdAt` immutability enforcement was itself found to be
> order-dependent and non-convergent — see the Fifth Pass note and §3's
> own corrected `createdAt` row. The enforcement described here was
> removed, not merely adjusted.

**Fifth CTO Gate Correction Pass (2026-09-09, distributed convergence).**
A broader review asked the central question directly: do two conformant
nodes that eventually observe the same set of valid signed
`OfferEnvelope` facts ever end with different economic interpretations
solely because those facts arrived in a different order? Two more real
cases were found where the answer was yes.
**Property J (owner equivocation):** nothing prevents the same owner
from signing two genuinely different envelopes at the identical
`(ownerPublicKey, logicalOfferId, revision)` — reproduced directly, a
node ingesting E1-then-E2 accepted E1's price as "the" offer, a node
ingesting E2-then-E1 accepted E2's price; the (correct, as of the Fourth
Pass) "revision does not supersede" rejection was itself silently
discarding whichever conflicting fact happened to arrive second. Fixed,
deliberately fail-CLOSED rather than another first-writer-wins race:
`prisma/schema.prisma`'s unique constraint gained a fourth column,
`signature` (`@@unique([ownerPublicKey, logicalOfferId, revision,
signature])`, corrected in place in the same still-unmerged migration),
so two genuinely different signed envelopes at the identical revision
are BOTH durably stored as equivocation evidence — never silently
dropped, never used to overwrite one another. `getLatest()` now returns
a three-way state (`RESOLVED` / `EQUIVOCATED` / `NOT_FOUND`) instead of
a single row-or-null; an `EQUIVOCATED` state is, by rule, never
economically active (`isOfferStateEconomicallyActive()`), regardless of
which conflicting envelope any given node happened to store first — this
verdict is computed fresh from the full stored history every time, so it
is order-independent by construction. **Property L:** a subsequent,
correctly-signed higher revision deterministically resolves the CURRENT
state going forward; the lower revision's equivocation evidence remains
in the table, un-deleted, as a permanent record that the owner
misbehaved once.
**Property K (`createdAt` immutability, retracted):** the Fourth Pass's
own `createdAt`-immutability enforcement was reproduced to be itself
order-dependent — a node that happens to observe a later revision before
an earlier one has no prior value to compare against and accepts it
unconditionally, then incorrectly *rejects* a legitimately-signed further
revision carrying the true original value, purely due to observation
order; two nodes given the identical eventual facts converged on
different accepted revisions entirely (not just a different verdict on
one field). No order-independent enforcement mechanism exists without
full-history replication (a later, unauthorized step) or a global
minimum-tracking scheme this pass declined to invent for a claim that is
not load-bearing for any of ADR-001 §3's seven frozen Portable-Offer
properties. **Retracted as an enforced rule** — `createdAt` remains
signed (tamper-evident) and advisory (never used for ordering), exactly
as originally, minus the ingest()-level rejection. §3's `createdAt` row
below is corrected accordingly. §21(a)'s status was reverted to
`CORRECTION REQUIRED` and re-closed below. Full narrative:
`docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s "CTO Gate Correction
(2026-09-09, Fifth Pass — Properties J, K, L)" section. Like the Third
and Fourth passes, this changes no architecture decision in this
document — Model C is unchanged.

**Sixth CTO Gate Correction Pass (2026-09-09, distributed correctness
foundations).** Before freezing step (a), a review established that
fact identity, revision ordering, current-state convergence, and
historical-evidence semantics were three different questions this
document and its implementation had been conflating, and found two more
real defects plus one real vulnerability in the Fifth Pass's own
equivocation mechanism.
**Property M (concurrent identical-fact ingestion):** reproduced
directly against a real local Postgres instance — two truly concurrent
`ingest()` calls (`Promise.all`) for the identical signed envelope let
one caller succeed while the other's promise rejected with a raw,
uncaught `PrismaClientKnownRequestError` (P2002), a real unhandled
exception, not the forbidden-outcome hypothesis. Fixed by relying on the
database's own atomic uniqueness check as the actual concurrency
control (no lock, no serialization): `create()` is attempted directly
and a P2002 is caught and converted into the same graceful result a
non-racing caller would receive.
**Property O (signature is not a sound identity):** confirmed directly,
via a controlled test against the real `tweetnacl` verifier (not a
guess) — Ed25519 signatures are malleable; given one valid signature
`(R, S)`, the byte-different `(R, S + L)` (`L` = the Ed25519 group
order) also verifies, with no secret key required. The Fifth Pass's own
"different signature at the same revision means equivocation" rule was
therefore exploitable by a mere OBSERVER, not even the offer's owner, as
a griefing vector — falsely triggering the fail-closed `EQUIVOCATED`
state against an offer that was never actually double-signed. Fixed:
fact identity is now `contentDigest` (`hashOfferEnvelope()`'s digest of
the canonical content, excluding `signature`), used for both the DB
uniqueness constraint and `getLatest()`'s distinctness check;
`signature` remains stored in full as authorization evidence, demoted
from "identity."
**Property P (historical-evidence convergence):** reproduced directly —
"History A" (an owner's equivocating pair at revision 5, then a
resolving revision 6) and "History B" (the identical facts, with
revision 6 arriving FIRST) converged on the identical CURRENT state
either way, but under the prior "revision below the current highest is
stale, reject" rule, History B's own revision-5 facts (arriving after
revision 6 was already known) would never have been stored at all —
History B would then hold zero evidence the owner ever equivocated,
while History A held both. Decided explicitly, property first mechanism
second: **Option B** — every validly-signed fact is retained regardless
of its revision relative to anything already known (reputation/dispute/
abuse-evidence value outweighs the storage cost; replay of an already-
known fact specifically is free under Property M/O's own idempotency —
**corrected 2026-09-09, Seventh Pass, Property R:** this paragraph
originally also claimed that cost was "bounded by cryptography, not
policy" for genuinely NEW facts, which is false — see Property R below,
"authenticity ≠ resource boundedness"). `ingest()`'s revision-comparison
rejection is removed entirely; `getLatest()`'s CURRENT-STATE semantics
are completely unaffected. **Property N
(gossip-dedup semantic contradiction):** audited §3/§4/§21/§22 for every
statement conflating fact identity with revision-number dedup
("discards any envelope whose revision is ≤ the highest," "a node never
relays the same revision twice") — corrected throughout to state the
actual property (fact-identity dedup) without designing the not-yet-
authorized gossip data structure itself. §21(a)'s status was reverted to
`CORRECTION REQUIRED` and re-closed below. Full narrative:
`docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s "CTO Gate Correction
(2026-09-09, Sixth Pass — Properties M, N, O, P)" section. Like every
prior pass, this changes no architecture decision in this document —
Model C is unchanged; all four properties are corrections to step (a)'s
own implementation and specification, not to the network model itself.

**Seventh CTO Gate Correction Pass (2026-09-09, cross-implementation
signature semantics + resource-claim precision).** Before freezing step
(a), this pass closed the more fundamental property behind Property O's
own malleability finding: **two conformant Sails implementations
receiving the same signature bytes must not disagree on validity merely
because their Ed25519 libraries enforce different canonical-encoding
rules.** Confirmed directly, by reading `tweetnacl`'s source, that it
never checks RFC 8032 §5.1.7's own required `0 <= S < L` bound (fetched
and quoted directly from the RFC, not recalled) — this, not a
`tweetnacl`-specific design choice, is exactly why `(R, S+L)` verifies
under raw `tweetnacl`. **Property Q:** Sails's own `verifyOfferEnvelope()`
now enforces this canonical range (plus the analogous `y < P` check for
`R`/`ownerPublicKey`'s point encoding) BEFORE calling `tweetnacl` at all
— the malleated signature Property O demonstrated is now rejected by
Sails outright, while `contentDigest` (Property O's own fix) remains the
fact identity for every case that legitimately reaches it; no new crypto
library, no reimplementation of Ed25519, a pure range-check layer in
front of the existing, unmodified verifier call. **Property R:**
corrected an over-claim, introduced in the Sixth Pass's own Property P
reasoning, that storage cost was "bounded by cryptography" — false;
cryptographic authenticity bounds WHO can sign, never HOW MANY facts an
authorized owner (or many Sybil identities) can produce. The residual
(owner-history growth, Sybil amplification, no bandwidth mitigation
since step (a) has no propagation) is now named explicitly, deferred to
a later CTO Gate, and deliberately NOT papered over with pruning (which
could destroy the equivocation evidence Option B exists to preserve).
**Property S:** reproduced directly against real Postgres that
`ingest()`'s own `equivocationDetected` response hint can be missed by
BOTH callers under a genuine concurrent-equivocation race, while
`getLatest()`/the stored fact set are always correct regardless —
confirmed advisory, not load-bearing, and documented as such rather than
hardened with new locking machinery. Two stale source comments
describing Property A's superseded "owner continuity" model (retracted
since Property H) were also corrected. §21(a)'s status was reverted to
`CORRECTION REQUIRED` and re-closed below. Full narrative:
`docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s "CTO Gate Correction
(2026-09-09, Seventh Pass — Properties Q, R, S)" section. Like every
prior pass, this changes no architecture decision in this document.

---

## Decision

Sails adopts a **signed-offer, pairwise-gossip** network model:
economic advertisements (`Offer`s) become self-authenticating, signed
envelopes with a creator-assigned logical identity, propagated between
nodes over direct Hyperswarm/HyperDHT connections (already a proven
capability in this codebase) using flood-gossip with signed-fact/
content-derived deduplication (`contentDigest` — dedup key = signed
fact identity, not revision; revision determines ordering and
current-state selection only, §3/§5; a lower or equal revision is not,
by itself, sufficient reason to discard a previously-unseen valid fact,
§21(a) Property P — **corrected 2026-09-09, Eighth Pass**: this
paragraph previously read "revision-based deduplication," directly
contradicting §3/§4's own Sixth Pass corrections and Property N) —
**not** a DHT-stored, content-addressed advertisement
system, and **not** a federated/replicated shared database. Trade
coordination remains pairwise between the two actual counterparties;
no Trade, Escrow, or reputation state is globally replicated. No node
economics are activated in this ADR — the shared-liquidity property
does not depend on paying anyone.

---

## Alternatives — why they lost

**Model naming reconciliation (2026-09-09, CTO Gate):** the isolated,
parallel discovery document
(`docs/SAILS_NODE_SHARED_LIQUIDITY_DISCOVERY.md`) uses its own A-E
lettering for a *different* set of topology descriptions than this
ADR's own A-E letters — the letters are **local to each document, not
a shared vocabulary**. Compare the underlying topology descriptions
across documents, never the letter names alone. This ADR's own letters,
named descriptively from here on to prevent exactly this ambiguity:
**A = Central Index, B = Federation, C = Signed Gossip, D = DHT
Discovery, (C/D) = Hybrid.**

Reusing `docs/DAY0_MULTI_OPERATOR_NETWORK_ARCHITECTURE_DISCOVERY.md`
§15/§22's own comparison, resolved to a final decision here:

- **Model A — Central Index (centralized shared index):** rejected outright — directly
  violates the frozen invariant that no Satsails-operated node may be a
  mandatory authority for membership or truth (§1 below). Not a close
  call.
- **Model B — Federation (federated replication):** rejected for Day-0 — requires
  replica-set membership and conflict resolution machinery
  (operational complexity: High) with no natural relationship to any
  capability already proven in this codebase, for a property (§5's
  convergence rule) that signed-gossip already satisfies more simply.
  Not ruled out forever; revisit only if gossip's own scaling limits
  are hit in practice.
- **Model D — DHT Discovery (DHT/content-addressed discovery):** the real runner-up —
  HyperDHT is a genuine, already-used dependency. Rejected **for Day-0
  specifically**, not on principle, because: (a) storing structured
  Offer records in a DHT designed for peer-lookup key→address mappings
  is an unconfirmed capability (`docs/DAY0_...md` §23, unknown #1) —
  adopting it now would mean building on an unverified assumption; (b)
  it would most naturally be paired with Hyperbee/Hypercore for the
  actual structured storage, which is **explicitly not authorized in
  this mission** and is not currently a dependency; (c) signed-gossip
  (Model C) already satisfies the frozen invariants at Day-0 beta scale
  (a bounded number of nodes, not millions) without either risk.
  **Complexity test applied:** the property gained by D over C at this
  scale (network-wide lookup without maintaining many direct
  connections) does not yet justify its added dependency and unverified
  capacity — Rube Goldberg Check: fails (a heavier mechanism than the
  problem currently requires).
- **Hybrid (Signed Gossip + DHT Discovery, "C/D"):** not adopted now for
  the same reason D alone isn't — named as the most likely *next*
  evolution if/when gossip fan-out alone stops scaling, not designed
  further here.

**Model C — Signed Gossip wins** because it is the only option that
simultaneously satisfies the sovereignty invariant, builds on an
already-proven capability in this exact codebase (Hyperswarm/HyperDHT
peer discovery and direct connections, `pear.service.ts`), and requires
no new external dependency.

---

## 1. Shared Market Invariant (frozen)

- **Node choice must not define market membership.**
- **All conformant nodes must be capable of reaching the same
  protocol-level liquidity universe** — "capable of reaching," not
  "instantaneously observing" (next point).
- **Shared market universe ≠ instantaneous identical view** — bounded
  gossip-propagation delay is expected and acceptable; it is not
  fragmentation.
- **No Satsails-operated node, index, registry, or bootstrap service
  may be a mandatory authority for membership or truth.** A Satsails
  bootstrap node may *assist* discovery (§6); it may never *gate* it.

## 2. Object authority

**Property, before mechanism:** the only entity that may authorize an
`Offer`'s creation, update, cancellation, or expiry is the participant
holding the private key bound to that Offer's own declared owner
identity. A relaying/gossiping node may forward an Offer; it may never
modify its terms and re-present the result as valid — a modified
envelope simply fails signature verification at any honest receiver.
**Mechanism:** the offer's owner identity is `User.publicKey` (already
real, Ed25519, no new identity primitive) — object authority *is*
"produces a valid Ed25519 signature over the offer's canonical
content," full stop. Expiry is self-enforcing (§3) — no party need
*act* to expire an offer; every verifier independently checks
`expiresAt` against its own clock.

## 3. Signed Offer envelope (Protocol Envelope)

**Property:** an Offer must be portable (verifiable by a node that
never received it directly from its owner) and tamper-evident
(a relayed copy identical to the original, or rejected — never silently
mutated).

**Reuse decision — explicit, not automatic:** `EvidenceReference`'s
*signing pattern* (Ed25519 signature by the existing `User.publicKey`,
independently verifiable without trusting the serving node) is reused
— this is a genuinely equivalent property. `EvidenceReference`'s
*schema* (a pointer to external media: provider/uri/mimeType/sha256) is
**not** reused — an Offer's terms are structured economic data, not a
media pointer; the equivalent property does not imply the equivalent
shape.

**Minimum fields, decided:**

| Field | Purpose |
|---|---|
| `logicalOfferId` | Creator-assigned UUID, signed, **creator-local only** — it names an offer within one owner's own numbering, never a globally-unique object by itself. **Corrected (2026-09-09, Fourth Pass):** the canonical offer identity is the *pair* `(ownerPublicKey, logicalOfferId)`, not `logicalOfferId` alone — see §5's correction below for why treating a bare `logicalOfferId` as the identity was itself a confirmed defect. Still the key architectural move relative to `Offer.id` (a node-local DB primary key): the pair decouples "this is the same offer" from "which node's row it happens to be" — any node can recognize the same offer regardless of local storage. |
| `ownerPublicKey` | The existing `User.publicKey` — no new identity concept. Also, as of the Fourth Pass correction above, half of the canonical offer identity itself, not merely a field on it. |
| `asset`, `side`, `priceUsd`, `minAmount`, `maxAmount`, `paymentMethod` | The existing economic terms (`Offer` model, unchanged shape). |
| `revision` | Strictly increasing integer per **offer identity** `(ownerPublicKey, logicalOfferId)` — corrected from an earlier "per `logicalOfferId`" phrasing, same reason as above — chosen by the owner. The convergence/current-state-selection mechanism (§5). **Corrected (2026-09-09, Eighth Pass):** this row previously also called `revision` itself the "replay protection" — imprecise; replay protection (deduplication) is by signed-fact identity (`contentDigest`), not `revision` (§3's own "Replay protection" paragraph, Property N/O). |
| `createdAt` | Owner-supplied, signed (tamper-evident — no relay can alter it without invalidating the signature), advisory only — never used for cross-node ordering (§5 uses `revision`, not wall-clock time, precisely because clocks aren't trusted across nodes). **Corrected (2026-09-09, Fifth Pass):** this row previously also said "immutable across revisions" as an enforced rule. Reproduced directly that enforcing this against a node's own locally-first-observed value is itself order-dependent and non-convergent — retracted as an enforced protocol rule, narrowed to what it always structurally was: signed and advisory, nothing more. |
| `revisedAt` | Owner-supplied per revision, signed, same advisory status. |
| `expiresAt` | Owner-supplied, signed. Self-enforcing (§2). |
| `status` | `ACTIVE` / `CANCELLED` — cancellation is a new signed envelope at a higher revision, not a deletion (a tombstone). |
| `signature` | Ed25519 signature over the canonical serialization of every field above. |

**Canonical serialization:** a fixed, deterministically-ordered field
list (not "sorted JSON keys," which is implementation-dependent across
languages) — the exact byte layout is an implementation detail for the
beta sequence (§21a), not frozen here; the *requirement* that one
canonical form exist and be re-derivable identically by any conformant
implementation (TypeScript today, any future implementation per Issue
#75) is frozen.

**Replay protection:** a verifier never re-processes a signed fact it
has already accepted. **Corrected (2026-09-09, Sixth Pass, Property N):**
this paragraph originally read "a verifier discards any envelope whose
`revision` is ≤ the highest one it has already verified for that offer
identity," conflating two different questions — **fact identity ≠
revision ordering.** `revision` determines ordering and CURRENT-STATE
selection (§5) only; it is not the deduplication key, and a lower or
equal revision number is not, by itself, a reason to discard an
envelope this node has never seen before (§21(a)'s own Property P
closes exactly this gap: a genuinely new signed fact at a
previously-seen revision is retained as evidence, not discarded).
Deduplication is by **signed-fact identity** — a content-derived digest
of the envelope, not the raw `signature` (Property O: Ed25519
signatures are malleable — a second, different-byte signature can exist
over identical content without the signing key, so `signature` itself
is not a sound identity to dedup on) and not `revision` alone. A
byte-identical or content-identical resend of an already-known fact is
a no-op; a genuinely new distinct fact is retained regardless of its
revision relative to whatever this node has already seen.

## 4. Propagation model

**Decision: Model C — signed gossip over direct Hyperswarm/HyperDHT
peer connections.** Each node maintains connections to a bounded set of
known peer nodes (from bootstrap, §6, plus peer-exchange). A node
relays any newly-received, signature-valid envelope it has not already
relayed to its own connected peers exactly once. **Corrected (2026-09-09,
Sixth Pass, Property N):** this paragraph originally described the
relay-dedup rule as "per-`logicalOfferId` dedup by highest-seen
`revision`" — the same conflation as §3's correction above. The property
this ADR actually freezes for a future gossip design (§21(e),
renumbered 2026-09-09 for the (d) Sails Node Operator Identity
insertion, not designed here): **a node must never suppress relay of a
genuinely new, distinct signed fact merely because that revision number
was already seen for that offer identity** — including a fact whose
revision is lower than one already relayed (Property P). The exact
relay-dedup data structure (a revision counter, a fact-identity set, a
Bloom filter, etc.) is an implementation detail for step (e)'s own CTO
Gate, not frozen here — only the property is frozen. **HyperDHT is used only for
its already-proven capability**
(peer discovery, direct connections) — **not** as a generic key-value
store for offer records (that would be Model D, rejected above).
`Pears capability ≠ mandatory architecture`: if a future implementation
(Issue #75) uses a different P2P transport with equivalent peer-
discovery + direct-connection properties, the gossip model above is
unaffected — nothing here is Pears-specific beyond "whatever transport
is used must support direct node-to-node connections," which Pears
already does today.

## 5. Convergence / conflict

**Rule, already stated in §3/§4: highest verified `revision` wins,
scoped to one offer identity `(ownerPublicKey, logicalOfferId)`.** A
node that has verified revision N for an offer identity treats any
later-arriving envelope for that identity with revision strictly below
N as **not current** (this is a CURRENT-STATE / convergence question,
answered independently of whether that envelope is also retained as
historical/equivocation evidence — §3's own replay-protection paragraph
and §21(a) Property P), and adopts any verified envelope with revision
> N as the new current state. This requires no
central tie-breaker because only the owner's own key can ever produce a
valid signature at any revision *for that identity* — there is
structurally no cross-owner conflict to arbitrate within one offer
identity, only single-owner sequencing. **Exception, precisely bounded
(Property J, Fifth Pass, see below):** the *same* owner can equivocate
by signing two different envelopes at the identical revision — this is
not a cross-owner conflict (no one but the true owner could produce
either envelope) but it does mean "revision N" does not always name a
single unambiguous economic fact; §5's residual paragraph below covers
exactly this case and how it is now handled.

> **Claim correction (2026-09-09, Fourth Pass).** This paragraph
> originally scoped the "no multi-party conflict" claim to a bare
> `logicalOfferId`, reading "...only the owner's own key can ever
> produce a valid signature for that `logicalOfferId`." That was false
> as scoped: `logicalOfferId` is creator-local, so two *different*
> owners can each validly sign an envelope carrying the identical
> `logicalOfferId` string — they are not making competing claims over
> one object, because a bare `logicalOfferId` was never a name for one
> shared object to begin with. Confirmed as a real defect in
> implementation, not merely a documentation imprecision: an earlier
> fix attempt that treated "first accepted envelope for a
> `logicalOfferId`" as establishing ownership let **arrival order**
> decide which of two independently-valid owners "won" — two nodes
> observing the identical two facts in different orders converged on
> different owners. The corrected claim, now reflected throughout this
> section: for a canonical offer identity scoped by `(ownerPublicKey,
> logicalOfferId)`, only that owner can ever produce a valid higher
> revision. Full narrative: `docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s
> "CTO Gate Correction (2026-09-09, Fourth Pass — Properties H, I)".

~~**Named residual, not solved:** owner equivocation (the same owner
signs two *different* envelopes at the *same* revision) is possible in
principle and is not detected by the revision rule alone. This is
bounded, not exploitable by a third party: it can only confuse the
owner's *own* counterparties, never let anyone else forge or hijack the
offer. Detection (e.g., a node that observes two differently-signed
envelopes at one revision could flag the owner) is named as a future
hardening, not designed here.~~

> **Claim correction (2026-09-09, Fifth Pass) — Property J.** The
> paragraph above (preserved struck through, not deleted) understated
> this residual: it is not merely "confuses the owner's own
> counterparties." Reproduced directly: a node ingesting equivocating
> envelope E1-then-E2 accepted E1's economic terms as authoritative; a
> node ingesting the identical two envelopes E2-then-E1 accepted E2's —
> **two conformant nodes, given the identical set of facts, disagreed
> about the offer's actual economic terms, purely due to arrival
> order.** That is exactly the central distributed-convergence property
> this whole correction pass exists to protect, not a bounded,
> low-severity residual. Now designed and fixed, fail-closed: both
> conflicting envelopes are durably stored (`@@unique([ownerPublicKey,
> logicalOfferId, revision, signature])`, `prisma/schema.prisma`) and
> `getLatest()` reports an explicit `EQUIVOCATED` state — never
> economically active, order-independently, regardless of which
> envelope any given node stored first. A subsequent, correctly-signed
> higher revision deterministically resolves the current state going
> forward; the equivocation evidence at the lower revision is never
> deleted. Full narrative: `docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`'s
> "CTO Gate Correction (2026-09-09, Fifth Pass — Properties J, K, L)".

## 6. Bootstrap and membership

**Property:** a new node must be able to find the network without
asking Satsails, and Satsails' own availability must not gate anyone
else's membership. **Mechanism:** each node ships with an
operator-editable list of bootstrap peer addresses/public keys.
Satsails may publish a well-known default list — a *suggestion*, freely
replaceable or extended by any operator, never the only valid list.
Peer-exchange (an already-standard Hyperswarm-family capability) lets a
newly-connected node discover further peers transitively, beyond
whatever bootstrap set it started with. **A censored or offline
bootstrap list degrades discovery speed for brand-new joiners; it
revokes nothing for nodes already connected**, and it never determines
who is "allowed" to join — there is no admission list at all. Any node
that can establish a connection and speak the gossip protocol (§4) is a
de facto participant.

**Confirmed, 2026-09-09 (CTO Gate):** a Satsails-published default list
is **not necessary for the network to function** — an operator may
configure zero Satsails-provided peers and still join the network via
any independently published bootstrap list, a direct peer address
obtained out-of-band, or transitive peer-exchange from any single
already-connected node. Day-0 architecture permits multiple,
independent, operator-defined bootstrap configurations simultaneously —
no central bootstrap registry exists or is proposed.

## 7. Node identity and Sybil

**Property, frozen 2026-09-09:**

> A Sails Node participating in network discovery must have a stable
> operational identity across ordinary restarts.

> **Node Identity ≠ Participant Identity.** Never transform node
> identity into economic authority — a node's own key signs only
> gossip-relay/transport-level metadata, never an Offer's economic
> terms (§2/§3 remain participant-signed, exclusively).

**Current implementation gap, classified explicitly against the
accepted Day-0 architecture (not a future nicety):** ~~today's
node-level keypair is HyperDHT's per-session, ephemeral `peerId`,
regenerated on every restart, satisfying neither the frozen property
above nor this ADR's own reliance (§4, gossip relay/dedup) on stable
peer relationships surviving ordinary restarts. This is registered as a
Day-0 implementation obligation (§21), not a beta-hardening nicety — a
node whose peer identity changes on every restart cannot maintain the
gossip peer relationships §4's own propagation model depends on.~~
(confirmed, `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`, at the time this
paragraph was written)

**Correction (2026-09-09, CTO Gate, final institutional precision
pass) — two conflations fixed, current truth stated precisely:** the
struck-through text (1) called this artifact a "node-level keypair,"
inviting the reading that it is the operator/deployment-level identity
§4/§16 separately require, and (2) claimed its persistence is what
§4's gossip-relay peer model "depends on." Neither is accurate. This
artifact is **Participant Transport Identity** — scoped per participant
(`ownerUserId`), not per operator/deployment — see
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5 for the full four-way
taxonomy (Participant Economic Identity / Participant Transport
Identity / Operational Sails Node Identity / Operator Economic
Recipient) this correction preserves. §4's gossip-relay peer network is
a **Sails Node operator-to-operator** relationship, which requires
Operational Sails Node Identity — an identity that **does not exist in
this codebase today** (confirmed by direct code/schema search; no
model, keypair, or code path represents an operator/deployment entity
distinct from its hosted participants). Persisting Participant Transport
Identity (§21(b)) closes the participant-to-participant restart-stability
gap only; it does not, and structurally cannot, make any gossip-relay
peer relationship stable. This is registered as a Day-0 implementation
obligation (§21(b) for Participant Transport Identity; §26.2/§26.3 for
the still-undesigned Operational Sails Node Identity), not a
beta-hardening nicety.

**Reconciliation note (2026-09-09, PR #108 ↔ PR #106 merge):** PR #108
independently reached the same correction under the earlier, retired
term "Sails Node Operator Identity" and its own §7.2/§21(d). That term
is superseded by this section's own, more precise A/B/C/D taxonomy —
specifically, it collapsed **Operational Sails Node Identity (C)** and
**Operator Economic Recipient (D)** into one label, which
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5 explicitly found is exactly
the mistake to avoid (one operator may run several C instances; C
rotating must not redefine D's entitlement; C and D must not be assumed
to share a key). §7.2/§7.3 below are retained for their genuinely new
content (the node-switch continuity investigation), updated to the
current terminology.

**Sybil resistance: explicitly not promised, per instruction.** No
strong Sybil-resistance mechanism is designed here, because none is
*needed* for the shared-liquidity property itself: a farm of fake node
identities can waste bandwidth relaying gossip, but cannot forge a
single valid Offer signature (§2/§3 already prevent that regardless of
how many fake nodes exist) and — because **no node economics are
activated in this ADR (§16)** — a Sybil farm has no economic payoff to
chase either. Sybil resistance becomes a real, separate requirement
only if/when node-economic attribution (§16) is ever activated, and is
named there as an explicit precondition, not solved now.

## 7.1 Economic Identity ↔ Transport Identity Binding (correction, 2026-09-09, CTO Gate)

**Correction — the original §8 below overclaimed that Pears connections
are already "keyed by participant public key." False, confirmed
directly against this session's own prior work
(`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md` §2/§3.3):**

> **Economic participant identity = `User.publicKey`.**
> **Transport identity = Pears/HyperDHT `peerId`.**
> **Today: no cryptographic binding exists between them.** ~~`peerId`
> is generated fresh by `HyperDHT.keyPair()` with no seed on every
> `PearNode.start()` call — cryptographically unrelated to
> `User.publicKey`, and not even stable across sessions.~~ (true at the
> time this paragraph was written)

**Correction (2026-09-09, CTO Gate B, PR #108 final pass) — current
truth:** the struck-through sentence is now historically false and is
preserved only as the record of what was true before PR #108.
**Participant Transport Identity is now stable across ordinary restarts
when the same persisted local seed material remains available**
(§21(b), `participant-transport-identity.ts`) — the "generated fresh...
not even stable across sessions" claim no longer holds. **This does not
change what stays true above:** the binding itself still does not
exist. `peerId` remains cryptographically unrelated to `User.publicKey`
— persistence of a transport identity is not the same property as
proving it belongs to a given economic identity, and this correction
does not conflate the two. **Persistence ≠ binding**, stated explicitly
to close that exact gap.

**Preserved:** `Economic Identity ≠ Transport Identity` — this was
already true before this correction and remains true after; what
changes here is that the ADR stops *assuming* a binding exists and
instead names the gap explicitly.

**Day-0 requirement, frozen:**

> A participant must be able to prove an authorized binding between its
> economic identity and the transport identity used to establish direct
> trade communication.

**Explicitly not decided here:** the final binding format (e.g., a
signed statement — "economic key X authorizes transport key Y for
session/interaction Z" — or a session-scoped derivation) is a real
cryptographic design decision this ADR does not make. **Explicitly
forbidden:** reusing `User.publicKey` directly *as* the Pears transport
key — collapsing the two would defeat the domain-separation reasoning
`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md` already established (economic
key compromise must not equal transport key compromise, and vice
versa). Whatever binding mechanism is eventually chosen must produce a
*separate*, transport-scoped key, cryptographically *linked* to the
economic identity by a verifiable statement — not identical to it.

**Effect on §8 below:** every place §8 says a buyer "connects directly
to the seller's own public key," read as: *the buyer connects to
whatever transport identity the seller has authorized-bound to their
economic identity, verified via that binding* — not a literal claim
that Pears already resolves participant public keys today. §8's own
architectural conclusion (pairwise coordination, no globalized Trade
state) is unaffected by this correction; only the mechanism-level claim
about *how* the connection is keyed changes.

## 7.2 Participant Transport Identity vs. Operational Sails Node Identity (correction, 2026-09-09, CTO Gate B on PR #108)

**Terminology note (2026-09-09, PR #108 ↔ PR #106 merge):** this
section originally used the single term "Sails Node Operator Identity"
for the concept below. §26.3 and `docs/DAY0_COMPLETENESS_COLD_SWEEP.md`
§3.5 later found that term itself collapses two distinct things —
**Operational Sails Node Identity (C)**, discussed here, and **Operator
Economic Recipient (D)**, a separate concept this section never
addressed. Renamed accordingly; the investigation and evidence below
are otherwise unchanged.

**Finding:** §7's own text ("today's node-level keypair is HyperDHT's
per-session, ephemeral `peerId`") and §7.1's definition ("Transport
identity = Pears/HyperDHT `peerId`") both describe the identical
underlying artifact, and PR #108 (Implementation Sequence step (b))
correctly persisted exactly that artifact. What this correction found
is that this ADR's own prior language never distinguished that artifact
— always scoped to one economic participant — from a structurally
different concept §4 and §16 both separately require: an identity for
the **operator/deployment itself**, independent of any single
participant, that gossips (§4: "each node maintains connections to a
bounded set of known peer nodes") and is economically compensated (§16:
"a node was genuinely used by a real participant to reach a real,
confirmed trade" — compensating the infrastructure that served the
trade, not the trading participant). Collapsing these two was never a
deliberate architectural decision; it was inherited, unexamined,
imprecise wording.

**Confirmed directly against the real code, not assumed** (`git log`
`feat/adr001-step-b-node-identity`, `src/infrastructure/p2p/pear.service.ts`):

> `PearNode → one DHT node for ONE user... PearNodeRegistry → owns a
> Map<userId, PearNode>` (the file's own pre-existing header comment,
> predating PR #108). `PearNode.start()` writes the derived `peerId`
> directly onto the `User` row: `prisma.user.update({ where: { id:
> this.ownerUserId }, data: { peerId } })`.

This is unambiguous: the identity PR #108 made persistent is scoped
1:1 to a `User` row. There is no code path, Prisma model, or keypair in
this codebase representing a deployment/operator entity distinct from
its hosted `User`s — confirmed by searching `prisma/schema.prisma` for
any `Operator`/`NodeOperator` identity model; the only matches are
`nodeOperatorShare`/`nodeOperatorPct` `Decimal` fields inside
distribution-policy models (§16) — a payout-recipient *category* in a
percentage table, not an identity of any kind.

**Two distinct concepts, named precisely from here forward:**

> **Participant Transport Identity** — per `User`; Pears/HyperDHT
> `peerId`; direct participant transport; persisted by PR #108. This is
> what §7.1 already calls "Transport identity" (renamed
> `node-identity.ts` → `participant-transport-identity.ts`,
> `loadOrCreateNodeIdentitySeed()` →
> `loadOrCreateParticipantTransportIdentitySeed()`, to match). **Frozen,
> 2026-09-09 (final-precision pass on PR #108).**

> **Operational Sails Node Identity (C)** — per operator/runtime/deployment;
> independent of any hosted participant; identifies infrastructure node
> to other nodes; future basis for gossip attribution (§4) and Node
> Contribution Accounting (§21(k)); **does NOT yet exist.** Distinct from
> **Operator Economic Recipient (D)** — see §26.3 for the full C≠D
> separation, not yet drawn out when this section was first written.
> **Frozen, 2026-09-09 (final-precision pass on PR #108).** No mechanism is proposed or invented here —
> inventing one is explicitly out of this correction's scope (no
> gossip, no node registry protocol, no federation design). This is
> registered as a real, previously-unregistered gap in
> `docs/BACKLOG.md`, item 5. **Sequenced (2026-09-09, CTO decision,
> final-precision pass on PR #108): §21(d), inserted immediately after
> (c) Economic Identity ↔ Transport Identity Binding and before (e)
> Propagation/bootstrap** — not merely "sometime before gossip/
> economics," an ordered Day-0 prerequisite. Propagation/bootstrap (e)
> must not be implemented before this step has its own CTO-approved
> design and evidence — see §21(d)'s own entry for the full
> authority-separation and privacy-unresolved statements.

**§21(b)'s own text is retroactively accurate, narrowly read:** "a
stable operational node keypair across ordinary restarts (§7), closing
the confirmed current gap (ephemeral, per-session `peerId`)" describes
exactly the Participant Transport Identity artifact and exactly what PR
#108 closed — §21(b) is not itself wrong, it was just read, by this
correction's own earlier pass, as implicitly satisfying §4/§16's
operator-level model too, which it does not and was never designed to.

**Privacy, corrected accordingly:** a persistent Participant Transport
Identity intentionally makes that *participant's* Pears `peerId`
linkable across their own connection sessions/restarts — not "the node
operator" (there is no operator identity here to be linkable). It does
not automatically make it linkable to their economic identity
(`User.publicKey`) — that binding is §7.1/step (c)'s own explicit,
still-undesigned scope — but a network observer who has, through any
means, previously associated a `peerId` with a real participant can now
recognize that same participant returning, rather than seeing a fresh,
unlinkable `peerId` every session.

**Node Identity ≠ Participant Identity, restated precisely:** this
frozen property (§7) is about economic authority, not database
association — it forbids a transport key from ever signing an Offer's
economic terms, not from being tied to a specific `User` row for
bookkeeping. A Participant Transport Identity being scoped per-user does
not violate it; the property remains fully intact (§7.1's own
domain-separation reasoning, and `offer-envelope.ts`'s complete import
isolation from this module, are unaffected by this correction).

## 7.3 Node-switch continuity — investigation, 2026-09-09, CTO Gate B final pass (no mechanism authorized)

**Question:** if the same participant moves from Sails Node A to Sails
Node B, what happens to its Participant Transport Identity today?

**Demonstrated against the actual implementation, not assumed**
(`tests/participantTransportIdentity.test.ts`, test 8): calling
`loadOrCreateParticipantTransportIdentitySeed(ownerUserId, storageDir)`
for the identical `ownerUserId` against two different `storageDir`
values — modeling two different Sails Nodes' own local storage —
produces two different seeds and two different `peerId`s:

```
Node A local storage → seed A → peerId A
Node B empty local storage → seed B → peerId B
```

Confirmed empirically (real `HyperDHT.keyPair()`, real filesystem):
`peerId A ≠ peerId B`. Nothing in `participant-transport-identity.ts` or
its `pear.service.ts` call site shares seed material across storage
locations — each Sails Node's own local disk is the entire scope of
today's persistence mechanism (§6 of `docs/PARTICIPANT_TRANSPORT_IDENTITY_EVIDENCE.md`).

**Property, named, not solved:**

> Changing Sails Node must not silently destroy participant identity
> continuity.

**Two model families, evaluated without choosing between them (no KDF,
key path, or identity-root mechanism selected here):**

> **Model P1 — Portable transport identity.** The participant controls
> and restores the same transport identity across nodes — e.g. via a
> participant-held recovery root that deterministically re-derives the
> identical Pears/HyperDHT seed regardless of which node's local storage
> is in use. This directly matches Model A/B/C's own "Pears" row already
> surveyed in `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md` §3.3/§5 — Pears
> "accepts a seed but define[s] no standard derivation path from an
> external root," a gap that document already named, not newly
> discovered here.

> **Model P2 — Rotatable transport identity.** The transport identity
> may legitimately change when switching nodes, but the participant's
> Economic Identity (`User.publicKey`) authorizes a new, verifiable
> binding to the new transport identity, preserving continuity at the
> economic layer rather than the transport layer. This is not a new
> mechanism to design — it is exactly what §21(c)'s own binding
> mechanism (once built) already needs to support, since nothing about
> §7.1's binding requirement assumes the transport key never changes.

**Relation to `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`, confronted
directly, not assumed:** that document is evidence-gathering only for a
possible future "Sails Identity Root" (backlog obligation from PR #91),
explicitly authorizing no derivation scheme. Its own §3.3 already
covers Pears/HyperDHT as one of seven surveyed protocol rows, and its
own preserved invariants — **`Same recovery root ≠ same private key
across protocols`** and **`Recovery relationship must not automatically
become public identity relationship`** — apply without modification to
Model P1: a future Identity Root re-deriving the Pears seed must not
reuse that seed (or a value trivially related to it) for any other
protocol's key, and re-deriving the same `peerId` across nodes must not
by itself make that `peerId` publicly correlated to the participant's
other protocol identities beyond what already applies today.

**Classification (2026-09-09, CTO Gate B final pass) — reconciliation,
not a new obligation:** node-switch continuity is **not** a genuinely
new, previously-unrepresented obligation. It decomposes into two
obligations already registered:
- **Model P1** is a refinement/specialization of the existing **Identity
  Root & Multi-Protocol Identity UX** obligation (`docs/BACKLOG.md`,
  registered via PR #91, investigated in
  `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`) — Pears is already one of
  its surveyed rows; node-switch portability is that same "can Pears
  identity be re-derived from a shared root" question, not a separate
  one.
- **Model P2** is a refinement of the existing **Economic Identity ↔
  Transport Identity Binding** obligation (§7.1/§21(c), item 3 in
  `docs/BACKLOG.md`) — a binding mechanism that supports re-binding a
  new transport key to the same economic identity already covers this
  case; no additional obligation is needed for P2 to exist as an option.

**No mechanism is chosen between P1 and P2 here — that choice, and any
derivation/binding design, is future work under the obligations already
named above, not this correction.**

## 8. Trade ownership / handoff

**Property:** the trade must not require a "home node" whose
disappearance kills it, and `buyerId`/`sellerId` (node-local foreign
keys today, confirmed `docs/DAY0_...md` §12) must never become the
*economic* authority over the trade.

**Decision: pairwise coordination, no globalized Trade state.** When
Buyer (on Node B) discovers Seller's gossiped Offer (originally signed
by Seller, who happens to be connected via Node A), Buyer's client
connects to **Seller's own transport identity, verified via the
Economic Identity ↔ Transport Identity Binding (§7.1)** — *not*
directly to `User.publicKey` itself, which corrects this section's own
prior overclaim that Pears connections are "already keyed by
participant public key" (§7.1 demonstrates this is false today). Node A
is not an intermediary in this connection at all. Each party's own node
persists its own local `Trade` row
(`buyerId`/`sellerId` remain valid as *that node's own bookkeeping*
references into its own `User` table) — the two rows are tied together
by a **jointly-signed trade-open handshake**: both parties countersign
a small message (`logicalOfferId` + a mutually-derived `tradeId`,
neither node unilaterally assigning it) at trade start. This
jointly-signed handshake, not either node's own row, is the actual
cross-node economic anchor. **Escrow/settlement is already
provider-mediated** (a real transaction hash, a real multisig PSBT) —
neither node needs to trust the other's database at all once
settlement moves; they each independently verify the same on-chain (or
provider-attested) fact. **No Trade globalization is needed** because
pairwise, mutually-signed coordination is sufficient for the two
parties who actually need to agree — no third party (including either
node's own operator) needs a global view of the trade to exist.

## 9. Offline / restart / resume

**Property, not "retry everything":** a party must be able to
reconstruct a trade's current state from artifacts it already holds
plus the settlement provider's own authoritative record — never by
guessing.

Minimum facts required, per scenario: (a) **app/process
restart** — already solved intra-node (Postgres durability, this
session's own WDK safety remediation); (b) **counterparty reconnects**
— Pears' existing backoff/reconnect (confirmed, this session's SDK
network-reliability work) plus the jointly-signed trade handshake
(§8) as the re-anchor point; (c) **the original coordinating node goes
permanently offline** — the surviving party's *own* node, holding its
own copy of the signed trade handshake and the settlement provider's
own on-chain/PSBT state, can independently reconstruct the trade's
status without the vanished node at all — **provided** that party's own
signed artifacts were themselves durably stored somewhere the party
controls, which loops into the separately-tracked, not-yet-solved
device/identity-recovery gap (`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`)
— named as a dependency, not re-solved here.

## 10. Reputation portability

**Correction, 2026-09-09 (CTO Gate).** The broad frozen claim carried
from `docs/BACKLOG.md` ("changing node must not inherently change
participant economic identity, reputation or historical rights") reads
as a guarantee over the *number* itself. Narrowed to what this ADR can
actually support:

> Changing nodes must not inherently erase or invalidate portable
> reputation evidence, participant identity, historical economic
> facts, or historical rights.

> **Reputation Evidence ≠ Reputation Score.** A node or application may
> compute a different score from the same evidence, under its own
> local policy, provided it does not invent or erase the underlying
> verifiable economic facts.

This is not a weaker property, only a more precise one: it protects the
*facts* a participant can prove (a completed trade, a signed receipt),
not any particular node's own arithmetic over those facts — the
distinction §10 below already draws between Evidence and Score
Calculation, now stated as the frozen property itself rather than left
implicit.

**Three things kept explicit and distinct, per instruction:**

- **Observation:** what a participant can *present* to a new
  counterparty or node — e.g., "here are N signed settlement receipts
  proving completed trades." Portable in principle once §11's signature
  requirement lands.
- **Evidence:** the underlying signed artifacts themselves
  (`EvidenceReference.signature`, and — once §11 lands — signed release
  authorizations). Already partially real, extended by this ADR.
- **Score calculation:** turning observed evidence into a number.
  **Remains a local, per-node/per-application policy decision** — not
  standardized, not synchronized, not globally computed. **No global
  reputation database is created.** A node may choose to weight
  presented, externally-verifiable evidence however it likes; this ADR
  does not mandate a formula.

## 11. Settlement / evidence portability

**Preserved: `Durable ≠ Portable ≠ Independently Verifiable`**
(`docs/DAY0_...md` §10/§4, demonstrated not asserted).

**Real, positive finding carried into this decision:** for on-chain
rails (`WDK_USDT_EVM`, `MULTISIG`, `LIGHTNING_HODL`), the settlement
*transaction* itself is already maximally portable and independently
verifiable — a real transaction hash checkable against the chain by
anyone, no Sails-specific mechanism required at all. **The actual gap
is narrower**: authorizing an ordinary (non-disputed) release/refund
has no equivalent to `DisputeOutcome.attributionRawProof`'s
participant-signed attestation today.

**Decision:** a settlement release/refund's authorization must be
accompanied by the authorizing participant's (or mutual parties')
Ed25519 signature over the release decision, stored alongside the
transaction hash — reusing the *exact* existing signature pattern
(same key, same curve, same verification logic already proven for
`EvidenceReference`/`DisputeOutcome`), not a new primitive. This single
change closes the gap between "this node's DB says the release was
authorized" and "any stranger node can verify the release was
authorized," for the ordinary (non-dispute) path.

**Precision, added 2026-09-09 (CTO Gate) — what this signature does and
does not prove:**

> **Participant-signed authorization proves authorization attribution;
> it does not by itself prove custody or funds authority.**

> **Authorization Evidence ≠ Funds Authority.**

A signature over "I authorize this release" is evidence of *who
decided*, verifiable by any stranger node — it is not evidence that the
signer *controlled the funds* being released, which is a separate,
rail-specific fact. **Evaluated per rail, not assumed uniform:**
`WDK_USDT_EVM` is server-custodial (one operator-held seed actually
moves funds; the participant's authorization signature and the
provider's own custody are two different things, confirmed
`docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md`); `MULTISIG`/
`LIGHTNING_HODL` are client-held-key rails where the authorizing
signature is closer to, but still not identical to, funds authority
(the actual PSBT/HTLC signature is the funds-authority artifact; the
authorization-decision signature this ADR adds is a separate, simpler
attestation of intent, useful for cross-node verification even where
it doesn't itself move funds). This ADR closes the *attribution*
gap (§11's own decision above); it does not claim to have unified or
simplified each rail's own, already-disclosed custody model
(`README.md`'s "Rail readiness" table remains the authoritative source
on that).

## 12. Privacy

**Preserved: `Shared market ≠ shared private state`.** Only signed
`OfferEnvelope`s (§3) are gossiped network-wide — their terms are
inherently public by the nature of advertising liquidity. **Trade
coordination, negotiation, and chat remain strictly pairwise** (direct
Pears connection between the two actual counterparties, already
sealed-box encrypted, confirmed this session's identity-architecture
work) — **never gossiped, never sent through relay nodes**. Reputation
evidence (§10) is presented by the participant on demand — opt-in
disclosure, not broadcast. **Cost of the chosen model, disclosed
honestly:** more nodes observe *that an offer exists and who signed it*
than under a strictly pairwise-only design — an inherent, unavoidable
cost of any discovery mechanism, not specific to gossip over DHT.
Network-metadata correlation (which node relayed which offer, IP-level
observation) inherits HyperDHT/Hyperswarm's own known trade-offs,
already accepted for today's pairwise Pears usage — not a new risk this
ADR introduces.

**Reviewed specifically, 2026-09-09 (CTO Gate), following §7.1's own
new binding requirement:**

- **Offer-signer correlation:** every gossiped `OfferEnvelope` carries
  `ownerPublicKey` (§3) — an offer owner's economic identity is
  inherently, permanently correlatable across every offer they ever
  sign, by construction of the discovery mechanism itself. Not a new
  cost introduced by this ADR beyond what any signed-advertisement
  system requires.
- **Node-relay metadata correlation:** unchanged from the general
  finding above — which nodes relay which offers is observable to
  anyone watching enough of the network, an inherent property of any
  gossip/relay mechanism, not specific to signed offers.
- **Economic identity ↔ transport identity binding privacy — the
  genuinely new question §7.1 raises:** if the binding statement
  itself (economic key → transport key) is gossiped or stored the same
  way an Offer is, it becomes a **permanent, public link** between a
  participant's economic identity and every transport session they've
  ever bound to it — a materially worse correlation surface than the
  offer-signer correlation above, since it could deanonymize *all* of
  a participant's transport-layer activity, not just their offers.
- **Whether the binding must be public, selectively disclosed, or
  interaction-specific — not decided here, evidence insufficient.**
  Three shapes are plausible and not evaluated in enough depth to
  choose: (a) a public, offer-attached binding (simplest, worst
  privacy — every discoverer of an offer also learns the owner's
  current transport identity); (b) a selectively-disclosed binding
  (shared only with the specific counterparty once a trade begins,
  better privacy, requires an extra disclosure step in the trade-open
  flow, §8); (c) an interaction-specific, rotating binding (a fresh
  transport identity bound per trade/session, best privacy, most
  mechanism complexity). **This ADR does not choose among them** — §7.1
  registers the requirement; this section registers that its privacy
  shape is a real, undecided design question for whatever mechanism
  closes §21(c), not an oversight. **Kept explicit and reusable, since
  the same shape question applies elsewhere in this repository's own
  identity work:** `Recovery relationship ≠ Public identity
  relationship` (`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`) — the
  binding statement here is exactly a recovery/linkage relationship of
  that same class, and the same caution against making it automatically
  public applies.

**Reconfirmed, 2026-09-09 (CTO Gate, Fase 8) — extended to §16's new
Node Contribution Accounting (§21(k), renumbered 2026-09-09 for the (d)
Sails Node Operator Identity insertion):**

> **Economic contribution attribution ≠ Global participant
> surveillance.**

Recording that a node genuinely served a confirmed trade (§16's
"trade-serving" row, the only verifiable contribution today) requires
only that trade's own already-durable `Trade`/`Escrow` rows and the
trade-open handshake (§8) — it does **not** require, and this ADR does
not authorize, any mechanism that aggregates a participant's activity
*across* trades into a single trackable profile for contribution-
accounting purposes. **Node contribution accounting must not require
global user tracking; economic attribution must not create a universal
participant tracking graph** — a design that needed either would be
solving a much larger problem than "did this node serve this one
confirmed trade," and is explicitly out of scope for §21(k)/(l).

## 13. Professional liquidity provider

**Tested explicitly, per instruction:** a professional web BTC/USDT/
DePix service publishes liquidity (a signed `OfferEnvelope`, §3, same
primitive a person or wallet-embedded offer uses — confirmed no second
marketplace needed, `docs/PARTNER_BETA_INTEGRATION_REALITY.md` §6/§13,
`docs/DAY0_...md` §18) and receives demand from multiple wallets/nodes
via the same gossip mechanism (§4) — structurally identical to any
other offer's propagation.

**Resolved or explicitly sequenced, not silently dropped:**
- **Quote expiry:** resolved by §3's `expiresAt` field — Day-0.
- **Min/max:** already real (`Offer.minAmount`/`maxAmount`) — no change
  needed.
- **Inventory reservation / double-commit:** resolved as a **local**
  concern — only the offer *owner's own node* ever needs to arbitrate
  acceptance of *its own* offer (optimistic-lock the local row at
  trade-acceptance time, reject/refresh if already claimed). No
  cross-node mechanism is needed because authority over "is this offer
  still available" is exactly the same object authority already
  established in §2 — Day-0.
- **Partial fill:** explicitly **deferred past Day-0 beta** — named
  here, not silently dropped, tracked in the beta sequence's own
  "later" bucket (§21, footnote).
- **Automated acceptance:** remains the current default (immediate,
  per `docs/PARTNER_BETA_INTEGRATION_REALITY.md` §6's finding) —
  unchanged by this ADR; a review-gate feature is a future, separate
  decision, not blocking.
- **Event/callback delivery:** WebSocket remains the interim mechanism;
  outbound webhooks are **deferred past Day-0 beta**, named explicitly.

## 14. Liquidity discovery scaling

**Property:** a valid offer must not need to manipulate its own price
to become discoverable merely because many other offers exist —
already the frozen property from
`docs/PARTNER_BETA_INTEGRATION_REALITY.md` §5.

**Finding carried forward:** the underlying pagination/filter mechanism
(`limit`/`offset`, `priceMin`/`priceMax`, `paymentMethod`) is **already
real and shipped** (`liquidity.service.ts`, confirmed this session) —
only `examples/simple-wallet`'s own documentation is stale. **This
generalizes for free to the multi-node case**: once gossip-received
offers land in the same local `Offer`-equivalent table a node already
serves `GET /v1/liquidity/offers` from, the exact same pagination/
filtering code already handles a larger, multi-source result set — no
new discovery mechanism is required. **Exits this ADR as a Day-0 beta
obligation** (§21(h), corrected 2026-09-09 alongside the (d) Sails Node
Operator Identity renumbering — was malformed as "§21e"): fix the stale
example/doc so real integrators
actually use the existing mechanism, and verify (not assume) it behaves
correctly once offers originate from more than one source.

## 15. Capability / rail discovery

**Decision: a capability-specific surface, not a universal interface**
— per instruction, explicitly rejecting a generic `supportedCapabilities()`
framework. Extends the existing, already-real `custodyModel`
per-escrow pattern (`docs/PARTNER_BETA_INTEGRATION_REALITY.md` §8) with
one new, narrow, **pre-creation** read: a node exposes which
`EscrowType`s it currently has configured/enabled, at what disclosed
maturity/custody label — read directly from that node's own already-
loaded provider configuration (no new registry, no new primitive,
just introspection of state that already exists in memory). Named for
the beta sequence (§21(h), pre-existing reference corrected 2026-09-09
alongside the (d) Sails Node Operator Identity renumbering — was
malformed as "§21e"; the intended target is Pagination/discovery
scaling, §15's own item), not designed at the wire-format level here.

## 16. Node economics

**Product Direction, registered 2026-09-09 (CTO Gate, Fase 2):**

> Independent Sails Nodes are intended to participate economically from
> Day 0 of the production network.

**Four distinct things, not one, per instruction — collapsing them is
exactly the mistake this correction fixes:**

- **Economic capability** — does the architecture allow contribution to
  be attributed at all? Yes, for participant-facing coordination
  (table below), the moment §21(a)/(g) land (renumbered 2026-09-09 for
  the (d) Sails Node Operator Identity insertion) — no new primitive
  required.
- **Contribution accounting** — is a contribution actually being
  recorded/tracked as it happens? **Must be built and testable before
  the independent partner-wallet beta (§20, §21(o))** — this is new,
  registered as Implementation Sequence item (k) (renumbered 2026-09-09
  for the (d) Sails Node Operator Identity insertion).
- **Entitlement recognition** — does a `DistributionPolicyVersion`
  actually name the contribution as eligible and specify (whatever)
  share? A policy decision, separate from accounting — **must also be
  testable before the partner-wallet beta**, without requiring any
  particular percentage to be chosen yet (a policy can name eligibility
  with a placeholder/test share for the purpose of exercising the
  mechanism).
- **Actual payout execution** — real value moving to a node operator.
  **Remains gated by the Production Readiness Consolidated Gate
  (`docs/BACKLOG.md`) — may stay disabled through the entire beta.**

**For beta, precisely:** real payout activation MAY remain disabled.
**Contribution accounting and entitlement semantics must be testable**
— meaning: a real contribution can be recorded, and a real
`DistributionPolicyVersion` can name it eligible and compute what it
*would* pay, end to end, without a single unit of value actually
moving. **No payout percentage is invented here. No new token is
introduced. No production fee is activated by this ADR.**

**Precision, unchanged from the prior correction — a third term, not
two:**

> **Coordination Attempt ≠ Verified Contribution ≠ Fee Entitlement.**

An attempt (a node tries to relay, tries to coordinate) is not itself a
contribution; a verified contribution (something independently checkable
actually happened) is not itself an entitlement (the applicable
`DistributionPolicyVersion` must still name it as eligible and specify
its share — a policy decision, never automatic from verification
alone).

**Contribution sources, classified by verifiability today, expanded
per instruction to cover all six evaluation dimensions — no
percentages set for any of them:**

| Contribution source | Verifiability today | Basis |
|---|---|---|
| **Trade-serving node compensation** (a node was genuinely used by a real participant to reach a real, confirmed trade) | **Verifiable today** | Directly derivable from the already-durable `Trade`/`Escrow` rows plus §8's jointly-signed trade-open handshake — no new proof primitive needed. |
| **Offer-origin contribution** (the node where a winning offer's owner was connected when the offer was created/signed) | **Potentially verifiable** — the signed `OfferEnvelope` (§3) already names `ownerPublicKey`, and §7.1's own binding (once built) could extend to naming an origin node — but attributing *origin*, as distinct from *serving the eventual trade*, is not yet designed. Considered explicitly, per instruction: the offer-origin identity plus the trade-open handshake together provide **durable attribution sufficient for trade-serving compensation specifically** (the row above) — they do not, by themselves, resolve origin-vs-serving-node attribution when those differ. |
| **Settlement contribution** (a node's own settlement-provider infrastructure processed a release/refund) | **Potentially verifiable** — the transaction hash and (once §11 lands) the signed release authorization are both real, checkable artifacts; attributing them to a specific *node's own infrastructure* rather than the settlement provider itself is not yet designed. |
| **Discovery / propagation contribution** (a node helped an offer be found/relayed) | **Potentially verifiable** — *only if* the propagation mechanism itself is signed/versioned (§9's own revision requirement); even then, no design here proves *which specific hop* mattered to a specific outcome. |
| **Routing** | **Not currently verifiable** — same gap as discovery/propagation, no proof mechanism proposed. |
| **Wallet/integrator rebate** (compensating the *wallet*, not the node, for bringing a transacting user) | **Verifiable today**, and structurally simpler than any node-side row above — a wallet/integrator is already identifiable via whichever `WalletAdapter`/API credential originated the request; this is a genuinely different recipient class from "node," not evaluated further here (out of this ADR's own node-economics scope, named only so it isn't confused with a node-side lever). |
| **Treasury/protocol share** | Not a contribution-verifiability question at all — a `DistributionPolicyVersion` policy choice (how much of a confirmed fee goes to the protocol treasury vs. any other named recipient), unrelated to whether any *node* contribution can be verified. |

**No new generic economic primitive is introduced** — every
potentially-verifiable row above extends an already-real, already-
proven mechanism (signed envelopes, signed release authorizations,
transaction hashes), consistent with the instruction that a new
primitive is authorized only if evidence demands it; none of this
evidence does.

**Explicitly, no payment is authorized for gossip relaying in this
ADR** — a naive "pay per message relayed" design is **rejected
outright** (not merely deferred) because it trivially incentivizes
spam and self-relay loops (relay your own garbage to yourself for a
stipend). Any future design for the "potentially verifiable" and "not
currently verifiable" rows must close that verifiability gap before
activation, not after. **Availability** — no attestation mechanism
exists; unaddressed, consistent with `docs/PROTOCOL_ECONOMY.md` §4.2's
own, now-Day-0-capability-corrected (not Day-0-*activated*) timeline.

**No real payout is activated by this ADR.** This remains a deliberate,
load-bearing choice: it is what makes §7's Sybil-resistance deferral
hold cleanly at Day-0, while contribution accounting and entitlement
recognition themselves become real, testable, Day-0 obligations per the
Product Direction above — capability, accounting, and entitlement
recognition are no longer treated as "later," only payout execution is.

## 17. Incentive compatibility / no-cannibalization property

**Narrowed, 2026-09-09 (CTO Gate) — the prior claim depended entirely
on node economics being disabled, which stops holding the moment
accounting/entitlement become Day-0-testable (§16). Replaced with a
property that holds independent of that:**

> A conformant node must not gain durable economic advantage by
> withholding valid competing liquidity.

> Honest liquidity propagation must remain economically rational
> relative to liquidity suppression.

**Evaluated explicitly against each of §16's six dimensions, not
assumed to hold uniformly:**

- **Trade-serving node compensation:** compensates a node only for
  trades it actually, verifiably served — withholding a *competitor's*
  offer earns nothing extra here, since compensation attaches to the
  node's own served trades, not to the volume of offers it chose to
  show or hide. **Property holds.**
- **Wallet/integrator rebate:** same reasoning, one layer up — a wallet
  rebate rewards bringing a real transacting user, not suppressing
  competing liquidity that user might otherwise have found elsewhere.
  **Property holds**, contingent on the rebate never being computed as
  a function of "share of visible market," which would invert the
  incentive — named as a design constraint for whenever this mechanism
  is built, not designed further here.
- **Offer-origin contribution:** if ever activated, rewards accurately
  attributing where a winning offer came from — has no natural
  incentive to suppress *other* offers, since suppressing a competitor
  doesn't make one's own offer's origin more "contributory." **Property
  holds under the same accurate-attribution assumption §16 already
  names as undesigned.**
- **Settlement contribution:** rewards processing confirmed outcomes,
  which requires trades to actually happen — suppressing liquidity
  network-wide reduces the total number of trades available to settle,
  a direct disincentive to suppression. **Property holds, and is
  actively reinforcing.**
- **Discovery/propagation contribution:** the one dimension with a real,
  disclosed risk if ever activated naively — a poorly designed
  discovery/propagation reward *could* create an incentive to relay
  more (even spam) rather than relay honestly, which is exactly why
  §16 rejects "pay per relay" outright rather than merely deferring it.
  **Property does not automatically hold here — it is exactly why this
  dimension stays unverifiable/unpaid until a real design closes the
  gap**, not an oversight.
- **Treasury/protocol share:** a fixed policy allocation, not
  contribution-dependent — no incentive effect on any individual node's
  behavior either way.

**Explicit withholding-liquidity threat analysis:** the failure mode
named by the mission — "if hiding liquidity can rationally increase
revenue, the design fails the Day-0 incentive test" — is evaluated per
dimension above, not asserted globally. Four of six dimensions
structurally cannot reward withholding (trade-serving, rebate,
offer-origin, settlement); one (treasury share) is neutral; one
(discovery/propagation) is the one genuine risk, and is precisely the
one this ADR keeps unpaid until it can be designed safely. **This is a
stronger, more defensible position than the prior "economics are
disabled" framing** — it holds for four of six real dimensions on
their own structural merits, and names the one real remaining risk
explicitly rather than hiding it behind "nothing is paid yet."

## 18. Stranger-node test (future evidence gate)

An independent operator installs a Sails Node from published material
alone, joins the network via a bootstrap list it obtained from public
documentation (not a private conversation with Satsails), discovers an
`OfferEnvelope` originated by a different, unrelated operator, and
**independently verifies that envelope's signature** without querying
any Satsails-controlled database or allowlist. **Not demonstrated
today** — this is the direct successor to
`docs/DAY0_...md` §21's own "Stranger Node Test," now scoped precisely
against this ADR's chosen mechanism (§3's signature, §6's bootstrap
model) rather than an abstract placeholder.

## 19. Stranger-developer test (future evidence gate)

A developer external to this project installs `@satsails/p2p-trading-sdk`
from the published package alone, using only published documentation,
connects a wallet or web service to a real (multi-operator) market,
and executes a permitted flow (discover → trade → settle) with zero
support from the Sails team. **Every question that developer would need
to ask the team is, by definition, a DX or documentation gap until
proven otherwise** — direct continuation of
`docs/PARTNER_BETA_INTEGRATION_REALITY.md` §10's own already-defined
test, now including the multi-node discovery step this ADR adds.

## 20. Partner-wallet evidence gate

An independently-maintained wallet or service — not Satsails, not this
repository — installs the SDK, uses only the public integration
surface, and participates in the *same* liquidity universe as at least
one other, unrelated operator (via this ADR's own gossip mechanism, not
a private arrangement). **Preserved, verbatim, per prior registration:**
Satsails Wallet's own success proves reference-implementation
viability, not independent interoperability — this gate is not
satisfied until a genuinely separate party clears it.

## 21. Implementation Sequence (obligatory order, not a "future" list)

None of the following may silently become "later roadmap" if it is
required for Day-0 beta — each is either in this sequence or explicitly
named as deferred-past-beta (§13's partial-fill/webhooks are the only
two items in this entire ADR granted that status):

**(a) Portable signed Offers** — `logicalOfferId`, canonical
serialization, Ed25519 signature, `revision`/`expiresAt`/tombstone
semantics (§3). ~~CLOSED (2026-09-09)~~ ~~CORRECTED AND RE-CLOSED
(2026-09-09, Third Pass)~~ ~~CORRECTED AND RE-CLOSED AGAIN (2026-09-09,
Fourth Pass)~~ ~~CORRECTED AND RE-CLOSED A THIRD TIME (2026-09-09, Fifth
Pass)~~ ~~CORRECTED AND RE-CLOSED A FOURTH TIME (2026-09-09, Sixth
Pass)~~ **CORRECTED AND RE-CLOSED A FIFTH TIME (2026-09-09, Seventh
Pass).** The Third Pass found and fixed a real, confirmed owner-takeover
vulnerability plus six related correctness gaps (Properties A-G). The
Fourth Pass found that the Third Pass's own Property A fix ("first
accepted envelope establishes ownership") was itself defective: it let
**arrival order** determine economic ownership across independent
nodes. Fixed by making the canonical offer identity the pair
`(ownerPublicKey, logicalOfferId)`, plus one related gap (`createdAt`
immutability across revisions, Property I). The Fifth Pass then asked
the central distributed-convergence question directly and found two
more real gaps: **Property J (owner equivocation)** — the same owner
signing two different envelopes at the identical revision let arrival
order determine WHICH conflicting economic terms a node accepted;
fixed, fail-closed, by storing both as durable evidence and having
`getLatest()` report an explicit, order-independent `EQUIVOCATED` state
that is never economically active — a subsequent higher revision
deterministically resolves it going forward without erasing the
evidence (**Property L**). **Property K** — the Fourth Pass's own
`createdAt`-immutability enforcement was found to be itself
order-dependent and was **retracted**, not repaired. The Sixth Pass then
found the Fifth Pass's own equivocation mechanism itself carried a real
vulnerability plus two more convergence gaps: **Property O** — Ed25519
signatures are malleable (confirmed via a controlled test against the
real verifier), so the Fifth Pass's `signature`-keyed uniqueness
constraint (`@@unique([ownerPublicKey, logicalOfferId, revision,
signature])`) let a mere OBSERVER manufacture a false `EQUIVOCATED`
state against an offer that was never actually double-signed — fixed by
re-keying on `contentDigest` (a content-derived hash, not `signature`)
instead. **Property M** — reproduced directly against real Postgres:
concurrent identical-fact ingestion used to leak a raw, uncaught
`PrismaClientKnownRequestError`; fixed by relying on the database's own
atomic uniqueness check (no lock, no serialization) rather than a racy
application-level pre-check. **Property P** — reproduced directly: a
node that observes a lower revision AFTER a higher one was itself
rejecting that lower revision as "stale," silently losing equivocation
evidence a node observing the same facts in a different order would
have retained; decided explicitly (Option B) that all valid signed
facts are retained regardless of arrival order, removing the
revision-comparison rejection from `ingest()` entirely (this changes
nothing about `getLatest()`'s own CURRENT-STATE selection). **Property
N** — corrected every ADR statement conflating fact-identity
deduplication with revision-number comparison (§3/§4/§21/§22), without
designing the not-yet-authorized gossip mechanism itself. The Seventh
Pass then closed the cross-implementation signature-semantics question
directly: **Property Q** — confirmed, by reading `tweetnacl`'s source
and RFC 8032 §5.1.7's own text, that `tweetnacl` never enforces the
spec's required `0 <= S < L` bound; fixed by having Sails's own
`verifyOfferEnvelope()` reject a non-canonical `(R, S)` or public key
outright, before `contentDigest`-based identity logic ever runs — no new
crypto library, a pure range check in front of the unmodified verifier.
**Property R** — corrected an over-claim that storage cost was "bounded
by cryptography"; authenticity bounds WHO can sign, never HOW MANY
facts — the owner-history-growth/Sybil-amplification residual is now
named and deferred to a later Gate, not solved or hidden. **Property S**
— confirmed by direct real-Postgres reproduction that `ingest()`'s own
`equivocationDetected` hint can be missed by both concurrent callers in
a genuine race, while `getLatest()`/the stored fact set remain always
correct; documented as advisory, not hardened with new locking. All
nineteen properties named across five correction passes (A-S, with I
retracted rather than fixed) are now in their evidenced final state —
tested (80 unit tests, 9 real-Postgres integration tests, including real
`Promise.all` concurrency evidence for both Property M and Property S),
zero regression. Full evidence, including every prior pass preserved as
history: `docs/PORTABLE_SIGNED_OFFERS_EVIDENCE.md`. Still proves Offer
portability/authenticity only — no propagation, no second node, no
network claim of any kind, and NOT general distributed consensus: the
convergence property demonstrated here is "the same eventual facts
produce the same eventual interpretation" for THIS bounded object model,
not a claim that arbitrary distributed disagreement is solved. Do not
begin (b) before its
own CTO Gate.
**(b) Persistent Participant Transport Identity** — ~~a stable
operational node keypair across ordinary restarts (§7), closing the
confirmed current gap (ephemeral, per-session `peerId`) this ADR's own
gossip model (§4) depends on~~. **Corrected (2026-09-09, CTO Gate,
final institutional precision pass):** a stable, per-participant
transport identity across ordinary restarts (§7/§7.1), closing the
confirmed current gap (ephemeral, per-session `peerId`) for
participant-to-participant direct communication. **Narrow claim:**
"Local participant transport identity persistence across ordinary
restarts on the same persisted storage." **Explicitly does not close**
(none of the following are demonstrated or claimed): §4's gossip-relay
model (operator-to-operator, needs Operational Sails Node Identity —
(d) below, §26.2/§26.3, `docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5, a
distinct, still-undesigned identity this step does not produce);
cross-node portability; node migration; recovery; rotation; node
gossip identity; participant continuity after changing operator (§7.3's
node-switch finding).
**(c) Economic Identity ↔ Transport Identity Binding** — the
participant-signed statement binding `User.publicKey` to a
session/interaction-scoped transport identity (§7.1) — **added
2026-09-09, a genuinely new Day-0 sequence item**, since without it
step (f) below has no real mechanism to connect the discovering buyer
to the actual offer owner.
**(d) Operational Sails Node Identity** — ~~Sails Node Operator
Identity~~ **renamed (2026-09-09, PR #108 ↔ PR #106 merge, §26.3) —
inserted 2026-09-09, CTO decision, §7.2/§21 final-precision correction
pass on PR #108**: a cryptographic identity for the operator/deployment
itself, independent of any hosted participant, identifying
infrastructure to other Sails Nodes — the future basis for gossip-relay
attribution (§4) and Node Contribution Accounting (§21(k)). **Confirmed
not to exist anywhere in this codebase today** (§7.2) — no design is
proposed or authorized here; this entry only fixes its ordered
position. **Critical dependency, explicit:** propagation/bootstrap (e)
must not be implemented before this step has its own CTO-approved
design and evidence — flood-gossip relay (§4) needs a stable
operator-level identity to attribute relay behavior to, which (b)'s
participant-scoped identity structurally cannot provide (one operator
can host many participants, each with their own `PearNode`). **Authority
separation, registered explicitly:** Operational Sails Node Identity
(C) ≠ Participant Economic Identity (A, `User.publicKey`) ≠ Participant
Transport Identity (B, `peerId`, (b) above) ≠ Operator Economic
Recipient (D) ≠ Funds Authority. A node operator key must never gain
authority to sign an Offer's economic terms, authorize a participant's
settlement, impersonate a participant's economic identity, or become
escrow authority merely because it operates infrastructure — this is a
restatement of §7's own frozen "Node Identity ≠ Participant Identity"
property, extended to cover the operator-level identity this step will
eventually design. **C does not determine D** (§26.3): one operator may
run several C instances, but node cardinality does not by itself fix
how many economic recipients (D) that operator has; C rotating or being
rebuilt must not automatically redefine D's entitlement, and D's own
policy must not grant C's operational authority — no recipient model or
C↔D mapping is selected here. **Privacy, explicitly unresolved, not
decided here:** unlike (b)'s own settled privacy assessment (§7.2 —
participant session/restart linkability, not operator linkability),
this future operator identity's own public-observability and privacy
characteristics are **not** determined by this entry and must be
reviewed as part of its actual design, whenever that design is
undertaken.
**(e) Propagation/bootstrap** — bootstrap peer list, flood-gossip with
fact-identity dedup, not revision-number dedup (§4/§6, corrected
2026-09-09 Sixth Pass), building on (b)'s now-stable Participant
Transport Identity **and gated on (d)'s own CTO-approved design**, per
(d)'s critical-dependency note above.
**(f) Multi-node discovery/convergence** — highest-revision-wins
verification at the receiving node (§5), feeding into the existing
local `Offer` table.
**(g) Cross-node trade coordination** — jointly-signed trade-open
handshake, pairwise Pears connection to the seller's transport
identity as authorized by (c)'s binding, not a claimed direct
public-key connection (§7.1/§8).
**(h) Pagination/discovery scaling** — fix the stale
`examples/simple-wallet` documentation, verify existing pagination/
filter code against a multi-source local offer table, add the
capability/rail pre-creation discovery surface (§14/§15).
**(i) Professional provider flow** — inventory reservation/optimistic
locking on the offer owner's own node (§13); quote expiry and min/max
already covered by (a).
**(j) Restart/offline/resume** — extend existing intra-node durability
with the jointly-signed trade handshake as the cross-node re-anchor
point (§9).
**(k) Node Contribution Accounting** — **added 2026-09-09**: recording
a verified contribution (§16's trade-serving row, the only one
verifiable today) as it happens — economic *capability* without
payout, must exist and be testable before (o) below. **Must refer to
(d)'s Sails Node Operator Identity, not (b)'s Participant Transport
Identity** — a contribution is attributed to the infrastructure that
served a trade, not to the participant's own transport `peerId`; this
was implicit before (d) existed as a named step and is now explicit.
**(l) Incentive Compatibility / No-Cannibalization Evidence** — **added
2026-09-09**: demonstrating §17's property actually holds against (k)'s
real accounting mechanism once built, not only as a structural argument
on paper — must exist and be testable before (o) below.
**(m) Stranger-node test** (§18).
**(n) Stranger-developer test** (§19).
**(o) First independent partner-wallet beta** (§20).

**Actual payout execution remains gated by the Production Readiness
Consolidated Gate (`docs/BACKLOG.md`)** — separate from, and later
than, this sequence; (k)/(l) make accounting and entitlement
*testable*, they do not activate any real payment.

**Deferred past Day-0 beta, named explicitly, not silently dropped:**
partial fill (§13); outbound webhook delivery (§13); any real
node-economic **payout activation** (§16 — capability/accounting/
entitlement recognition are Day-0 sequence items (k)/(l), payout
execution is not); formal Sybil-resistance mechanism (§7); Model
D/hybrid propagation (Alternatives section).

## 22. Complexity tests (applied to this ADR's own new artifacts)

**New artifact 1: the signed `OfferEnvelope` schema (§3).**
- *Property gained:* portable, independently verifiable offer
  authenticity — the single most concrete prerequisite this entire ADR
  depends on (`docs/DAY0_...md`'s own headline finding).
- *Simpler alternative considered:* trusting the relaying node's own
  claim about an offer's authenticity (no signature at all) — rejected,
  since it reintroduces exactly the "node authority over economic
  content" this ADR exists to prevent (§2).
- *Coupling:* couples every Offer-consuming code path to a signature-
  verification step — a real, disclosed cost, bounded to one
  well-understood operation (Ed25519 verify), not a new dependency.
- *Operational cost:* one signature computation per offer creation/
  update/cancellation — negligible.
- *Privacy cost:* none beyond what publishing an offer already implies
  (§12).
- *Attack surface:* signature-forgery is the new surface — bounded by
  Ed25519's own well-understood security properties, the same curve
  already used for `User.publicKey` (no new cryptographic primitive
  introduced).
- **COBRA Check:** does not touch settlement/escrow/authority code
  directly — a discovery/advertisement-layer addition only.
- **Rube Goldberg Check:** passes — the mechanism (sign a fixed field
  set, verify on receipt) is the minimum necessary for the property
  claimed, no generic framework introduced.

**New artifact 2: gossip propagation (§4).**
- *Property gained:* offers reach nodes beyond their origin without a
  central index (§1's own core requirement).
- *Simpler alternative considered:* Model D (DHT storage) — rejected
  above (Alternatives section) as heavier than currently justified.
- *Coupling:* couples node operation to maintaining peer connections —
  already true today for Pears' existing chat/negotiation use, not a
  new class of coupling.
- *Operational cost:* bandwidth for relaying (bounded by fact-identity
  dedup, §4 — corrected 2026-09-09, Sixth Pass: a node never re-relays
  the same signed fact twice; it is not bounded by revision number
  alone, since a genuinely new fact at a previously-seen revision must
  still be relayed, Property P).
- *Privacy cost:* addressed in §12 (offer visibility broadens, private
  trade content does not).
- *Attack surface:* flooding/spam (named, §14 threat table, not solved
  here); Sybil relay abuse (§7, bounded because it can't forge content,
  only waste bandwidth).
- **COBRA Check:** does not touch settlement/escrow/authority — a
  discovery-layer mechanism only.
- **Rube Goldberg Check:** passes — flood-gossip with fact-identity
  dedup is a standard, minimal pattern for this exact problem class, not
  a bespoke invention.

## 23. Claims not yet demonstrated (discipline, restated)

None of the following may be used as a demonstrated claim until its
named evidence gate (§18/§19/§20) actually passes: **decentralized,
permissionless, shared liquidity, portable, multi-node, censorship
resistant, production-ready.** This ADR is a decision about what to
build, not evidence that it exists yet.

## 24. Migration from current single-node topology

No breaking change to the existing single-node `Offer`/`Trade`/`User`
schema is required to *begin* this sequence — `logicalOfferId` and the
envelope's signed fields are additive columns/derived data on top of
the existing `Offer` model, not a replacement of it. A node running
today, before any of §21's sequence lands, continues to behave exactly
as it does now (a self-contained, correctly-functioning single-node
deployment) — this ADR describes an additive capability, not a
rewrite, consistent with `docs/PARTNER_BETA_INTEGRATION_REALITY.md`'s
own finding that the single-node SDK/API surface is already largely
sound.

## 25. BACKLOG DELTA

**Not forced to zero.** This ADR reveals concrete, implementation-
shaped obligations materially more specific than the abstract Day-0
obligation already registered — see the accompanying `docs/BACKLOG.md`
update for the itemized new delta (the §21 implementation sequence
itself, registered as the executable form of the existing obligation,
plus the settlement-release-signature requirement from §11, which is a
genuinely new, previously-unregistered obligation on its own).

**Updated 2026-09-09 (CTO Gate correction pass) — two further genuinely
new obligations**, surfaced by this correction and by reconciling
`docs/SAILS_NODE_SHARED_LIQUIDITY_DISCOVERY.md`'s (PR #98) independent
findings: **Economic Identity ↔ Transport Identity Binding** (§7.1) and
**Persistent Node Identity** (§7) — both now registered as Day-0
implementation-sequence items (§21 (b)/(c)), both genuinely new (neither
was represented anywhere in this repository before this pass), neither
duplicating an existing entry. See `docs/BACKLOG.md`'s own updated
entry for the full registration and the explicit check against
duplication with PR #98's own candidate list.

**Count correction, 2026-09-09.** `docs/BACKLOG.md`'s own entry for
this ADR now states explicitly: the original registration pass counted
**2** distinct obligations (items 1-2 there); this correction pass
added **2 further** (items 3-4); **total: 4**, not left implicit.

**Updated again, 2026-09-09 (Fase 2-5/9) — Node Contribution Accounting
and Incentive Compatibility (§21 (j)/(k) at the time of this entry,
renumbered to (k)/(l) 2026-09-09 by the later (d) Sails Node Operator
Identity insertion)** are new *sequence items* inside the already-counted
Implementation Sequence obligation (item 2) — deliberately **not**
registered as separate fifth/sixth top-level obligations, to avoid
double-counting the same "build this ordered sequence" obligation
twice. Checked against `docs/PROTOCOL_ECONOMY.md` §4.2 — no
duplication: that section's own Node Operator Pool/routing-fee content
is the future payout-*rollout* layer; §21(k)/(l) are the Day-0
accounting/entitlement-*capability* layer underneath it.

**Updated again, 2026-09-09 (CTO Gate B correction, PR #108, §7.2) —
one further genuinely new obligation: Operational Sails Node Identity.**
§7's original text conflated two distinct concepts — Participant
Transport Identity (per-`User` `peerId`, what §21(b) actually closes)
and a cryptographic identity for the operator/deployment itself,
independent of any hosted participant, required by §4's gossip-relay
peer model and §16's trade-serving-node compensation. Confirmed by
direct code/schema search: **no such operator-level identity exists
anywhere in this codebase today** — no model, no keypair, nothing
beyond `nodeOperatorShare`/`nodeOperatorPct` payout-percentage fields.
This is registered as a fifth top-level obligation, distinct from item
2's Implementation Sequence (it is a *precondition* some later sequence
items depend on, not itself a sequence step yet) and distinct from
items 3/4 (Economic Identity ↔ Transport Identity Binding, Persistent
[Participant Transport] Identity — both still participant-scoped, not
operator-scoped). **Total: 5**, not left implicit.

**Updated again, 2026-09-09 (CTO decision, final-precision correction
pass on PR #108) — item 5 sequenced, not fabricated as a sixth
obligation.** Placement is no longer "left to CTO decision": **§21(d)**,
inserted immediately after (c) Economic Identity ↔ Transport Identity
Binding and before (e) Propagation/bootstrap (renumbered from old (d)
onward) — an ordered Day-0 prerequisite, not merely "sometime before
gossip/economics." See §21(d)'s own entry for the critical-dependency
statement (propagation/bootstrap must not be implemented before this
step has its own CTO-approved design) and the authority-separation
statement (Operational Sails Node Identity (C) ≠ Participant Economic
Identity (A) ≠ Participant Transport Identity (B) ≠ Operator Economic
Recipient (D) ≠ Funds Authority — full taxonomy:
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5). **Total remains 5** — this
pass only fixes item 5's ordered position, it does not add a sixth.

**Reconciliation note (2026-09-09, PR #108 ↔ PR #106 merge):** the term
"Sails Node Operator Identity" used in the two entries above (PR #108's
own item-5 registration, predating PR #106) is superseded by the more
precise **Operational Sails Node Identity (C)** / **Operator Economic
Recipient (D)** split established in §26.3 below and
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5 — retained here as history,
not as the current canonical term.


## 26. Day-0 Completeness Cold Sweep — implementation consequence (2026-09-09)

**This section does not change the accepted topology decision.** Signed
Offer envelopes + direct node-to-node gossip remain the Day-0
architecture. It corrects a completeness omission in §21: a clean
happy-path propagation flow is not enough to demonstrate one durable
economic market across time, failure and adversarial network
conditions.

Full evidence/registration:
`docs/DAY0_COMPLETENESS_COLD_SWEEP.md`.

The §21 implementation sequence is therefore interpreted as requiring
the following additional properties before the corresponding evidence
gates can pass. **Letter references below are corrected, 2026-09-09
(PR #108 ↔ PR #106 merge), for the (d) Sails Node Operator Identity
insertion** — this section was originally written against the
pre-insertion lettering ((d) Propagation/bootstrap, (e) discovery/
convergence, ... (n) partner-wallet beta); every reference is shifted
one letter to match the now-merged sequence (Propagation/bootstrap is
(e), discovery/convergence is (f), and so on through (o)).

### 26.1 Propagation completeness

§21(e)/(f) **Propagation/bootstrap + discovery/convergence** are not
complete until they also demonstrate:

- late-joining-node catch-up / anti-entropy;
- partition healing;
- delivery of revisions/tombstones created while a node was offline;
- stale-resurrection prevention after local compaction/garbage
  collection.

> **New-event gossip ≠ Network convergence over time.**

### 26.2 Node discoverability and compatibility

§21(e)/(h) are not complete until a peer can self-authenticate the
minimum information required to decide whether interaction is safe.
**Precision (2026-09-09, CTO Gate, final institutional precision
pass):** this is a Node Descriptor, advertised by the operator/
deployment to other nodes — it concerns **Operational Sails Node
Identity (C, §26.3)**, which does not exist today, not **Participant
Transport Identity (B, §21(b))**, which does. §21(b)'s own closure does
not satisfy this list:

- Operational Sails Node Identity (C) — not yet designed, see §26.3;
- reachable endpoint/transport information;
- compatible protocol/wire version;
- relevant enabled capabilities;
- relevant settlement rails with disclosed maturity/custody posture;
- applicable node fee/policy disclosure;
- freshness/expiry of that advertisement.

No central node registry is authorized.

> **Node discoverability ≠ Node authority.**

### 26.3 Node identity lifecycle

**Correction (2026-09-09, CTO Gate, final institutional precision
pass):** §21(b)'s "persistent node identity" describes **Participant
Transport Identity (B)** — a protocol concept, not an operational
node/deployment identity — currently represented, in this reference
implementation only, by a `peerId` associated locally through
`ownerUserId`. Neither `peerId` nor `ownerUserId` is a protocol format;
a conforming implementation on a different stack needs only the
underlying property (a stable, participant-scoped transport identity),
not these identifiers. Calling B "node-level identity" without
qualification invites exactly the collapse this section exists to
prevent. See `docs/DAY0_COMPLETENESS_COLD_SWEEP.md` §3.5 for the full
four-way taxonomy freeze (A Participant Economic Identity / B
Participant Transport Identity / C Operational Sails Node Identity / D
Operator Economic Recipient), reproduced here:

> **A ≠ B ≠ C ≠ D.** Participant Transport Identity (B, §21(b)) is a
> different property from Operational Sails Node Identity (C, this
> section) — B's persistence does not, and cannot, produce C. **C does
> not determine D**: one operator may run several C instances, but node
> cardinality does not by itself fix how many economic recipients (D)
> that operator has — that is a policy choice, not a fact derivable from
> C. A node's own operational key (C) may rotate or be rebuilt without
> automatically redefining D's entitlement; D's own policy must not
> grant C's operational authority. C and D must not be assumed to use
> the same key. No canonical single term covering both C and D is
> adopted.

Before production, C — once it exists — must define bounded behavior
for backup, loss, compromise, rotation/replacement and superseded-key
distrust. No mechanism, no key format, no recipient model, and no
mapping between C and D, is selected or authorized here.

### 26.4 Network-view resilience

§21(e)/(f) and §21(l)'s no-cannibalization evidence must include
adversarial topology, not only honest topology:

- selective forwarding;
- one malicious bootstrap/relay peer;
- attempted eclipse/isolation;
- alternate honest paths;
- peer diversity/rotation sufficient to avoid one operator defining a
  node's entire market view.

No perfect censorship-resistance claim is created.

### 26.5 Resource safety

A valid signature proves authorship, not economic relevance. Gossip
implementation must have explicit, testable resource bounds for message
size, ingress rate, duplicate/revision cache growth, tombstone
retention, malformed messages, signature-verification amplification,
peer count and backpressure.

Formal Sybil resistance remains separately tracked exactly as §7
already states.

### 26.6 Clock-dependent expiry

`revision` ordering remains clock-independent as already frozen.
`expiresAt`, however, is evaluated against local time. Production node
operation must therefore define a bounded clock-health expectation and
visible degraded/fail behavior for materially incorrect clocks.

No global clock or consensus-time mechanism is introduced.

### 26.7 Node switching / operator independence evidence

§21(j)/(m)/(o) are not complete if a wallet can technically connect to
another node but loses its economic continuity when doing so.

Evidence must establish that node switching does not inherently erase
or redefine:

- participant identity;
- signed trade-open anchors;
- portable evidence;
- historical economic rights;
- access to the same reachable liquidity universe.

Local policy and locally-computed reputation scores may differ.

### 26.8 Independent node-operator test

Add an operator-side evidence gate alongside Stranger Node and Stranger
Developer:

> A competent independent operator, with no private Satsails assistance,
> can deploy, configure, join, observe, upgrade, back up, recover and
> safely stop a conformant Sails Node using only public supported
> artifacts.

This is a **Day-0 operational decentralization property**, not merely
documentation polish.

### 26.9 Production service event consumption

§13's outbound-webhook deferral remains valid for the first partner beta,
but it is not a production waiver. Before public production, a
backend/service integrator must have a documented recoverable way to
consume economically relevant state changes without relying on a
best-effort WebSocket session that can lose continuity.

No delivery mechanism is selected by this ADR correction.

### 26.10 Added evidence cases

The evidence program must now explicitly include:

1. Late Join Test.
2. Partition Heal Test.
3. Tombstone Resurrection Test.
4. Malicious Selective Forwarding Test.
5. Eclipse / Bootstrap Diversity Test.
6. Node Descriptor Authenticity / Staleness Test.
7. Wire-Version Mismatch Test.
8. Node-Key Rotation / Compromise Test.
9. Node Switch / Economic Continuity Test.
10. Gossip Resource-Exhaustion Test.
11. Clock-Skew / Offer-Expiry Test.
12. Independent Node Operator No-Assistance Test.

These are implementation/evidence consequences of the already-accepted
architecture, not a new topology model.

**BACKLOG DELTA:** DETECTED AND SYNCED in `docs/BACKLOG.md`.


## 27. Exact economic binding correction (2026-09-09)

This correction **does not change the topology decision**. It tightens
what the already-selected signed Offer + jointly-signed trade-open model
must cryptographically bind.

### 27.1 OfferEnvelope rail/network completeness

The original §3 minimum field table listed `asset` but omitted the
existing `Offer.network` semantic dimension. For a multi-rail protocol,
that is too weak.

Correction:

> A signed OfferEnvelope must commit to the canonical network/rail
> semantics whenever `asset` alone does not uniquely identify the
> economic settlement domain.

Preserved:

> **Asset identity ≠ Network identity ≠ Settlement-provider identity.**

The exact future identifier vocabulary is not selected by this
correction. The requirement is only that two conformant implementations
cannot verify the same Offer signature while silently interpreting the
rail differently.

### 27.2 Trade-open anchor must commit to the accepted revision/terms

The original §8 shorthand described the jointly-signed trade-open
handshake as `logicalOfferId + mutually-derived tradeId`. Read
literally, that is insufficient: two parties could know the same logical
offer while holding different revisions/terms.

Correction:

> A trade-open anchor must cryptographically commit both parties to one
> exact economic proposal.

Directly or by committing to the canonical OfferEnvelope hash, the
joint signature must bind:
- `logicalOfferId`;
- exact accepted revision / OfferEnvelope hash;
- trade amount;
- agreed price/quote;
- asset;
- network/rail semantics;
- payment-method/fiat-side semantics required for the deal;
- mutually-derived `tradeId`;
- replay/idempotency context sufficient to prevent one acceptance from
  producing multiple logical trades.

Preserved:

> **Offer Discovery ≠ Trade Acceptance.**

> **Offer Identity ≠ Accepted Offer Revision.**

> **Trade ID ≠ Economic Terms.**

No global Trade replication or central lock service is introduced.

### 27.3 Concurrent acceptance

§13/§21(i)'s local inventory-reservation obligation must be evidenced in
the cross-node case as well: two buyers racing a single-fill or
capacity-limited Offer through different nodes/devices must not commit
the seller beyond the owner's signed availability.

The future evidence set must include:
- competing trade opens against one Offer;
- stale-revision acceptance attempt;
- duplicate/replayed trade-open handshake;
- owner-node migration/reconnect during the race.

The owner remains the authority over acceptance. This correction does
not select a global lock mechanism.

**BACKLOG DELTA:** DETECTED AND SYNCED.


## 28. Real-money agreement and dispute-authority correction (2026-09-09)

This correction preserves the accepted signed-gossip / pairwise-trade
topology and tightens the economic commitment that §27 already began to
formalize.

### 28.1 Fiat-side obligation

Before a fiat-side payment becomes binding, the jointly-verifiable
trade agreement must freeze:
- exact fiat denomination;
- exact fiat amount;
- payment method;
- a verifiable commitment/reference to the payment destination.

Raw payment details remain private/pairwise. The commitment need not
publish the PIX key or bank account network-wide.

> **Payment destination commitment ≠ Public payment destination.**

> **Chat Instruction ≠ Economic Authority.**

A post-commit payment-instruction change is a new authenticated economic
amendment, never merely a chat message.

### 28.2 Settlement mechanism binding

§27's exact trade-open commitment must additionally bind the actual
settlement/custody contract the parties accepted. Where applicable this
includes the selected EscrowType/provider capability, network/rail,
custody posture, signer/approval requirements, economically relevant
finality policy and required refund/dispute capability.

A node may not silently substitute another provider after commitment.

> **Interface uniformity ≠ Security uniformity.**

### 28.3 Fee/policy binding

Any participant-facing fee that can become an economic obligation must
be disclosed and frozen before commitment: payer, basis and applicable
policy/version at minimum. Later node/policy rotation may not
retroactively reinterpret the trade.

> **Fee discovery ≠ Fee obligation.**

### 28.4 Cross-node dispute authority

Current implementation chooses/assigns arbitration through local
deployment state. That behavior is not sufficient as the authority
model for an independent multi-node trade.

Frozen Day-0 property:

> **Dispute Hosting Node ≠ Arbitration Authority.**

The trade/settlement agreement must establish the applicable
arbitration authority/policy and appeal semantics before funds are
economically committed. Both sides must be able to verify the same
authority, evidence, ruling and appeal round without treating either
operator's private database/config as protocol truth.

A node-local configuration change after trade-open cannot alter the
already-agreed dispute authority.

Preserve:

> **Arbitration Policy ≠ Node Local Configuration once a trade is committed.**

> **Ruling Attribution ≠ Funds Authority.**

No universal arbitration model is selected by this correction. Existing
rail-specific arbiter commitments and signed `DisputeOutcome` /
authority evidence are reusable evidence patterns, not proof that the
cross-node property already exists.

### 28.5 §21 sequencing consequence

The obligatory sequence must treat the following as part of the
trade-open / settlement path before Stranger Node / Partner Wallet
evidence can pass:

- fiat amount/currency/payment-destination commitment;
- settlement mechanism/custody binding;
- fee/policy commitment;
- cross-node arbitration-policy/authority commitment;
- cross-node dispute evidence/ruling availability and failover.

**BACKLOG DELTA:** DETECTED AND SYNCED.
