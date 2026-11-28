# TODO.md
### Sails Protocol — Historical / Category-Oriented Implementation Gap Inventory

> **Authority / status:** retained for implementation-gap provenance and category-oriented audit history. It is not the primary current execution queue. Use `BACKLOG.md` plus live GitHub Issues/Project for current unresolved obligations and sequencing.
>
> This list originated from filesystem audits of the reference implementation. Verify current state before acting on any item: code, ownership and production-readiness evidence may have changed since a section was written.

> **Re-audited 2026-07-16.** The previous version of this file had drifted
> out of sync with the codebase — several items it listed as missing or
> not-started had already been built (in the "MVP happy path" and
> "sails-p2p-schemas" work), but this file was never updated to reflect
> that. Fixed below, with the stale claims struck and moved to section 13
> rather than silently deleted, so it's clear what changed and why. For
> granular, frequently-updated per-item status, `BACKLOG.md`'s P0-P3
> tables are the more authoritative source — this file organizes by
> category (missing files, auth, tests, deployment) rather than by
> architectural dependency order, but the two must not contradict each
> other. If you find them disagreeing again, trust the filesystem, fix
> both, and don't leave the fix to whoever notices next.

> **Updated same day, route-restoration pass.** Section 1's biggest gap —
> HTTP routes for open-identity, open-p2p, open-settlement, and
> open-liquidity — is now closed. `npm run build` and `npm test` both pass
> with the new routes registered in `app.ts`.

> **Updated again same day — open-reputation built.** The one module this
> file flagged as more than route wiring (needed a real service layer,
> not just an HTTP shell) is now done: `reputation.service.ts` +
> `reputation.routes.ts`, with `recordOutcome()` wired dispute-aware into
> `common/events/handlers.ts`. Section 1 is now fully closed — every
> module has both routes and a real service layer. `npm run build`/
> `npm test` pass at 58 tests, 5 suites.

---

## 1. Missing Files (referenced by `app.ts` but not present in this environment)

`config/index.ts`, `common/database/index.ts`, `common/redis/index.ts`,
and `common/errors/index.ts` — all previously listed here as missing —
**now exist and are imported directly (uncommented) at the top of
`app.ts`.** See section 13. Route wiring is also done now, for every
module including `open-reputation` — see 13 for each. **This section is
now fully closed.**

- [x] **`src/main.ts` itself — found genuinely missing, fixed** *(new —
      root-level demo-satsails-qvac.ts pass, 2026-07-17)*. This section's
      "the server boots" claim below was never actually verified end to
      end: `package.json`'s `dev`/`start` scripts both referenced
      `src/main.ts`, but the file did not exist anywhere in the repo —
      confirmed by actually running `npm run dev`
      (`Error: Cannot find module 'src/main.ts'`), not assumed. Fixed
      with a thin entrypoint that calls `app.ts`'s already-real, complete
      `startServer()`. Also found and fixed along the way:
      `package.json`'s `"start"`/`"main"` pointed at `dist/main.js`, but
      `tsc`'s actual output lands at `dist/src/main.js` — `tsconfig.json`
      has no explicit `rootDir`, and the `@satsails/p2p-schemas` path
      mapping (`paths` → `packages/sails-p2p-schemas/src/index.ts`) pulls
      that file directly into the same compiled program, shifting the
      inferred common root up to the repo root. Both scripts now point
      at the real `dist/src/main.js`. Verified: `npm run dev` and
      `npm start` both now resolve and run cleanly up to the expected,
      already-documented "no live Postgres/Redis in this environment"
      failure point — no more `MODULE_NOT_FOUND`.

## 2. Immediate Priority — Restore a Runnable Server

**Resolved, and now actually verified (previously an unverified claim —
see section 1's new note above).** `config/index.ts`,
`common/database/index.ts`, `common/redis/index.ts`,
`common/errors/index.ts`, and `main.ts` all exist, and
`core/intent.routes.ts` (moved 2026-08-10, was `routes/intentRoutes.ts`) is registered in `app.ts` — the server boots
(given a reachable Postgres/Redis) and serves a real, tested route today.
This section previously blocked "almost everything else" per the closing
note below; it no longer does. **What's now the practical next blocker**
(not urgent in the "won't boot" sense, but the highest-leverage next
step): restoring the route files listed in section 1 above, so the
service layers that already exist for OpenSettlement, OpenLiquidity, and
the OpenP2P negotiation channel are actually reachable over HTTP/WS —
see `BACKLOG.md`'s "Why the Order Differs From Pure Priority" note, which
makes the same point in more detail.

## 3. Auth Middleware (status changed — closed)

- [x] Ed25519 signature verification middleware — `common/middleware/
      auth.ts` implements real challenge-response auth, closing
      `RED_TEAM_REVIEW.md` RT-002 (previously the highest-priority open
      security item here). See `BACKLOG.md` P2, "Sails OpenIdentity" row.
- [x] **Now wired.** Every write-side route added in the route-restoration
      pass (identity, peers, liquidity offers, trades, settlement/dispute)
      uses `requireAuth` as a `preHandler` and reads `request.participantId`
      — never a bare `userId`/`participantId` from the request body. Fixed
      a real bug found while wiring this: `verifySignedChallenge()`
      generated and stored a session token but never returned it to the
      caller, so the challenge-response flow was unusable end-to-end
      despite verifying correctly — see `common/middleware/auth.ts`.

## 4. Settlement Providers Beyond Mock

- [x] **`WDK_USDT_EVM`** *(new — QVAC/WDK MVP pass, 2026-07-17)* — real,
      not a stub: `wdk-settlement.provider.ts` uses
      `@tetherto/wdk-wallet-evm` for lock/release/refund, all real
      on-chain testnet transfers with real transaction hashes. Only
      active when `MOCK_ESCROW=false` and `WDK_SEED_PHRASE`/
      `WDK_USDT_CONTRACT` are set (`.env.example`) — inert otherwise, per
      RED_TEAM_REVIEW.md RT-001's existing gate. **Honest limitation, not
      hidden:** single-seed, two-hop escrow (one seed controls treasury
      + every per-trade escrow sub-account) — a real step up from `MOCK`,
      not yet a trustless multisig. `toBaseUnits()`/`escrowIndexFor()`
      (the pure, deterministic parts) are unit-tested in
      `tests/wdkSettlementProvider.test.ts`; the live wallet calls need a
      funded testnet key to verify, which wasn't available in this
      environment — same "cannot verify without live infrastructure"
      limitation the items below already have.
- [x] **`executeSettlement()`** *(new — same day, follow-up pass)* —
      `settlement-orchestrator.ts`'s real entrypoint: createEscrow ->
      lockFunds (real signed WDK collateral) -> markPaymentSent ->
      emulated seller PIX-receipt confirmation (`pixConfirmation.emulated:
      true`, explicitly labeled — Sails OpenProof, RFC-003, is still 📋
      future, this does not pretend to have built it) -> releaseFunds
      (real signed WDK USDT transfer). Reuses the existing
      `escrowService.releaseFunds()` -> `WdkSettlementProvider` ->
      `@tetherto/wdk-wallet-evm` signing path rather than adding a second
      WDK integration — checked against the real npm registry first:
      `@tetherto/wdk-core` does not exist as a package; the actual
      multi-chain umbrella package is `@tetherto/wdk`, a different thing
      from the chain-specific `@tetherto/wdk-wallet-evm` this codebase
      already correctly uses. Wired to `openp2p.trade.created`
      (`common/events/handlers.ts`) — this codebase's real stand-in for
      "the P2P engine gives Match," since the Intent Engine's own
      `MATCHED` state has no real matching engine wired to it — gated
      behind `config.features.autoSettleOnMatch` (default `false`,
      `AUTO_SETTLE_ON_MATCH` env var): that event fires for every real
      trade, not only demo/agent-driven ones, so autonomous fund release
      with no dispute-window step is not a safe unconditional default.
      `examples/demo/pix-to-usdt-flow.ts`'s steps 8-9 now call this single
      function instead of re-implementing the sequence inline. Tested in
      `tests/settlementOrchestrator.test.ts` (6 tests, mocked
      `escrow.service.ts`) and `tests/autoSettleHandler.test.ts` (3 tests
      — confirms the flag actually gates it, and that a settlement
      failure doesn't crash the event dispatcher).
- [x] **Two-person control on release** *(new — RFC-015,
      `rfcs/RFC-015-dual-authorization-escrow-release.md`, 2026-07-18)* —
      a real, application-layer mitigation for the single-seed custody
      gap named above, not a claim of real multisig (checked and
      rejected for this pass: `@tetherto/wdk-wallet-evm-erc-4337` is
      single-owner-only against its real compiled types).
      `escrow.service.ts`'s `releaseFunds()` — the one real choke point
      for every release, across all three of its real callers — now
      requires both `Trade.buyerId` and `sellerId` to have separately
      called `POST /v1/settlement/escrow/:id/approve-release` before a
      normal (non-disputed) release proceeds, behind
      `config.features.requireDualApprovalForRelease`
      (`REQUIRE_DUAL_APPROVAL_RELEASE`, default `false` — turning it on
      changes `executeSettlement()`'s calling pattern, see the RFC's
      Decision §5). Also fixed a real gap found while building this:
      RFC-014's capability check had shipped inside
      `settlement-orchestrator.ts` only, missing the direct release route
      and the arbitrated-dispute release path — both checks now live
      inside `releaseFunds()` itself. 13 new tests
      (`tests/escrowReleaseControls.test.ts`).
- [x] `LightningHodlProvider` — **done** (`lightning-hodl.provider.ts`,
      2026-07-27), via Arkade (Ark protocol) rather than a literal LND
      hold-invoice. Plain Lightning HTLCs have no genuine multi-party
      escrow primitive — confirmed directly from HodlHodl's own docs,
      their Lightning mode is plain custodial holding on their own LND
      node, not cryptographic escrow ("currently there are no multisig
      escrow addresses on the Lightning Network"). Arkade is different: a
      real, live Bitcoin L2 (VTXOs, Taproot scripts) that HodlHodl and
      Lendasat both already build genuine 2-of-3-style escrow on top of —
      same production precedent this file follows. Real
      `@arkade-os/sdk` — `SeedIdentity`/`MultisigTapscript`/
      `CSVMultisigTapscript`/`VtxoScript` construction verified
      experimentally against the real package AND a real network call to
      Ark Labs' own public mutinynet ASP (`https://mutinynet.arkade.sh`,
      confirmed reachable — real `getInfo()`, real signer pubkey, a real
      resulting Arkade address). Same custody-model/single-arbiter
      disclosure as `MultisigProvider`. `releaseFunds()`/`refundFunds()`
      are built against the real, documented `buildOffchainTx`/
      `combineTapscriptSigs`/`verifyTapscriptSignatures`/
      `RestArkProvider.submitTx`+`finalizeTx` functions, but — disclosed
      plainly in that file's own header comment — NOT executed end-to-end
      against a real funded VTXO in this pass (needs an actually-funded
      mutinynet address, a further step; same category of disclosure
      `WdkSettlementProvider` already uses for its own
      real-but-unfunded-in-this-sandbox transfer path). Note: `@arkade-os/sdk`
      cannot load under Jest (its CJS build transitively requires
      `@scure/btc-signer`, pure ESM, no CJS build) — mocked in every test
      file that reaches `escrow.service.ts`, same fix already used for
      `@tetherto/wdk-wallet-evm`; confirmed this is Jest-specific, not a
      real runtime problem (`node dist/src/modules/open-settlement/escrow.service.js`
      loads the real, unmocked package cleanly).
      `LiquidCovenantProvider` remains genuinely unimplemented — doesn't
      exist as a file at all yet (needs a real Elements node plus a new
      `liquidjs-lib` dependency), no Arkade-equivalent precedent found for
      it yet. **Decision (2026-08-01, project owner):** consciously not
      prioritized — `LIQUID_COVENANT` stays a reserved, documented
      `EscrowType` value (`DATABASE.md` §2) rather than being built or
      removed, same decision covering the other 6 `AssetType` values with
      no real provider (`BACKLOG.md`'s OpenSettlement row).
- [x] Real Multisig 2-of-3 Bitcoin escrow — **done** (`multisig.provider.ts`,
      2026-07-27). Real `bitcoinjs-lib`/`bip32`/`ecpair`/`tiny-secp256k1`
      P2WSH script + PSBT construction/signing/finalization, verified
      against the real libraries (2-of-3 finalizes, 1-of-3 correctly
      fails). Custody model disclosed plainly in that file's own header
      comment, same discipline as `WdkSettlementProvider`: all 3 keys
      (buyer/seller/arbiter) are still derived from one server-held seed —
      genuine 2-of-3 script mechanics, not yet a trustless multisig where
      each counterparty holds their own key (that's the same gap RFC-019
      Phase 2 already names). Also single-arbiter-only: the script's
      arbiter key is fixed at escrow-creation time, so a deployment with
      more than one `TRUSTED_ARBITRATORS` entry can produce a dispute
      whose assigned arbiter doesn't match — the provider refuses that
      loudly (`assertArbiterMatchesScript()`) rather than attempting a
      signature that wouldn't validate. Non-custodial in the fund-movement
      sense (unlike `MOCK`/`WDK_USDT_EVM`, it never pushes funds in — the
      seller funds the deposit address externally). Tests:
      `tests/multisigProvider.test.ts` (18, pure crypto — no live infra
      needed for any of it except the final broadcast, which is mocked)
      and `tests/escrowProviderWiring.test.ts` (5, wiring). RFC-015's
      two-person control (above) remains a real mitigation for *who may
      trigger* a release; this is the actual on-chain enforcement.
      **Real bug found and fixed in the same pass:** `getProvider()` used
      to silently fall back to `MOCK` for ANY unregistered `EscrowType`
      (`MULTISIG` before this, and still `LIQUID_COVENANT` today) instead
      of throwing like `LIGHTNING_HODL` already did — a real-money-shaped
      escrow could silently mock-process. Fixed for every type, not just
      `MULTISIG`.
- [x] **Client-held keys (Phase 1 of the HodlHodl-grade non-custody
      upgrade) — done, 2026-07-27.** Closes the biggest disclosed gap in
      both `MultisigProvider` and `LightningHodlProvider`: buyer/seller no
      longer have their key derived server-side. Each generates a real
      secp256k1 keypair client-side (`@satsails/p2p-trading-sdk`'s new `escrow-key.ts`,
      `generateEscrowKeypair()` — `@noble/curves`, pinned to `^1.2.0`
      specifically because 2.x ships pure ESM with no real CJS entry for
      this subpath, same class of Jest-breaking problem
      `@tetherto/wdk-wallet-evm`/`@arkade-os/sdk` already have) and submits
      only the 33-byte compressed pubkey via the new
      `POST /v1/settlement/escrow/:id/submit-key` route
      (`escrow.service.ts`'s `submitParticipantKey()`, persisted as the
      new `EscrowParticipantKey` Prisma model). The server now derives
      only the arbiter's key — genuinely the same custody split HodlHodl's
      own real design uses (confirmed against their public API docs
      before `MultisigProvider` was first built). `custodyModel` on both
      providers changed from `server-derived-2-of-3-reference-implementation`
      to `client-held-buyer-seller-keys-server-held-arbiter` to reflect
      this. `createEscrow()` no longer populates `Escrow.multisigAddr`
      immediately — it can't, until both pubkeys arrive;
      `submitParticipantKey()` derives and persists the real address once
      they do. **Consequence, disclosed plainly, not silently broken:**
      `releaseFunds()`/`refundFunds()` on both providers now throw a clear
      "Phase 2 not built" `EscrowError` unconditionally — the server
      structurally cannot sign with a key it no longer holds. A real
      release needs a signature-collection flow (server builds an unsigned
      tx, each required party fetches + signs + submits their own
      signature client-side) — scoped as an explicit Phase 2, not started.
      Verified end-to-end against the real running server + real local
      Postgres (not just unit tests): two real registered participants, a
      real trade, a real `MULTISIG` escrow, both submitting real
      client-generated pubkeys, address staying `null` until both arrive
      then resolving to a real testnet P2WSH address matching on re-fetch.
      New/changed tests: `tests/multisigProvider.test.ts` and
      `tests/lightningHodlProvider.test.ts` rewritten for the
      pubkey-accepting API; `tests/escrowProviderWiring.test.ts` gained a
      `submitParticipantKey()` describe block; new
      `packages/sails-sdk/tests/escrow-key.test.ts` (real crypto,
      cross-checked against `bitcoinjs-lib`).
- [x] **Client-signature-collection (Phase 2 of the HodlHodl-grade
      non-custody upgrade), MULTISIG only — done, 2026-07-27.** Closes the
      gap Phase 1 (above) disclosed: `releaseFunds()`/`refundFunds()` can
      no longer sign server-side now that buyer/seller keys are
      client-held. Real flow: `POST .../initiate-release` /
      `.../initiate-refund` (`escrow.service.ts`'s `initiateRelease()`/
      `initiateRefund()`) run the same ownership/capability/dual-approval
      checks the old synchronous release/refund already had, then call
      `multisig.provider.ts`'s new `buildUnsignedRelease()`/
      `buildUnsignedRefund()` (real PSBT construction against the
      escrow's recorded funding UTXO, does NOT sign) and persist it as a
      new `EscrowPendingTransaction` row — escrow status is untouched
      until finalize actually succeeds. Each required signer
      (`requiredSigners`, participant ids) independently loads the
      unsigned PSBT, signs their own copy client-side
      (`@satsails/p2p-trading-sdk`'s new `signEscrowPsbt()`, `@bitcoinerlab/secp256k1` —
      pure JS, no WASM, the same avoidance-of-`tiny-secp256k1`-in-the-
      browser reasoning `escrow-key.ts` already used for `@noble/curves`),
      and submits it via `POST .../submit-transaction-signature`
      (`submitTransactionSignature()`, persisted as
      `EscrowTransactionSignature`). Once every required signer has
      submitted, the real provider call happens
      (`finalizeRelease()`/`finalizeRefund()` — `Psbt.combine()`s every
      independently-signed copy against the unsigned base and finalizes,
      broadcasts) and the SAME atomic `updateMany` status-claim pattern
      `releaseFunds()`/`refundFunds()` already used protects against
      double-finalization. **Disputed release/refund**: the arbiter's own
      required signature is pre-embedded into the "unsigned" PSBT at
      build time (the arbiter's key is still server-derived, unchanged
      from Phase 1) rather than waiting for an HTTP submission from a key
      the server already legitimately holds — only the other required
      party (buyer or seller, mirroring the pre-Phase-1 signer-selection
      logic: release favors the buyer, refund favors the seller) is a
      real pending client submission in that case.
      **Verified experimentally before writing this** (mirrors every
      prior provider's "verify, don't assume" discipline this session):
      `Psbt.combine()` correctly merges two independently-signed copies of
      the SAME unsigned PSBT (server sends one unsigned PSBT to both
      parties, each signs their own copy without seeing the other's
      signature) and correctly fails to finalize with only one; a
      `@bitcoinerlab/secp256k1`-signed PSBT input combines/finalizes
      correctly against a `tiny-secp256k1`-backed verifier (the two ECC
      implementations genuinely interoperate on the same PSBT bytes — the
      actual cross-library requirement here, client signs with one
      library, server finalizes with another).
      **Verified end-to-end against the real running server + real local
      Postgres** (not just unit tests, mirroring Phase 1's own
      verification style — a local stub swapped in only for the one
      dependency this environment cannot reach with real funds, a funded
      testnet Bitcoin UTXO; every other part of the stack — real HTTP
      routes, real `escrow.service.ts` orchestration, real Postgres, real
      PSBT construction/signing/combine/finalize — ran for real): two real
      users, a real trade, a real `MULTISIG` escrow, both pubkeys
      submitted, real `lockFunds()`, `initiate-release` correctly leaves
      the escrow at `PAYMENT_PENDING` until both parties independently
      submit their real signed PSBT copy, escrow reaches `COMPLETED` with
      a real `txReleaseId` only once the second signature lands (the
      first submission alone correctly reports `complete: false`), and the
      `EscrowPendingTransaction` row is gone (404) once finalized.
      New/changed: `prisma/schema.prisma`'s `EscrowPendingTransaction`/
      `EscrowTransactionSignature` models;
      `multisig.provider.ts`'s `buildUnsignedRelease()`/
      `buildUnsignedRefund()`/`finalizeRelease()`/`finalizeRefund()`;
      `escrow.service.ts`'s `initiateRelease()`/`initiateRefund()`/
      `submitTransactionSignature()`/`getPendingTransaction()`; 4 new
      `settlement.routes.ts` routes; `@satsails/p2p-trading-sdk`'s `signEscrowPsbt()`
      (`escrow-key.ts`) and 4 new `SailsSettlementModule` methods;
      minimal `sails-ui` wiring (`useEscrowKey`'s
      `signAndSubmitPendingTransactionIfNeeded()`, called speculatively
      whenever a MULTISIG/LIGHTNING_HODL escrow loads, plus
      `Trade.tsx`'s release button now calls `initiateRelease()` for
      MULTISIG instead of the old direct `release()`, which now correctly
      throws "not directly callable" for this type). Tests: extended
      `tests/multisigProvider.test.ts` (9 new, real PSBT
      build/combine/finalize), extended `tests/escrowProviderWiring.test.ts`
      (12 new, service-layer orchestration), extended
      `packages/sails-sdk/tests/escrow-key.test.ts` (3 new,
      `signEscrowPsbt()` cross-library interop) — 341/341 full suite green.
- [x] **LIGHTNING_HODL's own Phase 2 — done, 2026-07-27 (second follow-up
      pass, same day).** The open question this section previously
      deferred — does `@arkade-os/sdk`'s client-side signing primitive
      work standalone in a browser bundle, outside the full
      ASP-connected wallet machinery? — is now answered **yes**, verified
      three separate ways before writing any shipped code (this session's
      standing "verify, don't assume" discipline): (1) a standalone Node
      script proved `SingleKey.fromPrivateKey()` — an in-memory signer
      needing nothing but a raw private key, no seed/wallet/ASP
      connection — correctly signs, combines
      (`combineTapscriptSigs`), and verifies (`verifyTapscriptSignatures`)
      a real Ark offchain tx built via the real `buildOffchainTx()`; (2) a
      second script proved `@scure/btc-signer`'s `Transaction` (what
      `buildOffchainTx()` actually returns) round-trips through
      `.toPSBT()`/`Transaction.fromPSBT()` with everything `sign()` needs
      intact — the same PSBT wire format `multisig.provider.ts` already
      uses; (3) `esbuild --platform=browser` bundled `SingleKey` +
      `buildOffchainTx` + `combineTapscriptSigs` +
      `verifyTapscriptSignatures` + script-building helpers with zero
      Node-core imports in the output, and the REAL `sails-ui` Vite
      production build (not just a synthetic check) succeeded with
      `@arkade-os/sdk`/`@scure/btc-signer` actually included (889 modules
      transformed, up from 745 before).
      Implementation mirrors `multisig.provider.ts`'s Phase 2 exactly,
      adapted for Ark's shape: `lightning-hodl.provider.ts`'s new
      `buildUnsignedRelease()`/`buildUnsignedRefund()`/`finalizeRelease()`/
      `finalizeRefund()` build (but don't sign) the Ark tx + checkpoint(s)
      via the same `buildOffchainTx()` this file always used; the "PSBT"
      string handed back and forth is actually a JSON bundle
      (`{ arkTxPsbtBase64, checkpointsPsbtBase64[], expectedPubkeys[] }`)
      since an Ark offchain tx needs its main tx AND a per-input
      checkpoint tx signed/combined together, unlike a single Bitcoin
      PSBT — `escrow.service.ts`'s `SIGNATURE_COLLECTION_PROVIDERS`
      interface never inspects this string's contents, so the difference
      is invisible at the orchestration layer (registering
      `LIGHTNING_HODL` there was a one-line change — the whole
      `initiateRelease()`/`initiateRefund()`/`submitTransactionSignature()`/
      `getPendingTransaction()` flow is provider-agnostic already). On a
      `DISPUTED` release/refund, the arbiter's own required signature
      (still server-derived, unchanged from Phase 1) is pre-embedded into
      the bundle at build time. `@satsails/p2p-trading-sdk` gained `signEscrowArkTx()`
      (`escrow-ark-signing.ts`) — the Arkade equivalent of
      `signEscrowPsbt()`, using `SingleKey` + `@scure/btc-signer`'s
      `Transaction` instead of bitcoinjs-lib/ECPair, same client-held
      private key either way. `useEscrowKey`'s
      `signAndSubmitPendingTransactionIfNeeded()` now dispatches on escrow
      type (`signEscrowPsbt()` for MULTISIG, `signEscrowArkTx()` for
      LIGHTNING_HODL); `Trade.tsx`'s release button now handles both
      types, each with its own demo `toAddress` format (a real bech32
      testnet address for MULTISIG, a raw script hex for LIGHTNING_HODL —
      `lightning-hodl.provider.ts`'s own `toAddress` convention, unchanged
      from before this pass).
      **Disclosed, not silently glossed over:** as with the very first
      `LightningHodlProvider` build (this section's own earlier entry),
      the REST calls this pass adds (`RestArkProvider.submitTx()`/
      `.finalizeTx()`) are built against the real, documented
      `@arkade-os/sdk` API — the same client whose `getInfo()`/`getVtxos()`
      methods Phase 1 already exercises — but this pass, like every prior
      one touching this file, was not run end-to-end against a real
      funded mutinynet VTXO (this environment cannot originate real
      testnet Bitcoin funds); what WAS verified for real is everything
      upstream of that network call — the signing, serialization, and
      orchestration logic — via the three checks above plus 18 new
      Jest tests (`tests/lightningHodlProvider.test.ts`) against
      deliberately-fake-but-structurally-faithful stand-ins for
      `@arkade-os/sdk`/`@scure/btc-signer` (both pure ESM, cannot load
      under Jest at all — same reason this file's tests have always
      mocked them). 349/349 full backend suite green, 54/54 SDK suite
      green, `npm run build` clean across backend + `@satsails/p2p-trading-sdk` +
      `sails-ui`.

## 5. Liquidity Providers Beyond Internal

- [ ] External liquidity aggregation remains roadmap work. The historical HodlHodl stub was removed on 2026-08-09 (see `BACKLOG.md`, OpenLiquidity row); the current router registers only `InternalOrderBook`. No external provider is integrated. **Corrected 2026-11-28:** the historical item stated that `HodlHodlProvider.isAvailable()` always returns `false` and the integration is a stub; it described code that no longer exists.

## 5B. OpenAgents — QvacAgentProvider + BuyerAgent/SellerAgent *(section added QVAC/WDK MVP pass 2026-07-17, consolidated same day)*

- [x] `modules/open-agents/qvac-agent.provider.ts` (`QvacAgentProvider`) —
      OpenAgents' first real capability, previously 📋 Aspirational with
      zero code (`PROJECT_CONTEXT.md` §4). Uses the real `@qvac/sdk`
      (local LLM inference, `loadModel`/`completion`/`unloadModel`, no
      cloud dependency), matching `ARCHITECTURE.md`'s "risk analysis
      locally, without cloud dependency" description of the module.
      **Consolidated from an earlier, narrower `qvac-risk.service.ts`**
      (same day, follow-up pass) into one class every agent capability
      shares a model load/dispose cycle through — `assessIntentRisk()`
      (unchanged behavior, moved here), plus two new structured-generation
      capabilities: `generateTradeIntent()` and `generateOfferIntent()`.
      Live-verified in this environment: first call downloaded the model
      (LLAMA_3_2_1B_INST_Q4_0, ~737MB, ~167s); cached, later calls run in
      ~7-9s with coherent output.
- [x] `modules/open-agents/wallet-agent.ts` + `buyer-agent.ts` +
      `seller-agent.ts` — two local agents simulating two Satsails Wallet
      instances, each holding a real `participantId` and a stable
      `agentId` (distinct identifiers — `Intent.agentId` records *which
      agent* acted, `Intent.participantId` records *for whom*).
      `BuyerAgent.requestUsdtViaPix()` autonomously generates a real
      `TradeIntentPayload` (`common/types/intent.ts`, frozen since
      Protocol Freeze v8.8) from a plain-language goal — live-verified:
      `{"asset":"USDT_ERC20","side":"BUY","maxValue":"20.5","minValue":"0","currency":"BRL","fiatMethod":"PIX"}`,
      structurally valid against `core/intent-engine.ts`'s own
      `validateStructure()`. `SellerAgent.offerUsdtForPix()` is the
      symmetric capability for `liquidity.service.ts`'s offer shape
      (minus `priceUsd`, deliberately not QVAC's to decide — no live
      price feed, see that file's own doc comment). 5 tests in
      `tests/walletAgents.test.ts` (mocked `@qvac/sdk` — re-running the
      real ~737MB model on every `npm test` would make CI unusable; the
      live run above already proved the real SDK path works).
      `core/intent-engine.ts`'s `create()` now threads `agentId` through
      (the field already existed in `Intent`'s frozen shape and the
      Prisma schema, just was never wired to the one function that
      creates Intents — filling in already-specified surface, not new
      protocol surface, no RFC needed).
- [ ] **Still open:** these are narrow capabilities (structural-shape
      risk assessment, and turning a stated goal into a valid payload
      shape) — not the full OpenAgents module. No HTTP route exists for
      any of this — it's called directly from
      `examples/demo/pix-to-usdt-flow.ts` and the agent classes, not exposed
      over `/v1/agents/*` yet.
- [x] **RFC-007 D5 (Timeline) + D7 (Social Engineering Agent) — real as
      of RFC-017** *(same day, direct owner instruction: "Construir o
      Social Engineering Agent de verdade")* — `core/timeline.ts` (a
      real, `correlationId`-keyed read-model, corrected from D5's literal
      `intentId`-keyed interface — see RFC-017's own Motivation) backed
      by a new `EventStore.getEvents()` query capability;
      `social-engineering-agent.ts`'s `SocialEngineeringAgent.evaluate()`
      (D7's own interface) uses QVAC to detect 2 of 3 named patterns
      (`off_channel_migration`/`payment_instruction_change`) from real
      chat messages, raising a real `RISK_WARNING` in the trade's chat —
      detection only. Off by default
      (`config.features.socialEngineeringDetection`). See
      `docs/rfcs/RFC-017-timeline-and-social-engineering-agent.md` and
      `BACKLOG.md`'s own rows for the full detail, including what's
      still explicitly not built (`unexpected_flow_deviation` detection,
      real Policy Engine integration).
- [ ] **Model output quality caveat, observed directly, not theorized:**
      the smallest model in QVAC's registry (`LLAMA_3_2_1B_INST_Q4_0`,
      1B params) occasionally produces internally inconsistent or
      degenerate output — `risk: "high"` paired with
      `recommendation: "proceed"` in one risk-assessment run;
      `minValue: "0"` and a `SellerAgent` offer with
      `minAmount === maxAmount` in the live BuyerAgent/SellerAgent run
      above. Expected behavior for a model this small, not a bug in the
      integration — every one of these outputs is still structurally
      valid JSON matching the requested schema, just not always a
      *sensible* value. A production deployment gating real money
      movement on agent-generated amounts should evaluate a larger model
      and/or add explicit range sanity checks before trusting these
      values, beyond the structural validation `intent-engine.ts` already
      does.

## 6. Rate Limiting & API Keys (status changed — per-IP resolved)

- [x] `@fastify/rate-limit` is real *(2026-07-18)* — global default
      (`config.rateLimit.max`/`timeWindow`, 100/min per IP) plus a
      tighter, independently-tracked override on the two identity
      challenge/authenticate routes (`config.rateLimit.authMax`/
      `authTimeWindow`, 10/min per IP each — the routes a credential-
      stuffing attempt actually hits, RED_TEAM_REVIEW.md RT-002). Found
      and fixed a real bug while wiring this: `app.ts`'s error handler
      previously flattened every non-`ZodError`/non-`AppError` to a
      generic 500, silently turning the rate-limit plugin's real 429
      into a misleading one — now any error carrying its own valid
      4xx/5xx `statusCode` is respected. Verified in
      `tests/rateLimit.test.ts` (4 tests, isolated `buildApp()` instance
      so its deliberately-exceeded limits don't pollute `routes.test.ts`'s
      shared counter) — 159 tests project-wide, all passing.
- [ ] **Still open:** per-API-key tiers (only per-IP exists today); a
      deployment behind a reverse proxy needs Fastify's own `trustProxy`
      option configured separately for `request.ip` to reflect the real
      client, not the proxy.

## 7. Intent Engine Tables (status changed — mostly resolved)

- [x] `Intent` and `IntentEvent` tables exist in `schema.prisma` and are
      real, verified via `npm run build`/`npm test`/HTTP round-trip
      (`BACKLOG.md` P0). This is 2 tables, not the 3 originally sketched
      in `PROTOCOL_SPECIFICATION.md` §2.6 — that section explains why a
      separate `intent_payloads` table wasn't needed.
- [x] `core/coordination-engine.ts`'s stub is resolved — `decide()` is now
      real (RFC-012, `rfcs/RFC-012-intent-validation-and-coordination.md`).
      `intent-engine.ts`'s `create()` runs `CREATED → VALIDATED →
      COORDINATED` through the existing hash-chained `transition()`
      mechanism, so `create()` now returns an Intent in `COORDINATED`
      status rather than `CREATED`. `IntentStatus` also had a duplicate
      declaration (`common/types/intent.ts` and `core/state-machine.ts`
      each defined their own) — fixed as part of the same RFC:
      `common/types/intent.ts` is now the single source of truth,
      `state-machine.ts` imports and re-exports it. `policy-engine.ts`'s
      governed-policy interface and `capability-registry.ts` remain
      untouched stubs — `coordinationEngine.decide()` does not consult
      either, a deliberate scope decision documented in RFC-012's
      Alternatives Considered.
- [x] `core/capability-registry.ts`'s stub is resolved — real
      `grant()`/`check()`/`revoke()`/`listGrants()` against a new
      `CapabilityGrant` Prisma table, plus real routes
      (`POST /v1/capabilities/register`, `GET /v1/capabilities/:participantId`,
      `POST /v1/capabilities/:grantId/revoke`) *(new — RFC-013,
      `rfcs/RFC-013-capability-registry-and-wallet-adapter.md`,
      2026-07-18)*. `coordinationEngine.decide()` still doesn't consult it
      (RFC-012's scope cut, unrevisited) — this closed the "the registry
      itself doesn't exist" half of that gap, not the "nothing calls it
      yet" half (that half closed by RFC-014 below). `policy-engine.ts`'s
      governed-policy interface remains the one still-untouched stub among
      the 6 formal Core components.
- [x] **Capability Registry actually has real callers now** *(new —
      RFC-014, `rfcs/RFC-014-capability-registry-enforcement.md`,
      2026-07-18; relocated by RFC-015 the same day — see next item)* —
      the "nothing calls it yet" half of the gap above.
      `intentEngine.create()` (TradeIntent) and
      `escrow.service.ts`'s `releaseFunds()` (immediately before the real
      USDT release, the highest-stakes line in that file — originally
      checked inside `settlement-orchestrator.ts`, moved into
      `releaseFunds()` itself once RFC-015 found that location missed two
      of its three real callers) both check `capabilityRegistry.check()`
      now, behind a new `config.features.enforceCapabilities` flag
      (`ENFORCE_CAPABILITIES`, default `false` — same off-by-default
      precedent as `AUTO_SETTLE_ON_MATCH`, since no deployment or test in
      this repo has ever issued a `CapabilityGrant`). `npm run demo:qvac`
      issues the two grants it needs unconditionally, so it works either
      way the flag is set. Still open: `coordinationEngine.decide()`
      itself doesn't consult the registry (unchanged from RFC-012's scope
      cut); no route/CLI for an operator to issue grants in bulk (still
      one self-issued `POST /v1/capabilities/register` call at a time).
- [x] **`IntentHandler` plugin registration pattern (§2.7) — done
      (2026-07-20), RFC-018 Phase 3.** `modules/open-p2p/intent-handler.ts`'s
      `OpenP2PTradeIntentHandler` is the first real, registered handler —
      `TradeIntent`'s field validation moved out of `intent-engine.ts`'s
      `validateStructure()` (which now just dispatches to
      `handlers.get(type)`) and into the module, registered at boot in
      `app.ts` next to `registerEventHandlers()`. Behavior-preserving —
      `npm run build` clean, `npm test` 222/222, no test count change.
- [x] **Real gap found 2026-07-19 by a CTO-directed fidelity audit**
      ("a implementação está respeitando o modelo de Intent definido na
      especificação?" — not a design question, an audit of the shipped
      code against it), **fixed the same day.** No real `Offer` or
      `Trade` had an `Intent` row behind it — `liquidity.service.ts`'s
      `createOffer()` never called `intentEngine.create()`;
      `trade.service.ts`'s `createTrade()` never imported
      `core/intent-engine.ts` at all — directly contradicting
      `PROTOCOL_SPECIFICATION.md` §1.11's claim that a published `Offer`
      "is OpenLiquidity's concrete database artifact representing a
      published, discoverable Intent." **RFC-018**
      (`docs/rfcs/RFC-018-intent-as-canonical-trade-entry-point.md`,
      Core RFC) registered the target architecture, then Phases 1-2
      were implemented in the same pass: `Offer`/`Trade` gained a
      nullable `intentId` FK; `createOffer()` creates a real `Intent`;
      `createTrade()` walks it through `DISCOVERING → MATCHED →
      NEGOTIATING`; `common/events/handlers.ts`'s three
      `settlement.escrow.*` reactions drive `COMMITTED`/`SETTLING → 
      FULFILLED`/`FAILED`. Corrected from the RFC's own original draft
      during implementation: `COMMITTED` fires at escrow-lock time
      (matching §3.1's already-accepted mapping), not at trade
      creation, and no `intent-engine.ts` ownership-check change was
      actually needed. `npm run build` clean, `npm test` 212/212 (5 new
      tests). **Not yet applied to a live database** — schema edited,
      `npx prisma generate` run, but no Postgres reachable in this
      environment to run a real migration; needed before this code path
      works outside tests. Phase 3 (`OpenP2PTradeIntentHandler`, §2.7)
      remains deferred — a refactor of already-working logic, not a
      blocker.
- [x] **Second pass, same day (2026-07-19), CTO-directed follow-up**
      ("garantir que os testes cubram cenários de falha: escrow não
      bloqueado, trade cancelado, settlement falho, disputa durante
      negociação"). Live-PostgreSQL migration validation itself could
      not be performed — no Docker/Postgres reachable in this sandboxed
      environment (same limitation as Redis/live-WDK-testnet elsewhere
      in this project); that piece is deferred to the sócio dev's infra
      pass per the established division of labor. What was done instead:
      (1) **real bug found and fixed** — `trade.service.ts`'s
      `updateStatus()` left a cancelled Trade's Intent stuck at
      `NEGOTIATING` forever; now transitions it to `CANCELLED`. (2)
      **real bug found and fixed, more severe than the scenario asked
      for** — investigating "disputa durante negociação" surfaced that
      `Trade.escrowId` was **never persisted anywhere in the live code
      path**: `escrow.service.ts`'s `createEscrow()` emits
      `settlement.escrow.created` but its own module-boundary rule
      (OpenSettlement may read `Trade`, never write it) forbids setting
      `Trade.escrowId` itself, and no handler in
      `common/events/handlers.ts` ever reacted to that event to do it —
      meaning `dispute.service.ts`'s `raiseDispute()` guard
      (`if (!trade.escrowId) throw ...`) rejected **every** dispute
      unconditionally against a real database, regardless of trade
      status. Not merely "disputes during negotiation are blocked" —
      disputes were blocked, period. Fixed by adding the missing
      `settlement.escrow.created` handler. (3) escrow-lock provider
      failure confirmed already correctly handled by existing control
      flow (fails before persisting/emitting) — added as a regression
      test, no code change needed. `npm run build` clean, `npm test`
      216/216 (4 new tests this pass).
- [x] **Third pass, same day (2026-07-19), CTO-directed follow-up**
      ("RFC-018 validation pass aprovado... validar o fluxo completo
      end-to-end do Sails P2P Trading SDK com persistência real e
      integração dos providers"). Real Postgres persistence + real WDK/
      HyperDHT provider integration still could not be executed — same
      no-Docker/no-live-network constraint as every other pass this
      session; unchanged, still the sócio dev's infra job. What was
      built instead, the strongest available substitute:
      `tests/fullTradeLifecycle.test.ts` — every other test file in this
      suite mocks at a single service boundary (routes.test.ts stubs
      `eventBus.emit` to a no-op so cross-module reactions never fire;
      `reputationOutcome.test.ts` mocks `intentEngine` wholesale). This
      file instead chains the REAL service layer end to end — Intent
      created → Offer published → discovered via the real order-book
      aggregation → Trade born → escrow locked/paid/released via the
      real `settlement-orchestrator.ts` → Reputation updated — with the
      REAL `eventBus` (`InMemoryEventStore`, RFC-010's always-available
      default, no Redis needed) actually dispatching to the REAL
      `registerEventHandlers()` reactions. Only the database (an
      in-memory fake standing in for Prisma) and the two genuinely-
      external providers (WDK/HyperDHT) are replaced. A second test in
      the same file drives a dispute through the real chain after escrow
      locks, directly proving the `Trade.escrowId` fix above holds
      end-to-end, not just at the handler level.
      **Found one more real bug this way** — the kind a per-boundary
      mock can't catch: `dispute.service.ts`'s `resolveDispute()` called
      `escrowService.releaseFunds()`/`refundFunds()` (which emit the
      events `common/events/handlers.ts`'s RFC-007 D8/D9 dispute-aware
      reputation branch reacts to) **before** marking the `Dispute` row
      `RESOLVED` — that branch's own `prisma.dispute.findFirst({ status:
      'RESOLVED', ... })` query always raced this function's own
      not-yet-run update and lost, so every disputed resolution was
      silently scored as an ordinary no-dispute outcome (both parties
      POSITIVE/NEUTRAL) instead of RFC-007 D8/D9's specified asymmetric
      win/loss. Existing unit tests never caught this because they all
      mock `resolveDispute()`'s internals directly, assuming the dispute
      was already resolved by the time the handler runs — only a real
      chained call exercises the actual order of operations. Fixed by
      marking `RESOLVED` before moving funds, with a revert-on-failure
      path (`status` back to `OPENED`, `ruling`/`resolvedAt` cleared) so
      a failed fund movement doesn't leave a dispute falsely claiming
      resolution. `npm run build` clean, `npm test` 218/218.
- [ ] **Related, more severe finding from the same audit — a real
      Constitutional Invariant violation, not a documentation gap:** the
      one real, tested `SettlementProvider` (`WdkSettlementProvider`,
      `wdk-settlement.provider.ts`, marked `[x]` above as shipped) signs
      every escrow release from **one server-held seed phrase**
      (`WDK_SEED_PHRASE`) — no user-supplied signature or credential is
      needed for `releaseFunds()` to succeed. This violates
      `PROTOCOL_INVARIANTS.md` Constitutional Invariant 2 ("The Protocol
      Never Custodies Assets") and `SECURITY_MODEL.md` §2 Principle 2
      ("User Always Signs") **in the one real settlement path this
      codebase ships today.** It was already disclosed at the code-comment
      level (`wdk-settlement.provider.ts`'s own header: "a single-seed,
      two-hop escrow, not a trustless multisig") but no document above
      the code said so plainly until this audit — `SECURITY_MODEL.md`,
      `PROTOCOL_INVARIANTS.md`, `TRUST_BOUNDARY.md`, and
      `CRYPTOGRAPHIC_MODEL.md` §5 all now state it explicitly.
      **Blocking for any production/mainnet use with real value** — do
      not represent `WDK_USDT_EVM` as satisfying the protocol's
      non-custodial invariant until a real multisig/threshold-signature
      `SettlementProvider` for EVM exists, or scope `WDK_USDT_EVM`
      explicitly to testnet/demo use only. **RFC-019**
      (`docs/rfcs/RFC-019-settlement-custody-reference-vs-normative.md`,
      accepted 2026-07-19, CTO-role review approved as P0/blocking)
      registers this reclassification and a 2-phase migration plan.
      **Phase 1 done (2026-07-19, Implementation Freeze — first real
      code from either Core RFC):** `WdkSettlementProvider.custodyModel`,
      a boot-time warning (`app.ts`'s `startServer()`) whenever
      `MOCK_ESCROW=false`, `.env.example` disclosure, `API_REFERENCE.md`
      pointer — purely additive, no behavior change, `npm test` 207/207.
      **Phase 2 is no longer unscoped (2026-07-28): RFC-020**
      (`docs/rfcs/RFC-020-non-custodial-evm-settlement.md`, accepted)
      registers the real target design and real, tested interfaces —
      `SailsEscrowSafe.sol` (a Safe Transaction Guard + ERC-4337, compiles
      clean against real audited dependencies, not deployed to any
      network), plus `@satsails/p2p-trading-sdk`'s `ERC4337CustodyProvider`,
      `BitcoinCustodyProvider`, and `SailsSignerService` (AWS KMS
      co-signer) with real, independently-verified cryptographic logic
      (`packages/sails-sdk/tests/custody-*.test.ts`). **Wired in as a
      real, registered fifth `SettlementProvider` (2026-07-28, same-day
      follow-up):** `SAFE_GUARD_EVM` (`safe-guard-evm.provider.ts`) is
      now in `escrow.service.ts`'s `PROVIDERS`/`SIGNATURE_COLLECTION_PROVIDERS`
      maps, following MULTISIG's exact client-held-keys +
      signature-collection-route pattern (no new routes needed —
      `initiate-release`/`initiate-refund`/`submit-transaction-signature`
      are already generic over `escrow.type`). Real, tested: UserOperation/
      userOpHash construction (importing `@satsails/p2p-trading-sdk`'s `getUserOpHash()`
      rather than a second hand-written copy — client and server must
      hash identically for a signature to verify), and real signature
      recovery + Safe's actual ascending-address-sorted packed-signature
      combination (20 tests, `tests/safeGuardEvmProvider.test.ts`).
      **`lockFunds()`/`verifyLock()`/`broadcast()` now real (2026-08-01,
      multisig-coverage-per-asset audit follow-through):** real CREATE2
      address prediction for both the Safe (`predictSafeAddress()`,
      `SafeProxyFactory.createProxyWithNonce()`'s own formula, transcribed
      from its real source) and the Guard (`predictGuardAddress()`, via
      the well-known EIP-2470-style deterministic deployer); real
      `provider.getBalance()` checks for `lockFunds()`/`verifyLock()` (same
      non-custodial "verify external funding, don't move it" shape
      MULTISIG already uses); real `eth_sendUserOperation` bundler
      submission in `broadcast()`. Every hardcoded contract address (Safe
      v1.4.1, Safe4337Module v0.3.0, SafeModuleSetup, MultiSendCallOnly,
      the deterministic deployer) was cross-checked against
      `safe-deployments`'/`safe-modules-deployments`'s own registry AND a
      live `eth_getCode` call against Sepolia; `SafeProxy`'s creation
      bytecode (needed for CREATE2 prediction) was additionally confirmed
      byte-for-byte identical to the real factory's own live
      `proxyCreationCode()` return value. **Guard-attachment design
      (the actual remaining engineering gap this pass closed):**
      `Safe.setGuard()` can only be called via a Safe-authorized self-call
      (`SelfAuthorized.sol`), so it needs the same 2-of-3 signature flow
      release/refund already use — rather than a new, separate signing
      round (materially bigger: new pending-transaction kind, new routes),
      `setGuard()` is folded into the SAME UserOp as the terminal
      release/refund transfer via a `MultiSendCallOnly` batch, safe
      specifically because the Safe's guard state is read once before
      either batched call executes, and the transaction's content is
      fixed by the server before any signature is requested — see
      `safe-guard-evm.provider.ts`'s own header comment for the full
      reasoning. 31 tests (`tests/safeGuardEvmProvider.test.ts`, RPC/bundler
      mocked, all CREATE2/ABI-encoding logic real). **Still disclosed, not
      fabricated:** none of this has been exercised against a live funded
      Sepolia account or a live bundler in this environment — same
      "verified structurally, not end-to-end" boundary as always. Deriving
      a Safe/Guard address now unconditionally needs `AWS_KMS_KEY_ID`
      configured (a read-only KMS `GetPublicKeyCommand`, never `Sign`) —
      a real, disclosed change from the previous "cooperative path needs
      no AWS access at all" claim, which only ever applied to co-signing,
      not to knowing the arbiter's own address (the Safe's owner list is
      fixed at deployment regardless of dispute status). `WdkSettlementProvider`
      itself is untouched and still signs from the single server-held
      seed — `SAFE_GUARD_EVM` is a new, parallel provider, not a
      replacement, and no escrow is forced onto it. No committed date for
      a third-party audit, real deployment, or cutover.

## 8. SDK (status changed — v0.1 real, partial) *(2026-07-17)*

- [x] `@satsails/p2p-trading-sdk` (`packages/sails-sdk`) now exists — real npm workspace
      package, wired into root `package.json`'s `workspaces`/`build`
      scripts. `SailsClient`'s Transport layer (real `fetch`/`WebSocket`,
      no Node-only dependency — works in both Node and browser per
      `SDK_GUIDE.md` §6) and Protocol SDK layer (`identity`,
      `reputation`, `liquidity`, `openp2p`, `settlement`, `peers`) are
      genuinely implemented against the reference implementation's real,
      tested routes — each verified against its actual `*.routes.ts`
      file, not assumed from `API_REFERENCE.md`'s prose (found and
      documented two real deviations that way: `createIntent` needs an
      explicit `participantId`, `openp2p.trade()` needs `amount` — see
      `SDK_GUIDE.md` §2's note). `identity.authenticate()`'s Ed25519
      signing (`tweetnacl`, pure JS) was checked byte-for-byte against
      `src/common/middleware/auth.ts`'s exact verification logic (a
      subtle double-hex-encoding quirk) and confirmed to actually work
      against the real server-side verify function, not just assumed
      compatible — `packages/sails-sdk/tests/identity.test.ts` asserts
      this directly. 46 tests total across 6 files as of 2026-08-07, all mocking only the
      network boundary (`fetchImpl`/`webSocketImpl` injection, no global
      mocking) — `npm run build`/`npm test` both verified clean (57
      suites, 689 tests project-wide as of 2026-08-07).
- [x] **`WalletAdapter` + `client.capabilities`** *(new — RFC-013,
      `rfcs/RFC-013-capability-registry-and-wallet-adapter.md`,
      2026-07-18)* — `packages/sails-sdk/src/wallet-adapter.ts`: an
      optional constructor argument (`SailsClientOptions.wallet`) so a
      wallet's own signing/balance/address logic can plug into the SDK,
      which v0.1 had no such layer for at all (every v0.1 module only
      ever made HTTP/WS calls). `getPeerId()`, not `getNodeId()` — matches
      this codebase's own existing vocabulary instead of introducing a
      synonym. `client.capabilities.registerFromWallet(wallet)` derives
      a `trade-coordination` grant's scope directly from
      `wallet.getCapabilities()`. 7 new tests
      (`packages/sails-sdk/tests/capabilities.test.ts` +
      `client.test.ts` additions) — 40 SDK tests total, 155
      project-wide.
- [x] **`dispute` closed for real (2026-07-20, §21 below has the full
      writeup).** Of the six-verb Intent facade (`SDK_GUIDE.md` §2),
      `createIntent`/`cancelIntent`/`dispute` are now real.
      `negotiate`/`releaseAsset` still throw `SailsNotImplementedError`
      — **not** for the "no server-side linkage" reason this item used
      to give (RFC-018 closed that), but for two different, more precise
      reasons found while fixing `dispute`: `negotiate`'s canonical
      signature can't represent a persistent `WebSocketChannel`, and
      `releaseAsset`'s canonical signature is missing a destination-
      address parameter the one real release route requires. Neither is
      "just SDK code" — both need a `SDK_GUIDE.md` shape decision first.
      `submitProof` is still correctly blocked on the Proof primitive
      itself (zero routes — the `Claim`/`Proof`/`EvidenceVerification`
      tables already exist, only `proof.service.ts` and its routes
      don't).
      `@sails/protocol-spec` also still does not exist — v0.1 defines its
      own local response types (`packages/sails-sdk/src/types.ts`)
      rather than reconciling with `@satsails/p2p-schemas`'s differently-
      shaped `OfferSchema`, a documented, deliberate deferral (that
      file's own header), not an oversight.

## 9. Monorepo Structure (status changed — first package landed)

- [x] `packages/sails-p2p-schemas` (`@satsails/p2p-schemas`) exists — the
      first real npm workspace package, wired via root `package.json`'s
      `"workspaces": ["packages/*"]`. See `BACKLOG.md` P1.
- [ ] **Still open:** the full `packages/` / `apps/` split from
      `ARCHITECTURE.md` section 6 — everything else still lives flat under
      `src/`. A `Months 10-12` roadmap item, not urgent, but don't invent a
      different structure ad hoc if you start this early.

## 10. Tests (status changed — no longer zero)

- [x] `tests/intentFlow.test.ts`, `tests/transportFallback.test.ts`,
      `tests/disputeFlow.test.ts` exist and pass — 28 tests across the
      Intent Engine, transport fallback, and dispute flow. `jest`/`ts-jest`
      are real dependencies now, not just a `package.json` script pointing
      at nothing.
- [x] `tests/routes.test.ts` *(new — route-restoration pass, 2026-07-16)*
      — 26 `app.inject()` HTTP round-trip tests through the real routes
      added in this pass (identity, peers, liquidity, trade, chat,
      settlement, reputation), Prisma/Redis/eventBus/`pearNodeRegistry`
      mocked, same pattern as the other suites. Caught two real bugs
      before they shipped: `verifySignedChallenge()` not returning its
      session token (see section 3), and the chat message-history route
      having no auth at all while the WebSocket side already restricted
      it to the trade's two parties — both fixed, not just found.
- [x] `tests/reputationOutcome.test.ts` *(new — open-reputation pass)* —
      4 tests verifying the RFC-007 D8/D9 dispute-aware branching in
      `common/events/handlers.ts` directly: happy-path completion vs. a
      RELEASE dispute ruling, plain refund vs. a REFUND dispute ruling.
      Confirms the "winner gets Positive, loser gets Negative, no dispute
      means Neutral" rule actually holds, not just that the code compiles.
- [x] `tests/chatUnification.test.ts` *(new — chat-unification pass)* —
      3 tests confirming a message "arriving" via either transport
      (simulated `HumanChatChannel`/Pears emit, or the WS route's own
      emit) reaches every WS room member for that trade, and that
      broadcasting to a trade nobody's watching doesn't throw. Uses the
      real `chat-room-registry.ts`, not a mock, so this is exercising the
      actual join/broadcast code, not just asserting a function was
      called.
- [x] 2 more cases added to `tests/routes.test.ts` *(WS → Pears
      follow-up pass)* — first real use of `app.injectWS()` in this
      codebase's test suite, a genuine WS round-trip through
      `chat.routes.ts`'s route (not a mock of the handler). Found and
      fixed a real test-infra issue along the way, not a product bug:
      `ws.close()` on the injected client left a pending close-handshake
      handle that made `jest --runInBand` (this repo's actual `npm test`
      command) hang past its 1s exit check; `ws.terminate()` (immediate
      teardown, appropriate for tests) fixed it. Also found that
      `chatUnification.test.ts` and `reputationOutcome.test.ts` had no
      top-level `import`/`export`, making TypeScript treat them as
      scripts sharing the global scope — their identically-named
      `const mockUserUpdate`/`handlers` collided under some jest
      invocations (`--detectOpenHandles` surfaced it, plain `npm test`
      didn't). Fixed with a top-level `export {}` in both files.
- [x] `tests/payloadCrypto.test.ts` + `tests/intentTransport.test.ts`
      *(new — direct P2P Intent delivery pass, 2026-07-17)* — 8 tests
      total. `payloadCrypto.test.ts` (4) is real cryptography end to end:
      real `HyperDHT.keyPair()` keypairs, real Ed25519→Curve25519
      conversion, real libsodium sealed-box round-trip, plus wrong-key and
      tampered-ciphertext rejection — none of this needs a live network,
      so none of it is mocked. `intentTransport.test.ts` (4) verifies
      `PearsTransportProvider.sendIntentToPeer()`'s composition logic
      (topic join, connected-peer-first / Postgres-directory-fallback
      resolution, no-peerId-found short-circuit) with `pear.service.ts`
      and Postgres mocked — same discipline `transportFallback.test.ts`
      already established for anything that would otherwise need a real
      P2P network to verify.
- [ ] **Still open, in the priority order `BACKLOG.md` P0/P2 imply:**
      escrow state machine transitions beyond what `disputeFlow.test.ts`
      already covers, and liquidity matching (`open-liquidity`) — no
      dedicated test files yet.

## 11. Frontend (status changed — skeleton + real brand identity landed) *(2026-07-18)*

- [x] **`packages/@sails/ui`** *(new)* — a real, navigable 9-screen React
      + Vite + TypeScript + React Router app (Marketplace, Offer Detail,
      Trade with chat + escrow state machine, Login, Profile, Trade
      History, Admin Dashboard, Manage Offers, Disputes). Every screen
      reads `src/data/mock.ts` — no `@satsails/p2p-trading-sdk` call happens anywhere
      in this package yet; every read site has a
      `// TODO: replace with @satsails/p2p-trading-sdk ...` comment naming the real
      method. Manually verified in a real browser (not just
      `npm run build`) — found and fixed one real bug this way: an
      effect-ordering race in `AuthContext` that bounced a logged-in
      session back to `/login` on a hard navigation to `/profile`
      (React runs effects child-to-parent on mount; a `useEffect`-based
      localStorage read lost that race against `Profile`'s own
      "redirect if no user" effect — fixed with a lazy `useState`
      initializer instead, which `tsc`/build type-checking alone would
      never have caught).
- [x] **Real black + orange brand identity, light and dark theme**
      *(same day, requested directly)* — `src/index.css`'s CSS custom
      properties define the full palette for both themes (`:root`/
      `:root.dark`), toggled by `ThemeContext` (defaults to system
      preference, persisted to `localStorage`, same lazy-`useState`
      pattern `AuthContext` uses for the same effect-ordering reason).
      Orange (`#f97316`) stays constant across both themes. A handful of
      component classes (`.card`, `.btn-primary`, `.input-field`, etc.,
      `@layer components`) centralize the theme so a white-label partner
      edits ~8 rules later, not every file — see the package's own
      `README.md`.
- [x] **Binance P2P-style Marketplace filters** *(same day)* —
      `AssetPicker` (search-based, replacing a lateral pill row that
      doesn't scale past a handful of assets), `CurrencyPicker`
      (BRL/USD/EUR/... — generalizes the real but narrower
      `Offer.priceBrl` field, honestly flagged as presentation-layer in
      `types.ts`'s own comment), and `FilterPanel` (a drawer with the
      exact requested option set — save filter, negotiable-only,
      high-reputation-only, previously-traded, amount presets by
      currency, payment time limit, payment method, country/region, sort
      by — each with an "i" `InfoTooltip`). Three of the filter
      predicates (`negotiableOnly`/`highReputationOnly`/
      `previouslyTradedOnly`) run against UI-only demonstration fields
      on `Offer` — a real version needs a real block-list and
      trade-history join, neither exists in the backend yet.
- [x] **Agent QVAC interaction reflected in the UI + chat image/video
      attach** *(same day, requested directly)* — `AgentIntentionPanel`
      (Marketplace) and `AgentRiskCard` (Trade) mock the shape of the
      real `QvacAgentProvider`/`BuyerAgent`/`SellerAgent`
      (`src/modules/open-agents/*.ts` — a real local LLM via `@qvac/sdk`,
      no cloud dependency) since no HTTP route exposes that code to a
      browser yet; today it only runs in the demo script and
      `intent-engine.ts`'s own validation. `ChatWindow`'s new 📎 button
      lets a user attach an image/video, rendered inline in
      `ChatMessage` — a local `URL.createObjectURL()` blob only, nothing
      is transmitted. **The agent-HTTP-route gap closed 2026-08-09** —
      `POST /v1/agents/generate-trade-intent`/`generate-offer-intent`/
      `assess-intent-risk` (`agent.routes.ts`, `API_REFERENCE.md` §7D)
      wrap `qvacAgentProvider`'s methods for real, and `sails-ui`'s
      `qvacAgent.ts` was updated the same day to call them instead of
      simulating — `AgentIntentionPanel`/`AgentRiskCard` no longer mock
      the shape, they call the real thing. The media-attach gap below
      is unrelated and still open: for media, an upload/storage step
      step (`Message.content` is Postgres text, unsuited to a raw video
      blob — `msgType` itself needs no migration, it's already a
      free-form `String`) plus a Pears event kind carrying a media
      reference (today's WS→Pears relay in `chat.routes.ts` only
      forwards plain text). See `packages/sails-ui/README.md` for detail
      and the real bug found while building this (an `InfoTooltip`
      button nested inside another button — invalid HTML, caught by a
      browser console warning, not `tsc`).
- [x] **RFC-016 (Crypto-Native Agent boundary) + "AI Negotiator" mandate
      UI** *(same day, direct owner instruction: "O QVAC nunca deve
      tocar em PIX. Essa decisão precisa ser arquitetural")* — formalizes
      an invariant already true by construction (no code in this repo
      has ever called a banking API) as an explicit RFC
      (`docs/rfcs/RFC-016-qvac-crypto-native-agent-boundary.md`):
      QVAC/`BuyerAgent`/`SellerAgent` only act on digital assets via WDK,
      never on fiat rails; conversion is a regulated on/off-ramp
      provider's job, outside Sails Protocol's scope. Propagated into
      `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `SDK_usecases.md`, and
      code comments in `qvac-agent.provider.ts`/`buyer-agent.ts`.
      `AgentIntentionPanel` renamed to lead with "🤖 AI Negotiator" and
      gained a bounded delegation mandate (quantity, limit price,
      deadline, tolerance, Negotiation Profile —
      Conservative/Balanced/Aggressive/Instant,
      `packages/sails-ui/src/lib/aiNegotiator.ts`) plus a mocked live
      negotiation view (status timeline, Agent Strategy panel) with a
      permanent "🛑 Parar Agente / Assumir Controle" stop control —
      verified in browser including mid-run interruption. Still a
      client-side simulation only; no backend accepts a mandate shaped
      like this yet (`packages/sails-ui/README.md` "Next steps").
- [x] **Offer publishing wizard + six cold-start UX fixes** *(same day,
      direct owner instruction: referenced RFC-017's documentation rigor
      and a Binance "Publicar Anúncio" screenshot for the wizard; then
      "está fidedigno o suficiente para achar os furos de UX?" →
      "Tudo da lista" for the fixes)* — `PublishOffer.tsx` is a 3-step
      wizard (tipo/preço → valor/método → condições) writing through
      `lib/offersStore.ts` (`getAllOffers()`/`addOffer()`, localStorage
      over the static `MOCK_OFFERS`) so a published offer shows up
      immediately in Marketplace/Profile/OfferDetail. A second cold-start
      walkthrough (clear `localStorage`, click through as a first-timer)
      then found and fixed 6 more real bugs, 2 critical: self-trading was
      possible (no `user.id === offer.userId` check anywhere); AI
      Negotiator's currency parser was hardcoded to BRL regardless of
      the goal text, silently producing zero-match Marketplace filters.
      Also fixed: no login/wallet indicator on mobile; Login screen led
      with "keypair Ed25519"/"WDK" jargon instead of plain language;
      raw backend enums (`USDT_ERC20`, `BANK_TRANSFER`, ...) rendered
      verbatim in several components instead of friendly labels; and a
      redundant duplicate price line in `OfferDetail`. Full detail and
      the fix for each in `packages/sails-ui/README.md`.
- [x] **Order history (date/time + cancel) + identity key clarity**
      *(same day, direct owner instruction: "minhas ordens tem que ter
      data e horario... e o usuario poder... remover a ordem", checked
      against Binance/Bisq/HodlHodl/El Dorado/P2P.me; separately "não
      fica claro se é minha chave Pears" after seeing Keet's unlabeled
      Public Key)* — `Profile.tsx`'s "Minhas Ofertas" now sorts
      newest-first, has status filter chips, shows `Criada em
      {formatDateTime}`, and gained Pausar/Ativar/Cancelar actions
      (destructive cancel gated behind an inline confirm, no browser
      `confirm()`); `lib/offersStore.ts` gained `updateOfferStatus()` — a
      status-only localStorage override, mirroring the real backend's
      actual `PATCH /v1/liquidity/offers/:id/status` (never a DELETE,
      matching how all 5 reference platforms actually behave). Doing
      this surfaced a second real bug immediately: `Marketplace.tsx`
      never filtered by `status`, so a just-cancelled offer stayed
      listed for sale — fixed with an `status !== 'ACTIVE'` check.
      Separately, `user.publicKey` was shown with no label at all;
      labeled "Sua chave de identidade (Pears / P2P)" with an
      `InfoTooltip` — genuinely the same key, not a simplification:
      `PearNode.getKeyPair()`'s Ed25519 keypair *is* the identity
      keypair (`docs/ARCHITECTURE.md`), used both for auth signing and
      as the Hyperswarm/HyperDHT P2P identity. See
      `packages/sails-ui/README.md` for full detail.

## 12. Deployment

- [ ] `docker-compose.yml` referenced in `DEPLOYMENT.md` does not exist in
      this environment and needs to be (re)created.
- [x] **CI/CD pipeline** *(new — handoff-readiness pass, 2026-07-17)* —
      `.github/workflows/ci.yml` runs `npm run build` + `npm test` on
      every push/PR to `main`, Node 20.x/22.x matrix. `.github/dependabot.yml`
      opens weekly dependency-update PRs. Neither needs live
      Postgres/Redis — every test in this repo mocks its own network/
      database boundary already.

## 13. Resolved Items (do not redo these — verify they're intact, don't rebuild)

- [x] Event bus namespacing (`{module}.{entity}.{action}`) — done
- [x] `moduleId`/`protocolVersion` in schema — done
- [x] Escrow service decoupled from Trade/User direct writes — done, logic
      moved to `common/events/handlers.ts`
- [x] `pear.service.ts` moved from Domain to Infrastructure layer — done
- [x] `PearPeerManager` singleton bug — done, replaced with
      `PearNode` + `PearNodeRegistry`
- [x] Dead message handlers (`OFFER_ANNOUNCE`, `CHAT_MESSAGE` no-ops) — removed
- [x] Duplicated offer-mapping logic in `liquidity.service.ts` — extracted
      into `mapOfferToLiquidityOffer()`
- [x] Module folder naming (`escrow/`, `identity/`, `routing/` → official
      `open-settlement/`, `open-liquidity/`) — done for the files that exist
- [x] `config/index.ts`, `common/database/index.ts`, `common/redis/index.ts`,
      `common/errors/index.ts` — all exist and are wired into `app.ts`
      (previously listed as missing in section 1/2 — that was stale)
- [x] Event Bus updated for RFC-003/RFC-004 — `claim.*`, `proof.*`,
      `verification.*`, `dispute.*`, and `negotiation.*` events all added
      and typed (previously flagged as out of sync in section 6B — that
      section is now closed and removed from this list)
- [x] `Intent`/`IntentEvent` Prisma tables — see section 7
- [x] `packages/sails-p2p-schemas` workspace package — see section 9
- [x] Jest test framework + 3 real test suites — see section 10
- [x] Ed25519 challenge-response auth middleware (`common/middleware/
      auth.ts`) — built and wired to every write-side route (see section 3)
- [x] `modules/open-identity/identity.routes.ts` + `identity.service.ts` —
      register/challenge/authenticate/get participant, per
      `API_REFERENCE.md` §2
- [x] `infrastructure/p2p/pear.routes.ts` — start/stop/status/join-topic/
      join-trade/broadcast-offer, wrapping `pearNodeRegistry` only, per
      `API_REFERENCE.md` §7
- [x] `modules/open-liquidity/liquidity.routes.ts` — list/publish/order
      book/status/match, per `API_REFERENCE.md` §3. Added
      `createOffer()`/`updateOfferStatus()`/`getOrderBook()` to
      `liquidity.service.ts`'s `LiquidityRouter` — only read/match methods
      existed before
- [x] `modules/open-p2p/trade.routes.ts` + new `trade.service.ts` — start
      trade from offer/detail/status, per `API_REFERENCE.md` §5.
      `negotiation.service.ts` already owned the negotiation channel but
      nothing created the `Trade` row it assumes exists — that was the gap
- [x] `modules/open-p2p/chat.routes.ts` — WebSocket negotiation channel +
      message history, per `API_REFERENCE.md` §5.
- [x] **Chat transport unification** *(new — same day, chat-unification
      pass)* — `chat-room-registry.ts` (new) holds the WS room registry;
      `common/events/handlers.ts` reacts to `openp2p.message.sent` and
      pushes `NEW_MESSAGE` to every WS-connected room member for that
      trade, regardless of whether the message was sent via
      `chat.routes.ts`'s WS route or `negotiation.service.ts`'s
      `HumanChatChannel` over Pears — both emit that same event after
      persisting to `Message`. Fixed a real bug found in the process:
      `HumanChatChannel.sendEvent()` discarded the created `Message` row
      and emitted a placeholder `messageId` equal to `tradeId`; every
      message now carries its own real id.
- [x] **WS → Pears best-effort relay** *(new — same day, follow-up pass)*
      — `chat.routes.ts`'s `SEND_MESSAGE` handler now attempts
      `pearNodeRegistry.get(senderId)?.sendToPeer(recipientId, ...)`
      after persisting, when the WS-connected sender also has an active
      PearNode. Verified in `tests/routes.test.ts` via
      `app.injectWS()` — a real WS round-trip through the actual route,
      not just a unit-level assertion. **Not full symmetry, and can't
      be:** `sendToPeer()` only exists on the sending identity's own
      node — a sender with no PearNode at all has nothing to relay from,
      a structural limit of peer-to-peer transports, not a missing
      wiring step.
- [x] **Corrected 2026-08-09 — this row was stale.** `HumanChatChannel.onEvent()`
      IS wired: `chat.routes.ts`'s `JOIN_TRADE` handler calls
      `wireInboundNegotiationChannel()` (`negotiation.service.ts:156`),
      which itself calls `channel.onEvent(...)` (line 169) to persist
      inbound P2P messages. Verified directly by reading both call
      sites, not assumed. Still genuinely unverifiable end-to-end in
      this environment (needs a live two-node Pears/HyperDHT setup) —
      the same limitation `PearsTransportProvider`'s own tests already
      decline to fake (see `tests/transportFallback.test.ts`'s comment)
      — but the wiring itself is real, not missing.
- [x] **Key-custody gap found answering a direct owner question, partial
      fix landed 2026-08-09** — original finding: "as chaves privadas do
      usuário podem ser consultadas?" — the answer for storage/auth was
      already a clean no (no `secretKey`/`privateKey` field anywhere in
      `prisma/schema.prisma`; `common/middleware/auth.ts`'s challenge-
      response only ever receives a *signature*, never the key), but
      `POST /v1/peers/start` used to take the caller's raw Ed25519 secret
      key in the request body and hand it to `PearNode.start()` so the
      server could run that user's Hyperswarm/HyperDHT node on their
      behalf — held only in an in-memory `keyPair` field, never persisted
      or logged, but it did transit the network on that one call.
      **Fixed for real, not just documented:** `PearNode.start()` now
      generates its own ephemeral per-session identity internally
      (`HyperDHT.keyPair()`, the library's own generator), so no key
      material transits the network at all anymore — `/v1/peers/start`
      takes no body, `@satsails/p2p-trading-sdk`'s `peers.start()` takes no argument.
      **Still genuinely not done, same as before:** the P2P node — and
      key custody — living entirely client-side (a wallet/mobile app
      running its own HyperDHT/Hyperswarm stack, server never involved)
      is real production-design work this fix doesn't attempt; it needs
      client-side P2P infrastructure that doesn't exist anywhere in this
      repo today (a browser SPA like `packages/sails-ui` can't easily run
      HyperDHT's UDP-based hole-punching stack without a native/WASM
      bridge). This pass closes the one concrete network-transit
      exposure that existed; it does not claim to close the larger
      architectural gap.
- [x] **Documentation consolidation pass** *(2026-07-19, direct owner
      instruction relaying a CTO-role architectural review: "o foco
      deixa de ser adicionar funcionalidades e passa a ser consolidar o
      protocolo")* — the review proposed 6 new "structuring documents"
      (`TRUST_BOUNDARY.md`, `CAPABILITY_MODEL.md`, `THREAT_MODEL.md`,
      `CRYPTOGRAPHIC_MODEL.md`, `PROTOCOL_INVARIANTS.md`,
      `DESIGN_PRINCIPLES.md`) without full visibility into this repo's
      existing 20-document Engineering Handoff series. Checked each
      against what already exists before writing anything, per this
      project's own "single source of truth" discipline — the same
      instruction the review itself asked for:
      - `THREAT_MODEL.md` (doc 8) and `PROTOCOL_INVARIANTS.md` (doc 19)
        **already existed**, substantial and maintained — not touched
        as new files.
      - `DESIGN_PRINCIPLES.md` **not created** — `PRINCIPLES.md` (doc
        16) already covers 6 of the review's 8 proposed principles
        under existing names (Protocol First, Infrastructure Neutral
        subsumes Wallet/Settlement/Transport Agnostic, Privacy
        Preserving). Creating a competing file would have been exactly
        the duplication the instruction asked to eliminate. The 2
        genuinely uncovered concepts ("Agent Optional," "Local First")
        are noted here, not added — `PRINCIPLES.md`'s own text states
        its 9 principles "should appear, verbatim and in this order" in
        the Whitepaper and `PROJECT_CONTEXT.md`; growing that list is a
        cross-document change with its own precedent (the 8→9 growth
        happened via a named Protocol Freeze review), not something to
        do unilaterally while relaying a second-hand analysis.
      - `CAPABILITY_MODEL.md` **not created** — RFC-005 already defines
        `Capability`/`CapabilityGrant` formally, with a real Prisma
        model and real enforcement (RFC-013/014). Instead added a
        concrete CAN/CANNOT reference table operationalizing those
        interfaces to `PROTOCOL_SPECIFICATION.md` §1.10.1, using the
        QVAC Agent (RFC-016) as the worked example.
      - `TRUST_BOUNDARY.md` and `CRYPTOGRAPHIC_MODEL.md` **genuinely
        didn't exist anywhere** — created as new, unnumbered docs (same
        precedent as `DEVELOPER_JOURNEY.md`/`HANDOFF.md`/
        `TRANSACTION_WALKTHROUGH.md`), cross-referenced from
        `00-INDEX.md`, `ARCHITECTURE.md`, `NODE_ARCHITECTURE.md`,
        `SECURITY_MODEL.md`, and `THREAT_MODEL.md`. `CRYPTOGRAPHIC_MODEL.md`
        is explicit about what's real vs. designed-but-not-wired (the
        `IntentEvent` hash chain is real and active; RFC-008's
        `TimestampAnchor` anchoring and extending the hash chain to the
        general `Timeline` are not) and what has no guarantee at all yet
        (no forward secrecy on P2P payload encryption).
      - `PROTOCOL_INVARIANTS.md` extended, not replaced — the existing 6
        invariants retitled "Constitutional" (protocol-shape rules),
        with a new "Operational Invariants" section (`INV-OP-1`
        through `INV-OP-8`) adding concrete, code-traceable rules per
        the review's own example format, each tied to the RFC that
        decided it and the file that enforces it today — including
        being explicit about which are unconditional vs. gated behind
        an off-by-default feature flag (dual-approval release,
        social-engineering detection).
- [x] **Duplication/drift audit + RFC 2119 normative language**
      *(2026-07-19, direct owner instruction relaying a CTO-role
      follow-up: "não criar documentos duplicados... consolidar...
      tornar a documentação normativa... faça tudo")* — two pieces:
      1. **`PROTOCOL_SPECIFICATION.md` gained RFC 2119 language** (§0
         defines MUST/SHOULD/MAY; §6 is a consolidated conformance
         checklist), scoped to this one document deliberately — the
         other 19 handoff docs stay in their existing narrative style,
         which serves a different audience (engineers understanding the
         system, not implementers conforming to a spec) and was itself
         praised as a strength in the CTO review that requested this
         work. No prose in sections 1-5 was rewritten; §0/§6 are pure
         additions.
      2. **A systematic audit for repeated/divergent concepts across
         all 20 docs + 17 RFCs found 6 real issues, all fixed:**
         - `DATABASE.md` documented a `Capability` Prisma model that
           was never real — `prisma/schema.prisma`'s own comment and
           RFC-013 both say only `CapabilityGrant` is persisted.
           Corrected to show only the real model.
         - `Timeline`'s key: RFC-017 corrected it from `intentId` to
           `correlationId` months ago (`core/timeline.ts` ships the
           correction), but `DATABASE.md`, `PROTOCOL_SPECIFICATION.md`,
           and `ARCHITECTURE.md` still described the superseded
           `intentId` version — worse, `ARCHITECTURE.md` contradicted
           itself between two nearby lines. All three corrected.
         - `SECURITY_MODEL.md`/`NODE_ARCHITECTURE.md` still described
           dispute arbiters as "bonded community volunteers" — the
           actually-accepted-and-implemented model (RFC-007 D4) is
           application-registered Trusted Arbitrators via
           `ArbitrationProvider`, explicitly *not* a protocol-native
           role. Corrected, with the reputation-as-bond mechanism that
           replaced literal bonding made explicit.
         - `EscrowStatus.PENDING_BANK_SETTLEMENT` (RFC-007 D3) was
           documented as live in four files (`DATABASE.md`,
           `PROTOCOL_SPECIFICATION.md`, `API_REFERENCE.md`,
           `SDK_GUIDE.md`) but was never actually migrated into
           `prisma/schema.prisma` — designed, not built. All four now
           say so; a real migration is still needed for RFC-007 D3 to
           actually land, not just a doc fix.
         - `EscrowType` was missing `WDK_USDT_EVM` — a real, tested,
           live settlement provider — from its independently-spelled-out
           listing in `DATABASE.md` and `SDK_GUIDE.md`.
         - `CapabilityGrant.grantId` vs. the real API's `id` — **claim
           corrected 2026-08-01, it was wrong.** This row used to claim
           the real API returns `id`, based on the Prisma column name
           and the route's `:grantId` URL param, without tracing as far
           as `core/capability-registry.ts`'s `toCapabilityGrant()`,
           which explicitly maps `id` -> `grantId` before any response
           leaves the server. The real, live API has always returned
           `grantId` — `PROTOCOL_SPECIFICATION.md` and the SDK type were
           never wrong; no code or interface change was needed.
         - `00-INDEX.md`'s "expected not to resolve" citation list was
           missing two internal-planning documents (
           `03-implementation_plan.md`, `04-Deepseek Review.md`) cited
           by name in several docs — added to the list.
      No false positives from the audit were "fixed" — `PRINCIPLES.md`/
      `PHILOSOPHY.md`/`PROTOCOL_INVARIANTS.md`'s three-tier layering and
      `THREAT_MODEL.md`/`SECURITY_MODEL.md`'s complementary scope were
      both confirmed intentional, not duplication, and left untouched.
- [x] `modules/open-settlement/settlement.routes.ts` — escrow
      create/lock/payment-sent/release/dispute/refund + a new dispute
      resolve route, per `API_REFERENCE.md` §4 (updated alongside this to
      document the resolve route, which wasn't listed there before)
- [x] `modules/open-reputation/reputation.service.ts` +
      `reputation.routes.ts` *(open-reputation pass)* — the module's
      first service layer, not just routes: `recordOutcome()` (RFC-007
      D8's sole score-mutating entrypoint), `rate()` (informational only,
      never touches `reputationScore`), `getScore()`, `getLeaderboard()`,
      per `API_REFERENCE.md` §6. `recordOutcome()` wired into
      `common/events/handlers.ts`'s `settlement.escrow.released`/
      `refunded` reactions, dispute-aware (checks for a resolved Dispute
      to tell a happy-path completion apart from a RELEASE/REFUND
      ruling) — see `tests/reputationOutcome.test.ts`.
- [x] **QVAC + WDK MVP pass** *(new — 2026-07-17)* — see section 4's
      `WDK_USDT_EVM` entry and section 5B for the two real integrations,
      and `examples/demo/pix-to-usdt-flow.ts` (`npm run demo:pix-to-usdt`) for
      the end-to-end script tying them to the already-real Intent/
      OpenP2P/OpenSettlement pieces: Comprador PIX ➡️ Vendedor USDT.
      **Not run live in this pass** — needs a reachable Postgres/Redis,
      not available in this environment; each individual piece it calls
      is real and, where the environment allowed, live-verified on its
      own (QVAC directly; WDK's pure helpers via
      `tests/wdkSettlementProvider.test.ts`, the live wallet calls not
      verifiable without a funded testnet key).

## 14. Gap Audit — Authorization/IDOR Fixes *(new — 2026-07-18)*

Requested directly by the project owner ("faça uma auditoria geral antes
para identificar furos") as a general sweep for the same class of gap
RFC-014/RFC-015's own work had just surfaced (a check that existed but
didn't cover every real caller). Found four real, previously-untested
authorization gaps — not from an external report, from a systematic
pass over every route/service checking who's actually allowed to call
what. All four fixed the same day; full detail in `THREAT_MODEL.md` §4
(each entry there struck through and marked Resolved, not deleted, so
the history stays visible):

- [x] **Intent API had zero authentication** — `POST /api/v1/intents`/
      `DELETE /api/v1/intents/:id` accepted `participantId` straight
      from the request body, the exact RT-002 vulnerability
      `auth.ts`'s own doc comment warns against. Fixed: `requireAuth`
      added, `participantId` now session-derived only;
      `intentEngine.cancel()` gained an ownership check it never had.
      `@satsails/p2p-trading-sdk`'s `createIntent()`/`cancelIntent()` updated to send
      real auth and dropped `participantId` as a caller argument
      (closing a previously-noted `SDK_GUIDE.md` deviation as a side
      effect). Zero HTTP-level test coverage existed for this route
      before this pass — that's exactly why it went unnoticed; now
      covered in `tests/routes.test.ts`.
- [x] **No escrow mutation checked the caller was a party to the
      trade** — `lockFunds()`/`markPaymentSent()`/`releaseFunds()`/
      `refundFunds()`/`openDispute()` in `escrow.service.ts` all trusted
      `triggeredBy` with no ownership check; any authenticated
      participant could mutate any other trade's escrow via
      `settlement.routes.ts`'s direct routes. Fixed with real checks
      (seller/seller-agent, buyer/buyer-agent, or the dispute's assigned
      arbiter, as appropriate per method) — 11 new tests in
      `tests/escrowReleaseControls.test.ts`.
- [x] **Capability grant revoke had no ownership check** — any
      authenticated participant could revoke any other participant's
      grant. Fixed: `capabilityRegistry.revoke()` now verifies
      `grantedTo` matches the caller.
- [x] **Reputation `rate()` never verified the rater/rated were actual
      trade counterparties** — lower severity (informational only, never
      touches `reputationScore`), but a real spam/abuse vector. Fixed:
      verifies `raterId`/`ratedId` against the trade's real buyer/seller.

Verified: `npm run build` clean, `npm test` 21/21 suites, 193/193 tests.

---

## 15. Implementation Freeze (declared 2026-07-19)

Full declaration lives in `GOVERNANCE.md` §6B — not repeated here, per
this same document's own recent discipline about one source of truth.
Short version for anyone scanning this list top to bottom: governance
process is considered stable now (Core RFC classification, the review
checklist, RFC-018/019 — all landed the same day). Effort going forward
should weight roughly 80-90% code/tests/integration (WDK/Pears/QVAC)/UX/
developer docs, 10-20% new RFCs, and those should come from what
implementation reveals, not further architectural speculation. New
governance process/classifications/documents are the exception now, not
a natural next step — assume a concept already exists and consolidate
before proposing an expansion.

**Practical effect on this list:** sections 4 (Settlement Providers,
specifically RFC-019's Phase 1/2), 7 (Intent Engine Tables, specifically
RFC-018's 3 phases), 8 (SDK), 9 (Monorepo), and 11 (Frontend) are where
Implementation Freeze effort should actually go next — they're the real
code/SDK/UX work this phase exists to prioritize.

## 16. Dependency major-version bump (2026-07-19) — applied on branch `chore/dependency-major-bumps-2026-07`

Dependabot's grouped PR (`dependabot/npm_and_yarn/dependencies-850b9c8707`)
bundled 15 simultaneous major-version bumps: `@prisma/client`/`prisma`
5→7, `dotenv` 16→17, `pino` 8→10, `zod` 3→4, `@types/node` 20→26,
`typescript` 5→7, `react`/`react-dom` 18→19, `react-router-dom` 6→7,
`sonner` 1→2, `recharts` 2→3, `tailwindcss` 3→4 (+ matching `@types/react*`).
The Dependabot branch itself was based on a stale commit predating
RFC-016 through RFC-019 and this session's work, so it was reproduced
fresh on `chore/dependency-major-bumps-2026-07` (branched off current
`main`) rather than rebased.

**14 of 15 packages applied as proposed.** `typescript` is the one
deliberate exception: `ts-jest@29.4.11` (the latest published version)
caps its own `typescript` peer range at `<7`, and empirically —
confirmed by actually running the test suite, not just reading the peer
range — TypeScript 6.0.3 also breaks ts-jest at runtime (every Jest
global — `describe`/`it`/`expect`/`jest` — stopped resolving across all
25 suites, even though 6.0.3 formally satisfies `<7`). `typescript`
stays at its original `^5.9.3`; every other bump landed for real.

Real breaking changes found and fixed, not just version bumps:
- **Prisma 7**: schema-level `datasource { url = env(...) }` is removed
  — connection config moved to a new `prisma.config.ts` (CLI/migrate)
  and an explicit driver adapter passed to `new PrismaClient({ adapter })`
  (runtime). Added `@prisma/adapter-pg` + `pg`, `prisma.config.ts`, and
  updated `common/database/index.ts` accordingly.
- **TypeScript 6 (via `moduleResolution`/`rootDir` inference changes)**:
  `moduleResolution: "node"` (node10) is deprecated as of 6.0 with no
  `ignoreDeprecations` value that also works on 5.9.3 — left as `"node"`
  since 5.9.3 doesn't need the escape hatch; added explicit `rootDir` to
  the 3 CJS `tsconfig.json`s (root, `sails-p2p-schemas`, `sails-sdk`)
  since newer `tsc` versions require it explicitly rather than inferring
  it, which surfaced regardless of which TS version ultimately shipped.
- **Zod 4**: `ZodError.errors` renamed to `.issues` (`app.ts`'s error
  handler); `z.record(valueSchema)` now requires an explicit key schema,
  `z.record(z.string(), valueSchema)` (`capability.routes.ts`).
- **Tailwind v4**: the PostCSS plugin moved to a separate
  `@tailwindcss/postcss` package; `index.css`'s `@tailwind base/
  components/utilities` directives became a single `@import "tailwindcss"`
  + `@config "../tailwind.config.js"` (kept the existing JS config
  rather than porting to v4's newer CSS-native `@theme` block, out of
  scope for a dependency bump); `@apply` can no longer chain through
  another custom `@layer components` class (v3 allowed `@apply card` /
  `@apply pill` from a sibling custom class) — inlined the referenced
  utility lists directly in `.card-hover`/`.pill-active`/`.pill-inactive`.
- **React 19 + npm peer-resolution**: `react-router-dom@7`/`recharts@3`/
  `sonner@2` all declare `react` as a wide-range peer dependency (all
  accept 19), but npm's auto-peer-install resolved a *second* React
  copy at 18.3.1 nested under `packages/sails-ui/node_modules` instead
  of deduping against the direct `react@19.2.7` — the classic "Invalid
  hook call" duplicate-React symptom (confirmed via `npm ls react --all`,
  fixed via `"overrides": { "react": "^19.2.7", "react-dom": "^19.2.7" }`
  in root `package.json`, verified with a clean `node_modules` reinstall
  showing exactly one resolved copy).

**Verification**: `npm run build` (backend, 3 TS projects) clean,
`npm test` 218/218 (run twice), `npm run build:ui` clean (`tsc --noEmit`
+ `vite build`). Runtime-checked in the browser (dev server), not just
type-checked — Marketplace, OfferDetail (React Router v7 navigation),
Profile (Sonner v2 toast interaction), and the Admin Dashboard (Recharts
v3 chart) all render correctly with zero console errors on a fresh tab.

**Update (2026-07-20) — now fixed, forward, no downgrade needed:**
Prisma 7.9.0 replaced `@prisma/dev`'s internal HTTP router
(`find-my-way`, no more `@hono/node-server` in its dependency tree at
all — confirmed via `npm view @prisma/dev@latest dependencies`), so the
`prisma`/`@prisma/client` bump from `7.8.0` → `7.9.0` (both still
`^7.x`, no `package.json` range change beyond the patch itself) removes
the vulnerable transitive dependency outright instead of requiring the
downgrade-to-6.19.3 tradeoff described below. `npm audit` now reports 0
vulnerabilities. Verified: `npx prisma generate`, `npm run build` clean,
`npx jest` 224/224, and — since this changes the actual runtime DB
client, not just a devDependency — the full `npx playwright test` suite
(golden path + both §24 concurrency scenarios) re-run against a freshly
restarted backend on the new client, 3/3 passing against real local
Postgres.

<details>
<summary>Original finding (2026-07-19), kept for context — no longer the current state</summary>

`@hono/node-server` <1.19.13 (moderate, [GHSA-92pp-h63x-
v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m), a
`serveStatic` middleware bypass via repeated slashes) was pulled in
transitively via `prisma` (our devDependency) → `@prisma/dev` (Prisma's
own internal package behind the `prisma dev` local-Postgres-proxy
feature) → `@hono/node-server`. Confirmed via `npm ls @prisma/dev
@hono/node-server` and a grep across `package.json`/`src/` — nothing in
this project ever invokes `prisma dev` (only `db:migrate`/`db:generate`/
`db:seed`/`db:studio`), so the vulnerable code path was never reached.
At the time, `npm audit fix --force` would have downgraded
`prisma`/`@prisma/client` from `7.8.0` back to `6.19.3`, reverting the
verified migration above for a devDependency-only, unreachable issue —
not worth it. Resolved forward instead once Prisma shipped 7.9.0 (see
above).

</details>

### 16B. Dependabot follow-up (2026-07-27) — triaged 67-package `npm audit` list, fixed the 2 real production-exposed items

GitHub flagged 15 Dependabot alerts (2 critical, 7 high, 5 moderate, 1
low) on `main`; `npm audit` locally reports a larger, differently-counted
67 (it counts every vulnerable package occurrence in the dependency
graph, Dependabot dedupes by advisory). Triaged the full `npm audit`
output by whether the vulnerable code actually runs in this server's
request path, not just by severity label — most of the 67 are
dev/test-only tooling (Jest, ts-jest, Vitest, Storybook, Artillery,
`@prisma/dev`, `redis-memory-server`) that never ships or executes
against real traffic; several of those need semver-major bumps that risk
destabilizing the large, already-verified test/tooling setup this
session built up, so they're deliberately left alone here rather than
bumped reflexively.

**Two real, production-reachable issues found and fixed:**

- **`find-my-way` (Fastify's own router, `fastify@5.10.0`'s direct
  dependency) — HTTP/2 DDoS (GHSA-c96f-x56v-gq3h), fixed non-breaking.**
  `npm audit`'s own tree attributed this advisory only to `@prisma/dev`'s
  copy, which under-reported the real exposure — `find-my-way@9.6.0` is
  also the literal router every HTTP request to this server passes
  through. Pinned via `package.json`'s existing `overrides` field (same
  mechanism already used there for `react`/`react-dom`) to `^9.7.0`, the
  patched version, same major — no code change needed.
- **`@fastify/static` (pulled in by `@fastify/swagger-ui`, which powers
  the `/docs` route) — route-guard-bypass/path-traversal
  (GHSA-83w8-p2f5-377r, high). No non-breaking fix exists yet** — the fix
  requires `@fastify/static` v10, and `@fastify/swagger-ui`'s own latest
  release (`6.1.0`) still pins `^9.1.2`. `/docs` was registered
  unconditionally in every environment (`app.ts`) with no auth guard — a
  real, live, unauthenticated attack surface on any deployment, not a
  theoretical one. Fixed by gating `swaggerUi`'s registration behind
  `!config.isProduction` — the same hard-gate pattern `config/index.ts`
  already uses for `MOCK_ESCROW` in production — so the vulnerable
  static-file-serving plugin is simply never registered where it would
  be reachable by the public, closing the exposure without waiting on an
  upstream fix. `@fastify/swagger` itself (the OpenAPI spec generator, no
  static file serving) stays registered everywhere — it has no
  path-traversal surface of its own. `GET /` and the startup console
  banner both updated to stop advertising `/docs` when it isn't actually
  registered. Verified by booting the compiled server both ways:
  `NODE_ENV` unset → `/docs` returns `200`; `NODE_ENV=production` →
  `/docs` returns `404` and `GET /`'s `docs` field is `null`.

**Deliberately not touched this pass** (all dev/test-only, no production
exposure): the Jest/ts-jest ecosystem, Vitest/`@vitest/coverage-v8`
(critical, but only reachable via a locally-listening Vitest UI server
this repo never runs), Storybook/`@joshwooding/vite-plugin-*`, Artillery/
OpenTelemetry (load-tests only), `@prisma/dev` itself, `redis-memory-server`/
`rimraf`/`ts-node-dev`. `react-router-dom@7.18.1` (`sails-ui`) technically
falls in the flagged range for a "RSC Mode CSRF Bypass" advisory, but
`sails-ui` is a plain client-side Vite SPA that never uses React Server
Components mode — left as a known-low-real-risk entry, not fixed here.

### 16C. Dependabot follow-up round 2 (2026-07-28) — leaf-level overrides for the dev-tooling chain, real ceiling found

Went back through §16B's "deliberately not touched" list at the user's
request. Real result: **4 more genuinely fixed via targeted
`package.json` `overrides` entries, no tool major-version bump needed**
— `tar` (`^7.5.22`, full fix), `valibot` (`^1.4.2`, full fix — only
consumed by `@prisma/dev`, never invoked), `brace-expansion`
(`^5.0.8`, **partial** — fixes the `artillery`/`typedoc` dependency
paths, but two remaining copies are hard-pinned by `minimatch@9.x`'s own
`^2.0.2` dependency inside `@joshwooding/vite-plugin-react-docgen-typescript`
(Storybook) and `@vitest/coverage-v8` — npm's override resolution
correctly declined to force an incompatible major there rather than risk
silently breaking those tools' own glob parsing), `uuid` (`^11.1.1`,
**partial** — fixes the `artillery` paths (already on `11.1.1`), but
`@storybook/addon-actions` bundles its own hard-pinned `uuid@9.0.1` copy
under its own `node_modules` that the override can't reach without
forcing an incompatible major into a tool that pins it deliberately).
**Net: 66 → 62 flagged packages.** Verified nothing broke: full backend
+ SDK Jest suite (349/349), `npm run build` clean (backend + `@satsails/p2p-trading-sdk`
+ `sails-ui`), `@satsails/sdk-react`'s own `tsc --noEmit` + `tsup` build
clean.

**The remaining 62 all have the same real ceiling**: a genuine fix
requires a semver-major bump of Jest, Vitest, Storybook, or Artillery
themselves (their nested vulnerable copies of `glob`/`minimatch`/
`brace-expansion`/`uuid`/`filelist`/`ejs`/`@opentelemetry/*` have no
patched release within their currently-declared major ranges — confirmed
by checking each package's own published version list, not assumed).
Deliberately still not forced this pass: this repo has a **concrete,
documented precedent for this exact failure mode** — §16's own
TypeScript major-bump entry above records that bumping `typescript` past
`^5.9.3` broke `ts-jest` at runtime (every Jest global stopped resolving
across all suites) despite formally satisfying `ts-jest`'s declared peer
range, only caught by actually running the suite, not by reading the
range. Blindly bumping Jest/Vitest/Storybook/Artillery's own majors risks
the identical class of silent breakage across this repo's much larger,
already-hard-won test/tooling investment (Fase 2's SDK React + Storybook
+ Vitest/RTL setup, Fase 3's Playwright E2E suite, Fase 4's k6/Artillery
load tests) — all dev/test-only surfaces that never execute against real
traffic, unlike the two §16B already fixed. Recommendation if this is
ever revisited: a dedicated pass per tool (Jest+ts-jest together, Vitest
+coverage-v8 together, Storybook's whole `@storybook/*` set together —
never one package in isolation, since these ecosystems version-lock
against each other), each with its own full-suite verification, not a
blanket `npm audit fix --force`.

**`react-router-dom` re-checked, confirmed no available fix exists**
(GHSA-qwww-vcr4-c8h2, "RSC Mode CSRF Bypass"): the advisory's vulnerable
range is `>=7.12.0 <8.3.0`; `7.18.1` (currently installed, also the
latest published release) falls inside it, and `react-router` has not
yet published an `8.3.0` — the only fix the registry actually offers
today is `npm audit`'s suggested `7.11.0`, a **downgrade** below the
vulnerable range's own start, losing ~7 months of real patches/features
for a vulnerability class that doesn't apply here in the first place —
`sails-ui` is a plain client-side SPA (`BrowserRouter`/`Routes`/`Route`),
never uses React Server Components mode, which is what CSRF-bypasses
Action execution. GitHub Advisory Database hasn't even scored this one
yet (CVSS `vectorString: null`). Confirmed deliberate accepted risk, not
an oversight — downgrading would be a real regression for zero practical
safety gain; will pick this back up once react-router actually ships a
forward-compatible `8.3.0`+ (or backports to a patched `7.x`).

**Also discovered, unrelated to this pass, flagged separately (not
fixed here):** `@satsails/sdk-react`'s own Vitest suite has been silently
broken since commit `9a49f20` (today, MULTISIG Phase 2) — 5 of 10 test
files fail to load with `Error: ecc library invalid` (thrown by
`ecpair`'s built-in self-test against `@bitcoinerlab/secp256k1`, added to
`escrow-key.ts` that commit). Confirmed the same library passes
`ecpair`'s self-test cleanly under plain Node — the failure is specific
to Vitest's jsdom test environment, likely a module-duplication issue
(two resolved copies of `@noble/curves`/`@noble/hashes` disagreeing).
Real backend/SDK build and the actual `signEscrowPsbt()`/
`generateEscrowKeypair()` functionality are unaffected (proven working
under plain Node and real browser bundling elsewhere this session) — this
is specifically `sdk-react`'s own test environment. Not investigated
further here since it's unrelated to the Dependabot work this pass was
scoped to; a background task was spawned to track it.

### 16D. Dependabot follow-up round 3 (2026-07-28) — RFC-020's `contracts/` workspace additions

GitHub flagged 11 new alerts (2 critical, 3 high, 5 moderate, 1 low)
after the RFC-020/`SAFE_GUARD_EVM` push. Triaged via `npm audit --json`
(83 raw findings locally — GitHub's count is deduplicated by advisory,
not by affected package node) and `npm ls <pkg> --all` to confirm actual
reachability, not assumed from the package name.

**All the new critical/high findings trace to one source, confirmed
non-production-reachable:** `@safe-global/safe-contracts@1.4.1-2` (the
real, audited Safe contracts `SailsEscrowSafe.sol` extends) bundles its
own internal build/deploy tooling dependency on `ethers@5.4.0` →
`@ethersproject/signing-key` → `elliptic@6.5.4` (real ECDSA
private-key-extraction / signature-validation bugs). Verified via
`npm ls elliptic --all`/`npm ls ethers --all`: this copy exists **only**
inside the `contracts/` workspace, pulled in transitively by Safe's own
package — this repo never invokes Safe's deploy scripts, only
`npx hardhat compile` (which reads `.sol` source, never executes Safe's
JS tooling). Production code's own real `ethers` usage
(`WdkSettlementProvider` → `@tetherto/wdk-wallet-evm`) is a completely
separate, unaffected `ethers@6.17.0` copy — confirmed via the same `npm
ls` output, not assumed. `fixAvailable: false` — Safe has not published
a release with a newer bundled `ethers`; nothing to bump.

**`hardhat` itself flagged high** (its own nested `adm-zip`/`solc`/
`@sentry/node`/`undici`/`uuid` chain) — `npm audit`'s own
`fixAvailable` field confirms the fix is `hardhat@3.11.1`, a semver-major
bump from the `^2.29.0` this repo deliberately pinned (`contracts/`'s own
`package.json`, chosen specifically for lower config-API risk on a first
Solidity toolchain — see the `contracts/` scaffold entry above). Same
"real ceiling, no non-major fix" pattern §16C already established for
Jest/Vitest/Storybook/Artillery — not forced this pass for the identical
reason: `hardhat compile` against `SailsEscrowSafe.sol` was verified
working today (5 files, zero warnings) and a major bump risks silently
breaking that without a dedicated verification pass of its own.

**Everything else in the 83-item list is the same already-triaged
dev/test-tooling category §16C covers** (Jest/Vitest/Storybook/Artillery
chains) plus `vite-plugin-node-polyfills` (a `packages/sails-ui`
devDependency, out of scope for this pass — untouched, per the standing
coordination discipline around that package while the parallel session's
rebranding work is in flight there).

**Net decision: accepted risk, nothing changed.** None of the new
findings are reachable from this repo's actual runtime — both the Safe
chain and the Hardhat chain are compile-time/dev-tooling only, and both
have a real, confirmed non-major-bump-available ceiling. Revisit if this
`contracts/` workspace ever grows beyond compile-only verification (e.g.
if Safe's own deploy scripts are ever actually invoked, or Hardhat needs
a feature only 3.x has).

---

## 17. Security-validation round (2026-07-19) — abandoned trade, retry safety, event replay, concurrent dispute

CTO-role follow-up after RFC-018's validation pass and the
`fullTradeLifecycle.test.ts` bug find: 4 scenarios meant to put the
architecture under pressure before adding any new feature, in the same
Implementation Freeze spirit (find real divergences, fix them, don't
invent new concepts). Two real bugs found and fixed, one real doc
overclaim corrected, one already proven safe:

1. **Trade abandonado (timeout) — real doc overclaim, corrected, sweeper
   itself deferred as tracked future work.** `SECURITY_MODEL.md` claimed
   "Timelock fallbacks handle no-response scenarios automatically" —
   `escrow.service.ts` computes and stores a real `Escrow.expiresAt` at
   lock time but nothing ever reads it again; no sweeper exists. Corrected
   `SECURITY_MODEL.md` Scenario B + Resolution Principles to state this
   honestly; added a `BACKLOG.md` row tracking the real sweeper as
   separate future work (the state-transition logic it would drive,
   `refundFunds()`, already exists and is tested — only the "notice time
   has passed" trigger is missing).
2. **Settlement failure retry safety — confirmed already safe, regression
   test added.** A failed `lockFunds()` (e.g. an unimplemented provider)
   leaves the `Escrow` row at `CREATED`, untouched — a corrected retry on
   the same row goes through the identical code path cleanly. New test in
   `tests/escrowReleaseControls.test.ts`.
3. **Event replay / idempotency — investigated and characterized, not
   fixed (not reachable today).** `InMemoryEventStore` (RFC-010's
   always-available default) never redelivers, so this isn't a live bug —
   but a stress test in `tests/fullTradeLifecycle.test.ts` proved the
   Intent lifecycle is naturally protected by `state-machine.ts`'s
   `assertValidTransition()` (a duplicate transition throws and is caught/
   logged, state untouched) while `reputation.service.ts`'s
   `recordOutcome()` is a bare increment with no idempotency key — a
   duplicate `settlement.escrow.released` delivery doubles
   `reputationScore`/`totalTrades`/`totalVolumeBtc`. Documented as a hard
   precondition on `BACKLOG.md`'s `RedisStreamsEventStore` row: that work
   must not ship without an eventId-based idempotency check on
   `recordOutcome()`'s callers first.
4. **Disputa dupla (concurrent double-dispute) — real bug, fixed.**
   `dispute.service.ts`'s `raiseDispute()` reads escrow status, validates,
   then writes, with no locking — two concurrent calls (buyer and seller
   both raising a dispute at once) could both pass every check before
   either write landed, producing two `OPENED` Dispute rows for the same
   trade, possibly with two different assigned arbiters (no DB constraint
   prevented it). Fixed with `schema.prisma`'s `Dispute` model gaining
   `@@unique([tradeId])` (this reference implementation's dispute flow has
   no reopen-after-`RESOLVED` path, so one dispute per trade for its
   entire lifetime is the real invariant) and `raiseDispute()` catching
   the resulting P2002 into a clean `ValidationError` — same pattern
   `reputation.service.ts`'s `rate()` already established for its own
   unique-constraint race. New test in `tests/disputeFlow.test.ts`.

**Verification**: `npm run build` clean, `npm test` 222/222 (run twice).
Schema changed (`Dispute.@@unique([tradeId])`) — `npx prisma generate`
run at the time; **applied for real the same day, see §18 below** — the
"no live Postgres" limitation this note originally referenced no longer
holds for local dev.

---

## 18. Real local Postgres + Redis — no Docker required (2026-07-19)

The single most-repeated caveat in this entire document — "no live
Postgres/Redis reachable in this environment" — stops being universally
true today, for local development. `embedded-postgres` (downloads a
real native Postgres binary per platform via `optionalDependencies`, no
container runtime needed) and `redis-memory-server` (same idea; resolves
to Memurai on Windows — real Redis dropped official Windows support
years ago, Memurai is a Redis-protocol-compatible server distributed
under its own EULA, free "Developer Edition" for exactly this use case)
both install and run cleanly in this sandboxed Windows environment with
zero Docker/container access.

`scripts/local-postgres.js` and `scripts/local-redis.js` (`npm run
db:local:start`/`db:local:stop`, `npm run redis:local:start`/
`redis:local:stop`) manage them — both default to the exact
host/port/user/password `config/index.ts`'s own fallback defaults
already assumed (`postgresql://postgres:password@127.0.0.1:5432/
sails_protocol`, `redis://127.0.0.1:6379`), so **zero `.env` changes**
are needed to point the real app at them. Neither script uses its
underlying library's own start()/stop() API directly — found the hard
way that `embedded-postgres`'s module-level `AsyncExitHook` stops every
tracked instance the moment the calling Node process exits (even a
clean `process.exit(0)`), which would kill the server the instant a
short-lived "start" script returned. Both scripts instead shell out to
the real `pg_ctl`/Memurai binaries directly as detached OS processes,
independent of the calling script's own lifetime — the actual fix.

**What this unlocked, verified for real the same day:**
- `npx prisma db push` against a genuinely live database — all 12
  tables created for the first time ever outside a mock. Confirmed via
  `information_schema.tables`.
- A real service-layer round trip with zero mocking:
  `liquidityRouter.createOffer()` → `intentEngine.create()` (the actual
  RFC-018 code) wrote a real `User`, `Offer`, and `Intent` row, with the
  `Intent` walking `CREATED → VALIDATED → COORDINATED` for real and its
  hash-chained `IntentEvent` rows persisting correctly — read back and
  confirmed via direct SQL, not application code.
- `npm run dev`'s real Fastify server booted against real Postgres AND
  real Redis (`[Database] Connected` / `[Redis] Connected`, both real
  log lines, not mocked) — the first time this project's actual
  `startServer()` has ever run end-to-end. A real
  `GET /v1/liquidity/offers/USDT_ERC20/book` HTTP call returned the
  exact Offer created in the smoke test above, straight from Postgres.

**What this does NOT unlock** (scope discipline — not claiming more than
verified): live HyperDHT P2P network (needs real internet peers), real
WDK testnet transfers (needs real blockchain RPC access), or a
production deployment story — this is strictly a local-dev/testing
capability. `docker-compose.yml` (§12/BACKLOG.md, already real) remains
the deployment-shaped path; this is the workaround for environments
(like this one) where Docker itself isn't available.

`.local-pgdata/`, `.local-pgdata.log`, `.local-redis.pid`,
`.local-redis.log` are gitignored — per-machine local state, never
committed. `embedded-postgres` and `redis-memory-server` added as
devDependencies only.

---

## 19. `packages/sails-ui` wired to the real backend — golden path (2026-07-19)

Every screen in this reference UI was 100% mocked (`data/mock.ts`/
`lib/offersStore.ts`/`localStorage`) until today — every `TODO: replace
with @satsails/p2p-trading-sdk` comment across the codebase pointed at this pass. With
§18's real local Postgres+Redis and a real `npm run dev` server running,
the core "two wallets negotiate" loop now runs against the real backend
end to end, verified live in a real browser (not just `tsc`/build):

- **Login** (`AuthContext.tsx`) — real `identity.create()` +
  `identity.authenticate()` (Ed25519 challenge-response,
  `@satsails/p2p-trading-sdk`'s identity module). Keypair persisted in `localStorage`
  (demo-only shortcut, disclosed in the file's own comment — a real
  wallet integration keeps this in the wallet's own secure storage,
  never a page-controlled origin). Verified: full register → challenge
  → authenticate → `/v1/identity/me` round trip, all real HTTP calls.
- **Marketplace** (`lib/realOffers.ts`) — real `liquidity.discover()`,
  fanned out per asset/side (the real route only filters by asset+side,
  no "list everything"). Verified: a real offer created via a smoke
  test earlier the same day rendered live in the Marketplace grid.
- **OfferDetail** — real single-offer fetch. Found a real gap: no route
  ever let a caller fetch one Offer by id with its seller's real profile
  fields — added `GET /v1/liquidity/offers/id/:id`
  (`liquidity.service.ts`'s new `getOffer()`, `liquidity.routes.ts`) and
  the matching `@satsails/p2p-trading-sdk` method.
- **PublishOffer** — real `liquidity.publish()` (`POST
  /v1/liquidity/offers`).
- **Trade** — real `openp2p.trade()` (creates the real Trade, walks its
  Intent through the real RFC-018 lifecycle), real `openp2p.getTrade()`/
  `identity.get()` for both parties, real escrow actions
  (`settlement.create/lock/markPaymentSent/release/dispute`, matching
  each action's real ownership rule — only the seller sees "Criar
  Escrow"/"Bloquear"/"Liberar", only the buyer sees "Marcar Pagamento
  Enviado"), and real chat (`openp2p.getMessages()` for history,
  `openp2p.chat()` WebSocket for live messages) — the QVAC risk card
  (`AgentRiskCard`) also fired for real against this real trade.
  `buildTrade.ts`'s client-only mock construction is no longer used by
  this screen.

**Real bugs found and fixed the same day, each invisible until this
pass's actual browser exercise (this SDK's own tests always inject
mocks — a real fetch/WS round trip was never exercised before):**
1. `SailsTransport`'s fallback to the global `fetch` passed a bare
   function reference, later called as `this.fetchImpl(...)` — real
   browsers throw `Illegal invocation` for that (fetch requires
   `window`/`WorkerGlobalScope` as its receiver). Fixed with
   `fetch.bind(globalThis)`.
2. `liquidity.discover()`/`.book()`/`.match()` all claimed to return
   persisted `Offer` shapes — the live routes actually return
   `{ offers, sources }` (`discover`) or bare `LiquidityOfferSummary`
   objects (`book`'s bids/asks, `match`), a materially different shape
   (no `userId`/`status`, `paymentMethods` array not singular). Fixed
   the SDK's types to match reality; added `LiquidityOfferSummary`/
   `DiscoverResult` exports.
3. `WebSocketChannel.onMessage()` claimed `NEW_MESSAGE` frames carry the
   persisted `Message` shape (`id`/`createdAt`) — the real broadcast
   payload is `OpenP2PMessageSentEvent` (`messageId`/`timestamp`, no
   `readAt`). Symptom before the fix: "Invalid Date" on every live chat
   message. Fixed with a new `ChatMessageEvent` type matching the real
   frame.
4. (Tooling, not an SDK bug) Vite resolves `@satsails/p2p-trading-sdk` — an npm-
   workspace-linked package — through its real filesystem path rather
   than as a `node_modules` dependency, skipping the esbuild CJS→ESM
   pre-bundling every other CJS dependency gets automatically. The
   browser's native ESM loader then can't find named exports from what's
   actually a CJS `exports.X = ...` module. Fixed with
   `optimizeDeps.include: ['@satsails/p2p-trading-sdk']` in `packages/sails-ui/vite.config.ts`.

**Still mocked, not touched this pass** (disclosed, not silently left):
Profile's own-offers list, TradeHistory, the Admin dashboard/
ManageOffers/Disputes screens, and media (image/video) chat attachments
(no real upload/storage endpoint exists — same gap `types.ts`'s own
comment already discloses). `isOperator`/`toggleRole` (Profile's
buyer/seller role-play toggle) stays presentation-only, unrelated to
real auth.

**Verification**: `npm run build` clean (backend + all 3 TS packages),
`npm run build:ui` clean (production Vite build), `npm test` 222/222.
Live browser walkthrough against the real `npm run dev` server (real
Postgres via §18): register/login, Marketplace showing a real offer,
OfferDetail with real seller profile data, starting a real Trade (walked
the real Intent lifecycle), the real QVAC risk card firing, and a real
chat message sent/received over the live WebSocket with a correctly
rendered timestamp.

---

## 20. Trade screen now shows the seller's payment details (2026-07-20)

**Real gap, found and closed the same day, not carried over as a TODO
item:** `OfferDetail` fetched `Offer.paymentMethod`/`paymentDetails`
(where to actually send fiat — a PIX key, in the reference flow) but
never rendered `paymentDetails` even there, and `Trade` — the screen a
buyer is actually looking at once a trade is underway — never fetched
the Offer at all. A buyer who'd already navigated away from OfferDetail
had no way to see where to send money once the trade started.

**Fixed:** `trade.service.ts`'s `getTrade()` now `include`s the real
`offer` relation (the `intentId`-style pattern this file already uses
for `escrow`/`messages`) — no new route, no schema change, the
`offerId` FK already existed. `@satsails/p2p-trading-sdk`'s `Trade` type gained an
optional `offer?: Offer` field (optional because `trade()`'s create
response doesn't include it — only `getTrade()` does, documented on the
method itself). `Trade.tsx` renders a "Como pagar" card for the buyer
specifically, showing the human-readable payment method
(`PAYMENT_METHOD_LABELS`, already existed) and the raw `paymentDetails`
string, with an honest fallback ("combine pelo chat") when a seller
left it blank.

**Also found while auditing this, not yet fixed — a smaller version of
the same gap:** `OfferDetail.tsx` itself fetches `paymentDetails` into
its local `Offer` object but still never renders it, even on the page
whose whole job is showing offer details before a trade starts. Left
as-is — out of the scope actually confirmed for this pass (the Trade
screen specifically) — but worth closing in the same spirit if picked
up next: one `Row` addition, same pattern as `PAYMENT_METHOD_LABELS`'s
existing row.

**Verification:** `npm run build` clean, `packages/sails-ui`'s
`npx tsc --noEmit` clean, `npm test` 222/222 (no regressions — the new
`include` doesn't change any mocked test's assertions). Live-verified
against the real backend: seeded a fresh Offer with a real
`paymentDetails` string and a real Trade against it (two fresh Ed25519
identities, registered/authenticated for real, not fixtures), opened
`/trade/:id` as the buyer in a real browser session, and confirmed the
card renders the exact seeded PIX string.

---

## 21. `@satsails/p2p-trading-sdk`'s `dispute()` is real; `negotiate()`/`releaseAsset()`'s
    blockers corrected (2026-07-20)

Section 8's "still genuinely unbuilt/partial" note (and `HANDOFF.md` §3
item 4) said the fix for `negotiate`/`releaseAsset`/`dispute` was "a
route + facade wiring" once RFC-018's `intentId` link existed. Building
it found that claim was only half right — worth recording precisely,
the same way an over-optimistic estimate from earlier in this project
would be.

**Done:** `trade.service.ts` gained `getTradeByIntentId()`;
`GET /v1/openp2p/trades/by-intent/:intentId` (`API_REFERENCE.md` §5)
exposes it, same no-auth pattern `GET /trades/:id` already has.
`intent-facade.ts`'s `dispute(intentId, reason)` resolves the Trade,
reads its `escrowId`, and raises a real `Dispute` on it — throws
`SailsNotImplementedError` only if the Trade has no Escrow yet (nothing
to dispute), not as a permanent state.

**Found while building it, NOT done, for a more precise reason than
before:**
- `negotiate(intentId, event): Promise<void>` (`SDK_GUIDE.md` §2) — the
  real negotiation channel is a persistent `WebSocketChannel`
  (`openp2p.chat(tradeId)`), not something a single `Promise<void>` call
  can represent. This needed the same signature-level check as
  `releaseAsset` below to surface — the RFC-018 link fixed the *data*
  gap, not this *shape* gap.
- `releaseAsset(intentId): Promise<Settlement>` — the canonical
  signature in `SDK_GUIDE.md` itself has no destination-address
  parameter, but the one real release route
  (`POST /v1/settlement/escrow/:id/release`) requires `toAddress` with
  no default (`settlement.routes.ts`'s own zod schema, checked
  directly). Closing this needs a decision on `SDK_GUIDE.md`'s canonical
  shape — add a parameter, or define a default-address source — not
  more plumbing. Not attempted here; flagged precisely instead of forced.
- `submitProof` unchanged — still correctly blocked on the Proof
  primitive having zero routes, unrelated to any of the above.

**Verification:** `npm run build` clean, `npm test` 223/223 (2 new SDK
tests replacing 1 now-obsolete one in `client.test.ts` — the old test
asserted `dispute()` always throws, which stopped being true).

---

## 22. Pre-beta robustness audit (2026-07-20) — "assume 10,000 users tomorrow"

CTO-directed audit for fund-loss bugs, state-machine violations, race
conditions, and reconnection failures ahead of any public beta.
Explicitly scoped to hardening existing infrastructure, not new
features — every item below is either a fix to code that already
existed, or a precisely-scoped registration of a gap left open on
purpose. Verified: `npm run build` clean, `npm test` 224/224 (1 net new
test; several existing tests updated for the new call shape, none
weakened).

### Fixed — real, reproducible bugs

1. **Escrow state transitions were not atomic (TOCTOU race) — the
   highest-severity finding, a genuine fund-loss bug, not a theoretical
   one.** `escrow.service.ts`'s `lockFunds()`/`markPaymentSent()`/
   `releaseFunds()`/`openDispute()`/`refundFunds()` all read `escrow.status`,
   checked it in memory (`assertTransition`), then — for `releaseFunds()`
   and `refundFunds()` specifically — called the real, side-effecting
   `SettlementProvider` (for `WDK_USDT_EVM`, a real signed on-chain USDT
   transfer) with no database-level guard before it. Two concurrent calls
   for the same escrow (a double-click, a client retrying a request that
   actually already succeeded, a race between `executeSettlement()`'s
   auto-settle path and a manual API call) would both pass the in-memory
   check before either write landed, and **both would sign and broadcast
   a real transfer** — an actual double-payment. Fixed by claiming the
   transition atomically via a conditional `prisma.escrow.updateMany({
   where: { id, status: expectedCurrentStatus }, data: {...} })`
   *before* ever calling the provider — Postgres's own row-level locking
   makes only one concurrent caller's claim succeed (`count: 1`); the
   loser gets `count: 0` and is rejected before touching real funds, not
   after. On a provider failure after a successful claim, the status is
   reverted (same idiom `dispute.service.ts`'s `resolveDispute()` already
   established for its own revert-on-failure case) so a failed attempt
   doesn't permanently strand the escrow. Verified in
   `tests/escrowReleaseControls.test.ts` (26 tests, including the
   provider-failure/revert and safe-retry cases, both updated for the new
   call shape).
2. **The RFC-018 Intent state machine had the identical race.**
   `intent-engine.ts`'s `transition()` — the single function every real
   status change in the protocol goes through — had the same read-check-
   write gap. Worse than a lost update: `writeIntentEvent()` computes
   `prevHash` from "the last `IntentEvent` row for this intentId," so two
   racing transitions could both read the same prior event as "last" and
   both chain off it, corrupting RFC-008's hash chain (which guarantees
   exactly one true predecessor per event), not just silently overwriting
   a status field. Fixed the same way: an atomic conditional
   `prisma.intent.updateMany({ where: { id, status: currentStatus },
   data: { status: toStatus } })` before `writeIntentEvent()`/`emit()`
   ever run. New test in `tests/intentFlow.test.ts` exercises the
   rejection path directly (`count: 0` → a clear error, not a silent
   double-write).
3. **`createTrade()` never validated `amount` against the Offer's own
   `minAmount`/`maxAmount` — or that it was a sane positive number at
   all.** A caller could request any amount, including one wildly outside
   what the seller actually published (the same limits `OfferDetail.tsx`
   shows the buyer as a hard constraint), and a real `Trade` would be
   created for it — an accepted "trade" the counterparty never agreed to,
   a state-consistency bug, not just a UX gap. Fixed in
   `trade.service.ts`'s `createTrade()`, same "bounds check via `Number()`,
   decimal string is still what's persisted" precedent RFC-009 already
   established elsewhere in this codebase.

### Found, not fixed — registered precisely, per the "no new features" scope

- **No WebSocket reconnection logic anywhere in the client stack — ✅ closed on the SDK side, 2026-08-02.**
  `@satsails/p2p-trading-sdk`'s `WebSocketChannel` (`openp2p.ts`) now takes a socket
  factory instead of a bare `WebSocket` (a closed real socket can never
  be reopened) and reconnects itself with exponential backoff + jitter on
  an unexpected `close`, re-`JOIN_TRADE`-ing on every reconnect, capped at
  `maxReconnectAttempts` (default 10) before giving up; a new
  `onConnectionStateChange()` hook reports `'open'`/`'reconnecting'`/
  `'closed'`. `chat(tradeId, options?)` wires it through automatically —
  every caller gets it for free with zero code changes, exactly this
  entry's own "next step" plan. **Still open: `Trade.tsx` itself** (in
  `packages/sails-ui`, a separate session's own ownership boundary this
  pass didn't cross) doesn't yet call `onConnectionStateChange()` to show
  a real "reconectando..." indicator — the SDK-side capability now exists
  for it to use, but the UI wiring is a separate, still-open follow-up.
- **`trade.service.ts`'s `updateStatus()` and `capability-registry.ts`'s
  `revoke()` have the same read-check-write shape as the escrow/intent
  bugs above, but lower severity** — neither guards a real fund movement
  or a hash-chain invariant; the worst case of a lost race is "last write
  wins" on a status/timestamp field, not a double-payment or a corrupted
  chain. Left as-is this pass (the fix pattern is identical to items 1-2
  above if this is ever prioritized — same atomic `updateMany` swap).
- **Client-side double-click protection already exists** (`Trade.tsx`'s
  `acting` state disables every action button mid-request) — real, but
  correctly understood as defense-in-depth, not the actual fix: it does
  nothing against two independent HTTP clients (a retried request, a
  second device, a script), which is exactly why item 1 above needed a
  server-side, database-level fix regardless.

### Explicitly out of scope this pass (the CTO's own "what I would NOT ask
for right now" list, respected as-is)

Playwright E2E suites, dual-browser test harnesses, fuzz testing
infrastructure, and a formal RFC-018 model-checking harness (random
event-sequence generation against the state machine) were all named as
good ideas but bigger, standalone efforts — not attempted here without a
separate decision to prioritize one. This section exists so that decision
has an accurate audit to start from, not so it gets made implicitly by
what got built anyway.

---

## 23. Real Playwright E2E suite — "the official protocol test" (2026-07-20)

CTO-directed, named priority-máxima follow-up to §22's audit: automate
the golden path instead of validating it by hand. `@playwright/test`
added (root devDependency, not scoped to `packages/sails-ui` — it drives
the whole stack, not just the UI package). `playwright.config.ts` starts
the real backend and real UI dev servers (`webServer`, `reuseExistingServer`
so a dev's already-running servers are reused, not restarted) against
real local Postgres/Redis (`§18` — prerequisite, not orchestrated by this
config, same reasoning that section already gives for keeping DB startup
a separate step). `npm run test:e2e` runs it.

`e2e/golden-path.spec.ts` — two genuinely separate browser contexts
(isolated `localStorage`, so two real, distinct Ed25519 identities, the
same isolation a real buyer and seller on two different devices would
have) drive: register → publish a real offer → discover it via the real
Marketplace → start a real Trade → real-time chat over a live WebSocket
→ escrow create/lock/mark-paid/release → settlement completes. No mocked
fetch, no mocked WebSocket, anywhere — anything shown to be broken here
is broken in the real stack.

**Found three real, reproducible gaps while making this pass reliably
— registered, not silently worked around:**

1. **`AuthContext.tsx` computes a real `loading` boolean for its
   post-reload re-authentication window but no page or layout component
   ever reads it** (`grep -rn "\.loading" packages/sails-ui/src`, zero
   matches outside that file). A full page reload leaves every form
   fully interactive while re-auth is still in flight; a fast actor can
   act before `user` populates, and the action silently no-ops
   (`PublishOffer.tsx`'s `handlePublish()`: `if (!user || ...) return`)
   instead of erroring or waiting. Worked around in the spec by waiting
   for the same signal `TopNav.tsx` itself uses (`"Conectar"` link
   presence) — a real user has no equivalent workaround available.
2. **`liquidity.service.ts`'s `discover()` orders SELL offers by
   `priceUsd` ascending and hard-caps at `take: 10`, no pagination, no
   "more results" signal.** After enough offers accumulate for an
   asset/side pair (exactly what running this very spec repeatedly
   does), a real, active offer priced above the 10th-cheapest becomes
   permanently invisible in the Marketplace — no error, no indication
   anything is missing. This is a real "descoberta" gap, not a database-
   hygiene inconvenience; it would affect a real busy marketplace the
   same way. Worked around in the spec by pricing the test offer to
   always sort first, which is a workaround for the *test's* stability,
   not evidence the cap itself is fine.
3. **Partial correction, 2026-08-09** — the literal `"🟢 Conectado via
   Pears"` string this item quotes no longer exists in
   `ChatWindow.tsx` (grepped directly, zero matches; likely refactored
   since this was written). Not re-verified whether the underlying
   reliability gap this item describes (a message sent before
   `JOIN_TRADE` completes being lost with no retry/backfill) was
   actually fixed or just relabeled — that's `packages/sails-ui`'s own
   territory, out of scope for this pass to investigate further. Original
   text, for reference: the label wasn't tied to the WebSocket's actual
   `readyState` or `JOIN_TRADE` acknowledgment, and a real user had no
   reliable "is this actually connected yet" signal.

Also required lifting the real rate limiter's ceiling for local e2e runs
specifically (`playwright.config.ts`'s `webServer.env`:
`RATE_LIMIT_AUTH_MAX=500`, `RATE_LIMIT_MAX=2000` — not a change to
`src/config/index.ts`'s real defaults, which stay `10`/`100`). The
default 10-per-minute auth tier (RT-002's own real mitigation) is
legitimately tight enough that one full golden-path run — two identities
each re-authenticating on every full page reload, amplified by React
StrictMode double-invoking effects in Vite's dev server — can exceed it,
turning an otherwise-correct run into a spurious 401/429 failure. Worth
revisiting once real usage data exists for what the production-tier
default should actually be; not touched here beyond disclosing it.

**Verification:** the spec passes reliably (6 consecutive runs after the
three fixes above, 0 flakes) against the real local stack. `npm run
build`/`npm test` unaffected (e2e lives in its own `e2e/` directory,
outside Jest's `testDir`). `test-results/`, `playwright-report/` gitignored.

---

## 24. Real concurrency proof — `e2e/concurrency.spec.ts` (2026-07-20)

CTO-directed follow-up to §22's robustness audit: that audit *fixed* a
real TOCTOU race in `escrow.service.ts`/`intent-engine.ts` (atomic
conditional `updateMany` claimed before any side-effecting provider
call), but every test that verified it did so against mocked, sequential
Prisma calls — legitimate unit coverage, but incapable of proving the
fix holds against genuinely simultaneous requests hitting real Postgres.
This file is pure HTTP (Playwright's `request` fixture, no browser)
against the real running backend, firing N truly-concurrent requests via
`Promise.all`.

Two scenarios, matching the CTO's own framing directly:

1. **"Duplicate escrow / duplicate settlement":** 10 concurrent
   `POST .../release` calls for the *same* escrow. Exactly 1 succeeds
   (200), 9 are rejected cleanly (< 500, never a second silent 200), and
   the final state is exactly one real release — one `txReleaseId`, not
   two, not a corrupted intermediate status.
2. **"100 offers, 100 buyers, 100 trades simultaneously"** (scaled to 20
   for a sandboxed environment): 20 fully independent trades created and
   released concurrently. All 20 succeed, and all 20 `txReleaseId`s are
   distinct — no cross-contamination between unrelated escrows sharing
   the same code path at the same instant.

Both pass, 4/4 clean runs against the real, correctly-fixed code.

**A regression-verification detour worth recording honestly.** Before
trusting scenario 1, I tried to prove it has teeth: temporarily removed
the `status: escrow.status` guard from `releaseFunds()`'s `updateMany`
`where` clause (so the claim would always succeed regardless of current
state) and inserted an artificial 50ms delay right after the initial
`findUnique`, to widen the race window. The test still reported exactly
1 success — which looked at first like a false negative in the test
itself.

It wasn't. Backend request logs (real timestamps, real reqIds) showed
why: of the 10 `Promise.all`-dispatched requests, only the first landed
and fully completed (`req-f`, done at `.631`) before the remaining nine
even arrived at the server (`req-g` onward, starting at `.856` —
225ms later). Playwright's `request` fixture does not guarantee all 10
calls hit the server as simultaneous TCP connections; enough client-side
staggering exists that, by the time the later requests' code ran, the
row was already `COMPLETED`. That meant the *unrelated*, pre-existing
`assertTransition(escrow.status, 'COMPLETED')` check — which runs before
the (deliberately broken) `updateMany` and independently rejects
re-entry into a terminal state, since `VALID_TRANSITIONS.COMPLETED` is
`[]` — was catching the late arrivals on a *freshly re-read* status, not
because the atomic-claim fix I'd broken was doing anything. The
artificial 50ms delay didn't help because it sat before that same
`assertTransition` call: it widened the window between the read and the
check, not between the read and the actual concurrent write each
request would race against.

Net effect: `assertTransition` is real, correct, defense-in-depth that
happens to also block duplicate settlement under *this specific test
harness's* actual arrival pattern — but it is not a substitute for the
atomic `updateMany` guard, and this test as written does not exercise
the guard in true isolation from that other check. Forcing genuinely
simultaneous arrival (e.g. a lower-level concurrent client, or
`maxSockets`/agent tuning) would be needed to test the `updateMany`
guard in isolation; not attempted here — registered, not built, per this
phase's "no new infrastructure" scope. Both temporary edits (guard
removal, artificial delay) were reverted before committing; the real fix
is unchanged from §22. Full suite reconfirmed green after revert: 224/224
Jest, 3/3 Playwright (golden path + both concurrency scenarios).

---

## 25. SDK hardening phase, part 1 — `examples/simple-wallet` dogfooding + a real gap it found and fixed (2026-07-20)

CTO-directed pivot (relayed 2026-07-20): now that `@satsails/p2p-trading-sdk` is the
primary product surface, stop adding functionality and start hardening
it — make it trivial for any wallet to integrate. First step: prove it,
don't assume it. `examples/simple-wallet` (new workspace, added to root
`package.json`'s `workspaces` array as `examples/*`) is a ~140-line
script using **only `@satsails/p2p-trading-sdk`'s public exports** — no reaching into
this monorepo's internal services, no mocks — that drives the entire
golden path against a real local Sails node: register (seller) →
register (buyer) → publish offer → discover it → open a trade → chat →
create + lock escrow → mark payment sent → release. 12 SDK methods, 9
narrated steps. Run via `npm run start -w @sails/example-simple-wallet`
(prerequisite: `npm run dev` from the repo root). See
`examples/simple-wallet/README.md` for the full walkthrough.

**A real, previously-unknown gap this surfaced, then fixed (not just
documented):** the first version of this example published its offer at
a realistic price (`priceUsd: '1.00'`) and step 4 — `liquidity.discover()`
finding the offer just published — failed outright. Root cause, found by
reading `liquidity.service.ts` directly: `InternalOrderBook.getOffers()`
had a hardcoded `take: 10` with no way for any caller (SDK or raw HTTP)
to reach anything beyond the 10 cheapest active offers for a given
asset/side — `GET /v1/liquidity/offers`'s query schema never accepted a
pagination parameter at all. This repo's own local dev database, after
dozens of E2E runs across §22-§24, had accumulated enough active
`USDT_ERC20`/`SELL` offers that a normally-priced new one silently fell
outside the top 10. This is exactly the class of bug the CTO's
hardening mandate exists to catch: invisible in every test written so
far (each one only ever asserted "my own offer is discoverable"
immediately after creation, on a database no other test had polluted
yet) and guaranteed to bite any real wallet integrating against a
genuinely active marketplace.

**Fixed, not worked around:**
- `src/modules/open-liquidity/liquidity.service.ts` — `LiquidityProvider.getOffers()` and `LiquidityRouter.getAggregatedOffers()` both gained an optional `pagination?: { limit?: number; offset?: number }` (new `OfferPagination` type). `InternalOrderBook.getOffers()` clamps `limit` to 1-50 (default 10 — unchanged behavior for every existing caller that doesn't pass one) and applies `skip: offset`. Aggregation across multiple providers is not globally re-paginated (documented as a known limitation, real follow-up once a second real provider — HodlHodl today is a disabled stub — actually exists).
- `src/modules/open-liquidity/liquidity.routes.ts` — `GET /v1/liquidity/offers` accepts optional `limit`/`offset` query params (zod-validated, `limit` capped at 50 — an out-of-range value is rejected with a clean 400, not silently clamped).
- `packages/sails-sdk/src/modules/liquidity.ts` — `discover()`'s filter type gained optional `limit`/`offset`, documented with the exact failure this fixes.
- `examples/simple-wallet/src/index.ts` — kept its low-price (`'0.01'`) workaround deliberately, with a comment explaining why: pagination lets a caller *browse* more of the market, but a wallet that already knows a specific offer id has no reason to page through `discover()` hunting for it — `liquidity.getOffer(offerId)` is the right call for that, and doesn't exist as a workaround here on purpose (see the example's own README for the fuller explanation).

**Verification:** `npm run build` clean, `npx jest` 224/224, `npx
playwright test` 3/3 (golden path + both concurrency scenarios) against
a freshly restarted backend on the new code. Direct `curl` checks against
the real endpoint confirmed all four behaviors: default (no params)
still returns exactly 10 — unchanged; `limit=50` returns 50 (this
database now has 50+ real accumulated offers); `limit=200` is rejected
with `400 VALIDATION_ERROR` (`"Too big: expected number to be <=50"`),
not silently clamped; `offset=10&limit=10` returns a genuine second page
(different offers than page one). The `examples/simple-wallet` script
itself ran clean 4/4 times end to end, including once against the fixed
pagination code specifically to confirm the golden path still holds.

**Addendum, same day, found rerunning the full Playwright suite after
the fix above:** `e2e/golden-path.spec.ts` — which had *already*
disclosed this exact `take: 10` cap in its own header comment since
§22/§23, with a "price it tiny" workaround — failed for the first time
in this session, for the reason its own comment predicted: enough
`R$0,01`-tier offers had accumulated (including from this very fix's
own verification runs) that a freshly published offer no longer
reliably ranked in the top 10 by price alone. Traced to the real product
code, not just the test: `packages/sails-ui/src/lib/realOffers.ts`'s
`fetchOffers()` — the actual Marketplace screen's data source — called
`sailsClient.liquidity.discover({ asset, side })` with no `limit`,
silently defaulting to 10. Fixed by passing `limit: 50` (the route's own
max) there too. This is the real UI, not a test-only fix — any live user
publishing into a sufficiently active market was hitting this exact
invisibility today. Re-verified: 3/3 Playwright, then `golden-path.spec.ts`
alone 3 more consecutive clean runs to confirm this wasn't luck given
how collision-prone the original failure was.

---

## 26. SDK hardening phase, part 2 — friendly aliases + `docs/API_STABLE.md`, the actual freeze (2026-07-20)

Direct follow-up to §25's item 3 ("API Freeze," CTO's original hardening
list). Before writing a frozen public-API document, this repo's own
`SailsClient` names (`identity`/`liquidity`/`openp2p`/`settlement`/
`reputation`) had to be reconciled against the CTO's proposed friendlier
names (`auth`/`offers`/`trades`/`escrow`/`profile`) — freezing the wrong
one, or freezing then renaming, defeats the point of a freeze. Resolved
as: **both names, permanently, as the same object** — not a rename, not
a deprecation of either side. `packages/sails-sdk/src/client.ts` gained
`auth`/`offers`/`trades`/`escrow`/`trustScore` as readonly properties
assigned in the constructor to the exact same module instance as their
protocol-name counterpart (`this.auth = this.identity`, etc.) —
`sdk.auth === sdk.identity` is a real, tested invariant
(`packages/sails-sdk/tests/client.test.ts`'s new "friendly aliases"
describe block: same-instance assertions for all 5 pairs, plus a
round-trip proving a session set through one name is visible through
its alias, i.e. they share the one real transport, not just reference
equality by coincidence).

**One deliberate deviation from the CTO's proposed names, corrected
before shipping, not after:** `reputation` has no `profile` alias.
Checked `modules/reputation.ts` directly — it only exposes `get()`
(a numeric score), `leaderboard()`, and `rate()` (informational only,
does not feed the score). No displayName, avatar, verified status, or
trade history — that data belongs to `identity.get()`/`identity.me()`.
Naming it `profile` would have shipped a permanently-frozen public API
name that overpromises what it returns. `trustScore` was chosen instead
— it names exactly what the module is. `chat` also has no separate
alias (never asked for one, once clarified) — it already lives inside
`openp2p`/`trades` (`sdk.trades.chat(tradeId)`), never a standalone
module.

**`docs/API_STABLE.md`** (new) is the actual freeze document this
section's title promises: every `SailsClient` module (protocol name +
friendly alias, or the note that none makes sense for `peers`/
`capabilities`), every real method with its one-line contract, and the
freeze commitment itself (no breaking changes to anything listed until
v1; new optional params/methods/modules are additive, not breaking).
Explicitly carves out the Intent facade's three still-throwing verbs
(`negotiate`/`submitProof`/`releaseAsset`) as NOT frozen — their
throw-vs-real status is expected to change, and that specific change is
additive. Cross-referenced from `docs/00-INDEX.md` (now 21 documents,
inserted as entry 6 right after `SDK_GUIDE.md`; the one other place in
that file describing the current table's own size as a live count,
not a historical reference to the original delivered set, updated to
match).

**Verification:** `npm run build -w @satsails/p2p-trading-sdk` clean, `npx jest
packages/sails-sdk` 44/44 (2 new tests). Full repo suite re-run after:
`npm run build` clean, `npx jest` 226/226 (224 + these 2 new tests),
`npx playwright test` 3/3.

**Addendum, same day — the real cost of dual-naming, and the actual
fix, not just a note:** raised directly (user feedback, not
self-identified): two names for the same module is not free — it's a
permanent tax on autocomplete discoverability specifically (a caller
typing `sdk.` sees 13 properties with no indication 5 pairs are
identical). It is *not* a runtime-drift risk — `this.auth =
this.identity` in the constructor means the two can never behave
differently, so there is nothing to keep "in sync" at runtime; the cost
is purely about a newcomer's first encounter with the type. Fixed, not
just accepted: every one of the 10 aliased/canonical properties in
`client.ts` now carries its own `/** */` JSDoc block (not a `//` line
comment — only block comments surface in editor hover) with an
`{@link}` pointer to its counterpart, confirmed to survive into the
compiled `.d.ts` (`tsc`'s `declaration: true` preserves JSDoc) — so
`sdk.auth`'s hover tooltip says "alias for `sdk.identity`, same
instance" without the reader needing `docs/API_STABLE.md` open.
`docs/API_STABLE.md` itself gained a short pointer to this. Considered
and rejected: namespacing aliases under `sdk.friendly.*` — would fully
eliminate the top-level autocomplete crowding, but costs a token on
every call (`sdk.friendly.auth.authenticate(...)`) for a problem the
JSDoc fix already solves without that tax. Verified: `npm run build -w
@satsails/p2p-trading-sdk` clean, the compiled `packages/sails-sdk/dist/client.d.ts`
inspected directly to confirm the JSDoc survived compilation, full
repo `npm run build` + `npx jest` 226/226 re-run clean.

---

## 27. SDK release-readiness pass — Release Candidate checks (2026-07-20)

CTO's own read of everything above: the SDK has crossed from "compiles"
to "used by a real application, found real integration bugs" — a
Release Candidate, not a place for more features. His follow-up list
(7 checks that build confidence, explicitly not new methods/modules) had
3 concrete inaccuracies against the real repo, corrected before running
anything: the example commands used the package name
`@sails/p2p-trading-sdk` (the real name is `@satsails/p2p-trading-sdk` — "Sails P2P
Trading SDK" is prose/marketing, not the npm package name); they assumed
the package is already published (`npm view @satsails/p2p-trading-sdk` → real `404`,
confirmed 2026-07-20 — nothing has ever been published); and the
suggested `CHANGELOG.md` heading was `v1.0.0`, which directly
contradicts `docs/API_STABLE.md`'s own freeze commitment ("0.1 becomes
1.0 once this SDK has had real external usage" — none exists yet).
Adjusted all three before doing the actual work, not after.

**What was actually run, all real, all against the real built package:**

- **Package footprint** (`npm pack` inside `packages/sails-sdk`): 22.3 kB
  packed, 77.4 kB unpacked, 31 files — far under any of the CTO's
  illustrative guesses (200 KB/800 KB/3 MB).
- **Standalone smoke test** — not `npm install @satsails/p2p-trading-sdk` against the
  real registry (nothing published there), but the equivalent that
  doesn't require publishing anything: packed the real tarball, created
  a folder with zero relation to this monorepo (own `npm init`, no
  workspace symlinks, no shared `node_modules`), installed only the
  tarball, and ran a script exercising every module, every friendly
  alias (`auth`/`offers`/`trades`/`escrow`/`trustScore`), same-instance
  identity between alias pairs, `generateKeypair()`, and every error
  class. All passed identically to running inside the workspace — this
  is the actual proof a fresh `npm install` + `import { SailsClient }`
  works, the real intent behind the CTO's items 2 and 7.
- **Tree-shaking — checked, found it doesn't apply, not silently
  claimed to work:** `packages/sails-sdk/package.json` declares only
  `main` (CommonJS) — no `module`, no `exports` map, no `sideEffects`
  flag, no ESM build at all. Real tree-shaking needs static ESM
  analysis; a CJS-only package cannot be meaningfully tree-shaken by any
  bundler no matter how a caller writes their `import`. Not fixed here
  — a dual CJS/ESM build is new packaging infrastructure, exactly what
  this phase is not supposed to add (the CTO's own "não pediria mais
  nenhuma feature" applies to packaging as much as to API surface).
  Recorded honestly in `packages/sails-sdk/CHANGELOG.md` as a known,
  unfixed gap rather than papered over.
- **TypeDoc** (new `packages/sails-sdk/typedoc.json`, `npm run docs`
  script) — generates real browsable API docs from source + JSDoc
  directly (0 errors, 1 benign warning about an unexported internal
  const array TypeDoc can't inline — not a code defect, not fixed, since
  exporting it would be new API surface for a purely cosmetic docs-tool
  complaint). Spot-checked the generated HTML directly to confirm
  §26's new alias JSDoc renders correctly. Output (`docs-api/`, ~1.5MB)
  gitignored — generated content, not committed, same pattern as
  `test-results/`/`playwright-report/`.
- **`packages/sails-sdk/CHANGELOG.md`** (new) — real history compiled
  from this package's actual 10-commit `git log`, not the CTO's
  illustrative placeholder entries. Correctly headed `[Unreleased]` (see
  the versioning-inaccuracy correction above), with real Added/Fixed/
  Changed sections plus a "Verified, not changed" section documenting
  the package-footprint/smoke-test/tree-shaking/Node-version findings
  from this pass directly in the artifact a consumer would actually
  read.
- **Node LTS validation — genuinely not done, disclosed, not faked.**
  This environment has only Node 24.16.0 (`node --version`) and no
  version manager (`nvm`, `fnm`, `volta`, `n` all absent — checked
  directly, not assumed). Installing a second Node runtime is a real
  system change, not a reversible code edit — registered as an open gap
  in the CHANGELOG rather than silently skipped or claimed complete.

**Verification:** `npm run build` clean (unaffected by the new
`typedoc` devDependency), `npx jest` 226/226.

---

## 28. Final pre-handoff public-API audit (2026-07-20)

CTO's explicit closing request before the SDK passes to a dev for
ongoing maintenance: audit `@satsails/p2p-trading-sdk` as an external developer seeing
it for the first time, looking specifically for internal leakage onto
the public surface — not a feature review. 8 categories requested; each
checked against real code, not assumed. Fixed only what was real; did
not implement anything new.

| # | Category | Result | Severity |
|---|---|---|---|
| 1 | Public APIs exposed unnecessarily | **Found — fixed.** `SailsTransport`/`SailsTransportOptions` re-exported from the public barrel (`index.ts`) despite zero documented use case, zero real external usage (`packages/sails-ui`, `examples/simple-wallet` — grepped directly), and this package's own tests already importing it straight from `./transport`, never through the barrel. | High |
| 2 | Exported types that should be internal | **Found — fixed.** `SailsIntentFacade` (the class) exported from the public barrel despite `SailsClient.intents` being deliberately `private` — the class export directly contradicted its own encapsulation intent, letting a caller construct one against a raw transport and bypass `SailsClient`'s session management entirely. Zero real usage confirmed. The two payload types it also exports (`NegotiationEvent`, `ProofSubmission`) stayed exported — `negotiate()`/`submitProof()` callers genuinely need them. | High |
| 3 | Public methods never used | **Checked, no fix needed.** Several methods (`settlement.refund`/`resolveDispute`, `reputation.rate`, all of `peers`/`capabilities`) have no current internal caller — but each maps 1:1 to a real, tested backend route (verified across this whole session's work), not accidental cruft. Flagging "unused by today's one internal consumer" as a defect would be wrong for a v0.1 SDK whose entire purpose is serving future third-party wallets that don't exist yet. | — (not a finding) |
| 4 | Imports from `src/internal` or private paths | **Checked, clean.** `grep -rn` across the whole package for reaches outside `packages/sails-sdk` (`../../../`, `@/`, etc.) — zero matches. | — |
| 5 | Circular dependencies | **Checked, clean.** `npx madge --circular` — "No circular dependency found!" | — |
| 6 | References to the backend violating the API Freeze | **Checked, clean.** No hardcoded backend URLs or `process.env` reads in actual code — the one `localhost:3000` match is a doc-comment example illustrating "never hardcode this," not a real reference. | — |
| 7 | TODO/FIXME/HACK inside the public SDK | **Checked, clean.** The only "TODO" matches are legitimate cross-references to `docs/TODO.md` (this file) — no real incomplete-work markers. | — |
| 8a | TypeScript warnings hidden by casts | **Found — fixed (minor).** One `as unknown as typeof fetch` in `transport.ts`'s constructor — not a real bug (the field is validated and thrown-on immediately after), but avoidable: restructured to resolve into a local variable, validate, then assign — the field's `typeof fetch` type now genuinely guarantees "always present" instead of that guarantee resting on a cast plus an easy-to-break immediate-throw convention. | Low |
| 8b | Public documentation diverging from implementation | **Found — fixed.** `docs/SDK_GUIDE.md` section 2's interface block — despite its own banner claiming "verified route-by-route" — had drifted substantially from the real implementation across `identity` (wrong method names, `verify()` never built — real flow is `challenge()`+`authenticate()`), `liquidity` (`discover`/`publish`/`match` all wrong signatures, `cancel()` never implemented — real equivalent is `updateStatus()`), `settlement` (`create`/`dispute` wrong signatures/return types), and `reputation` (`rate()` wrong signature). Rewritten to match `packages/sails-sdk/src/modules/*.ts` exactly; file's own status banner updated with this correction and a pointer to `docs/API_STABLE.md` as the actual frozen contract if the two ever disagree again. | Medium |

**No Critical findings.** The two High findings were about surface area
(internal classes reachable that shouldn't be), not correctness or
security — nothing in the shipped `dist/` behaved incorrectly, no data
exposure, no broken contract. Both are now fixed.

**A real regression this pass's own fixes exposed, fixed in turn:**
rerunning `examples/simple-wallet` after these changes hit the exact
§25/§26 pagination-collision class again — this repo's shared local dev
database had, by this point in the session, accumulated more than 10
offers *also* priced at the same minimum tier (confirmed via a direct
`curl` — the top 10 at default `limit` were six `0.01`s and four
`0.00`s), so the example's own low price stopped being sufficient on
its own. Fixed the same way `packages/sails-ui`'s `realOffers.ts` was
fixed in §25: added `limit: 50` to the example's `discover()` call too.
Real, if slightly funny, proof the underlying gap is real — even this
fix's own demo needed the fix.

**Verification:** `npm run build` (backend+SDK+UI) clean, `npx jest
packages/sails-sdk` 44/44, full repo `npx jest` 226/226, `npx playwright
test` 3/3, `examples/simple-wallet` re-run twice clean against the
trimmed public surface.

---

## 29. Qwen-sourced review, Fase 2 round 1 (2026-08-10) — DX/observability/reconciliation

Founder relayed 3 recommendations from a separate Qwen-based repo review.
Each checked against real code before acting — the filter applied: does
this block a live demo with a partner wallet? If not, and it's real,
it's registered here for the roadmap, not fixed unnecessarily; if it's
already done, it's marked done, not silently dropped.

| # | Recommendation | Result |
|---|---|---|
| 1 | ESM + tree-shaking for `@satsails/p2p-trading-sdk` (dual CJS/ESM build) | **Already done.** `package.json`'s `exports` map (`import`→`.mjs`, `require`→`.js`) + `sideEffects: false`, built via `tsup`. The source Qwen read was stale. |
| 2a | k6/Artillery load tests on critical paths (concurrent `releaseFunds`, trade creation) | **Already done.** `load-tests/tests/escrow-operations.js` runs the full create→lock→payment-sent→release flow under concurrent VUs; `trade-lifecycle.js`/`reconciliation.js` cover the rest. |
| 2b | OpenTelemetry distributed tracing (P2P event → settlement confirmation latency) | **Real gap, genuinely not built — registered here as roadmap, not implemented this pass.** `common/metrics.ts`'s own header already explains why: real Prometheus counters/histograms were built and are live at `/metrics`, but full distributed tracing needs a vendor decision (which backend, who operates retention, cost) that's the project owner's call, not something to commit to unilaterally. Not a demo blocker — no partner-wallet-facing flow depends on trace visibility. |
| 3 | E2E test proving `Timeline`/`ReconciliationService` event replay survives a network drop without duplicating actions | **Premise didn't match the real architecture — checked directly, not assumed.** `ReconciliationService` never replays P2P events; it re-reads Postgres, the single source of truth (`reconciliation.service.ts`'s own header states this). The real duplicate-action protection is `escrow-lifecycle.ts`'s atomic `claimEscrowTransition()` (a concurrent duplicate transition throws instead of double-executing) — already real, already covered (`tests/race-condition.test.ts`). `e2e/flows/network-reconnection.spec.ts` already covers the real recovery path (server-side Postgres persistence + client reload-to-resync) and is honest in its own comments about what a browser-driven test can't observe (backend-to-backend P2P reconciliation). |

**A separate, real, demo-relevant thing verified while checking item 3
(not something this table's "no action needed" would have caught on its
own):** `tests/reconciliation-poisoning.test.ts` had flagged a genuine
unfixed vulnerability at the time it was written — a P2P HANDSHAKE
message's `userId` was trusted with zero verification
(`pear.service.ts`). This is exactly the kind of path a live demo with
an external partner wallet actually exercises, so it was checked for
real, current test coverage rather than trusted at face value: the fix
(`verifyHandshakeIdentity()`, checks the claimed `userId` against the
real `User.peerId` on record) is real and `tests/handshakeSpoofing.test.ts`
(5 cases: legitimate accept, impersonation reject, never-started-node
reject, nonexistent-user reject, malformed-input reject) passes clean
today — reconfirmed by running it, not by reading the file.

**Verification:** `npx jest tests/handshakeSpoofing.test.ts
tests/reconciliation-poisoning.test.ts` — 2/2 suites, 8/8 tests.

---

## 30. Qwen-sourced review, Fase 2 round 2 (2026-08-10) — network topology, infra security, custody evolution

Same filter as §29: does this block a live demo with a partner wallet?
If real and not blocking, registered as roadmap here, not implemented
unnecessarily.

| # | Recommendation | Result |
|---|---|---|
| 1 | Resolve the custody gap: Account Abstraction (ERC-4337 + Smart Contract Wallets) for EVM, MuSig2/Taproot for Bitcoin/Liquid — protocol should orchestrate partial-signature collection, not depend on a server seed | **Substantially already done.** `SAFE_GUARD_EVM` (RFC-020) is real ERC-4337 Account Abstraction: real CREATE2 address prediction, real `UserOperation`/`userOpHash` construction, real 2-of-3 signature aggregation (buyer, seller, KMS co-signer — the one server-held key lives in AWS KMS, never in app memory/env), real bundler submission. Bitcoin's `MultisigProvider` is already 2-of-3 client-held-key multisig (not server-custodial) — but P2WSH, not MuSig2/Taproot; that upgrade is already registered in RFC-020 itself as a documented future target, not newly discovered here. **Real remaining gap, not architectural:** none of this has been exercised against live infrastructure yet (funded testnet account, live bundler) — that's task #44/#45 already tracked above, not a new item. |
| 2 | P2P resilience in restrictive networks (corporate NAT/CGNAT) — evaluate TURN relays or WebRTC fallback beyond HyperDHT | **Goal already met, by a different real mechanism.** `FallbackTransportProvider` races Pears against a 5s timeout and falls back to a real WebSocket relay through the Sails server itself — same problem (direct P2P blocked by restrictive NAT) solved without TURN or WebRTC specifically. Registered as roadmap: evaluating TURN/WebRTC as an alternative to the current self-hosted relay (different trust/scaling profile — all relayed traffic passes through the Sails server today, not a dedicated third-party relay) is a real, undecided architecture question, not implemented this pass. |
| 3 | Bulkheading: a QVAC or Pears failure must not block the Intent Engine's main state machine; use async event queues (RedisStreamsEventStore) | **The isolation itself is already real; the Redis part isn't active.** Verified directly: `intent-engine.ts` never calls QVAC/Pears synchronously, and `event-store.ts`'s `subscribe()` catches every handler's rejection without propagating it — a downstream QVAC/Pears-consuming handler failing genuinely cannot block or crash the Intent Engine's own state transitions, today, already. Real, precise gap: `RedisStreamsEventStore` (task #56) is built and real, but `event-bus.ts`'s singleton still defaults to `InMemoryEventStore` — events don't survive a process restart yet. Registered as roadmap (wiring + config to activate Redis Streams as the default backend), not a demo blocker since the isolation property itself doesn't depend on which store is active. |

**Verification:** read directly (`intent-engine.ts`, `event-bus.ts`,
`event-store.ts`, `transport-provider.ts`, `safe-guard-evm.provider.ts`,
`multisig.provider.ts`, RFC-020) — no code changed this round, findings
only.

---

## How to Use This List

Work top to bottom by section number unless a specific business priority
overrides it. Section 1 ("Missing Files," the route wiring) is now fully
closed — every module has both a real service layer and HTTP routes.
What's left is genuinely lower-leverage: production-grade Settlement/
Liquidity providers (sections 4-5), rate limiting (6), remaining test
coverage (10), and the CRDT-free `FallbackTransportProvider`/`/ws/relay`
gap `BACKLOG.md` P0 tracks. Update the checkboxes in this file as you go;
don't let this document drift out of sync with reality the way this
version did before the 2026-07-16 re-audit.
