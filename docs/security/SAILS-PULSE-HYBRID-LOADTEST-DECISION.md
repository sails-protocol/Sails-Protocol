# Sails Pulse: hybrid load testing architecture (candidate)

Status: PROPOSED. This document does not authorize a tool migration, removal, merge, deployment, production load test, or rate-limit adjustment.

## Purpose

Own protocol-specific correctness and security policy, not a generic high-volume load-generation engine. The preferred architecture to evaluate is a small Sails Pulse orchestration layer with k6 as the external load engine. Retain the Node 24 native harness as an independent low-volume behavior check. Keep Artillery until reproducible, current-protocol parity is demonstrated.

## Trust boundaries

- Pin k6 version and verify distribution provenance, checksums and license before use. No floating installer, curl-pipe-shell, or unreviewed third-party extensions.
- Execute only in disposable isolated environments with loopback or explicitly allowlisted test targets; fail closed for production/public targets.
- Test-only accounts and signing keys. Never commit, upload as artifacts, or print tokens, seeds, private keys, registration proofs or ticket URLs.
- Bound arrivals, duration, active virtual users, concurrent sockets, request timeouts, CPU and memory; fail closed on budget breaches.
- Distinguish protocol failures from load-generator saturation, throttling, setup errors, and missing assertions.
- Assert full PoP registration, signed authentication, create/delete intent responses, WS single-use ticket and PONG; do not accept a connection-only success as parity.
- Use deterministic workload descriptions, machine-readable reports, error counts and threshold gates. Review p50/p95/p99, achieved request rate and resource consumption across independent repeat runs.
- Do not weaken authentication rate limits to make benchmark graphs green. Escalate a separate security review if higher-load setup is required.

## Decision gates

1. Verify native and independent CI at exact commit HEAD.
2. Evaluate k6 package/source maintenance, dependency and binary supply-chain risks, license, available WS semantics and bounded CI execution.
3. Implement one equivalent low-volume HTTP and WS workload with identical auth setup and assertions for each candidate.
4. Run repeated isolated benchmarks and compare measured throughput, latency distributions, failures, CI stability, complexity and ongoing maintenance cost.
5. Only then propose a documented choice: hybrid k6, alternative established engine, or native-only. A proposal is not permission to remove Artillery or merge.

## Current evidence

Native smoke and tiny rehearsal have succeeded; these are not sustained throughput or parity evidence. The inherited Artillery scripts do not match current PoP and WS ticket behavior. A separate test-only HTTP comparator exists; WS comparator and matched benchmark are still outstanding. No k6 benchmark has been performed.

## Naming

Sails Pulse is the internal umbrella name for protocol-specific test policy and scenarios. It does not imply that the load-generation engine is proprietary.
