# MULTISIG disputes: when the required party can no longer sign (F32, alternative A)

Status: documentation of a **known limitation** plus a **read-only** operational indicator. It changes no behavior of funds, signatures, authority, escrow, settlement or arbitration, and it needs no migration.

## The limitation

A MULTISIG escrow is a 2-of-3 P2WSH script (buyer, seller, arbiter) with no time condition. The script requires any 2 of the 3 signatures and **does not restrict the outputs**. For disputed rounds, the Sails software only builds and broadcasts the transaction whose outputs are the decided outcome. ADR-004 items 5 and 6 remain open for other broadcast paths, and this text does not extend the statement to them.

In a dispute the arbiter issues a signed ruling (release to the buyer, refund to the seller, or a split). Sails translates it into a transaction and the arbiter pre-signs it. One signature is still missing: the **required party's**. It is the **buyer** for a release or a split and the **seller** for a refund.

If the required party can **never** sign again (lost or destroyed key, lost device, abandoned escrow), **the decided outcome cannot be executed through Sails**. Sails offers no independent exit: the software does not replace that party's signature, and **for disputed rounds** there is no Sails path in which the arbiter, the operator or the counterparty replaces it. The funds stay at the 2-of-3 address while the required party does not sign through Sails.

Sails does **not** move funds because time passed or because a party is absent, does not change the recipient, amount or allocation rule of the decided outcome, and does not promise automatic recovery (re-issuing a transaction does not recreate a lost key). A round that is consistent with the decided outcome is not deleted and a round that already has a signature is never deleted; the cleanup of obsolete rounds only removes rounds with **no signature** that have no durable Outcome or fail revalidation against it. The ruling itself stays.

| Who becomes unavailable | Effect |
|---|---|
| The party that is **not** required (the losing party) | The dispute executes normally: the required party signs and the arbiter already pre-signed |
| The **required** party | Execution is blocked until that party signs. In a split only the **buyer** can complete it, even with the seller present |
| The **arbiter** | Without a ruling there is no outcome and nothing moves. Arbiter assignment (#238) only assigns an arbiter to disputes that still have none; it never replaces one already assigned |
| Time passing | No effect on the funds: there is no timelock and no dispute expiry that spends |
| The operator process restarts | The durable state resumes; the required party completes it later |

### The arbiter key belongs to the node operator

The arbiter key belongs to the node operator (it is derived from the operator's `MULTISIG_SEED`). The operator together with one of the parties can therefore build and sign a different transaction **outside the Sails software**. That the software only builds the decided outcome for disputed rounds is a software and trust guarantee, not a property of the script. This is not a recovery path that Sails offers.

### What the time indicator is not

The time shown comes from the **application clock, which the operator controls**. It only measures how long the current round exists and how long ago the ruling was committed. It **does not prove that a party is unavailable**: a signature not observed is an operational signal, never a conclusion about the party, and it never authorizes any action on the funds.

## The read-only signals

`GET /v1/settlement/escrow/:id/party-absence-signals` (buyer, seller or the assigned arbiter; same visibility as `pending-transaction`). Each signal is `OBSERVADO`, `NAO_OBSERVADO` or `DESCONHECIDO`; `DESCONHECIDO` is never downgraded to "absent".

- **S0 (E0)**: `createdAt` of the live round of the current ruling generation, on the application clock. `DESCONHECIDO` when there is no round, the ruling is null or reverted, two rounds are ambiguous, a date is invalid, the round is in the future, or the round is before the ruling. It is never compared with a database clock.
- **S1**: a signature of a required signer on the live round. `NAO_OBSERVADO` is only reported when S0 and the ruling (S7) are observed. It reads existence, not the time of the last signature (the write is an upsert).
- **S3**: the database clock, **context only**; no decision uses it.
- **S4 / S5**: chain tip height and the funding outpoint state, read from the explorer. `DESCONHECIDO` when the explorer is unavailable or the escrow has no recorded vout (legacy).
- **S7 / S9**: the ruling and its generation; an arbiter without a ruling.
- **S10**: every required signer has a registered key (capacity, not presence).
- **S6 / S8 (informative)**: the recorded miner fee (obsolescence against a live rate is **not** evaluated); cooperative rounds superseded by a ruling.
- **S13**: the output is derived on read; nothing is persisted.

The response carries **two separate intervals**, both on the application clock: `sinceRulingMs` and `sinceCurrentRoundMs`. A replaced round restarts the second one only. They are never merged.

The display status is `AGUARDANDO_ASSINATURA_DA_PARTE_EXIGIDA` only when S0, S7 and S1 are all observed; any unknown gives `DESCONHECIDO`.
