<!--
Consequence-weighted — see docs/ENGINEERING_GOVERNANCE.md §4/§9.
Fill in every section for Protocol-sensitive / Financial-authority work.
For a reversible UI/product change, docs typo, or internal refactor with
no semantic impact, write "N/A" on the sections that don't apply — don't
leave them blank without saying why.
-->

## Problem

<!-- What was wrong or missing? Link the Issue. -->

## Property gained

<!-- What does this change make true that wasn't true before? -->

## Scope

<!-- What's in this PR. What's explicitly left out. -->

## Canonical references

<!-- Which docs/RFC/invariant this touches or implements. -->

---

### Impact (mark each — "None" is a real, valid answer, not a skip)

- **Architecture impact:**
- **Protocol impact:**
- **Security impact:**
- **Privacy impact:**
- **UX impact:**

### Tests

<!-- What ran. What a reviewer should run to reproduce. -->

### Evidence

<!-- Per docs/ENGINEERING_GOVERNANCE.md §11 — Hypothesis / Designed /
     Implemented / Supported / Demonstrated / Validated / Frozen.
     State the level honestly; don't round up. Use the weakest test
     that can actually falsify the claim, then strengthen it if the
     consequence demands more (§16.7/§16.17's harness/evidence ladders).
     Don't collapse Absence/Failure/Unknown/Pending/Rejected/Unavailable
     into each other (§16.17) — a swallowed error is not a success. -->

### Claims allowed / not demonstrated

<!-- docs/ENGINEERING_GOVERNANCE.md §10 — OUTPUT ≠ EVIDENCE ≠ PROPERTY ≠ CLAIM.
     What may this PR's description or a doc update safely say? What
     must it explicitly NOT claim? -->

### Technical debt introduced

<!-- If none, say "None." If any, it must be registered in
     docs/TECHNICAL_DEBT_AUDIT.md in this same PR, not left implicit. -->

---

<!-- The two sections below are REQUIRED for Protocol-Sensitive /
     Economic-Security-Critical work (docs/ENGINEERING_GOVERNANCE.md §4).
     Mark N/A for Reversible / Shared-Semantics work. -->

### Merge Tier (docs/governance/MERGE_AUTONOMY_POLICY.md; proposed by the EPM, confirmed or raised by the GK)

- **Proposed Tier (1-4) and why (real effect, not title):**
- **GK confirmation:** (comment link, head SHA)
- **Files that need explicit diff review (workflows, scripts, package.json):** None / list
- [ ] Tier 3/4 only: CTO despacho for this exact head linked: ___
- [ ] Merge does not authorize migration, deploy or economic activation.

---

### Sacrifice Check (required for significant architecture/security/protocol work)

1. What property did we gain?
2. What property might we have sacrificed?
3. What complexity did we introduce?
4. Did the complexity earn its place?
5. What remains explicitly not demonstrated?

### STOP gate / architecture approval

- [ ] This PR does not change a frozen invariant, the Semantic Kernel, or Core Architecture.
- [ ] If it does, the corresponding RFC/Core-RFC (`docs/GOVERNANCE.md` §5/§6A) is linked here: ___
- [ ] No STOP condition (`docs/ENGINEERING_GOVERNANCE.md` §6) was encountered and worked around silently.
