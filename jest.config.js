/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  clearMocks: true,
  // CTO 429 experiment: an absent MULTISIG_EXPLORER_API_URL points at a closed loopback port (refused at once), never
  // the public explorer. Explicit values are untouched. See tests/setup/closedExplorerDefault.ts.
  setupFiles: ['<rootDir>/tests/setup/closedExplorerDefault.ts'],
  // `app.ts` now imports the root package.json (API_VERSION, see its own
  // comment) — tsc's resolveJsonModule copies that file into dist/ as a
  // build artifact, which then collides with the real root package.json
  // in Jest's haste module map (both declare the same "name") once dist/
  // has been built locally. dist/ should never be scanned by Jest at all
  // regardless — this is the correct general exclusion, not a workaround
  // specific to that one file.
  //
  // docs/TEST_HARNESS_RELIABILITY.md (TECHNICAL_DEBT_AUDIT.md #59,
  // 2026-09-08 — distinct from item #57, which is a different, still-open
  // finding about buildApp() timeout contention under parallel Jest load)
  // — the same class of failure, a different source: the Agent tool's
  // `isolation: "worktree"`
  // feature (and any other tool that runs `git worktree add`) leaves a
  // full checkout, including its own `packages/sails-sdk/package.json`,
  // under `.claude/worktrees/<name>/` whenever a spawned agent makes
  // changes (its worktree is only auto-removed when it makes none).
  // Jest's own haste-map has no concept of "this directory is a git
  // worktree, not product source" — it indexes every package.json under
  // `roots` by its declared `name` field, so as few as ONE stray worktree
  // (confirmed empirically: excluding 3 of 4 present at investigation
  // time still reproduced the identical failure with the remaining one)
  // reintroduces the exact `@satsails/p2p-trading-sdk` name collision
  // `dist/`'s own exclusion above was written to prevent, breaking any
  // suite whose import graph reaches `safe-guard-evm.provider.ts`
  // (`escrow.service.ts` → `escrow-providers.ts` → that file's own
  // `@satsails/p2p-trading-sdk` import). This directory is never part of
  // this repository's own product source or test surface regardless of
  // whether a worktree currently happens to exist under it — it should
  // never be scanned by Jest at all, the same "correct general exclusion"
  // reasoning as `dist/` above, not a workaround specific to today's
  // leftover worktrees.
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.claude/worktrees/'],
  // @noble/curves v2.x (forced into packages/sails-sdk/node_modules by
  // @arkade-os/sdk's own transitive tree — verified via `npm ls
  // @noble/curves -w @satsails/p2p-trading-sdk --all`, npm cannot place a separate 1.x
  // copy there without breaking that tree) ships `"type": "module"` with
  // no real CJS entry point, even on its "require" condition. Jest's own
  // module registry (unlike plain Node 22+) doesn't interop with ESM-only
  // CJS-required packages, so `escrow-key.ts`/`custody/kms-signer.ts`
  // (both import `@noble/curves/secp256k1.js` directly) fail to load
  // under the default `transformIgnorePatterns`. ts-jest can transform
  // it like any other TS/JS source once it isn't ignored — verified: all
  // pre-existing `escrow-key.test.ts` cases still pass with this change.
  // `@arkade-os/sdk`'s own dependency tree turned out to have several
  // ESM-only (`"type": "module"`) transitive packages, discovered one at
  // a time as each new test file happened to import a different part of
  // it: `@noble/curves` v2.x (forced into packages/sails-sdk's own
  // node_modules by this same tree, no real CJS entry even on its
  // "require" condition), `micro-packed` (@scure/btc-signer/musig2.js's
  // dependency), a NESTED `@scure/base` copy under
  // node_modules/@arkade-os/sdk/node_modules/, and `@marcbachmann/cel-js`
  // (surfaced only once `safeGuardEvmProvider.test.ts` imported
  // `@satsails/p2p-trading-sdk`'s full barrel, which pulls in escrow-ark-signing.ts's
  // real `@arkade-os/sdk` import). Allowlisting each by name as it
  // surfaces doesn't scale — an empty transformIgnorePatterns (transform
  // everything, node_modules included) is the robust fix: ts-jest
  // downlevel-compiles real ESM/modern syntax to CJS the same way it
  // already does for this repo's own source, regardless of which
  // package it came from. Verified: the full existing suite still passes
  // with this change (slower, not broken).
  //
  // @prisma/client exception (Missão 06, 2026-08-16): found running the
  // first real-Postgres integration test with an interpolated `$queryRaw`
  // tagged template (`` prisma.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${x}))` ``,
  // event-store.ts's PostgresEventStore.publish()) — re-transpiling
  // @prisma/client's own pre-built runtime bundle breaks a real
  // `class Sql extends Array` its runtime constructs internally for
  // exactly this interpolated-template code path (a non-interpolated
  // `` $queryRaw`SELECT 1` `` never touches it, which is why app.ts's own
  // healthcheck query never surfaced this): "Must call super constructor
  // in derived class before accessing 'this'" — down-leveling an
  // already-built bundle's native `extends Array` under ts-jest breaks
  // native super-call semantics. Unlike the genuinely ESM-only packages
  // this empty-array default exists for, @prisma/client already ships a
  // valid, CJS-interoperable bundle and never needed re-transpiling —
  // excluding just it (and the generated `.prisma/client` query-engine
  // glue) is narrower than reverting to a real ignore list, and doesn't
  // reintroduce the ESM-only failures the empty array was added to fix.
  transformIgnorePatterns: ['node_modules/(?:@prisma/client|\\.prisma/client)/'],
  transform: {
    '^.+\\.(t|j)sx?$': ['ts-jest'],
  },
  moduleNameMapper: {
    // Resolve the workspace package straight to its TypeScript source so
    // tests never depend on `packages/*/dist` having been built first —
    // without this, `npm test` on a fresh clone fails until `npm run
    // build` has run once (found the hard way: deleting dist broke the
    // dispute suite while the code itself was fine).
    '^@satsails/p2p-schemas$': '<rootDir>/packages/sails-p2p-schemas/src/index.ts',
    // Same reasoning — `safe-guard-evm.provider.ts` (RFC-020) is the
    // first backend code to import `@satsails/p2p-trading-sdk` for real (its real
    // userOpHash math + SailsSignerService, not duplicated server-side).
    '^@satsails/p2p-trading-sdk$': '<rootDir>/packages/sails-sdk/src/index.ts',
    // Same reasoning again — the M3 shadow adapter
    // (expiry-shadow.ts) imports the Pure Core evaluator by package
    // name; tests must not depend on `packages/sails-core/dist` having
    // been built first.
    '^@sails/core$': '<rootDir>/packages/sails-core/src/index.ts',
  },
}
