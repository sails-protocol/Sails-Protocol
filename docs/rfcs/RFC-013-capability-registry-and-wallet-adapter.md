# RFC-013: Capability Registry Implementation, WalletAdapter Pattern, and Portable Identity via peerId

## Summary

Implements `core/capability-registry.ts` for real (RFC-005's
`CapabilityGrant` shape, previously a stub since Architecture Freeze),
adds a `WalletAdapter` interface to `@satsails/p2p-trading-sdk` so a wallet's own
signing/balance/address logic can plug into the SDK instead of being
absent from it, extends the frozen `TradeIntentPayload` with a new
optional constraint field (`minReputationRating`), and adds a
`peerId`-keyed reputation lookup so a participant's score is
addressable by their portable Pears identity, not only their internal
`participantId`.

> **Corrected 2026-08-09** — this RFC originally also added a second
> optional constraint field, `kycRequired`. Removed: project-owner
> decision that this protocol does not do KYC (the same principle
> `vouch.service.ts`/`payment-account.service.ts` already state
> explicitly for RFC-021 D7) — a field literally named `kycRequired`
> existing in the canonical, frozen Intent type undercut that
> positioning even though, per this RFC's own text below, it was never
> enforced against a real counterparty. Every mention of `kycRequired`
> below is a historical record of what this RFC originally shipped, not
> current guidance — `minReputationRating` is unaffected and remains real.

**Status:** Accepted. Triggered by a consolidated technical proposal
("Sails Trading Protocol SDK — Documento Técnico Consolidado v1") the
project owner brought in from an external source, aimed at making the
SDK layer richer ahead of external technical review. Before implementing
it as written, its claims about what Pears and QVAC actually provide
were checked against their official documentation
(docs.pears.com, docs.qvac.tether.io) and against the real integrations
already built in this codebase (`pear.service.ts`, `qvac-agent.provider.ts`)
— two significant misattributions were found and corrected; see
Motivation.

## Motivation

The proposal is a good-faith architecture document with real, buildable
ideas, but it attributes two of Sails Protocol's own Core responsibilities
to the underlying technologies instead:

1. **"Pears (Identity + Reputation Layer)"** — checked against
   docs.pears.com and this codebase's own `pear.service.ts` (real
   `hyperdht`/`hyperswarm` usage, verified throughout this project):
   Pears is a P2P networking stack (DHT-based peer discovery, connection
   swarms). It has no reputation service, no trade-history API, no score.
   What it genuinely provides is a portable Ed25519 public key (the
   `peerId` this codebase already persists on `User.peerId`, set the
   first time a participant's `PearNode` starts) — a stable identity
   substrate that *can* carry reputation across applications built on
   it, but the reputation computation and storage itself is, and has
   been throughout this project, Sails OpenReputation's job
   (`reputation.service.ts`, real, tested, `RFC-007` D8/D9's
   Outcome Engine). The proposal's "ReputationModule (Pears)" conflated
   the identity substrate with the module that uses it.
2. **"QVAC (Verification & Capability Control)"** — checked against
   docs.qvac.tether.io and `qvac-agent.provider.ts` (real local LLM
   inference, live-verified earlier this project): QVAC is Tether's
   on-device AI inference SDK. It has no capability-verification, policy,
   or permission-control product surface. What the proposal describes —
   "verificação de capacidades declaradas," "políticas de segurança,"
   "controle de permissões" — is a precise description of
   `PROTOCOL_SPECIFICATION.md` §1.10's own Capability Registry and
   Policy Engine (`RFC-005-capability-model.md`), both Sails Protocol
   Core components that have been stubbed since Architecture Freeze,
   not a QVAC feature.

Both corrections point at the same real, actionable gap: the Capability
Registry RFC-005 already specified in full has never been implemented.
This RFC treats "build it for real, correctly attributed" as the
actionable core of the proposal, rather than either rejecting the
document outright or implementing its misattributions literally (which
would read as a credibility problem, not a feature, to anyone who knows
the actual Pears/QVAC/WDK products — precisely the audience the project
owner wants this repository to be evaluated by).

The proposal's other two genuinely new, non-conflicting ideas —
a `WalletAdapter` interface so `@satsails/p2p-trading-sdk` can call into a wallet's own
signing logic, and two new optional Intent constraint fields
(`minReputationRating`, `kycRequired`) — are real, bounded gaps this RFC
also closes.

## Alternatives Considered

1. **Implement the proposal literally, including the Pears/QVAC
   attributions.** Rejected — see Motivation. Shipping documentation
   that misdescribes two named third-party products this project
   integrates with is a real risk to the exact credibility goal the
   project owner stated, not a stylistic nitpick.
2. **New `p2p_trade` Intent type, separate from `TradeIntent`.**
   Rejected. `TradeIntentPayload` (frozen, `common/types/intent.ts`)
   already covers `asset`/`side`/`maxValue`/`minValue`/`currency`/
   `fiatMethod`/`network` — every field the proposal's `p2p_trade` intent
   needs except two (`min_reputation_rating`, `kyc_required`), which are
   additive optional fields, not a reason to fork the type taxonomy.
   `RFC-012`'s own precedent (extend, don't duplicate) applies directly.
3. **New `/sdk/register-capabilities` and `/sdk/submit-intent` HTTP
   namespace, as literally proposed.** Rejected. `API_REFERENCE.md`
   section 1's namespacing convention (`/v1/{module}/...`) is already
   mandatory going forward; a parallel `/sdk/*` surface would fragment
   the API into two competing conventions for no functional gain — the
   real Intent route (`POST /api/v1/intents`) already does what
   `/sdk/submit-intent` proposed. A new `/v1/capabilities/` namespace is
   added instead, consistent with every other module's routing.
4. **Skip a real Prisma-backed store for `Capability`/
   `CapabilityImplementation` (the module↔category mapping RFC-005's own
   table lists), not just `CapabilityGrant`.** Accepted as a deliberate
   scope cut, not an oversight: RFC-005 itself calls that table
   "illustrative... a Reference Implementation detail," and it is static
   reference data (which `moduleId` implements which `capabilityName`),
   not something created/mutated over HTTP in this pass. Modeled as a
   static in-code map (`CAPABILITY_IMPLEMENTATIONS` in
   `capability-registry.ts`) instead of a table with zero real write
   path. `CapabilityGrant` — the part with an actual issue/check/revoke
   lifecycle — is the part that gets a real table.
5. **Build a full policy-evaluation engine (`PolicyEngine`'s
   `get`/`propose`/`activate`) in the same pass, since the proposal also
   describes "políticas de segurança."** Rejected — out of scope for this
   RFC. `policy-engine.ts`'s governed-policy interface remains a stub, as
   it was before RFC-012 made the same scope cut for the same reason:
   this pass closes the Capability Registry gap specifically because it
   maps directly onto a concrete, already-specified proposal ask
   (capability declaration + checking); the Policy Engine's governed-rule
   storage is a separate, larger piece of work with no immediate caller.

## Decision

**1. `CapabilityGrant` becomes a real, persisted Prisma model** (new
`prisma/schema.prisma` model, migration required):

```prisma
model CapabilityGrant {
  id             String    @id @default(uuid())
  grantedTo      String    // a Participant or Agent id (RFC-001)
  capabilityName String    // e.g. 'trade-coordination' (RFC-005's table)
  scope          String[]  // subset of that capability's events/API
  constraints    Json?     // e.g. { maxValue, expiresAt }
  issuedBy       String
  revokedAt      DateTime?
  createdAt      DateTime  @default(now())

  @@index([grantedTo])
  @@index([capabilityName])
  @@map("capability_grants")
}
```

**2. `core/capability-registry.ts` implements the real logic**, correcting
a signature drift from before RFC-005 disambiguated `Capability` from
`CapabilityGrant` (the stub's `grant(capability: Capability)` predates
that RFC and was never updated to take the grant shape it actually
needs):

```typescript
export interface CapabilityRegistry {
  grant(input: Omit<CapabilityGrant, 'grantId'>): Promise<CapabilityGrant>
  check(grantedTo: string, capabilityName: string, requiredScope: string): Promise<boolean>
  revoke(grantId: string): Promise<void>
  listGrants(grantedTo: string): Promise<CapabilityGrant[]>
}
```

`check()` returns `true` only for a grant that is not revoked, not
expired (`constraints.expiresAt`, if present), matches `capabilityName`,
and whose `scope` includes `requiredScope`. `CAPABILITY_IMPLEMENTATIONS`
(the static moduleId↔capabilityName map from RFC-005's own table) lives
in the same file, exported for `intent-engine.ts`/`coordination-engine.ts`
to reference without a database round-trip.

**3. `common/types/intent.ts`'s `TradeIntentPayload` gains two optional
fields** (additive, no `protocolVersion` bump needed per the same
reasoning `RFC-012` used for its own additive change):

```typescript
export interface TradeIntentPayload extends IntentPayload {
  // ...existing fields unchanged...
  minReputationRating?: number  // 0-5, mirrors ReputationScore's scale
  kycRequired?: boolean
}
```

Structural validation (`intent-engine.ts`'s `validateStructure()`) is
extended to reject a `minReputationRating` outside `[0, 5]` — the same
CISO Byzantine Rule boundary-check discipline already applied to every
other field on this payload. Neither field is enforced against a
counterparty yet (that requires OpenLiquidity's matching logic to read
them, tracked as follow-up in `BACKLOG.md`, not claimed done here) — this
RFC adds the vocabulary, not the enforcement.

**4. `@satsails/p2p-trading-sdk` gains a `WalletAdapter` interface** (new
`packages/sails-sdk/src/wallet-adapter.ts`), matching the proposal's
shape closely since it was already sound:

```typescript
export interface WalletAdapter {
  getPeerId(): Promise<string>
  getAddress(asset: string): Promise<string>
  getBalance(asset: string): Promise<string>
  signTransaction(asset: string, tx: unknown): Promise<unknown>
  broadcastTransaction(asset: string, signedTx: unknown): Promise<string>
  getCapabilities(): Promise<WalletCapabilitiesDeclaration>
}

export interface WalletCapabilitiesDeclaration {
  assets: string[]
  fiatRails: string[]
  supportsP2PTrading: boolean
  supportsOnchainSettlement: boolean
}
```

Renamed `getNodeId()` → `getPeerId()` to match this codebase's own
existing vocabulary (`User.peerId`, `PeerHandle.peerId`,
`pearNodeRegistry`) instead of introducing a synonym for the same
concept. `SailsClient` accepts an optional `wallet: WalletAdapter` in its
constructor options — when present, a new `client.capabilities` module
(`packages/sails-sdk/src/modules/capabilities.ts`) can call
`wallet.getCapabilities()` and `POST /v1/capabilities/register` (new
route, §below) without the caller re-assembling the declaration by hand.
The adapter is optional: every module built in `@satsails/p2p-trading-sdk` v0.1 already
works without one (they only need HTTP/WS, never a private key) — this
is additive, not a breaking change to the v0.1 surface.

**5. New route, `open-agents` module boundary** (closest existing owner
of "capability declaration" per RFC-005's `agent-delegation` mapping):
`POST /v1/capabilities/register` (auth required) — body
`{ capabilityName, scope, constraints? }`, calls
`capabilityRegistry.grant()` with `grantedTo = req.participantId`,
`issuedBy = req.participantId` (self-issued for the MVP — a real
multi-party issuance flow, e.g. a module operator granting scope to an
agent, is follow-up work, not claimed done here). `GET
/v1/capabilities/:participantId` lists active grants. `POST
/v1/capabilities/:grantId/revoke` (auth required) revokes one — added
during implementation since a grant system with no revoke endpoint would
be incomplete, not specified above but consistent with it.

**Current registration boundary.** `capability.routes.ts` still binds
both issuer and holder to the authenticated participant; this is
self-declaration, not independently issued agent delegation. The registry
now rejects names and scopes outside `CANONICAL_CAPABILITY_SCOPES`:
`trade-coordination` (intent creation/discovery) and `settlement`
(release/refund/split). The `agent-delegation` module mapping is not itself
an accepted grant scope. Revocation requires the authenticated holder
and is serialized against execution authorization (ADR-004). The registry
checks scope and expiry; arbitrary JSON constraints such as `maxValue`
are not financial limits enforced by this registry. A self-issued grant
does not substitute for participant ownership, ruling authority or
required settlement signatures. See ADR-004 and RFC-014 for enforcement
and production boundaries; no multi-party delegation or production
homologation is established by this registration path.

**6. Reputation becomes addressable by `peerId`**, the portable identity
this RFC's Motivation section corrects the record on:
`reputation.service.ts` gains `getByPeerId(peerId: string)`, and
`GET /v1/reputation/peer/:peerId` (new route) resolves `User.peerId` →
`participantId` → the existing `get()` path, returning the same
`ReputationScore` shape `GET /v1/reputation/:participantId` already
does. No new scoring logic — this is a lookup key addition, matching the
Motivation section's correction that `peerId` (Pears), not a
Pears-hosted reputation service, is the portable substrate.

## Primitives Used or Extended

No new primitive. `CapabilityGrant` is Core-component data
(`PROTOCOL_SPECIFICATION.md` §1.10, already ruled non-primitive by
RFC-005 itself — "neither has a participant-facing lifecycle of its
own"). `TradeIntentPayload`'s two new fields extend an existing
primitive's payload shape additively, the same category of change
RFC-009 (decimal strings) and RFC-012 (VALIDATED/COORDINATED) both made
to the same primitive.

## Principle Alignment

- **Principle 5 (Capability Based):** this RFC is what actually delivers
  RFC-005's own stated goal — `CapabilityGrant` moves from an interface
  that existed only in a stub to one with real issue/check/revoke
  behavior and a persisted table.
- **Principle 9 (Interface Agnostic):** `WalletAdapter` is deliberately
  transport- and chain-agnostic (asset is a string key, tx/signedTx are
  `unknown`) — same discipline `SettlementProvider`/`TransportProvider`
  already use, so a wallet's own signing stack (WDK-based or otherwise)
  can implement it without this SDK assuming anything about *how* the
  wallet signs.

## Specification

| File | Change |
|---|---|
| `prisma/schema.prisma` | New `CapabilityGrant` model + migration |
| `src/common/types/capability.ts` | `CapabilityRegistry`'s methods corrected to the RFC-005-consistent shape (see Decision §2) |
| `src/core/capability-registry.ts` | Real implementation against Prisma; `CAPABILITY_IMPLEMENTATIONS` static map |
| `src/common/types/intent.ts` | `TradeIntentPayload` +`minReputationRating`/`kycRequired` |
| `src/core/intent-engine.ts` | `validateStructure()` bounds-checks `minReputationRating` |
| `src/modules/open-agents/capability.routes.ts` (new) | `POST /v1/capabilities/register`, `GET /v1/capabilities/:participantId` |
| `src/modules/open-reputation/reputation.service.ts` | `getByPeerId()` |
| `src/modules/open-reputation/reputation.routes.ts` | `GET /v1/reputation/peer/:peerId` |
| `packages/sails-sdk/src/wallet-adapter.ts` (new) | `WalletAdapter`, `WalletCapabilitiesDeclaration` |
| `packages/sails-sdk/src/modules/capabilities.ts` (new) | SDK-side wrapper for the new routes |
| `packages/sails-sdk/src/client.ts` | Optional `wallet` constructor option, `client.capabilities` |

## Backward Compatibility

No `protocolVersion` bump — every change is additive (new optional
payload fields, a new Core-component table with no prior data to
migrate, new routes, a new optional SDK constructor argument). Existing
callers of `intentEngine.create()`, `@satsails/p2p-trading-sdk`'s v0.1 surface, and
every existing route are unaffected.

## Reference Implementation Plan

1. Migration + `capability-registry.ts` real implementation (this pass).
2. `TradeIntentPayload` extension + validation (this pass).
3. `WalletAdapter` + SDK wiring (this pass).
4. `peerId`-keyed reputation lookup (this pass).
5. **Explicitly not this pass, tracked in `BACKLOG.md`:** OpenLiquidity
   actually reading `minReputationRating`/`kycRequired` during matching;
   a non-self-issued grant flow (module operator → agent); the Policy
   Engine's governed-rule storage (`get`/`propose`/`activate`) that would
   let `CapabilityGrant` scopes be checked against a versioned, proposed-
   and-activated policy instead of only the grant's own static `scope`
   array.
