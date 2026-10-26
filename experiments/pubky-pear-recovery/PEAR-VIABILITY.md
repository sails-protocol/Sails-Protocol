# Pear operational viability (Mission 03, item 4)

Scope: lab evidence for Pear/HyperDHT as the Day 0 candidate. Pubky Noise was NOT implemented and Pear was NOT removed.
Versions: `hyperdht` 6.34.1, `hyperswarm` 4.17.2, `hypercore` 11.39.3, `blind-relay` (transitive), `bare-runtime` 1.36.0, Node 24.22.1 (Linux container).
Evidence: `p2-evidence/pp3/` (natlab-matrix.log, public-dht.log, bare-check.log, offline test output).

## Results (PASS / FAIL / UNKNOWN)

| # | Item | Result | Evidence and limits |
|---|---|---|---|
| 1 | Authenticated peer-to-peer channel; remote key on the wire equals the authorized key | **PASS** | PR #543 (loopback testnet) |
| 2 | Connect when one side is behind a NAT (other direct) | **PASS** | natlab: 16-17 ms, both directions (Linux iptables MASQUERADE) |
| 3 | Connect when BOTH sides are behind cone-type NATs | **FAIL in the lab** | `HOLEPUNCH_ABORTED` after 10 s. **Not isolated**: this is a Linux conntrack emulation on one shared L2; real home routers are known to behave differently, so this must not be read as a statement about real NATs: **UNKNOWN for the real world** |
| 4 | Cone/symmetric and symmetric/cone | **FAIL in the lab** | `HOLEPUNCH_ABORTED` after 36 s |
| 5 | Symmetric/symmetric | **FAIL in the lab** | aborted at once (both randomized) |
| 6 | Blind-relay fallback when punching fails (cone/cone) | **PASS** | connects through the relay in 28-38 ms. Requires a relay peer that Sails (or someone) operates and clients configured with its key (`relayThrough`) |
| 7 | Blind-relay fallback with symmetric NATs | **FAIL in the lab** | `CHANNEL_CLOSED` after 8 s |
| 8 | Public HyperDHT reachability from a real network | **PASS (weak)** | two containers behind this machine's home NAT reached ~75 DHT nodes, announced and connected in 1.9 s. Both share ONE public IP, so the LAN shortcut was used: this does NOT test cross-network hole punching |
| 9 | HyperDHT under the Bare runtime (what Pear mobile uses) | **PASS (Linux x64 only)** | `bare` v1.36.0 ran the same round trip. **Real iOS/Android: UNKNOWN** (no device, no emulator here) |
| 10 | Live delivery while both online | **PASS** | tests above, plus 56-test suite |
| 11 | Delivery while the recipient is offline, direct channel | **FAIL (expected)** | connection fails: this is what `TransportProvider.sendToPeer` returns `false` for |
| 12 | Offline delivery by store-and-forward (Hypercore mailbox + always-on seeder, sealed to the recipient's Pear key) | **PASS (local testnet)** | the sender went offline after appending; the recipient fetched and opened it later through the seeder; the seeder could not open it. Needs: mailbox key distribution (e.g. a signed directory record), an operated seeder, retention policy, mobile background behaviour (**UNKNOWN**) |
| 13 | Authorized-session binding on the live connection | **PASS** | #543 + Mission 02 (`remotePublicKey` equals the key authorized by the Pubky grant chain) |
| 14 | Mobile background/battery/push behaviour | **UNKNOWN** | not testable here |
| 15 | Production relay/bootstrap operation (who runs them, SLOs, abuse) | **UNKNOWN** | design decision, see Day 0 criteria |

## What this means

* Pear is **viable for Day 0 only with** an operated blind relay (and probably an operated seeder for offline delivery) and a
  real-device test. The lab cannot say how often real users need the relay; real-network measurements are required.
* The lab itself is part of the finding: three NAT combinations failed to hole-punch and one relay failed; before treating any
  of it as a Pear defect, repeat it on real routers or with a proper NAT emulator. The relay result is useful as a mechanism check.
* Offline delivery is possible but is a SECOND system (mailbox + seeder) next to the live channel. That is the point where
  the Pubky Noise comparison could matter again; it is not decided here.

## Day 0 acceptance criteria for the transport (verifiable)

1. Two real phones (iOS and Android) on different carriers connect directly or through the relay, 20 of 20 attempts, p95 under 10 s, with the relay disabled and enabled.
2. Message sent to a recipient who was offline for 1 h is delivered within 30 s of coming online, via the mailbox/seeder, with no plaintext at the seeder.
3. An authorization revoked by the user is refused by a second integrator within the freshness bound (see `homeserver/README.md`).
4. The relay/seeder outage degrades to a visible "cannot deliver" state, never to silent loss (test: kill relay, kill seeder).
5. Battery/background: documented behaviour on both OSes for incoming messages while the app is backgrounded.

## Reproduce

```
docker build -f homeserver/Dockerfile.runner -t ppr-runner:dev .
node natlab/run.mjs build && node natlab/run.mjs matrix     # NAT matrix on isolated docker networks
node natlab/public.mjs                                       # public DHT sanity check (sends UDP to third-party bootstrap nodes)
node --test test/offline-delivery.test.mjs                   # store-and-forward on a local testnet
docker run --rm -v "$PWD/natlab/bare-check.cjs:/w/bare-check.cjs:ro" ppr-runner:dev sh -c "npm i --no-save bare-runtime@1.36.0 && node_modules/.bin/bare /w/bare-check.cjs"
```
