# Sails Pulse: k6 evaluation checklist

Status: EVALUATION ONLY. This is not approval to install a binary or change the default CI.

## First controlled experiment

- Select an explicit k6 release, pin the artifact SHA-256 and document its official origin, license and maintenance/security advisories.
- Run in an isolated disposable runner with no external network access to protocol targets; enforce an allowlist and bounded duration/VUs.
- Implement HTTP PoP registration, signed challenge authentication, create/cancel intent with full response assertions. Use k6-compatible crypto or a reviewed setup fixture; do not assume Node.js crypto or npm packages work in k6.
- Implement WebSocket one-time ticket minting and verify application PONG; reject URL bearer tokens.
- Capture requested and achieved arrival rates, error classification, p50/p95/p99, connection counts, resource consumption and generator saturation.
- Compare against a protocol-equivalent native run and corrected Artillery comparator, each with equivalent setup cost, assertions, rate policies and load profile.
- Preserve auth rate-limit policy. If the 10/min default conflicts with workload generation, stop and request a separate security review instead of bypassing it.
- Fail if metrics, assertions or reports are missing. Never publish credentials, signed proofs, ticket URLs or private keys in CI artifacts.

## Acceptance

The hybrid option must have no security regressions, meet required protocol coverage, generate reproducible and trustworthy measurements, reduce maintenance burden, and not introduce unjustified supply-chain exposure. Performance wins alone do not override failed security gates.

## Current status

- Native real-service smoke and tiny rehearsal: previously passed.
- Native workflow and general CI: passed at 9846c5b3f666f4c16ddc025f355c78dbccc2ca51.
- k6 binary provenance, scenario implementation, WS assertion and comparative benchmark: NOT YET VERIFIED.
- No decision to uninstall Artillery, merge, deploy or change rate limits.
