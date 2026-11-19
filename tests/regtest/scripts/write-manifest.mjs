// P51: manifest of versions, pins and declared parameters for the evidence (GK P51 §4: "versões fixadas"; spec V2 §A).
// Usage: node write-manifest.mjs <evidence-dir>
// Everything here is read from the job's own environment and from files the earlier steps wrote. No secret is ever read.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const dir = process.argv[2]
if (!dir) { console.error('usage: write-manifest.mjs <evidence-dir>'); process.exit(2) }
const e = process.env
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim() } catch { return null } }
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim() : null)

const manifest = {
  purpose: 'P51 disposable regtest environment, informational. It is NOT a homologation, does NOT enable a rail, is NOT production.',
  codeUnderProof: { expectedSha: e.EXPECTED_SHA, infraTree: e.EXPECTED_INFRA_TREE },
  runner: { os: sh('. /etc/os-release && echo "$PRETTY_NAME"'), kernel: sh('uname -r'), glibc: sh('ldd --version | head -1'), image: e.ImageOS ?? null, imageVersion: e.ImageVersion ?? null },
  toolchain: { node: process.version, npm: sh('npm -v'), rust: e.RUST_TOOLCHAIN },
  bitcoinCore: {
    version: e.BITCOIN_CORE_VERSION, tarballSha256Pinned: e.BITCOIN_CORE_TARBALL_SHA256,
    guixSigs: { repo: e.GUIX_SIGS_REPO_URL, commit: e.GUIX_SIGS_COMMIT, keys: 'vendored in tests/regtest/keys/bitcoin-core-builders, each sha256 pinned' },
    builderKeySha256s: (e.BUILDER_KEY_SHA256S ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
    pinnedBuilderFingerprints: (e.BITCOIN_CORE_BUILDER_FINGERPRINTS ?? '').split(/\s+/).filter(Boolean),
    minValidSignatures: Number(e.GPG_MIN_VALID_SIGNATURES), provenance: read('provenance-bitcoin-core.txt'),
  },
  electrs: { repo: e.ELECTRS_REPO_URL, commit: e.ELECTRS_COMMIT, cargoLockSha256Pinned: e.ELECTRS_CARGO_LOCK_SHA256, provenance: read('provenance-electrs.txt') },
  services: { postgresImageDeclaredInWorkflow: true, redisImageDeclaredInWorkflow: true, note: 'image references with @sha256 digests are in the workflow services: block (the env context is not available there)' },
  declared: {
    network: 'regtest (forced; the job refuses any other chain)',
    explorer: 'loopback front proxy only (no public explorer anywhere)',
    fixedFeeSatPerVB: Number(e.FIXED_FEE_SAT_PER_VB),
    fixedFeeNote: 'A fixed, declared INPUT (policy), not chain state and NOT market data. Its economic adequacy is outside this demonstration.',
    bitcoindFallbackFee: '-fallbackfee=0.0002 (20 sat/vB): used by the test wallet ONLY to fund the test transactions; not the fee the provider uses',
    firstRun: 'validates the workflow and the infrastructure; does NOT count for P45',
    rpcCredentials: 'ephemeral, generated per run, never uploaded',
    stateStart: 'blocks generated from zero with generatetoaddress; no snapshot',
    runs: 2,
    structuralEquality: 'states, refusal codes, values in sats, number/type of outputs, number of broadcasts; txids, hashes, heights, times and addresses EXCLUDED',
  },
  scope: {
    covered: 'infrastructure, fidelity of the 7 Esplora routes against bitcoind, fixed-fee acceptance by the real node, fee-route negative case',
    scenarios: read('run1/scenarios-status.txt'),
    notCovered: 'D1-D6 (depend on #235/F3/F4); anything not listed as PASS in scenarios-status.txt',
  },
}
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('manifest.json written')
