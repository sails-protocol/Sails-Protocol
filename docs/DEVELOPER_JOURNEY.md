# DEVELOPER_JOURNEY.md
### Sails Protocol — Current Developer Journey

> **Status / authority:** current developer-journey orientation for the published `@satsails/p2p-trading-sdk`.
> For exact method stability and shape, `API_STABLE.md` wins. For current production eligibility, use
> `BACKLOG.md`, live GitHub Issues/Project and provider/evidence records. A working SDK/API path does
> **not** imply that every underlying rail/provider is production-eligible.

## The Developer Journey — from package install to a working P2P integration

```
Install Sails P2P Trading SDK → Create Wallet → Enable OpenP2P →
Enable Settlement → Enable Reputation → Working Marketplace
```

"Sails P2P Trading SDK" is the MVP's product name for the `@satsails/p2p-trading-sdk`
package — see `PROJECT_CONTEXT.md` section 3 for why it's scoped that
way rather than the long-term "Sails SDK."

This is the same shape as the developer diagram in `PROJECT_CONTEXT.md`
section 3, walked one layer at a time. Each step below adds exactly one
module. Nothing here requires understanding the protocol's internals
first — that's the point: a wallet developer should be able to follow
this without reading `PROTOCOL_SPECIFICATION.md`.

---

### Step 1 — Install the Sails P2P Trading SDK

**Status: ✅ Real / published.** The repository package is currently
`@satsails/p2p-trading-sdk@0.2.0`. Install it with:

```bash
npm install @satsails/p2p-trading-sdk
```

One package. No per-module installs, no separate clients for identity,
settlement, and reputation — that flattening is the SDK's entire reason
to exist (`SDK_GUIDE.md` section 1).

### Step 2 - Create a wallet-backed client

**Status: ✅ Real** (`SailsClient` is fully implemented in v0.1; the
`baseUrl` + optional `wallet` constructor below is real, verified against
`packages/sails-sdk/src/client.ts`).

```typescript
import { SailsClient } from '@satsails/p2p-trading-sdk'

const sails = new SailsClient({
  baseUrl: 'http://localhost:3000',
})
```

The `wallet` field is optional - every authenticated method on
`SailsClient` works over plain HTTP/WS alone. Supplying one unlocks
the wallet-backed convenience methods (`getBalance`,
`getWalletAddresses`, `sendTransaction`, `signMessage`,
`getCapabilities`) and `identity.authenticateWithWallet()`; see
`docs/EXAMPLES.md` for the `MockWalletAdapter` reference implementation.

Everything past this line talks to `sails`, not to WDK, Pears, or QVAC
directly - those three stay infrastructure the protocol coordinates,
never things your wallet code calls into on its own (`PROJECT_CONTEXT.md`
section 3).

### Step 3 - Enable OpenP2P (negotiation)

**Status: ✅ Real.** `SailsClient` exposes the current OpenP2P trading and
chat surface. OpenP2P is not the only real module anymore; use `API_STABLE.md`
for the current public module inventory and exact supported methods.

```typescript
// Discover offers (the discover() filter takes asset + side + optional
// pagination only - paymentMethod/price-range filters described in
// API_REFERENCE.md are aspirational, not yet implemented).
const matches = await sails.liquidity.discover({
  asset: 'BTC',
  side: 'BUY',
  limit: 10,
  offset: 0,
})

// Open a trade with the best match (requires an active session).
const trade = await sails.openp2p.trade(matches[0].id, '0.001')

const chat = sails.openp2p.chat(trade.id)
chat.onMessage((msg) => console.log(msg.content))
chat.send({ content: 'Sending payment now', msgType: 'TEXT' })
```

### Step 4 - Enable Settlement (escrow)

**Status: ✅ Real** (`sails.settlement.create` / `lock` / `release` are
real implementations of MULTISIG, LIGHTNING_HODL, SAFE_GUARD_EVM,
WDK_USDT_EVM, and MOCK providers, all covered by integration tests).

```typescript
// create() takes an object body (EscrowType, lockedAmount, asset,
// network?, timelockHours?) - not positional args.
const escrow = await sails.settlement.create({
  tradeId: trade.id,
  type: 'MULTISIG',
  lockedAmount: '0.001',
  asset: 'BTC',
})
await sails.settlement.lock(escrow.id)
// buyer sends fiat directly to seller, shares proof via chat.
// Release pays the buyer's own registered payout address: before this,
// the buyer's client calls
//   settlement.setPayoutAddress({ asset: 'BTC', address })
// The node ignores any address the seller passes to release().
await sails.settlement.release(escrow.id)
```

This is the step that turns a negotiation into money actually moving -
non-custodially: Sails Protocol never holds the funds itself.

### Step 5 — Enable Reputation

**Status: ✅ Real.** Reputation is exposed through `sails.reputation`
(alias `sails.trustScore`) with score, leaderboard and rating methods.
Use `API_STABLE.md` for the exact frozen surface.

```typescript
await sails.reputation.rate(trade.id, 5)
```

Reputation is portable across every module and every wallet that
integrates the protocol — it's tied to the keypair from Step 2, not to
your app (`ARCHITECTURE.md` section 3).

### Step 6 — Working Marketplace

Five steps, one SDK, one keypair. What you have at this point is a wallet
that can discover a counterparty, negotiate, settle non-custodially, and
build portable reputation — the definition of a P2P Financial Marketplace
used throughout this project (`PROJECT_CONTEXT.md` section 1). Everything
past this — OpenAgents fraud detection, OpenFinance's future modules — is
additive, not required to reach a working Marketplace.

---

## Where the honesty caveat matters most

If you are evaluating Sails Protocol today, the SDK and the core developer
journey above are real integration surfaces, but maturity must be read
per capability. Some providers/rails remain testnet-only, reference-only,
production-ineligible, or blocked by Day-0 hardening.

Use `API_STABLE.md` for what is callable and stable, `GETTING_STARTED.md`
for the current executable onboarding path, and `BACKLOG.md` plus live
GitHub Issues/Project for unresolved production-readiness obligations.

**SDK integration reality ≠ rail/provider Production Eligibility.**
