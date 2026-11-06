// P4 Gate 3 independent review kit. See README.md. Node >= 18, docker, a checkout of the reference SHA with deps installed.
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = process.env.P4_REVIEW_PORT || '55447'
const NAME = 'p4review-pg'
const PW = 'review'
const OUT = path.join(__dirname, process.env.P4_OUT || 'out')
const TMPL = process.env.P4_TEMPLATE || 'tmpl_review'
const url = (db) => `postgresql://postgres:${PW}@127.0.0.1:${PORT}/${db}`
const argv = process.argv.slice(2)
const cmd = argv[0]
const repoIdx = argv.indexOf('--repo')
const REPO = repoIdx >= 0 ? path.resolve(argv[repoIdx + 1]) : null
const only = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1].split(',') : null })()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function docker(...args) { const r = spawnSync('docker', args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
function needRepo() {
  if (!REPO || !fs.existsSync(path.join(REPO, 'node_modules', 'jest'))) throw new Error('--repo <checkout with npm ci> is required')
  return REPO
}
function suites() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const lane = pkg.scripts['test:integration:postgres'].split(/\s+/).filter(t => t.startsWith('tests/'))
  // Environment-bound suites the 6.4 run also excluded: the two operator CLIs assert the CI database name, and the production
  // readiness suite's own guard rejects a database named like the suite.
  const bound = ['draftEconomicPolicyOperatorCli', 'economicPolicyOperatorCli', 'postgresProductionReadiness']
  const kept = lane.filter(f => !bound.some(b => f.includes(b)))
  const unitLanePg = ['aud1xBearerCapability', 'aud1xR2DispatchAuthority', 'disputedOutcomeBinding']
    .map(n => { const hits = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === `${n}.test.ts`) hits.push(path.relative(REPO, p).replace(/\\/g, '/')) } })(path.join(REPO, 'tests')); return hits[0] })
  if (unitLanePg.some(x => !x)) throw new Error('could not locate the three unit-lane PostgreSQL suites')
  const all = [...new Set([...kept, ...unitLanePg])]
  return only ? all.filter(f => only.some(o => f.includes(o))) : all
}
const env = (db) => ({ ...process.env, DATABASE_URL: url(db), SAILS_INTEGRATION_TEST_DB_CONFIRMED: 'yes-i-am-sure', TRUSTED_ARBITRATORS: 'k6-test-arbiter', NODE_OPTIONS: `--max-old-space-size=${process.env.P4_NODE_HEAP || 4096}` })
const jest = (args, db, logFile) => {
  const r = spawnSync('node', ['node_modules/jest/bin/jest.js', '--runInBand', '--no-coverage', ...args], { cwd: REPO, env: env(db), encoding: 'utf8', maxBuffer: 1 << 28 })
  fs.writeFileSync(logFile, (r.stdout || '') + (r.stderr || ''))
  return r.status
}
const { Client } = (() => { try { return require(path.join(REPO || '.', 'node_modules', 'pg')) } catch { return {} } })()
async function sql(db, text) { const c = new Client({ connectionString: url(db) }); await c.connect(); try { return (await c.query(text)).rows } finally { await c.end() } }

const Q_CANDIDATES = `SELECT count(*)::int AS n FROM economic_disposition_authorizations a JOIN escrows e ON e.id = a."escrowId"
  WHERE a."supersededAt" IS NULL AND a."unsignedTxid" IS NOT NULL AND e.type = 'MULTISIG' AND e.status = 'DISPUTED' AND e."txReleaseId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p.id = a."pendingOperationId")
    AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p2 WHERE p2."escrowId" = e.id)`
const Q_NONB64 = `SELECT count(*)::int AS total,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM escrow_participant_keys k WHERE k."escrowId" = p."escrowId" AND k.role = 'arbiter'))::int AS on_arbiter_escrow
  FROM escrow_transaction_signatures s JOIN escrow_pending_transactions p ON p.id = s."pendingTxId"
  WHERE s."signedPsbtBase64" !~ '^[A-Za-z0-9+/]*={0,2}$'`

async function setup() {
  needRepo()
  const running = spawnSync('docker', ['ps', '-q', '--filter', `name=^${NAME}$`], { encoding: 'utf8' }).stdout.trim()
  if (!running || !process.env.P4_KEEP_SERVER) {
    try { docker('rm', '-f', NAME) } catch {}
    docker('run', '-d', '--name', NAME, '-e', `POSTGRES_PASSWORD=${PW}`, '-p', `127.0.0.1:${PORT}:5432`, 'postgres:16-alpine', '-c', 'max_connections=300', '-c', 'fsync=off')
    for (let i = 0; i < 40; i++) { if (spawnSync('docker', ['exec', NAME, 'pg_isready', '-U', 'postgres']).status === 0) break; await new Promise(r => setTimeout(r, 1500)) }
    await new Promise(r => setTimeout(r, 2000))
  }
  await sql('postgres', `CREATE DATABASE ${TMPL}`)
  const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: REPO, env: env(TMPL), encoding: 'utf8', shell: true })
  if (r.status !== 0) throw new Error('migrate deploy failed: ' + (r.stdout + r.stderr).slice(-600))
  log('template ready:', (r.stdout.match(/(\d+) migrations? found/) || [])[0] || 'migrated', '| head', execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
}

async function census() {
  needRepo(); fs.mkdirSync(OUT, { recursive: true })
  const list = suites(); const rows = []
  for (const [i, file] of list.entries()) {
    const db = `review_c${i}`
    await sql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await sql('postgres', `CREATE DATABASE ${db} TEMPLATE ${TMPL}`)
    const status = jest([file], db, path.join(OUT, `census-${i}-${path.basename(file)}.log`))
    // P4_SKIP_CENSUS=1: pass/fail only (a tree before the #525 migration has no supersededAt column for the first query)
    const skip = process.env.P4_SKIP_CENSUS === '1'
    const cand = skip ? -1 : (await sql(db, Q_CANDIDATES))[0].n
    const nb = skip ? { total: -1, on_arbiter_escrow: -1 } : (await sql(db, Q_NONB64))[0]
    rows.push({ suite: file, jestExit: status, candidatesLeft: cand, nonBase64Total: nb.total, nonBase64OnArbiterEscrow: nb.on_arbiter_escrow })
    log(String(i + 1).padStart(2) + '/' + list.length, status === 0 ? 'PASS' : 'FAIL', 'cand=' + cand, 'nonb64=' + nb.total + '/' + nb.on_arbiter_escrow, file)
    await sql('postgres', `DROP DATABASE ${db} WITH (FORCE)`)
  }
  const sum = { head: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), suites: rows.length, databasesInspected: rows.length,
    suitesFailing: rows.filter(r => r.jestExit !== 0).length, withCandidatesLeft: rows.filter(r => r.candidatesLeft > 0).map(r => r.suite),
    withNonBase64OnArbiterEscrow: rows.filter(r => r.nonBase64OnArbiterEscrow > 0).map(r => r.suite) }
  fs.writeFileSync(path.join(OUT, 'census.json'), JSON.stringify({ summary: sum, rows }, null, 2))
  log('census summary', JSON.stringify(sum))
}

async function order(direction) {
  needRepo(); fs.mkdirSync(OUT, { recursive: true })
  let list = suites(); if (direction === 'reversed') list = [...list].reverse()
  const orderFile = path.join(OUT, `${direction}-order.json`)
  fs.writeFileSync(orderFile, JSON.stringify(list.map(f => path.join(REPO, f))))
  const seq = path.join(OUT, `${direction}-sequencer.js`)
  fs.writeFileSync(seq, `const Seq = require(${JSON.stringify(path.join(REPO, 'node_modules', '@jest', 'test-sequencer'))}).default
const order = require(${JSON.stringify(orderFile)})
module.exports = class extends Seq { sort(tests) { const rank = new Map(order.map((p, i) => [p, i])); return [...tests].sort((a, b) => (rank.get(a.path) ?? 1e9) - (rank.get(b.path) ?? 1e9)) } }
`)
  const db = `review_${direction}`
  await sql('postgres', `CREATE DATABASE ${db} TEMPLATE ${TMPL}`)
  // ONE shared database, suites in the stated order, in consecutive jest processes of CHUNK suites each: a single process over
  // all of them runs out of heap (4 GB: reproduced, 32 min in). The database state that carries cross-suite contamination is
  // the same; only the process boundary differs from CI's single process. Stated in the report.
  const CHUNK = Number(process.env.P4_CHUNK || 8)
  const agg = { suites: 0, suitesPassed: 0, tests: 0, testsPassed: 0, testsFailed: 0, testsSkipped: 0 }
  const failedSuites = []; let status = 0
  log(direction, 'run:', list.length, 'suites in ONE database, chunks of', CHUNK, '| first:', list[0], '| last:', list[list.length - 1])
  for (let c = 0; c * CHUNK < list.length; c++) {
    const part = list.slice(c * CHUNK, (c + 1) * CHUNK)
    const json = path.join(OUT, `${direction}.jest.${c}.json`)
    const st = jest([`--testSequencer=${seq}`, '--json', `--outputFile=${json}`, ...part], db, path.join(OUT, `${direction}.${c}.log`))
    if (!fs.existsSync(json)) { status = st || 1; failedSuites.push({ suite: `chunk ${c}: ${part.join(',')}`, failed: [], message: 'jest produced no result (crash/OOM)' }); log(direction, 'chunk', c, 'NO RESULT'); continue }
    const j = JSON.parse(fs.readFileSync(json, 'utf8'))
    agg.suites += j.numTotalTestSuites; agg.suitesPassed += j.numPassedTestSuites; agg.tests += j.numTotalTests; agg.testsPassed += j.numPassedTests; agg.testsFailed += j.numFailedTests; agg.testsSkipped += j.numPendingTests
    for (const t of j.testResults.filter(t => t.status !== 'passed')) failedSuites.push({ suite: path.relative(REPO, t.name).replace(/\\/g, '/'), failed: t.assertionResults.filter(a => a.status === 'failed').map(a => a.fullName), message: (t.message || '').slice(0, 400) })
    if (st !== 0) status = st
    log(direction, 'chunk', c, st === 0 ? 'PASS' : 'FAIL', `${j.numPassedTestSuites}/${j.numTotalTestSuites} suites`, `${j.numPassedTests}/${j.numTotalTests} tests`)
  }
  const sum = { head: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), direction, chunk: CHUNK, jestExit: status, ...agg, failedSuites }
  fs.writeFileSync(path.join(OUT, `${direction}.json`), JSON.stringify(sum, null, 2))
  log(direction, 'summary', JSON.stringify({ ...sum, failedSuites: failedSuites.map(f => f.suite) }))
}

async function teardown() { try { docker('rm', '-f', NAME); log('removed', NAME) } catch (e) { log(String(e.message)) } }

;({ setup, census, reversed: () => order('reversed'), forward: () => order('forward'), teardown }[cmd] || (async () => { console.error('usage: run.js setup|census|reversed|forward|teardown --repo <dir> [--only a,b]'); process.exit(2) }))()
  .catch(e => { console.error(e.message); process.exit(1) })
