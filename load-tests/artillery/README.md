# Load tests (Artillery)

Moved from `loadtest/` to `load-tests/artillery/` (PRODUCTION_READINESS_FIXES.md
item 19, closed 2026-08-08) so both load-testing suites live under one
parent directory — see `load-tests/README.md`'s own header comment for
why this stays a *separate* subdirectory rather than a merge: this suite
(Artillery) and the k6 suite next to it are two different tools testing
different flows, not duplicates of each other.

Real Artillery scripts against the real server — not synthetic echo
endpoints. Closes the gap `TECHNICAL_WHITEPAPER.md` section 12 disclosed
("no numbers exist yet for throughput"). See that section for the actual
results and their methodology caveats (single local machine, rate limits
raised for the Intent API run, pre-authenticated session pool for the WS
run) before citing these numbers anywhere.

## Prerequisites

- Local server running (`npm run dev`) against a real local Postgres/Redis
  (`docs/DEVELOPER_JOURNEY.md`'s local setup, or `docker-compose.yml`).
- `npm install --save-dev artillery` (not a `dependencies` entry — this is
  a dev-only tool, not shipped).

## Intent API (`intent-api.yml`)

Each virtual user goes through the real Ed25519 challenge-response auth
flow (`processor.js`'s `setupAuthenticatedUser`) before creating and
cancelling a `TradeIntent`. Run as-is:

```
npx artillery run load-tests/artillery/intent-api.yml
```

At the shipped rate-limit defaults (`RATE_LIMIT_AUTH_MAX=10`/min) this
may primarily measure the enforced authentication rate limiter, not the
Intent API's unrestricted capacity. HTTP 429 is a valid security-enforcement
result, not permission to weaken the limiter.

**Current evaluation policy (PR #472):** run only against disposable
loopback services with the shipped authentication and API rate limits intact.
Use the bounded comparators documented in `load-tests/README.md` for the
current k6-versus-Artillery evaluation. Stop and request a separate security
review before any higher-rate experiment that conflicts with these limits.
Do not change `RATE_LIMIT_MAX` or `RATE_LIMIT_AUTH_MAX` to make CI or a
benchmark pass.

**Historical methodology only:** the earlier Intent throughput experiment
raised rate limits to isolate application behavior, as disclosed in
`TECHNICAL_WHITEPAPER.md` section 12. Those measurements are not evidence
of performance under shipped rate limits and must not be presented as a
current approved runbook or k6/Artillery parity proof.

## Chat WebSocket (`chat-ws.yml`)

Requires a pre-generated pool of authenticated sessions — Artillery's
`ws` engine only honors a `connect` step as the literal first item in a
scenario's flow (see `processor.js`'s `pickChatSession` doc comment for
where this was found), so per-VU auth can't run as an earlier flow step
the way it does for the `http` engine above.

```
node load-tests/artillery/pregenerate-users.js 50
npx artillery run load-tests/artillery/chat-ws.yml
```

`users.json` is gitignored — it holds real (if throwaway) session
tokens for whichever local server generated them.
