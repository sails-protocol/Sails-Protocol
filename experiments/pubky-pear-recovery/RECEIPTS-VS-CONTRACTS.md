# Lab receipts vs the real OpenProof / OpenReputation contracts

Read-only comparison. No production contract, schema or code was changed. Executable part: `test/contracts-gap.test.mjs`
(copies two formulas literally; imports nothing from `src/`). The lab receipt is **not** conformant with either module.

## What the real contracts are (current `main`)

| Contract | Where | Shape |
|---|---|---|
| Claim / Proof / Verification | `prisma/schema.prisma` models `Claim`, `Proof`, `Verification`; `docs/PROTOCOL_SPECIFICATION.md` section 1.8 | DB rows with server-assigned uuid ids and timestamps; `Proof.evidenceHash` is **always recomputed server-side** as sha256 of canonicalized evidence (`proof.service.ts:161-170`); `Verification` has `verifiedBy`, `verdict`, `nonce` |
| EvidenceReference | same schema; `proof.service.ts:438-520` | pointer to stored media; `sha256` of the bytes; `signature` = participant Ed25519 signature over that **bare digest** (no domain separation) |
| Trade evidence bundle | `packages/sails-sdk/src/modules/proof.ts` (`TradeEvidenceBundle`) | claims, proofs, verifications, external references, timeline entries (`entryHash`, `prevHash`) |
| Timeline / event chain | `src/common/events/event-store.ts:92-104` | `sha256("${eventName}:${publishedAt}:${JSON.stringify(payload)}:${prevHash}")`, genesis literal `"genesis"`, no signature |
| Reputation | `docs/PROTOCOL_SPECIFICATION.md` section 1.6; models `ReputationEvent`, `Vouch` | score is computed by the server's OutcomeEngine from `SettlementOutcome` (`recordOutcome()` is the sole input); `rate()` is informational; `ReputationScore` is a server read model |
| Participant | `User.id` + registered Ed25519 `publicKey` | economic identity; `peerId` is separate transport state |

## Gaps (what a portable signed receipt cannot be today)

| # | Gap | Evidence | Direction (not a change) |
|---|---|---|---|
| 1 | **Identity**: contracts are keyed by `User.id`/registered key, not by a Pubky key. Nothing records the Pubky identity | schema, `identity.service`, no Pubky reference | needs an identity-binding decision in #276 before any receipt can name a Pubky key as `claimedBy` |
| 2 | **Structure**: three server objects (Claim, Proof, Verification) vs one signed record | `Claim.id`, `Proof.id` uuid, `Verification.verifiedBy/nonce` are server-assigned | a portable form must define which parts are client-signed and which are server attestations |
| 3 | **Hash and canonicalization**: OpenProof `canonicalize` matches the lab encoder for plain objects (test C1) but emits invalid JSON for `undefined` and accepts non-integers (C2); the Timeline hash uses `JSON.stringify` and is **key-order dependent** (C3), uses `:` joins (ambiguity) and a different genesis (C4) | tests C1-C4 | a portable spec needs one canonical form, domain-separated, versioned |
| 4 | **Signatures**: `EvidenceReference.signature` signs a bare hash; `Verification`, `ReputationEvent`, `Vouch`, Timeline entries carry **no signature** | schema; `proof.service.ts:472-477` | lab receipts are signed and co-signed, the real chain is server-asserted, so third parties cannot verify it without trusting Sails |
| 5 | **Reputation is not derived from receipts**: score input is the server-side settlement outcome, not client-signed evidence | spec 1.6 | a receipt could be Proof evidence for a Claim, not a score input; a portable reputation needs a signed `SettlementOutcome` export, which does not exist |
| 6 | **Anti-truncation / anchor**: Timeline chain is per correlation id on the server; lab chain needs a pinned head; `AnchorProof` (OpenTimestamps) is optional per evidence | spec 1.8, `proof.ts` | replicate receipts to the user's own storage and pin heads |
| 7 | **Dual-party attestation**: lab co-signature by the counterparty has no counterpart in the real contracts (verification is by a third party/arbiter) | `Verification.verifiedBy` | decide whether mutual attestation is a new Claim type or a Verification variant |
| 8 | **Privacy**: lab receipts carry amounts/counterparty in clear; contracts keep evidence server-side and reference media | schema | portable form needs selective disclosure or hashed fields |

## What this means for Day 0

The lab receipt can at most become a **new evidence type** attached to a Claim (an `EvidenceReference`-like object signed by a
Pubky-bound key), after gaps 1, 3 and 4 are decided. Mapping it onto Claim/Proof/Verification today would invent server-owned fields
client-side. Owners already in the repo's governance: architecture owner #276 (identity and portability), OpenProof/OpenReputation
RFC-006/RFC-007/RFC-008 for evidence, reputation and timeline contracts; a Gatekeeper review is required.
