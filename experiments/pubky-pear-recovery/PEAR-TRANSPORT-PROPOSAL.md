# Minimal proposal: OpenP2P through `TransportProvider`, not `PearNode` (Mission 04, step 5)

Status: **PROPOSAL, read-only inspection of `origin/main` at `456d3e52`. No production code changed.** Any implementation needs a CTO-approved mission
(it touches `src/`). Pear is not removed, Pubky Noise is not implemented, and no multi-transport architecture is proposed.

## What is coupled today (file:line, verified by reading)

| Place | Direct dependency on Pear | What it does there |
|---|---|---|
| `src/modules/open-p2p/negotiation.service.ts:14,46,76,157,170` | `pearNodeRegistry`, `PearNode` | `HumanChatChannel.sendEvent` calls `node.sendToPeer(remoteUserId, ...)` (synchronous boolean); `onEvent` registers `node.on('message')` and checks `node.getConnectedPeerId(remote) === peerId` (handshake-verified mapping); `wireInboundNegotiationChannel` dedupes with `pearNodeRegistry.get(counterpartyId)` |
| `src/modules/open-p2p/chat.routes.ts:50,216` | `pearNodeRegistry` | WS -> Pear relay of a chat message: `senderNode.sendToPeer(...)` |
| `src/modules/open-p2p/trade.routes.ts:30,198` | `pearNodeRegistry` | join a trade topic after the domain authorization: `node.joinTradeTopic(tradeId)` |
| `src/infrastructure/p2p/pear.routes.ts:22,59-108` | `pearNodeRegistry` + `fallbackTransportProvider` | start goes through the provider; stop/status/connect/peers go straight to the registry |
| `src/infrastructure/p2p/transport-provider.ts:35-157` | wraps `pearNodeRegistry` | `PearsTransportProvider` (all 7 interface methods) plus Pears-only `sendIntentToPeer`; `FallbackTransportProvider(pears -> websocket relay)` |
| `src/infrastructure/p2p/payload-crypto.ts` | HyperDHT identity key | sealed box keyed to the Pear peer key; used only by `sendIntentToPeer` (Pear-specific by construction, as the file says) |

So the abstraction exists and is sound (`TransportProvider`, RFC-002; `NegotiationChannel`, RFC-004), but three business modules bypass it and talk to the concrete
`PearNode`. Tests that touch these seams: `negotiationInboundChannel`, `joinTradeAuthorization`, `pearRoutes`, `intentTransport`, `transportFallback`, `handshakeSpoofing`, `routes`.

## The gaps in the interface that force the bypass

1. **Verified peer identity**: `HumanChatChannel` needs "the peer id that completed a handshake for participant X". It is not in `TransportProvider`.
2. **Trade-scoped topics**: the interface has `joinTopic(participantId, topic)`; the domain needs `joinTradeTopic(tradeId)` (the topic is derived server-side on purpose).
3. **Inbound messages with the verified sender**: `onMessage(participantId, handler(peerId, payload))` exists but registers listeners with no removal, and callers re-implement the identity check.
4. **Connected check**: `isConnected(participantId)` is "my node is running", not "the counterparty is reachable"; `wireInboundNegotiationChannel` uses the registry for the latter.

## Minimal change (4 additive steps, no rename of a published method)

1. Add two OPTIONAL methods to `TransportProvider` (additive, backward compatible): `verifiedPeerId(participantId, remoteParticipantId): string | undefined` and `joinTradeTopic(participantId, tradeId): Promise<void>`. `PearsTransportProvider` implements them with `getConnectedPeerId` / `joinTradeTopic`; the WebSocket relay returns `undefined` / a no-op.
2. One accessor, `activeTransport()` in `transport-provider.ts`, returning the existing `fallbackTransportProvider`. It is the only place that names a concrete provider.
3. `HumanChatChannel` takes a `TransportProvider` in its constructor (default `activeTransport()`) and replaces `pearNodeRegistry.get(...)`, `node.sendToPeer`, `node.on('message')`, `node.getConnectedPeerId`. `chat.routes.ts` and `trade.routes.ts` call the same provider. The counterpart dedupe becomes `transport.isConnected(counterpartyId)`.
4. `PearNode`/`pearNodeRegistry` stay private to `infrastructure/p2p` (imported only by `PearsTransportProvider` and `pear.routes.ts`).

Explicitly NOT part of it: a plugin loader or registry of transports, Pubky Noise, offline mailbox, removing the WebSocket relay, changing the wire format or `payload-crypto.ts`, changing how identities are bound (that is the portable-identity work).

## How the Pubky authorization plugs in later (not now)

Today `User.peerId` is a directory row written by `PearNode.start()`. With model B the Pear key is fresh per device/session and is authorized by a Pubky grant statement
(`SECURITY-CLOSURE.md`). The seam is `start(participantId) -> { peerId }`: after `start`, the application layer would publish/refresh the authorization record for that `peerId`;
peers would call `verifiedPeerId` AND check the record. That needs no change to the transport itself and should be designed after the binding contract is approved.

## Acceptance criteria (verifiable)

1. `grep -rn "pearNodeRegistry\|PearNode" src/modules` returns nothing; only `src/infrastructure/p2p` names Pear types.
2. The existing seven test files above pass unchanged except for the constructor argument of `HumanChatChannel`, plus one new test running `HumanChatChannel` against an in-memory fake `TransportProvider` (the property the abstraction is for).
3. `handshakeSpoofing` still passes: a message from a peer that did not complete the verified handshake for the claimed participant is dropped.
4. Behaviour with the WebSocket relay provider (which has no handshake-verified peer id) must be decided and tested explicitly before step 3 lands: either the channel keeps today's Pear-only inbound path and the relay path is a documented no-op, or the relay supplies its own verified mapping. Not verified in this read-only pass.
5. No public SDK type, Prisma model or route changes.

Owners: RFC-002 (transport provider) and RFC-004 (negotiation channel) owners; implementation mission: CTO approval first.
