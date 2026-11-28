# Core — Sails Protocol

This folder holds the formal Core components (`ARCHITECTURE.md` section
1B, `MASTER_COORDINATION.md` v7.1). **Corrected 2026-08-09** — this file
previously said "each file below is currently a stub interface," which
stopped being true well before this correction: only the governed-policy
interface of `policy-engine.ts` remains a genuine stub today (see the
update on that file below).

- `intent-engine.ts`      — real (RFC-012). Routes Intents by type, runs the
  full CREATED → VALIDATED → COORDINATED lifecycle (PROTOCOL_SPECIFICATION.md §2).
  Persistence lives in `intent-repository.ts`.
- `coordination-engine.ts` — real, deliberately minimal (RFC-012). Resolves
  an Intent's target module; does not yet consult Policy/Capability — see
  its own header comment for why that's a disclosed scope limit, not a stub.
- `state-machine.ts`      — real. Canonical Intent lifecycle (9 states, §2.4).
- `capability-registry.ts` — real (RFC-013). Persists and checks real
  `CapabilityGrant`s. Persistence lives in `capability-grant-repository.ts`.
- `intent-repository.ts` / `capability-grant-repository.ts` — Repository
  Pattern persistence layer for the two entities above (ARCHITECTURE_AUDIT_REPORT
  recommendation #3, closed 2026-08-08).
- `timeline.ts`           — real (RFC-008 D2). Hash-chained event timeline.
- `policy-engine.ts`      — **partly implemented.** `evaluateIntentPolicy()` and
  `validateFinancialSanity()` are implemented. The governed-policy interface
  (`policyEngine.get`/`propose`/`activate`) is **still a genuine stub**:
  all three throw "Not yet implemented" — FeePolicy/TrustPolicy/RoutingPolicy
  governance is real future work (`PROTOCOL_ECONOMY.md` §7, roadmap "Months 10-12"),
  not built yet. Fee rates live in the versioned `FeePolicyVersion`
  foundation (`modules/open-settlement/fee-policy.service.ts`) in the meantime.

No module should import another module directly — every module imports
from `core/` instead. See `ARCHITECTURE.md` section 5 for the enforcement
rule and the grep check to run before submitting any change.
