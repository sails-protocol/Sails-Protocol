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
