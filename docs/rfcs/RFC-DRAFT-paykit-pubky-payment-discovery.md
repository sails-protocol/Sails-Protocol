# RFC (Draft) — Optional Paykit / Pubky Payment Discovery Adapter

**Status:** Research / future roadmap; NOT ACCEPTED, NOT IMPLEMENTED.
**Date:** 2026-10-24
**Scope:** Sails Protocol interoperability; outside Day-0, P1, P3, P4 and production gates.

## Problem and opportunity

A Sails Participant may want a stable externally discoverable payment identity and multiple receiving methods without publishing sensitive counterparty-specific destinations. Synonym's Paykit provides Pubky-based public endpoint discovery, encrypted private payment coordination and receipt exchange. Bitkit's native architecture includes Paykit integration, but the upstream Paykit documentation still explicitly describes the protocol as WIP / not production-ready. Shipping integration is not equivalent to protocol stabilization.

## Proposed boundary (non-normative)

- Add a **fully optional** Paykit/Pubky discovery adapter; never make Pubky, a homeserver, Paykit or Bitkit a prerequisite for Sails economic participation.
- Preserve Sails Participant identity as canonical for economic authority. Pubky identifiers are externally bound claims, not automatically equivalent identities or spending keys.
- Paykit discovers and transports endpoint metadata; existing Sails SettlementRail/SettlementProvider adapters execute and verify settlement. Never interpret a Paykit endpoint as permission to move funds.
- Discovery output is untrusted until validated against the trade's allowed rail, asset, network, recipient authorization and capability profile.
- Destination Authority, economic disposition, escrow, dispute resolution, payout binding, evidence and reconciliation remain exclusively governed by Sails contracts. A Paykit endpoint update MUST NOT silently mutate a committed trade destination.
- Public endpoints must be explicitly opted into; bank details, PIX keys, reusable identifiers, counterparty private data and correlation-sensitive metadata should default to private or unpublished.
- Private exchange requires independently assessed cryptography, key management, consent, anti-replay, expiration, availability and metadata-leakage properties. Paykit receipts are supplemental evidence, never authoritative proof of settlement by themselves.
- Failure or unavailability of Pubky/Paykit must fail safely without changing Sails economic state; existing non-Paykit routes remain available.

## Candidate adapter contract (illustrative, not approved)

```ts
interface PaymentDiscoveryAdapter {
  discover(externalIdentity: string, context: { network?: string; acceptedRails: string[] }): Promise<UntrustedPaymentEndpoint[]>;
}
```

No new universal identity, automatic settlement, or direct database writes are implied. A separate accepted design must define identity binding and endpoint authorization.

## Future acceptance plan

1. Review upstream Paykit specifications, release maturity, license, mobile/FFI and Rust-to-TS integration options.
2. Map Sails Participant, payment-account trust, Payment Destination Commitment, Destination Authority and ADR-002 rail adapters to Paykit concepts. Explicitly resolve any incompatible semantics before coding.
3. Threat-model identity impersonation, endpoint substitution, replay, stale endpoints, phishing, malicious homeserver, privacy/correlation, encrypted receipt misuse and compromised device/key.
4. Implement a mock adapter behind a disabled-by-default feature flag, in an isolated research branch.
5. Demonstrate compatibility tests across BTC on-chain, Lightning and unsupported rails; test offline/degraded modes and ensure no change to escrow authority.
6. Seek governance acceptance and independent review; only then schedule production implementation and release gates.

## Non-goals

No Paykit deployment, dependency installation, migration, wallet key import, new settlement rail, protocol identity replacement or production authorization under this RFC.

## References

- https://pubky.org/explore/technologies/paykit/
- https://github.com/pubky/paykit-rs
- https://github.com/synonymdev/bitkit
- Sails: `docs/SYSTEM_DESIGN.md`, `docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`, `docs/adr/ADR-002-asset-settlement-rail-adapter-provider-architecture.md`, `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`.
