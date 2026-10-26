# Portable identity binding and facts, lab format v1 (EXPERIMENT, not a Sails contract)

Status: lab-only proof format and test vectors for gaps 1, 3 and 4 of `CONTRACT-RECONCILIATION.md` (CTO decision on #545).
No Prisma, `proof.service`, `event-store`, SDK type or migration is touched. A production contract needs separate CTO approval.
Three independent implementations exist and must agree on `vectors/portable-v1.json`: the issuer (`src/issue.mjs`, libsodium),
the verifier (`src/verify.mjs`, node:crypto only, no Sails or Pubky code) and a Python verifier (`verifier-py/verify.py`, standard library only).

## 1. Canonical form CF1 (gap 3)

Deterministic bytes of a JSON value:
* objects: keys must be ASCII, sorted by code point, no whitespace; arrays keep order; `null`, `true`, `false` allowed;
* numbers: integers only, `|n| <= 2^53-1`, decimal without sign for non-negative, no `-0`; floats, NaN, undefined are rejected;
* strings: `"` and `\` escaped with a backslash; every character below U+0020 as `\u00xx` (lower-case hex); everything else raw UTF-8; lone surrogates rejected.
Signing input = ASCII `SAILS-PORTABLE/1/` + purpose + `\n` + CF1 bytes. Purposes are listed per object. An object id is `sha256(signing input)` in hex.
Every body carries `"v": 1`; a verifier MUST reject other versions.

## 2. Authority model for the Pubky binding (gap 1, 4)

Three keys, three different statements:
* **Root R**: the Pubky identity key. In the delegated flow it signs ONLY the grant (a JWS `typ=pubky-grant`: `iss`=R, `cnf`=D, `caps`, `client_id`, `jti`, `iat`, `exp`).
* **Delegate D**: the key the grant binds in `cnf` (the app's proof-of-possession key). Its custom PoP (`typ=pubky-custom-pop-v1`, payload `{gid, iat, nonce, data}`) is a signature by D, **not** by R.
* **Participant P**: the Sails economic key (Ed25519). Independent of R and D, never derived from them.

Binding statement `S = {v:1, kind:"binding", pubky:z32(R), participant:hex(P), audience, nonce, iat, exp}`.
A bundle carries: `S`, `participantSig = Sign_P("binding-participant", S)`, the grant JWS, and a delegate PoP JWS whose `data` equals `S`.

A verifier accepts a binding at one of two levels, and an application MUST say which it needs:
* **root-consented** : R's grant names P in an approved capability: `caps` contains `<base>/bindings/<hex(P)>/:rw`. The user saw and approved a capability that contains P at the signer. This is the only level that is evidence of R's consent.
* **delegated-only** : everything else verifies, but R's grant does not mention P. It shows that SOME app holding a delegation from R and the holder of P agreed. It is NOT evidence that R consents; it MUST NOT be used as a Pubky-to-Participant binding.
Checks: grant signature by R; `now < grant.exp`; `S.pubky = grant.iss`; PoP signature by `grant.cnf`; `pop.gid = grant.jti`; `pop.data = S` (CF1 equal); `participantSig` by P; `S.audience`; `S.iat <= now+30`; `now < S.exp <= grant.exp`.
Revocation: (a) the grant can be revoked at the homeserver (not third-party verifiable: bounded by freshness, see `SECURITY-CLOSURE.md`); (b) P signs a `binding-revocation` fact, verifiable by anyone; (c) every binding expires at `S.exp`.

## 3. Facts (gap 4)

`trade-outcome` body: `{v, kind, participant:hex(P), seq, prev, tradeCommit, counterpartyCommit, outcome, iat}`; purpose `fact`; signed by P; `prev` = id of the previous fact (64 zeros first);
`outcome` in `completed | cancelled-by-agreement | disputed-lost`.
`confirmation` body: `{v, kind, confirmer:hex(Q), issuer:hex(P), tradeCommit, outcome, iat}`; purpose `confirmation`; signed by Q.
`head` body: `{v, kind, participant, seq, hash, iat}`; purpose `head`; signed by P; `hash` = id of fact `seq`.
`dispute-claim` body: `{v, kind, claimant:hex(Q), subject:hex(P), tradeCommit, iat}`; purpose `dispute-claim`; signed by Q (a counterparty complaint that P cannot suppress).
`binding-revocation` body: `{v, kind, participant, pubky, iat}`; purpose `binding-revocation`; signed by P.
Commitments (privacy): `tradeCommit = sha256("SAILS-COMMIT/1/trade\0" + salt + "\0" + tradeRef)`, `counterpartyCommit = sha256("SAILS-COMMIT/1/party\0" + salt + "\0" + hex(Q))`, `salt` 32 random bytes in hex.
The PUBLIC record holds commitments only: no amount, address, counterparty key or conversation. An **opening** (`{tradeRef, tradeSalt, counterparty, partySalt}`) is given to one verifier for one fact.

## 4. Reputation projection (reproducible, not a transported score)

Input: a binding set, the complete chain up to a head, confirmations, openings, optional dispute claims. The function `reputation` in `src/verify.mjs`:
* the chain must be contiguous from seq 0 to the head, every fact signed by a participant bound to the same Pubky id, head signed; a head lower than a verifier-pinned head is refused;
* per trade only the LAST fact counts (corrections); a `completed` counts +1 only with a confirmation by a key `Q != P` whose opening matches `counterpartyCommit`; otherwise it is "one-sided" (0);
* at most 3 counted completions per distinct counterparty (wash-trade cap); `disputed-lost` = -3 (self-reported negatives always count); each distinct `dispute-claim` against P = -1;
* output: `{score, trades, completedConfirmed, oneSided, distinctCounterparties, capped, lost, disputeClaims}`.
Known limits (written, not hidden): a user who controls many keys (Sybil) can create distinct counterparties; a user can drop a whole chain/key and start another unless counterparties or a witness pin heads and dispute claims are collected; the user's own storage cannot prove completeness by itself.
