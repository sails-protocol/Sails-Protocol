# M8_DISPATCH_GATE_FINDINGS.md
### Sails Protocol — Provider Dispatch Gate: why live migration was deferred

> Engineering handoff note, not a frozen architecture document.

## 1. The finding

`dispute.service.ts`'s `resolveDispute()` accepts `releaseToAddress`/
`refundToAddress` as plain HTTP-request parameters. Neither is part of
what the arbiter's Ed25519 signature covers —
`arbitration-authority.ts`'s `AuthorityDecisionPayload` signs exactly
`{disputeId, escrowId, appealRound, authorityId, outcome, buyerBps,
issuedAt}`, nothing else.

These addresses reach real fund movement via
`escrow-lifecycle.ts`'s `resolvePayoutAddress()`:

```ts
export async function resolvePayoutAddress(explicitAddress: string | undefined, participantId: string, asset: AssetType): Promise<string> {
  if (explicitAddress) return explicitAddress
  const registered = await payoutAddressService.getPayoutAddress(participantId, asset)
  ...
}
```

**An explicit address always wins** — verbatim from that function's own
comment. The participant's own registered `PayoutAddress` is only a
fallback for when the caller omits an address; it is never
cross-checked against whatever the caller *does* supply.

## 2. Why this blocks a safe live M8 migration

This is the exact, concrete instance of the "central threat" M6/M7/M8
all exist to name generically: a technically valid, correctly-signed
ruling (`RELEASE`, `buyerBps` correct) can still be executed to an
attacker-chosen destination, because the destination itself carries
**zero provenance** — it is neither signed, nor bound to any durable,
independently-verifiable fact.

Building a "dispatch gate" that reads its destination from this same
unverified parameter would be decorative: the gate would report
`ELIGIBLE`, Core would appear to "govern," and the underlying
vulnerability would pass straight through unchanged. That is precisely
the kind of pass this program's own discipline (§25's "delete-the-Core
test", `docs/CORE_ARCHITECTURE.md`'s "do not optimize for passing the
gate") exists to prevent.

## 3. What closing this actually requires — a genuine product decision, not an implementation detail

At least two structurally different resolutions exist, and choosing
between them is a real product/protocol decision this program has not
made:

**Option A — bind destination into what the arbiter signs.** Extend
`AuthorityDecisionPayload` (a frozen Mission13 signing scheme) with a
destination commitment. Changes what an arbiter must supply and sign;
requires new client/SDK support; is the strongest fix.

**Option B — remove the override capability for the live-migrated
path.** Always resolve the authorized destination from the
participant's own registered `PayoutAddress`, ignoring
`releaseToAddress`/`refundToAddress` entirely once a slice is Core-
authoritative. Weaker product surface (a participant must pre-register
before a ruling can execute) but needs no signing-scheme change.

**Option C — some other explicit destination-attestation mechanism**
(e.g. a separate, participant-signed destination confirmation) not
explored here.

None of these is an implementation refinement — each changes real
user-facing behavior or the frozen Mission13 signing contract. Per this
program's own operating discipline (`CLAUDE.md` rule 5: a genuine
architectural inconsistency in Tier 3 code — escrow, settlement,
arbitration — gets reported, not decided unilaterally), M8 stops here
and reports this rather than picking one silently.

## 4. What was still built and validated in this mission

- `packages/sails-core/src/dispatch-gate.ts` — the dispatch-eligibility
  primitive itself (attribution/Outcome/destination-binding/idempotency
  structural checks), fully isolated from this finding — the primitive
  is sound; the BLOCKER is exclusively about what real, live input would
  feed it.
- `src/modules/open-settlement/dispatch-gate-adapter.ts` — the Runtime
  trust-boundary shape a future live wiring must respect
  (`alreadyDispatched` is never an externally-assertable boolean).
- M7's W1 (allocation remainder determinism) resolved: `beneficiary`
  string-sorting no longer decides money; `remainderBeneficiary` is now
  an explicit, required, validated field
  (`src/modules/open-settlement/economic-outcome.ts`).

## 5. Recommended next step

A dedicated, narrowly-scoped decision (not an M8 retry in isolation):
choose Option A, B, or C above with explicit product input, then retry
live migration against that resolved destination-provenance model.

## 6. Resolved at the architecture level — Mission M8.5, 2026-08-30

The product/protocol decision recommended above has been made at the
architecture level: `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md`
selects a refined form of **Option B** (drop the caller-suppliable
override; always resolve and snapshot the beneficiary's own registered
`PayoutAddress` at Outcome-authorization time) as the default,
sufficient remediation for this exact finding, with Option A's own
underlying idea (an explicit, signed, beneficiary-authorized destination
claim) preserved as a validated, optional extension — reusing M5's
`AttributionClaim`/`referenceAttributionEvaluator` unchanged, never a new
Core primitive. **Not yet implemented** — see that document's §16 for
the concrete remaining work and the one open product decision (legacy
in-flight disputes) before Mission M8-R may retry.

> **Corrected/Implemented 2026-11-27 (historical delimitation):** "Not yet implemented" describes the state when this note was written. Since then, the destination is the beneficiary's registered payout address on every rail: the cooperative release path (`/release` and `/initiate-release`) ignores a caller-supplied destination (the SDK's `release()` ignores its address argument), and the disputed non-MULTISIG rails (`LIGHTNING_HODL`, `SAFE_GUARD_EVM`, `WDK_USDT_EVM`, `MOCK`) disregard the arbiter-supplied destination since M8-R2 (2026-09-11). The rail-by-rail detail and its evidence are in `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` (note after section 16). Whether every item of the remaining-work list in `docs/DESTINATION_AUTHORITY_ARCHITECTURE.md` section 16 is closed, in particular the dispute-resolution parameters and the legacy in-flight disputes, is not re-established by this note.
