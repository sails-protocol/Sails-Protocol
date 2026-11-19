# Contract for the scenario drivers D7-D12 (NOT written yet)

`run-once.sh` runs every `tests/regtest/first-flow/scenarios/*.check.ts` that exists in the tree, one at a time, from the code tree:
`npx ts-node --transpile-only tests/regtest/first-flow/scenarios/<name>.check.ts`. If the directory has no driver, the run says so
(`scenarios-status.txt`: `ABSENT ... NOT run`) and the summary says the scenarios were **not demonstrated**. A driver that is missing never counts as a pass.

## What a driver gets (environment)
`RPC_URL`, `RPC_USER`, `RPC_PASS` (ephemeral), `PROXY_URL` (the loopback front proxy: the ONLY explorer the provider may talk to),
`MULTISIG_NETWORK=regtest`, `MULTISIG_EXPLORER_API_URL=$PROXY_URL`, `MULTISIG_SEED` (generated for this run), `FIXED_FEE_SAT_PER_VB`, `OUT_DIR`, and the job's
`DATABASE_URL` (ephemeral PostgreSQL service). Fresh chain: 0 blocks at start; the driver mines what it needs with `generatetoaddress`.

## What a driver must do
Use the **real** explorer path, PSBT construction, signing and broadcast against the node. **Nothing simulated on the economic path.** The only declared
non-real element is the fixed fee of the proxy (a policy input, not market data). Flags such as C4 off and `enabledRails` = BTC MULTISIG only must be set
explicitly and recorded in the driver's own output (the owner of the driver defines the exact configuration names; they are not guessed here).
Per the P51 specification (the scenario table):

| D | Scenario | Real execution on regtest | Evidence |
|---|---|---|---|
| D7 | address only after `COMMITTED`; funding in a later block; binding (#621) | `sendtoaddress` + `generatetoaddress` | funding txid, `txLockId:vout`, `fundedAmount` |
| D8 | cooperative RELEASE and RELEASE by ruling | real signatures, one broadcast | txid; decoded tx outputs = the outcome's outputs |
| D9 | REFUND | same | same |
| D10 | SPLIT (protocol fee **inactive**, buyer fixed) | same | same; the seller's rounding = the remainder |
| D11 | dispute, ruling, R1/R2, single broadcast | real SDK/services | 0 POST for an incompatible round; 1 for the faithful one |
| D12 | operator restart / SIGKILL and a reorg (`invalidateblock`) | real process | no duplicate round; evidence reclassified |

## What a driver must write (the structure the two runs are compared on)
`$OUT_DIR/structure-<name>.json`, for example `structure-d08-release.json`. Allowed content: **states, refusal codes, values in sats, number of outputs,
output types (`p2wpkh`/`p2wsh`/`p2tr`), number of broadcasts**. Forbidden (the comparison fails on them): any key named
`txid`/`hash`/`blockhash`/`block_hash`/`height`/`block_height`/`time`/`block_time`/`timestamp`/`ts`/`address`, and any 64-hex string value.
Audit detail with full txids and raw transactions goes into a **different** file name (not `structure-*.json`), for example `d08-release.json`, which is uploaded
but not compared.

```json
{
  "scenario": "d08-release",
  "finalState": "RELEASED",
  "broadcasts": 1,
  "outputs": [{ "type": "p2wpkh", "valueSats": 990000 }],
  "refusals": []
}
```

## Dependencies
D2-D6 depend on #235, F3 and F4 and are **not** part of the first demonstration. D7-D12 run on the legacy admission with the composed M9-R chain. The
first demonstration must say which of D7-D12 actually ran, and C1-C7 that depend on D2-D6 are "not demonstrated".
