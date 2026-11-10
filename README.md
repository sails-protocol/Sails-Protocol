# Sails Protocol

[![npm version](https://img.shields.io/npm/v/@satsails/p2p-trading-sdk.svg)](https://www.npmjs.com/package/@satsails/p2p-trading-sdk)
[![CI](https://github.com/alan-schramm/Sails-Protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/alan-schramm/Sails-Protocol/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Architecture Diagrams](https://img.shields.io/badge/architecture-diagrams-informational.svg)](https://alan-schramm.github.io/Sails-Protocol/)

**Sails Protocol is an Economic Coordination Protocol.**

**V1 focus: Sails Protocol is open infrastructure for building interoperable P2P Financial Marketplaces.**

Its first concrete developer product is the **Sails P2P Trading SDK**, which exposes the first protocol module to integrators and is designed to enable interoperable P2P financial marketplaces across different wallets and execution stacks.

The adoption rule is simple: **keep your wallet stack; plug into Sails.** Sails coordinates shared economic semantics without requiring an integrating wallet or application to surrender ownership of its keys, signing stack, transport, settlement stack, or user experience.

> **Repository identity:** this repository is the canonical public monorepo and reference implementation workspace for Sails Protocol. It includes the protocol implementation, Sails P2P Trading SDK, shared schemas, developer packages, examples, and reference application components. Being the canonical public monorepo does **not** make every file in it normative protocol truth.

## What exists today — and how it fits together

Sails is actively developed. The repository contains real implementation, SDKs, reference surfaces, architecture, governance and evidence, but **existence is not the same claim as production eligibility**.

```text
Applications / Integrators
(Sails Market, Satsails Wallet, third-party wallets and apps)
                         │
                         ▼
              Sails P2P Trading SDK
                         │
                         ▼
                  Sails Protocol
         shared economic coordination semantics
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
   Pure Core          Runtime           Modules
                                         │
          OpenP2P · OpenSettlement · OpenIdentity
          OpenReputation · OpenProof · OpenLiquidity
          OpenAgents · OpenFinance (roadmap where applicable)
                                         │
                                         ▼
                              Providers / Adapters
                                         │
                                         ▼
                     wallet, transport and settlement stacks
```

The concrete repository surfaces behind that map are:

- **Sails Protocol implementation** — protocol/runtime implementation and modules.
- **Sails P2P Trading SDK** — `@satsails/p2p-trading-sdk`, the first concrete developer product.
- **Sails Core** — `@sails/core`, the internal Pure Semantic Core package; Runtime, Modules, Providers and Adapters remain outside the Pure Core boundary.
- **Shared schemas** — protocol-facing domain contracts in `@satsails/p2p-schemas`.
- **Developer/reference packages** — React/UI surfaces and integration examples.
- **Reference applications/integrations** — including Sails Market and Satsails-oriented validation work.
- **Institutional documentation** — protocol, architecture, governance, RFC, evidence and explanatory records under `docs/`.

**No interface or reference implementation owns protocol semantics.** Sails Market and Satsails exercise and expose protocol behavior; they do not redefine it.

This diagram is orientation, not specification. [System Design](docs/SYSTEM_DESIGN.md) is the consolidated current system-level technical map. [Documentation Index](docs/00-INDEX.md) routes to the deeper normative owners.

For current engineering reality, use [Backlog](docs/BACKLOG.md), live GitHub Issues/Project, the relevant RFCs, provider documentation and evidence records. [TODO](docs/TODO.md) is retained as a historical/category-oriented gap inventory, not the primary execution queue.

## Start here

If you want to run something first:

```bash
docker compose up -d --build
```

That starts the local server with Postgres and Redis using the repository's safe-by-default local configuration.

Then follow the canonical developer journey:

1. [Getting Started](docs/GETTING_STARTED.md) — zero to first real operation.
2. [`examples/simple-wallet`](examples/simple-wallet) — the continuously verified golden path using the SDK public API.
3. [SDK Guide](docs/SDK_GUIDE.md) — build a real integration.
4. [API Reference](docs/API_REFERENCE.md) — detailed routes and contracts.
5. [API Stable](docs/API_STABLE.md) — the frozen developer contract/version boundary.

## Developer SDKs

Sails developer products are listed here so integrators can go directly from the repository homepage to the package, installation command, and integration documentation. As additional Sails SDKs are released, they should be added to this table rather than creating separate discovery paths.

| SDK | Package | Install | Start here | Status |
|---|---|---|---|---|
| **Sails P2P Trading SDK** | [`@satsails/p2p-trading-sdk` on npm](https://www.npmjs.com/package/@satsails/p2p-trading-sdk) | `npm install @satsails/p2p-trading-sdk` | [Getting Started](docs/GETTING_STARTED.md) · [SDK Guide](docs/SDK_GUIDE.md) · [`examples/simple-wallet`](examples/simple-wallet) | First concrete developer product |

Minimal local example:

```ts
import { SailsClient, MockWalletAdapter } from '@satsails/p2p-trading-sdk';

const wallet = new MockWalletAdapter({
  peerId: 'mock-peer',
  addresses: { BTC: 'bc1qmockaddress...' },
  balances: { BTC: '1.5' },
});

const client = new SailsClient({
  baseUrl: 'http://localhost:3000',
  wallet,
});

const balance = await client.getBalance('BTC');
console.log(balance);
```

`MockWalletAdapter` is for local development. For a real wallet integration reference, see [`examples/wallet-integration`](examples/wallet-integration).

## Documentation paths

Use the shortest path for the question you are trying to answer.

| Goal | Canonical starting point |
|---|---|
| **1. Understand what Sails is** | [Project Context](docs/PROJECT_CONTEXT.md) |
| **2. Run it locally** | [Getting Started](docs/GETTING_STARTED.md) |
| **3. Integrate the SDK** | [SDK Guide](docs/SDK_GUIDE.md) · [API Reference](docs/API_REFERENCE.md) · [API Stable](docs/API_STABLE.md) |
| **4. Understand the system and protocol** | [System Design](docs/SYSTEM_DESIGN.md) · [Protocol Specification](docs/PROTOCOL_SPECIFICATION.md) · [Protocol Invariants](docs/PROTOCOL_INVARIANTS.md) · [Semantic Kernel](docs/SEMANTIC_KERNEL.md) |
| **5. Understand architecture and decisions** | [Core Architecture](docs/CORE_ARCHITECTURE.md) · [Core Implementation Architecture](docs/CORE_IMPLEMENTATION_ARCHITECTURE.md) · [RFC Index](docs/rfcs/00-INDEX.md) |
| **6. Inspect current state and unresolved work** | [Backlog](docs/BACKLOG.md) · live GitHub Issues/Project |
| **7. Understand governance or contribute** | [Engineering Governance](docs/ENGINEERING_GOVERNANCE.md) · [Contributing](CONTRIBUTING.md) |
| Browse the complete documentation map | [Documentation Index](docs/00-INDEX.md) |
| Report a vulnerability | [Security Policy](SECURITY.md) |
| Read the public explanatory papers | [Whitepaper Set](docs/whitepapers/README.md) |

For a complete trade flow, see [Transaction Walkthrough](docs/TRANSACTION_WALKTHROUGH.md). For broad/reference and historical topology, see [Architecture](docs/ARCHITECTURE.md).

## Where institutional truth lives

Sails does **not** use one universal linear authority chain. Different documents govern different questions.

```text
Institutional Truth
│
├── Semantic identity
│   └── docs/SEMANTIC_KERNEL.md
│
├── Protocol invariants
│   └── docs/PROTOCOL_INVARIANTS.md
│
├── Normative protocol contract
│   └── docs/PROTOCOL_SPECIFICATION.md
│
├── System-level technical map
│   └── docs/SYSTEM_DESIGN.md
│
├── Architecture
│   ├── docs/ARCHITECTURE.md (broad/reference + historical topology)
│   ├── docs/CORE_ARCHITECTURE.md
│   └── docs/CORE_IMPLEMENTATION_ARCHITECTURE.md
│
├── Decisions
│   ├── ADRs
│   └── accepted RFCs
│
├── Developer contract
│   └── docs/API_STABLE.md
│
└── Institutional discoveries / evidence
    └── discovery, validation, proof and audit records
```

Use each source for the responsibility it owns:

- **`SYSTEM_DESIGN.md`** — consolidated current system-level technical map and routing surface; it summarizes rather than replacing deeper normative owners.
- **`ARCHITECTURE.md`** — broad/reference system architecture and historical implementation topology.
- **`CORE_ARCHITECTURE.md`** — authority for the modern **Pure Core + Runtime + Modules + Providers** architecture derived from Sails' semantic identity.
- **`CORE_IMPLEMENTATION_ARCHITECTURE.md`** — implementation derivation of those Core properties and boundaries.
- **Accepted RFCs / ADRs** — decisions within their explicit scope; they do not become a universal replacement for every other authority class.
- **`API_STABLE.md`** — the frozen developer-facing SDK/API contract.
- **Discovery and evidence documents** — institutional findings and proof; they record reality without automatically redefining protocol semantics.

The [Documentation Index](docs/00-INDEX.md) provides the full repository reading map. Some strategic evaluation documents are intentionally not public; [Governance](docs/GOVERNANCE.md) defines the publication discipline for those references.

## Current reality and maturity

This repository deliberately distinguishes architecture, implementation, evidence, and production readiness.

A few examples of that claim discipline:

- the Bitcoin `MULTISIG` settlement path has a disclosed small-value mainnet rehearsal; see [MAINNET_MULTISIG_PROOF.md](docs/MAINNET_MULTISIG_PROOF.md);
- `WDK_USDT_EVM` has real-path testnet evidence but its reference custody model is not the normative custody model for every Sails integration;
- Arkade/VTXO settlement has testnet evidence;
- plain Lightning, as its own distinct settlement capability, must not be inferred from Arkade interoperability or naming;
- Liquid settlement remains designed rather than implemented where the provider explicitly says so.

For the full current target/maturity distinctions, use the relevant provider files, RFCs, [Backlog](docs/BACKLOG.md), live GitHub Issues/Project, and current validation records. The README intentionally does not duplicate the complete rail/asset/adapter maturity matrix.

## Repository map

```text
packages/
├── sails-core/          modern Sails Core implementation
├── sails-p2p-schemas/   shared protocol/domain schemas
├── sails-sdk/           @satsails/p2p-trading-sdk
├── sails-ui/            reference UI package
└── sdk-react/           React-facing developer package

examples/
├── simple-wallet/              canonical SDK golden path
├── wallet-integration/         real wallet adapter reference
├── sails-integration-starter/  application integration starter
└── demo/                       integration/demo flows

docs/
├── 00-INDEX.md                 documentation router
├── rfcs/                       protocol decisions
├── architecture/               canonical visual representations
├── whitepapers/                public explanatory papers
└── ...                         specification, architecture, governance,
                                discovery, evidence, roadmap and state docs
```

## Public papers

The public explanatory set contains three primary papers:

1. [Sails Protocol Whitepaper](docs/whitepapers/SAILS_PROTOCOL_WHITEPAPER.md) — problem, thesis, shared economic meaning, ecosystem, economics, and current reality.
2. [Sails Technical Paper](docs/whitepapers/SAILS_TECHNICAL_PAPER.md) — Semantic Kernel, Core, Runtime, Modules, Providers, authority, evidence, recovery, security, and engineering governance.
3. [Sails P2P Trading SDK Paper](docs/whitepapers/SAILS_P2P_TRADING_SDK_PAPER.md) — developer product, integration boundary, capabilities, economics, and Day-0 integration reality.

These papers explain Institutional Truth; they do not replace normative specification, invariants, architecture, RFCs, or the stable developer contract. See the [Whitepaper Set README](docs/whitepapers/README.md) for the editorial model and legacy paper redirects.

## Project state and planning surfaces

Several repository surfaces intentionally coexist because they own different responsibilities:

- **`ROADMAP.md`** — high-level direction and sequencing.
- **GitHub Project** — live operational state.
- **GitHub Issues** — executable units, decisions, and durable validation gates/registries where appropriate.
- **`BACKLOG.md`** — institutional unresolved inventory plus dependency/context ledger.
- **`TODO.md`** — historical/category-oriented implementation-gap inventory retained for provenance; limited operational authority.

These are intentionally **not consolidated** here. Do not treat any one of them as a universal substitute for the others.

## Integration strategy

Sails is designed so wallets and applications can integrate without replacing their existing key-management, signing, transport, or settlement stack merely to participate in the same coordination layer.

Wallet adapters, settlement providers, networks, assets, capabilities, and maturity are different axes. Support for one axis never implies support for another. First-party integration targets such as WDK, Bitcoin, EVM-family networks, Spark, Lightning-related stacks, Liquid, and others are tracked with evidence-specific maturity rather than by presence in a marketing matrix.

For the detailed Day-0 target and unresolved architecture questions, follow [Backlog](docs/BACKLOG.md), the relevant RFCs, and provider-specific documentation.

## Before changing architecture

Protocol-sensitive changes are not ordinary refactors. If implementation evidence contradicts a frozen invariant, Semantic Kernel property, Core Architecture property, or accepted protocol contract, stop and surface the conflict rather than silently redefining the system in code or documentation.

Start with:

- [Contributing](CONTRIBUTING.md)
- [Engineering Governance](docs/ENGINEERING_GOVERNANCE.md)
- [Governance / RFC process](docs/GOVERNANCE.md)
- [RFC Index](docs/rfcs/00-INDEX.md)

## Security

Security disclosures must not be filed as public Issues. See [SECURITY.md](SECURITY.md) for the reporting process, scope, and current security-policy surface.

## Contributing

Contributions are welcome under the repository's consequence-weighted engineering process. A documentation fix and a protocol/economic-authority change do not require the same ceremony; [CONTRIBUTING.md](CONTRIBUTING.md) and [ENGINEERING_GOVERNANCE.md](docs/ENGINEERING_GOVERNANCE.md) define the applicable process.

## Author & maintainer

Sails Protocol is created and led by **Alan Schramm** and developed by **Sails Labs**, part of **Satsails Holding**.

## License

Apache 2.0 — see [LICENSE](LICENSE).
