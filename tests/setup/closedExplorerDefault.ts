// Jest setupFiles (CTO 429 experiment): without an explicit MULTISIG_EXPLORER_API_URL, tests would otherwise reach the
// public explorer (config default https://mempool.space/testnet/api) and wait on its timeouts. A loopback port nothing
// listens on refuses at once, so an unmocked explorer read fails fast and visibly instead. Explicit values (tests,
// workflows, harnesses) are never overridden. Same address reconcilerProcessHarness.CLOSED_EXPLORER_URL already uses.
export const CLOSED_EXPLORER_DEFAULT = 'http://127.0.0.1:1'

if (process.env.MULTISIG_EXPLORER_API_URL === undefined) process.env.MULTISIG_EXPLORER_API_URL = CLOSED_EXPLORER_DEFAULT
