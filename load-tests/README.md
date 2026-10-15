# Load tests (k6)

Real k6 scripts against the real server — every flow here goes through
the actual routes (`src/core/intent.routes.ts`, `src/modules/open-p2p/`,
`src/modules/open-settlement/`, `src/modules/open-reputation/`) with
real Ed25519 challenge-response auth (`common/middleware/auth.ts`), the
same "mock only the database boundary a unit test needs to, never the
thing actually being proven" discipline this repo's e2e (Playwright) and
load-tests/artillery/ (Artillery) suites already established.

## Target architecture: k6 + Sails TestKit

**Decision (2026-10-15):** k6 is the primary load/performance runner. **Sails
TestKit** is a small, test-only Node.js helper layer for protocol-specific
identity/Ed25519 proof-of-possession, authentication, one-time WebSocket
tickets, fixture setup and fail-closed protocol assertions when these cannot
be expressed safely and simply inside k6. It is **not** a second load engine:
no virtual-user scheduler, arrival-rate implementation, latency percentile
engine, dashboards or independent throughput benchmarks should be maintained
in TestKit. Prefer direct k6 implementations when practical.

**Migration status: NOT COMPLETE.** The existing k6 suite covers
trade/escrow lifecycle, reconciliation and reputation, while the legacy
Artillery suite covers Intent API and chat WebSocket. The candidate
`load-tests/native/run.js` still contains a temporary load scheduler; this
is **transitional evidence only**, not the approved long-term TestKit shape.
Do not rename it to TestKit and declare the migration complete. The
Artillery bounded HTTP and WS comparators are retained as baselines. In
particular, the bounded Artillery WS candidate sends PING but does **not**
assert receipt of PONG; it must not be presented as protocol parity.

**Removal gates:** port the missing Intent and authenticated chat WebSocket
workloads to k6; establish positive and deliberately negative PONG evidence;
verify fail-closed identity, auth, ticket and target safety; compare outcomes
against the real-backend legacy baseline; establish a safe, explicitly
approved rate-limit/benchmark policy for sustained load; then review the
Artillery dependency and lockfile removal. No production rate-limit changes,
merge or deployment are authorized by this document.

**Maintenance boundary:** TestKit follows protocol contract changes and
security fixes only; CI verifies its helpers. k6 owns concurrency, load
shapes, thresholds, metrics and reports. No always-on TestKit service or
independent infrastructure.

### Historical suite context

The k6 suite was originally introduced as a second tool alongside
`load-tests/artillery/` (Artillery moved from the former top-level
`loadtest/` under PRODUCTION_READINESS_FIXES.md item 19 on 2026-08-08).
At that time the suites covered different areas: Artillery covered Intent
API and chat WebSocket, while k6 added trade/escrow lifecycle,
reconciliation, reputation and dedicated load shapes. The target
architecture above supersedes that earlier coexistence decision.

## Prerequisites

1. **k6 itself** — not an npm package, a standalone binary:
   ```
   winget install --id GrafanaLabs.k6 -e
   ```
   (or see https://grafana.com/docs/k6/latest/set-up/install-k6/ for
   other platforms). Verify with `k6 version`.

2. **Local Postgres + Redis**, same as every other real-backend suite in
   this repo:
   ```
   npm run db:local:start
   npm run redis:local:start
   ```
   (or `docker-compose up -d` — either path, see `docs/DEVELOPER_JOURNEY.md`).

3. **The real server, with rate limits raised.** At shipped defaults
   (`RATE_LIMIT_AUTH_MAX=10`/min, `RATE_LIMIT_MAX=100`/min —
   `src/config/index.ts`, RT-002) any of these scripts will mostly
   measure the rate limiter within the first few seconds — a real,
   correct result, just not what "Intent/trade/escrow throughput" means.
   `load-tests/artillery/README.md` already documents this exact tradeoff for
   Artillery; the same override works here:
   ```
   RATE_LIMIT_AUTH_MAX=100000 RATE_LIMIT_MAX=100000 TRUSTED_ARBITRATORS=k6-test-arbiter npm run dev
   ```
   `TRUSTED_ARBITRATORS` isn't exercised by anything in this suite today
   (no test drives dispute resolution), but is included above since a
   real deployment needs it set before disputes work at all — harmless
   to include, and one less thing to remember if a future test needs it.

## Structure

```
load-tests/
  k6.config.js            — BASE_URL + options shared by every scenario/test
  utils/
    data-generator.js      — generateTestUser (real Ed25519 auth), generateTestIntent, generateTestOffer, generateTestTrade
    metrics.js              — custom Trend/Rate/Counter metrics, shared names across files
    thresholds.js           — standard / strict / relaxed presets
  tests/                    — one real flow each, runnable standalone or imported by a scenario
    intent-creation.js
    trade-lifecycle.js
    escrow-operations.js
    reconciliation.js
    reputation-lookup.js
  scenarios/                — load *shapes*, each driving a realistic mix of the 5 flows above
    smoke-test.js
    average-load.js
    stress-test.js
    soak-test.js
    spike-test.js
    _shared-workload.js     — the mixed-workload composition every scenario file uses (not meant to be run directly)
```

## Running a specific flow

Each file in `tests/` is runnable on its own, with its own sensible
default load shape:

```bash
k6 run load-tests/tests/intent-creation.js      # 100 req/s create+cancel, 30s
k6 run load-tests/tests/trade-lifecycle.js      # 10 VUs, full trade cycle, 30s
k6 run load-tests/tests/escrow-operations.js    # 15 VUs, create->lock->payment-sent->release, 30s
k6 run load-tests/tests/reconciliation.js       # 50 req/s against one real ongoing trade, 30s
k6 run load-tests/tests/reputation-lookup.js    # 200 req/s, leaderboard + single lookups, 30s
```

Override the target if not running locally on the default port:

```bash
k6 run -e BASE_URL=http://staging.example.com:3000 load-tests/tests/intent-creation.js
```

## Running a load-shape scenario

```bash
k6 run load-tests/scenarios/smoke-test.js       # 5 VUs, 1 minute — run this first, always
k6 run load-tests/scenarios/average-load.js     # ramps to 100 VUs, holds, ramps down
k6 run load-tests/scenarios/stress-test.js      # ramps to 1000 req/s — finds where it breaks
k6 run load-tests/scenarios/spike-test.js       # 50 -> 500 -> 50 req/s — tests recovery, not just peak
k6 run load-tests/scenarios/soak-test.js        # 50 VUs, 4 hours — do NOT run this by accident
```

Each scenario drives a realistic mixed workload across all 5 real flows
(weighted toward reads — see `scenarios/_shared-workload.js`'s own
comment for the exact split and why), not one single endpoint.

### The soak test specifically

`soak-test.js` runs for **4 real hours** as written — that's the point
(catching degradation nothing shorter would surface; see the file's own
header comment). Don't run it unmodified unless you actually mean to
tie up a machine for 4 hours. To sanity-check the script itself works
without committing to the full run, override VUs/duration from the CLI
— this **replaces** the file's own `options.scenarios` entirely, it
doesn't add to it:

```bash
k6 run --vus 5 --duration 2m load-tests/scenarios/soak-test.js
```

## Thresholds

Three presets in `utils/thresholds.js`, selected per scenario file
(`standard` for smoke/average/soak, `relaxed` for stress/spike — see
each scenario's own header comment for why). All three cover k6's
built-in `http_req_duration`/`http_req_failed` plus this suite's custom
per-flow success-rate metrics (`sails_*_success`).

| Preset     | p95 duration | p99 duration | error rate | per-flow success |
|------------|--------------|--------------|------------|-------------------|
| `strict`   | <100ms       | <250ms       | <0.1%      | >99.9%            |
| `standard` | <200ms       | <500ms       | <1%        | >99%              |
| `relaxed`  | <1000ms      | <3000ms      | <10%       | >90%              |

`standard`'s numbers aren't arbitrary — they're set against the actual
results already on record for this backend
(`docs/whitepapers/TECHNICAL_WHITEPAPER.md` section 12: Intent API p95
32ms/p99 55ms on one local machine, zero failures, 30s/20rps sustained),
with headroom. `strict` is meant as a real CI regression gate — tighter
than today's numbers, so it catches a real slowdown before it ships, not
just confirms the status quo.

Swap a scenario's preset without editing the file:

```bash
k6 run -e THRESHOLD_PROFILE=strict load-tests/scenarios/smoke-test.js
```

(only wires up if a file calls `selectThresholds(__ENV.THRESHOLD_PROFILE)`
in its own `options.thresholds` — the shipped scenario files import a
fixed preset directly instead, matching the table above; use
`selectThresholds` in your own copy if you want the env-var switch.)

## Interpreting results

k6's own end-of-run summary is the primary output — read it in this
order:

1. **`✓`/`✗` checks** — did the real assertions (status codes) hold.
   Zero `✗` is the first thing to look for.
2. **`http_req_failed`** — the aggregate error rate. Compare against the
   threshold table above for whichever preset you ran.
3. **`sails_*_success`** — per-flow success rate. If `http_req_failed`
   is low but one specific `sails_X_success` is low, the failure is
   concentrated in one flow, not spread evenly — look at that flow's
   own `tests/*.js` file next.
4. **`sails_*_duration` / `http_req_duration`** — the actual latency
   distribution (p90/p95/p99), not just the average. A low average with
   a high p99 usually means a real tail-latency problem (a slow query
   under contention, a GC pause), not "usually fine."
5. **`sails_rate_limited_429`** (metrics.js) — a real, *expected*
   nonzero count if you forgot the rate-limit-raise step above; a
   nonzero count with limits already raised is a real finding worth
   investigating, not routine.

A threshold failure at the end of a run exits k6 with a non-zero status
code — that's what a CI job should gate on, not manual reading of the
summary (see below).

## CI/CD

```bash
# Smoke test as a merge gate — fast, catches "something is fundamentally broken"
k6 run --quiet load-tests/scenarios/smoke-test.js

# Non-zero exit code on any threshold breach — CI can just check $?
echo "k6 exited with status $?"
```

A real CI environment needs the same three prerequisites listed above
(Postgres+Redis up, server running with rate limits raised) — this
suite doesn't spin those up itself, matching `load-tests/artillery/`'s own existing
convention of treating that as the runner's job, not the test's.

`stress-test.js`/`soak-test.js` are deliberately **not** meant for a
per-PR CI gate (too slow, and stress/soak results are inherently
machine-dependent) — run those on a schedule against a stable
environment instead, and compare trends over time rather than gating a
single run pass/fail.

## A real, non-obvious gotcha this suite's own development ran into

k6's JS engine (Goja) is not Node or a browser — `tweetnacl`
(`data-generator.js`'s real Ed25519 signing, needed for the real auth
flow) auto-detects its environment via a UMD footer that checks
`typeof self` (browser) then `typeof require` (Node) to wire up its
random-number source. k6 has neither a `self` global nor a requirable
`'crypto'` module (it exposes Web Crypto as a real global `crypto`
instead) — so tweetnacl's own auto-detect picks the Node branch and
crashes on `require('crypto')`. The fix, already applied in
`data-generator.js`: set `globalThis.self = globalThis` before loading
tweetnacl via `require()` (not `import` — ES module imports are hoisted
and would run before that polyfill line executes, regardless of where
the `import` statement is textually written). Confirmed by testing
directly against a real k6 binary before writing anything that depended
on it, not assumed from how this works in Node/Artillery.
