# @sails/example-simple-wallet

The dogfooding test for `@satsails/p2p-trading-sdk` (docs/TODO.md §25): the
canonical SDK golden-path integration, written using **only its public
API** — no reaching into this monorepo's internal services, no mocks.
It runs the real golden path against a real local Sails node:

```
register (seller) → register (buyer) → publish offer → discover offer
  → open trade → chat → create + lock escrow → mark payment sent
  → buyer registers payout address → release escrow → rate the trade
```

Release always pays the buyer's own registered payout address for the
asset (`settlement.setPayoutAddress()`); the node ignores any address the
releasing seller passes and refuses to release until one is registered.
The escrow is created as `type: 'MOCK'` so the example runs against a
plain local node; without it, `create()` picks the asset's real settlement
rail, which needs a funded testnet wallet on the node.

The question this answers: **can a developer integrate the SDK in under
15 minutes?** Read `src/index.ts` top to bottom — it's ~170 lines
including comments, uses 13 SDK methods, and needs nothing beyond what
`@satsails/p2p-trading-sdk`'s own types export.

This example proves the **SDK path**. It does not implement a real
`WalletAdapter` or prove a wallet-owned signing/custody boundary. For
that separate proof, continue to
[`../wallet-integration`](../wallet-integration).

## Run it

1. Start a Sails node (from the repo root):
   ```
   npm run dev
   ```
2. In a second terminal, from the repo root:
   ```
   npm run build -w @satsails/p2p-trading-sdk
   npm run start -w @sails/example-simple-wallet
   ```

You should see all 11 steps print and finish with:
```
Done — full golden path completed using only @satsails/p2p-trading-sdk's public API.
```

To point this at a different node (e.g. a staging deployment), set
`SAILS_BASE_URL`:
```
SAILS_BASE_URL=https://staging.example.com npm run start -w @sails/example-simple-wallet
```

## What this is *not*

This is not a UI and it is not the real-wallet adapter reference. There's
no wallet screen, no wallet-owned signing adapter, no key storage, and no
error recovery beyond a single clear message pointing back at the
prerequisite. Real wallets (see
[`../wallet-integration`](../wallet-integration) for the canonical
`WalletAdapter` / signing-boundary proof and `packages/sails-ui` for a
full screen-by-screen integration) need those responsibilities in
addition to the SDK flow demonstrated here.

This example exists purely to prove the SDK's public surface alone is
enough to drive the entire protocol, without shortcuts.

## A real finding from writing this

The first version of this example exposed a real pagination defect in
`liquidity.discover()`: only the cheapest 10 matching offers were reachable,
so the demo temporarily used an aggressively low offer price to guarantee
its freshly-published offer appeared in the first result set.

That limitation is **historical, not current API truth**. The current SDK
accepts optional `limit` / `offset`, and `discover()` returns pagination
metadata (`total` / `hasMore`) together with the offers. A caller should use
that pagination contract rather than rely on offer pricing to force an item
into the first page.

The low demo price may still be useful for deterministic local fixtures, but
it is no longer a required workaround for a missing pagination capability.
See `docs/API_STABLE.md` and `packages/sails-sdk/src/modules/liquidity.ts` for
the current contract.
