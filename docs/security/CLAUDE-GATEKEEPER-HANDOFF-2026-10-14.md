# Security remediation: Claude Gatekeeper handoff (2026-10-14)

> Operational evidence, not approval. Read current PR HEAD and Actions runs again before decisions. **No merge, deploy, freeze, or security waiver without explicit CTO authorization.**

## Objective and measured baseline

Remove the remaining vulnerabilities in the **complete** npm dependency graph while preserving Sails Protocol economic authorization, cryptography, PostgreSQL/Prisma, concurrency, restart and idempotency. **NO MATERIAL FINDING UNDER THE RUG.**

- Baseline before watcher removal: **35 vulnerable package records** (8 high, 21 moderate, 6 low, 0 critical).
- Exact-head draft #460 (`7567c67a2af6b45d706ac0a599cf94ae1f62ef59`): **34 vulnerable package records** (7 high, 21 moderate, 6 low, 0 critical), not 34 distinct CVEs.
- Thus **1/35 = 2.86%** reduction validated in a **DRAFT**, **not merged or deployed**. Full-graph audit remains **FAIL / STOP**. Production-only audit and Docker/PostgreSQL runtime checks pass.
- Raw baseline evidence: Actions run `38561936422`, artifact `11892957118` (`committed-removal-audit.json`). Do not mistake a green *investigation* workflow for zero findings.

## PR ledger and decisions

| PR | Purpose | State / decision |
|---|---|---|
| #460 | Remove `ts-node-dev` and 11 exclusive packages, promote Node 24 native watch | DRAFT; CI, CI Tests, watch, production audit PASS; full audit FAIL as expected; preserve |
| #461 | Master tracking issue | Open |
| #462 | Artillery compatible update probe | Workflow + CI Tests PASS; no reduction (34 -> 34); no candidate adopted |
| #463 | Prisma 7 compatible update probe | Workflow + CI Tests PASS; no reduction (34 -> 34); no Prisma 6 downgrade |
| #464 | Jest/ts-jest compatible update probe | Workflow + CI Tests PASS; no reduction (34 -> 34); no candidate adopted |
| #465 | UI `Buffer` polyfill regression contract | DRAFT docs-only; no package removal |
| #466 | Broad npm-compatible transitive update probe | Workflow + CI Tests PASS; **REJECT**: 34 -> 41 including **3 critical**; do not adopt patch |
| #467 | Targeted `elliptic` update probe | DRAFT; Actions runs `38574272364` and `38574272402` in progress at last check; inspect exact-head audit artifact when complete |

Other stacked security drafts: #449 integrated candidate, #451 Prisma runtime isolation, #454 Dependabot GitHub Actions/Docker, #455 Node 24 runtime, #456 full audit triage, #457 Node 24 CI parity, #458 Node 24 watch candidate. **These are not merged.** The branch/PR base chain matters; never compare to main without accounting for stacked changes.

## Known roots and constraints

1. **Prisma 7** (`mysql2@3.15.3`, `deepmerge-ts@7.1.5` and optional CLI graph): no blind npm-audit-suggested Prisma 6 downgrade. Preserve Prisma 7, `@prisma/adapter-pg`, client generation, 37 migrations, Postgres and runtime isolation.
2. **Artillery** (`csv-parse@4.16.3`, `sprintf-js@1.0.3` via `argparse`, `chokidar`, etc.): no unsafe downgrade to Artillery 0.0.2; load scenarios must work.
3. **Jest / ts-jest**: avoid incompatible suggested downgrade; require full test parity.
4. **UI Vite `vite-plugin-node-polyfills`**: currently required for global `Buffer` in eager SDK/bitcoinjs-lib ECC path. Removing it blindly makes browser UI blank. Read `packages/sails-ui/vite.config.ts` and #465 before changing.
5. **Transitives**: `elliptic`, `braces`, `ws` and others; broad `npm update` introduced critical findings, so inspect raw added/removed package keys, not only totals.

## Exact-head acceptance gates

- Regenerate lockfile using npm resolver, `npm ci` from clean checkout.
- Unsuppressed `npm audit --json` on **committed exact HEAD**, report critical/high/moderate/low counts; production-only audit separately.
- Node 24 CI + CI Tests; real PostgreSQL + Redis integration; Prisma generate + 37 migrations; Docker runtime; restart/concurrency/idempotency.
- For crypto dependencies, signature/key/address/settlement tests; for UI, real browser render with non-empty root, no `pageerror`, SDK import and `Buffer` availability; for Artillery, real load scripts.
- Compare **added** findings as well as removed findings. No suppressions, misleading PASS, unreviewed overrides, or untested major downgrades.
- Independent Gatekeeper review of evidence and decisions before merge.

## Working environment warning

An unrelated Codespace previously contained **22 unpublished local changes** invisible to GitHub connector. **Do not sync, push, delete, reset or overwrite that Codespace**. These draft PRs were created via GitHub connector separately.

## Immediate next action for Claude

1. Refresh #467 exact HEAD, check Actions completion and download audit artifact.
2. Inspect full raw JSON of #460 and compare against targeted candidate. Prioritize compatible *individual* patches and actual functional tests.
3. If a candidate reduces findings, implement in separate DRAFT PR and run all exact-head gates; otherwise record why not and advance to another root.
4. Keep #461 and this handoff current, including explicit red/green and remaining count. Never call the full audit green until truly zero.

## 2026-10-14 follow-up: audit root-cause classification

Raw full-graph baseline JSON from #469 artifact `11900741901` confirms the 34 vulnerable package records cluster by **four direct roots**: `artillery` (including `braces`, `csv-parse`, `js-yaml`, `sprintf-js`), `prisma` (including `mysql2`, `deepmerge-ts`), `jest`/`ts-jest` (Jest transform/coverage chain), and `vite-plugin-node-polyfills` (including `elliptic` and browser crypto polyfills). `npm audit` suggests **unsafe major downgrades** (Artillery 0.0.2, Prisma 6.19.3, Jest 25, ts-jest 27, polyfills 0.2.0); **do not execute npm audit fix --force**.

#467 elliptic probe: both workflows PASS, audit unchanged 34 -> 34, no package findings added/removed. #469 braces probe: both workflows PASS, audit unchanged 34 -> 34, no package findings added/removed; candidate patch includes unrelated lockfile reshuffling, so reject as a remediation. #470 csv-parse probe in progress at this writing; refresh checks and raw artifact before interpreting.

**Priority shift:** stop multiplying no-op targeted probes after #470. Next action should be an **architecture-preserving root-level fix** or a controlled isolation/removal proof for a *direct* vulnerable tool (Artillery, Jest/ts-jest, Prisma CLI, UI polyfill). Preserve actual functionality and independent security review; measure full graph on committed exact HEAD. Track confirmed remediation separately from evidence-only probes.

## 2026-10-14 root-level implementation planning (after #471)

The direct Artillery removal experiment (#471, run `38578034930`) was still running when last checked; do not claim a reduction until its raw artifact is reviewed. The csv-parse probe #470 (run `38576988382`) also remained in progress.

**Verified functional replacement contract from repository source:**
- `load-tests/artillery/intent-api.yml`: 20s at 5 arrivals/s warm-up, then 30s at 20 arrivals/s; each VU creates an Ed25519 participant, requests and signs the UTF-8 challenge string, authenticates, POSTs `/v1/intents` with bearer token and expects 201, captures ID, DELETEs `/v1/intents/{id}` and expects 200. Assets BTC, USDT_ERC20, LN_BTC.
- `load-tests/artillery/chat-ws.yml`: 20s at 5 arrivals/s, then 30s at 15 arrivals/s; `pregenerate-users.js` creates 50 authenticated users, `processor.js` chooses session on WS connect `/v1/openp2p/chat?token=...`, sends PING, expects real service behavior. Preserve authenticated WS handshake, PING/PONG verification, rate/latency/error reporting.
- Scripts `loadtest:intent`, `loadtest:ws:prep`, `loadtest:ws` currently depend on Artillery; a removal-only PR is **not acceptable**. Replacement needs measured equivalence with a running backend, not mock traffic.

**Next implementation:** after #471 audit quantifies benefit, develop a dedicated replacement candidate for both load scripts, validate against real service, then remove Artillery only if feature parity and full audit delta are proved on exact HEAD. Avoid simply switching to another vulnerable tool or hiding dev dependencies from full audit.

## 2026-10-14 decisive Artillery root-isolation evidence

#470 raw artifact `11900413741`: compatible csv-parse update stays 4.16.3 and **34 -> 34**, no removed/added vulnerabilities. Both workflows PASS, no remediation.

#471 raw artifact `11902502817`: **npm uninstall artillery --save-dev** on an ephemeral runner yields **34 -> 30** (7 high -> 4 high, 21 moderate -> 20 moderate, 6 low unchanged; no new vulnerabilities). Removed vulnerable package records: `artillery`, `braces`, `chokidar`, `csv-parse`. This is a **measured potential 4/35 = 11.43 percentage points**, taking total reduction from 1/35 = 2.86% to 5/35 = 14.29% **only if** a real load-test replacement passes. The raw summary explicitly reports `artilleryScriptBroken: true`, so **do not adopt uninstall-only patch**. Workflow was still in progress when artifact was read, and CI Tests also in progress; re-check conclusions before review. Next implement full authenticated HTTP/WS load-test parity, then rerun unsuppressed full audit and real-service load tests. Never claim 30 vulnerabilities on committed HEAD until a tested replacement is committed.
