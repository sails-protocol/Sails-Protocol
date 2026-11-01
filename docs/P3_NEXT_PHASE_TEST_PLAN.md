# P3 next-phase test plan (PLAN ONLY, nothing here is implemented)

Status: PLANNED (2026-10-24, P3-R3). Each item states what would be proven, how, what it needs and what it would **not**
prove. Priority is by the risk to a self-hosting operator who cannot call a vendor. Nothing below runs against a shared or
production database; anything needing a real host says so.

| P | Test | Proves | How | Needs | Does not prove |
|---|---|---|---|---|---|
| 1 | Backup/restore **with SSE key custody** | Evidence stored encrypted can be restored on a new host; losing the key is detected, not silent | Store evidence, `backup` + `backup-evidence`, wipe volumes, restore with the key, verify bytes and hashes; repeat with a wrong/missing key and assert a loud failure | Compose stack, a key-custody procedure decision | Durability of the operator's key storage |
| 2 | **VPS install and recovery** | The kit works on a plain Linux host as a non-root operator: install, reboot, disk-full, power-loss restart | Scripted run on a disposable VPS; transcript kept | A real VPS (partner dev) | Multi-node behaviour |
| 3 | **cosign + SBOM** for both images | Provenance: the image the operator pulls is the one CI built, with a listed bill of materials | Sign by digest in CI, publish SBOM (CycloneDX/SPDX) as an artifact, verify in the install path | Decision on registry and key policy (the CTO's: nothing is published today) | That the dependencies in the SBOM are safe (that is Trivy's job) |
| 4 | **Digest pinning of external images** (PostgreSQL, SeaweedFS and any other compose image) | Rebuilds do not silently change the stack | Replace tags by digests in `deploy/self-host`, add a CI check that fails on an unpinned `image:` | None | That the pinned digest is free of vulnerabilities (Trivy on them is a separate step) |
| 5 | **`sails-node update` concurrency** | Two simultaneous updates cannot corrupt state or skip the migration gate | Launch two updates against a throwaway project, assert one wins and the state file stays consistent (needs a lock if it does not) | Compose stack | Concurrency across hosts |
| 6 | **QVAC offline** | The node starts and serves with no outbound network | Run the stack with egress blocked, assert readiness and a QVAC call | Compose stack with a network policy | Behaviour when the network returns mid-operation |
| 7 | **Docker volume cleanup** | `down`, `down -v`, prune and failed updates never remove data the operator did not ask to remove | Matrix of commands against a populated stack; assert which volumes survive | Compose stack | Third-party tooling that deletes volumes |
| 8 | **Mutation-test reproducibility** | A third party can re-run the K-series (K3/K4/K6 and others) and get the same RED/GREEN | Move the harness (`mutate_p3`-style) into the repository under `scripts/` with a committed-tree precondition, document the bounded timeouts | The harness code now kept outside the repository | That the mutants are the right ones |
| 9 | **P3-B interoperability** | A second implementation can talk to a node built from these images | To be designed with the CTO; scope not defined yet | A second implementation | Anything before the scope exists |
| 10 | Trivy `enforce` rehearsal | The gate fails exactly when it should, with a synthetic CRITICAL and a synthetic exception | Unit tests exist for the evaluator; add a CI job that feeds a canned report in `enforce` mode and expects exit 1 | None | Real-world scan coverage |

## Ordering and dependencies

1 and 4 are cheap and independent: do first. 3 depends on a registry/key policy decision. 2 and 9 need people and hosts.
8 should precede any new mutation claim. 10 can be folded into the enforce switch.

## What would make this plan wrong

- If the CTO decides the kit is not a product deliverable (only a reference), items 2, 3 and 9 shrink to documentation.
- If SeaweedFS is replaced, items 1, 4 and 7 are redone for the new store.
