# Temporary Solo-Maintainer Governance — Proposed Transition (2026-11-07)

> **Status: OWNER APPROVED / PENDING PROTECTION RECONCILIATION — NOT YET OPERATIVE FOR MERGES.** This document is a proposed, time-bounded exception to the current engineering merge-review model. It does not supersede `docs/ENGINEERING_GOVERNANCE.md` §7 or `docs/GITHUB_PROJECT.md` §8/§8.1 until explicitly adopted and the repository protection rules are reconciled. No merge, deployment, or Day 0 claim is authorized by this proposal.

## Context and scope

The repository owner, `alan-schramm`, reports being the only active human developer/maintainer for now; `renipinto` has left the project and the owner reports removing his repository access. A future human developer may join, at which point the independent human review requirement must be reassessed. The reviewer request for `renipinto` on PR #585 has been withdrawn.

The documented current baseline is **one human approval required**, stale approvals dismissed, strict status checks, and `enforce_admins: true` (see `docs/GITHUB_PROJECT.md` §8.1). Live protection settings have **not** been verified by this proposal; a previous integration read returned 403. Do not treat this document as proof that any branch rule has changed.

## Proposed temporary process

1. **Author/implementer:** the sole human maintainer may implement directly or direct Claude Principal; all work stays in normal branches and PRs.
2. **Independent technical gate:** a separate Gatekeeper session reviews consequential changes against exact-head code, tests, and protocol/economic invariants. Record GO / conditional GO / NO-GO with reproducible evidence. Same model-family sessions are operationally separate, not equivalent to an independent human review.
3. **CTO gate:** explicitly reconcile Gatekeeper verdict, exact head SHA, CI, residual risks, governing issues and STOP gates. CI green alone is never permission.
4. **Human decision:** `alan-schramm` personally accepts the risk and authorizes each merge, with an auditable written decision tied to the exact SHA. AI agents cannot approve or authorize a merge in his place.
5. **Repository protection:** before using this process for a merge, the owner must explicitly approve the policy exception and reconcile actual GitHub branch/ruleset settings through an authorized interface. The owner has explicitly approved the temporary policy, but the currently documented human-approval requirement must **not** be bypassed silently. A settings change, if needed, requires an authorized GitHub operator, exact before/after readback, and retention of required checks and anti-force-push protections. If protections still require another eligible approving reviewer, STOP; do not force or bypass.
6. **Critical financial/security changes:** preserve fail-closed review, adversarial tests, signing/settlement authority checks, issue-specific NO-GO gates, and any existing RFC requirements. A Gatekeeper GO does not make WDK production eligible, close #254/#341, or authorize Day 0/deployment.
7. **Sunset:** this exception is temporary and must be reconsidered upon onboarding a second active human developer, or earlier if a material incident reveals a review blind spot. Restore independent human review where feasible.

## Live protection verification (pending)

The available GitHub connector exposes PR and file actions but no branch-protection/ruleset read or update operation; an earlier direct integration query returned HTTP 403. **Do not infer live settings from the dated historical configuration.** An authorized repository administrator must inspect GitHub Settings → Branches and Settings → Rules → Rulesets, identify every effective rule applying to `main`, and record the required approval count, code-owner requirement, admin enforcement, status checks, strictness, and bypass permissions before and after any separately authorized change. The owner approval of the temporary policy is **not** an authorization to silently bypass a still-active rule.

## PR #585 applicability

Gatekeeper reported GO on two targeted P1 corrections at `17a70d56c10efc701b618bac894112f6fa767e80`; this is **technical evidence only**. PR #585 remains separate and must not be merged until the temporary policy is adopted, effective protection rules are verified, checks and exact HEAD revalidated, and the owner makes a specific final decision.

## Adoption checklist (all currently pending)

- [x] Owner explicitly approves this exception and its loss of second-human review (chat authorization, 2026-11-07).
- [x] Existing governance documents updated in this Draft PR #589, preserving their historical record; not yet merged into `main`.
- [ ] Current GitHub branch protection/rulesets are read back and any proposed changes explicitly authorized and verified.
- [ ] No unresolved required review/check or other STOP gate remains for the target PR.
- [ ] Owner records a SHA-specific merge authorization.

**This proposal is not an authorization to weaken protections, merge, deploy, or change Project #3.**
