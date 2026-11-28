# FAQ

## Is `@satsails/p2p-trading-sdk` on npm?

No. It's a workspace package (`packages/sails-sdk`), not published to
the public registry. That's why this starter lives *inside* the
`sails-push-ready` monorepo under `examples/`, rather than as a
standalone repo — a standalone repo couldn't `npm install` it today.

## Why does `client.liquidity.discover()` return offers with `paymentMethods` (plural), but `openp2p.trade()` gives me a `Trade` with no such field?

`discover()` returns `LiquidityOfferSummary` (from the liquidity
service's own query), `getTrade()`/`trade()` returns `Trade` (a
different real shape, from the trade service). They're not
interchangeable — see `docs/ARCHITECTURE.md`'s note on why this
starter's own "Discover offers" section renders plain rows instead of
reusing `TradeCard`.

## Why did `settlement.dispute()` fail with a config error?

`resolveDispute()` requires the resolving participant's id to be in the
running node's `TRUSTED_ARBITRATORS` env var (RFC-007 D4 — "each
application registers its own Trusted Arbitrators," not a protocol-wide
list). A fresh local node has this empty by design — see
`examples/escrow-with-arbitration.ts`'s own header comment for the
one-time setup (register an arbiter identity, add its id to
`TRUSTED_ARBITRATORS`, restart the node) before that script's dispute
resolution step will succeed.

## Which escrow type should I use?

Leave `type` unset when calling `settlement.create()`. The server picks
a sane default (`MOCK` on this repo's own local dev config, or
`MULTISIG` if `MOCK_ESCROW` isn't set) — both examples in this starter
do this deliberately. If you request a specific real provider
(`MULTISIG`, `WDK_USDT_EVM`, `SAFE_GUARD_EVM`; `LIGHTNING_HODL` is closed to new admissions)
directly, you take on that provider's real requirements: `MULTISIG`
needs actual on-chain BTC sent to a derived address before `lock()`
succeeds (it's genuinely non-custodial — it verifies funding, it
doesn't create it), `WDK_USDT_EVM`/`SAFE_GUARD_EVM` need a live EVM
RPC/bundler and, for the latter, AWS KMS. None of these are
automatable in an unattended script the way `MOCK` is.

## Can I call `negotiate()`, `submitProof()`, or `releaseAsset()`?

They exist on `SailsClient`'s six-verb Intent facade, but all three
throw `SailsNotImplementedError` unconditionally today
(`packages/sails-sdk/src/intent-facade.ts`) — there's no server-side
Intent → Trade → Escrow resolution wired up yet. Use the lower-level
`openp2p.*`/`settlement.*` methods instead, exactly as both example
scripts in this starter do. `createIntent()`, `cancelIntent()`, and
`dispute()` (the facade's `dispute`, distinct from
`settlement.dispute()`) are real and working.

## Do I need a `WalletAdapter`?

No, not for the flows in this starter. Identity is Ed25519
challenge-response (`identity.create`/`identity.authenticate`) and
doesn't need a wallet at all. `WalletAdapter`
(`src/wallet-mock/index.ts` in this starter) is a separate, optional
extension point for apps that also want to plug in on-chain signing —
none of the golden-path or dispute examples require it.

## What assets are actually supported?

`BTC`, `USDT_ERC20`, `USDT_TRC20`, `USDT_LIQUID`, `USDT_LIGHTNING`,
`LN_BTC`, `LIQUID_BTC`, `SPARK`, `STACKS`, `RSK_BTC`
(`packages/sails-sdk/src/types.ts`'s `AssetType`). No NFT or arbitrary
ERC-20/ERC-721 type exists — see `docs/USE_CASES.md` for what that
means for an NFT use case.

## `npx tsc --noEmit` or the dev server can't find `@satsails/p2p-trading-sdk` — what's wrong?

You're almost certainly not running from inside the
`sails-push-ready` monorepo, or haven't run `npm install` at its root
(workspaces need the root install, not a per-package one — this
starter has no `node_modules` of its own for workspace-linked
packages).

## Why is the Next.js dev server on port 3001, not 3000?

The Sails node itself defaults to port 3000. This starter's `dev`
script (`next dev -p 3001`) picks a different port so both can run at
once — set `NEXT_PUBLIC_SAILS_BASE_URL`/`SAILS_BASE_URL` (see
`.env.example`) if your node runs somewhere else entirely.
