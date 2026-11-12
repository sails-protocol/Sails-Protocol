# RFC-021: Market-Based Arbitration — Reputation-as-Collateral, Payment-Account Trust Ramp, and Escalation

## Summary

RFC-007 D4 gave OpenSettlement its Dispute escalation order and a real
`ArbitrationProvider` interface, but the only shipped implementation
(`TrustedArbitratorProvider`, `arbitration-provider.ts`) is a **static,
application-configured allowlist** (`TRUSTED_ARBITRATORS` env var,
round-robin assignment) — the application decides who is allowed to
arbitrate, not the market. That was a deliberate, disclosed stub (its
own header: "Simple round-robin assignment across the configured
trusted-arbiter list") and it is exactly the kind of stub the project
owner has now directed be replaced with production reasoning ahead of
the Tether grant MVP deadline.

This RFC replaces that stub's *selection mechanism* with a
permissionless, reputation-and-collateral-weighted market, while
**keeping RFC-007 D4's escalation order and `ArbitrationProvider`
interface shape intact** — this is a new implementation of an existing
interface, not a redesign of the Dispute primitive. It also adds a
second, independent trust mechanism this RFC's own research surfaced
as necessary for the PIX/fiat-rail reality of this protocol's actual
use case: **payment-account trust ramping**, a defense against
chargeback/mule-account fraud that reputation-of-trader alone does not
cover.

**Status:** Proposed — formal acceptance (`GOVERNANCE.md` §6A review
step) has not happened yet, though as of 2026-08-02 every phase in
"Reference Implementation Plan" below (D1 through D9, no remaining
deferred item) is implemented, tested, and committed; "Proposed"
describes governance status, not build status — see that section for
what's actually real. Synthesized from a design session between the
project owner, an external developer (Yuri, via 8 transcribed voice
messages, 2026-07-29), and this session — grounded against real
precedent (Kleros, Bisq's `Payment account age witness`/account
signing, Bisq Easy's burned-BSQ reputation) rather than invented from
nothing. Explicitly follows the project owner's own stated engineering
philosophy for this RFC (paraphrased): *document known residual risk
honestly rather than claim false closure — not everything is solved,
some things (like the oracle problem) have no known closed-form
solution — and still ship the most elegant layered mitigation
available now, calibrated so the attack is theoretically possible but
practically irrational, the same "possible in theory, basically never
happens" character as many Bitcoin-network attacks.*

**Classification:** Core RFC (`GOVERNANCE.md` §6A) — changes the
trust/custody model of Dispute resolution, the same category RFC-019
and RFC-020 were classified under for Settlement.

## Motivation

Three real, concrete problems, in the order the design session
surfaced them:

1. **`TrustedArbitratorProvider` doesn't scale past one operator's
   trust decisions.** A protocol positioning itself as a P2P
   marketplace SDK (not a company that vets arbitrators) needs
   arbitration supply the market can grow on its own, not a hand-typed
   env var.
2. **Legal exposure.** If arbitration means "a designated party moves
   your money," the operator/arbiter inherits real legal
   susceptibility for every disputed outcome. This has to be
   architected away, not disclaimed away.
3. **Chargeback fraud on the PIX/fiat rail specifically.** A buyer can
   pay with a stolen or "warmed-up" mule bank account; the seller
   releases crypto on a real-looking PIX confirmation, then the
   original account holder reverses it with their bank. Trader
   reputation (built from trade history) does not, by itself,
   distinguish a legitimate payment account from a fraudulent one used
   for the first and only time.

## Alternatives Considered

- **Pure stake-weighted juror selection (Kleros's actual model).**
  Rejected as the sole mechanism. Verified directly against Kleros's
  own documentation before proposing this: juror-draw probability is
  proportional to staked PNK alone, with no reputation dimension — "an
  attacker needs >50% of the scarce resource used to determine voting
  weight" is Kleros's own stated Sybil-resistance bound. That is
  exactly the "money = power" outcome the project owner explicitly
  rejected in this design session. Kleros's **appeal-round structure**
  (escalating jury size and cost) is kept — see D6 — but its
  plutocratic selection weighting is not copied.
- **A small, DAO/community-curated arbiter set (Bisq's actual
  historical model).** Rejected as the sole mechanism for the same
  reason RFC-007 D4 already rejected a protocol-native "Guardião"
  role: it re-centralizes who gets to arbitrate, which is precisely
  what "the market decides, not the wallet or the protocol" (project
  owner, this session) rules out.
- **Reputation and collateral as two separate, exchangeable
  currencies with a conversion rate.** Considered and rejected in
  favor of D3 below: a conversion-rate model invites gaming the
  exchange rate itself. Making reputation *itself* a slashable asset
  (the same "at risk" property collateral already has) avoids needing
  an exchange rate at all.
- **Trusting trader reputation as sufficient defense against payment
  fraud.** Rejected once the design session reached the PIX-specific
  chargeback scenario — trader reputation answers "has this identity
  behaved well," not "is this specific bank account legitimate and
  unlikely to be reversed." These are different risks needing
  different mechanisms (D3 vs. D5).

## Decision

### D1 — Arbiter role redefined: reputation attestor, not fund mover

An arbiter's `resolveDispute()` call does not move funds. It never
did, structurally — `dispute.service.ts`'s real `resolveDispute()`
already writes `Dispute.ruling` first, and it is *that write* which
`escrowService.releaseFunds()`/`refundFunds()` react to, not direct
arbiter custody (verified by reading `dispute.service.ts` directly
before writing this RFC, not assumed). **This RFC does not change that
code path — it formalizes it as an explicit design principle**, because
it is the load-bearing fact that limits an arbiter's legal exposure to
a narrow, factual claim ("I reviewed this dispute and attest Party X
was in the right") rather than "I am the entity that moved your
money." Every interface and doc description of `ArbitrationProvider`
going forward must preserve this framing.

### D2 — Permissionless arbiter registration

Replaces `TrustedArbitratorProvider`'s static list. Any participant may
self-register as an arbiter candidate by posting collateral (D3) —
no protocol or application approval step, matching "nem a carteira e
nem o protocolo irá decidir quem tem poder de arbitro" (project owner,
this session). **Implemented** (RFC-021 Phase 1):
`MarketArbitrationProvider.register()`/`eligibleFor()`/`assign()`
(`market-arbitration.provider.ts`), gated behind
`config.settlement.arbitrationMode = 'market'` (`'trusted-list'`
remains the default — this is an opt-in per deployment, not an
automatic upgrade).

**Hardening fix, Missão 04 (2026-08-15) — a real, previously-open gap:**
permissionless registration is only safe under the unstated but obvious
invariant "an arbiter is not a party to the dispute it arbitrates."
Neither `assign()` nor `assignAppealPanel()` ever enforced that — a
trade's own buyer or seller could register enough collateral to clear
D3's `K_ELIGIBILITY` threshold for their own trade's value and had a
real, non-zero chance of being weighted-random-selected to arbitrate
(or sit on the appeal panel for) their own dispute.
`resolveDispute()`'s only authorization check is
`dispute.arbiterId === arbiterId`, trivially true for a self-assigned
arbiter — a real, unilateral path to a favorable RELEASE/REFUND/SPLIT
ruling with none of RFC-015's two-person control (which arbitration is
deliberately exempt from, on the assumption the arbiter is neutral —
this bug broke that assumption). Fixed at the source: `eligibleFor()`
now takes an `excludeParticipantIds` list, and both `assign()` and
`assignAppealPanel()` populate it with the disputed trade's own
`buyerId`/`sellerId`, looked up from the dispute's own persisted
`tradeId` (not trusted from a caller-supplied parameter). Not live by
default (`arbitrationMode` defaults to `'trusted-list'`), so no
production deployment was ever exposed — found and closed before
`market` mode's first real use, not after. Tests:
`tests/marketArbitrationProvider.test.ts`'s "excludes the disputed
trade's own buyer and seller" cases (both `assign()` and
`assignAppealPanel()`).

### D3 — Reputation as slashable collateral, eligibility scaled to dispute value

Not two currencies with an exchange rate — one property (*"has skin in
the game that can be lost"*) expressed two ways:

```
effectiveStake(candidate) = monetaryCollateral(candidate)
                           + reputationAtRisk(candidate)
```

- `monetaryCollateral` — BTC/USDT posted into escrow for this
  arbitration role, refundable only if never slashed. **Corrected
  (Issue #255, 2026-09-22):** this line described the intended design,
  not the shipped code. `MarketArbitrationProvider.register()` (called
  from `POST /v1/settlement/arbitration/register`) accepts
  `monetaryCollateral` as a bare, caller-declared decimal string —
  there is no deposit txid, no on-chain lock, no escrow, and no funding
  verification of any kind anywhere in this codebase. `slash()`
  likewise only ever decrements this same internal `ArbiterProfile`
  column; there is no external seizure/burn to perform. Real economic
  consequences DO flow from the declared number regardless (the
  eligibility/selection/appeal-panel weighting below is real code, not
  aspirational) — which is exactly why Issue #255 classifies this
  capability as **not economically backed** and refuses to boot with
  `ARBITRATION_MODE=market` in production
  (`arbitration-policy.ts`'s `assertMarketArbitrationCollateralProductionEligible()`)
  until a real funding/custody adapter exists. Safe as a deliberate
  dev/test/sandbox capability, same as `MOCK` escrow already is; never
  safe as something a production deployment treats as real, verified
  stake.
- `reputationAtRisk` — a portion of the candidate's accumulated
  arbiter-reputation score, converted to an "at-risk" value. Reputation
  is not free to lose: a veteran arbiter with little capital but years
  of non-overturned rulings has that history itself on the line, the
  same way Bisq Easy's burned BSQ is unrecoverable capital that *is*
  the reputation, not separate from it (verified against Bisq's own
  docs — the BurningMan mechanism converts burned BSQ directly into
  standing, it is not a parallel score). **Implemented** (RFC-021 Phase
  1, `market-arbitration.provider.ts`) as
  `reputationAtRisk = arbiterReputation × REPUTATION_STAKE_FACTOR`, a
  flat tunable constant (starting `0.01`) — simpler than "using the
  same cost-to-fabricate floor D4 defines," which this RFC originally
  proposed but the real implementation does not do; `cumulativeFeesObserved`
  (D4) and `reputationAtRisk` (D3) ended up as two independent inputs
  the code never mixes, not one derived from the other. Corrected here
  to match the shipped code, not the other way around.
- **Eligibility scales to the disputed amount**: `effectiveStake ≥ k ×
  disputeValue` for a protocol/market-tunable `k`, the same
  underwriting-ratio logic real bonding/insurance already uses. This
  is what lets a low-capital, high-reputation arbiter compete for
  small-to-medium disputes broadly, while large disputes require deep
  capital, deep reputation, or both — professional escalation emerges
  from the math, not from anyone appointing "senior" arbiters.
  **Implemented** (Phase 1) with `k` = `K_ELIGIBILITY`, starting `1.5`.
- **Slashing**: an overturned ruling (D6 appeal process) burns a
  portion of `effectiveStake` — this is what makes honest ruling the
  individual-best-response strategy (a Schelling point), the one part
  of Kleros's mechanism design this RFC does keep, decoupled from its
  plutocratic selection weighting. **Implemented** (RFC-021 Phase 2,
  `MarketArbitrationProvider.slash()`): forfeits
  `SLASH_COLLATERAL_FRACTION` (starting `0.5`) of posted collateral
  plus a fixed reputation penalty (`OVERTURNED_PENALTY`, starting
  `-10`, floored at 0). **Corrected (Issue #255):** "posted collateral"
  here means the same declared, not-economically-backed
  `monetaryCollateral` column — see the D3 correction above; this is an
  internal `ArbiterProfile` decrement, not an external seizure.

### D4 — Cost-to-fabricate floor (fee-based reputation lower bound)

A concrete, calculable mechanism from the design session's own
transcript (Yuri, audio 06), not invented independently: a
counterparty's positive reputation "bag" can always be assumed
worst-case (entirely Sybil — the trader paid fees to themselves in a
loop to inflate it). Even under that assumption, the **cumulative
protocol fees** the account paid to build that history are a real,
provable lower bound on what it cost to fabricate. If
`cumulativeFeesObserved(candidate) > k × currentTradeValue`, faking the
reputation would have cost more than the current trade is worth
scamming — which makes the fabrication economically irrational under
the same worst-case assumption.

**Corrected 2026-07-29 (RFC-021 Phase 0/3 implementation):** this
section originally claimed fee collection was "already wired via
existing settlement flows" and that `cumulativeFeesObserved` composed
directly into D3's `reputationAtRisk`. Neither was true when written —
verified against the real code before implementing, not assumed:
`src/core/policy-engine.ts`'s `FeePolicy` was a literal
`throw new Error('Not yet implemented')` stub, and no fee was ever
computed anywhere in `escrow.service.ts`. Real fee collection needed to
be built first (**Phase 0**, resolving that stub) before this floor
could be anything but a formula — `config.settlement.protocolFeeRate`
(code default `0` for safety — no production env should ever charge a
fee by silent fallback; see the 2026-08-11 note below for what the real
production value is), `Escrow.feeCharged`, and a `FeeDistribution` row
recording the same Node Operator/Treasury/Wallet Rebate/Arbitrator
Reserve split `PROTOCOL_ECONOMY.md` §6.2 already decided — this RFC
reuses that accepted economics, it does not re-derive new percentages.
`User.cumulativeFeesObserved` (**Phase 3**) now accrues real
`Escrow.feeCharged` on every completed trade
(`common/events/handlers.ts`'s `settlement.escrow.released` reaction);
`ArbiterProfile.cumulativeFeesObserved` accrues the same, per-arbiter,
via `MarketArbitrationProvider.recordRuling()`. Both are real,
queryable numbers now (`reputation.service.ts`'s `getScore()` exposes
the trader-side one) — and both stay `0` for any deployment that
doesn't set `PROTOCOL_FEE_RATE`, which is the honest number for that
deployment, not a bug.

**Added 2026-08-11:** the split cited above was 40/30/20/10 when this
correction was originally written (2026-07-29); `PROTOCOL_ECONOMY.md`
§6.2 revised it to 35/30/25/10 (Wallet Rebate/Node Operator/Treasury/
Arbitrator Reserve) — see that document for the reasoning. Separately,
the "bootstrap-phase Protocol Fee is OFF" framing this correction
originally cited no longer describes the plan: `PROTOCOL_ECONOMY.md`
§3 now has the fee active at 0.40% from Day 0 rather than after a
12-month grace period. The code default stays `0` regardless (a safety
default, not a phase marker) — production deployments are expected to
set `PROTOCOL_FEE_RATE=0.004` explicitly from launch. **D3 correction:** `cumulativeFeesObserved`
does **not** compose into `reputationAtRisk` in the shipped code — see
D3's own correction above; the two ended up as independent signals, not
one feeding the other.

**Known limitation, stated plainly (Yuri, audio 07 and 08):** this
floor grows slowly relative to trade size (many small fee-paying
transactions are needed before the floor exceeds a meaningful trade
value), and it cannot bootstrap a brand-new keypair from zero — see D7.

**Wired for real, 2026-08-04 — into D6 only, deliberately not into D3:**
until this pass, `cumulativeFeesObserved` was real (accrued from actual
`Escrow.feeCharged` data) but never actually *read* anywhere except a
read-only profile display — verified via a real grep across `src/`
before writing anything, not assumed. The formula above
(`cumulativeFeesObserved(candidate) > k × currentTradeValue`, `k = 1`,
`COST_FLOOR_FACTOR` in `market-arbitration.provider.ts`) is now
evaluated inside `assignAppealPanel()` (D6): a candidate whose fee
history hasn't cleared the floor for the disputed value has their
reputation term zeroed for that panel's 70/30 weighting, falling back to
pure collateral. **Deliberately not folded into D3's baseline
`eligibleFor()`/`effectiveStake`** — project owner's own explicit
decision (2026-08-04): `protocolFeeRate` defaults to `0` during the
bootstrap phase, so `cumulativeFeesObserved` stays `0` for everyone
until real fee volume exists; gating ordinary first-instance eligibility
on it would zero out every reputation-heavy, low-capital arbiter's
eligibility exactly during the phase D3's "veteran with little capital
can still compete" design goal matters most. Applying the floor to the
appeal panel only targets the actual concern it exists for — a
deep-capital actor topping up cheap, unproven reputation specifically to
also dominate the reputation-weighted appeal pool — without touching
ordinary dispute resolution. 3 new tests
(`tests/marketArbitrationProvider.test.ts`), including one proving D3's
`eligibleFor()` is unaffected.

### D5 — Payment-account trust ramp (chargeback mitigation)

A separate mechanism from trader reputation, addressing a separate
risk: whether a specific payment rail (a PIX key, a bank account) is
likely to be reversed. Modeled directly on Bisq's real, shipped
mechanism — verified against Bisq's own documentation before proposing
this, not assumed:

- **Payment account age witness**: a privacy-preserving hash scheme
  lets a counterparty verify a payment account has been used before on
  this protocol, without revealing the account's real details.
- **Account signing**: after a payment account's first completed trade
  without a chargeback/reversal, a peer (initially: the assigned
  arbiter, using the same attestation framing as D1) signs it. Trade
  limits for that account start low and increase gradually with
  signed, uncontested history — mirroring Bisq's real 0.002 BTC
  starting cap that phases in fully over time.
- **Implemented** (RFC-021 Phase 4): `PaymentAccount` model in
  `prisma/schema.prisma`, `payment-account.service.ts`'s
  `hashAccountIdentifier()` (server-side SHA-256, reference/test only)
  and `@satsails/p2p-trading-sdk`'s `hashPaymentAccount()` (`@noble/hashes`, the real
  client-side path — verified byte-identical to the server's own hash
  via a dedicated cross-package test), and the trade-limit ramp
  (`UNSIGNED_TRADE_LIMIT`/`SIGNED_TRADE_LIMIT`/`ESTABLISHED_TRADE_LIMIT`/
  `TRUSTED_TRADE_COUNT`) deliberately reusing `SECURITY_MODEL.md` §1.4's
  exact tier values (0.001/0.01/0.05 BTC, unlimited) rather than a
  second, conflicting scale.

**Known limitation, stated plainly (raised directly by the project
owner, this session):** a patient attacker can "warm up" a mule/stolen
account with one small legitimate trade before using it for a larger
scam. This is not detected — it is *bounded*: the gradual limit ramp
caps the maximum possible loss at each trust tier below the realistic
cost of acquiring and warming a mule account to that tier, the same
cost-exceeds-gain argument as D4, applied to the payment rail instead
of trader reputation. High-trust, high-limit accounts remain the most
valuable target for this specific attack — an accepted residual risk,
not a solved one.

### D6 — Reputation-weighted appeal escalation

Kleros's real, genuinely good idea, kept deliberately separate from
its stake-only selection weighting (which this RFC does not copy — see
Alternatives Considered): a party dissatisfied with a ruling may
appeal to a larger panel, at increasing cost, discouraging frivolous
appeals. Unlike Kleros, the appeal panel is drawn weighted more toward
`reputationAtRisk` and less toward raw `monetaryCollateral` than the
first-instance draw — this is the mechanism's answer to the "full
nodes can refuse a majority-hashpower miner" analogy the project owner
raised: no single deep-capital actor can reliably dominate both the
first-instance draw *and* a wider, more reputation-weighted appeal
pool.

**Implemented** (RFC-021 Phase 2): `DisputeService.appeal()` reopens a
`RESOLVED` dispute (new `DisputeStatus.APPEALED`), draws the new
arbiter via `MarketArbitrationProvider.assignAppealPanel()` — panel
size `PANEL_SIZE_BASE × 2^round` (`PANEL_SIZE_BASE = 3`, Kleros's own
real starting jury size, reused for panel size only), weighted 70%
`arbiterReputation` / 30% `monetaryCollateral` within that panel, and
excludes the original arbiter. An overturned ruling triggers
`slash()` (D3); an upheld ruling slashes nothing — a denied appeal, not
a punished one. `appealFeeRequired` (`APPEAL_FEE_MULTIPLIER × ` the
escrow's already-collected protocol fee) is computed and returned but
**not yet collected** — no "pay before a ruling exists" payment
primitive is wired yet, a real, deferred gap, not a silent one (see
`docs/BACKLOG.md`).

### D7 — Bootstrap via peer vouching (real, built — corrected 2026-08-02)

**This section previously described the cold-start fix as needing "an
onboarding/KYC-optional identity-linking flow" that ships later,
out of scope.** That framing was a lazy reading of this RFC's own
draft, corrected directly by the project owner: this protocol does not
do KYC, full stop, and the real fix needed no identity-linking
infrastructure at all — see the correction below for what actually got
built.

The cold-start problem Yuri named directly (audio 08): if every
brand-new keypair starts at zero and the system always assumes
worst-case for zero-reputation parties, two new participants can never
transact with each other — real-world trust has to be able to anchor
the first transaction, the same way Bisq's own account-age witness
needs a *first* trade to establish any history at all (his own
"handshake at Anarcapulco" analogy for what that first anchor looks
like in person).

**Verified before building anything further, not assumed:** the system
does not actually block this today — a brand-new participant can
already trade with anyone, including another brand-new participant,
capped at `UNSIGNED_TRADE_LIMIT` (D5) until their account is signed.
D7 closes a real UX friction (how long a newcomer sits at the floor
limit), not a functional block — worth stating plainly so this section
isn't read as "nothing worked before this."

**The real fix: peer vouching, the same "reputation as slashable
collateral" principle from D3, extended one hop further out.** A
participant with real trade history (`MIN_VOUCHER_TRADES`, starting 3
completed trades, and positive `reputationScore`) may vouch for a
newcomer — a real `Vouch` row (`voucher.service.ts`,
`prisma/schema.prisma`'s new `Vouch` model), one per
(voucher, vouchee) pair ever, enforced at the database level. This
pre-signs the vouchee's *first* `PaymentAccount`
(`payment-account.service.ts`'s `getOrCreate()`) — skipping
`UNSIGNED_TRADE_LIMIT` entirely, straight to `SIGNED_TRADE_LIMIT`,
treating a real peer's attestation as equivalent trust to "this account
already survived one clean trade." Explicitly scoped to a genuinely
new owner's first account only — an already-established participant
adding a second payment method gets no special treatment from a vouch.

**Real skin in the game, closing the obvious two-fresh-Sybils-vouch-
for-each-other loophole:** if the vouchee's first lost dispute happens
while the vouch is still active, the voucher's own reputation takes a
real penalty (`reputation.service.ts`'s `penalizeForBurnedVouch()`,
`VOUCH_BURN_PENALTY = -5` — the same magnitude as an ordinary trade
loss, `NEGATIVE_DELTA`, deliberately lighter than an arbiter's
professional `OVERTURNED_PENALTY = -10` since vouching is a social
attestation between peers, not a paid role committing capital to
adjudicate). This is the actual Sybil defense: a real, established
account has to put its own real standing at risk to bootstrap a
newcomer — the eligibility bar alone (needing real trade history)
already keeps two zero-reputation accounts from vouching for each
other for free.

**Implemented** (2026-08-02): `Vouch` model; `vouch.service.ts`'s
`vouchFor()`/`hasActiveVouch()`/`burnVouchesFor()`;
`reputation.service.ts`'s `penalizeForBurnedVouch()` (a second,
explicitly disclosed legitimate input to `User.reputationScore`,
alongside `recordOutcome()`); `payment-account.service.ts`'s
`getOrCreate()` pre-signing check (a cross-module Prisma read, same
boundary `escrow.service.ts`'s own Trade reads already established);
`common/events/handlers.ts`'s `settlement.escrow.released`/`refunded`
reactions burn the losing party's active vouch, if any, as part of the
same dispute-aware branch that already scores `recordOutcome()`; new
route `POST /v1/reputation/vouch`; `@satsails/p2p-trading-sdk`'s `reputation.vouchFor()`.
27 new tests across `tests/vouchService.test.ts`,
`tests/paymentAccountService.test.ts`, `tests/reputationOutcome.test.ts`,
and `tests/routes.test.ts`.

### D8 — QVAC-assisted automated first-pass resolution (arbiters as a fallback, not the default)

Synthesized from a second design session (project owner + dev partners,
2026-08-02), building directly on D1's "attestor, not mover" framing
rather than introducing a new authority model: *"os árbitros só são
assionados quando não tiver mais como resolver"* — a human arbiter should
be the fallback path, not the automatic first step, for the large share of
disputes a straightforward evidence check can settle on its own. QVAC
(`qvac-agent.provider.ts`, the same real local-LLM integration
`assessIntentRisk()`/`assessSocialEngineeringRisk()` already use — not a
new dependency) gets a first, non-binding look at submitted evidence
before a dispute leans on its assigned arbiter.

**Deliberately payment-method-agnostic** (explicit project-owner
correction during this same session): earlier QVAC prompts elsewhere in
this codebase (e.g. `assessSocialEngineeringRisk()`'s own example text)
default to PIX-flavored language, a reasonable shortcut for a
Brazil-first MVP but wrong for a protocol positioned as a worldwide P2P
marketplace SDK. D8's own prompt (`DISPUTE_EVIDENCE_SYSTEM_PROMPT`) never
names a specific payment rail — it always reasons over whichever real
`PaymentMethod` enum value (`PIX`, `TED`, `BANK_TRANSFER`,
`CRYPTO_DIRECT`, `LIGHTNING_DIRECT`, `CASH`, `OTHER`) the trade actually
used, verified with a dedicated test asserting the string `"pix"` never
appears in the system prompt.

**QVAC never has decision-making power** — the exact same "attestor, not
mover" boundary D1 already draws around human arbiters, applied here to
software instead: `assessDisputeEvidence()` only ever returns a
recommendation plus a confidence score. Nothing calls
`escrowService.releaseFunds()`/`refundFunds()` directly off the back of
it. Three things must all be true before anything is even proposed:

1. Evidence actually exists (`submitEvidence()`, below — an omission is
   simply not analyzed, not treated as a signal either way).
2. The recommendation isn't `INCONCLUSIVE` — the prompt explicitly
   instructs the model that saying "unsure" is always the safer answer
   than guessing.
3. Confidence is at or above `qvacAutoResolutionConfidenceThreshold`
   (config, default `0.85`) — a real, tunable number, not a fixed
   assumption.

Even then, the recommendation is only *proposed* (`DisputeStatus.AUTO_PROPOSED`),
with a visible confidence score and reasoning, and a contest window
(`qvacAutoResolutionWindowHours`, default 24h) during which **either**
trade party can reject it (`POST .../disputes/:id/contest`) and fall back
to their already-assigned human arbiter — the same one `raiseDispute()`
already assigns immediately and unconditionally, unchanged by this
feature. If uncontested, a background sweep
(`sweepExpiredAutoResolutions()`, same `unref()`'d-interval shape the
escrow timelock sweeper already established) applies it.

**The mechanically important design constraint, found while
implementing this**: `escrowService.releaseFunds()`/`refundFunds()`
already enforce (`isSellerOrAssignedArbiter()`) that only the trade's
seller or the dispute's *own assigned arbiter* may trigger a fund
movement — `INV-OP-1`, unchanged by D2 or by this section. An automated
resolution does not, and structurally cannot, invent a new kind of
authorized caller: `sweepExpiredAutoResolutions()` applies an uncontested
recommendation using the dispute's own already-assigned human arbiter's
identity as `triggeredBy` — the exact same identity that would have
triggered it had they read the dispute and ruled personally. This is not
a workaround; it is the direct consequence of D1's framing taken
literally: the arbiter's authorized slot is exercised automatically, on
their behalf, when they don't need to personally intervene. No slashing
or `recordRuling()` happens for an auto-resolution — those track a human
arbiter's own decision-making track record (D3/D4), which is not what
took place.

**A real, disclosed limitation found during implementation, not
papered over**: a `RELEASE` ruling needs a real crypto payout address,
and — the same gap `resolveDispute()`'s own doc comment already
states — this schema stores no participant payout address anywhere. A
human arbiter calling `resolveDispute()` directly gets one supplied by
whatever route/UI called them; the automated sweep has no such caller to
ask. Rather than fabricate one from a participant id (which is not a
crypto address), `sweepExpiredAutoResolutions()` throws a clear, visible
error for a `RELEASE` recommendation specifically, leaving the dispute
`AUTO_PROPOSED` for its human arbiter to resolve normally with a real
address. `REFUND` has no such gap (it returns collateral to the seller's
own escrow) and auto-applies cleanly.

**Implemented** (2026-08-02): `qvac-agent.provider.ts`'s
`assessDisputeEvidence()`; `dispute.service.ts`'s `submitEvidence()`
(finally makes `DisputeStatus.EVIDENCE_SUBMITTED` reachable — it existed
in the schema since the Dispute primitive was first built with no code
path ever producing it), `proposeAutoResolution()` (atomic claim, same
race-protection idiom `escrow.service.ts`'s `lockFunds()` established),
`contestAutoResolution()`, and `sweepExpiredAutoResolutions()`;
`common/events/handlers.ts`'s config-gated `dispute.evidence_submitted`
reaction (lazy-`require`s both QVAC and dispute.service.ts, same reason
the existing social-engineering handler does); two new routes
(`POST .../disputes/:id/evidence`, `POST .../disputes/:id/contest`); the
sweeper interval in `app.ts` (`DISPUTE_AUTO_RESOLUTION_SWEEPER`, off by
default). Off end-to-end by default
(`QVAC_AUTO_RESOLUTION_ENABLED=false`) — a fresh deployment keeps today's
exact behavior (every dispute goes straight to its assigned human
arbiter) until explicitly turned on. 48 new tests across
`tests/qvacDisputeEvidence.test.ts`, `tests/disputeFlow.test.ts`,
`tests/qvacAutoResolutionHandler.test.ts`, and `tests/routes.test.ts`.

### D9 — SPLIT ruling: a real settlement action for §1.9's third option (2026-08-02)

`DisputeRuling.SPLIT` has existed in the schema since RFC-007's own
Dispute primitive (`PROTOCOL_SPECIFICATION.md` §1.9's "third option"),
but `dispute.service.ts`'s `applyRuling()` only ever recorded it — no
`SettlementProvider` method existed to actually move a *partial*
payout, so a SPLIT ruling changed the `Dispute` row and nothing else.
Closed for real, for the escrow types where a partial payout is
genuinely representable:

- **`MOCK`/`WDK_USDT_EVM`** — `SettlementProvider.splitFunds(escrow,
  buyerAddress, sellerAddress, buyerBps)`, a new optional interface
  method. `buyerBps` is the buyer's share out of 10000 (strictly
  between 0 and 10000 — 0 or 10000 is a REFUND/RELEASE in disguise,
  rejected rather than silently accepted); the seller gets the exact
  remainder, computed from what's left over so the two legs always sum
  to the full locked amount with no truncation dust unaccounted for.
  `WDK_USDT_EVM`'s implementation is two real, separate on-chain
  transfers (no atomic multi-recipient primitive on that provider's
  API, same constraint `releaseFunds()`/`refundFunds()` already live
  with).
- **`MULTISIG`** — the signature-collection equivalent,
  `buildUnsignedSplit()`/`finalizeSplit()`, a genuine 2-output Bitcoin
  PSBT: the 2-of-3 P2WSH script has no per-output covenant, so it
  validates a spend with two outputs exactly as readily as one. Always
  the disputed shape (SPLIT is only ever reached via
  `VALID_TRANSITIONS.DISPUTED -> 'SPLIT'`, no non-disputed happy path
  exists for it) — the arbiter pre-signs, and only **one** more
  required signer (the buyer, mirroring `buildUnsignedRelease()`'s own
  arbiter+buyer disputed pairing). This is a real constraint found
  while writing `tests/multisigProvider.test.ts`, not a design choice:
  it is still a 2-of-3 script, and `finalizeSpend()` combines
  independently-signed copies sequentially — requiring both buyer's
  and seller's copies on top of the arbiter's already-embedded
  signature yields 3 valid signatures for a threshold of 2, which
  bitcoinjs-lib correctly refuses to finalize ("Too many signatures").
  The split amounts are already fixed by the arbiter's ruling either
  way, so which single party is required is arbitrary but must be
  exactly one.
- **`SAFE_GUARD_EVM` and `LIGHTNING_HODL` do not support SPLIT — a
  real limitation of each provider's own architecture, not a missing
  wire-up**, and each throws a specific, documented error rather than
  either faking it or falling through to a generic message:
  - `SAFE_GUARD_EVM`'s `SailsEscrowSafe.sol` Transaction Guard is
    immutable once deployed: `checkTransaction()` reverts
    `WrongAmount()` unless `value == lockedAmount` exactly, checked
    against the constructor's own immutable `releaseTo`/`refundTo`/
    `lockedAmount`. Confirmed by reading the actual deployed contract
    source (`contracts/contracts/SailsEscrowSafe.sol`) before writing
    this, not assumed from the escrow type's name — that guard is the
    entire non-custodial guarantee (no server/arbiter can ever
    redirect this Safe's funds anywhere else), so there is no
    transaction it will ever authorize for a partial amount. A real
    SPLIT here needs a genuinely different guard contract (new
    constructor shape, new `checkTransaction()` logic, new bytecode/
    CREATE2 address) — a separate contracts-side undertaking, out of
    this pass's scope.
  - `LIGHTNING_HODL` (really Arkade/Ark VTXO-Taproot, not a literal
    BOLT11 hold invoice — see `lightning-hodl.provider.ts`'s own header
    comment) has a *different* real limitation, found by reading its
    actual `VtxoScript` construction rather than assumed from the
    escrow type's Lightning-sounding name (an earlier draft of this
    section wrongly reasoned from generic hold-invoice semantics —
    corrected here once the real code was read): its `VtxoScript` has
    exactly three **fixed 2-of-2** leaves (buyer+seller, buyer+arbiter,
    seller+arbiter) — a spend must pick one leaf and provide exactly
    that leaf's two signatures. A disputed SPLIT needs the arbiter's
    signature to be enforceable without both parties' voluntary
    cooperation (the same property that makes a disputed release/
    refund work today), but no leaf lets the arbiter co-sign a payout
    to *both* buyer and seller at once — `buyerArbiter` excludes the
    seller, `sellerArbiter` excludes the buyer, `buyerSeller` excludes
    the arbiter entirely. Fixing this for real needs a genuinely new
    leaf/script construction (e.g. a 3-key threshold leaf), not
    attempted here.

**Reputation/Trade/Intent classification for a completed SPLIT** — a
real, disclosed judgment call (made with the project owner, 2026-08-02):
`Trade.status`/`IntentStatus` only have binary terminal states (no
partial-outcome value exists in either enum), so a SPLIT is classified
as `Trade.status: 'COMPLETED'`/`Intent: 'FULFILLED'` (real funds did
leave the escrow via a real settlement action, the same trigger a
RELEASE's own classification rests on) with **both parties scored
NEUTRAL** (RFC-007 D9's "always Neutral, never Negative" precedent,
applied here since a SPLIT ruling means the arbiter found both sides
share the outcome, not that one clearly lost) and **no vouch burned on
either side** (RFC-021 D7's vouch-burn reaction only fires on a clear
dispute loss — applying it to a SPLIT would misrepresent an outcome
that isn't one). New `EscrowStatus.SPLIT` (terminal, only reachable
from `DISPUTED`), new `settlement.escrow.split` event, new
`EscrowPendingTransaction.toAddressSecondary` column (the seller's
payout address, alongside the existing `toAddress` for the buyer's,
only populated for `kind: 'split'`).

**A second, unrelated bug found and fixed while building this**:
`applyRuling()` previously called `escrowService.releaseFunds()`/
`refundFunds()` unconditionally for every escrow type — those throw
"not directly callable" for `MULTISIG`/`LIGHTNING_HODL`/
`SAFE_GUARD_EVM` (client-held keys), meaning a disputed RELEASE/REFUND
on those three escrow types could never actually resolve through
`resolveDispute()` at all before today; never caught because no test
exercised `resolveDispute()` against a non-`MOCK`/`WDK` escrow. Fixed
uniformly for all three rulings, not just SPLIT — a signature-collection
type now routes through `initiateRelease()`/`initiateRefund()`/
`initiateSplit()` instead, consistent with how the cooperative
(non-disputed) path already works for these types.

`resolveDispute(disputeId, arbiterId, ruling, releaseToAddress?,
refundToAddress?, splitBuyerBps?)` — the two new trailing parameters
are additive per `docs/API_STABLE.md`'s own freeze commitment, required
only when `ruling === 'SPLIT'`. New route body fields
(`refundToAddress`, `splitBuyerBps`) on the existing
`POST /v1/settlement/disputes/:id/resolve`. 26 new tests across
`tests/escrowReleaseControls.test.ts`, `tests/escrowProviderWiring.test.ts`,
`tests/multisigProvider.test.ts`, `tests/lightningHodlProvider.test.ts`,
`tests/safeGuardEvmProvider.test.ts`, `tests/disputeFlow.test.ts`,
`tests/reputationOutcome.test.ts`, `tests/fullTradeLifecycle.test.ts`
(a real end-to-end SPLIT resolution through the actual event chain, not
just mocked service-level dispatch), `tests/routes.test.ts`, and
`packages/sails-sdk/tests/modules.test.ts`.

### D10 — `GET` escrow/dispute reads require authentication + party/arbiter authorization (Missão 06.8, 2026-08-16)

**Previous behavior.** `GET /v1/settlement/escrow/:id` and
`GET /v1/settlement/disputes/:id` (`settlement.routes.ts`) shipped as
public reads, no session required — an inline code comment, never
elevated to an RFC decision, reasoning "read by id needs no auth" the
same way a few other coarse-status routes in this codebase do. That
reasoning didn't actually fit these two: the escrow route's own
`findByIdWithDetails()` query includes `disputes: true`, and the dispute
route returns `Dispute.reason`/`Dispute.evidence` directly — real,
free-text content describing the actual conflict between two named
parties, potentially containing PII, not a coarse status field.

**Risk discovered.** Missão 06.7's full route-authorization audit found
this: anyone who knew or merely guessed an `escrowId`/`disputeId` (both
UUIDs, but not otherwise access-controlled) could read another pair's
private dispute reasoning and evidence descriptors, no authentication at
all. The same class of exposure D6's amendment above closed for the
Proof Bundle (Missão 06.6) — found separately, by the same audit, and
disclosed as a known-open finding until this pass closed it.

**New rule.** Both routes now require `requireAuth`, and only three
actors may read the result: the trade's buyer, its seller, or — new,
not previously checked anywhere for a *read* — the dispute's own
assigned arbiter (`Dispute.arbiterId`), when a dispute exists on that
escrow. A non-assigned arbiter (or any other authenticated outsider)
gets the same `403` a stranger would — this mirrors the boundary
`resolveDispute()` already enforces for arbiter *actions* (D1 above:
"reputation attestor, not fund mover" — the arbiter's authority is
scoped to the disputes actually assigned to them, never a caller-claimed
`arbiterId`), applied here to the read path for the first time. No new
primitive: the buyer/seller comparison reuses the same inline pattern
`trade.routes.ts`/`chat.routes.ts` already use; the arbiter check reads
`Dispute.arbiterId` (escrow route: from the escrow's own already-loaded
`disputes` array, no extra query) or compares directly (dispute route).

**Not changed:** the response shape for an authorized reader — same
`Escrow`/`Dispute` fields as before, this is purely an access-control
fix, not a data-minimization one. `POST /v1/settlement/disputes` (list,
already `requireAuth` + scoped to the caller's own `arbiterId` since the
2026-08-03 UI-audit gap fix) and every write action on these resources
were already correctly authorized before this amendment — only the two
bare-`GET`-by-id reads changed.

## Known Risks — Mitigated, Not Solved

Stated explicitly and separately, per this RFC's own governing
principle: these are not closed. They are bounded enough that
exploiting them is economically irrational in the common case, the
same "theoretically possible, practically never happens" character
Bitcoin's own well-known theoretical attacks have.

1. **Capital-based Sybil** (an actor with very deep pockets buying
   enough `effectiveStake` to dominate selection). No known closed-form
   solution exists in any reviewed precedent, including Kleros. D3's
   per-dispute stake cap (mitigating, not eliminating, how much weight
   one funding source can hold) and D6's reputation-weighted appeal
   pool bound the *damage*, not the *possibility*.
2. **Warmed mule accounts** (D5's own stated limitation above).
3. **Slow bootstrap efficiency** (D4/D7's own stated limitation —
   Yuri, audio 07: "é uma evolução lenta").
4. **Market ticket-size self-limiting effect, noted as a real
   mitigating factor but not a mechanism this RFC builds**: the
   project owner observed that P2P markets naturally concentrate large
   trades with already-reputable counterparties (parties who already
   know each other skip arbitration-dependent flows entirely), which
   shrinks the population of accounts valuable enough to be worth
   attacking. This is a real, structural dampener but is an emergent
   market property, not something D1–D7 enforce directly — stated here
   so it isn't silently relied upon as if it were.
5. **QVAC calibration drift (D8)**: `qvacAutoResolutionConfidenceThreshold`
   is a starting number (`0.85`), not one validated against real-world
   outcome data yet — an under-tuned threshold could auto-propose
   resolutions more often than warranted, or (the safer failure
   direction) rarely enough that D8 barely reduces arbiter load at all.
   The contest window is the actual backstop against the first failure
   mode (either party can always force human review), not the confidence
   number itself — stated so the threshold isn't mistaken for a solved,
   precisely-calibrated value.
6. **A collusive buyer+seller pair could in principle try to game D8's
   automation** (e.g. submitting evidence crafted to read as a clear
   match when it isn't) to avoid a human arbiter's scrutiny entirely.
   Bounded, not eliminated, the same way D3's Sybil mitigation is
   bounded: both parties would need to actively cooperate against their
   own dispute (unlike an ordinary dispute, where the two parties are
   adversarial by definition) — a narrower, higher-coordination-cost
   attack than ordinary reputation fabrication, but not impossible.
7. **D7 vouching, worst case**: an established account with real
   reputation could spend it deliberately, vouching for a sockpuppet it
   controls and accepting the `VOUCH_BURN_PENALTY` hit as a cost of
   doing business, if the newcomer's inflated trust tier lets it scam a
   counterparty for more than the reputation lost is worth. Bounded the
   same way D4's cost-to-fabricate floor bounds trader reputation
   generally: the voucher's own real, accumulated reputation is what
   gets spent, not a free action, and `SIGNED_TRADE_LIMIT` (D5) is
   itself a real, capped ceiling — the newcomer isn't jumping to
   `unlimited`, only past the floor. Not a closed-form solution, the
   same disclosed character as every other risk in this section.
8. **D9's SPLIT coverage is real but partial, by architecture, not
   oversight**: two of the five escrow types (`SAFE_GUARD_EVM`,
   `LIGHTNING_HODL`) cannot represent a partial payout at all today —
   an arbiter presiding over a dispute on one of those two escrow types
   is limited to RELEASE or REFUND, an all-or-nothing outcome, even
   when the facts genuinely warrant a split. Closing this for
   `SAFE_GUARD_EVM` needs a new Guard contract variant; closing it for
   `LIGHTNING_HODL` needs a new VtxoScript leaf construction — both
   real, separate, contracts/protocol-level undertakings, not service-
   layer wiring, and neither is attempted by this RFC.

## Specification

`ArbitrationProvider` (RFC-007 D4) keeps its existing shape —
`arbitrators: string[]`, `assign(disputeId, tradeId): Promise<string>`
— as the interface `DisputeService` depends on
(`dispute.service.ts` needs no change to its own logic). This RFC adds
a new implementation alongside `TrustedArbitratorProvider`, not a
breaking change to it:

**Implemented (Phases 0-4), shipped shape — the sketch above this
correction was written before implementation and has drifted; this is
the real, current interface, not a plan:**

```typescript
// src/modules/open-settlement/arbitration-provider.ts — unchanged base
// interface, three new OPTIONAL methods (TrustedArbitratorProvider
// implements none of them).
interface ArbitrationProvider {
  name: string
  arbitrators: string[]
  assign(disputeId: string, tradeId: string): Promise<string>
  assignAppealPanel?(disputeId: string, tradeId: string, round: number, excludeParticipantId?: string): Promise<string>
  slash?(participantId: string): Promise<unknown>
  recordRuling?(participantId: string, feeObserved?: string): Promise<void>
}

// market-arbitration.provider.ts
interface ArbiterCandidate {
  participantId: string
  monetaryCollateral: string   // decimal string, RFC-009
  collateralAsset: string | null
  arbiterReputation: number
  effectiveStake: number       // monetaryCollateral + arbiterReputation * REPUTATION_STAKE_FACTOR
}

class MarketArbitrationProvider implements ArbitrationProvider {
  register(participantId: string, monetaryCollateral: string, collateralAsset?: string): Promise<ArbiterCandidate>
  getProfile(participantId: string): Promise<ArbiterCandidate | null>
  eligibleFor(disputeValue: string): Promise<ArbiterCandidate[]>
  assign(disputeId: string, tradeId: string): Promise<string>
  assignAppealPanel(disputeId: string, tradeId: string, round: number, excludeParticipantId?: string): Promise<string>
  slash(participantId: string): Promise<ArbiterCandidate>
  recordRuling(participantId: string, feeObserved?: string): Promise<void>
}

// dispute.service.ts
class DisputeService {
  appeal(disputeId: string, requestedBy: string): Promise<{ dispute: Dispute; appealFeeRequired: string }>
}
```

`ArbiterProfile` (collateral, arbiter-specific reputation, slash
tracking) and `PaymentAccount` (D5's age-witness hash, signed status,
trade-limit-relevant counters) both exist in `prisma/schema.prisma` and
extend `User`, not replace it. **`docs/DATABASE.md` does not document
either model yet** — a real, tracked gap (`docs/BACKLOG.md`), not
implied covered here.

## Backward Compatibility

- `INV-OP-1` (`PROTOCOL_INVARIANTS.md`: only the trade's buyer/seller
  or the dispute's *assigned* arbiter may trigger release/refund) is
  unchanged — this RFC changes how an arbiter becomes assigned and
  what backs their authority, not who is authorized to act once
  assigned.
- `TrustedArbitratorProvider` is not removed. A deployment may keep
  using it (e.g., for a closed/regulated context that wants a curated
  list) — `MarketArbitrationProvider` is a new, additional
  implementation of the same interface.
- **Correction (2026-07-29):** `Dispute`'s Prisma fields **did** change
  — D6's appeal flow needed real state to reopen a resolved dispute:
  `DisputeStatus` gained `APPEALED`; `Dispute` gained `appealRound Int`,
  `previousRuling DisputeRuling?`, `previousArbiterId String?`. No
  change to `DisputeRuling`'s own values or `EvidenceDescriptor`
  (`packages/sails-p2p-schemas/src/dispute.ts`) — this correction is
  scoped to what actually changed, not a broader reversal.

## Reference Implementation Plan

**Status as of 2026-07-29: all five phases below are implemented and
committed** (Phase 0 real fee collection → Phase 1 D1-D3 → Phase 4 D5 →
Phase 2 D6 → Phase 3 D4, the actual build order — not the same order
D1-D7 are numbered in, since D5/Phase 4 was independent and D4/Phase 3
needed Phase 0's fee data flowing first). This section originally read
as a punch list before any of it existed; kept below with real ✅
status per this repo's convention (`docs/DEVELOPER_JOURNEY.md`) so the
history of what was proposed vs. what shipped stays visible, not
overwritten.

0. ✅ Real Protocol Fee collection — resolved `policy-engine.ts`'s
   disclosed `FeePolicy` stub (a genuine prerequisite this RFC
   surfaced, not originally one of D1-D7): `config.settlement.protocolFeeRate`
   (code default `0`, production expected to set `0.004`), `Escrow.feeCharged`,
   `FeeDistribution` (the real 35/30/25/10 split `PROTOCOL_ECONOMY.md`
   §6.2 already decided — revised 2026-08-11 from the original 40/30/20/10).
1. ✅ `ArbiterProfile` Prisma model + `register()`/`eligibleFor()`/
   `assign()` (D1-D3) — `market-arbitration.provider.ts`, gated behind
   `config.settlement.arbitrationMode`.
2. ✅ `slash()` + `assignAppealPanel()` + `DisputeService.appeal()`
   (D6) — built after (1), a real stake to slash.
3. ✅ D4's `cumulativeFeesObserved`, both the trader-side
   (`User.cumulativeFeesObserved`, wired from Phase 0's real fee data)
   and arbiter-side (`ArbiterProfile.cumulativeFeesObserved`, via
   `recordRuling()`'s `feeObserved` parameter) — built after Phase 0
   gave it a real data source, exposed via `reputation.service.ts`'s
   `getScore()`.
4. ✅ `PaymentAccount` model + age-witness hash + account signing (D5)
   — `payment-account.service.ts` (server reference hash) + `@satsails/p2p-trading-sdk`'s
   `hashPaymentAccount()` (the real client-side path).
5. ✅ D7's peer vouching (2026-08-02, corrected from the earlier
   "external onboarding/KYC-optional flow" framing — this protocol does
   not do KYC) — `Vouch` model, `vouch.service.ts`'s
   `vouchFor()`/`hasActiveVouch()`/`burnVouchesFor()`,
   `reputation.service.ts`'s `penalizeForBurnedVouch()`,
   `payment-account.service.ts`'s pre-signing check, the
   `settlement.escrow.released`/`refunded` burn reaction, new route
   `POST /v1/reputation/vouch`.
6. ✅ D8's QVAC-assisted automated first-pass resolution (2026-08-02) —
   `assessDisputeEvidence()`, `submitEvidence()`/`proposeAutoResolution()`/
   `contestAutoResolution()`/`sweepExpiredAutoResolutions()`, the
   config-gated event reaction, two new routes, the sweeper interval.
   Off end-to-end by default.
7. ✅ D9's SPLIT settlement action (2026-08-02) — `splitFunds()`/
   `buildUnsignedSplit()`/`finalizeSplit()` for `MOCK`/`WDK_USDT_EVM`/
   `MULTISIG`; a documented, specific rejection for `SAFE_GUARD_EVM`/
   `LIGHTNING_HODL` (real per-provider limitations, not gaps); the
   `applyRuling()` signature-collection dispatch fix for RELEASE/REFUND/
   SPLIT alike.

**Every phase in this section is now implemented** — D1 through D9, no
remaining deferred item. **Resolved since this section was last
updated:** D6's `appealFeeRequired` is now really collected, not just
computed (`DisputeAppealFee` model, 2026-08-01) — `resolveDispute()`
settles its outcome (FORFEITED/REFUNDED). Still tracked separately
(`docs/BACKLOG.md`, `docs/DATABASE.md`'s own §2 note):
`docs/DATABASE.md` does not yet document
`ArbiterProfile`/`PaymentAccount`/`DisputeAppealFee`/`Vouch`.
