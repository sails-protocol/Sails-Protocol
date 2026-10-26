# CTO START HERE — Sails Protocol Current-Truth Entry Point

> **Snapshot:** 2026-10-24. **Status:** documentation PR #531 (DRAFT), not merged. This entrypoint is a navigation and contradiction-prevention protocol, **not** a new economic/architectural authority or production approval. Always recheck live issue/PR/CI states when taking over.

## Mission and exit criterion — continuity, not endless backlog certification (2026-10-25)

**Why this consolidation exists:** architectural/product conversations created new GitHub issues and decisions faster than incoming CTO sessions could read them. The deliverable is a **usable institutional handoff**: a successor must know what is being implemented, what was only discussed, where the current authority and issue owner live, and what to do next. It is **not** a requirement to prove that every technical backlog item is complete before a CTO can take over.

**Success for this documentation mission (bounded):** (1) this entrypoint provides an ordered reading path; (2) the ledger points to canonical issue/ADR/RFC owners and clearly separates historical claims, draft work and accepted evidence; (3) historical Master candidate registers are navigable without treating each candidate as an independent obligation; (4) an incoming CTO can continue with current issue/PR/CI verification, and unresolved technical gates remain explicitly OPEN; (5) an independent reviewer accepts this as a **truthful, bounded continuity map**. This fifth condition is the only outstanding **independent handoff acceptance**, not an obligation to close every Day-0 or Beta technical gate.

**Verified correction:** the ledger's 53-entry Day-0 lexical index now has numeric issue IDs restored; the earlier `#undefined` observation was historical and **must not** be repeated as a current blocker. This index remains lexical, not a release denominator. The ledger's 40 BP, 54 BL, 156 BB and 54 MO source records are overlapping navigation populations, **not** a sum of unique obligations or a completion percentage.

**Operational handoff for the next CTO:** read this page, check the current GitHub issue/PR owners and latest comments, consult the relevant ledger/register only for the active mission, verify the exact current SHA and CI, then advance the canonical issue. Do **not** reread the entire historical backlog or append speculative crosswalk rows before doing engineering work. Open technical work remains owned by its own gates; a GREEN continuity handoff would **not** mean Day-0, Beta or production GREEN.

**Current acceptance:** 7/8 continuity controls documented; the final independent review is still pending. The PR remains draft until an authorized review decision. Do not confuse the historical 6/10 and 8/12 authoring snapshots below with the operative handoff score.

## Sails Projects #3 — operational workboard (2026-10-25)

**Start here for active work:** [Sails GitHub Projects #3](https://github.com/users/alan-schramm/projects/3). This is the existing operational board, not a replacement for canonical GitHub issues, PRs, ADRs, or this institutional entrypoint. Before acting, check the board **and** the live issue/PR/CI state; the board may lag behind the repository.

**Organize by workstream, without duplicating issues:**

- **Master Backlog — closure:** obligations already in the canonical Master Backlog and their actual implementation/acceptance status. Reference [BACKLOG.md](BACKLOG.md) and the relevant issue/PR. Do not mark a backlog item complete based only on a document or green CI.
- **Post-Master / Day 0 — release readiness:** integration, security, multi-operator, recovery, distributed testing, Gatekeeper decisions and launch prerequisites that emerged during/after Master closure. Keep technical acceptance separate from documentation and CI. Canonical starting points include [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105) and [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165).
- **Roadmap / discovery:** product concepts, future integrations and enhancements that have not been approved as Day-0 requirements. Discovery is not an implementation commitment or release blocker unless formally promoted through its canonical issue/decision.

**Board design recommendation:** retain existing Project items and current workflow until its actual fields/views are inspected. Prefer one shared Kanban **Status** (e.g., Backlog, Ready, In progress, Blocked / awaiting CI or Gatekeeper, Done), plus a **Workstream** field (Master, Post-Master / Day 0, Roadmap) and filtered views. If the current board already has equivalent fields or views, reuse them. Avoid a separate board per stream, duplicate cards, bulk status changes, and mass importing historical source registers. Do not claim these suggested fields/views have been configured until verified directly in Projects.

**CTO handoff workflow:** open Projects #3 → select the active workstream and item → read the linked canonical issue/PR, latest decision and exact-SHA CI → execute and record progress in that issue/PR → update the Project status if access is available. This document remains the memory index; Projects is the live operational overview.

## Read in this order

1. [BACKLOG.md](BACKLOG.md): institutional technical backlog and history; its early phase table contains explicitly superseded snapshots. Read corrections, not just the first DONE.
2. [MASTER_CLOSURE_REALITY_LEDGER.md](MASTER_CLOSURE_REALITY_LEDGER.md): active audit index, 53 search-matched Day-0 issues, 56 mechanically extracted historical table candidates, draft PR topology, CTO checklist and contradictions. **These are overlapping candidate populations, not an additive denominator.**
3. [ADR-001 Day-0 multi-operator network](adr/ADR-001-day0-multi-operator-network.md), then GitHub [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105) for the network completion gate.
4. GitHub [#221](https://github.com/sails-protocol/Sails-Protocol/issues/221) and [#99](https://github.com/sails-protocol/Sails-Protocol/issues/99) for operating memory, sequencing and Claude/CTO roles.
5. GitHub [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165) for Beta integration reality, [#125](https://github.com/sails-protocol/Sails-Protocol/issues/125) for cross-surface docs alignment, [#293](https://github.com/sails-protocol/Sails-Protocol/issues/293) for P2P lifecycle, [#500](https://github.com/sails-protocol/Sails-Protocol/issues/500) for continuing gap discovery.
6. Read live PR status and exact-SHA CI before acting. P4 #525 and P3 #519 were draft on 2026-10-24; never assume their state remains unchanged.

## Active engineering PR topology — self-host images (P3) and settlement (P4), snapshot 2026-10-26

All are **draft**; none is merged, deployed or accepted. Verify live before acting. Detail lives in the PRs and in `docs/security/` (P3) / `docs/p4-gate3-unknown-outcome-contract.md` (P4); this block is only the map.

| PR | Head | What it is | Depends on |
|---|---|---|---|
| #519 → #521 | `d82d805b` → `b6f79bcd` | P3 self-host kit; advisory fixes | main |
| #530 | `5ef5e22d` | P3-R2: npm/corepack removed from final images | #521 |
| #529 | `7763c3f8` | P3-R3: Trivy gate (observe), migration controls, ADR-006 | #521 |
| #532 | `2ac896a2` | P3-R4: Trivy triage (18 distinct CVEs), image alternatives, backup/key report | #529 |
| #533 | `2e8ab2a3` | P3-R2.1: distroless experiment (not production) | #530 |
| #534 | `3c0dda08` | backup integrity, atomic restore, evidence verify/rotate, `migrate` hardening (G1–G6) | #529 |
| #536 | `d156ad07` | integration of #530/#533/#529/#534 + distroless **candidate** behind `SAILS_IMAGE_FLAVOR` | those |
| #525 | `22c4f6eb` | P4 Gate 3 (iii-a) guard; **its SHA is the evidence reference, do not move it** | #523 |
| #535 | `51c09f34` | PASS 3 claim race fix (pre-existing flake, not caused by #525) | #523 |
| #537 | `8fb437d3` | review kits: P4 census / reversed run, Redis Gate 2 probes | main |

**Integration (simulated, nothing merged):** `#516`, `#518`, `#492` are redundant or superseded by #521/#529; #529, #530, #532, #533 conflict pairwise **only in `CHANGELOG.md`**; #531 merges cleanly with all. Re-run `node scripts/verify-pr-chain.js` (in #529) right before any merge.

**Gates that stay open:** P3/self-host: images have 1 CRITICAL + 17 HIGH in the Debian build (no exception exists, Trivy gate is observe); distroless candidate has 0 CRITICAL/HIGH but is a different runtime contract (uid 65532, no shell) awaiting a CTO decision; signing-identity recovery NOT VERIFIED; no VPS run; no cosign. P4: SPLIT scope and the operating window (`DISPUTED_RECREATION_SETTLE_WINDOW_MS`, unset = fail closed) are open decisions; the guard is not activated. **Redis Gate 2: NO-GO**: ACK authenticity, instance identity and fencing are undecided (probes in #537).

## Do not collapse different clocks

- **Architectural freeze** is not implementation acceptance.
- **Historical DONE** is not current production eligibility.
- **Open issue** is not proof the code is missing; **closed issue** is not proof a newer gate is satisfied.
- **PR CI green** is not independent review, merge, database migration or production approval.
- **Executor report** is not an institutional decision; an accepted ADR/RFC cannot be overridden by a newer chat.
- **Sails Market-hosted fleet** is not evidence of independent third-party node operation.
- **Post-Master Beta work (#420)** is not automatically a blocker for the current bounded Master closure mission; it does block later Beta gates according to its scope.
- **Continuous audit #500** is not a finite 100%-complete task.

## Stage boundaries

**Current:** implementation, correction, Day-0 hardening and bounded audit evidence. **Master closure percentage:** NOT MEASURED; neither the 53 issue index nor 56 historical rows are a valid denominator. **Beta/production:** NO-GO until separately evidenced and authorized. See the closure ledger for all residuals and source pointers.

## CTO decision log template

For every consequential finding record: `timestamp | source A + date | source B + date | normative owner | current code SHA | test/evidence | status | decision/authority | next owner`.

Statuses: `OPEN / IMPLEMENTING / EVIDENCE PENDING / ACCEPTED / BLOCKED / DEFERRED WITH OWNER`. Preserve history and never quietly overwrite. A decision is provisional until the designated gate owner has independently reviewed it.

## Continuation protocol

Read → compare current truth → issue bounded Claude mission → reproduce/review independently → document exact SHA/limits → CTO gate → freeze/merge only when explicitly approved → update canonical issue and ledger → next mission. No shared DB migration, deploy, production or protocol-semantic change by implication.

**Documentation scope acceptance:** this file can be approved independently from the entire Master backlog and from Beta/production gates. Merging PR #531 requires separate CTO review.

> **Current metric hierarchy (independent review 2026-10-25):** The controlling handoff metric is the **7/8 scorecard (87.5%)** in the ledger, pending check 8. The 6/10 and 8/12 metrics below are retained solely as dated authoring-history snapshots, not competing current scores. Neither the handoff score nor authoring-history scores measure Master technical completion, Beta readiness or production clearance.

## Measured closure of this documentation reconciliation (2026-10-24) — historical authoring snapshot

**Baseline:** 6 of 10 acceptance checklist items are documented (60% of this *bounded checklist*, not 60% of Master Backlog or independently approved institutional truth). The ten items and their individual [x]/[ ] states are in [MASTER_CLOSURE_REALITY_LEDGER.md](MASTER_CLOSURE_REALITY_LEDGER.md), section E. This percentage is an **authoring progress indicator only**: checked means recorded, not independently accepted.

**Remaining 4 of 10:** (7) extract/deduplicate all normative prose obligations; (8) cross-check issue comments, PR diffs, code and independent evidence for each obligation; (9) independently reconcile public/developer docs under #125; (10) obtain CTO review and merge #531 to main. These are not equally sized work items; no ETA is supported. No other CTO should convert this into a time-to-completion estimate.

**Suggested gate:** remain YELLOW until 7–9 have inspectable evidence and a reviewer signs off; move to GREEN for *institutional continuity documentation only* after 10 is approved and the merged main content is verified. Production, Beta, P3/P4 and Day-0 retain their own independent gates.

## Continuity reconciliation progress — 2026-10-25 — superseded authoring checklist

**Bounded documentation-control checklist (not Master completion):**

| Control | State | Evidence |
| --- | --- | --- |
| 1. Single entrypoint for new CTOs | DONE IN DRAFT | This file |
| 2. Historical BACKLOG phase-table warning | DONE IN DRAFT | BACKLOG.md link to ledger |
| 3. Source/authority hierarchy and contradiction rule | DONE IN DRAFT | MASTER_CLOSURE_REALITY_LEDGER.md |
| 4. Open Day-0 lexical issue candidate index | DONE IN DRAFT | 53 candidates; NOT normative denominator |
| 5. Historical Master table candidate inventory | DONE IN DRAFT | 56 rows; NOT normative denominator |
| 6. Live P3/P4 PR snapshot | DONE IN DRAFT | Exact branch/base/HEAD at last check |
| 7. Economic/security issue state check | DONE IN DRAFT | 29/29 fetched OPEN; 0/29 independently accepted |
| 8. Review/tool authority correction | DONE IN DRAFT | #221 later comments |
| 9. Full prose-obligation extraction/deduplication | OPEN | Historical Master spans thousands of lines |
| 10. Per-obligation code/comment/PR/CI/acceptance reconciliation | OPEN | Not demonstrated |
| 11. Cross-surface docs gate | OPEN | #125, GitBook/Mintlify not accepted |
| 12. CTO review + main merge | OPEN | #531 draft; explicit approval required |

**Bounded progress: 8/12 controls recorded in draft = 66.7% of this 12-control checklist, NOT 66.7% of the Master and NOT 66.7% of release readiness.** 'Done in draft' means documentation exists in PR #531, not that main or a reviewer accepted it. The prior informal 75% estimate is superseded by this measurable denominator.

**Immediate next action:** complete 9 and 10 with explicit conflict ledger and evidence; then obtain #125 cross-surface review and CTO authorization for #531 merge. No production gate changes follow automatically.
