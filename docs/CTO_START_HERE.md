# CTO START HERE — Sails Protocol Current-Truth Entry Point

> **Snapshot:** 2026-10-24. **Status:** documentation PR #531 (DRAFT), not merged. This entrypoint is a navigation and contradiction-prevention protocol, **not** a new economic/architectural authority or production approval. Always recheck live issue/PR/CI states when taking over.

## Read in this order

1. [BACKLOG.md](BACKLOG.md): institutional technical backlog and history; its early phase table contains explicitly superseded snapshots. Read corrections, not just the first DONE.
2. [MASTER_CLOSURE_REALITY_LEDGER.md](MASTER_CLOSURE_REALITY_LEDGER.md): active audit index, 53 search-matched Day-0 issues, 56 mechanically extracted historical table candidates, draft PR topology, CTO checklist and contradictions. **These are overlapping candidate populations, not an additive denominator.**
3. [ADR-001 Day-0 multi-operator network](adr/ADR-001-day0-multi-operator-network.md), then GitHub [#105](https://github.com/sails-protocol/Sails-Protocol/issues/105) for the network completion gate.
4. GitHub [#221](https://github.com/sails-protocol/Sails-Protocol/issues/221) and [#99](https://github.com/sails-protocol/Sails-Protocol/issues/99) for operating memory, sequencing and Claude/CTO roles.
5. GitHub [#165](https://github.com/sails-protocol/Sails-Protocol/issues/165) for Beta integration reality, [#125](https://github.com/sails-protocol/Sails-Protocol/issues/125) for cross-surface docs alignment, [#293](https://github.com/sails-protocol/Sails-Protocol/issues/293) for P2P lifecycle, [#500](https://github.com/sails-protocol/Sails-Protocol/issues/500) for continuing gap discovery.
6. Read live PR status and exact-SHA CI before acting. P4 #525 and P3 #519 were draft on 2026-10-24; never assume their state remains unchanged.

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
