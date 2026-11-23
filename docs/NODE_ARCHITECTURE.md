# NODE_ARCHITECTURE.md
### Sails Protocol — Reference Transport & Node Runtime Architecture

> Covers the P2P transport layer (Pears / HyperDHT / Hyperswarm) and the
> broader question of "who runs the infrastructure" for the protocol as a
> whole. This is Infrastructure Layer material — see `ARCHITECTURE.md`
> section 1 for how it relates to Domain/Application/Protocol layers.
> **This document does not cover the cryptography running over this
> transport** (identity keys, payload encryption, replay protection) —
> that's `CRYPTOGRAPHIC_MODEL.md`. `TRUST_BOUNDARY.md` covers what a
> connected peer over this transport can and cannot be trusted to say.

> **Current authority note:** this document describes the Reference
> Implementation's transport/runtime topology, especially Pears/HyperDHT.
> It does **not** own the Day-0 multi-operator/shared-market architecture.
> For that, use `SYSTEM_DESIGN.md`, ADR-001 and Issue #105.
>
> Pears/HyperDHT is one current transport implementation, not a fixed
> protocol dependency. Current transport identity is separate from Sails
> participant/economic identity; see `CRYPTOGRAPHIC_MODEL.md`.

---

## 1. Reference transport/runtime topology

The tables and flows below describe the reference transport/runtime model,
not proof that the Day-0 shared-market multi-operator architecture is already
complete.

Sails' current institutional requirement is stronger than "decentralize
later": Day-0 must support multiple independent operators in the same
economic market universe. Current Pears transport is one building block of
that target; node-local database ownership, cross-node discovery, identity
portability and recovery remain governed separately by ADR-001 / #105 and
the current Day-0 network evidence.

| Node type | Who runs it | Role |
|---|---|---|
| **User Nodes** | Individual participants running the Pears/Sails client | Announce offers to HyperDHT topics, chat via Secretstream. Base of the network. |
| **Wallet Nodes** | Wallet apps that integrated the SDK (e.g. Satsails Wallet) | Act as P2P nodes on behalf of their users |
| **Liquidity Nodes** | OTCs, market makers, payment providers | Standing offers, high volume, high uptime |
| **Reputation Nodes** *(target topology)* | Independent operators (proposed) | Shared reputation validation/consensus is not established by the current node-local reference implementation |
| **Arbiter Nodes** | Trusted Arbitrators, registered per application via `ArbitrationProvider` — never a protocol-native, permissionless role (RFC-007 D4; corrected 2026-07-19, this previously said "bonded community volunteers") | Handle dispute resolution (see `SECURITY_MODEL.md`) |
| **Bootstrap Nodes** *(current dependency and target)* | Holepunch public bootstrap defaults; future operator diversity is proposed | DHT entry/discovery does not by itself establish shared economic-market state or operator-failure survivability |

---

## 2. The `PearNode` / `PearNodeRegistry` Pattern (as implemented today)

This is the concrete implementation detail in
`infrastructure/p2p/pear.service.ts`. Understanding this is required before
touching any P2P-related code.

### The problem this solves

An earlier version of this file had a single class (`PearPeerManager`)
implemented as a **process-wide singleton** — but its `start(userId, ...)`
method took a `userId` parameter, implying multiple users could run
concurrently. In practice, a second call to `start()` silently replaced the
first user's DHT node and keypair. This is a real bug that was found during
code review and fixed.

### The fix — two classes with distinct responsibilities

```typescript
class PearNode extends EventEmitter {
  // One DHT node for ONE user. No static/singleton state.
  // Owns: keyPair, dht, swarm, peers map, topic announcements — all
  // instance fields, none shared across instances.
  constructor(private readonly ownerUserId: string) { ... }
  async start(): Promise<string> { ... }
  async stop(): Promise<void> { ... }
  // ... joinTopic, joinTradeTopic, broadcast, sendToPeer, getStatus ...
}

class PearNodeRegistry {
  // THIS is the singleton — exactly one per server process.
  // Owns a Map<userId, PearNode>, handing out or reusing one PearNode
  // per active user.
  private nodes = new Map<string, PearNode>()

  async start(userId: string): Promise<string> {
    let node = this.nodes.get(userId)
    if (!node) {
      node = new PearNode(userId)
      this.nodes.set(userId, node)
    }
    return node.start()
  }
  // ... stop, stopAll, get, isRunning, getStatus, activeCount ...
}

export const pearNodeRegistry = new PearNodeRegistry()
```

**Rule:** route handlers and any other code must depend on
`pearNodeRegistry`, and must never construct a `PearNode` directly. This enforces one runtime `PearNode` instance per user within a server
process, not independent user custody of transport keys, persistent DHT
identity across restarts, or a shared multi-operator economic market. The
transport keypair is generated by `PearNode.start()` in the server runtime
(see `TRUST_BOUNDARY.md` boundary 1b).

---

## 3. Topic Derivation

Topics are 32-byte SHA-256 hashes of well-known strings — any peer that
knows the topic name can independently derive the same key and find others
announcing on it. No directory server is involved.

```typescript
function deriveTopic(name: string): Buffer {
  return createHash('sha256').update(`sails:v1:${name}`).digest()
}

const TOPICS = {
  marketplace: deriveTopic('marketplace'),        // global — all peers announce here
  btc: deriveTopic('offers:BTC'),                  // per-asset topics
  lnBtc: deriveTopic('offers:LN_BTC'),
  liquidBtc: deriveTopic('offers:LIQUID_BTC'),
  usdtErc20: deriveTopic('offers:USDT_ERC20'),
  usdtLiquid: deriveTopic('offers:USDT_LIQUID'),
  trade: (tradeId: string) => deriveTopic(`trade:${tradeId}`),  // private per-trade channel
}
```

Note the `sails:v1:` prefix — this replaced an earlier `satsails:v1:` prefix
as part of the Sails Protocol / Satsails Wallet naming separation (see
`PROJECT_CONTEXT.md`). If you find `satsails:v1:` anywhere in derived
topics, that's legacy and should be migrated carefully — changing the topic
prefix changes the derived hash, which breaks discovery between old and new
clients unless handled with a migration window.

---

## 4. Connection Handling — What Belongs Here vs What Doesn't

`PearNode` only handles the generic `HANDSHAKE` message type (exchanging
`userId` to map `peerId ↔ userId`). Any other message type (chat content,
offer announcements, payment proof) is forwarded as a generic `message`
event:

```typescript
this.emit('message', { peerId: remotePeerId, message: msg })
```

Domain modules (Sails OpenP2P for chat, Sails OpenLiquidity for offer
announcements) attach their own listeners to this event instead of
`PearNode` knowing the shape of a chat message or an offer. This was a fix
applied during code review — the previous version had `PearPeerManager`
special-case `OFFER_ANNOUNCE` and `CHAT_MESSAGE` message types directly,
with dead, no-op handler bodies that just logged to console. Both were
removed; the generic forwarding pattern above replaced them.

**Rule going forward:** if you need to handle a new message type over P2P,
do not add a new `if (msg.type === 'X')` branch inside `PearNode`. Instead,
subscribe to the generic `message` event from the owning domain module.

---

## 5. Open questions and external owners

This document does not claim there are no remaining cross-cutting node/network
questions.

Current external owners include:
- Day-0 multi-operator/shared-market architecture and evidence → ADR-001 / #105;
- cross-node identity/reputation portability → current identity/network architecture work;
- bootstrap/fallback/operator economics → Day-0 network program;
- production readiness → #220 and bounded owners.

Do not use this document as a substitute for those current owners.

---

## 6. Bootstrap Configuration

```typescript
// config.pear.bootstrapNodes — array of "host:port" strings
// Empty array → uses Holepunch's default public bootstrap nodes
// Non-empty → uses your own bootstrap nodes (needed in restrictive
// network environments, e.g. corporate firewalls blocking default nodes)
```

This is a reference-implementation configuration concern
(`config/index.ts`, which is one of the missing files — see `TODO.md`), not
a protocol-level requirement.
