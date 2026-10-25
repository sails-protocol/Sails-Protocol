# Master Backlog — Bullet-Clause Source Inventory

**Snapshot:** 2026-10-25, branch `docs/master-backlog-reality-reconciliation-20261024`, BACKLOG.md (5,906 lines). This is a **mechanical source inventory of 156 top-level Markdown bullet lines** in six selected sections; **not 156 distinct normative obligations**. A bullet may be explanation, implementation evidence, an open defect, a design constraint, or a nested requirement. Excludes all bullets outside the six sections, nested prose without bullet markers, and continuation lines. These exclusions prevent any claim of complete Master coverage.

| Source ID | BACKLOG line | Parent section | Literal first-line excerpt | Normative classification | Evidence | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| BB-0117 | L117 | MULTISIG | **H1 (dust validation) — fixed.** New `bitcoin-dust-policy.ts` computes Bitcoin Core's real `GetDustThreshold()` formula from the actual destination script | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0118 | L118 | MULTISIG | **H3 / H7 (outpoint persistence/attribution) — fixed for new escrows.** `Escrow.txLockVout` (nullable, additive) now persists the full funding outpoint alo | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0119 | L119 | MULTISIG | **New explicit debt (CTO-flagged, deliberately not resolved this mission): legacy-outpoint resolution.** Every escrow locked before this migration has `txL | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0120 | L120 | MULTISIG | H2 (key-derivation collision bound) and H5/H8 (client key recovery, pre-signature verification contract) remain open, gated behind Missão 10's own later ph | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0124 | L124 | MULTISIG | **H5 (client key recovery) — closed.** `@satsails/p2p-trading-sdk`'s new `deriveEscrowKey()`/`recoverEscrowKey()` give a real, production-shaped (not demo- | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0125 | L125 | MULTISIG | **H8 (pre-signature verification contract) — closed.** New `verifySigningIntent()`/`verifyAndSignEscrowPsbt()` decode a real release/refund/split PSBT and  | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0126 | L126 | MULTISIG | **H2 — corrected and reclassified, effective 2026-08-21.** The original framing ("theoretical risk over 2³¹ slots") generalized "arbiter" and "participant- | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0127 | L127 | MULTISIG | What remains real, not closed: the derivation path's last level (`m/0'/0/${index}`) is still non-hardened — the classic "xpub + one leaked child key ⇒ pare | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0128 | L128 | MULTISIG | The existing derivation must **not** be changed retroactively: the arbiter's pubkey is baked permanently into every already-created MULTISIG P2WSH redeem s | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0129 | L129 | MULTISIG | **Reclassified**: H2 moves from "production-hardening debt" to **compatibility/design constraint** — reopen only if any of: (a) MULTISIG ever supports mult | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0150 | L150 | MULTISIG | Protocol-wide fee activation for rails other than MULTISIG (`LIGHTNING_HODL`/`SAFE_GUARD_EVM`/`WDK_USDT_EVM` have no real fee-aware collection construction | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0151 | L151 | MULTISIG | `LIGHTNING_HODL`'s own analogous single-arbiter/live-config-derivation pattern (`ArkParties.arbiterId`, its own `defaultArbiterId()`) has the exact same hi | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0152 | L152 | MULTISIG | `escrow-pending-tx.ts`'s signature-collection path still never threads `triggeredBy` fully into every downstream consumer beyond what Fase 5.3 needed — wor | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0153 | L153 | MULTISIG | The false-green Postgres-test-hygiene pattern Fase 5.3 fixed in two named files (`feePolicyImmutability.test.ts`, `feeCollectionRecognitionIntegration.test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0154 | L154 | MULTISIG | Production protocol fee rate selection (0.40% or any other number), revenue-distribution percentages, production collection address/key generation, and any | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0165 | L165 | MULTISIG | **Repository current truth.** Eight known stale instances: this file's own "Phase Verification" section (above) understates settlement-provider/economic-mo | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0166 | L166 | MULTISIG | **Mintlify developer-surface current truth.** The public Mintlify site (`satsails.mintlify.site`, ~28 real pages) is live and populated — this repository's | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0201 | L201 | MULTISIG | **Bounded liveness for live chain/RPC calls.** Live network calls to a Bitcoin explorer or EVM bundler (`multisig.provider.ts:228,243,270,300,314,654,908,9 | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0202 | L202 | MULTISIG | **Shared SDK↔backend escrow-creation contract truth.** `packages/sails-p2p-schemas` covers dispute/offer/trade/capability-profile/bitcoin-network but not e | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0203 | L203 | MULTISIG | **`verifyLock()` fate decision (not made here).** All four `SettlementProvider` implementations define `verifyLock()`; zero real call sites exist anywhere  | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0204 | L204 | MULTISIG | **`WDK_USDT_EVM`'s `lockFunds()` — unknown-outcome / retry-safety evidence gap (new delta, CTO Gate #2 on F6, 2026-09-07).** Not caused by, and does not in | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0214 | L214 | MULTISIG | **New backlog delta — WDK Fund-Moving Operations Safety Sweep (registered 2026-09-08, investigation obligation derived from #56, not itself a demonstrated  | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0215 | L215 | MULTISIG | **Property A — Unknown Outcome / Retry Safety.** A side-effecting economic action must not be repeated merely because the previous attempt's outcome is unk | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0216 | L216 | MULTISIG | **Property B — Multi-Leg Partial Execution** (`splitFunds()` specifically, RFC-021 D9 — two separate, non-atomic on-chain transfers with no shared-recipien | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0217 | L217 | MULTISIG | **Property C — Submission vs. Execution.** Transaction submission acknowledgement is not equivalent to confirmed successful economic execution — a returned | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0227 | L227 | MULTISIG | **Test-harness reliability — Jest Haste module-map collision via `.claude/worktrees/` (new delta, 2026-09-08) — CLOSED.** Note: a CTO mission labeled this  | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0229 | L229 | MULTISIG | **Operational visibility for degraded QVAC-based detection.** `liquidity.service.ts:270-289` (`screenOfferContent`) and `handlers.ts:519-543` (`socialEngin | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0231 | L231 | MULTISIG | **Test-harness reliability under parallel load (new delta, CTO Gate follow-up on F8, 2026-09-07) — not caused by, and does not invalidate, F8's closure.**  | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0387 | L387 | IDENTITY | **Pears/HyperDHT identity** — the only one with a *real, shipped* | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0404 | L404 | IDENTITY | **`rfcs/RFC-013-capability-registry-and-wallet-adapter.md`** — titled | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0411 | L411 | IDENTITY | **`docs/PROTOCOL_SPECIFICATION.md` §1.1's "Portable Identity Layer"** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0419 | L419 | IDENTITY | **Nostr** — appears only in three unrelated framings: (1) design | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0432 | L432 | IDENTITY | **Pubky / PKARR** — appear *only* in that same `docs/GITHUB_PROJECT.md` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0436 | L436 | IDENTITY | **Iroh** — a targeted search of every `.md` file and `src/` found | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0441 | L441 | IDENTITY | **`ParticipantIdentity`** (the conceptual name for the `User` Prisma | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0447 | L447 | IDENTITY | **"multi-device"**, **"seed-derived identity"**, **"reputation | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0454 | L454 | IDENTITY | **Current architecture:** `User.publicKey` (economic/funds identity) | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0459 | L459 | IDENTITY | **Historical discussion, named only:** Nostr (as transport), Pubky, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0461 | L461 | IDENTITY | **Partial implementation:** none beyond the Pears/`peerId` case above. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0462 | L462 | IDENTITY | **Future direction:** the Portable Identity Layer (`docs/PROTOCOL_SPECIFICATION.md` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0465 | L465 | IDENTITY | **Missing obligation (this entry):** a single user recovery root | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0479 | L479 | IDENTITY | **Funds Authority ≠ Economic Identity ≠ Transport/Communication | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0482 | L482 | IDENTITY | **Same recovery seed/root ≠ same private key across protocols** — a | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0634 | L634 | PRODUCTION | **Protocol implementations** (semantics-bearing, must conform): | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0640 | L640 | PRODUCTION | **Application/platform targets** (consume a protocol implementation, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0643 | L643 | PRODUCTION | **Native/developer surfaces** (integration surface, smallest-correct | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0692 | L692 | PRODUCTION | **TypeScript implementation ≠ protocol truth.** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0693 | L693 | PRODUCTION | **Conformance ≠ interoperability.** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0694 | L694 | PRODUCTION | **Same canonical inputs must not produce different valid economic | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0769 | L769 | PRODUCTION | **Provider implementation ≠ provider maturity ≠ production | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0771 | L771 | PRODUCTION | **Reference implementation success ≠ independent interoperability | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0786 | L786 | PRODUCTION | **Third-Party Sails Modules & Developer Extension Ecosystem**, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0790 | L790 | PRODUCTION | **Sandbox / Playground** (Issue #78) — correctly **not yet mentioned | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0794 | L794 | PRODUCTION | **External security audit** — `docs/DEPLOYMENT.md` already states | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0797 | L797 | PRODUCTION | **RC1** — `docs/BACKLOG.md`'s own status table already shows | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0983 | L983 | MULTINODE | **Sails Protocol ≠ Satsails server.** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0984 | L984 | MULTINODE | **Sails Protocol ≠ Sails Node (added 2026-09-09, Day-0 Multi-Node + | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0993 | L993 | MULTINODE | **Node choice must not define market membership.** Explicit failure | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-0999 | L999 | MULTINODE | **Choosing a Sails Node must not, by itself, confine a participant to | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1001 | L1001 | MULTINODE | **Changing node must not inherently change participant economic | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1003 | L1003 | MULTINODE | **Running a node must not grant authority over settlement truth, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1052 | L1052 | MULTINODE | **Shared Market Universe ≠ Instantaneous Identical View.** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1053 | L1053 | MULTINODE | **Eventual propagation ≠ Economic fragmentation.** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1281 | L1281 | MULTINODE | **OpenP2P / OpenLiquidity:** `Offer`/`Trade` are per-node Postgres | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1285 | L1285 | MULTINODE | **Pears/transport:** already genuinely serverless at the connection | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1291 | L1291 | MULTINODE | **OpenIdentity:** `User.publicKey` is portable in principle (it's | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1298 | L1298 | MULTINODE | **OpenReputation:** `User.reputationScore` is a per-node running | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1302 | L1302 | MULTINODE | **Durable Protocol Truth** (`docs/DURABLE_PROTOCOL_TRUTH_EVIDENCE.md`): | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1308 | L1308 | MULTINODE | **Recovery/Reconciliation:** this session's own #56/#58/#59 | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1312 | L1312 | MULTINODE | **Production Readiness Consolidated Gate:** updated above with the | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1314 | L1314 | MULTINODE | **Issue #75** (multi-implementation/platform horizon): adjacent | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1318 | L1318 | MULTINODE | **Issue #77** (Final Red Team Horizon): its own "Sails semantic | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1322 | L1322 | MULTINODE | **Issue #78** (Sandbox/Playground): a future consumer of this | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1325 | L1325 | MULTINODE | **Protocol economics:** covered above — `docs/PROTOCOL_ECONOMY.md` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1653 | L1653 | COLD | Late Join Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1654 | L1654 | COLD | Partition Heal Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1655 | L1655 | COLD | Tombstone Resurrection Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1656 | L1656 | COLD | Malicious Selective Forwarding Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1657 | L1657 | COLD | Eclipse / Bootstrap Diversity Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1658 | L1658 | COLD | Node Descriptor Authenticity + Staleness Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1659 | L1659 | COLD | Wire-Version Mismatch Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1660 | L1660 | COLD | Node-Key Rotation / Compromise Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1661 | L1661 | COLD | Node Switch / Economic Continuity Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1662 | L1662 | COLD | Gossip Resource-Exhaustion Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1663 | L1663 | COLD | Clock-Skew / Offer-Expiry Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1664 | L1664 | COLD | Independent Node Operator No-Assistance Test | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1901 | L1901 | COLD | **BTC**: Bitcoin on-chain; Spark; Lightning; Arkade; Liquid/L-BTC. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1944 | L1944 | COLD | **Lightning Network** is a protocol/network family; LND, Core | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1949 | L1949 | COLD | **Ark/Arkade** is its own, separate Bitcoin second-layer | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1954 | L1954 | COLD | **Spark** is its own, separate Bitcoin L2/protocol family. It | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1959 | L1959 | COLD | **RGB** is a Bitcoin asset protocol/layer that may use or | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1970 | L1970 | COLD | **DePix**: Liquid **and** Spark — both required, not a choice. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1977 | L1977 | COLD | **USDT**: Ethereum; Base; Optimism; Polygon; Avalanche; Solana; | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1992 | L1992 | COLD | **USDC**: Ethereum; Base; Optimism; Arbitrum; Avalanche; Polygon. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-1994 | L1994 | COLD | **XAUT (Tether Gold)**: Ethereum. Day-0 required. (Network | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-2334 | L2334 | COLD | **FundingRequest UX — proven concrete gap (source-traced, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-2351 | L2351 | COLD | **SigningRequest UX (real gap, same source).** Participant-key | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-2356 | L2356 | COLD | **Rail-aware UX beyond the single BTC label fix.** PR #130 fixed | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-2359 | L2359 | COLD | **White-label configuration model.** No tenant-configuration | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-2363 | L2363 | COLD | **Dogfooding evidence obligation.** §2D item 3's non-privilege | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-2367 | L2367 | COLD | **Private Markets composition proof.** §2D item 12 classifies | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-3499 | L3499 | COLD | **`createTrade()`** — the ENTIRE durable side effect is | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-3507 | L3507 | COLD | **`createOffer()`** — the durable side effect is TWO writes | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-3518 | L3518 | COLD | **`submitEvidence()`** — the durable side effect is validation | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4225 | L4225 | COLD | Mission 3 (Partner Wallet Integration & Identity Continuity), PR | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4228 | L4228 | COLD | Mission 4 (Adaptive Execution / Capability Routing), PR #151, R1- | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4235 | L4235 | COLD | External Extensibility Blind-Spot & Precedent Consolidation, PR | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4373 | L4373 | COLD | **F-06 supersession (Destination Authority residual gap) and BRD-01 | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4398 | L4398 | COLD | **F-05 supersession (Dispute `RESOLVED`/`appeal()` — prior | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4408 | L4408 | COLD | **Offer status lifecycle — Product Decision required (`BR-OFFER-02`/ | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4422 | L4422 | COLD | **RFC-021 formal governance acceptance — distinct from its already- | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4437 | L4437 | COLD | **F-08A (session revocation absence) — flagged for backlog | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4450 | L4450 | COLD | **Three small evidence/test-hygiene items, named for visibility, not | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4577 | L4577 | COLD | Offer A3's implementation delta — owned by item 43 above. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4578 | L4578 | COLD | `Dispute.ARBITRATED`'s vestigial status — already tracked by | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4583 | L4583 | COLD | Trade terminal while its linked Escrow is non-terminal — already | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4590 | L4590 | COLD | MULTISIG-only automated settlement reconciliation — already | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4604 | L4604 | COLD | **`Offer.PAUSED` semantics — `PRODUCT DECISION REQUIRED BEFORE | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4610 | L4610 | COLD | **Seller release during an open Dispute — `FIXED / VERIFIED` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4627 | L4627 | COLD | **Appeal leaving a prior ruling's pending fund-movement instruction | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4643 | L4643 | COLD | **Dispute→Escrow crash-window non-atomicity — `ARCHITECTURE / | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4655 | L4655 | COLD | **Cooperative `EscrowPendingTransaction` abandonment — | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4664 | L4664 | COLD | **Intent `EXPIRABLE_STATES` vs. `VALID_TRANSITIONS` inconsistency — | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4744 | L4744 | COLD | Seller release during an open Dispute — owned by item 44. Authority | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4748 | L4748 | COLD | F-08A (session revocation absence) — owned by item 42. Authority | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4753 | L4753 | COLD | Offer A3's implementation delta — owned by item 43, untouched by | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4755 | L4755 | COLD | RFC-021 B2 / BRD-03 (uncapped appeal-round cost disclosure) — | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4757 | L4757 | COLD | Destination Authority — **`NO_ACTION_REQUIRED` / frozen truth | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4866 | L4866 | COLD | **Sharper formulation of the core obligation** | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4885 | L4885 | COLD | **Non-MULTISIG old-arbiter race — consolidated as a sub-obligation | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4906 | L4906 | COLD | **Tautological `assertExecutionMatchesAuthorization(payload, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4925 | L4925 | COLD | `docs/PROJECT_CONTEXT.md`'s SDK use-case reality table already | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4930 | L4930 | COLD | `docs/PROJECT_CONTEXT.md`'s ecosystem-integration section already | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-4934 | L4934 | COLD | RFC-016 already frames agents as "autonomous code acting on a | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5143 | L5143 | COLD | **Provider runtime health — `LEGITIMATE_DEFERRAL` scope corrected | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5181 | L5181 | COLD | **Provider/operator quality (evidence-based selection)** — | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5197 | L5197 | COLD | **Recovery as economic-truth reconstruction** — `ALREADY_COVERED` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5212 | L5212 | COLD | **Lifecycle-scoped information disclosure** — `ALREADY_COVERED`, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5233 | L5233 | COLD | **Pre-dispute cooperative recovery** — `PRODUCT_UI_INPUT` / | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5251 | L5251 | COLD | **Solver / proposed-solution separation (Anoma precedent)** — | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5285 | L5285 | COLD | **Anti-griefing / no-show economics — `DAY0_DECISION_REQUIRED` + | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5337 | L5337 | COLD | **Economic spam / fake economic activity — `DAY0_DECISION_REQUIRED` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5367 | L5367 | COLD | **Provider-unreachable failure surfaced as generic `INTERNAL_ERROR` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5425 | L5425 | COLD | **`IdempotencyKeyStatus.UNKNOWN` has no automated reconciliation | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5498 | L5498 | COLD | **Settlement-rail constraints can make an otherwise-supported | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5537 | L5537 | COLD | **A participant who disappears after funds are already locked, at | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5554 | L5554 | COLD | **A required co-signer who never signs — `DAY0_DECISION_REQUIRED`, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5566 | L5566 | COLD | **An assigned arbiter who never rules has no forced-reassignment | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5605 | L5605 | COLD | **Recovery-truth representation completeness — `DAY0_DECISION_REQUIRED` | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5676 | L5676 | COLD | **Unsafe capability exposure — `ALREADY_COVERED IN PRINCIPLE`, | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5888 | L5888 | OPENPROOF | `TimestampAnchor` remains the Sails-owned abstraction boundary. OpenTimestamps is a replaceable Day-0 mechanism behind that boundary, not Protocol Truth, O | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5889 | L5889 | OPENPROOF | The OpenTimestamps implementation MUST support multiple public/free calendars. No individual calendar may become a single point of failure. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5890 | L5890 | OPENPROOF | The same commitment MAY be submitted to multiple configured calendars. Valid responses/proofs already obtained MUST survive failures from other calendars. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5891 | L5891 | OPENPROOF | Failure of one calendar MUST NOT make OpenProof unavailable. Total timestamp-provider unavailability MUST degrade timestamp anchoring only; it MUST NOT reg | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5892 | L5892 | OPENPROOF | Calendar/provider success is evidence availability, not economic finality or protocol authority. | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |
| BB-5893 | L5893 | OPENPROOF | Day-0 evidence MUST cover one-calendar failure, N-1 failure, mixed success/failure, preservation of valid returned proofs, retry/recovery, and total provid | REVIEW REQUIRED | NOT VERIFIED | NOT ACCEPTED |

## Adjudication guardrails

- Review complete source paragraph and effective date before classifying a bullet. The same source may contain an implemented historical fix **and** a live residual risk.
- Check candidate overlaps with MO, BL, BP and independent audit/issue gates; no source-count addition or false deduplication.
- Classify **non-normative**, **historical implemented pending verification**, **current open obligation**, **conditional/future**, **superseded**, or **distinct acceptance gate** only after inspecting complete evidence.
- No changes to production routes, code, architecture, merge state or acceptance.
