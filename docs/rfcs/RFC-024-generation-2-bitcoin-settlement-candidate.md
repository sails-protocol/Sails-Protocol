# RFC-024: Generation-2 Bitcoin Settlement — Architecture Candidate (Not Implemented)

## Status

**Architecture candidate only — explicitly NOT implemented, NOT scheduled,
NOT a commitment.** Recorded per CTO direction (Missão 11 Fase 7.3.3 §E)
as the deliberate landing place for a real Bitcoin-settlement-script
upgrade investigation, so it exists as a named target before any code
is written toward it — not because a decision has been made to build it.

This document is descriptive of a *design space*, not a specification. No
timeline is implied. Generation-1 (`multisig.provider.ts`'s bare 2-of-3
P2WSH `p2ms`) remains the only real, shipped Bitcoin settlement rail.

See `docs/architecture/SAILS_SIGNING_FEDERATION/` (Delivery A: conditioned approval of the direction; not homologated; Gen-2 activation NO-GO).

## Why this exists

Missão 11 Fase 7.3.2's own design-options analysis (Model D, "a
cryptographically cleaner model implied by the current 2-of-3
construction") identified a real, structural limitation of Generation-1:
`Escrow.expiresAt` is a purely off-chain/database concept. The actual
Bitcoin script has no on-chain notion of a timelock at all — a 2-of-3
`p2ms` is satisfiable by *any* 2 of the 3 keyholders, forever, with no
unilateral recovery path encoded anywhere in the spending conditions
themselves. Every Generation-1 recovery mechanism (Missão 11 Fase 7.3.3)
is therefore necessarily an *off-chain, application-layer* affordance
(a status field, a guided dispute action) layered on top of a script that
itself knows nothing about expiry.

A genuinely cleaner answer — one where "no permanently stranded funds" is
a property of the **script itself**, not of whichever application-layer
recovery logic happens to be running — requires encoding recovery paths
directly into the spending conditions. That is a real script-architecture
change, not a small patch, and is the subject of this document.

## Generation-1 funding-provenance limitation (recorded, not solved here)

Recorded per CTO direction (Missão 11 Fase 7.3 pre-commit gate, 2026-08-24)
as a permanent, load-bearing distinction that must not be lost in future
architectural descriptions of Generation-1.

`multisig.provider.ts`'s `lockFunds()`/`verifyLock()` verify funding at the
committed P2WSH escrow output — address, confirmed UTXO, txid/vout, output
value — via a read-only block-explorer query. **This is not a cryptographic
attestation of who funded that output.** Bitcoin's UTXO model constrains
*spending* (the 2-of-3 script), not *funding* (any party's wallet can send
to any address); nothing in this repository constructs, sees, or verifies
the funding transaction's own inputs. Seller-only funding is a **protocol
workflow rule** (the API only ever instructs the seller to fund their own
escrow address) — not a structurally or cryptographically enforced
guarantee. See Missão 11 Fase 7.3's pre-commit gate report for the full
question-by-question trace.

This does not retroactively weaken Generation-1's shipped recovery
mechanism (Missão 11 Fase 7.3.3) — that mechanism's safety rests on the
real trade flow giving a buyer no incentive to fund the seller's address,
not on a cryptographic funding proof that was never claimed to exist
before this note. It is recorded here as an open question for Generation-2:
any redesign must explicitly evaluate whether stronger funding-input
provenance (e.g. a cooperative funding protocol, an on-chain commitment to
expected input ownership) is necessary or desirable — this document takes
no position on that question and no Generation-1 mechanism is invented to
solve it now.

## What Generation-2 must NOT be

**Not a cryptographic-fashion upgrade.** Adopting Taproot/MuSig2 purely
for their own sake (smaller witnesses, better privacy, aggregated
signatures) does not by itself solve anything this RFC exists for.
**MuSig2 alone does not solve recovery** — a single aggregated
2-of-2-equivalent cooperative key is, if anything, *more* dependent on
both parties being online and willing than a plain multisig is, unless
it is explicitly paired with an alternative, non-cooperative spending
path. Generation-2 must be evaluated and designed as a **complete
settlement script architecture** — every spending path, every actor's
authority under every path, every historical-verification implication —
not as an isolated primitive swap.

## Payjoin — a first-class privacy capability to evaluate, not a decision

Recorded per CTO direction (Missão 11 Fase 7.3 cumulative audit §J) as an
explicit amendment. **Payjoin is not implemented in this phase, is not
scheduled, and this section does not choose it.** It is added to the
Generation-2 design space alongside Taproot, MuSig2, the Tapscript
dispute path, on-chain timeout recovery, and (where relevant) Lightning
interoperability — evaluated together, not bolted on afterward.

Two things Payjoin explicitly is **not**, stated plainly so neither is
ever assumed by a later design pass reading this document in isolation:

- **Payjoin is not an escrow replacement.** It is a funding-transaction
  privacy technique (breaking the common heuristic that all inputs to a
  transaction belong to one party) — it says nothing about custody,
  dispute resolution, or recovery, and does not substitute for any of the
  script-architecture work described above.
- **Payjoin is not assumed compatible with every settlement phase.**
  Generation-1's own funding step (`multisig.provider.ts`'s `lockFunds()`/
  `fetchUtxos()`) already depends on identifying the escrow's own UTXO
  deterministically by address and (once persisted) exact outpoint
  (`txLockVout` — Missão 10). A real Payjoin round mutates the funding
  transaction's own structure (input count, sometimes the paying party's
  own change) through negotiation between the sender and receiver before
  broadcast — whether and how that composes with an escrow funding flow
  at all needs real analysis, not an assumption either way.

Before any Generation-2 design converges, a real Payjoin-compatibility
analysis must at minimum address:

- **Escrow funding.** Whether a Payjoin-style negotiated funding
  transaction can still deterministically produce the exact UTXO/vout an
  escrow's later spend construction depends on.
- **Cooperative settlement.** Whether Payjoin's negotiation model has any
  place in the *release*/*refund* side of settlement, or is meaningfully
  a funding-only concern.
- **Transaction/PSBT identity.** Whether a negotiated Payjoin transaction
  changes the assumptions `verifySigningIntent()`/`deriveExpectedMultisigAddress()`
  (or their Generation-2 equivalents) make about what a wallet is
  independently verifying.
- **Txid mutation/negotiation implications.** A Payjoin round can change
  the final txid relative to a naive send — any code path that persists
  or matches against a *predicted* txid before broadcast must be checked
  for this assumption explicitly.
- **Fee accounting.** Whether a Payjoin-negotiated transaction's fee
  structure remains compatible with `fee-reserve-math.ts`'s Decimal-exact
  fee construction, or requires its own accounting path.
- **Collection evidence.** Whether `FeeCollectionEvidence`'s own
  txid/vout-based identification (Fase 5-7.2's own collection-recognition
  design) remains valid against a Payjoin-negotiated funding or
  settlement transaction.
- **Wallet reconstruction/verification.** Whether an external wallet can
  still independently reconstruct and verify what it is being asked to
  sign when a transaction's own construction was itself the product of a
  multi-party negotiation, not a single party's deterministic build.
- **Historical verification.** Whether `distributionPolicyFreezes`-style
  historical proofs (Fase 7.2 §L) remain sound against a settlement whose
  own transaction structure was negotiated rather than fixed.
- **Information leakage.** Whether Payjoin's own privacy benefit (breaking
  the common-input-ownership heuristic) is actually preserved once
  layered on top of an escrow whose *existence* and *parties* are already
  known to the protocol server — or whether escrow-specific metadata
  reintroduces exactly the correlation Payjoin exists to prevent.

## Design space to investigate

- **Taproot output structure.** A single Taproot output whose key path
  is the cooperative case and whose script path(s) hold the exception
  cases (dispute, timeout) — replacing P2WSH's always-visible `p2ms`
  redeem script with a structure that reveals only the path actually
  used.
- **MuSig2 cooperative path.** The buyer+seller (and, for a disputed
  resolution, buyer/seller+arbiter) cooperative-release case as an
  aggregated Schnorr signature via the Taproot key path — smaller,
  cheaper, and (a real, non-cosmetic benefit) does not reveal on-chain
  that this was ever a 3-party escrow at all when the cooperative path
  is used.
- **Tapscript dispute path.** The arbiter-involved ruling paths
  (RELEASE/REFUND/SPLIT after a real dispute) as an explicit Tapscript
  leaf, functionally equivalent to today's 2-of-3 disputed-spend branches
  but only ever revealed on-chain when actually exercised.
- **On-chain timeout/recovery semantics.** A genuine CSV/CLTV-gated leaf
  encoding unilateral recovery after a real, consensus-enforced block
  height/time — the direct answer to Fase 7.3.2's Model D and the actual
  elimination of the off-chain-`expiresAt` dependency Generation-1 has
  today.
- **Whether buyer and/or seller require timeout leaves.** Generation-1's
  real fund-ownership model (Missão 11 Fase 7.3.3 §C's own authority
  matrix) has the **seller** as the party with locked collateral at
  stake in the timeout scenario that actually occurs in practice — a
  seller-only timeout leaf may be sufficient. Whether a symmetric
  buyer-side leaf is also warranted (e.g., for a future flow where the
  buyer locks value) is a real, separate question, not to be assumed
  either way.
- **Historical script versioning.** Generation-1 escrows must remain
  fully valid and interpretable forever — a Generation-2 rollout must be
  a new, distinctly-versioned `EscrowType` (or an explicit script-version
  field), never a retroactive reinterpretation of an existing P2WSH
  escrow's own script. `multisig.provider.ts`'s own `buildScript()` would
  need a real, explicit version discriminant from day one of this
  investigation, not added later.
- **Wallet reconstruction.** `@satsails/p2p-trading-sdk`'s
  `deriveExpectedMultisigAddress()`/`verifySigningIntent()` (the
  independent-verification primitives an external wallet actually relies
  on) would need genuine Taproot/Tapscript-aware equivalents — a wallet
  must be able to independently reconstruct the *exact* output (key path
  + every script-path leaf) from public information alone, exactly as it
  does for Generation-1's simpler script today. This is not a smaller
  problem than the script design itself; wallet-side verifiability is a
  first-class design constraint, not an afterthought bolted on once the
  script is chosen.
- **Backwards coexistence with Generation-1.** Both rails must be able to
  run simultaneously indefinitely — existing P2WSH escrows settle exactly
  as they do today; only newly-created escrows would ever use a
  Generation-2 script, gated behind its own explicit type/version. No
  migration of an existing escrow's script is ever in scope.

## Explicitly out of scope for this document

- Choosing a production rollout date.
- Choosing which specific spending paths are mandatory vs. optional.
- Any code change. This document records a design space; Missão 11 Fase
  7.3.3 implemented nothing toward it.

## Relationship to other RFCs

- RFC-019 (`settlement-custody-reference-vs-normative.md`) — this
  document should be read alongside RFC-019's own custody-model framing
  once real design work begins.
- RFC-021 (market-based arbitration) — Generation-2's Tapscript dispute
  path must remain compatible with `ARBITRATION_MODE=market`'s own
  eventual per-rail capability model (Missão 11 Fase 7.3.2 §1's
  `SCRIPT_COMMITTED_ARBITER_RAILS`) — a Generation-2 rail that
  commits its arbiter identity per-escrow the same way Generation-1 does
  would need the identical rail-capability treatment; a rail that somehow
  avoided a fixed-arbiter commitment would not.
