# ADR proposal (not accepted), revision 2: Pubky identity as root, Pear transport keys re-authorized

Status: **PROPOSED, for CTO decision.** Number and location are the CTO's to assign. This revision applies the CTO decision on
PR #543 (model B) and the results of mission 02. It changes no canonical documentation. Evidence: this directory.

## Context

Day 0: Pubky-first identity, Pear for private communication, portable OpenProof/OpenReputation history, Paykit for payment
coordination (PR #542). Funds authority, economic identity and transport identity stay separate
(`docs/IDENTITY_ARCHITECTURE_DISCOVERY.md`, `docs/CRYPTOGRAPHIC_MODEL.md`). Today the Pear key is ephemeral and unbound.

## Decision proposed

1. **Recovery model B.** The user recovers the Pubky identity with Pubky's own mechanisms. Pear/device keys are fresh random keys,
   one per device and session epoch, re-authorized by the Pubky identity after reinstall. No Sails-owned phrase, no BIP-39 P2P
   phrase for the user, no Pear key derived from any Pubky or wallet secret. A and C remain lab comparisons only.
2. **The authorization is a native Pubky grant, not a parallel certificate.** Integrator asks the signer for a grant whose
   capabilities are `.../pear/devices/:rw` plus one capability per transport scope. The integrator's grant proof-of-possession key
   signs a short statement (`sails.pear-session.v1`: Pear public key, device, scopes, audience, iat, exp <= 1 h) via
   `createCustomPop`; the Pear key signs a binding over (grant id, nonce, Pear key). Verification needs only public data
   (`verifyCustomGrantPop` + Sails policy). The user's consent screen therefore decides the scopes; the integrator never holds
   the Pubky secret (tested with a separate signer process).
3. **Revocation.** Revoking the grant cuts the integrator at the homeserver. For other integrators: (a) short statement expiry
   bounds the window; (b) verifiers MUST check grant status online before authorizing anything new or privileged and MUST fail
   closed when the status is unavailable (tested); (c) when the signer is Sails-aware it deletes the directory record. Offline
   verification alone is insufficient and never acceptable as proof of non-revocation. Stale data may be shown read-only,
   labelled stale, and never used to authorize.
4. **Directory.** Public records under `/pub/sails.market/pear/devices/`; the device list is public (privacy cost to be accepted or mitigated).
5. **Transport.** Pear (HyperDHT/Hyperswarm) for live negotiation chat on Day 0, behind `TransportProvider`. Pubky Noise is not adopted
   for Day 0 and is not rejected: see `TRANSPORT-COMPARISON.md` for the decision point and its three entry conditions.
6. **Receipts.** The lab receipt format is not a contract. Mapping to OpenProof/OpenReputation requires the identity-binding and
   canonicalization decisions listed in `RECEIPTS-VS-CONTRACTS.md`.

## Revision 3 addendum (Mission 03, after CTO review of #545)

* The undocumented error-ordering probe is **diagnostic only** and is not an authorization oracle.
* Third-party authorization requiring **immediate** revocation is **BLOCKED** until upstream documents a status endpoint or signed revocation feed.
* An auditable bounded alternative exists and is tested (`SECURITY-CLOSURE.md` section 4): provenance from the identity's directory, signed statement age < N,
  homeserver modification time < N, sequence guard, fail closed when unavailable; N is a parameter (5-15 min to be chosen after a threat model). It trusts the user's
  homeserver for freshness and revocation (a homeserver that ignores revocation defeats it) and needs a live integrator re-publishing before N.
* Two-year grants accepted as an upstream constraint for the experiment only; protocol-level short `exp` works (suite 06) but the official signer API cannot request it.
* Records must be signed, versioned (`seq`), anti-replay and anti-rollback, with bounded freshness; the directory is never trusted as authority.
* Pear remains the Day 0 transport candidate (viability: `PEAR-VIABILITY.md`); Pubky Noise not implemented.
* Receipts: minimal decisions and acceptance criteria in `CONTRACT-RECONCILIATION.md`, to be approved by the CTO before any implementation.

## Revision 4 addendum (Mission 04, after CTO review of Mission 03)

* **Upstream asked, publicly:** https://github.com/pubky/pubky-homeserver/issues/743 (status endpoint / signed revocation feed, signer-side lifetime, service-specific consent, SDK deadlines). No answer yet when this was written; nothing here depends on one.
* **Revocation vocabulary (use these words):** *immediate revocation* = a verifier refuses within seconds of the user's action; available only with a cooperating signer that deletes the record AND an honest homeserver (measured: next poll). *Revocation with limited exposure* = a verifier refuses after the freshness window N; measured with N = 300 s: a revoked grant's record was still accepted for 291 s / 300 s in two runs and first refused at 301 s / 310 s with a 10 s poll (suite 07, W1). *Not revocable by a third party* = anything that relies on a homeserver that ignores revocation (S8) or on a verifier whose clock or guard state is wrong (W3, W6).
* **N = 300 s is an experimental parameter, not a Day 0 policy.** False-accept windows measured: honest homeserver + revoked integrator, up to N; hostile homeserver replay, up to N (forged `Last-Modified` adds nothing); verifier clock running L seconds behind, up to N + L; verifier restart with an in-memory guard, rollback inside N; hostile homeserver that ignores revocation, unbounded.
* **Binding authority model** (`portable/SPEC.md`): the root signs only the grant; a grant client's PoP is NOT a root signature; a Pubky-to-Participant binding counts as *root-consented* only if the grant names the Participant key in an approved capability; otherwise it is *delegated-only* and refused. Participant-signed revocation is verifiable by anyone.
* **Recovery vs availability** (criterion of the mission): the Pubky identity is the single recovery point for *identity* (same key in a second app, verified with real SDK artifacts). It does not recover the Participant key, private openings and confirmations, chat history or messages; those need replication. The public chain verifies without them but yields no confirmed reputation.
* **Pear integration:** minimal proposal `PEAR-TRANSPORT-PROPOSAL.md` (two optional methods, one accessor, `HumanChatChannel` takes a provider); nothing implemented.
* **Real devices:** `REAL-DEVICE-TESTS.md` and the `field/` kit are ready; Ring and phone rows are UNKNOWN until the infrastructure partner runs them.
* **Supply chain:** `HYPERCORE-PROVENANCE.md`: content equals the signed upstream commit; the attestation record for 11.39.3 is missing at the registry; neither compromised nor attested.

## Consequences and costs

* Depends on an **undocumented** homeserver behaviour for third-party revocation status (observation 19). Ask Pubky for a documented
  grant-status endpoint or signed revocation feed; until then it is a Day 0 blocker, not a hidden assumption.
* Grants live 2 years and the signer API cannot shorten them; security rests on short statements plus re-attestation.
* Pubky JS SDK 0.x moves fast (0.11 to 0.16 in about eight weeks) and has no raw sign() and no companion-claim API in JS; pin versions and keep the drift tests.
* Callers must set their own deadlines for storage calls.
* A real signer app (Ring) was not exercised: process-level separation only.

## Day 0 blockers (objective list; owners are existing roles, none created here)

| # | Blocker | State | Owner |
|---|---|---|---|
| 1 | Documented third-party grant-status / revocation feed (or accept the undocumented probe explicitly) | open | CTO decision; upstream Pubky |
| 2 | Real signer-app test (Ring or equivalent) of the grant flow, narrowing and revoke | open | independent Gatekeeper + dev partner who runs live infra tests |
| 3 | Pear runtime, mobile (Bare), production NAT/relay, offline delivery | open | dev partner (live infra), CTO transport decision |
| 4 | Binary versioned canonical encoding for the statement and binding; signature/KDF review; zeroization | open | CTO + Gatekeeper |
| 5 | Directory authenticity against a hostile or stale homeserver; privacy of a public device list | open | CTO + Gatekeeper |
| 6 | Identity binding between Pubky key and Participant (`User.id`/registered key) | open | architecture owner #276 |
| 7 | Receipt portability: gaps 1-8 in `RECEIPTS-VS-CONTRACTS.md` | open | #276 + RFC-006/007/008 owners |
| 8 | Recovery/evidence/chat-history separation, pinned replicated receipts, anti-truncation | open | CTO |
| 9 | Pubky Noise licence file, JS/WASM or FFI route, delegated-key model (only if Noise is reconsidered) | not needed for Day 0 chat | CTO |
| 10 | Independent Gatekeeper review of this experiment | open | Gatekeeper |

No GO is declared: this is a passed prototype, not a homologated Day 0 implementation.
