# Temporary Solo-Maintainer Governance — Proposed Transition (2026-11-07)

> **Status (reconciled 2026-11-08): OWNER APPROVED · MERGED INTO `main` BY PR #589 (`da3a254421197f479e1b9751e824a437a0539cdb`) · LIVE PROTECTION READ BACK.** This is a time-bounded exception to the engineering merge-review model. It applies only through the per-merge procedure below. It authorizes no merge, deployment, or Day 0 claim by itself.
>
> *Reconciliation note, 2026-11-08:* the status above replaces the original 2026-11-07 status, `OWNER APPROVED / PENDING PROTECTION RECONCILIATION — NOT YET OPERATIVE FOR MERGES`. Two facts closed the pending protection reconciliation:
> - PR #589 was merged into `main`.
> - Live branch protection was read back (§ "Live protection verification").
>
> No protection setting was changed by this reconciliation.

## Context and scope

The repository owner, `alan-schramm`, reports being the only active human developer/maintainer for now; `renipinto` has left the project and the owner reports removing his repository access. A future human developer may join, at which point the independent human review requirement must be reassessed. The reviewer request for `renipinto` on PR #585 has been withdrawn.

When this proposal was written (2026-11-07), the documented baseline was **one human approval required**, stale approvals dismissed, strict status checks, and `enforce_admins: true` (see `docs/GITHUB_PROJECT.md` §8.1). Live protection had not been verified; a previous integration read returned 403. That baseline is now **historical**. The live read-back of 2026-11-08 shows **zero** required approvals (see below and `docs/GITHUB_PROJECT.md` §8.2).

## Proposed temporary process

1. **Author/implementer:** the sole human maintainer may implement directly or direct Claude Principal; all work stays in normal branches and PRs.
2. **Independent technical gate:** a separate Gatekeeper session reviews consequential changes against exact-head code, tests, and protocol/economic invariants. Record GO / conditional GO / NO-GO with reproducible evidence. Same model-family sessions are operationally separate, not equivalent to an independent human review.
3. **CTO gate:** explicitly reconcile Gatekeeper verdict, exact head SHA, CI, residual risks, governing issues and STOP gates. CI green alone is never permission.
4. **Human decision:** `alan-schramm` personally accepts the risk and authorizes each merge, with an auditable written decision tied to the exact SHA. AI agents cannot approve or authorize a merge in his place.
5. **Repository protection:** before using this process for a merge, the owner must explicitly approve the policy exception and reconcile actual GitHub branch/ruleset settings through an authorized interface. The owner has explicitly approved the temporary policy, but the currently documented human-approval requirement must **not** be bypassed silently. A settings change, if needed, requires an authorized GitHub operator, exact before/after readback, and retention of required checks and anti-force-push protections. If protections still require another eligible approving reviewer, STOP; do not force or bypass.
6. **Critical financial/security changes:** preserve fail-closed review, adversarial tests, signing/settlement authority checks, issue-specific NO-GO gates, and any existing RFC requirements. A Gatekeeper GO does not make WDK production eligible, close #254/#341, or authorize Day 0/deployment.
7. **Sunset:** this exception is temporary and must be reconsidered upon onboarding a second active human developer, or earlier if a material incident reveals a review blind spot. Restore independent human review where feasible.

## Live protection verification (read back 2026-11-08)

*Original text, kept as the record of the 2026-11-07 state:* the available GitHub connector exposed PR and file actions but no branch-protection or ruleset read; an earlier direct integration query returned HTTP 403. An authorized repository administrator was to record every effective rule on `main`.

**Read back 2026-11-08T03:01Z** with the owner's (`alan-schramm`, org admin) authenticated GitHub CLI, using `GET repos/sails-protocol/Sails-Protocol/branches/main/protection` and `GET repos/sails-protocol/Sails-Protocol/rules/branches/main`. These were read-only requests.

| Setting | Live value |
|---|---|
| Required status checks | `build`, `test`, `Analyze (javascript-typescript)` |
| Branch must be up to date (`strict`) | `true` |
| `enforce_admins` (rules apply to admins too) | `true` |
| `required_approving_review_count` | **`0`** |
| `dismiss_stale_reviews` | `true` |
| `require_code_owner_reviews` / `require_last_push_approval` | `false` / `false` |
| Force pushes / deletions on `main` | blocked / blocked |
| Signed commits / linear history / conversation resolution / branch lock | not required |
| Push restrictions / review bypass allowances | none |
| Rules applying to `main` from repository or organization rulesets | none (`[]`) |

**The change from one required approval to zero:**
- It is an observed fact.
- Its date and author are **not** established. Neither the repository documents nor the read-only API calls above record them, and the organization audit log could not be read (HTTP 404 for this account).
- No document authorizes reducing any *other* protection. Required checks, `strict`, `enforce_admins`, and the force-push and deletion blocks all remain active.
- With zero approvals required, the procedure above needs no bypass. A STOP under step 5 would apply only if a rule again required an eligible reviewer who is not available.

## PR #585 applicability

*Corrected 2026-11-08.* The original sentence said the "Gatekeeper reported GO on two targeted P1 corrections at `17a70d56c10efc701b618bac894112f6fa767e80`".
- **What was verified:** the CTO states that it **received** a report of an independent Gatekeeper GO for that SHA ([CTO verdict, comment 6716352771](https://github.com/sails-protocol/Sails-Protocol/pull/585#issuecomment-6716352771)).
- **What is missing:** no Gatekeeper comment, review, or commit status for `17a70d56` exists on PR #585 or anywhere else on GitHub. The last Gatekeeper record on the PR is the D7–D13 consolidation for `8efc63b0`.
- **Until it is attached:** the GO is CTO-relayed, not GitHub-verifiable, and must not be cited as a recorded Gatekeeper approval.

The current head of PR #585, `2f20fd4fc040b36a2cf3bf6a1e1a684316431a67`, is `17a70d56` merged with `main` at `da3a2544` (this PR's governance docs only). Its `src`, `tests`, `prisma` and `.github` trees, its `package.json` and its `package-lock.json` are byte-identical to `17a70d56` ([evidence, comment 6716331974](https://github.com/sails-protocol/Sails-Protocol/pull/585#issuecomment-6716331974)).

PR #585 must not be merged until three conditions hold:
- the Gatekeeper's verdict is attached to `17a70d56` and linked to the current head;
- checks are green on that exact head;
- the owner records a SHA-specific decision.

**Known CI risk:** the `eventProjectionClaims` "5 CONCURRENT recovery workers" timeout failed the first `build` attempt on `2f20fd4f` and passed on rerun. Its root cause is unresolved, and a green rerun does not prove a flake.

## Adoption checklist

- [x] Owner explicitly approves this exception and its loss of second-human review (chat authorization, 2026-11-07).
- [x] Existing governance documents updated in PR #589, preserving their historical record; merged into `main` as `da3a2544`.
- [x] Current GitHub branch protection/rulesets read back (2026-11-08, table above). No protection change was proposed or made. The earlier 1→0 approval change is recorded as observed, with author and date unknown.
- [ ] No unresolved required review/check or other STOP gate remains for the target PR. For PR #585, the Gatekeeper record for `17a70d56` is still missing on GitHub.
- [ ] Owner records a SHA-specific merge authorization.

**This proposal is not an authorization to weaken protections, merge, deploy, or change Project #3.**
