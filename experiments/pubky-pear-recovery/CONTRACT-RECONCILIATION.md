# Reconciling the eight receipt gaps with OpenProof / OpenReputation / #276 (Mission 03, item 5)

Status: **PROPOSAL for CTO approval. Nothing here changes a production contract, schema or code, and no parallel contract is invented.**
Every item below reuses an existing mechanism and states a verifiable acceptance criterion. Implementation waits for the CTO.
Gap numbers refer to `RECEIPTS-VS-CONTRACTS.md`. Context from #276 (CTO comments of 2026-10-25): the Day 0 minimum includes Nostr OR Pubky
identity with proof of possession, portable OpenProof, and a reputation that is a **local, reproducible projection over proven facts, not a
transported score**; minimal-proof privacy; no universal Sails ID; no derivation from financial seeds.

Existing mechanisms reused: `Participant` + `IdentityProof` (spec 1.1); `Claim` with open `claimType` + `Proof` + `Verification` (spec 1.8, RFC-006);
`EvidenceReference` with participant signature and optional `AnchorProof` (RFC-007/008); event hash chain (`event-store.ts`);
`recordOutcome()` as the sole reputation input (spec 1.6, RFC-007 D8).

| Gap | Minimal decision the CTO needs to take | Existing owner / place | Verifiable acceptance criteria (all executable) | Explicitly NOT proposed |
|---|---|---|---|---|
| 1 Pubky-to-Participant binding | Express the binding as a `Claim` (`claimType: "external_identity_binding"`, assertion = provider + external id + participantId) supported by `Proof`s from BOTH keys (Participant key signs a challenge naming the Pubky id; the Pubky side signs through a grant custom-PoP naming the participantId) and a `Verification`. One binding per persona/context | #276 (identity layers); RFC-001 Participant; RFC-006 | (a) a third verifier with no Satsails access validates both directions offline; (b) binding to a different Pubky id or participant is refused; (c) revocation of the binding is itself a verifiable fact and a second verifier sees it within the freshness bound; (d) two personas of the same user are unlinkable from the public records; (e) the binding grants no authority over funds (test: no capability path) | a universal Sails ID; any new primitive; deriving keys from wallet seeds |
| 2 Structure (3 server objects vs 1 signed record) | Decide which parts of a portable fact are client-signed and which are server attestations: client-signed = the Claim and its Proof; server/arbiter = Verification, labelled as an attestation by a named key | RFC-006 / RFC-007 | (a) an exported fact carries Claim + Proof + zero or more Verification, each with its signer; (b) a verifier can tell which statements the user made and which the operator made; (c) server-assigned ids are never required to verify | making `Verification` unsigned data authoritative |
| 3 Canonical hash and encoding | One canonical byte form for portable facts, domain-separated and versioned; keep the existing `Proof.evidenceHash` rule for evidence. Fix or avoid the known divergences (undefined, non-integers, key-order dependence of the event hash) in the PORTABLE form only | RFC-006/007; `proof.service.ts`, `event-store.ts` are read-only here | (a) published test vectors reproduced by two independent implementations; (b) key order changes nothing; (c) non-integers and undefined are rejected or defined; (d) a changed byte anywhere changes the digest (mutation test); (e) version field present and checked | changing the current hashes or migrating existing rows |
| 4 Signatures | Every portable fact is signed by at least the participant that asserts it; signature input has a domain prefix. Reputation/vouch events enter portability only as signed facts | RFC-006/007 | (a) signature verifies against the Pubky or participant key named in the binding; (b) cross-protocol replay refused (domain separation test); (c) a stripped signature is refused | signing existing rows retroactively |
| 5 Reputation derivation | Reputation is computed by the consumer from a set of proven facts with a published, deterministic function; `recordOutcome()` stays the server's input for its own score. Portability exports facts, not scores | spec 1.6, RFC-007 D8; #276 | (a) same fact set gives the same projection in two independent implementations (vectors); (b) every number is explainable down to fact ids; (c) duplicate facts and replays do not add weight; (d) a wash-trading fixture (same two parties, many small trades) is detected or capped, with the limitation written; (e) revoked or corrected facts are dropped | a transported score as source of truth |
| 6 Truncation / anchor | Portable history is replicated by the user to at least two stores and the head is pinned by whoever verifies; anchoring stays optional and policy-gated | RFC-008; #543 history chain as prior art | (a) removing the tail is detected when the head is pinned; (b) recovery from either store restores the same head; (c) an anchored head verifies offline; (d) the cost of anchoring is stated | mandatory blockchain anchoring |
| 7 Dual-party attestation | Treat the counterparty's co-signature as a `Verification` (or a second `Proof`) by the counterparty, not as a new object | RFC-006 | (a) a fact without counterparty confirmation is labelled one-sided; (b) a self confirmation is refused; (c) disagreement between parties is representable and not hidden | automatic positive reputation from a single side |
| 8 Privacy / selective disclosure | Default portable record carries commitments and the minimum fields; amounts, addresses and counterparty are disclosed per verifier. Benchmark signatures, credentials, commitments and Merkle proofs BEFORE any ZK, as #276 already says | #276; RFC-007 evidence principle | (a) the default record exposes no amount, address or counterparty (grep test on fixtures); (b) a verifier given a disclosure opening can confirm one field without the others; (c) two records of the same user under different personas are not linkable by the public fields; (d) private messages never appear in any portable record | publishing conversations, a universal identifier, ZK |

## Mission 04 status of gaps 1, 3 and 4 (lab only, CTO direction on #545: no production contract, schema or SDK type changed)

Implemented as a lab format with three agreeing implementations: `portable/SPEC.md`, `portable/src/issue.mjs` (libsodium), `portable/src/verify.mjs` (node:crypto only, imports nothing else),
`portable/verifier-py/verify.py` (Python standard library only, Ed25519 from the RFC 8032 algorithm), vectors `portable/vectors/portable-v1.json` (35 cases with hand-written expectations).

| Gap | What the lab shows | Evidence |
|---|---|---|
| 1 Pubky-to-Participant binding | Formalized authority model: the root key signs ONLY the grant; the grant's client key (cnf) signs the delegate PoP; the Participant key signs its own statement. A binding is accepted as **root-consented** only when the grant names the Participant key in an approved capability (`.../bindings/<participant>/:rw`); otherwise it is **delegated-only** and refused as a binding. Real SDK grants and custom PoPs are accepted by the independent verifier at the root-consented level | cases `binding/*`; lab `08-portable-recovery` X1, X6 (real homeserver, real SDK artifacts) |
| 3 Canonical form | CF1 (sorted ASCII keys, integers only, explicit escapes), versioned (`v:1`) and domain-separated (`SAILS-PORTABLE/1/<purpose>`); issuer encoder and verifier encoder agree on 300 fuzzed values and on the published bytes; the Python implementation reproduces every case | `test/portable.test.mjs`, `verify.py` 35/35 |
| 4 Signatures | every portable object is signed by its author under a purpose prefix; head signed under another purpose is refused (domain separation); forged, stripped or cross-purpose signatures are refused | cases and RED/GREEN mutants P1-P23 (23/23 detected after four cases were added) |

What the lab also demonstrates against the CTO's reputation requirements:
* **No selective receipts**: a fact removed from the middle, a tail removed, an edited outcome, a link re-signed with a wrong previous hash, and a repeated or forged dispute claim are refused; a corrected outcome replaces the earlier one for the same trade; a trade counts for reputation only with a counterparty confirmation whose key matches an opening of the commitment.
* **Known, written limits** (not hidden): (a) Sybil: five colluding keys each confirming one trade are accepted and counted as five distinct counterparties; (b) tail truncation with a head re-signed by the participant is accepted unless the verifier pinned an earlier head; (c) a user who abandons a chain/key and starts another can hide the old history unless counterparties' dispute claims or witnesses pin heads; (d) the user's own storage cannot prove completeness; (e) wash trading is only capped (3 per counterparty).
* **Recovery is not availability**: after recovering the Pubky identity in a second app, the public chain still verifies (existence, order, signer), but reputation computed without the private openings and confirmations is `-3` instead of `+1`; those private items are not recovered by the Pubky identity and need replication (lab X3).
* **Privacy**: the public record contains no counterparty key, trade reference, amount or conversation (test); openings are given to one verifier for one trade.

Still open for these gaps (needs CTO decisions, nothing implemented in production): who the witnesses are and how heads are pinned; retention of openings; dispute adjudication beyond a counterparty claim; how `Participant` registration would reference the Pubky id.

## Cross-cutting acceptance test (the Day 0 claim)

An independent app, with no access to Satsails, Sails Market or PixGo databases, starting from the user's recovered Pubky identity:
1. discovers the user's portable facts from the user's own storage;
2. verifies every signature, binding, chain link and head;
3. derives the reputation projection with a published function and gets the published vector result;
4. refuses a tampered, truncated, replayed, revoked or wrong-identity set, each by a named error.
Until this passes with a Gatekeeper review, "portable proof and reputation" is **not claimed**.

## Sequencing proposal

1 -> 3 -> 4 (identity binding, canonical form, signatures) can proceed as lab work without any production change; 2, 5, 6, 7, 8 follow.
Any change to `prisma/schema.prisma`, `proof.service.ts`, `event-store.ts` or the SDK types is a separate CTO-approved mission.
Owners are the existing ones named above; no new issue is created.
