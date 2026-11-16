# Getting Started

> **Role in the canonical developer journey (Missão 07.4):** this
> document is "from zero to your first real operation." `README.md` is
> "what this is and where to start"; `examples/simple-wallet` is the
> full, continuously-verified golden path (run the code, don't just read
> about it); `SDK_GUIDE.md` is "how to build a real integration";
> `API_REFERENCE.md` is the detailed reference; `API_STABLE.md` is the
> version/freeze contract. If you're not sure which doc to open next:
> README → **this file** → `examples/simple-wallet` → `SDK_GUIDE.md` →
> `API_REFERENCE.md`, in that order.

Commands only — no architectural context here, that's `PROJECT_CONTEXT.md`.
For the full narrated version of everything below, see `TRANSACTION_WALKTHROUGH.md`.

## Prerequisites: choose the path you are actually using

- **Easiest local server path:** use Docker. You do not need Node/npm on
  the host just to start the repository's local Sails server with the
  command below.
- **Monorepo / local development path:** use **Node.js >=20**, matching
  the root repository `engines.node` requirement. Commands such as
  `npm run dev`, workspace builds, tests and the in-repo examples use
  this development environment.
- **External SDK consumer runtime:** the SDK package has its own runtime
  support statement in [`packages/sails-sdk/README.md`](../packages/sails-sdk/README.md).
  Do not infer the monorepo/server Node requirement as the SDK consumer
  requirement, or vice versa.

## 1. Run the server

### Easiest path: Docker

No Node/npm on your host needed:

```bash
docker compose up -d --build   # Postgres + Redis + the server — http://localhost:3000
```

### Monorepo development path

If you are developing inside this repository rather than only running the
Docker quickstart, use Node.js >=20 and the repository's npm workspace:

```bash
npm run dev
```

## 2. Run the full demo flow

```bash
npm run demo:qvac    # QVAC decides -> Pears connects the peers -> Intent Engine -> WDK settles
```

## 3. Use the SDK from your own code

```bash
npm install @satsails/p2p-trading-sdk
```

```ts
import { SailsClient, MockWalletAdapter } from '@satsails/p2p-trading-sdk';

const wallet = new MockWalletAdapter({
  peerId: 'mock-peer',
  addresses: { BTC: 'bc1qmockaddress...' },
  balances: { BTC: '1.5' },
});
const client = new SailsClient({ baseUrl: 'http://localhost:3000', wallet });

const balance = await client.getBalance('BTC');
```

Swap `MockWalletAdapter` for a real one when you're ready —
`examples/wallet-integration/src/bitcoin-wallet-adapter.ts` is a
complete, tested, non-mock reference (`RealBitcoinWalletAdapter`).

## 4. Run the tests

```bash
npm test    # 600+ tests, no external infra needed
```

## The trade flow, conceptually

The full technical walkthrough (`TRANSACTION_WALKTHROUGH.md`) names every
file and function involved. This is the same flow with none of that —
just what happens, in order. The transport/topology and funds-authority
mechanics are deployment- and rail-specific: the configured runtime/network
path determines how peers and services connect, and current reference
deployments may still involve server/runtime infrastructure. Likewise,
custody/signing authority depends on the selected settlement provider — do
not infer one custody model across every rail from this conceptual flow.

```
1. Offer published        Seller lists an asset/price/payment method
                                  │
2. Intent created         Buyer expresses "I want this" — validated,
                           never trusted as-is
                                  │
3. Participants connect   Discovery/transport follows the configured
                           runtime/network path; some paths are direct P2P,
                           others still involve reference runtime/server
                           infrastructure
                                  │
4. Negotiate & agree       Terms confirmed over the configured communication
                           channel
                                  │
5. Escrow locked           Funds authority follows the selected settlement
                           rail/provider; some paths use participant-held
                           signing while others do not
                                  │
6. Payment sent            Off-chain leg (PIX, bank transfer, etc.)
                           happens outside the protocol
                                  │
7. Proof submitted         Evidence the payment happened, hashed and
                           recorded — not trusted blindly, verifiable
                                  │
8. Escrow released         Funds move according to the settlement provider's
                           authority model. If something's wrong, step 8
                           becomes a dispute instead — see RFC-021 for that path
```

## Which endpoint for which action

The full reference, with every field and edge case, is
`API_REFERENCE.md`. This is the lookup table for "I want to do X":

| I want to... | Call |
|---|---|
| Register a new identity | `POST /v1/identity/participants` |
| Log in | `POST /v1/identity/challenge` then `POST /v1/identity/authenticate` |
| Publish an offer | `POST /v1/liquidity/offers` |
| See available offers | `GET /v1/liquidity/offers` |
| See my own offers | `GET /v1/liquidity/offers/mine` |
| Express intent to trade | `POST /v1/intents` |
| Start a trade from an offer | `POST /v1/openp2p/trades` |
| Chat with my counterparty | `GET /v1/openp2p/chat/:tradeId/messages` |
| Create escrow for a trade | `POST /v1/settlement/escrow` |
| Lock funds in escrow | `POST /v1/settlement/escrow/:id/lock` |
| Mark payment as sent | `POST /v1/settlement/escrow/:id/payment-sent` |
| Submit proof of payment | `POST /v1/proof/proofs` |
| Release escrow to the buyer | `POST /v1/settlement/escrow/:id/release` |
| Open a dispute | `POST /v1/settlement/escrow/:id/dispute` |
| Check my reputation | `GET /v1/reputation/:participantId` |
| Rate a completed trade | `POST /v1/reputation/rate` |
| Start P2P networking | `POST /v1/peers/start` |

## What QVAC actually does (Missão 07.3 model — see that mission's report for the full audit)

QVAC is a real local LLM (llama.cpp, no cloud dependency). It does
exactly three things, each a single call, none of them stateful or
conversational:

| QVAC does | Real? | Call |
|---|---|---|
| Draft a structured Intent from a plain-language goal | ✅ real | `sdk.agents.generateTradeIntent(goal)` |
| Draft a structured Offer from a plain-language goal | ✅ real | `sdk.agents.generateOfferIntent(goal)` |
| Assess risk on a trade intent's shape | ✅ real | `sdk.agents.assessIntentRisk(intent)` |

What happens after Intent generation — finding a real matching `Offer`
within the price/reputation limits you declared, or computing a bounded
counter-price — is **not** a QVAC call. It's deterministic matching
(`sdk.proposeTrade`/`sdk.proposeTradeOutcome`), no LLM involved. And
**interactive, back-and-forth negotiation with a counterparty doesn't
exist** — `sdk.negotiate()` throws on purpose; use
`sdk.openp2p.chat(tradeId)` for real human-to-human chat instead.

```
AI-generated Intent (QVAC)  →  Bounded discovery/proposal (deterministic)  →  You approve  →  Interactive negotiation: FUTURE, not built
```

## Capability — what it is, and whether you need it

**What it is:** an optional, opt-in authorization layer (RFC-013). A
`CapabilityGrant` says "participant X may perform actions under
capability Y, for real events matching scope Z." `sdk.capabilities`
lets you register/list/revoke your own grants.

**What it is NOT:** it is not required to use the SDK. It is not
identity, not a KYC step, and it does not gate reading public data
(discover, get a trade you're party to, etc).

**When it's enforced:** when the server sets `ENFORCE_CAPABILITIES=true`
- **mandatory in production** (a production process refuses to boot
without it, Issue #303) and off by default in development, test and this
repo's `docker-compose.yml` quickstart. With it off, every capability
check short-circuits and `sdk.capabilities` calls just write/read rows.
With it on, call `sdk.capabilities.ensureCanonicalGrants(participantId)`
once after authenticating (idempotent; the reference UI does it on every
login) - buyers, sellers and arbiters all need it. Grants are
self-issued: your own consent, not independent third-party permission.
The old `registerFromWallet()` helper is deprecated. See
`src/config/index.ts`'s own doc comment on this flag for the production
boot-guard around it.

**Real capability names in this codebase today** (`CAPABILITY_IMPLEMENTATIONS`,
`src/core/capability-registry.ts` — not invented for this doc):

| Capability name | Module | Status |
|---|---|---|
| `trade-coordination` | OpenP2P | in use |
| `settlement` | OpenSettlement | in use |
| `liquidity-discovery` | OpenLiquidity | defined, not yet checked anywhere |
| `identity-verification` | OpenIdentity | defined, not yet checked anywhere |
| `reputation-scoring` | OpenReputation | defined, not yet checked anywhere |
| `agent-delegation` | OpenAgents | defined, not yet checked anywhere |
| `financial-instruments` | OpenFinance | future — module doesn't exist yet |
| `proof-verification` | OpenProof | future (RFC-006) |

**Real scope strings actually checked today** (the `requiredScope`
argument to `capabilities.register()`'s `scope` array — these are real
event names, not a separate vocabulary): `intent.created`,
`intent.discovering`, `settlement.escrow.released`,
`settlement.escrow.refunded`, `settlement.escrow.split`.

**How to register a grant:**
```typescript
await sails.capabilities.register({
  grantedTo: myParticipantId,
  capabilityName: 'settlement',
  scope: ['settlement.escrow.released'],
})
```
**How to revoke one:** `await sails.capabilities.revoke(grantId)`.

This is documentation only — no automatic onboarding UI/flow exists for
Capability, and building one is explicitly out of scope for this pass.

## Settlement providers — what's actually usable today

Every provider below is real code (none are UI mockups), but "real
code" and "you can settle real value with it right now" are different
claims. `MOCK` is the only one meant for everyday development.

| Provider | Real | Infra needed | Direct `release()`? | Client-held keys? | Status |
|---|---|---|---|---|---|
| `MOCK` | ✅ | none | ✅ | no | **Development/test only — not real money, ever.** |
| `WDK_USDT_EVM` | ✅ | `WDK_SEED_PHRASE` + Sepolia RPC | ✅ | no — single seed, operator-custodial | Testnet only. One seed controls the treasury *and* every escrow sub-account — not a production custody model as-is. |
| `MULTISIG` | ✅ | real testnet BTC, sent manually by the trade parties | ❌ — use `initiateRelease()` + `submitTransactionSignature()` | ✅ (2-of-3 Bitcoin PSBT) | Testnet only. |
| `LIGHTNING_HODL` | ✅ | pinned to Ark Labs' public `mutinynet.arkade.sh`, real testnet funding | ❌ — same signature-collection flow as MULTISIG | ✅ | Testnet/mutinynet only, single-arbiter limitation. |
| `SAFE_GUARD_EVM` | ✅ (client-side signing) / ❌ (server side) | a live EVM RPC + ERC-4337 bundler — **not available in this environment** | ❌ — same signature-collection flow | ✅ (KMS-backed arbiter co-signer) | **Not deployable today** — the one provider that's real code but genuinely can't run end-to-end here. |
| `LIQUID_COVENANT` | ❌ | — | — | — | Never built. `type: 'LIQUID_COVENANT'` is rejected at escrow-creation time, not silently accepted. |

**Local dev note:** `docker-compose.yml`'s default (`MOCK_ESCROW=true`,
i.e. `config.features.mockEscrow`) routes **every** escrow type to the
`MOCK` provider regardless of what `type` you pass — so
`examples/simple-wallet` calling `release()` directly "works" locally
even though its own code never sets `type`, because the *type stored* on
the Escrow row and the *provider actually used* are different things
when this flag is on. Don't take a working local run as proof a
non-MOCK type is production-ready — check this table.

## Common integration errors

| Status | Means | Fix |
|---|---|---|
| `401` | No session, or an invalid/expired one | Call `identity.authenticate()` first (or `client.setSessionToken()` if restoring a saved session) |
| `403` | Authenticated, but not authorized for this specific resource | You're not a party to this trade/escrow, or (rarely, only if the server has `ENFORCE_CAPABILITIES=true`) you're missing a capability grant — see the Capability section above |
| `409` | The action conflicts with current state | Common causes: calling an escrow action from the wrong lifecycle status (e.g. `release()` before `markPaymentSent()`), or calling a `peers` route with no active node (`peers.start()` first) |
| `400` | Malformed input | Check the field the error message names — every route validates with zod; the message says which field and why |
| `5xx` | Server/infrastructure problem, not your request | Retry with backoff (the SDK already does this for GET); if persistent, the node itself likely has a real problem (DB/Redis down, etc) — not something a client-side fix resolves |

Only these five appear in this backend — if you see something else, it's
worth reporting as a real gap, not assuming it's documented elsewhere.

**Note:** `MULTISIG`/`LIGHTNING_HODL`/`SAFE_GUARD_EVM` escrow types don't
use `release` directly — client-held keys mean `initiate-release` +
`submit-transaction-signature` instead. `API_REFERENCE.md`'s Settlement
section covers the full per-type distinction.
