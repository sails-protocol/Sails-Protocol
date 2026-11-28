> **Status: Superseded by Revision 3: conditional approval (CTO 28).** Delivery A received conditional approval (CTO 28); Delivery B is not authorized; nothing has been implemented or homologated. (Original text: PROPOSAL / PENDING_CTO_APPROVAL, joint Principal + GK recommendation.) All values (n/k, r/m, T_rec, Δ, D_max) are reference values only. E26 remains on documentary HOLD. The original document is in English; Revision 2 (§13) takes precedence where applicable, subject to the subsequent Revision 3 decision.

# DELIVERY A: Gen-2 Bitcoin (Taproot) + Sails Signing Federation. Decision document (Principal draft for the GK and the Documentary Auditor; for the CTO's decision)

Base: main 46d1a8a9; RFC-024 (stays formally a CANDIDATE); the Signing Federation record (#619, CTO 25); R1-R15; the GK's 6 proofs. Read-only: **nothing implemented**, and no irreversible economic step before the gates. Gen-1 (P2WSH 2-of-3) is preserved: existing escrows **never** migrate automatically.

## 0. The recommendation in one paragraph
A per-escrow **P2TR** output.
- **Key path:** a MuSig2 aggregate of **buyer + seller** only, for every cooperative close (release, refund, mutual agreement).
- **Script tree:** two ruling leaves, **Federation k-of-n + the winner**, using native `OP_CHECKSIGADD` k-of-n with **independent member keys**, not FROST; and two recovery leaves, **Recovery set m-of-r + one party** after a long relative timelock (CSV).
- **No leaf lets one party alone, or the federation alone, move funds, ever.** The federation's members **verify** the authorized decision (P1/P2 package) before each signs; they do not decide disputes.
- Rotation applies to new escrows by a versioned federation set committed in E26. Existing escrows keep their committed keys, and the recovery leaves are the answer to quorum loss.
- 3-of-5 is a reference only (not approved), and so are all timelock values; **the CTO decides them**.

## 1. The Taproot tree and the exact conditions of each spending path
`B` = buyer key, `S` = seller key (both client-held, as today). `F₁…Fₙ` = federation member keys (independent, §5). `R₁…Rᵣ` = recovery-set keys, disjoint from F and independent. CSV is relative to the funding confirmation.

| Path | Script (Tapscript, BIP342) | Who must sign | When it is used |
|---|---|---|---|
| **K: key path** | internal key `P = MuSig2(B, S)` (BIP327) | B **and** S (a 2-round MuSig2 between the two parties) | cooperative release, cooperative refund, mutual agreement (R13), including during a dispute |
| **L1: ruling for the buyer** | `<B> CHECKSIGVERIFY <F₁> CHECKSIG <F₂> CHECKSIGADD … <Fₙ> CHECKSIGADD <k> NUMEQUAL` | B **and** ≥ k federation members | a ruling of RELEASE (and SPLIT signed with the buyer) |
| **L2: ruling for the seller** | same with `<S>` | S **and** ≥ k federation members | a ruling of REFUND (and SPLIT signed with the seller); seller recovery after the buyer's no-show (today's EXPIRED → dispute) |
| **L3: recovery with the buyer** | `<T_rec> CSV DROP <B> CHECKSIGVERIFY <R₁> CHECKSIG … <m> NUMEQUAL` | B **and** ≥ m recovery keys, after T_rec | only if the federation cannot form a quorum (§4) |
| **L4: recovery with the seller** | same with `<S>` | S **and** ≥ m recovery keys, after T_rec | same |

Notes:
- **The winner co-signs every ruling leaf.** That is what stops the federation alone from spending; it is the same property as today's "arbiter + winner".
- **No CSV on L1 and L2:** a ruling executes immediately. CSV only on L3 and L4.
- **No leaf has a single key, and no leaf is party-only.** This is a deliberate exclusion: the Arkade buyer-exit-leaf lesson, and Despacho 066's "no automatic refund to the seller".
- Signatures use `SIGHASH_DEFAULT`/`ALL` (BIP341), which commit to the outpoint, the amounts and the outputs. There is no cross-escrow replay.

## 2. Participants and powers on each path
| Actor | K | L1 | L2 | L3/L4 | Alone, can it move funds? |
|---|---|---|---|---|---|
| Buyer | required | required (it is the beneficiary) | — | L3 with ≥ m recovery keys | **No** |
| Seller | required | — | required | L4 with ≥ m recovery keys | **No** |
| Federation (≥ k) | — | required | required | — | **No** (it always needs a party) |
| Recovery set (≥ m) | — | — | — | after T_rec, with a party | **No** |
| Node operator / Sails | **no key at all** unless it is also a federation member, which is counted against independence (§5) | — | — | — | **No** |

**Collusion bounds (to be declared; R9/R10):**
- k federation members + one party = theft of that escrow.
- m recovery keys + one party, after T_rec = theft.
- B + S = always (it is their money).

## 3. Disputes and authorized decisions
- **Decision quorum ≠ cryptographic quorum.**
  - The *decision* is made by the Resolution Layer: the integrator or the Sails desk, with Ed25519-signed rulings and the existing ADR-005 generations.
  - The *federation* does not judge. **Each member independently verifies** the P1/P2 authorization package before signing: the ruling signature and generation, the committed destination and outputs, the fee, and the digest it recomputes itself.
  - k independent verifications are the cryptographic quorum. A compromised node cannot obtain k signatures for an unauthorized spend unless k members are also compromised.
- **SPLIT:** two outputs; signed through L1 or L2 (the federation + one party). Either party may co-sign, so the one who is present suffices.
- **Mutual agreement (R13)** = the K path. It stays neutral to the federation (no member signs). It is still serialized against rulings through the Dispute record, as on the local branch.
- **Appeal:** none on Day 0 (E26 `NONE_SCRIPT_FIXED` stays true while the federation set is fixed per escrow).

## 4. Recovery from operator failure
| Failure | Outcome |
|---|---|
| The node or the Sails operator disappears | **Funds are not stranded:** the parties use K; the federation signs L1/L2 from a ruling any authorized Resolution Provider issues. The node holds **no key** (it is the coordinator only, CTO 25 role 1) |
| The Resolution Layer is unavailable (no ruling) | K by agreement; otherwise wait. **No timeout turns into a ruling**; L3/L4 after T_rec is the last resort |
| Fewer than k federation members are online | Wait (n−k members may be absent). Below quorum for longer than the runbook SLA: L3/L4 after T_rec |

## 5. Recovery from loss or compromise of a key
- **A party loses its key:** a buyer or seller key lost means K is impossible. The other party still has its ruling leaf (federation + itself). If the key lost is the beneficiary's, the ruling must go the other way, or wait for the recovery path. *Residual:* the beneficiary loses its own key and the money cannot reach it. That is user custody, disclosed (R10).
- **A federation member loses its key:** tolerated up to n−k members. The member is replaced **for new escrows** (§7).
- **A federation member is compromised:** below k, harmless alone. At or above k compromised members: theft becomes possible with one colluding party. The response is to freeze new escrows on that set, rotate, and for existing escrows, ask both parties to migrate cooperatively via K (optional). Detection and response: runbook R7, alerting R8.
- **Backup of member keys:** each member keeps its own encrypted backup and restore drill (R1-R2, R15 analogues *per member*). **No common seed, no common host** (GK proofs 1 and 3). Sails never holds a member's backup.
- **Proof of independence before the word "federation"** is used: the GK's 6 proofs. A ceremony log per member, separate organizations and hosts, a test that k−1 members cannot sign, and k declared in R9/R10.

## 6. Timelocks: semantics and protection
- **Only L3/L4 have a timelock:** a relative `CSV` from funding confirmation, `T_rec` (BIP68).
  - Its maximum is **65 535 blocks ≈ 455 days**. A longer horizon would need an absolute CLTV leaf, which fixes a calendar date at creation.
  - Reference, **not approved**: T_rec = 26 208 blocks ≈ 26 weeks. It must exceed the longest dispute plus the appeal horizon, plus a safety margin.
- **Protection of the buyer who paid fiat:** no leaf lets the seller alone reclaim the coins after time. A seller who stalls faces L1 (the federation + the buyer) as soon as a ruling exists. Neither L3 nor L4 can be used before T_rec, and even then a recovery quorum must agree.
- **Protection of the seller:** the buyer cannot take the coins without paying. Every buyer path needs the seller (K), a ruling (L1) or a recovery quorum after T_rec (L3). There is no buyer-only exit, unlike the Arkade leaf.
- **Race between a ruling and recovery after T_rec:** both are valid spends of one UTXO, and the first confirmed wins. **Technical control (rev 2, GK R-2/G-c):** no decision is issued or executed by the SF after **T_rec − Δ**, and the maximum dispute duration is < T_rec − Δ. The RS signs only after T_rec, in accordance with the existing decision, with proof from the append-only signed log (GV8) that the SF did not execute it within Δ. It never uses the node's database as proof.

**Named conflict.** "Funds never stranded" and "no unilateral withdrawal" and "the fiat payer is never harmed" **cannot all hold** when the federation and the recovery set are both lost **and** one party refuses to cooperate. This design keeps the last two and accepts the residual *stranded if F and R are both lost and a party refuses*. The alternative is a long-dated party-only leaf (seller or buyer alone after N years), which reintroduces a unilateral withdrawal and harms one side. It is **rejected**.

## 7. Federation rotation
| Case | Mechanism |
|---|---|
| **New escrows** | A versioned **federation set** `{version, k, n, member keys, recovery set}`, published like a policy (DRAFT→PUBLISHED→RETIRED, immutable; the same discipline as TradeTermsPolicyVersion, GK C9). Committed in the trade's E26 commitment and verified by both parties before funding |
| **Existing escrows** | **Never changed automatically**: the keys are in the script. A member's departure is absorbed by n−k tolerance. For a compromise or quorum loss: optional cooperative migration via K, or L3/L4 after T_rec |
| **Rotate shares while keeping the public key** | Only possible with a threshold *aggregated* key (FROST share refresh). With native k-of-n there is no aggregated key, so a member's change = a new set version (for new escrows only). This is the main reason one might later move a leaf to FROST (§8) |
| **Replace the public key** | A new set version only. It never touches funded escrows (#237: "recovery authority ≠ silent reassignment") |

## 8. Mechanisms compared (for the paths chosen above)
| Mechanism | Fit | For | Against | Recommendation |
|---|---|---|---|---|
| **MuSig2 (BIP327)** | K path, B+S | private, cheap, standard, PSBT fields (BIP373) | 2 rounds, both parties online, nonce discipline | **Adopt for K** |
| **Native k-of-n `OP_CHECKSIGADD` in a leaf** | L1-L4 | independent keys, no DKG, no interactive protocol, verifiable by the parties, simplest to audit | reveals k-of-n only when a dispute path is used; bigger witness on that path; rotation = a new set | **Adopt for L1-L4 on Day 0** |
| **FROST (threshold Schnorr)** | could replace the k-of-n part of L1/L2 | one key per leaf (private, smaller), share refresh keeps the pubkey | DKG + interactive signing state; the standard is still a draft (no final BIP); library maturity and audits uncertain | **Later optimization**, after an audit and an explicit decision |
| **MuSig2 per k-subset leaves** (C(n,k) leaves) | L1/L2 | each leaf is a plain aggregate | tree size, interactive nonces among members | Not recommended |
| Threshold ECDSA (Gen-1 P2WSH) | — | — | needs proof and an audit (CTO 25); not Taproot | Not for Gen-2 |

**Compatibility:**
- **PSBT:** BIP371 Taproot fields (tapLeafScript, tapScriptSig) plus BIP373 for MuSig2. JS library support exists for Taproot. **The MuSig2 library choice is UNCERTAIN** and needs a security review before use.
- **Fees and fee-reserve:** each path has a different vsize; L1/L2 are the largest (k signatures + n keys + control block). `fee-reserve-math.ts` must reserve for the **worst path**, not for the K path.
- **Payjoin:** RFC-024 §105 requires a compatibility probe before converging (txid mutation, outpoint binding, fee accounting). **Recommendation: Payjoin out of the Day-0 exit scope**, with the probe kept as a G2-c deliverable.

## 9. Threat matrix (each line becomes an adversarial test in Delivery B)
| # | Threat | Expected defence | Test |
|---|---|---|---|
| T1 | The federation alone signs (≥ k members, no party) | no leaf is satisfied | script test: k sigs without B/S → invalid |
| T2 | k−1 members + a party | L1/L2 not satisfied | k−1 sigs + B → invalid |
| T3 | A compromised node requests an unauthorized ruling spend | members recompute the digest and verify the package → refuse | mismatch of the package/digest/destination at each member |
| T4 | The seller stalls after a fiat payment | a ruling → L1 (F + B), with no timelock wait | end to end on regtest |
| T5 | The buyer no-shows | a ruling → L2 (F + S) | regtest |
| T6 | A party tries to exit alone after time | no single-party leaf exists | the tree audit + a script test |
| T7 | A recovery spend races a ruling | the first confirmed wins; the runbook forbids recovery while a ruling exists | a regtest race in both orders |
| T8 | MuSig2 nonce reuse or a rogue key (K) | BIP327 nonce rules, key aggregation with coefficients | library conformance vectors + a reuse-refusal test |
| T9 | Signature replay across escrows | BIP341 sighash commits to the outpoint and amounts | cross-escrow replay → invalid |
| T10 | Below quorum for long | L3/L4 after T_rec, never before | CSV boundary tests (T_rec−1 invalid, T_rec valid) |
| T11 | Fee or pinning attacks on the dispute path | worst-path reserve; CPFP/RBF policy | fee-reserve tests per path |
| T12 | Reorg after the ruling broadcast | UNKNOWN ≠ FAILED, reconciliation (as #299) | reorg simulation |
| T13 | A false federation (common controller) | the GK's 6 proofs before the label; independent ceremony logs | an evidence review, not a code test |

## 10. Acceptance criteria to approve Delivery A (for the CTO and the GK)
> Note (Revision 3, CTO 28): these criteria remain the conditions of the conditioned approval; the approval does not by itself satisfy them. Parameters stay pending and Delivery B is not authorized.
1. The tree and the powers table (§1-§2) are accepted as the target, with **no leaf that is single-party or federation-only**.
2. The named conflict (§6) and its residual are accepted explicitly by the CTO.
3. The mechanisms: MuSig2 for K and native k-of-n for the leaves; FROST deferred.
4. The values to be decided (k, n, m, r, T_rec) are listed. 3-of-5 is a reference only.
5. Payjoin is out of the Day-0 exit scope, and the probe is kept.
6. Delivery B is only small PRs, in this order:
   - a script and PSBT library spike with conformance vectors, on regtest;
   - P1 (SettlementSigner, single round, already designed);
   - the federation-set registry and the E26 commitment;
   - the member verification service;
   - end-to-end regtest failure simulations T1-T12;
   - the GK homologation;
   - the objective activation criteria (R1-R15 per member + the 6 proofs).

## 11. Remaining incompatibilities and uncertainties
- **The library for MuSig2 (and later FROST):** maturity and audit status are UNCERTAIN, so a spike plus a review comes before any choice.
- **The current code is Gen-1 only** (P2WSH `p2ms`, ECDSA, `bip32.fromSeed` arbiter). Gen-2 is a **new provider** (a new rail kind), not a change to `multisig.provider.ts`. Gen-1 escrows stay on their rail.
- **The commitment format (E26)** has room for one arbiter today. It needs a federation-set version, the recovery set and T_rec (a protocol change, Tier 3).
- **Who the recovery set is** (independent of the federation and of Sails): unresolved. It needs an organisation and legal analysis (#619, no regulatory analysis exists yet).
- **The CSV horizon is capped at ≈ 455 days.** Disputes longer than T_rec would need an absolute-CLTV variant.

---

## 12. Internal governance of the Sails Signing Federation (CTO complement: a Day-0 requirement)
Owner direction: a **professional, controlled** infrastructure. Sails governance constitutes the federation entities, selects and replaces qualified participants, and sets the policies. **No network participant takes arbitration or signing authority by itself.** The numbers below are references for the CTO, not approved values.

### 12.1 Four separated bodies and their powers
| Body | Composition (reference) | CAN | CANNOT |
|---|---|---|---|
| **Governance Council (GC)** | ≥ 3 seats appointed by the Sails board, ≥ 1 of them independent of Sails management; decides by simple majority, and by 2/3 for removing a member | accredit, appoint, renew, suspend and remove federation entities, recovery custodians and resolvers; **publish and retire federation-set versions and policies** (immutable, versioned, §7) | hold any key; sign; issue a ruling; change a funded escrow |
| **Resolution Layer (RL)** | Day 0: the Sails desk (≥ 2 named resolvers, each with an Ed25519 identity, R15). Later: accredited integrator Resolution Providers (#619) | issue **signed rulings** (ADR-005 generation) | hold a federation or recovery key; sign a transaction |
| **Signing Federation (SF)** | **n = 5 entities, k = 3** (reference). Each is a separate legal entity with its own operator and its own key | each member **independently verifies** the ruling package (P1/P2: signature, generation, destination, amounts, fee, the digest it recomputes) and signs L1/L2 | rule on a dispute; add members; sign without a valid package; sign L3/L4 |
| **Recovery Set (RS)** | **r = 3 custodians, m = 2** (reference), disjoint from the SF, from the RL and from Sails operations | sign L3/L4 **after T_rec only**, on a recovery decision (§12.6) | act before T_rec; rule on a dispute; sign L1/L2 |

**Two quorums, always separate (item 3):**
- the **decision quorum** belongs to the RL: one accredited resolver on Day 0, or two resolvers above a value threshold set by the GC;
- the **cryptographic quorum** is k-of-n in the SF (or m-of-r in the RS).

No body counts toward the other's quorum.

### 12.2 Lifecycle of an entity or operator (item 1)
1. **Constitution and accreditation**, with evidence reviewed by the GC and checked by the GK:
   - a legal entity, a jurisdiction and the legal analysis (the #619 gap);
   - named operators;
   - an independence attestation (§12.3);
   - a key ceremony log;
   - a key-protection method (a hardware module or equivalent; hosting-agnostic, as in R5);
   - a backup and restore drill (R1-R2 per entity);
   - an SLA, a response contact and a contingency plan.
2. **Appointment** by a GC majority, for a **12-month mandate** (reference), renewable after a fresh evidence review.
3. **Substitution** (resignation or mandate end): a new set version. It applies to new escrows only, and the departing entity **keeps its duty for the funded escrows that committed its key** until they are terminal or past T_rec (a contractual tail obligation). **If the entity disappears anyway (GK G-d)**, the n−k tolerance applies first, then L3/L4 under §12.6. Beyond that it is the declared residual.
4. **Removal** (for compromise, an SLA breach or a conflict), by a 2/3 GC vote: the set is retired for new escrows. For funded escrows, the n−k tolerance covers the loss; on compromise, §12.5.

### 12.3 Independence and key protection (item 4)
- **Between SF members:** no common controller or beneficial owner, host, cloud account, administrator, or key custodian. Separate entropy and ceremony per member (the GK's proofs 1 and 3).
- **Sails and its node operators:** at most **1 SF seat** (reference; it must stay < k), declared and counted in R9/R10. **No RS seat.**
- **RS vs SF vs RL:** disjoint memberships.
- **Key protection:** each member's key lives in that member's own protected store with dual control (R4), its own backup (R1), a quarterly restore drill (R2) and revocation (R15). **Sails never holds a member's key or backup.**
- **Rotation:** a new set version only (§7). **A new key never controls funds committed to the old keys** (item 6).

### 12.4 Conflict of interest, audit and traceability (item 5)
- **Resolvers** recuse themselves when affiliated with a party or an integrator of the trade. A recusal and its reassignment are recorded before the ruling.
- **SF members** attest that they are not affiliated with the trade's parties, as part of the package check. When a member is affiliated, it abstains, and the quorum is formed without it.
- **Append-only audit:** for each GC decision (published), each ruling (Ed25519, ADR-005), each member's verification result (with digest, verdict and timestamp, signed by the member), and each signature.
- **A quarterly reconciliation:** spends observed on-chain are matched to authorized rulings and to member logs, and any mismatch is raised as an incident.

### 12.5 Response to compromise
A member key compromised (or suspected):
1. the GC suspends the member;
2. the set is retired for new escrows;
3. the exposure is computed (funded escrows that committed the key);
4. if < k members are affected, nothing moves;
5. if ≥ k members could collude with a party, the parties are offered a cooperative migration via K, and R9 bounds the loss;
6. the incident record is published.

A compromise of the GC cannot touch funded escrows: it can only publish a malicious set for **new** escrows. The parties verify the committed set before funding (E26), the set's publication is transparent, and the GK reviews it.

### 12.6 Recovery decisions (L3/L4)
- After T_rec, the RS **only executes a decision the RL has already issued** (GK R-1). With no such decision, it does not sign (the residual). **Corrected in rev 2:** the "GC ad-hoc panel" is withdrawn, because governance never decides (GV1).
- **The substitute resolver is PRE-DESIGNATED (GK G-a).** If the assigned resolver is unavailable, the substitute is the one already named in the set or policy version **committed at funding**, under the recusal rule of §12.4. Nobody is appointed after the dispute.
- **The recovery decision = the EXECUTION of the existing decision (GK G-b).** It never contradicts that decision. A new decision is issued only when none exists, and only before the cutoff. **The RS signs only in accordance with the existing decision, after T_rec, and after Δ with no execution by the SF.**
- **The cutoff and the source of proof (GK G-c):** no decision is issued or executed by the SF after T_rec − Δ. The proofs (the decision, and the fact that the SF did not execute it) come from the append-only signed log (GV8), never from the node's database.

### 12.7 Creating a NEW federated entity and binding it to escrows (item 6)
1. Proposal → 2. accreditation evidence (§12.2) → 3. a GC vote → 4. an independent key ceremony → 5. a set version in DRAFT including the entity → 6. a GK review (the 6 proofs, recomputed for the new set) → 7. PUBLISHED.

**Only escrows created after publication commit the new set.** Funded escrows are never re-bound, and no step assumes that a new key controls funds committed to old keys.

### 12.8 Collusion, failure and unavailability scenarios (item 7): technical control and its demonstration
| Scenario | Control | Demonstration (Delivery B) |
|---|---|---|
| k SF members + a party | script bound (k), R9 cap, the member-log reconciliation | T1/T2 script tests; a reconciliation drill |
| A captured GC | no key; affects only new sets; party-side verification of the commitment | a test that a funded escrow ignores a new set; a commitment-verification vector |
| A corrupt resolver (a valid signature, a wrong judgment) | recusal, a 2-resolver threshold above the value cap, audit. **The SF cannot detect a wrong judgment, only an invalid package** (declared) | a conflict-recusal test; a disclosure in R10 |
| The SF below quorum | n−k tolerance → L3/L4 after T_rec | T10 CSV boundary tests |
| The RS unavailable as well | the residual named in §6 | declared; no test can remove it |
| A Sails node outage | the node holds no key; another node or the parties via K | T4/T5 with the node offline |
| A key compromise | §12.5 | an incident drill |
| **T14: the winner loses their key** | mandatory key backup + a UI warning before funding (R10); only the other party's path remains (declared residual) | a regtest test: without B, L1/L3/K fail and L4 needs S |
| **RS + one party after T_rec** | RS executes only the existing decision; the cutoff; proof from the GV8 log; RS disjoint from SF, with m declared in R9/R10 | a CSV boundary test; a test that the RS refuses without an existing decision or before Δ |

### 12.9 Integration and traceability (item 8)
- **RFC-024 stays a CANDIDATE.** A dated note (G2-a) referencing this document is proposed, with no status change.
- **#619:** the Resolution Layer and the roles. **#121:** Gen-2 and the regulatory benchmark. **#237/#293:** recovery and lifecycle. **Project #3:** the EPM updates it.

Existing records keep their formal status.

### 12.10 Exit criterion (CTO): Gen-2 is NOT ready for implementation until these are decided
> Gen-2 activation is NO-GO until these are decided and the design is homologated; see Revision 3 below and the README of this folder.
1. Participants (the GC seats, n/k for the SF, r/m for the RS, the resolvers).
2. Powers (§12.1).
3. Quorums (§12.1, decision ≠ cryptographic).
4. Key management (§12.3).
5. Recovery (§6, §12.6) with T_rec **and Δ**, the **pre-designated substitute resolver** (G-a), and the **automatic opening of the dispute at `latestDisputeOpenAt`** (R-7; it interacts with #740 F0).
6. The governance rules (§12.2-§12.7).
7. The legal analysis per entity and jurisdiction.

These are the items the EPM lists as **CTO decisions**. Everything else in this document is a technical recommendation from the Principal and the GK.

---

## 13. Rev 2: the GK review incorporated (GK_revisao_ENTREGA_A_Gen2.md), with traceability to G1-G15 and GV1-GV10
Where this section conflicts with §1-§12, **this section prevails**.

### 13.1 Corrections from the GK review
- **R-1, the Recovery Set never decides.** Choosing between L3 and L4 without a decision would be choosing the winner, which violates GV1. **L3/L4 only EXECUTE a decision the Resolution Layer has already issued**, when the federation is lost. With no decision, R does not sign; that case is the residual.
  - §12.6 is corrected: **the "GC ad-hoc panel" is withdrawn.** Governance never issues a decision (GV1: governance appoints and sets policy, it never decides).
- **R-2, a technical control for the T7 race** (CSV counts from funding):
  - (a) **A cutoff:** no decision is issued or executed by the federation after **T_rec − Δ**, and the maximum dispute duration (including any future appeal) is **< T_rec − Δ**. The RL contract and the members enforce it: a package past the cutoff is refused.
  - (b) **R signs only after T_rec**, with proof of a valid decision **and** proof that F did not execute it within Δ.
  - (c) Both proofs come from the **append-only, author-signed, third-party-verifiable log (GV8)**, **never** from the node's database.
- **R-3, a new threat T14: the winner loses their key.** Take the buyer as the winner who loses key B: L1, L3 and K become impossible, and only L4 remains, which depends on the seller cooperating.
  - This is **declared as a residual**.
  - An F+R leaf without any party would be an alternative; the GK and the Principal **do not recommend it for Day 0**.
  - The mitigation is a mandatory key backup, with a UI warning before funding (R10).
- **R-4, the residual is right:** "one party + R" with R-1 and R-2, R independent and disjoint from F, m declared, R's collusion number in R9/R10, and governance never appointing the same entities to F and R.
- **R-5, stated plainly:** **k federation members + the LOSING party = theft of that escrow** (today k = 1). Likewise m R-members + one party after T_rec. Both numbers go into R9 (the caps) and R10 (the UI).

### 13.2 Values that "cannot stay undefined" (GK §C): proposal for the CTO
| Item | Proposal |
|---|---|
| Leaves and timelocks | K, L1, L2 (no timelock), and L3/L4 with `T_rec` CSV. **T_rec = 26 208 blocks (≈ 26 weeks)** and **Δ = 4 032 blocks (≈ 4 weeks)**, both counted from the **funding confirmation**. So everything (the trade, any dispute, and its decision and execution) must finish **within 22 weeks of funding** (R-7). The maximum dispute duration from opening to decision is **D_max = 8 weeks** (proposal), so a dispute must open by **funding + 14 weeks** (`latestDisputeOpenAt`, §13.6). All values stay within the 65 535-block CSV limit |
| k, n and the members | **SF: k = 3, n = 5.** Admission and removal are the **Governance Council's** (§12.1-§12.2); the members are named in the set version. **RS: m = 2, r = 3**, with entities disjoint from F |
| What the coordinator (the node) CANNOT do | sign; hold any key; choose the destination, amounts or fee (the members recompute them from committed data, G2); change a funded escrow; turn a timeout into a decision; present the RS with a decision that is not in the GV8 log |
| Key ceremony | Per member: its own entropy and hardware or equivalent; a signed ceremony log (pubkey, date, operator, and an attestation of no common host or custodian); the GK checks it before the set is published (G3/GV5) |
| Reshare vs a new pubkey | **No reshare** (native k-of-n has no aggregated key). Every member change = a **new set version with new pubkeys, for new escrows only** (G9(b), GV3). Existing escrows keep their committed keys until they are terminal |
| Who gets the funds after T_rec, and why the fiat payer is not harmed | **The beneficiary of the RL decision already issued** (R-1). The buyer who paid fiat and holds a ruling in their favour is protected: the seller alone cannot use any leaf, and R cannot pick a different winner. Without a ruling, nobody can use L3/L4 (the residual) |
| The exact message the federation signs | the **BIP341 script-path sighash** (`SIGHASH_DEFAULT`, the tapleaf hash of L1 or L2), **recomputed by each member** from the committed escrow data plus the RL decision of the current ADR-005 generation (G5). It is signed only if the outputs, amounts and fee match that decision and the committed limits |
| The federation unavailable | up to n−k = 2 members absent: normal operation. Below quorum: wait for the decision cutoff; then, after T_rec, R executes the issued decision (R-2) |
| Fees and the reserve | `fee-reserve-math` reserves for the **worst path** (L1/L2: k signatures + n keys + control block). The beneficiary pays. **A bump only by CPFP on the beneficiary's own output, never by changing the committed outputs** (G11) |
| Library and audit | chosen in the **Delivery B S0 spike**: it must pass the BIP340/341/342/327 vectors and nonce-reuse protection, and it must have an **independent audit** before any merge (G10). The MuSig2 library is still UNCERTAIN |
| Caps | R9 as a function of the collusion numbers: a per-escrow cap and an aggregate cap per set version, with the aggregate cap growing only with **verified independent k** (G6). The values are the CTO's |
| Commitment (E26) | gains `genVersion`, `federationSet {version, keys, k}`, `recoverySet {keys, m}`, `T_rec`, `Δ` and **`latestDisputeOpenAt`** (R-7). The parties verify the **output key** (the Taproot tweak of the merkle root) against a conformance vector before funding |

### 13.3 Traceability: G1-G15
| Criterion | Where it is met in Delivery A |
|---|---|
| G1 all paths + exhaustive test | §1 (K = MuSig2(B,S); L1-L4), plus the test {right and wrong party, k−1, k, n} × {before and after T_rec}, with F and R disjoint |
| G2 signer outside the node + independent verification | §3, §13.2 "coordinator cannot"; test T3 (an adversarial coordinator) |
| G3 the 6 proofs | §5, §12.3, ceremony (§13.2) |
| G4 five named quorums | decision (RL), signing (SF k-of-n), rotation preserving the pubkey (**not used**, declared), substitution (GC → a new set), recovery without quorum (RS m-of-r, executes only, R-1) |
| G5 sign only a valid decision | §13.2 "exact message" |
| G6 collusion bound + caps | §2, R-5, §13.2 caps |
| G7 no unilateral timelock; T ≫ dispute SLA; the fiat payer protected | §6, R-2 cutoff, §13.2 "who gets the funds" |
| G8 no new authority on recovery | R-1 (R executes, never decides) |
| G9 rotation residual | no reshare; new pubkeys for new escrows only |
| G10 scheme + libraries + vectors | §8, §13.2 library |
| G11 PSBT/fees/bump | §8, §13.2 fees |
| G12 Payjoin out | §8 |
| G13 threats + tests + mutants | §9 T1-T13 + T14 (R-3) |
| G14 coexistence with Gen-1 | §11 (a new provider and rail kind; `genVersion` in E26) |
| G15 R1-R15 per member | §5, §12.3 |

### 13.4 Traceability: GV1-GV10
| Criterion | Where |
|---|---|
| GV1 powers matrix; nobody both appoints AND signs, or both decides AND signs | §12.1, **plus a rule:** GC members can hold no SF or RS seat, and RL resolvers can hold no SF or RS seat (the GK checks the public role lists) |
| GV2 governance never moves funds | §12.2-§12.5; no governance key in any leaf; test: a new quorum cannot spend an old escrow |
| GV3 a new entity = a new pubkey, new escrows only | §12.7 |
| GV4 decision quorum ≠ signing quorum | §12.1, plus the GV1 rule above |
| GV5 an admission dossier per operator | §12.2 step 1 |
| GV6 removal; loss limit declared | n − k = 2 members may be lost without losing availability; < k compromised = no loss of funds; a test with n − 1 on signet |
| GV7 conflict checked BEFORE designation | §12.4 (resolvers recuse before the ruling; members abstain before signing) |
| GV8 append-only, signed, third-party verifiable | §12.4, R-2(c) |
| GV9 a policy change = a new version, never retroactive | §7, §12.1 |
| GV10 technical controls | G6, G7, G8, GV2 as tests (§9, §13.3) |

### 13.5 Declared residuals (for explicit CTO acceptance)
1. F and R both lost, **or** no ruling exists while F is lost: funds wait for K (§6, R-1).
2. **T14:** the winner loses their key: only the other party's path remains (R-3).
3. Collusion: k SF members + the losing party, or m RS members + one party after T_rec (R-5).
4. A corrupt resolver issuing a formally valid but wrong decision: the SF cannot detect it (§12.8).
5. The ≈ 455-day CSV ceiling on T_rec.

### 13.6 R-7 (material): the cutoff bounds the WHOLE life of the escrow, not only the dispute (GK)
- The CSV counts from **funding**, so T_rec − Δ is a deadline for the entire escrow.
- The gap: under C12/#740, PAYMENT_PENDING never expires and F0 allows a dispute "at any time". An escrow sitting 21 weeks in PAYMENT_PENDING that only then opens a dispute would reach the cutoff with no decision possible. It would fall into residual 1 with nobody at fault.
- **Control:**
  - a new committed deadline, **`latestDisputeOpenAt = funding + (T_rec − Δ − D_max)`**, which is funding + 14 weeks with the proposed values;
  - at that instant, if the escrow is not terminal and no dispute is open, the system **opens the dispute automatically**. This is a state transition only: it **does not move funds**;
  - the RL then decides within D_max, before the cutoff.
- **Interaction with #740:** under F0 a dispute stays openable at any time *before* `latestDisputeOpenAt`. After it, the dispute already exists. **This needs one line from the CTO** (it changes the "never expires" property of PAYMENT_PENDING for Gen-2 escrows only; Gen-1 is unchanged).
- **Test:** an escrow left idle in PAYMENT_PENDING opens its dispute by itself at `latestDisputeOpenAt`, is decided and executed before T_rec − Δ, and at no point can any single party spend.

### 13.7 G5 note: allowed sighash types (GK)
SF and RS members **refuse any signature request other than `SIGHASH_DEFAULT` / `SIGHASH_ALL`**, because ANYONECANPAY, NONE and SINGLE leave inputs or outputs open to change after signing. There is one negative test per sighash type.


---

## Revision 3 (CTO 28 conditioned approval of Delivery A): the four points

> Status: PROPOSAL text (joint opinion Principal + GK, co-signed), under the conditioned approval of Delivery A as a direction (CTO 28). Not homologated, not implemented. Delivery B is not authorized; public activation stays NO-GO. All values are references pending the CTO.


Status: Delivery A has **CONDITIONED APPROVAL** (CTO 28). Delivery B (economic) is **not** authorized. Nothing is implemented.

## Point 1: T7, the late federation spend vs recovery (CRITICAL)
**The fact:** Bitcoin script **cannot express "valid only BEFORE height H"**: CLTV and CSV only enforce *after*. There is also no signature or nonce expiry for BIP340 signatures. So **no cryptographic deadline is possible on L1/L2.** A federation-signed L1/L2 transaction, signed before the cutoff, stays valid forever and can be broadcast after T_rec, where it competes with an L3/L4 spend. **T7 is NOT eliminated by the operational cutoff.**

**The required wording (GK):** "**both spends are valid on-chain; safety comes from S1, S2 and S4; R collusion is a residual**". Never write "the cutoff prevents it". The cutoff is off-chain policy and never a guarantee (this also corrects the GK's earlier R-2).

**The security properties (GK S1-S4):**
- **S1:** an honest R signs only outputs **IDENTICAL** to those of the existing decision, so the race is benign: the same beneficiary.
- **S2:** a decision is **FINAL** once the SF's signature is complete (k). No generation g2 may follow, otherwise two different beneficiaries really conflict.
- **S3:** R's source is the GV8 log, which records the SF's signatures by digest, never the node's database.
- **S4:** an immediate broadcast, bumped with CPFP.

**The recommendation: make the race harmless by construction, and prove it.** Both spends execute the **same decision**, so whichever confirms, the economic outcome is identical. This rests on four invariants, each a test:
| # | Invariant | How it is enforced | Test |
|---|---|---|---|
| I1 | **At most one decision per escrow; it is FINAL once the SF's signature is complete (S2)** | Day 0 has no appeal (E26 `NONE_SCRIPT_FIXED`). The RL refuses to re-rule an escrow whose decision carries any SF signature in the GV8 log | T7-4: no g2 after a complete g1 (+ a mutant) |
| I2 | **The SF and the RS sign only outputs IDENTICAL to the decision's** (S1): the decision fixes the exact outputs. **Aligned with the GK's C3:** the protocol-fee output is byte-identical, and the only allowed variation is the **miner** fee, taken from the winner's output within the committed cap. CPFP is the preferred way to bump (S4) | Each member recomputes the outputs from the committed escrow data + the decision (G2/G5); any difference is refused | T7-2: R refuses different outputs (+ a mutant) |
| I3 | **L3/L4 can only pay the same winner as L1/L2**: L3 requires the buyer's signature and L4 the seller's. The RS executes the decision through the **winner's** leaf, so the winner co-signs both spends | The RS signs only the winner's leaf (G-b) | The RS signing the loser's leaf with a decision for the winner → refused |
| I4 | **One UTXO:** two spends cannot both confirm, so the funds cannot be paid twice | Bitcoin consensus | T7-1: the SF and R with the same outputs, in both orders ⇒ always the same beneficiary |

On top of the invariants:
- **Policy:** after the cutoff, the SF **produces no new signatures**, but signatures already given stay valid (I1/I2 make that harmless).
- **On-chain monitoring:** before signing, the RS checks the chain and the mempool for any L1/L2 spend of the outpoint. If one is seen, the RS does not sign, and the case is recorded.
- **The only remaining risk is not T7 but collusion** (residual 3): m RS members + the **loser** signing the loser's leaf after T_rec, against an honest late SF spend. That is bounded by m, R9 and the RS's independence. The timing does not change it.

**Rejected alternatives:**
- An absolute "upper bound" on L1/L2 is impossible in script.
- Pre-signed transactions with nLockTime do not help, because a lower nLockTime can always be signed again.
- Expiring the leaf by moving the funds before the cutoff would require an intermediate "kick-off" transaction (a covenant-like pattern), which adds complexity and fee risk. **Not for Day 0.**

**Regtest PoCs and tests (GK):**
- T7-1: same outputs, both orders.
- T7-2: R refuses different outputs (+ a mutant).
- **T7-3: collusion wins through the mempool/RBF.** This test DOCUMENTS the residual; it does not hide it.
- T7-4: no g2 after a complete g1 (+ a mutant).
- T7-5: R reads the GV8 log, not the node's database (+ a mutant).
- T7-6: the CSV boundary.
- T7-7: broadcast and alert.

**The conclusion to put before the CTO:** T7 is a race between two spends **of the same decision**, harmless under I1-I4. Those four are proven by tests. The risk that remains is the collusion bound (residual 3), not timing.

## Point 2: parameters and independence (the final recommendation)
**Federation (SF): 3-of-5.**
- It tolerates **2** unavailable members (availability), and stealing needs **3** colluding members + the losing party (collusion).
- 2-of-3 would tolerate only 1 absence and fall to 2 colluders. 4-of-7 is stronger but needs 7 independent entities, which is not realistic for Day 0.
- Recommendation: **3-of-5 for Day 0**, raised only by a new set version.

**Recovery (RS): 2-of-3**, disjoint from the SF. It tolerates 1 absence and needs 2 colluders + a party.

**The EFFECTIVE k (GK):** the number of members with **PROVEN** independence (G3/GV5). Without the dossier, the federation's k is **not** 3, and the caps of point 3 use the effective k only.

**Composition:**
- 5 SF entities and 3 RS entities, all **distinct legal entities**.
- **Sails at most 1 SF seat, 0 RS seats.**
- Recommended: ≥ 3 jurisdictions across the SF, and ≥ 2 across the RS. This depends on legal validation.
- **No common controller, beneficial owner, host provider account, administrator or key custodian** across the 8 entities.

**Substitution:** by a new set version only (new pubkeys, new escrows only), plus the tail obligation on funded escrows.

**Evidence of independence, per entity** (verifiable; the GK checks it before publication):
- a corporate registry extract with beneficial owners;
- a signed key-ceremony log (entropy source, hardware or equivalent, operator, date, pubkey);
- an infrastructure attestation (provider and account ids, admin roster) cross-checked against the other members for overlap;
- a conflict declaration;
- an R1-R5 and R15 dossier.

**Proven vs dependent on validation:**
- The scripts and quorum arithmetic are proven by tests (G1).
- The independence of the entities and the jurisdictions **depend on validation** (dossiers, legal).

## Point 3: R9 caps and individual acceptance of the residuals
**Caps (R9), functions of the collusion numbers:**
- **Per escrow:** `cap_escrow ≤ C₀`. Ramp: C₀ low in phase 1.
- **Per federation set version (aggregate locked):** `cap_set ≤ A₀ · g(k_eff)`, where `k_eff` = the number of **independently verified** members needed to collude (3 for the SF; 2 for the RS **after T_rec**). `g` grows only when k_eff grows through a new set version.
- **Aggregate across sets:** capped by the CTO.
- **Collusion rule (GK):** the cap per escrow stays **≤ the cost of corrupting k_eff entities**.
- **For each residual, the R9 matrix records** its trigger, control, effect on the cap, evidence and owner (below).
- **The values (C₀, A₀, g) are the CTO's** (the economics). Proposed ramp: phase 1 = 90 days at the lowest caps, then a raise only after an external audit, a clean quarterly reconciliation and no incidents.

**Individual acceptance matrix (§13.5):**
| # | Residual (trigger) | Can funds be locked indefinitely? | Collusion? | Control / mitigation | Recommendation to the CTO (the cap effect, evidence and owner are in the GK file) |
|---|---|---|---|---|---|
| 1 | SF + RS both lost, or no decision while the SF is lost | **Yes** (only K remains) | no | independence and disjointness (low joint probability), D_max SLA, pre-designated substitute, monitoring | **Accept with conditions:** the caps of point 3 + quarterly availability drills |
| 2 | T14, the winner loses their key | **Yes** for the winner's share (the other party's path remains) | no | mandatory key backup + a UI warning (R10); recovery-phrase check before funding | **Accept** (user custody, disclosed) |
| 3 | k SF + the loser, or m RS + a party after T_rec | no (theft, not a lock) | **yes** | k=3 / m=2 independent, R9 caps, GV8 log reconciliation, removal | **Accept, bounded by R9** |
| 4 | A valid but wrong decision | no | possible (resolver) | recusal, 2 resolvers above the cap, audit | **Accept with conditions:** the 2-resolver threshold value is set by the CTO |
| 5 | The CSV ceiling ≈ 455 days | no | no | T_rec = 26 weeks is far below it | **Accept** |

**Residuals 1 and 2 are the only paths to indefinitely locked funds.** Both need a joint failure (1) or a user's own key loss (2). Neither is triggered by a single operator.

## Point 4: governance and continuity
| Item | Recommendation | Status |
|---|---|---|
| Governance Council | 3 seats: 2 appointed by the Sails board + 1 independent (outside Sails management). Simple majority; 2/3 to remove. **No council member holds an SF, RS or RL seat** (GV1) | design; **depends on validation** (corporate) |
| Pre-designated substitute resolvers | ≥ 2 named substitutes **per set version**, committed at funding (E26), with recusal rules. A substitute takes over when the assigned resolver misses half of D_max | design, testable (an assignment test) |
| Automatic dispute opening (Gen-2 only) | at `latestDisputeOpenAt` = t0 + 14 weeks, a state transition with no fund movement; the Gen-1 and #740 F0 behaviour is unchanged | design, testable; needs a #740 compatibility test |
| Legal requirements per entity | a legal analysis per entity and jurisdiction (the custody characterisation of the signer and recovery roles; the dispute-resolution role; licensing), a **prerequisite of accreditation (GV5)**, done **before** admission. #121's "regulatory benchmark" stays open | **depends on legal validation** (none exists today) |
| Continuity | n−k tolerance, the tail obligation, availability drills, compromise response (§12.5) | design; drills **depend on validation** |

**Proven vs dependent on validation, in summary:**
- **Proven or provable by tests:** the scripts, the quorums, the cutoff and auto-open logic, invariants I1-I4, the refusals.
- **Dependent on validation:** entity independence, jurisdictions, legal analysis, council composition, the cap values.

---

## GK co-signature (2026-11-21), with 3 corrections
The GK co-signs this document as the JOINT opinion. It converges with the GK's adversarial test annex (S1-S4, T7-1..T7-7), to be published with Delivery B. Where the two differ, this document prevails, with the corrections below.

**C1. I1 is accepted, and it is STRONGER than the GK's S2.** Irrevocability on the FIRST member's signature, rather than on a complete set of k, is better: it closes the case where k−1 members sign g1 and later sign g2. It needs a second half on the Resolution Layer side, because of point 4 (the substitute resolver taking over at D_max/2):
- **I1-RL:** at most **one decision per escrow**: the FIRST one recorded in the GV8 log. Any later decision for the same escrow, from the original resolver arriving late or from a substitute, is refused by the RL and by every SF/RS member. A substitute may rule only if GV8 shows **no** decision for that escrow.
- Tests: (a) the original resolver and the substitute race to rule → exactly one decision is recorded, and the second is refused; (b) a mutant "accept a second decision" → red.
- Combined with I1-SF (irrevocable on the first signature), this removes the real two-beneficiary conflict (g1 × g2).

**C2. The RS's mempool and chain check is NOT a safety guarantee, and it does not need to be one.**
- The mempool is local and incomplete. A beneficiary can hold an already SF-signed tx offline and broadcast it later, and no check can see it.
- Safety comes from **I1 + I2 + I3** (one decision; outputs derived from it; the RS goes through the winner's leaf). With these, two valid spends pay the **same** winner, so the race is harmless whatever the RS sees.
- The check stays as **hygiene only** (it avoids a duplicate broadcast and wasted fees). The documents must describe it that way, never as protection.

**C3. I2 must be exact on the fee leg.**
- "The amounts differ only by the fee within the committed cap" applies to the **miner fee** (the bump) only. The **protocol-fee output** (destination and amount) is identical across all spends of the same decision.
- Each SF/RS member checks the beneficiary and the fee-leg outputs **byte for byte** against the decision. The only variance it accepts is the winner's output being reduced by the miner fee, up to the cap.
- Test: a spend with a fee leg altered by 1 sat is refused.

**The other points:**
- **Point 1:** agreed. The rejected options (an "upper bound" leaf, nLockTime, a kick-off tx) are rightly rejected. The residual of T7 is **collusion (residual 3), not timing**.
- **Point 2:** agreed, with one rule from the GK: **k_eff counts only members whose independence evidence the GK has checked**. A member whose evidence is pending counts as not independent.
- **Point 3:** agreed. The matrix is correct: only residuals 1 and 2 can lock funds indefinitely, and neither through a single operator.
- **Point 4:** agreed with C1 (the substitute rules only if there is no decision). The legal analysis per entity is a precondition of admission (GV5). The GK checks that it exists, not its legal merits.

Document changes go in the documentary PR that follows the #757 GO.

— GK
