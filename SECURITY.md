# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability within Sails Protocol, **do not publish exploit details, secrets, personal data, or reproduction material in a public GitHub issue**.

Send the report privately to [social@satsails.com](mailto:social@satsails.com). Do not include vulnerability details in a public GitHub issue.

`social@satsails.com` is the project's current centralized public contact mailbox, including security reporting. This policy does not publish a fixed response-time SLA.

## Scope

This security policy applies to:

- **Backend API** (`@sails/api`) — Fastify server, authentication, escrow logic
- **SDK** (`@satsails/p2p-trading-sdk`) — Client library for interacting with the API
- **React SDK** (`@satsails/sdk-react`) — React hooks and components

## Out of Scope

- Third-party dependencies (report upstream)
- Social engineering attacks
- Physical attacks
- Denial of service attacks

## Response Expectations

This repository does **not** currently publish fixed acknowledgment, assessment, or remediation SLAs. Response and remediation depend on maintainer availability, severity, reproducibility, affected release/deployment, and the evidence available.

A future response-time commitment should be documented only after an actively monitored private reporting channel and operational security process are established.

## Security Best Practices

### For Contributors

1. **Never commit secrets** — API keys, private keys, passwords, or tokens
2. **Use environment variables** — All sensitive configuration via `.env`
3. **Validate all inputs** — Zod schemas for all API endpoints
4. **Sanitize outputs** — No XSS, no injection
5. **Abuse controls** — Apply rate limits, quotas, idempotency and resource controls according to the exposed capability and deployment risk; do not assume every path is covered merely because some middleware exists.
6. **TLS in production** — Treat HTTPS/TLS as a deployment requirement and verify it in the deployed environment rather than inferring it from application code.

### For Users

1. **Never share your private key** — Not even with support; it's the only credential that exists, there's no password to fall back on
2. **Verify distribution sources** — Use repository/package/release information that can be independently verified.
3. **Report suspicious activity carefully** — Do not publish sensitive security details in a public issue; follow the reporting guidance above.

## Authentication

<!-- Corrected 2026-08-15 — this section previously described JWT/refresh
     tokens, which never existed in this codebase; found stale while
     verifying claims against the real implementation before adding
     automated CI scanning below. -->
- Ed25519 challenge-response — the client signs a server-issued nonce with
  their own keypair; no password ever exists to authenticate with
- Session token (a random 32-byte value, not a JWT) issued on successful
  verification, stored server-side in Redis, default 1-hour TTL. It is a
  bearer credential: whoever holds it acts as that participant until it
  expires. The challenge-response proof is made once per session; later
  requests are not individually signed, so the challenge gives no
  per-operation replay protection
- No logout/session-revocation endpoint exists yet — a session ends only
  by expiring; tracked as a real gap, not implemented

### Long-lived credentials inventory

<!-- Added 2026-08-15 — audited every long-lived secret in this codebase
     for accidental exposure before writing this section, not assumed. -->
- `ARKADE_SEED`, `WDK_SEED_PHRASE` — operator-held master secrets
  (`.env.example`), used only server-side to derive/construct signing
  material; confirmed no route ever returns either value or anything
  derived directly from them (public keys derived from them are the only
  thing ever exposed, by design). Neither has a rotation path — rotating
  either changes every key it would derive going forward, breaking
  in-flight escrows that depend on the current derivation; a real
  operational constraint, not something this codebase automates today.
- Session tokens and WS tickets — confirmed each has exactly one issuance
  point (`POST /v1/identity/authenticate`, `POST /v1/identity/ws-ticket`
  respectively); no other route echoes either back.

## Data Protection

- Do **not** assume that a Sails deployment processes no personal data merely because the protocol centers on public-key identities. Applications, operators, evidence flows, payment integrations, logs, metadata and external providers may introduce personal or regulated data depending on the deployment.
- Sensitive transport/authentication material such as headers, cookies and tokens is redacted by the reference server's pino configuration; operators must independently validate their own logging, tracing and external observability pipelines.
- Encryption at rest for the database is a deployment-time choice (for example, managed-database storage encryption), not something this repository can prove for an operator's infrastructure.
- Evidence/object-storage encryption is provider/deployment specific and must be validated against the configured production provider.
- TLS is a production deployment requirement; this repository does not by itself prove that every downstream deployment terminates TLS correctly.
- Each deployer/integrator is responsible for its own data inventory, retention, deletion, access-control and jurisdiction-specific privacy obligations.

## Dependency Security

- Regular dependency updates via Dependabot (`.github/dependabot.yml`)
- Automated static analysis (CodeQL, `security-extended` query pack) on
  every PR, every push to `main`, and weekly — `.github/workflows/codeql.yml`,
  added 2026-08-15. This line was aspirational before that date; corrected
  once it became true, not before.
- Lock files committed (`package-lock.json`)

## Compliance

This repository does **not** claim blanket legal or regulatory compliance for every deployment.

GDPR, other privacy regimes, financial-services obligations, record-retention rules and similar requirements depend on the concrete operator, jurisdiction, data flows, providers, controller/processor roles and deployment configuration. Integrators should perform their own legal/compliance assessment.

SOC 2 Type II is not claimed by this repository.

## Contact Status

- **Security:** social@satsails.com
- **General:** social@satsails.com

---

> **Last updated:** 2026-09-19
