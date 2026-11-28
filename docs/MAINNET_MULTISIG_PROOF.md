# Bitcoin Mainnet MULTISIG Proof (Missão 09, 2026-08-18)

Historical, auditable record of a real, micro-value Bitcoin mainnet
settlement executed end-to-end through Sails' MULTISIG 2-of-3 provider
(`src/modules/open-settlement/multisig.provider.ts`), using only the
same public methods a real client integration would call
(`escrowService`/`@satsails/p2p-trading-sdk`'s `signEscrowPsbt`/
`generateEscrowKeypair`-equivalent derivation). This is not a simulation,
not a mock, and not testnet — real BTC moved on Bitcoin mainnet.

Rehearsal script: `examples/demo/multisig-testnet-flow.ts` (originally
testnet-only, extended in this mission to support mainnet — see that
file's own header comment for the change history).

## Context

Sails had a real, unit-tested MULTISIG provider with no end-to-end proof
against real funds. Missão 09 set out to answer: can Sails' public
API/SDK surface move real BTC through a genuine 2-of-3 P2WSH escrow,
buyer/seller keys client-held throughout, no server-side custody
shortcut? A deliberately small, self-funded, total-loss-accepted amount
(30,000 sats) was used — real risk, minimized in size, per the CTO's
explicit authorization.

## Funding

- txid: `5815534b3695d47e0a799736e376cb725a9e93d6dafe781673643447fc96a2ed`
- vout: `1`
- amount: `30000` sats
- P2WSH address funded: `bc1q3jyc5pm43z4m8tyl8zyunlkp3a44rmxex2kmcym2wsnjq4x8znhqans03s`
- confirmed on-chain (independently verified via mempool.space and blockchain.info)

## Release

- txid: `db0b5e4bae9f81d15169d33975de5581db850ce9cdc7356b25843d330fbd6ca8`
- input spent: `5815534b3695d47e0a799736e376cb725a9e93d6dafe781673643447fc96a2ed:1` (exactly the funding outpoint)
- destination: `bc1q7mrvhs3xxzg9jyesd60nvda26ueukn9nc404xk` (buyer's own P2WPKH payout address, derived from the buyer's client-held escrow pubkey — a rehearsal stand-in; no per-user payout-address record exists in the schema for this path yet, same disclosed gap `dispute.service.ts`'s own comment already flags for WDK's refund path)
- amount: `29836` sats
- miner fee: `164` sats (`30000 − 29836`), ≈1.00 sat/vB over a ~164 vB conservative 2-of-3 P2WSH estimate
- confirmed on-chain, block height `963109` (independently verified via mempool.space and blockchain.info, both agreeing on block height, input, output, and fee down to the byte)

## What the transaction itself proves (not "the server said so")

Decoding the release transaction's witness directly (not trusting Sails'
own report of it):

```
witness[0]: <empty>                     (OP_CHECKMULTISIG's off-by-one legacy quirk)
witness[1]: <buyer's ECDSA signature>   (71 bytes, DER + sighash byte)
witness[2]: <seller's ECDSA signature>  (72 bytes, DER + sighash byte)
witness[3]: <witnessScript>             (105 bytes)
```

The `witnessScript`, decompiled directly with bitcoinjs-lib rather than
assumed:

```
OP_2
<arbiter pubkey>  0215d7c18bb58d1e5b25686a231fe6af2cfdb26bcb69ae461fcfb37934a6344c7e
<buyer pubkey>    030270bc3b401df1486e357e28cb5de90be6b7354bf54cbcdf9d4b964ca256c359
<seller pubkey>   039703a7077ddd812f649b7533b412673e758c936ef180139f819f3088942c2c81
OP_3
OP_CHECKMULTISIG
```

Three distinct 33-byte compressed pubkeys, `OP_2 ... OP_3 OP_CHECKMULTISIG`
— a real 2-of-3 threshold, and Bitcoin's own consensus rules already
reject a `CHECKMULTISIG` spend with fewer than the required valid
signatures against the exact pubkeys named in the script (this is not
something Sails enforces client-side — the Bitcoin network itself would
have rejected this broadcast otherwise, and it didn't). There is no
script variant of `OP_CHECKMULTISIG` that a single key could satisfy
under a 3-pubkey/threshold-2 script — this is a structural, not a
policy-level, guarantee. This is B (the transaction demonstrates 2-of-3),
not A (a claim Sails makes about itself).

## Custody / key-ownership evidence

- Buyer and seller each held their own 32-byte seed (`DEMO_BUYER_SEED`/
  `DEMO_SELLER_SEED`) client-side only, in a local file outside the git
  repository, outside the OS temp directory, with NTFS ACLs restricted
  to the operator's own Windows account.
- Buyer/seller private keys were derived deterministically from those
  seeds plus the escrow's own id (`keyIndexFor(role, escrowId)`, the
  same exported primitive `multisig.provider.ts` already uses
  server-side for the arbiter key) — never generated or held server-side.
- The server (`EscrowParticipantKey.pubkey`, confirmed directly in
  `prisma/schema.prisma`) only ever stores the 33-byte compressed public
  key. No `privateKey`/`seed` column exists anywhere in the
  `EscrowParticipantKey`/`EscrowPendingTransaction`/
  `EscrowTransactionSignature` tables — structurally impossible for
  Postgres to hold what the schema has no column for.
- `EscrowTransactionSignature.signedPsbtBase64` holds a *signature*
  (the buyer/seller's own client-produced signed PSBT copy) — a
  signature does not reveal the signing private key.
- No Sails application code path (routes, services, providers) ever
  calls `console.log`/`logger.*` with a seed or private key value —
  confirmed by direct code reading, not inferred.
- Recovery was proven twice, on two different key-rotation generations,
  across a real, deliberate process kill each time: same seed + same
  escrowId → same derived pubkey → same P2WSH address → real spend
  capability (proven offline by combining+finalizing a deterministic
  dummy PSBT with both recovered keys before ever touching real funds).
  A different escrowId with the same seed independently produced a
  different pubkey/address, closing the address-reuse bug this
  mission also found (see H6 below).

## Address uniqueness

An earlier version of this mission's key-derivation fix bound buyer/
seller keys only to the client seed, not to the specific escrow — two
different escrows built with the same seeds derived byte-identical
pubkeys and the identical P2WSH address. Confirmed directly (escrow
`418d10d8...` and escrow `67738ec6...` both derived the same
`bc1q7jvjavwg...` address) before any funds were sent to it. Fixed by
binding derivation to `escrowId` (see H6/H7 below) — re-verified after
the fix that two different escrows built from the *same* seeds produce
two *different* addresses, and that a real client restart against the
*same* escrowId recovers the *same* address, confirmed against the real
`multisigProvider.getDepositAddress()` production code path, not a side
reimplementation.

## Pre-signature verification

Before any client signature was produced against real funds, the
rehearsal script decoded the actual, already-persisted, unsigned PSBT
(never reconstructed) and printed: input outpoint, input value,
destination, every output and its amount, absolute fee, estimated fee
rate, an explicit check that only the expected single output was
present, and the required signer ids — a human read and approved all of
that before `DEMO_AUTHORIZE_SIGN=true` was ever set. See H8.

## Miner fee

`164` sats, entirely accounted for by `input (30000) − output (29836)`.
Verified independently via two sources reading the raw transaction, not
computed from Sails' own report.

## Sails Protocol fee

> **Corrected/Implemented 2026-11-27:** this paragraph is a historical record of the rehearsal. `chargeProtocolFee()` and the `PROTOCOL_FEE_RATE` setting were retired later (Missao 11 Fase 6.5.2); fees are now a `FeePolicyVersion` (versioned locally on each node today) that is not economically activated. The conclusion below (no Sails Protocol fee in this settlement) is unchanged.

Audited directly against the real code (`escrow-lifecycle.ts`'s
`chargeProtocolFee()`, called unconditionally from `escrow.service.ts`'s
release-completion path): the mechanism is real and wired into this
exact release, but gated by `config.settlement.protocolFeeRate`
(`PROTOCOL_FEE_RATE` env var, defaults to `0`, the documented
bootstrap-phase default). That env var was never set in this rehearsal,
so `chargeProtocolFee()` returned `null` immediately (`if (!rate ||
rate <= 0) return null`) — confirmed directly against Postgres:
`Escrow.feeCharged` is `null` for this escrow, and zero rows exist in
`fee_distributions` for it. **The 164 sats are entirely Bitcoin miner
fee — no Sails Protocol fee was charged in this settlement.**
Classification: B — implemented, not applicable here (rate configured
to 0).

## What was proven

- Real BTC, real Bitcoin mainnet, no simulation.
- A genuine P2WSH 2-of-3 script, demonstrated by the broadcast
  transaction's own witness — not merely claimed by Sails.
- A real funding UTXO, independently verified.
- A real unsigned PSBT built by the real provider, decoded and
  human-reviewed before any signature.
- Real buyer and real seller client-side signatures, produced with
  private keys that never left the client side.
- Real server-side combine/finalize. In this cooperative rehearsal the server held no participant signing key and only combined the two independently produced participant signatures; the arbiter key remains derived on the server, as stated elsewhere in this document.
- A real mainnet broadcast, with a confirmed release transaction.
- Both the funding and the release are independently, externally
  verifiable by anyone via public block explorers — this proof does not
  depend on trusting Sails' own report.
- Client key recovery across a real process restart, including a
  seed-rotation exercise for full custody hygiene.

## What was NOT proven

Deliberately not overclaimed:

- Production-scale custody. This was a single micro-value (30,000 sats)
  rehearsal, not a load-bearing custody system.
- An audited cryptographic implementation. No third-party security audit
  of `multisig.provider.ts` or the client-side derivation has occurred.
- High-value safety. Dust-threshold handling and a few other hardening
  items remain open (see H1-H9 below) — none were exercised at a value
  where they would have mattered here, but they are real gaps for
  larger amounts.
- Production key-backup UX. The seed-file backup used here is an
  operator-run rehearsal mechanism, not a shipped wallet UX.
- Hardware wallet integration. Not attempted in this mission.
- Multi-provider settlement in the same flow. This mission tested
  MULTISIG only.
- Refund or split on mainnet. Only the cooperative release path was
  exercised with real funds; refund/split remain unproven against real
  BTC (deterministic/local tests cover their logic, not a real broadcast).
- Protocol fee monetization at a nonzero rate. Confirmed not charged in
  this run because the rate is configured to 0, not because charging it
  was tested and found safe.
- Arbitrary concurrency or load. This was one escrow, one release, no
  concurrent settlement activity.
- Institutional custody compliance. Out of scope entirely for this
  mission.

## Hardening findings (H1-H9)

See `docs/BACKLOG.md`'s "Known Debt — MULTISIG production-hardening"
section and this document's own Fase-6 audit (Missão 09 final report)
for the full list, carried forward as real, disclosed, unfixed debt
rather than resolved by this proof succeeding.
