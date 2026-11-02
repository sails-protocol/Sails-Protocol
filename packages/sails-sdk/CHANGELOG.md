# Changelog

All notable changes to `@satsails/p2p-trading-sdk` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Release mechanics, release authority, tag policy, and partial-failure recovery are
owned by [`docs/SDK_RELEASE.md`](../../docs/SDK_RELEASE.md). This changelog owns the
SDK change history, not the release process or API compatibility contract.

**Note on versioning:** published to npm 2026-08-10 as
`@satsails/p2p-trading-sdk@0.1.0` (public, under the `@satsails` org
scope â€” corrected/updated 2026-08-11, superseding the "not published"
note that used to sit here). `v1.0.0-rc1` below is a **release
candidate**, not a final `1.0.0` â€” by SemVer, `1.0.0-rc1` has *lower*
precedence than `1.0.0` itself. `docs/API_STABLE.md`'s freeze
commitment ("0.1 becomes 1.0 once this SDK has had real external
usage") is not contradicted by tagging an RC: an RC is exactly "this is
what we believe 1.0.0 will be, pending a real consumer proving it out"
â€” the actual `1.0.0` tag still waits for that.

**Historical RC-checkpoint context (2026-07-20):** the paragraph below records
a real failure observed while preparing the `v1.0.0-rc1` Git checkpoint. At
that time, moving the workspace package version outside the local consumer's
`^0.1.0` range made npm try the registry and the required package was not
available there, producing the recorded 404. The phrase "nothing is published"
is therefore preserved as a statement about that historical checkpoint, **not**
as a claim about current registry state. Later repository history records
0.1.x npm publications. Current live npm versions/dist-tags must be verified
against the registry when needed; this changelog does not infer them.

**A real gotcha found trying to bump `package.json`'s own `"version"`
field to match** (`0.1.0` â†’ `1.0.0-rc1`): `packages/sails-ui/package.json`
declares `"@satsails/p2p-trading-sdk": "^0.1.0"`. The moment the local package's version
moved outside that range, `npm install` stopped treating it as a
workspace-local symlink and tried to satisfy the range from the real
npm registry instead â€” which 404s, since nothing is published. Reverted
immediately (confirmed `npm install` clean again after). **Consequence:**
the git tag `v1.0.0-rc1` and this changelog heading are intentionally
decoupled from `package.json`'s `"version"` field, which stays `0.1.0`
until either a real publish happens or every workspace consumer's
declared range is widened at the same time â€” not something to do
silently as a side effect of tagging a release candidate.

## [0.1.2] - 2026-08-11

### Fixed
- `custody/kms-signer.ts`'s lazy `import('@aws-sdk/client-kms')` is now
  built inside a `Function` constructor body, making the specifier
  genuinely invisible to every bundler's static analysis (the same
  established trick real packages use for optional native addons, e.g.
  `ws`'s bufferutil/utf-8-validate loading). This is a **correction to
  0.1.1**, not just an addition â€” 0.1.1's `webpackIgnore`/
  `turbopackIgnore` magic-comment fix solved Next.js/Turbopack but broke
  a second real target the same day: Hermes (React Native/Metro) doesn't
  parse a comment inside `import()` at all and hard-fails to bundle.
  A follow-up attempt (hiding the specifier behind a plain `const`)
  fixed Hermes's parser but Metro still statically resolved the import â€”
  Metro does constant-folding on top-level string literals before its
  import scan, unlike Turbopack/webpack. Confirmed green against both a
  real `expo export --platform android` and `next build` this time, not
  assumed from one bundler generalizing to the others. No API or
  Node.js runtime behavior change in either release.

## [0.1.1] - 2026-08-11 (superseded by 0.1.2 â€” see above)

### Fixed
- `custody/kms-signer.ts`'s lazy `import('@aws-sdk/client-kms')` now
  carries `webpackIgnore`/`turbopackIgnore` magic comments. Found via
  an actual standalone Next.js/Turbopack build of `0.1.0` pulled fresh
  from npm (not `tsc`/`jest`, which both erase this to a plain runtime
  call and never catch it): browser bundlers statically resolve every
  `import()` at build time regardless of whether it's ever reached, so
  any client-side consumer without `@aws-sdk/client-kms` installed hit
  a hard build failure â€” even one that never instantiates
  `SailsSignerService`. No API or Node.js runtime behavior change.

## [Unreleased]

### Fixed
- `openp2p.reconcileTrade()` was typed as returning `Message[]`, but the
  route returns an object: `{ tradeId, currentTradeStatus,
  currentEscrowStatus, missedMessages }`. It is now typed as the new
  exported `TradeReconciliation`. No runtime change; code that treated the
  result as an array never received one.

## [0.2.0] - 2026-09-17

### Added
- Added deterministic escrow key recovery support.
- Added SDK surfaces introduced since 0.1.3 for settlement, dispute, trade-proposal, and recovery flows.
- Added SDK support for the current QVAC-negotiated trade proposal flow.

### Changed
- Reconciled SDK authentication behavior with the current server/session contract.
- Reconciled escrow creation and SDK-facing settlement/dispute contracts, including SPLIT and payout-destination handling.
- Migrated SDK offer-detail consumption to the current public offer-detail contract.
- Updated the `@satsails/p2p-schemas` dependency range to `^0.2.0`.
- Aligned package identity with the independently versioned `0.2.0` release.

### Fixed
- Fixed SDK authentication regressions and discovery pagination behavior.
- Corrected SPLIT-related representation and payout-destination handling across the SDK-facing contract.
- Corrected SDK-facing shared type mismatches identified during cross-layer reconciliation.


## [0.1.3] - 2026-08-16

**MissÃ£o 07.5 finding, the main reason for this release:** `0.1.2`
(published 2026-08-11) predates a 2026-08-15 security fix
(`openp2p.ts`) that migrated `chat()`'s WebSocket auth from a raw,
reusable `?token=<session token>` query param to a short-lived,
single-use `?ticket=` (minted via `POST /v1/identity/ws-ticket`
immediately before every connection attempt, including every
reconnect). The backend (`chat.routes.ts`) only accepts `?ticket=` â€”
there is no fallback â€” so every `0.1.2` client's chat connection opened
successfully at the WebSocket-handshake level and was then immediately
rejected by the server, which the client's own reconnect-with-backoff
logic (correctly) interpreted as a dropped connection and kept retrying
forever. Confirmed via a raw-socket diagnostic against the real local
backend: `0.1.2`'s exact connection shape gets an `ERROR` frame +
close within single-digit milliseconds; the current `?ticket=` shape
connects cleanly. This was a **stale-publish problem, not a source
defect** â€” `packages/sails-sdk/src`'s `WebSocketChannel`/`chat()` were
already correct; `0.1.2`'s `dist/` simply predated that fix and nobody
bumped the version to ship it. Verified fixed: built current source,
`npm pack`'d it, installed the tarball into a directory with zero
monorepo access, and ran the full 10-step canonical golden path â€”
chat opened cleanly on both sides with no reconnect loop, message
delivered, escrow released, reputation rated.

### Fixed
- `openp2p.chat()`'s WebSocket auth (see above) â€” now actually shipped
  to npm, not just present in source. No API change: `chat()`'s own
  signature was already unchanged when this landed in source on
  2026-08-15.
- `settlement.get(escrowId)` / `settlement.getDispute(disputeId)` sent
  no `Authorization` header, so both 401'd against the backend's
  MissÃ£o 06.8 auth requirement (party-scoped reads) â€” every consumer
  of a completed trade's own escrow/dispute record was broken. Now
  sends `Authorization` like every other authenticated call.
- `proof.getTradeEvidenceBundle(tradeId)` â€” same missing-auth bug,
  same fix (MissÃ£o 06.6 made this route participant-scoped).
- `liquidity.discover()`'s pagination/aggregation â€” `getAggregatedOffers()`
  now requests enough rows from each provider to actually satisfy
  `offset + limit` (previously capped at a fixed 10 regardless of what
  was asked for) and computes `total`/`hasMore` from a real count
  across providers run in parallel, instead of an arbitrary provider-local
  slice. Found via a full 13-stage Golden Path Matrix audit exercising a
  marketplace with more than 10 real offers.
- `src/modules/open-liquidity/liquidity.routes.ts` (backend) â€” `asset`
  query/body param now validated against the real `AssetType` enum
  instead of accepting any non-empty string, closing a stack-trace-leak
  path found during a real npm-install cold-start dogfooding pass.

### Added
- Test coverage for all of the above at both the SDK level
  (`packages/sails-sdk/tests/modules.test.ts` â€” `Authorization` header
  assertions for the three fixed calls, plus a new test proving
  `chat()` mints a fresh single-use ticket on the initial connection
  AND again on every reconnect, never reusing one) and the backend
  level (`tests/liquidityDiscoverPagination.test.ts`).
- `examples/simple-wallet` â€” the canonical golden-path reference now
  completes all 10 real steps end to end, including both sides rating
  the trade via `reputation.rate()` and reading back
  `reputation.get()`. Wired to a real `typecheck` npm script so this
  example is continuously verified, not just runnable.
- `WebSocketChannel` now sends a real heartbeat (`PING` every 30s by default,
  force-closes if no `PONG` arrives within 60s) to catch "zombie
  connections" â€” a socket object that's still open but whose underlying
  network path silently died, with no `close` event ever firing on its own
  (CTO_DUE_DILIGENCE_REPORT.md A-STA-03, closed 2026-08-08). The force-close
  feeds into the exact same reconnect-with-backoff path a real network drop
  already uses. New `WebSocketChannelOptions` fields: `heartbeat` (default
  `true`), `heartbeatIntervalMs` (default `30000`), `heartbeatTimeoutMs`
  (default `60000`) â€” all additive, no existing caller's code needs to
  change. The server side (`chat.routes.ts`) already answered `PING` with
  `PONG`; only the client side was silent.
- `SailsClient.proof` â€” now exposes the `SailsProofModule` (RFC-006, RFC-007) as
  `client.proof`, with `assertClaim()`, `submitProof()`, `issueVerificationNonce()`,
  `verifyProof()`, and `getEvidenceBundle()`. Previously the module existed as a
  standalone export but was never wired onto `SailsClient`.
- `Proof` and `Verification` types exported from the package root (both were
  already defined in `types.ts` but not re-exported from `index.ts`).
- `useSailsProof()` React hook in `@satsails/sdk-react` â€” wraps all five
  `SailsProofModule` methods with TanStack Query (`getEvidenceBundle` query,
  `assertClaim`/`submitProof`/`issueVerificationNonce`/`verifyProof` mutations).
  10 tests (5 success-path + 5 error-state) added to `tests/useSailsProof.test.tsx`.

### Changed
- `liquidity.discover()` (and the underlying backend
  `LiquidityRouter.getAggregatedOffers()`) now returns `{ offers, sources,
  total, hasMore }` instead of `{ offers, sources }`. The backend now applies
  global pagination (sort-then-slice across all aggregated providers) rather
  than per-provider pagination, and returns the total count and `hasMore`
  flag directly (MissÃ£o 07.1 closed the remaining gap: providers were still
  being asked for a fixed 10 rows regardless of what `offset+limit` actually
  needed â€” see Fixed above). `getOrderBook()` is unaffected â€” it only reads
  `.offers` from each side's result.
- `docs/SDK_GUIDE.md` section 2 updated to document `discove()`'s new
  `DiscoverResult` shape (with `total`/`hasMore`), plus the previously-undocumented
  `approveRelease()`, `getReleaseApprovals()`, `registerArbiter()`,
  `getArbiterProfile()`, `reconcileTrade()`, `getScoreByPeerId()`, and the
  full `proof:` namespace.

### Process change (MissÃ£o 07.5 CTO decision)
- No future SDK version will be published from a `dist/` that wasn't
  freshly rebuilt from the exact source it's tagged against. MissÃ£o
  07.6 adds an explicit `source â†’ clean build â†’ npm pack â†’ external
  smoke test â†’ publish` gate to the release process so the registry is
  part of the release test, not a disconnected manual step.

## [1.0.0-rc1] - 2026-07-20

Release-candidate audit pass (docs/TODO.md Â§28) â€” a final check for
internal implementation details leaked onto the public surface, before
handoff to ongoing maintenance. No new features; only real problems
found and fixed.

### Fixed (this audit)
- `SailsTransport`/`SailsTransportOptions` were re-exported from the
  public package root despite zero documented use case and zero real
  external usage â€” removed from the public surface (still exported
  from `transport.ts` itself for this package's own internal use).
- `SailsIntentFacade` (the class) was re-exported from the public
  package root despite `SailsClient.intents` being deliberately
  `private` specifically to prevent exactly this â€” a caller could
  construct one directly against a raw transport, bypassing
  `SailsClient`'s session management entirely. Removed from the public
  surface; the two payload types it also exports (`NegotiationEvent`,
  `ProofSubmission`) stayed, since `negotiate()`/`submitProof()`
  callers genuinely need them.
- One internal `as unknown as typeof fetch` cast in `transport.ts`'s
  constructor removed via restructuring (resolve â†’ validate â†’ assign,
  instead of assign-with-cast â†’ validate).
- `docs/SDK_GUIDE.md` section 2's interface listing â€” despite its own
  banner claiming "verified route-by-route" â€” had drifted from the
  real implementation across `identity`/`liquidity`/`settlement`/
  `reputation` (wrong method names and signatures throughout;
  `liquidity.cancel()` was documented but never built â€” the real
  equivalent is `updateStatus()`). Rewritten to match the real code.

### Added

Everything below was already on `main` before this audit pass â€” folded
into this first tagged version rather than re-listed as a separate
entry.
- Initial SDK: `SailsClient`, the Transport layer, and six Protocol SDK
  modules â€” `identity`, `reputation`, `liquidity`, `openp2p`,
  `settlement`, `peers` â€” plus the Intent-oriented six-verb facade
  (`createIntent`/`cancelIntent`/`negotiate`/`submitProof`/
  `releaseAsset`/`dispute`).
- `capabilities` module and `WalletAdapter` (RFC-013: Capability
  Registry + portable identity via `peerId`).
- `openp2p.getTradeByIntent(intentId)` â€” RFC-018's Intentâ†’Trade link,
  exposed directly.
- Friendly aliases on `SailsClient`: `auth`/`offers`/`trades`/`escrow`/
  `trustScore`, each the exact same instance as its protocol-name
  counterpart (`identity`/`liquidity`/`openp2p`/`settlement`/
  `reputation`) â€” not a rename, both frozen together. See
  `docs/API_STABLE.md`.
- `liquidity.discover()` gained optional `limit`/`offset` (default 10,
  max 50) â€” see Fixed below for why.
- `examples/simple-wallet` â€” a real, mock-free integration example
  using only this package's public API, proving the full golden path
  (register â†’ publish â†’ discover â†’ trade â†’ chat â†’ escrow â†’ release)
  works end to end.
- TypeDoc config (`npm run docs` from this package) generates browsable
  API docs from source + JSDoc directly.

### Fixed
- `dispute(intentId, reason)` â€” was a hardcoded `SailsNotImplementedError`
  stub; now resolves the real Trade/Escrow behind an `intentId` and
  performs a real dispute. `negotiate()`/`submitProof()`/`releaseAsset()`
  remain honest stubs (their server-side primitives don't exist yet) â€”
  their thrown messages were corrected to name the real, specific
  blocker instead of a generic "not implemented."
- `liquidity.discover()`/`liquidity.book()` were typed as returning the
  persisted `Offer` shape; the real route
  (`GET /v1/liquidity/offers`) returns a materially different
  aggregation shape (`LiquidityOfferSummary` â€” `paymentMethods[]` not
  `paymentMethod`, no `userId`/`status`, an aggregation-only `source`).
  Corrected to match the real response, found wiring the first real
  caller (`packages/sails-ui`).
- `openp2p.chat()`'s delivered message events were typed with the
  persisted `Message` row's field names (`id`, `createdAt`); the real
  WS `NEW_MESSAGE` frame payload uses different names (`messageId`,
  `timestamp`, no `readAt`). Corrected, same root cause as above â€” a
  live WS round trip was never exercised by this package's own tests
  until a real caller existed.
- `intent-facade.ts`'s `createIntent()` had an authorization gap
  (accepted a caller-supplied identity in the request body instead of
  deriving it from the authenticated session) â€” closed as part of a
  broader gap audit across the reference implementation.
- `Trade`'s type didn't expose the seller's payment details
  (`paymentDetails`, e.g. a PIX key) â€” added, so a buyer can actually
  see how to pay.
- `liquidity.discover()`'s hard `take: 10` cap (no pagination) meant a
  normally-priced new offer could be silently invisible on any
  sufficiently active marketplace â€” the exact failure a dogfooding pass
  (`examples/simple-wallet`) hit on its first real run. Fixed with the
  `limit`/`offset` params above (backend: `liquidity.service.ts`,
  `liquidity.routes.ts`). The same default-limit gap was also live in
  `packages/sails-ui`'s actual Marketplace screen
  (`realOffers.ts` calling `discover()` with no `limit`) â€” fixed there
  too, a real user-facing bug, not just a test artifact.

### Changed
- `reputation` intentionally has **no** `profile` alias â€” that module
  only returns a numeric trust score (`get`/`leaderboard`/`rate`), never
  displayName/avatar/trade history (that's `identity`), so `profile`
  would have promised more than it returns. Named `trustScore` instead.
- Dependency versions bumped across a Dependabot major-version sweep
  (TypeScript intentionally held back to avoid unrelated breakage).

### Verified, not changed
- **Package footprint:** `npm pack` â†’ 22.3 kB packed / 77.4 kB unpacked,
  31 files (2026-07-20).
- **Standalone install:** installed the packed tarball into a folder
  with zero relation to this monorepo (no workspace symlinks, no shared
  `node_modules`) and ran a smoke script exercising every module, every
  alias, `generateKeypair()`, and the error classes â€” all worked
  identically to running inside the workspace.
- **Tree-shaking: does not apply today.** `package.json` only declares
  `main` (CommonJS) â€” no `module`/`exports`/`sideEffects` fields, no ESM
  build. Real tree-shaking requires static ESM analysis; a CJS-only
  package like this one cannot be meaningfully tree-shaken by any
  bundler regardless of how imports are written at the call site. Not
  fixed here â€” a dual CJS/ESM build is new packaging infrastructure,
  out of scope for this hardening pass (docs/TODO.md Â§15's freeze:
  verify and hold the line, don't add).
- **Node version:** verified against Node 24.16.0 only (this
  environment's only available runtime â€” no `nvm`/`fnm` present to test
  Node 20/22 LTS). Registered as an open verification gap, not silently
  claimed.
