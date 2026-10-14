# UI Buffer polyfill remediation: non-regression contract

This is an **investigation-only** branch stacked on draft #460, tracked by #461. No dependency or Vite configuration change is authorized here.

## Confirmed root cause

`packages/sails-ui/vite.config.ts` documents a browser runtime crash in the SDK's eager `bitcoinjs-lib` ECC initialization path: `Buffer` is not available globally. The existing `vite-plugin-node-polyfills` config enables **only** `Buffer`, with `global: false` and `process: false`. Blindly removing the plugin would risk a permanently blank UI, even when `tsc` and `vite build` pass.

## Candidate requirements

1. Capture the exact `npm audit --json` package records from the full graph (baseline #460: 34), especially `vite-plugin-node-polyfills`, `node-stdlib-browser`, `crypto-browserify`, `browserify-sign`, `create-ecdh`, and `elliptic`.
2. Evaluate a narrowly scoped replacement that provides a browser-compatible `Buffer` **before** SDK import/eager initialization, rather than polyfilling the entire Node standard library.
3. Reproduce and test the prior blank-root failure: browser-render smoke must assert a non-empty React root and zero uncaught `pageerror` exceptions, including Marketplace and Trade entry paths. Verify real SDK import, not a mocked substitute.
4. Run UI typecheck/build, Node 24 full CI and CI Tests, Docker/PostgreSQL integration, unsuppressed full and production audits on the candidate's exact committed HEAD.
5. Compare raw vulnerability keys, severities, and added records. No claim of remediation from a package removal alone. Preserve **FAIL / STOP** while findings remain.

## Constraints

Do not remove the existing plugin or edit the lockfile on this evidence-only branch. No merge, deploy, freeze, security waiver, or override without independent Gatekeeper review.
