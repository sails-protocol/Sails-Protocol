# RFC-022: Arbiterless Reputation on a Lightning Substrate

**Status:** Draft — proposed for the open Discussion window
(`GOVERNANCE.md` §5). Provenance, stated plainly: this RFC did not
originate from a CTO directive (RFC-007's path) nor from an audit finding
(RFC-009/010/011's path) — it was drafted by an incoming contributor
(Yuri da Silva Villas Boas) from design sessions on the decentralization
target for Sails OpenReputation, before his engagement start date, and is
submitted for discussion, not recorded as accepted. Originally drafted as
RFC-020 on its own branch; renumbered to RFC-022 after upstream `main`
claimed RFC-020 (non-custodial EVM settlement) and RFC-021 (market-based
arbitration + payment-account trust ramp) — renumber only, no content
change. Related provenance, disclosed rather than left implicit: RFC-021
records that it was synthesized partly from the same contributor's
transcribed voice notes (2026-07-29) — its D4 cost-to-fabricate fee floor
(audio 06), its slow-bootstrap limitation (audio 07), and its D7
cold-start requirement (audio 08) are earlier, narrower forms of ideas
this RFC develops systematically. This draft is the follow-through on
that same design line, not a competing proposal: RFC-021 shipped the
arbitration market and the payment-account ramp *inside the reference
server*; this RFC specifies the decentralized floor those mechanisms can
eventually stand on. Nothing here is merged into
`PROTOCOL_SPECIFICATION.md` or any other document; no runtime behavior
changes. Like RFC-018 and RFC-019, this RFC registers a target
architecture and an incremental path — it does not implement it.

**Registered 2026-08-15** (Claude Code, engenheiro-chefe): filed as a
Draft in `rfcs/` per `GOVERNANCE.md` §5's own rule that every RFC —
accepted, rejected, or still under discussion — gets a permanent number
and a file, never left unrecorded. Content below is verbatim from the
author's own PR #24 (`Yuri-SVB`, branch
`feat/LN-toolkit-for-decentralized-portable-reputation`); no edits to
substance. Acceptance/rejection is a product/CTO decision still pending
discussion, not made by this registration.

## Summary

`NODE_ARCHITECTURE.md` §1 lists "Reputation Nodes — anyone validates the
public reputation graph; consensus via protocol rules, not a central
authority." No document specifies the mechanism, and today's real
implementation is a Postgres score computed inside the reference server
(RFC-007 D8/D9, now extended by RFC-021's arbiter profiles and
payment-account ramp — all still server-resident). This RFC proposes the
mechanism, built from five decisions that reinforce each other: (1) **no
protocol-native arbiter at the floor** — disputes are never individually
adjudicated by the protocol; contested trades penalize both endpoints
symmetrically and dishonesty separates *statistically* across independent
counterparties (arbitration — curated or RFC-021's market — remains the
opt-in application layer above); (2) **evidence is the crypto leg only**
— settled volume, provable default, and the releasing signature as an
irrevocable attestation that the counter-leg arrived; the fiat rail is
never the evidence, the *ordering* of the crypto leg is; (3) **reputation
matures** — volume vests only after the payment method's reversal window,
so reversal scams never credit reputation and rails self-price by
reversibility; (4) **trust is size-indexed** — a completed trade of size
`s` is evidence only of honesty *at* `s` (threshold model), so exposure is
capped at β × the counterparty's matured high-water mark, which bounds
laddered exit-scams and, as a by-product, answers cold-start endogenously
(newcomers enter at the bottom rung, no bond, no gatekeeper); (5) **the
metric is viewer-relative max-flow** over the volume-capacity graph at
the deal's size ("altitude"), so sybil rings are inert — their flow from
any honest vantage is capped by the real, settlement-paid edges crossing
the honest/sybil cut.

The substrate proposal: most of this machinery already exists in
production as the **Lightning Network**. A channel funding transaction is
a settlement-priced edge; channel age is on-chain-verifiable maturation;
channel capacity is a *physically enforced* altitude cap; splicing is a
verifiable rung-climb; justice transactions are slashing; hold invoices
are bonds; invoice+preimage is a native settlement receipt; pathfinding at
amount S is an operational altitude-S connectivity query. What Lightning
cannot carry is the judgment layer — an LN edge means capital, not trust —
so the protocol adds only a thin overlay: **co-signed trade receipts**
(2-of-2 attestations by both counterparties, bound to `tradeId` and
settlement proof), kept bilaterally private and disclosed on demand.
Channels supply the capital-verified skeleton; receipts fill it with
matured trade history; flow composes across both.

## Motivation

Five unresolved problems in the current reputation design, none of which
the Postgres implementation can address even in principle:

1. **The decentralization mechanism is unspecified.** "Anyone validates
   the public reputation graph" has no storage model, no sync model, no
   consensus rule anywhere in the handoff docs. RFC-013 correctly
   assigned reputation computation to Sails OpenReputation (not Pears,
   not QVAC) — but computed *from what*, held *where*, once there is no
   central Postgres, is open. RFC-021 deepened the server-side model
   (arbiter profiles, `cumulativeFeesObserved`, payment-account ramp)
   without changing where it lives — by design, since its scope was the
   arbitration market, not the substrate.
2. **Selective disclosure.** Any design where the subject presents their
   own history fails: signatures prove authenticity, never completeness.
   A scammer simply omits the negatives. Append-only logs alone don't fix
   it (keep a second, clean log).
3. **Sybil and whitewashing.** Signed reviews are free to mint; abandoned
   identities are free to replace. Reputation must be priced in something
   real, and the price must be forfeited on identity abandonment.
   RFC-021 D4 (from this same design line, audio 06) shipped the first
   such price — cumulative protocol fees as a worst-case
   cost-to-fabricate floor; this RFC generalizes the principle from fees
   to matured, size-indexed settled volume.
4. **The fiat leg is unprovable.** A crypto↔fiat trade's dispute is
   almost always about the leg with no cryptographic settlement — "she
   says the PIX never arrived." A unilateral accusation is
   indistinguishable from slander, which is why RFC-007 D4 needed Trusted
   Arbitrators and RFC-021 built the arbitration market. But arbiters —
   curated or market-selected — are still trusted parties per dispute;
   the decentralized target needs a floor that functions with *zero*
   trusted parties, above which arbitration remains an application
   choice. (RFC-021 D5 attacks the adjacent risk — whether a *payment
   account* will be reversed — at the rail level; D3 below is its
   edge-level counterpart, and the two compose.)
5. **Privacy.** A public review graph is a trade-surveillance graph: who
   traded with whom, how much, when. For a protocol whose stated users
   include people avoiding custodial surveillance, publishing the full
   social graph of trade is self-defeating.

## Alternatives Considered

**A global reputation score, server-computed (status quo).** Rejected as
the *normative* model for the same reason RFC-019 reclassified
`WdkSettlementProvider`: fine as reference implementation, but it makes
the operator a trusted party for the exact signal that is supposed to
protect users *from* trusted parties. Kept as the Phase-0 reference
implementation (Backward Compatibility below).

**Subject-presented signed history ("reputation bags").** Rejected —
selective disclosure (Motivation 2). No completeness proof exists for
self-custodied history; the mechanism runs on omission, and no
append-only cleverness closes it.

**Public DHT review graph with witness nodes (CT-style log-head
gossip).** Workable — this was the design's previous iteration — but
rejected as the primary substrate on three grounds: it requires new,
dedicated availability infrastructure (witnesses, seeders) whose
incentives must be designed from scratch; censorship-resistance of
negative reviews becomes load-bearing engineering; and it publishes the
trade graph (Motivation 5). The Lightning substrate obtains the priced
skeleton from infrastructure that already exists and is already paid for,
and keeps history bilateral by default.

**Proof-of-personhood for sybil resistance.** Rejected on values and
threat model: imports KYC-flavored gatekeeping into a protocol whose
constituency includes exactly the people such systems exclude or endanger.

**Linear volume as the edge metric.** Rejected — the laddering exit-scam.
Under a threshold adversary model (trade honestly until one trade's
temptation exceeds θ, then defect), a thousand 1-unit trades prove θ > 1
a thousand times and say nothing about θ > 1000. Linear aggregation
invites building cheap small-trade reputation and defecting at size.

**A global EigenTrust-style scalar.** Rejected in its *global* form — a
single number is a farmable target and requires global computation.
Accepted in its viewer-relative form: the max-flow metric below is the
same trust-propagation idea, seeded at the verifier, with the min-cut
bound as the explicit sybil defense.

## Decision

**D1 — No protocol-native arbiter at the floor; statistical
adjudication.** Both parties to a trade MAY file a signed review of it.
Concordant positives credit the edge. Conflicting reviews mark the trade
**disputed**: its volume counts against the edge *for both endpoints*,
with no determination of fault. Honest traders accrue scattered disputed
marks; scammers accrue disputed marks with many independent
counterparties — the graph pattern separates them, no judge required.
False accusation is automatically priced (the slanderer takes the same
disputed mark). Consequence accepted openly: per-trade justice is
sacrificed for systemic accuracy — a victim gets deterrence and
detection, not restitution. Restitution remains exactly where RFC-007 D4
and RFC-021 put it: bonds, escrow, and arbitration — whether the curated
`TrustedArbitratorProvider` list or RFC-021's permissionless
reputation-and-collateral market — at the application layer, *above*
this floor. RFC-021 D1's framing (an arbiter is a reputation attestor,
never a fund mover) is not merely compatible with this floor — it is
what makes the composition coherent: an arbitrated ruling enters the
fold as one more signed attestation, weighted by the arbiter's own
standing, never obeyed as authority. This RFC amends neither RFC-007 D4
nor RFC-021.

**D2 — Evidence is the crypto leg, exclusively.** Every reputation-bearing
record binds to a `tradeId` (which already commits to both parties'
signed offer/acceptance) and to the crypto leg's settlement proof. Three
consequences: (a) *volume is uniformly settlement-priced* — every unit of
edge weight cost real fees and float, in crypto-crypto and crypto-fiat
trades alike; (b) *default is provable* — "no payment to the committed
address by deadline" is an on-chain-checkable fact, so dead trades take a
small symmetric breakage mark (blame unassignable, statistics apply);
(c) *release is attestation* — because the crypto leg moves last in the
canonical fiat flow, the releasing party's settlement signature is their
signed, irrevocable statement that the counter-leg arrived. They cannot
later claim the fiat never came; the chain holds their own signature
against it. The fiat leg is never evidenced by the fiat rail — it is
evidenced by the crypto rail's ordering.

**D3 — Maturation.** Settled volume credits an edge only after the
trade's payment method's reversal window elapses (`paymentMethod` is
already a first-class offer field; each method carries a maturation
period `Δ_m` — near-zero for irreversible rails, days for bank rails,
~120 days for cards). A reversal-triggered negative filed inside the
window converts pending volume to disputed instead of credited. Reversal
scammers therefore bank *zero* reputation from scam trades, and payment
rails self-price by reversibility — irreversible rails build trust fast,
reversible rails slowly, with no one legislating which rails are "risky."
The review deadline and the maturation window are one boundary: the
moment after which a trade can no longer change. This is the edge-level
counterpart of RFC-021 D5's payment-account ramp (Bisq account-age
witness lineage): D5 ramps trust in a *rail account*, D3+D4 ramp trust in
a *counterparty edge*; both apply the same underwriting logic, and
implementations SHOULD keep their tier values consistent with
`SECURITY_MODEL.md` §1.4, which RFC-021 D5 already reuses.

**D4 — Size-indexed trust (the ladder).** An edge tracks two statistics
serving two distinct risks: its **matured high-water mark** (largest
trade completed and vested — the evidence against *betrayal*, per the
threshold model) and **count/consistency** (the evidence against
*breakage*: operational reliability, temporal spread, survived reversal
windows). Applications SHOULD cap exposure to a counterparty at
**β × matured high-water mark** on the relevant path (β ≈ 1.5–2).
Consequences: laddered exit-scams are bounded — stealing X requires first
honestly settling ≈ X/(β−1) of matured volume, serialized over
rungs × Δ_m of wall-clock time — and cold-start is answered
endogenously: a new identity enters at the bottom rung and climbs. No
bond, no vouching authority, no gatekeeper; entry is permissionless and
merely gradual. Wash economics are taxed in both shapes: many small fakes
burn per-transaction fees; single large fakes burn capital-time under D3.
Relationship to RFC-021, stated precisely: RFC-021 D4's
`cumulativeFeesObserved` (audio 06 of the same design line) is the
shipped, narrow form of this cost-to-fabricate principle — protocol fees
as a worst-case floor, with its acknowledged limitations (slow growth,
audio 07; zero at bootstrap while no fee is economically active; Corrected/Implemented 2026-11-27: the `protocolFeeRate` setting named here was retired and fees are now a global `FeePolicyVersion`). This D4
generalizes the floor from fees to matured settled volume, indexed by
size — and where RFC-021 D7 registered cold-start as a requirement for
*external* trust anchors (a vouch, a signed introduction), the ladder is
the *endogenous* complement: external anchors can seed a starting rung;
the ladder climbs from there. The two compose rather than compete.

**D5 — Viewer-relative max-flow at altitude.** A's trust in B for a
prospective deal of size S is the **max-flow from A to B** in the graph
whose edge capacities count only matured volume from trades of size
comparable to S (weight `min(s/S, 1)^γ`, γ ≥ 1; γ→∞ recovers the hard
ladder). Computed by A, seeded at A; there is no global score anywhere in
the protocol. The min-cut bound is the sybil defense: a fabricated ring
adds zero flow from any honest vantage unless real, settlement-paid,
matured edges cross the honest/ring boundary. Flow capacity is
deal-sized — the output is not a rating but a limit: "accept this offer
up to X."

**D6 — Lightning as the reference substrate.** The mapping, stated as the
design's load-bearing observation:

| This RFC's requirement | LN-native object |
|---|---|
| Settlement-priced edge creation (D2a) | Channel funding transaction — on-chain fee + locked capital, publicly verifiable |
| Maturation clock (D3) | Channel age in blocks since funding confirmation |
| Physically enforced altitude cap (D4) | Channel capacity — an HTLC larger than the channel cannot exist; splicing = an on-chain-verifiable rung-climb |
| Slashing provable misbehavior | Justice transactions (deployed, battle-tested) |
| Bonds (application layer, D1) | Hold invoices (production-proven by RoboSats) |
| Settlement receipt (D2) | Signed invoice + payment preimage — native proof-of-payment |
| Altitude-S connectivity query (D5) | Pathfinding/probing at amount S |
| Identity keys | Node pubkeys (secp256k1, same key infrastructure) |

What LN does *not* carry — and the discipline this RFC imposes on the
idea — is judgment: an LN channel means capital, not trust; routing nodes
open channels to strangers for fee income, and HTLC atomicity means
routed flow carries zero counterparty risk. LN is therefore the perfected
infrastructure of the *provable* half (D2's half), and it cannot speak to
the unprovable half that reputation exists for. Hence:

**D7 — The two-tier graph and the co-signed trade receipt.** The overlay
that carries judgment is deliberately thin:

- **Physical edges (channels):** standing, capital-backed relationships —
  market makers, repeat counterparties, the high-altitude backbone.
  Capacity, age, and splice history form the on-chain-verifiable
  skeleton. Capacity *qualifies* an edge; it never fills it.
- **Virtual edges (receipts):** every completed trade — including one-off
  multi-hop trades with no direct channel — produces a **TradeReceipt**:
  a 2-of-2 statement co-signed by both counterparties binding
  `{tradeId, settlement proof, amount, paymentMethod, outcome,
  timestamps}`. Receipts are counterparty-signed (not self-serving),
  independently verifiable, and survive channel closure (the channel was
  their venue, never their custodian). Receipts, matured per D3, are what
  fill edge capacity for D5's flow computation.
- **Privacy default:** receipts are held bilaterally and disclosed on
  demand to a specific verifier — selective disclosure of *positives* is
  the honest party's prerogative and harms no one (D2 makes absence of
  disclosed history simply "no trust," never "hidden negatives" — the
  metric leans on provable presence-of-good, not unprovable
  absence-of-bad). ZK presentation ("I hold co-signed matured receipts
  totaling ≥ X at altitude ≥ S") is a natural later refinement, not a
  dependency. Trading identity MAY be a key distinct from the LN node
  key, bound once by cross-signature (each key signs the other, committed
  into the first receipt) — the same identity↔settlement binding pattern
  D2 already requires per-trade.
- **Portability (anti-lock-in), proposed objective (Corrected/Implemented 2026-11-27: not implemented or demonstrated; the current score is node-local, and `peerId` is a transport key, not the portability mechanism):** reputation binds to the user-held
  identity key, never to a wallet account — a user carries their full
  matured history into any wallet that speaks this protocol. The
  mechanism is **delegation, never key export**: the identity key signs
  an authorization for the new wallet's session key (the same
  cross-signature pattern above); the root key never moves between apps,
  so portability adds no custody surface, and a compromised wallet burns
  a revocable delegate, not the identity. The tier split is what makes
  this real: receipts (judgment) are independently-signed objects that
  survive wallet death and channel closure; channels (capital) are
  rebuildable infrastructure, re-opened from any wallet. Portability does
  not reopen whitewashing — disputed marks ride the same identity the
  positives do, and abandoning it forfeits the matured high-water mark
  D4 makes expensive to rebuild, so the incentive is to *keep* the
  identity. Ecosystem consequence: no wallet can hold users hostage on
  switching costs, which is exactly why every wallet can integrate
  without a per-wallet reputation cold start — the network effect accrues
  to the protocol layer, not to any operator, consistent with RFC-013's
  portable identity via peerId and with the project's stated purpose of
  dismantling, not re-creating, lock-in.

**D8 — Temporal anchoring via RFC-008's `TimestampAnchor`.** A receipt
embeds a recent Bitcoin block hash (provably created *after* that block)
and is anchored through a `TimestampAnchor` adapter (provably existing
*before* the anchor, unalterable since) — RFC-008's construct, reused
unchanged, policy-gated by value exactly as RFC-008 specifies. Reviews
and receipts are valid only if their provable creation window falls
within `[settlement, settlement + Δ_m]`; every verifier applies this rule
independently in the fold. This closes retroactive tampering and
"reputation time-bombs" (hoarding silent negatives to detonate at a
chosen moment), and makes an identity's history stable — auditable once,
not re-litigated forever.

## Implementation Impact

None in this pass. Like RFC-018 and RFC-019, this RFC registers the
target architecture and the migration shape. No schema change, no config
flag, no runtime behavior change ships with acceptance of the draft. The
reference server's Postgres reputation (RFC-007 D8/D9 scoring, RFC-021's
arbiter profiles and payment-account ramp) continues unchanged as the
Phase-0 reference implementation.

## Primitives Used or Extended

- **`ReputationScore` / Outcome scoring (RFC-007 D8/D9)** — extended
  conceptually: outcomes become derivable from receipts; the asymmetric
  win/loss scoring for arbitrated disputes remains, as the
  application-layer path above D1's floor.
- **`ArbitrationProvider` (RFC-007 D4) / `MarketArbitrationProvider`
  (RFC-021)** — unchanged. Arbitrated rulings enter the fold as signed
  attestations weighted by the arbiter's standing (D1); the market's
  slashing and appeal mechanics are unaffected by this RFC.
- **`cumulativeFeesObserved` (RFC-021 D4)** — reusable, unchanged, as an
  additional worst-case floor input to edge weighting during Phase 0–1,
  before receipt volume exists.
- **`TimestampAnchor` (RFC-008)** — reused unchanged (D8).
- **`SettlementProvider`** — source of the settlement proofs D2 binds to.
- **`TransportProvider` (RFC-002)** — receipt disclosure runs over
  whatever transport the application uses; nothing here re-couples the
  protocol to Pears or to LN's own transport.
- **TradeReceipt** — a new *evidence object*, deliberately evaluated
  against the primitive test (`PROTOCOL_SPECIFICATION.md` §1.10–1.11) and
  NOT proposed as a primitive: it is a signed record two Participants
  produce about a Trade, the same category as RFC-007's
  `EvidenceReference`, which was likewise rejected as a primitive.

## Principle Alignment

- **Non-custodial:** nothing in this design holds user funds or keys; the
  substrate's capital is the users' own channels.
- **Infrastructure Neutral:** LN is the *reference* substrate, behind the
  same reasoning RFC-002 applied to Pears — the receipt/fold/flow rules
  are substrate-independent; Liquid-leg or on-chain-leg trades produce
  receipts with no channel underneath, and the virtual tier carries them.
- **No token:** trust is denominated in settled sats and blocks, not in a
  protocol asset.
- **Progressive decentralization:** Phase 0 is the current server; each
  phase moves judgment outward without a flag-day.
- **Interoperable, anti-moat:** reputation is a user-portable asset
  (D7, Portability), so no wallet accrues lock-in from it — wallets
  compete on service while the trust network compounds at the protocol
  layer, which is the moat structure the project's thesis calls for.
- **Tether-stack coherence:** Taproot Assets brings USDT to LN channels,
  so the substrate extends to the stablecoin legs central to Satsails'
  market without new machinery.

## Specification

```typescript
// The co-signed receipt — the only new wire object this RFC introduces.
interface TradeReceipt {
  tradeId: string            // commits to signed offer + acceptance (both parties' keys)
  amount: string             // decimal string, RFC-009 — crypto-leg denominated
  paymentMethod: string      // determines maturation window Δ_m
  settlementProof: SettlementProofRef  // txid | invoice+preimage | Liquid ref
  outcome: 'COMPLETED' | 'DISPUTED' | 'DEAD'
  notBefore: BlockRef        // recent block hash embedded at signing (D8)
  anchor?: TimestampAnchorRef // RFC-008 anchor, policy-gated by value
  sigA: string               // both counterparties sign the identical record
  sigB: string
}
```

**Fold rules (every verifier, independently):** reject receipts whose
creation window falls outside `[settlement, settlement + Δ_m]`; volume is
*pending* until `settlement + Δ_m`, then credits; a conflicting review or
reversal inside the window converts pending → disputed (counts against
both endpoints); dead trades (signed commitment + provable non-settlement
by deadline) take a small symmetric breakage mark; time-decay applies so
trust is a flow, not a stock. Arbitrated rulings (RFC-021) enter as
attestations weighted by the ruling arbiter's own standing — an input to
the fold, never an override of it.

**Edge state (per identity pair):** matured volume, matured high-water
mark, count, first/last timestamps, disputed volume, breakage count.
Physical-edge data (capacity, age, splices) qualifies; receipts fill.

**Query (assessment of B by A, deal size S):** collect candidate paths
(direct receipts, disclosed receipt bundles from intermediaries, channel
skeleton); weight each receipt `min(s/S, 1)^γ`; compute max-flow A→B;
cap acceptable exposure at `min(flow, β × B's matured high-water on the
path)`. Bounded-depth is sufficient — flow beyond a few hops is
negligible by construction.

**Threat notes (named here so reviewers don't have to):** capacity ≠
consent — leased/bought channels with no matured receipts score as
skeleton only; identity linkage between trading history and routing
liquidity is mitigated by the D7 key separation and unannounced channels;
the residual unprovables (blame in dead trades, in-window reversals) are
exactly the statistically-adjudicated set, and the theft they can
underwrite is bounded by D4's ladder — maximum extraction ≤ (β−1) ×
honestly matured volume, serialized in wall-clock time.

## Backward Compatibility

Fully additive. The Postgres reputation of the reference server remains
the Phase-0 implementation, reclassified the way RFC-019 reclassified
custody: reference, not normative. RFC-007 D8/D9 scoring, RFC-007 D4
arbitration, and every RFC-021 mechanism (market registration, slashing,
appeals, payment-account ramp, `cumulativeFeesObserved`) keep their
current semantics unchanged. No existing API changes;
`GET /v1/reputation/...` continues to serve the server-computed score
until later phases exist.

## Reference Implementation Plan

- **Phase 0 (server, low risk):** generate co-signed `TradeReceipt`s for
  completed trades alongside the existing outcome recording — both
  signatures already transit the server today (RFC-019's documented
  custody reality), so this is bookkeeping, not new trust. Store,
  don't yet serve.
- **Phase 1:** receipt disclosure endpoint + client-side fold/verify;
  maturation windows per `paymentMethod` (tier values consistent with
  `SECURITY_MODEL.md` §1.4, per RFC-021 D5's precedent); D4 exposure
  caps surfaced in the SDK as advisory limits.
- **Phase 2:** LN identity binding (cross-signed node/trading keys),
  channel-skeleton ingestion, altitude probing; `TimestampAnchor`
  anchoring of receipt batches.
- **Phase 3 (target):** bilateral receipt custody in user wallets,
  server drops out of the reputation path entirely — the "Reputation
  Nodes" row of `NODE_ARCHITECTURE.md` §1 becomes: *any node that folds
  disclosed receipts by these rules*.

Not started. 🔲
