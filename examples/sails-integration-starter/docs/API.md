# API reference (index)

A thin pointer into `@satsails/p2p-trading-sdk`'s and `@satsails/sdk-react`'s real,
current public surface — verified directly against source at the time
of writing, not against `docs/SDK_GUIDE.md`'s §4 or
`docs/DEVELOPER_JOURNEY.md`'s code snippets, both confirmed stale
elsewhere in this repo (wrong `SailsClient` constructor shape, methods
that don't match reality). For full JSDoc on any method below, read the
linked source file directly — it's kept accurate because the SDK's own
tests exercise it.

## `SailsClient` (`packages/sails-sdk/src/client.ts`)

```ts
new SailsClient({ baseUrl, fetchImpl?, webSocketImpl?, wallet? })
```

Exposes module instances directly: `.identity` (alias `.auth`),
`.reputation` (alias `.trustScore`), `.liquidity` (alias `.offers`),
`.openp2p` (alias `.trades`), `.settlement` (alias `.escrow`), `.peers`,
`.capabilities`. Also exposes a six-verb Intent facade directly on the
client — see the caveat in `FAQ.md` about which three of those six
verbs actually work.

## `identity` — `packages/sails-sdk/src/modules/identity.ts`

| Method | Auth required | Notes |
|---|---|---|
| `create(keypair?, displayName?)` | no | registers a Participant; generates a keypair if omitted |
| `authenticate(keypair)` | no | full challenge→sign→verify flow, stores the session token |
| `challenge(publicKeyHex)` | no | lower-level, rarely needed directly |
| `get(participantId)` | no | |
| `me()` | yes | |

## `liquidity` — `packages/sails-sdk/src/modules/liquidity.ts`

| Method | Auth required |
|---|---|
| `publish(input)` | yes |
| `discover({asset, side, limit?, offset?})` | no |
| `getOffer(offerId)` | no |
| `book(asset)` | no |
| `updateStatus(offerId, status)` | yes |
| `match(input)` | no |

## `openp2p` — `packages/sails-sdk/src/modules/openp2p.ts`

| Method | Auth required |
|---|---|
| `trade(offerId, amount)` | yes |
| `getTrades(pagination?)` | yes |
| `getTrade(tradeId)` | no |
| `getTradeByIntent(intentId)` | no |
| `updateTradeStatus(tradeId, status)` | yes |
| `getMessages(tradeId)` | no |
| `chat(tradeId)` → `WebSocketChannel` | yes (throws if no session) |

## `settlement` — `packages/sails-sdk/src/modules/settlement.ts`

| Method | Auth required | Notes |
|---|---|---|
| `create(input)` | yes | `type` optional — see `FAQ.md` |
| `get(escrowId)` | no | |
| `submitKey(escrowId, pubkeyHex)` | yes | client-held-keys providers only |
| `lock(escrowId)` | yes | |
| `markPaymentSent(escrowId)` | yes | |
| `release(escrowId, toAddress?)` | yes | Direct release, for providers without client-held keys (`MOCK` locally, `WDK_USDT_EVM` on testnet). `toAddress` is ignored: the server uses the buyer's registered payout address. |
| `dispute(escrowId, reason, evidence?)` | yes | needs `TRUSTED_ARBITRATORS` configured — see `FAQ.md` |
| `refund(escrowId)` | yes | |
| `initiateRelease`/`initiateRefund`/`submitTransactionSignature`/`getPendingTransaction` | yes/no | Signature-collection flow for the client-held-key providers (`MULTISIG`, `SAFE_GUARD_EVM`); `LIGHTNING_HODL` is closed to new admissions |
| `resolveDispute(disputeId, ruling, releaseToAddress?)` | yes | caller must be the dispute's assigned arbiter |

## `reputation` — `packages/sails-sdk/src/modules/reputation.ts`

`get(participantId)`, `leaderboard(limit?)`, `rate(input)` (yes, auth required).

## `peers` — `packages/sails-sdk/src/modules/peers.ts`

`start()` (no argument: the server generates its own ephemeral transport identity), `stop()`, `status()`, `joinTopic(topic)`,
`joinTrade(tradeId)`, `broadcastOffer(input)` — the P2P transport layer;
none of the examples in this starter use it directly.

## `capabilities` — `packages/sails-sdk/src/modules/capabilities.ts`

`register(input)`, `list(participantId)`, `revoke(grantId)`,
`registerFromWallet(wallet)` (RFC-013/014 capability grants).

## `@satsails/sdk-react` — `packages/sdk-react/src/index.ts`

- `SailsProvider({client, children})`, `useSailsContext()`, `useSailsClient()`
- `useSailsTrade(tradeId)` — no auth required
- `useSailsTrades({limit?})` — auth required, infinite query
- `useSailsEscrow(escrowId)` — one query + `lock`/`markPaymentSent`/`release`/`refund`/`dispute` mutations, auto-invalidating
- `TradeCard`, `TradeStatusBadge`, `EscrowStatusBadge`, `ReputationBadge`, `ToastProvider`/`useToast`/`Toast`, `Skeleton`

Full setup requirements (the `QueryClientProvider` + `SailsProvider`
pairing) are documented in `packages/sdk-react/README.md`, which this
starter's own `src/app/providers.tsx` follows exactly.

## `WalletAdapter` — `packages/sails-sdk/src/wallet-adapter.ts`

```ts
interface WalletAdapter {
  getPeerId(): Promise<string>
  getAddress(asset: AssetType): Promise<string>
  getBalance(asset: AssetType): Promise<string>
  signTransaction(asset: AssetType, tx: unknown): Promise<unknown>
  broadcastTransaction(asset: AssetType, signedTx: unknown): Promise<string>
  getCapabilities(): Promise<WalletCapabilitiesDeclaration>
}
```

`src/wallet-mock/index.ts` in this starter implements it with fake,
deterministic-per-instance values — a reference for the shape, not a
real wallet.
