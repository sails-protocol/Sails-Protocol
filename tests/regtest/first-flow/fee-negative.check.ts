// P51: NEGATIVE case for the fee route (GK P51 §(a).3). The real MultisigProvider must REFUSE to guess a fee when the
// explorer's /v1/fees/recommended answers 500 or {} ("refusing to guess"), and the proxy must show ZERO forwarded POST /tx.
// A positive control checks the same real method against the normal proxy (the FIXED, declared rate).
//
// Scope, stated plainly: this exercises the provider's own fee-fetch method (the "refusing to guess" branches). The
// end-to-end "no broadcast when the fee is unavailable" for a full settlement belongs to the D8-D10 scenario drivers.
//
// Run from the code tree (the infra is overlaid on it): npx ts-node --transpile-only tests/regtest/first-flow/fee-negative.check.ts
// Env: PROXY_URL (normal), PROXY_FAULT500_URL, PROXY_EMPTY_URL, the three *_LOG files, FIXED_FEE_SAT_PER_VB, OUT_DIR,
//      MULTISIG_NETWORK=regtest (the harness sets it; config reads it at import).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function need(k: string): string {
  const v = process.env[k]
  if (!v) { console.error(`missing env ${k}`); process.exit(2) }
  return v
}
const countForwardedPosts = (file: string): number =>
  existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'post-tx' && e.forwarded === true).length
    : 0

async function main(): Promise<void> {
  const OUT_DIR = need('OUT_DIR')
  const FIXED = Number(need('FIXED_FEE_SAT_PER_VB'))
  mkdirSync(OUT_DIR, { recursive: true })
  if (process.env.MULTISIG_NETWORK !== 'regtest') { console.error('REFUSING: MULTISIG_NETWORK must be regtest'); process.exit(2) }

  // Imported AFTER the env is in place: config reads process.env at import time.
  const { config } = await import('../../../src/config')
  const { MultisigProvider } = await import('../../../src/modules/open-settlement/multisig.provider')
  const { EscrowError } = await import('../../../src/common/errors')
  const provider = new MultisigProvider() as unknown as { fetchFeeRateSatsPerVByte(): Promise<number> }
  const point = (url: string): void => { (config.multisig as { explorerApiUrl: string }).explorerApiUrl = url }

  const results: Array<{ name: string; pass: boolean; detail: unknown }> = []
  const record = (name: string, pass: boolean, detail: unknown): void => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`) }

  // positive control
  point(need('PROXY_URL'))
  try {
    const rate = await provider.fetchFeeRateSatsPerVByte()
    record('control: the normal proxy yields the FIXED declared rate', rate === FIXED, { rate, expected: FIXED })
  } catch (err) { record('control: the normal proxy yields the FIXED declared rate', false, String(err)) }

  for (const [label, urlEnv, logEnv, expect] of [
    ['proxy answers 500', 'PROXY_FAULT500_URL', 'PROXY_FAULT500_LOG', /fee-estimate endpoint returned 500/],
    ['proxy answers {}', 'PROXY_EMPTY_URL', 'PROXY_EMPTY_LOG', /no usable rate/],
  ] as const) {
    point(need(urlEnv))
    let refused = false
    let isEscrowError = false
    let message = ''
    try {
      await provider.fetchFeeRateSatsPerVByte()
    } catch (err) {
      refused = true
      isEscrowError = err instanceof EscrowError
      message = err instanceof Error ? err.message : String(err)
    }
    const posts = countForwardedPosts(need(logEnv))
    record(`negative: ${label} => the provider REFUSES (EscrowError) and 0 POST /tx reached the node`,
      refused && isEscrowError && expect.test(message) && posts === 0,
      { refused, isEscrowError, matchesExpectedMessage: expect.test(message), forwardedPosts: posts })
  }

  const pass = results.every((r) => r.pass)
  writeFileSync(join(OUT_DIR, 'fee-negative.json'), JSON.stringify({
    pass, results,
    note: 'The fixed fee does NOT reflect the market. Economic adequacy of the fee is outside this demonstration.',
  }, null, 2))
  // STRUCTURE only (compared across the two runs): outcomes, not messages with txids.
  writeFileSync(join(OUT_DIR, 'structure-fee-negative.json'), JSON.stringify({
    allChecksPass: pass,
    checks: results.map((r) => ({ name: r.name, pass: r.pass })),
    refusalCodes: { fault500: 'EscrowError', empty: 'EscrowError' },
    forwardedPostTxOnFault: 0,
  }, null, 2))
  console.log(pass ? 'FEE-NEGATIVE: ALL PASS' : 'FEE-NEGATIVE: FAILED')
  process.exit(pass ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
