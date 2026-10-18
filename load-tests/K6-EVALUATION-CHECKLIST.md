# Sails Pulse: k6 evaluation checklist

Status: EVALUATION ONLY. This is not approval to install a binary or change the default CI.

## First controlled experiment

- Select an explicit k6 release, pin the artifact SHA-256 and document its official origin, license and maintenance/security advisories.
- Run in an isolated disposable runner with no external network access to protocol targets; enforce an allowlist and bounded duration/VUs.
- Implement HTTP PoP registration, signed challenge authentication, create/cancel intent with full response assertions. Use k6-compatible crypto or a reviewed setup fixture; do not assume Node.js crypto or npm packages work in k6.
- Implement WebSocket one-time ticket minting and verify application PONG; reject URL bearer tokens.
- Capture requested and achieved arrival rates, error classification, p50/p95/p99, connection counts, resource consumption and generator saturation.
- Compare against a protocol-equivalent native run and corrected Artillery comparator, each with equivalent setup cost, assertions, rate policies and load profile.
- Preserve auth rate-limit policy. If the 10/min default conflicts with workload generation, stop and request a separate security review instead of bypassing it.
- Fail if metrics, assertions or reports are missing. Never publish credentials, signed proofs, ticket URLs or private keys in CI artifacts.

## Acceptance

The hybrid option must have no security regressions, meet required protocol coverage, generate reproducible and trustworthy measurements, reduce maintenance burden, and not introduce unjustified supply-chain exposure. Performance wins alone do not override failed security gates.

## Current status

- Native real-service smoke and tiny rehearsal: previously passed.
- Native workflow and general CI: passed at 9846c5b3f666f4c16ddc025f355c78dbccc2ca51.
- k6 binary provenance, scenario implementation, WS assertion and comparative benchmark: NOT YET VERIFIED.
- No decision to uninstall Artillery, merge, deploy or change rate limits.

## CTO transition evidence — 2026-10-15 (PR #472)

- Candidate HEAD observed: `9f4b6338d2fb9ea02e2e2052ddbbf0a03e3f2373`. This is an observation, not an acceptance SHA.
- CI Tests run 38740919931 and Native load harness run 38740919937 were **in progress** at the CTO review; do not infer PASS or FAIL from pending jobs.
- In the native load run, dependency-free syntax and safety guard checks **PASSED** on that HEAD. The older syntax failure (run 38732929803, job 116414916066, chat-ws-bounded.js line 31) predates this HEAD and must not be treated as a current failure.
- Source inspection confirms bounded k6 Intent and WS candidates, an explicit application PONG assertion, a negative no-PONG fixture, and disposable PostgreSQL/Redis workflow configuration. These are **implementation observations**, not runtime acceptance.
- `load-tests/native/run.js` still implements its own `runPhases` scheduler. This is transitional only; k6 remains the sole approved load executor, while Sails TestKit may provide protocol-specific fixtures and checks.
- **Gate: BLOCKED until exact-HEAD jobs complete and positive Intent/WS, specific negative no-PONG, security and comparator evidence are inspected.** Artillery remains installed. No merge, deploy, production rate-limit change, or economic/escrow modification authorized.
- Claude's read-only scalability/event-architecture mission is tracked in #473 with #253 and #269; Kafka/Redpanda adoption remains undecided.

### CTO continuation procedure

1. Check both run conclusions and job logs on the exact PR HEAD; do not fix historical failures blindly.
2. For any red gate, record job, step, error and SHA, then apply the minimal safe fix and rerun.
3. Require positive real-service k6 Intent and WS PONG plus a negative fixture that fails specifically for missing PONG.
4. Review authentication limits, secret-safe artifacts and Artillery comparison before any removal proposal.
5. After acceptance, simplify the temporary native scheduler into protocol-only TestKit utilities; seek explicit authorization for merge/deploy.


## Evidence reconciliation — 2026-10-15, completed runs

The previously pending jobs finished **successfully**: CI Tests run `38740919931` and Native load harness candidate run `38740919937`, both on implementation HEAD `9f4b6338d2fb9ea02e2e2052ddbbf0a03e3f2373`. This does not assert a rerun on the later documentation-only HEAD.

Inspection of `.github/workflows/native-load-harness-candidate.yml` confirms the successful candidate job includes: real disposable PostgreSQL/Redis service, bounded Artillery HTTP and WS comparator runs, a deliberately failing k6 non-PONG fixture whose failure classification is asserted, and bounded k6 real-service Intent and authenticated WS PONG runs. The Artillery WS comparator **does not** assert PONG and is deliberately labeled non-parity. Do not infer sustained throughput equivalence from bounded one-iteration k6 smoke checks.

**Residual gate:** the workflow currently uses `grafana/setup-k6-action@v1` without an explicitly pinned action commit or k6 artifact digest in the workflow. The supply-chain/provenance acceptance item above remains OPEN. Also OPEN: comparable sustained load shapes, p50/p95/p99, arrival rates, saturation and resource measurements, review of the duplicate native `runPhases` scheduler, and authorized dependency removal. No merge/deploy/production-limit change.


## CTO exact-HEAD follow-up — 2026-10-15

- PR #472 HEAD `494ab7e82bb6b6f3b1d572e841f9afd212d3865f` verified DRAFT and unmerged.
- GitHub commit-associated PR runs returned CI Tests `38752828157`: **completed / success** (job `test`). This is not the k6 load harness workflow.
- The candidate workflow now records `k6 version` and SHA-256 of the resolved executable into `k6-executable-provenance.txt`, included in the baseline artifact. **Implementation verified in source; execution and artifact contents NOT VERIFIED on this HEAD.**
- The commit-associated PR-run endpoint did not return a load-harness run. This absence is not evidence of a failed or successful run, because the endpoint is filtered to PR-triggered runs and first page.
- Keep CONDITIONAL / NO MERGE. Next: obtain exact-HEAD load workflow result and inspect provenance artifact, then pin the setup action and k6 version under a reviewed update; benchmark parity and duplicate scheduler remain OPEN.

## CTO acceptance gate — exact HEAD faa015cf755f

- CI Tests and Native load harness candidate verification completed successfully on commit `faa015cf755fb7b88de6d43980c82f7bebae98f0` (checked 2026-10-15). The bounded authenticated Intent, WS application PONG, negative non-PONG and offline Ed25519 preflight gates are covered by the successful workflow. This is **smoke correctness**, not benchmark parity.
- The k6-specific TweetNaCl workaround edits only the disposable runner's `node_modules/tweetnacl/nacl-fast.js` after install, neutralizing the statically discovered Node `require('crypto')`. It must be audited for dependency-version drift and for continued use of k6 WebCrypto CSPRNG. No application/lockfile modification is authorized by this workaround.
- **BLOCKED for Artillery retirement:** No controlled sustained-rate comparison has established achieved/requested arrival rate, latency p50/p95/p99, error classification, connections, generator saturation, or backend CPU/memory. WS comparator lacks application-PONG parity. The separate native scheduler remains transitional.
- Next experiment: disposable loopback-only backend; identical seeded authenticated fixture/setup accounting and rate-limit policy for k6 and Artillery; bounded staged arrival rates; capture both generator and backend resource metrics and sanitized summaries. Abort on missing measurements or security assertions. No production targets, bypasses, merge, deploy, or Artillery removal.

## Benchmark protocol freeze — no performance claims until measured

**Scope:** authenticated Intent create+cancel only for the first comparable benchmark. WebSocket PONG parity remains a separate blocking gate because the current Artillery WS flow does not assert an application PONG.

1. **Preconditions:** disposable PostgreSQL 16 + Redis 7; local server on `127.0.0.1:3000`; isolated CI runner; pinned k6 executable; exact HEAD, tool versions and dependency hashes captured. Never use external targets.
2. **Identical work:** one signed registration/login per explicitly counted fixture; each measured iteration creates an Intent and cancels that same Intent, checking HTTP 201/200 and response identifiers. Include fixture/setup cost as a separate recorded dimension, not silently in one tool and outside the other.
3. **Rate policy:** start with the already-proven tiny bounded profile. Increase arrival rate only after reviewing authentication and API rate limits; never relax them for a green benchmark. Stop on HTTP 429 rather than reclassifying it as success.
4. **Measurement contract:** record requested versus achieved iterations/s, attempted and successful create+cancel pairs, check failures, HTTP status classes, p50/p95/p99 by create and cancel, dropped iterations, active VUs, CPU/RSS for server and generators, peak connections and runner saturation. Missing data is a failed experiment, not zero.
5. **Fairness:** identical workload duration, warmup, dataset state, seed strategy, host resources and concurrency constraints. Run multiple repetitions, report per-run values and variability, and preserve sanitized machine-readable summaries only.
6. **Fail-closed:** require authenticated positive assertions and a separate negative no-PONG test; redact tokens, signed proofs, WS ticket URLs and private keys. No raw HTTP response bodies in artifacts.
7. **Decision gate:** no Artillery removal until both protocols reach assertion parity, measurements are reproducible and independently reviewed, and the duplicate native scheduler is addressed. A passing smoke CI does not satisfy this gate.

**Current evidence:** exact HEAD `74f758b51c2d47c471da5bffa8b226e23e047c77` passed CI Tests run `38830759309` and Native load harness run `38830759325`. These runs are not sustained benchmark evidence.

## Arrival-probe implementation review — 2026-10-16

- A new **opt-in** k6 file `load-tests/tests/intent-arrival-probe.js` defines a five-second, 2 iterations/s constant-arrival-rate profile (2 preallocated, max 4 VUs), guarded to loopback HTTP only. Its code uses one authenticated PoP identity from `setup()` and the existing real create/cancel flow. It has a syntax check in the candidate workflow but is **not yet executed** there. Do not present it as measured evidence.
- **Fairness blocker:** Artillery's current comparator provisions a new signed identity for each arrival, while this probe shares a single identity across arrivals. Registration cost and participant-scoped rate limits therefore differ. Even a green k6 probe cannot establish throughput parity. Reconcile fixtures and accounting before making comparative claims.
- **Security blocker:** 429 is a valid enforcement signal, not an invitation to disable or loosen limits. The probe intentionally fails on rate limiting; if the shared identity exceeds the shipped participant quota, reduce or stop the experiment and request security review before changing the load profile.
- **Execution gate:** before enabling this probe in CI, ensure its `sails_intent_success` and `dropped_iterations` thresholds exist and are emitted in k6's summary. Require positive iterations, measured create+cancel counts, and sanitized requested/achieved rates. A missing metric must fail closed, not be treated as zero.
- **Decision:** retain Artillery, DRAFT PR, NO MERGE / NO DEPLOY. No claim of k6/Artillery parity until a protocol-equivalent comparator, repeated runs and backend/generator resource metrics exist.

### Fixture-accounting correction — 2026-10-16

- The k6 arrival probe was changed at `36377ef` to provision a **fresh signed identity inside each iteration**, matching Artillery comparator's per-arrival authentication accounting. The initial profile is now **1 arrival/s for 2s**, with at most 2 VUs and no security-limit modification.
- This corrects the *fixture placement* mismatch identified above, but does **not** establish runtime or assertion parity: Artillery still needs an exactly matching duration/profile and both tools need measured setup timing, per-operation statuses, and repeated observations. The earlier note about the shared identity describes the superseded implementation, not the current probe.
- The probe is syntax-checked but remains **opt-in and not executed** by the CI workflow. No result or performance claim is authorized until the exact HEAD passes and the bounded experiment is explicitly wired and observed.

### First measured arrival probe — exact HEAD 73373ff (2026-10-16)

- GitHub Actions: CI Tests `38847722654` **success**; Native load harness `38847722674` **success**. The k6 arrival-probe step ran against disposable loopback services and produced a sanitized summary: **2 iterations, 0 dropped**, checks and Intent success rates equal 1, `med`, `p(95)`, `p(99)` present. This proves only the bounded correctness rehearsal; latency *values* and resource saturation were not compared.
- The Artillery bounded HTTP comparator is already configured for **1 arrival/s × 2s** with fresh per-arrival signed authentication and 201/200 assertions. The k6 probe now uses the same nominal rate, duration and fixture placement. **Remaining non-parity:** k6 randomizes assets/sides/currencies/amounts while Artillery fixes BTC/BUY/USD/100; and their summary schemas, setup cost measurements, request tagging, repetitions and host-resource accounting have not been normalized.
- Next: normalize k6 payload to Artillery's fixed fixture and add fail-closed sanitized measurement extraction for both runners, then repeated runs. Do not call the current green results a sustained throughput benchmark or approve dependency removal.

## Exact-HEAD evidence update — 2026-10-16 (`945c12ac354c86ec22c3a8bb80184a9d4a16c7fe`)

- CI Tests run `38853604826`: **success**. Native load harness candidate run `38853604827`: **success** on the same HEAD.
- Bounded Artillery HTTP: 2 completed arrivals, 0 failed, 4 HTTP requests. Create endpoint p95 34.1 ms; cancel endpoint p95 7.9 ms.
- Bounded k6 arrival probe: 3 actual iterations, 0 dropped, 18 HTTP requests (including per-arrival authentication); `checks` and `sails_intent_success` both valid. Custom per-operation trends are present: create median 32.577707 ms / p95 36.8602508 ms / p99 37.24092136 ms; cancel median 7.101045 ms / p95 13.6632744 ms / p99 14.24658368 ms.
- The workflow now **fails closed** if either per-operation trend lacks median/p95/p99. Overall k6 HTTP latency includes authentication and must not be directly compared to Artillery endpoint latency.
- **Interpretation:** correctness and latency instrumentation PASS for this tiny profile; benchmark performance parity NOT ESTABLISHED. Artillery observed 2 arrivals while k6 observed 3. Small sample size, separate runs, possible environmental variance, missing repeated-run variability and resource/saturation measurements remain blockers.
- **Next gate:** repeated isolated runs with matched actual arrivals, explicit requested/achieved rates, CPU/RSS and generator saturation, plus Artillery WS application-PONG assertion parity. Preserve loopback-only target, existing authentication/rate limits, no credential-bearing artifacts. Do not remove Artillery or merge/deploy.

## Exact-HEAD authenticated request-accounting gate — 2026-10-16

- HEAD `b8cb81b2db245680403951cb86206344ba2bba0a`: CI Tests run `38856420975` **success**; Native load harness run `38856420986` **success**.
- k6 authenticated arrival probe: 2 completed iterations, 0 dropped, 12 HTTP requests; exactly 6 HTTP requests per iteration (4 PoP authentication, 1 Intent create, 1 Intent cancel). `requestAccountingValid: true`, all checks and Intent flow success valid.
- k6 Intent create median 28.8759845 ms, p95 37.76744675 ms, p99 38.55779895 ms; cancel median 7.9279705 ms, p95 8.12674675 ms, p99 8.14441575 ms. Sample size remains too small for sustained performance conclusions.
- This closes the **per-arrival request accounting** evidence gap, not the broader load-tool parity gate. Remaining: repeatable matched profiles and measured requested/achieved rates, CPU/RSS, generator saturation, connection counts, and Artillery WS application PONG verification. Artillery retained; NO MERGE / NO DEPLOY.

## Exact-HEAD verification: HTTP comparator fail-closed evidence (2026-10-16)

- Commit `338f2bc6573d9f78cfb24b020c0bb728862e60ca` completed **CI Tests** run `38922625837` (SUCCESS) and **Native load harness candidate verification** run `38922626033` (SUCCESS). Both were queried against this exact commit; the native job reported no failed steps.
- The workflow now rejects an Artillery HTTP comparator report unless it has exactly four Intent create/cancel HTTP requests (PoP setup happens out of band), exactly two completed users, no failed users or error counters, and finite median/p95/p99 endpoint histograms for **both** create and cancel.
- **Scope limit:** this is bounded correctness and evidence completeness, not sustained k6/Artillery performance equivalence. Missing WS application-PONG parity, repeated matched workloads, generator/backend resource saturation, TestKit implementation, temporary scheduler retirement and independent review remain OPEN.
- ADR: `docs/architecture/ADR-K6-SAILS-TESTKIT.md` documents the accepted target architecture and explicit migration closure requirements. Do not interpret documentation acceptance as implementation acceptance.
- **Disposition:** CONDITIONAL / NO MERGE / NO DEPLOY / retain Artillery.

## Gatekeeper exact-HEAD bounded evidence — 2026-10-17

- HEAD `f6c76f070747c12a5b3a1d90104470f9cdea4dbb`: CI Tests `39071329110` SUCCESS; Native load harness candidate verification `39071329113` SUCCESS; independent real-service smoke `39071325877` SUCCESS. These are CI/correctness gates, not sustained performance certification.
- Artillery HTTP comparator (native run `39071329113`): 2 completed users, 0 failed, 4 measured Intent HTTP requests, 0 reported errors. Create endpoint median/p95/p99 23.8/23.8/23.8 ms; cancel endpoint median/p95/p99 10.1/10.1/10.1 ms. Backend process CPU delta 27 ticks, peak RSS 322080 KiB (224 samples). Generator sampled CPU delta 254 ticks, peak RSS 354464 KiB (222 samples). Generator CPU excludes work after its last successful process sample; do not equate these figures with complete process-tree accounting.
- k6 authenticated arrival probe (same native run, sequential rather than simultaneous): requested 1 arrival/s for 2s; 2 iterations achieved, 0 dropped, 12 HTTP requests (6 including auth per arrival), request accounting and checks valid. Create median/p95/p99 37.228/47.199/48.086 ms; cancel median/p95/p99 10.923/11.315/11.350 ms. These are tiny samples, not stable latency percentiles.
- **Comparison limit:** nominal and actual HTTP arrivals now match (2 versus 2), but backend/generator resource measurements above are from Artillery only; k6 generator/backend CPU/RSS are not established as matched measurements here. Execution windows are sequential and not repeated under controlled isolated conditions. Auth/setup inclusion and endpoint-specific measurement windows must be normalized before any speed claim. WS Artillery engine still lacks proven application-PONG receive assertion; standalone WS positive/negative tests do not close that gate.
- **Disposition:** retain Artillery; keep PR DRAFT, NO MERGE, NO DEPLOY. Next gate: at least two isolated repetitions per tool with matching workload and full resource/connection/arrival accounting, then independent security and architecture review. Never turn missing data into zero or relax auth/rate limits.

## Gatekeeper RSS recovery evidence — 2026-10-17

- Exact HEAD `b203e9530c3c7fe1ee4349e3dfa29ad98964cabd`: CI Tests `39075514984` SUCCESS; Native load harness candidate verification runs `39075514980` and `39075512595` SUCCESS; real-service smoke `39075512605` SUCCESS. This is two passing native runs after prior intermittent `rss-incomplete` failures, **not** statistical proof of sampler stability.
- In native run `39075514980`, Artillery HTTP completed 2 arrivals, 0 failures, 4 endpoint requests. Backend: 43 CPU ticks delta, 347684 KiB peak RSS (223 samples). Generator: 261 sampled CPU ticks delta, 353156 KiB peak RSS (220 samples), with 1 process-disappearance event counted separately. Generator CPU remains a sampled lower bound and does not include process-tree descendants or post-last-sample ticks.
- Same run's k6 arrival probe requested 1/s for 2 seconds and achieved 2 iterations, 0 dropped, 12 total HTTP requests including authentication; create p50/p95/p99 39.062/50.796/51.839 ms, cancel p50/p95/p99 11.077/11.257/11.273 ms. Artillery create p50/p95/p99 25.8/25.8/25.8 ms, cancel 10.1/10.1/10.1 ms. These tiny sequential runs must not be used as a speed ranking.
- RSS sampler now distinguishes verified process-exit transitions from missing RSS and attempts a positive resident-pages fallback. **Open review concern:** fallback currently assumes 4 KiB pages via `SAILS_PROC_PAGE_KIB` default and does not prove the runtime kernel page size. Independently verify this assumption or replace it with a platform-verified mechanism before promoting the sampler as portable or authoritative.
- Remaining blocking gates: repeated matched runs with complete k6/backend/generator CPU/RSS, comparable arrival and setup windows, Artillery-engine application PONG positive/no-PONG negative parity, independent architecture/security review. Artillery retained; PR DRAFT; NO MERGE / NO DEPLOY.

## Gatekeeper fixed-iteration accounting gate — 2026-10-18

- Exact HEAD `98097b87912355f40bbbbc38533d27cbceac8d31`: CI Tests `39082410037` SUCCESS; real-service smoke `39082407111` SUCCESS; native harness `39082410032` and `39082406980` SUCCESS. Both native runs reported 2 completed k6 iterations, 12 HTTP requests (6 per authenticated iteration), 0 dropped, complete intent latency quantiles and passing functional checks.
- Native run `39082410032`: Artillery generator 201 positive samples, sampled CPU delta 163 ticks, peak RSS 362680 KiB, 1 disappearance, 0 live-state RSS omissions. Native run `39082406980`: 221 positive samples, sampled CPU delta 250 ticks, peak RSS 354048 KiB, 0 disappearances, **1 live-state RSS omission**. Omission is explicitly counted, not a fabricated zero; sampler validity and acceptable omission thresholds still require independent review.
- The k6 probe now uses `shared-iterations` with exactly 2 iterations, 1 VU, 30-second max duration; it is an **authenticated request-accounting smoke**, NOT an arrival-rate/throughput parity measurement. The workflow rejects an iteration-count mismatch and does not report achieved arrivals/s for this profile. A previous constant-arrival-rate 2-second probe intermittently executed 3 iterations for 2 nominal arrivals; run `39080852660` correctly failed under the tightened accounting gate. Do not reuse prior arrival-rate assertions as evidence for the new profile.
- **Open blockers:** controlled repeated *matched arrival-rate* profiles, comparable auth/setup windows, k6 and Artillery backend/generator CPU/RSS with process-tree scope documented, Artillery-engine application PONG positive/negative receive assertions, independent architecture/security review, and verification of Linux page-size assumptions. Keep PR DRAFT; retain Artillery; NO MERGE / NO DEPLOY.

## Gatekeeper RSS omission boundary CI — 2026-10-18

- Exact HEAD `ef9255d681ea40bd94d6c372194fd6e8bc10a852`: CI Tests `39087211869` SUCCESS, real-service smoke `39087207838` SUCCESS, Native load harness `39087211863` and `39087207835` SUCCESS.
- `measured-generator.test.cjs` now exercises the actual `assertRssSampleCoverage` function: 1/100 and 2/200 missing-live-state observations are accepted, while 1/99, 2/100, 1/2, negative and absent counters fail closed. This validates the configured 1% sampling-omission boundary, **not** the statistical precision of CPU/RSS measurements or process-tree coverage.
- The fixed-iteration k6 accounting profile remains distinct from the Artillery two-second arrival-rate comparator. Both can complete two authenticated identities, but their scheduling semantics differ. No throughput or latency ranking is authorized. Missing matched k6 backend/generator CPU/RSS and Artillery-engine PONG receive assertion remain blockers.
- **Disposition:** evaluation only; PR DRAFT; retain Artillery; NO MERGE / NO DEPLOY.

## Gatekeeper k6 dual-process resource evidence — 2026-10-18

- Exact HEAD `be542ae6c15e73a2819f7ea3ff7eb0ad5d2ae91f`: CI Tests `39089212711`, real-service smoke `39089210155`, Native load harness `39089212755` and `39089210151` all SUCCESS.
- Native run `39089212755`: k6 generator CPU ticks sampled **178**, peak RSS **51,760 KiB**, 74 samples, 0 missing-live-state RSS; k6 backend CPU ticks **24**, peak RSS **317,156 KiB**, 76 samples; k6 2 iterations / 12 HTTP requests / 0 dropped; Artillery HTTP generator CPU ticks **251**, peak RSS **353,712 KiB**, 221 samples, 1 missing-live-state RSS.
- Native run `39089210151`: k6 generator CPU ticks sampled **179**, peak RSS **52,228 KiB**, 75 samples, 0 missing-live-state RSS; k6 backend CPU ticks **39**, peak RSS **320,064 KiB**, 77 samples; k6 2 iterations / 12 HTTP requests / 0 dropped; Artillery HTTP generator CPU ticks **254**, peak RSS **354,160 KiB**, 219 samples, 0 missing-live-state RSS.
- **Non-equivalence warning:** k6 shared-iterations (2 total) versus Artillery 2-second 1/s arrival-rate; no equalized schedule, generator CPU/RSS duration or backend comparability claim. Sampled CPU excludes unobserved exit tail; per-process RSS excludes process-tree descendants. p50/p95/p99 based on tiny counts do not establish load capacity.
- **Disposition:** evaluation only, no throughput ranking, no migration approval, PR DRAFT, retain Artillery; independent WS PONG engine receive proof and comparable rate/concurrency profiles remain blocked.

## Gatekeeper Artillery WebSocket receive-surface review — 2026-10-18

- Exact HEAD `435e6ce2449c7a87c360618118547d759b21140a`: CI Tests `39089963466`, real-service smoke `39089959883`, Native load harness `39089963472` and `39089959912` all SUCCESS.
- The current Artillery WS scenario `chat-ws-bounded-comparator.yml` connects with a fresh one-time ticket, sends application PING, and waits one second; **it does not assert a received application PONG**. The existing `assertPongFromSocket` helper requires a socket object; it is exercised by isolated transport tests but not connected to the Artillery scenario engine.
- The workflow's installed-engine inspection is diagnostic only. A matching `receive`/`message` string in dependency source cannot establish a supported callback or fail-closed scenario assertion. No engine-level positive/negative PONG proof has been accepted.
- **Gate stays RED:** do not merge, deploy, remove Artillery or claim WebSocket parity until a reviewed receive/assertion path proves both valid PONG and missing/wrong PONG rejection through the same Artillery engine execution.

## Gatekeeper WS blocker preservation — exact HEAD CI evidence

- Exact HEAD `61ff1c00e44ab9c023ce0f705d73cf9a9d7899e2`: CI Tests `39091915209` SUCCESS; real-service smoke `39091912036` SUCCESS; Native load harness `39091915208` and `39091912037` SUCCESS.
- These green checks validate the current candidate and the documented guardrail; they **do not** demonstrate Artillery engine-level application PONG receive assertions, matching constant-arrival-rate profiles, WebSocket concurrency parity, or independent approval.
- Decision: **CI GREEN / MIGRATION GATE RED**. Keep PR #472 DRAFT; no merge, deploy, or Artillery removal.

## Protocol-operation metric scope reconciliation — Gatekeeper 2026-10-18

- **Artillery** `intent-api-bounded-comparator.yml`: two authenticated users, **four** in-scenario HTTP create/cancel operations; authentication is executed inside the processor's `setupCurrentAuthenticatedUser` function, outside Artillery's HTTP engine request histogram. Arrival schedule is `arrivalRate: 1`, `duration: 2` seconds.
- **k6** `intent-arrival-probe.js`: two `shared-iterations` at one VU, **twelve** recorded HTTP requests (six per authenticated iteration) covering authentication plus create/cancel. Its dedicated `sails_intent_create_duration` and `sails_intent_cancel_duration` trends are the operation-scoped latency series; `http_req_duration` is an all-requests mixture.
- **Required normalization before any parity claim:** (1) compare Artillery's endpoint-specific `/v1/intents` create and `/v1/intents/:id` cancel histograms only to k6's matching intent create/cancel series, with verified successful operation counts; (2) keep authentication request volume and auth latency separate, never compare Artillery's four engine requests to k6's twelve total requests as if same scope; (3) execute equal bounded arrival schedules and repeat independent runs on equivalent disposable backends, collecting dropped arrivals and generator/backend CPU/RSS with identical counter definitions; (4) include WS connection concurrency and engine-level positive/negative application PONG assertions; (5) obtain independent security and architecture sign-off.
- **Interpretation guardrail:** neither existing k6 `shared-iterations` latency quantiles nor Artillery's two-second arrival probe are throughput parity evidence. Do not change the small deterministic accounting smoke back to constant-arrival-rate to hide scheduling-boundary nondeterminism; create a separately named, explicitly evaluated bounded rate-profile when the test design is reviewed.
- **Disposition:** HTTP operation scope has been identified, not normalized; migration gate RED. PR remains DRAFT, no merge/deploy/removal of Artillery.

## Exact-HEAD k6 completed-operation accounting evidence — 2026-10-18

- Exact HEAD `bc161a41e98fcccbdec01fda5b3f35fee3945106`: CI Tests `39138207860` SUCCESS; real-service smoke `39138204308` SUCCESS; Native load harness `39138207760` and `39138204206` SUCCESS.
- Native run `39138207760`: **2** k6 iterations, **2** completed authenticated Intent create/cancel pairs (`sails_completed_intent_pairs`), **12** HTTP requests, **0** dropped iterations, all required metrics present, checks and intent success valid.
- Native run `39138204206`: **2** k6 iterations, **2** completed authenticated Intent create/cancel pairs, **12** HTTP requests, **0** dropped iterations, all required metrics present, checks and intent success valid.
- `sails_intent_create_duration` and `sails_intent_cancel_duration` expose valid quantiles in both runs but **do not expose a sample `count` in this k6 summary-export format** (`null` in sanitized inventory). The new completed-pairs Counter is a separate success-after-both-operations signal, **not** a direct measurement of the latency Trend sample counts. Do not claim the absent Trend counts were recovered.
- **Disposition:** bounded HTTP success accounting evidenced; no equal-rate arrival profile, WS Artillery-engine PONG assertion or independent sign-off. Migration gate remains RED; PR DRAFT, no merge/deploy/Artillery removal.

## Exact-HEAD k6 per-operation latency sample accounting — 2026-10-18

- Exact HEAD `a88fe552d485812d4c8e0d57750844832f5dfa4e`: CI Tests `39140932969` SUCCESS; real-service smoke `39140929117` SUCCESS; Native load harness `39140932976` and `39140929159` SUCCESS.
- Both native runs recorded `iterations=2`, `sails_completed_intent_pairs=2`, `sails_intent_create_samples=2`, `sails_intent_cancel_samples=2`, `httpRequests=12`, `dropped=0`, `checksValid=true`, `intentSuccessValid=true` and nonnegative ordered latency quantiles.
- The new counters fire immediately after `recordFlow` writes the create/cancel latency Trend samples; they prove two instrumented write paths for each operation in these runs. k6 summary-export's optional Trend `count` remains `null`; do not misstate these counters as native Trend counts.
- The k6 profile remains deterministic `shared-iterations`, **not** constant-arrival-rate. The Artillery HTTP comparator has a different request-accounting scope. No direct throughput/latency efficiency parity claim. Artillery WS PONG still not asserted by its engine; independent security/architecture review still open. **Migration gate RED; PR DRAFT.**

## Exact-HEAD authenticated-arrival accounting — 2026-10-18

- Exact HEAD `e4223bee3d65067eb2665a0c4ffe3023f893a737`: CI Tests `39142924066` SUCCESS; real-service smoke `39142921242` SUCCESS; Native load harness `39142924084` and `39142921239` SUCCESS.
- Both native runs independently reported `iterations=2`, `authenticatedArrivals=2`, `completedIntentPairs=2`, `createSamples=2`, `cancelSamples=2`, `httpRequests=12`, `dropped=0`, `checksValid=true`, `intentSuccessValid=true`, and finite nonnegative ordered operation-scoped latency quantiles. Both native Trend `count` fields remain `null` in the exported summary; explicit write counters are distinct from native Trend counts.
- This proves consistent bounded authentication/operation sample accounting on the exact tested commit, **not** arrival-rate parity. k6 remains `shared-iterations`; Artillery HTTP uses a two-second arrival-rate phase and different HTTP metric scope. Artillery engine-level positive/negative PONG, matched repeat rate profiles, and independent security/architecture review remain OPEN. **CI GREEN / MIGRATION GATE RED; PR #472 DRAFT; NO MERGE / NO DEPLOY / NO ARTILLERY REMOVAL.**
