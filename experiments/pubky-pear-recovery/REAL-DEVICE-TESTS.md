# Real-device test plan (Mission 04, step 3): Pubky Ring, phones, real networks

Status: **PREPARED, NOT EXECUTED.** I (the assistant) cannot run Pubky Ring or phones; these tests need the infrastructure-dev partner. Until results are
filled in, every row below is **UNKNOWN** and no emulation result may be reported as equivalent (CTO decision, #545 point 4).
Everything is disposable: fresh identities, no wallets, no funds, no production Sails or Satsails services, no personal data.

## What is already ready (self-tested against the lab, with the SDK signer standing in for Ring)

| Kit (`field/`) | Purpose | Self-test |
|---|---|---|
| `integrator.mjs` | prints the `pubkyauth://` URL to paste/scan in Ring, then publishes the Pear authorization every `--refresh` s; logs `refused-by-homeserver` when the grant is revoked | `homeserver/test/09-field-kit-selftest.test.mjs` F1 |
| `verifier.mjs` | second integrator on another network: prints per-poll ACCEPT/REFUSE under window N (default 300 s) | F1 |
| `pear-echo.mjs` | server/client connectivity probe: connect time, direct vs LAN vs relay, RTT, reconnect | F2 (loopback only) |
| `mailbox.mjs` | offline delivery: sender writes a sealed message and goes offline, seeder holds it, recipient reads | `test/field-mailbox.test.mjs` M1 (local testnet) |

## Prerequisites (blockers if missing)

1. **A homeserver Ring can reach.** The lab testnet is not reachable by Ring (it expects mainnet PKARR/DHT). Options: (a) self-host `pubky-homeserver` v0.16.2 (`docs/deploy` upstream; same signed tag used in the lab) on a throwaway host, or (b) use a public homeserver ONLY with its operator's explicit authorization (CTO point 4: "external infrastructure tests only with explicit authorization from its operator"). Record the choice.
2. Two disposable phones (Android and iOS if available) with the **official store build** of Pubky Ring; record version and store listing publisher.
3. Two laptops on **different networks** (home Wi-Fi vs phone hotspot) with Node 24 (or Docker and the `ppr-runner` image).
4. For Pear on phones: a Pear/Bare mobile test app. **None exists in this repo.** Either (i) a separate small mission builds a minimal Bare Kit (iOS/Android) app that runs the same `pear-echo` logic, or (ii) record phone rows as BLOCKED. Using Keet or any third-party app does not prove Sails' own stack; do not report it as equivalent.

## Test matrix (fill in; record date, versions, network, device, raw log file)

| # | Test | Steps (short) | Expected | Result |
|---|---|---|---|---|
| R1 | Versions | note Ring build, OS, SDK `0.16.2`, homeserver build, Node | recorded | UNKNOWN |
| R2 | Create a disposable identity in Ring and make the backup Ring offers (recovery file / seed) | screenshots of the backup step | an identity exists; backup type recorded | UNKNOWN |
| R3 | Grant through Ring | `node field/integrator.mjs [--testnet-host ...]` (set your homeserver) -> paste the URL in Ring | the consent screen lists the capability paths; note whether per-path narrowing exists; note the grant lifetime shown (lab: 2 years) | UNKNOWN |
| R4 | Restriction | approve fewer capabilities if Ring allows | integrator logs the narrowed `caps`; writes outside are refused | UNKNOWN |
| R5 | Directory seen from another network | `node field/verifier.mjs --identity <z32> --pear <hex>` on the second network | ACCEPT while the integrator keeps publishing | UNKNOWN |
| R6 | Revocation | revoke the grant in Ring; keep both kits running; note the wall-clock time | integrator logs `refused-by-homeserver`; verifier refuses within N (300 s) of the last accepted write. **Record the exact seconds.** | UNKNOWN |
| R7 | Recovery on another device | wipe/reinstall Ring (or use the second phone), restore the identity from the backup | same Pubky id (z32); a new grant works; the NEW Pear key differs | UNKNOWN |
| R8 | Re-authorization | run the integrator again; compare Pear key and record | new key accepted, old record removed or expired | UNKNOWN |
| R9 | Pear across networks | server on network A `node field/pear-echo.mjs --role server`; client on B `--role client --key <hex> --pings 20`; repeat 20 times, with and without a relay | per run: open time, `remoteHostClass` (public = direct, private/LAN = LAN shortcut), RTT median; success rate; relay fallback | UNKNOWN |
| R10 | Reconnect | kill the client network (airplane mode 30 s) mid-session | `reconnecting` then `open` again; time to recover | UNKNOWN |
| R11 | Offline delivery across networks | `mailbox.mjs write` on A (hold 120), `seed` on a third host, A goes offline, `read` on B | `delivered` within 30 s of the reader starting | UNKNOWN |
| R12 | Phones: Pear connectivity (needs prerequisite 4) | run the probe app on Android and iOS, cellular vs Wi-Fi | as R9 | UNKNOWN / BLOCKED |
| R13 | Background and battery (needs prerequisite 4) | app backgrounded 10 min with an incoming message | delivery behaviour and battery drop % recorded per OS | UNKNOWN / BLOCKED |
| R14 | Resource use of the kits | `--duration 1800`, sample CPU/RSS every minute | numbers recorded | UNKNOWN |
| R15 | Timeouts | disconnect the homeserver host for 60 s while the verifier polls | `record-unavailable` (fail closed), recovery afterwards | UNKNOWN |

## Evidence to hand back

One folder per run: the JSON-lines logs of each kit, screenshots of Ring's consent / revoke / expiry screens, device and OS versions, network descriptions (no public IPs: redact), and a one-line verdict per row.
Delete the disposable identities and stop all announcing processes afterwards. The assistant will tabulate PASS / FAIL / UNKNOWN from the folder; nothing is PASS without a log.
