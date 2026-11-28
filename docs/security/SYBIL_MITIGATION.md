# Sybil Mitigation Strategy

Fase 1 (Red Team), Task 4 — a strategy document, not an implementation.
Nothing below is claimed as built unless explicitly marked ✅. See
`docs/whitepapers/*.md` for the Proven/Commitment/Planned discipline
this document follows.

## 1. What Exists Today

✅ **Proven** — `THREAT_MODEL.md` §1 already documents the baseline:
reputation is tied to real trade volume
(`src/modules/open-reputation/reputation.service.ts`), so a fake
identity starts at zero score and zero trust limit. The scoring itself
is real and asymmetric on purpose:

- `recordOutcome()` is the *sole* input to `User.reputationScore` — a
  `POSITIVE` outcome adds `+2`, a `NEGATIVE` outcome (a lost dispute)
  subtracts `-5`. The asymmetry is deliberate: a participant who
  Sybils several clean, low-value trades to build score cannot "wash"
  one high-value scam with one good trade — the loss costs more than
  two wins recover.
- `rate()` (1–5 star ratings) is informational only, never mixed into
  `reputationScore`, and is already gated: one rating per
  `(tradeId, raterId)` (`@@unique` constraint), and the rater/rated
  pair must actually match the trade's real buyer/seller — a
  gap-audit fix already closed the version of this that let anyone
  rate a trade they had no part in (`reputation.service.ts`'s own
  comment on `rate()`).
- `disputeCount / totalTrades` is a real, live-computed dispute rate
  (`getScore()`), not a static field — a Sybil identity that starts
  losing disputes can't hide that ratio behind a raw score number.

📋 **Planned, no code exists yet** — everything below this line. This
document exists specifically because none of it does.

> **Corrected/Implemented 2026-11-27 (historical delimitation):** this describes the state when the document was written. One related mechanism has since been implemented: a burned vouch costs the voucher 5 score points (RFC-021 D7, `reputation.service.ts`, `vouch.service.ts`), and `recordOutcome()` is no longer the only path that changes the score. The graph analysis and the other planned items below remain without code.

## 2. Graph Analysis — Detecting Sybil Clusters

**The gap:** nothing today looks *across* trades to notice that
`user-A`, `user-B`, and `user-C` only ever trade with each other,
building reputation in a closed loop with no real counterparty risk.

**Direction:** a periodic (not real-time) batch job over `Trade`
(`buyerId`, `sellerId`, `createdAt`) building a counterparty graph per
participant. Signals worth scoring, not yet a specific algorithm
commitment:

- **Closed triangles/small cliques** — a set of accounts trading
  almost exclusively within itself.
- **Shared infrastructure fingerprints** — same `PearNode` bootstrap
  timing patterns, same IP ranges at the HTTP layer (available today
  via Fastify's request logging, not currently aggregated for this
  purpose).
- **Timing correlation** — trades between two accounts settling within
  seconds of each other, repeatedly, is consistent with one operator
  controlling both sides.

This is squarely QVAC's stated role (`ARCHITECTURE.md`: "any module can
request... fraud detection... locally, without cloud dependency") —
`THREAT_MODEL.md` §1 already names "coordinated rating groups: same IP,
same timing, circular trades between colluding accounts" as a future
QVAC capability for the adjacent Reputation Manipulation threat. Graph
analysis for Sybil clustering is the same capability applied one layer
up, at the trade-counterparty level rather than the rating level, and
should reuse whatever QVAC integration that work builds rather than
becoming a second, parallel detection path.

## 3. Staking — Skin in the Game

**The gap:** creating a new identity costs nothing today —
`POST /v1/identity/participants` requires only a public key
(`identity.service.ts`), no bond, no fee, no proof of anything.

**Direction:** an optional, protocol-level `stakedAmount` a new
participant can lock (via the same `SettlementProvider` abstraction
escrow already uses — no new custody model needed, since Constitutional
Invariant 2 forbids the protocol from custodying funds outside that one
existing abstraction) that:

- Raises the initial trust limit faster than volume-only reputation
  would allow, in exchange for capital genuinely at risk.
- Is slashable — a portion forfeit on a lost dispute where the losing
  party's evidence indicates bad faith (not merely losing an
  ambiguous dispute), reusing `dispute.service.ts`'s existing
  arbiter-ruling mechanism rather than inventing a second one.

This is explicitly optional, not a KYC-style gate — Constitutional
Invariant 3 (`docs/whitepapers/PROTOCOL_PAPER.md` §8) keeps custody of
keys with the participant; staking must not become a backdoor into
custody of anything else.

## 4. Time Decay

**The gap:** `reputationScore` only ever moves via explicit
`recordOutcome()` calls — a score earned once in 2024 counts exactly
the same in a leaderboard query today as one earned yesterday.
`getLeaderboard()` (`reputation.service.ts`) orders by raw
`reputationScore` with no time weighting at all.

**Direction:** weight `recordOutcome()`'s contribution by recency —
either a scheduled decay job that reduces `reputationScore` toward a
floor over time absent new activity, or (simpler, no new scheduled
job) compute a time-weighted score at read time from
`ReputationEvent`/`EscrowEvent` history rather than the single
accumulated `Float` column, the same shift `SDK_GUIDE.md`'s
`ReputationScore` breakdown (`tradeScore`/`volumeScore`/
`settlementScore`) already implies this service will eventually need
regardless of Sybil mitigation specifically. This directly closes a
real Sybil angle: an identity that farms reputation once and then goes
dormant (having extracted whatever trust limit it needed) should not
keep that trust indefinitely.

## 5. Counterparty Diversity

**The gap:** `getScore()`/`getLeaderboard()` have no concept of *who*
a participant traded with — 100 trades against 100 different
counterparties and 100 trades against the same one counterparty score
identically today.

**Direction:** a diversity component (distinct-counterparty count over
total trade count) as an explicit factor either gating trust-limit
increases or displayed alongside `reputationScore`, so a Sybil ring's
low diversity is visible even before graph analysis (§2) flags it
outright — a cheaper, always-on signal that graph analysis can
prioritize rather than scanning the whole graph cold.

## 6. What This Document Does Not Claim

None of §2–§5 has a line of implementation code, a scheduled job, or a
schema field behind it today. `stakedAmount`, decay weighting, and
diversity scoring are not in `prisma/schema.prisma`. This is a
direction document for RFC-drafting, not a design already accepted
into canon — it should go through the same RFC process
(`GOVERNANCE.md`) as any other protocol-level change before
implementation begins.
