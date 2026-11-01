# AUD1X-H1 — legacy exposure inventory (read-only plan)

**Status:** plan + query set, validated on disposable PostgreSQL only. **No production data was read, exported or
modified in producing it.** Companion code change: "AUD1X-H1" in `CHANGELOG.md`. Queries:
[`scripts/aud1x-h1-legacy-inventory.sql`](../scripts/aud1x-h1-legacy-inventory.sql).

## Why an inventory is needed

AUD1X-H1 changes what Sails builds from now on: a disputed MULTISIG round is built only for a resolved, signed
ruling, and the platform arbiter signature is produced at execution, never stored or returned. It cannot change what
was built **before**: every disputed MULTISIG round persisted by earlier code carries the platform arbiter
signature inside `EscrowPendingTransaction.unsignedPsbtBase64`, and so does every participant's stored signed copy of
it. Such a round is one signature short of a valid 2-of-3 spend — the beneficiary's own — and Sails deleting,
refusing or ignoring the round does not revoke it.

The exposure of such a round ends when the escrow's funding outpoint is spent by **anything**: the transaction the
round describes is only ever valid while that outpoint is unspent. So the questions the inventory answers are:
*how many disputed escrows still hold an unspent funding outpoint together with such a round, and in which of them
does the round contradict, or pre-date, a signed ruling?*

## Handling rules

1. Run on a **replica or snapshot**, by a person already authorized to see production data, inside the one
   `READ ONLY` transaction the file opens (it ends in `ROLLBACK`; nothing is written, there is no temporary object).
2. The queries return **identifiers and counts only** — never a PSBT, a signature, a key or an address. Do not widen
   the select lists. Row-level output stays in the access-controlled channel the CTO names; only counts leave it.
3. Nothing in this plan deletes, rewrites, supersedes or "cleans up" a row. Reclaiming or revoking a legacy round is
   the unresolved dead-generation policy (ST1-R1 / ST1-R2, owned by the Gatekeeper) and needs its own CTO decision.
4. A hit is a finding, not an incident: the table below says what each query means and what the evidence of
   harm would be.

## Queries

| Query | Rows are… | Exposure | What would show harm |
|---|---|---|---|
| **Q1** | disputed MULTISIG rounds built **before** any signed ruling existed | highest: no authority ever existed for the transaction; also blocks the honest ruling (the dispute can never be ruled) | the funding outpoint spent by a transaction that is neither the ruling's nor a cooperative one |
| **Q2** | disputed rounds whose kind contradicts the ruling they record, or the dispute's current ruling | AUD-1 (R1): a refund round under a RELEASE ruling, or the reverse | same |
| **Q3** | committed Economic Disposition Authorizations whose round contradicts the ruling (R6) | an authorization, not an effect; refused since AUD-1 | same |
| **Q4** | escrows already settled against their dispute's RESOLVED ruling | an effect that already happened (R4); not reversed by any code | settled escrow whose ruling disagrees |
| **Q5** | live correspondence evaluations that are not MATCH for every beneficiary | detection of Q4-like effects (M2); note that in the audit's probe a contradicting broadcast showed as `UNKNOWN` for the beneficiary it did not pay, not as `DIVERGENT` | any non-MATCH row |
| **Q6** | pending rounds whose stored PSBT **already embeds** the escrow's arbiter signature | the bearer exposure itself: one beneficiary signature from a valid transaction | funding outpoint spent while the round is still pending |
| **Q7** | participants' stored signed copies embedding the arbiter signature | the same exposure through a participant's own copy | as Q6 |
| **Q8** | authorizations committed for a round that embeds the signature | the reuse path will let it execute (after the AUD-1 binding) | as Q6 |

Reading them together: **Q6 ∩ (escrow `DISPUTED` and funding outpoint unspent)** is the live bearer set. **Q1 ⊂ Q6**
for rounds built by code before this change (a pre-ruling round carried the signature from the moment it was
built). A round built by this change never appears in Q6/Q7/Q8; one that appears in Q1 after this change shipped is a
defect.

## Procedure

1. Restore or attach a replica; confirm it is not the primary.
2. `psql --single-transaction -v ON_ERROR_STOP=1 -f scripts/aud1x-h1-legacy-inventory.sql` (or paste the file;
   every statement is a `SELECT`). Record **counts per query** and the date of the snapshot.
3. For each Q6/Q1 row, join *outside* this tool — with the explorer, not the database — whether the escrow's funding
   outpoint is still unspent. Only unspent ones are live.
4. Hand the CTO: counts per query, the number live under (3), and for those the age of the round
   (`createdAt` is in Q1/Q6). The decision on what to do about live ones (let the honest settlement spend the
   outpoint, which voids every other spend of it; or a Tier-3 reclaim rule) is theirs.

## Expected result on a deployment that never ran the earlier code

Zero rows in every query. On the scratch databases this change was developed on, Q1/Q6 return exactly the rounds
a test seeded in the earlier shape (`tests/integration/aud1xBearerCapability.test.ts`, scenario I1) and none built by
the new code.
