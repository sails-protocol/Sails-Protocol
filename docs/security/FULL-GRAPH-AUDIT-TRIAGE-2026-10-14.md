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

## Reconfirmed on Node 24 CI parity candidate

PR #457, HEAD `88d72521fb10bd9c7a3e801c91ff596532bfba6d`, workflow `38503462565`, artifact `11866509337` (`build-dependency-audit.json`) independently reproduces **35** vulnerable package records (8 high, 21 moderate, 6 low, 0 critical), from **2,200** dependency records (719 production, 1,373 dev, 275 optional; categories can overlap). Production dependency verification in workflow `38503462569` passed; full graph remains **FAIL**.

Direct package records flagged in that audit: `artillery` (high), `prisma` (high), `ts-node-dev` (high, no npm audit fix), `jest` (moderate), `ts-jest` (moderate), `vite-plugin-node-polyfills` (low). Transitive high records include `@prisma/config`, `mysql2`, `deepmerge-ts`, `braces` and `chokidar`. The JSON `fixAvailable` suggestions for Prisma, Artillery, Jest, ts-jest and Vite polyfills are downgrades, **not** validated safe remediations. These are package records, not 35 unique CVEs. Preserve the raw artifact and do not infer deployed exploitability from the full graph alone.

## Parallel candidate tracking (non-interfering)

PR #458, branch `security/replace-ts-node-dev-candidate`, is an **unmerged, draft, stacked candidate** on #457. Its original candidate HEAD `4841da04aa16a1790448fe09fec213aec3aec91d` passed primary CI, CI Tests, Node 24 TypeScript watch smoke, production dependency verification, and the Docker/PostgreSQL runtime job. The full graph audit remained FAIL. These successes validate the **additive candidate command**, not the final removal of `ts-node-dev`.

At PR #458 HEAD `24ba0fb322d9def2c68904dd979a9a3fd0ea6e7f`, workflow run `38559363749` generated a review-only patch artifact `11891617120` for removal of `ts-node-dev` and regeneration of `package-lock.json`. This is **not a committed dependency removal**.

At HEAD `f9d6a54bb831489188e205a9341b41e0088e6df6`, run `38559563846` began verifying `npm ci` with the modified candidate lockfile and capturing an unsuppressed candidate full audit. At the time of this note, the `npm ci` verification was still **in progress**; do not infer PASS or an improved finding count. Production dependency verification `38559563828` passed on this HEAD; other jobs were in progress.

**Independent decision gate:** Do not apply the generated patch, merge, deploy, or claim vulnerability reduction until candidate `npm ci` passes, its audit artifact is inspected, and runtime behavior is verified. Preserve the original 35-record full-graph baseline until a newer raw audit provides authoritative counts. Avoid concurrent edits to PR #458 while its exact-head verification runs.
