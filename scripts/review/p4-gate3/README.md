# P4 Gate 3 independent review kit (reproduces the censuses and the reversed-order run of PR #525)

Reference SHA: `22c4f6ebb3fbe5ea710cbe8215def3c60bce0e6c` (head of `p4/gate3-iii-a-guard`, PR #525). This kit **reads** that tree and
writes nothing into it; it needs a checkout of the SHA with `npm ci`, the three workspace packages built and `prisma generate` done.
It uses its own disposable PostgreSQL (port 55447 by default, user/password `postgres`/`review`), never 5432, never a shared database.
Nothing here activates the guard, applies a migration to any non-disposable database, or sets `DISPUTED_RECREATION_SETTLE_WINDOW_MS`.

```bash
node scripts/review/p4-gate3/run.js setup   --repo <checkout of 22c4f6e>      # starts the disposable PostgreSQL, builds the migrated template
node scripts/review/p4-gate3/run.js census  --repo <checkout>                 # 6.4 / 6.8 censuses: each suite alone on a clone, then the two queries
node scripts/review/p4-gate3/run.js reversed --repo <checkout>                # one complete run, all suites in REVERSE order, ONE shared database
node scripts/review/p4-gate3/run.js forward  --repo <checkout>                # the same suites in the lane's own order, for comparison
node scripts/review/p4-gate3/run.js teardown
```

Outputs go to `scripts/review/p4-gate3/out/` (`census.json`, `reversed.json`, `forward.json`, logs). The census asks, per suite database:
(1) PASS 0b candidates left behind (`economic_disposition_authorizations` live + `unsignedTxid` + MULTISIG + DISPUTED + no settlement result + no pending operation);
(2) signed copies whose text is not base64 (`escrow_transaction_signatures`), split by "escrow has an arbiter key" (the only ones the AUD1X inventory decodes).
A suite "passes the census" when (1) is 0 and (2) with an arbiter key is 0.


## Results obtained with this kit (2026-10-26, reference SHA `22c4f6ebb3fbe5ea710cbe8215def3c60bce0e6c`, PostgreSQL 16, Windows 11 + Docker Desktop)

| Run | Result | File |
|---|---|---|
| Census, each of 88 suites alone on a clone of the migrated template | **88 databases inspected, 0 PASS 0b candidates left, 0 non-base64 signed copies on a keyed MULTISIG escrow** (the claims of sections 6.4 and 6.8 reproduce); 1 suite failed alone: `paymentAccountBindingAuthority` (2 of 26 tests; passed in the reversed run: the #436 race of section 6.5) | `census-22c4f6e.result.json` |
| Complete run in REVERSE order, one shared database, 11 consecutive jest processes of 8 suites (a single process runs out of its 4 GB heap after ~32 min: reproduced) | **87 of 88 suites, 1271 of 1272 tests**; the failure is `projectionRecoveryQueue` test P | `reversed-22c4f6e.result.json` |
| `projectionRecoveryQueue` test P, isolated, clean clone each time | fails intermittently **also on the parent commit `f3ca9fe1`** (2 of 10) and at the reference SHA (1 of 9): pre-existing, not order dependent. Root cause reproduced at SQL level with `pass3-claim-race.js` (33/400 overlapping claims on the shipped statement; 0/400 with an advisory lock). Fix and test: PR #535 | `pass3-claim-race.js` |

The reversed run now includes the post-row-8 head (`aud1xBearerCapability` passed). It is one order out of ~88!, as the contract doc says; it samples, it does not prove independence of order.
