# Merge Autonomy Policy (Despacho 058)

Status: **PROPOSED** until the Adoption checklist (§9) is complete. Until then, Despacho 057, every earlier HOLD and `docs/governance/SOLO_MAINTAINER_TRANSITION_PROPOSAL.md` stay binding.

Origin: CTO 28 orders of 2026-11-21 (risk tiers; complement; decisions registered in issue #147, comment 7063780839). This policy does not change any invariant, any branch protection, or any security gate. It only says **who may authorize a merge, by risk**.

> The CTO governs architecture and critical risk. The Principal and the Gatekeeper (GK) guarantee quality and security. The EPM guarantees that development moves forward.

## 1. Tiers

Classification uses the **real effect** of the change, not the PR title or size.

| Tier | Real effect of the change | Who authorizes the merge |
|---|---|---|
| 1 | Documentation that does not change an invariant; isolated UI; tests with no change to production behavior | EPM |
| 2 | Isolated feature, SDK, non-critical API, CI/lane infrastructure with no security effect | EPM, after the applicable technical approvals of the Principal and the GK |
| 3 | Escrow, funds, signatures, authorization, economic concurrency, critical migrations, security controls | CTO + GK |
| 4 | Economic activation, production deploy, protocol change, fundamental invariant | CTO with formal GK homologation |

Authorization, funds, escrow, migrations, protocol invariants and security controls are never Tier 1 or 2.

## 2. Who classifies
1. The EPM proposes the Tier in the PR description.
2. The GK confirms or raises it. A Tier can be lowered only with a written reason on the PR.
3. Any disagreement, or any doubt, goes to the CTO (**fail closed**). Never reclassify a PR to speed it up.

## 3. Gates required for every merge (any Tier)
- Branch protection stays on: required checks `build`, `test`, `Analyze (javascript-typescript)`, branch up to date (`strict`), admins included. Nobody bypasses it.
- CI 4/4 green on the exact head SHA; the head and base are the ones reviewed.
- Every PR comment, review and inline comment read before merge.
- The diff matches the authorized scope; no conflicts.
- One merge at a time; `main` CI green before the next merge.
- Each merge is recorded (SHA, Tier, evidence) in the EPM append-only record and on the PR.
- Tier 2 PRs that touch `.github/workflows`, scripts or `package.json`: the diff of those files is reviewed explicitly and named in the approval.
- Tier 3 and 4: an express CTO despacho for the exact head. It is transferred to a new head only if the original despacho foresaw it.

## 4. A new head is not a new scope
A branch update is **mechanical** when the base moved only by changes that do not touch the PR files. The approval for the previous head stays valid when all hold:
- the tree of the new head equals the predicted merge tree, and its parents are the old head and the current `main`;
- the diff against the new `main` equals the reviewed diff;
- the GK confirms there is no relevant semantic change;
- CI is 4/4 green again on the new head;
- comments were read.

Any other head change voids the approval and returns the PR to review. This never waives checks, GitHub protections or the review of a material change. A decision is made once and reused while its assumptions hold.

## 5. Architecture decisions and their merge
An approved architectural decision does not need a second personal approval for its documentary merge, when the scope stays identical and the gates above are met. The decision and the execution of the merge are separate authorizations.

## 6. Merge is not activation
Merging to `main` never authorizes a persistent migration, a deploy, a production release or an economic activation (Tier 4). Those keep their own authorizations.

## 7. Mandatory stop
The EPM stops and escalates on: divergence between Principal and GK, new risk, doubt about the Tier, red CI, an unread comment, an unexpected head or base, a change of scope, or any economic, custody or critical-security question. Escalation states options, recommendation, risks and cost of not deciding.

## 8. Reporting
The CTO receives consolidated executive reports (proven progress, real blockers, risks, pending decisions in the CTO's competence) instead of one authorization request per PR in Tier 1 and 2. Proven progress is always kept apart from formal homologation (Day 0 criteria are homologated only by the CTO).

## 9. Adoption checklist (the delegation is NOT active before all items are done)
- [ ] Policy merged in this repository through the normal PR flow, with GK review and Principal technical review.
- [ ] Owner's written approval that the owner-reserved, SHA-specific merge authorization of the solo-maintainer procedure is delegated to the EPM for Tier 1 and 2 under this policy.
- [ ] GitHub controls read back and compatible (see §10), with before/after evidence.
- [ ] PR template updated with the Tier fields.
- [ ] EPM procedure and checklist updated.
- [ ] Entry into force announced by the CTO, with the HOLDs and earlier despachos reconciled expressly.

## 10. GitHub controls (read back 2026-11-21)
- `main` protection: required checks `Analyze (javascript-typescript)`, `build`, `test`; `strict` true; `enforce_admins` true; force pushes and deletions blocked; required approving reviews 0 (the temporary solo-maintainer exception, unchanged); no rulesets.
- Consequence: GitHub does not enforce independent review in this repository today. Independent review is enforced by procedure: the GK verdict on the exact head and, for Tier 3 and 4, the CTO despacho. This policy neither lowers nor raises that protection. Raising it (for example requiring a second approving human) needs administrative authorization and is a CTO decision.
- `CODEOWNERS` routes review only; it is not authority.

## 11. Relation to existing documents
- `docs/ENGINEERING_GOVERNANCE.md` §4 (consequence classes) classifies *how* to build by consequence; this policy classifies *who may merge*. The two do not conflict: Financial-authority work is Tier 3 or 4.
- §7 and the solo-maintainer transition: this policy only adds the delegation in §9 once the owner approves it; until then the owner's SHA-specific authorization stays reserved.
