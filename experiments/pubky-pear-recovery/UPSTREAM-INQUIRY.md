# DRAFT upstream inquiry to Pubky (not posted; needs the CTO's or Alan's approval before anything is sent)

Target: https://github.com/pubky/pubky-homeserver (issues) or the Pubky core team channel. No Sails secrets or data are included.
Evidence behind it: `homeserver/README.md`, upstream files cited below at tag `v0.16.2` (commit `f60e502f`) and `main` (`fd24bf0c`).

## Title
Documented way for a third party to learn whether a grant is revoked, and signer-side control of grant lifetime

## Body

We integrate Pubky grants for delegated, scoped sessions (an app asks a signer for a grant, the app never holds the root key) and use
`createCustomPop` / `verifyCustomGrantPop` to present proofs to other services.

1. **Revocation visibility for third parties.** `docs/CUSTOM_POP.md` says verification "does not contact the homeserver or check
   revocation". After `GrantManager.revoke`, `verifyCustomGrantPop` still succeeds and a revoked client can keep minting new custom
   proofs offline. Is there a documented, supported way for a recipient to ask the grant's homeserver whether `jti` is currently active
   (an authenticated or signed status endpoint, or a signed revocation feed)? We observed that `POST /auth/grant/session` with the public
   grant and an invalid PoP answers `401 Grant has been revoked` because revocation is checked before the PoP
   (`auth/grant/service.rs`, `verify_grant_and_pop`). We do **not** want to depend on error ordering as a security contract. Would you
   support a stable status endpoint, and what are its rate-limit and privacy expectations?
2. **Configurable grant lifetime.** The grant carries a signed `exp` and the homeserver honours it (we verified a 25 s grant: bearer capped to it,
   writes refused after expiry, offline verifier rejects it), but the official signer path hard-codes two years
   (`pubky-sdk/src/actors/auth/grant/constants.rs`, `signer/auth.rs`) and neither the JS SDK nor the deep link carries a lifetime.
   Can a requesting app ask for a maximum lifetime that the signer (Ring) may shorten and show to the user? Does Ring plan a lifetime control?
3. **Service-specific consent.** The user approves storage capabilities only; the JS signer cannot sign a service claim
   (Rust has `approve_auth_with_companion_claim`). Is a JS/React Native equivalent planned?
4. **Deadlines.** Public `list` on a frozen homeserver never returned in our test; PKARR resolution times out after about 5 s.
   Is a per-call or client-level deadline planned?

Thank you; we are happy to share the reproduction harness.
