# Full dependency graph: remediation triage (evidence, not waiver)

Source: PR #455, exact HEAD `a1dad13aac82627ed7e53ff33673a755c9d6ad3c`, Prisma runtime isolation workflow run 38501243667, build-dependency-advisory-inventory job 115648467843. Date: 2026-10-14.

## Verified status

- `npm audit --json` exits 1: **35 vulnerable package records** (8 high, 21 moderate, 6 low, 0 critical). This is a full build/migration/test graph audit, **not** a production-image finding count.
- In the same run, `runtime-image-and-postgres` succeeded. CI, CI Tests, CodeQL and production dependency verification succeeded on this exact PR HEAD.
- These are separate security gates. Runtime isolation reduces deployed exposure but does **not** make the full graph audit green. Keep the latter **FAIL / STOP**.
- Prisma CLI 7.10.0 reaches vulnerable `mysql2` through optional/config dependencies; `npm audit` suggests Prisma 6.19.3 as a semver-major fix. **Do not apply that downgrade automatically**: the repository uses Prisma 7 adapter-pg and must preserve schema, migrations and client compatibility.
- The audit also identifies `ts-node-dev` (via chokidar; no automatic fix), `ts-jest` (Jest dependency chain), `sprintf-js` (via argparse/artillery) and `vite-plugin-node-polyfills` (via node-stdlib-browser). Some suggested fixes are breaking downgrades.

## Ordered remediation gates

1. **Prisma/build tooling:** investigate a compatible patched upstream graph or a supported optional-dependency omission limited to the build stage. Verify generation, 37 migrations, PostgreSQL restart and exact-head CI. Never remove the audit or ignore vulnerable packages to manufacture PASS.
2. **Dev-only watchers:** determine whether `ts-node-dev` is still required; replace with a supported Node 24-compatible watch flow only after proving development startup and preserving behavior. Regenerate lockfile via npm, not by hand.
3. **Test/load/UI tooling:** isolate `ts-jest`, Artillery/sprintf-js and Vite polyfill chains into separate candidate PRs, regenerate lockfile and run exact-head CI and integration tests for each.
4. **Re-audit both graphs:** run the unsuppressed full `npm audit --json` and deployed-image inventory independently; retain JSON artifacts, counts and affected dependency paths.
5. **Gatekeeper:** independent review before any merge, deployment or security sign-off.

## Constraints

No production changes in this document. No claims that all 35 findings are exploitable in production. No unverified waiver, blanket override, blind major downgrade, merge, deploy or freeze. Preserve any residual findings visibly as STOP.
