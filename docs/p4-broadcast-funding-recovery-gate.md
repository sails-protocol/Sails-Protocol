# P4 — fail-closed broadcast/funding recovery gate

Scope: isolated branch only. This document is a **test plan**, not test evidence or deployment authorization.

## Safety invariants

1. A provider exception is **UNKNOWN**, not proof that no external side effect occurred.
2. Never retry a signed settlement broadcast until an authoritative chain/provider check has determined the outcome.
3. PASS 1 and rollback must serialize on the escrow E advisory lock. A status change between chain observation and evidence persistence requires manual review; no downstream completion effects.
4. A rollback must not overwrite an escrow with durable settlement evidence (txReleaseId).
5. For disputed escrows, all paths acquiring D and E must acquire D before E.
6. Funding UNKNOWN is **not** automatically recovered by terminal settlement PASS 1/2. A distinct funding reconciliation or documented manual recovery procedure is required.

## Mandatory real PostgreSQL tests — not yet executed

- **RACE-A (rollback first):** hold E in one transaction; queue rollback, then PASS 1; release E; assert PASS 1 detects changed status, records manual review, and does not persist txReleaseId or downstream effects.
- **RACE-B (PASS 1 first):** hold E; queue PASS 1, then rollback; release E; assert durable txReleaseId is write-once and rollback affects zero rows.
- **UNKNOWN-BROADCAST:** provider accepts broadcast but loses response; assert no rollback and no automatic second submission. Restart reconciler and verify exact transaction identity and one completion projection.
- **DEFINITIVE-REJECT:** a typed provider rejection known to precede external effects needs an explicit contract before a retry can be enabled. Until then, remain fail-closed.
- **UNKNOWN-FUNDING:** provider accepts funding then response is lost; assert FUNDS_LOCKED claim is retained and repeat lockFunds cannot invoke provider again. Verify a *separate* authoritative recovery route before calling this GREEN.
- **POST-PROVIDER-FAIL:** provider returns success, local DB/event write fails; assert no rollback and recovery remains possible.
- **LOCK-ORDER:** prove D -> E in disputed paths; test no E -> D inversion.
- **FAIL-CLOSED-HARNESS:** tests must refuse unauthorized/unreachable databases; never target production.

## Evidence required for GREEN

Record the exact HEAD SHA, commands, DB image/version, isolated DB identity (redacted), deterministic interleavings, assertions, failing RED baseline, passing GREEN run, TypeScript compilation, CI workflow links, and all unresolved findings. A green mock-only unit suite is not sufficient.

## Explicit open risks

- No confirmed automated recovery for funding UNKNOWN.
- No typed distinction between definitive rejection and ambiguous provider failure.
- MULTISIG recovery can broadcast NEWLY_BROADCAST when its chain/outpoint checks permit it; this must be exercised under competing workers.
- Changes to rollback error propagation may affect callers; audit all usages.
- Current patch is unmerged and not approved for deployment.

Production gate: **NO-GO** until independent review and explicit approval.
