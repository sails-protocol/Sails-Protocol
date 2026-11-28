// Jest setupFiles (jest.config.js): no test reaches a public Bitcoin explorer by default. MULTISIG_EXPLORER_API_URL otherwise
// defaults to https://mempool.space/testnet/api (src/config/index.ts, 8 s timeout). A closed local port refuses the connection at
// once. Only applied when the variable is not already set: a test that needs an explorer injects its own mock or URL.
if (process.env.MULTISIG_EXPLORER_API_URL === undefined) {
  process.env.MULTISIG_EXPLORER_API_URL = 'http://127.0.0.1:1'
}
