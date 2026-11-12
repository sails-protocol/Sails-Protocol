# Private staging (architecture H1)

Target approved by CTO 24 ([#105, 6809651802](https://github.com/sails-protocol/Sails-Protocol/issues/105#issuecomment-6809651802)):
one small host, Docker Compose, isolated Postgres and Redis, one app instance, MULTISIG/BITCOIN_L1 on
**testnet**, synthetic data. **This directory only prepares it: nothing is provisioned, connected or deployed.**

| File | Purpose |
|---|---|
| `docker-compose.yml` | The stack. Runs the real production boot path: `NODE_ENV=production` declared explicitly (#474), mocks off, capabilities enforced, WDK seed forced empty, app bound to loopback only. |
| `.env.example` | Every required value, none filled in. Copy to `.env` (gitignored). |
| `smoke.sh` | Liveness, readiness and mock flags; in-container `NODE_ENV` and rail eligibility (only MULTISIG); five negative boots that must refuse to start. |
| `../../.github/workflows/staging-smoke.yml` | Runs the stack and the smoke inside the CI runner with throwaway values. |

## Still pending (not decided here)
- **Operator** (named and confirmed), **provider**, costs and credentials.
- **Evidence store:** production refuses `local-fs`, so staging needs an S3-compatible bucket (`EVIDENCE_S3_*`).
  The smoke uses placeholders; uploading evidence is not exercised.
- **Exposure:** the app is bound to `127.0.0.1`. Reverse proxy, TLS and access control are a separate decision.
- **Database role:** the C9 protection of `offer_envelopes` needs a runtime role that does not own the tables
  (J48). Here the app connects as the database owner.

## STOP
No provisioning, no public exposure, no real funds, no mainnet seed, no rail activation, no economic settlement,
no homologation by inference. **Never promote this database (or a dump of it) into production:** recovery replays
(ruling finalization, projection redrive) trust stored facts and have no per-rail eligibility gate (#609 residual).
