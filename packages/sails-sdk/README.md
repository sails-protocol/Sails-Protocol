# `@satsails/p2p-trading-sdk` — Sails P2P Trading SDK

[![npm version](https://img.shields.io/npm/v/@satsails/p2p-trading-sdk.svg)](https://www.npmjs.com/package/@satsails/p2p-trading-sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../../LICENSE)
[![CI](https://github.com/alan-schramm/Sails-Protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/alan-schramm/Sails-Protocol/actions/workflows/ci.yml)

The single typed client a wallet/fintech imports to reach every Sails
Protocol module (OpenIdentity, OpenLiquidity, OpenP2P, OpenSettlement,
OpenReputation, OpenProof, OpenAgents) over HTTP/WebSocket. See
[`docs/SDK_GUIDE.md`](../../docs/SDK_GUIDE.md) for how to build a real
integration, [`docs/API_STABLE.md`](../../docs/API_STABLE.md) for the
frozen no-breaking-changes contract, and [`docs/EXAMPLES.md`](../../docs/EXAMPLES.md)
for small copyable wallet-method snippets.

For release history, see [`CHANGELOG.md`](CHANGELOG.md). Maintainers should use
[`docs/SDK_RELEASE.md`](../../docs/SDK_RELEASE.md) for the canonical release
contract, tag policy, authority model, and partial-failure recovery rules.

Install:

```bash
npm install @satsails/p2p-trading-sdk
```

If you also need a local Sails node, start with
[`docs/GETTING_STARTED.md`](../../docs/GETTING_STARTED.md). The canonical
SDK golden path is [`examples/simple-wallet`](../../examples/simple-wallet).
When you are ready to connect real wallet-owned signing and custody,
continue to [`examples/wallet-integration`](../../examples/wallet-integration).

## Quick start

```ts
import { SailsClient } from "@satsails/p2p-trading-sdk"

const client = new SailsClient({
  baseUrl: "http://localhost:3000",
})

// Register a participant and authenticate (Ed25519 challenge-response,
// byte-for-byte equivalent to src/common/middleware/auth.ts on the server).
const { keypair } = await client.identity.create()
await client.identity.authenticate(keypair)

// Discover offers and create a trade
const { offers } = await client.liquidity.discover({
  asset: "BTC",
  side: "BUY",
  limit: 10,
})
const trade = await client.openp2p.trade(offers[0].id, "0.001")

// Open the negotiation chat channel (WebSocket, real reconnect-with-backoff)
const chat = client.openp2p.chat(trade.id)
chat.onMessage((msg) => console.log(msg.content))
chat.send({ content: "Sending payment now", msgType: "TEXT" })
```

The SDK works in both Node.js (18+/20+/22+) and modern browsers. It
has no Node-only dependencies beyond `tweetnacl` (pure JS Ed25519).
This is the SDK consumer runtime claim; running this repository's local
server/monorepo has its own requirements documented in
[`docs/GETTING_STARTED.md`](../../docs/GETTING_STARTED.md).

## React Native setup

Confirmed bundling cleanly for both Android and iOS (Hermes, React
Native 0.86, Expo SDK 57 — the same engine on both platforms since RN
0.84's Hermes V1), via `expo export` and `hermesc` syntax validation
directly against the built bundle. Not yet confirmed running end-to-end
on a physical device (blocked on this session's own network tooling,
not the SDK). Two things a React Native app needs to do that a web/Node
consumer doesn't:

1. **Polyfill `Buffer` before importing the SDK.** Hermes has no
   Node.js globals; the SDK's Bitcoin-signing dependencies
   (`bitcoinjs-lib`/`ecpair`) reference `Buffer` at module-load time.
   Install `buffer` (`npm install buffer`) and add this as its own
   module, imported *first* — before any other import in your app's
   entry point:

   ```ts
   // polyfills.ts — must be its own file. ES module import
   // declarations always evaluate before any plain statement in the
   // importing file, so mixing `global.Buffer = Buffer` into the same
   // file as your SDK import runs too late to matter — confirmed the
   // hard way debugging this exact failure.
   import { Buffer } from 'buffer'
   global.Buffer = global.Buffer || Buffer
   ```

   ```ts
   // App.tsx (or index.ts) — first line, before anything else
   import './polyfills'
   ```

2. **No bundler configuration needed for the SDK's optional AWS KMS
   path.** `custody/kms-signer.ts`'s lazy `import('@aws-sdk/client-kms')`
   is built to be invisible to every major bundler's static analysis
   (Metro, Turbopack, webpack) — confirmed against real `expo export`
   (Android and iOS) and `next build` runs, not assumed. A consumer who
   never instantiates `SailsSignerService` never triggers the import,
   with no `metro.config.js` changes required.

## Module map

| Protocol name | Friendly alias | Source | What it does |
| --- | --- | --- | --- |
| `client.identity` | `client.auth` | `modules/identity.ts` | Register a Participant, Ed25519 challenge-response auth, session management |
| `client.liquidity` | `client.offers` | `modules/liquidity.ts` | Publish/discover/manage Offers, the order book |
| `client.openp2p` | `client.trades` | `modules/openp2p.ts` | Open/manage a Trade, real-time chat (`chat(tradeId)`) |
| `client.settlement` | `client.escrow` | `modules/settlement.ts` | Escrow lifecycle: create, lock, release, refund, dispute |
| `client.reputation` | `client.trustScore` | `modules/reputation.ts` | Reputation score, leaderboard, rating submission |
| `client.peers` | — | `modules/peers.ts` | P2P transport node (start/stop, topic/trade rooms) |
| `client.capabilities` | — | `modules/capabilities.ts` | RFC-013 Capability Registry: register/list/revoke grants |
| `client.arbitration` | — | `modules/arbitration.ts` | RFC-021 D2: permissionless arbiter registration |
| `client.paymentAccounts` | — | `modules/payment-account.ts` | RFC-021 D5: payment-account trust ramp |
| `client.proof` | — | `modules/proof.ts` | RFC-006 OpenProof: claims, proofs, verification |

The Intent-oriented facade (`client.createIntent`, `cancelIntent`,
`dispute`, `submitProof`, `releaseAsset`) is the recommended path for
most applications; the module-level methods above are for advanced/direct
use. Only `client.negotiate` still throws `SailsNotImplementedError` —
see `intent-facade.ts`'s own header for the architectural reason.

Since 2026-11-15 (E21 slice 1, PR #651; same signatures, new error
outcomes): `cancelIntent` answers 409 `INTENT_BOUND` for an Intent an
Offer or a Trade references (cancel the trade or the Offer instead);
`dispute`, `releaseAsset` and `openp2p.getTradeByIntent` answer 409
`AMBIGUOUS_INTENT` (`details.tradeIds`) when an Offer's Intent matches
several of your trades, and 404 instead of 403 when you are not a party.
Both 409s arrive as a `SailsError` with that `code`. Details:
[`docs/API_STABLE.md`](../../docs/API_STABLE.md).

## Wallet adapter (optional)

`SailsClient` accepts an optional `wallet: WalletAdapter` for wallet
integration. Without one, every wallet-requiring method (`getBalance`,
`sendTransaction`, `signMessage`, `getWalletAddresses`,
`getCapabilities`) throws a clear `SailsTransportError` pointing at the
fix.

For local/example code, use the publicly exported `MockWalletAdapter` and
[`docs/EXAMPLES.md`](../../docs/EXAMPLES.md). For a real integration, your
wallet implements the public `WalletAdapter` contract while keeping
ownership of its own keys, signing, storage, transport and broadcast
responsibilities. The canonical non-mock Bitcoin/EVM reference is
[`examples/wallet-integration`](../../examples/wallet-integration).

In short: **keep your wallet stack; plug into Sails.** That means Sails
provides the coordination/client surface; it does not require the wallet
to surrender key management or signing ownership.

## Build

```bash
npm run build -w @satsails/p2p-trading-sdk    # produces dist/ via tsup
npm test -w @satsails/p2p-trading-sdk         # jest + ts-jest, 33 tests
npm run typecheck -w @satsails/p2p-trading-sdk # tsc --noEmit
```

## License

Apache-2.0 (same as the rest of this repository).
