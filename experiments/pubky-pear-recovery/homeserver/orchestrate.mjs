// Disposable Pubky testnet (DHT + pkarr relay + http relay + REAL homeserver, built from the
// signed upstream tag) on an --internal docker network, plus a Node runner that shares the
// testnet's network namespace so `localhost` reaches it. No egress, no published ports.
//
//   node homeserver/orchestrate.mjs up | run <test files...> | pause | unpause | logs | down
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

const NET = 'ppr-net'
const PG = 'ppr-pg'
const TESTNET = 'ppr-testnet'
const STATE = 'ppr-state'
const PG_IMAGE = process.env.PPR_PG_IMAGE ?? 'postgres:18'
const TESTNET_IMAGE = process.env.PPR_TESTNET_IMAGE ?? 'ppr-pubky-testnet:v0.16.2'
const RUNNER_IMAGE = process.env.PPR_RUNNER_IMAGE ?? 'ppr-runner:dev'
const PG_PASSWORD = 'ppr-throwaway-password' // disposable container, never published

const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const tryDocker = (args) => { try { return docker(args) } catch { return null } }

function down () {
  for (const c of [TESTNET, PG]) tryDocker(['rm', '-f', c])
  tryDocker(['network', 'rm', NET])
  tryDocker(['volume', 'rm', '-f', STATE])
}

function up () {
  down()
  docker(['network', 'create', '--internal', NET])
  docker(['volume', 'create', STATE])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`, PG_IMAGE])
  for (let i = 0; i < 60; i++) {
    if (tryDocker(['exec', PG, 'pg_isready', '-U', 'postgres']) !== null) break
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)'])
  }
  docker(['run', '-d', '--name', TESTNET, '--network', NET,
    '-e', `TEST_PUBKY_CONNECTION_STRING=postgres://postgres:${PG_PASSWORD}@${PG}:5432/postgres`,
    '--entrypoint', 'homeserver', TESTNET_IMAGE])
  for (let i = 0; i < 60; i++) {
    const r = spawnSync('docker', ['run', '--rm', '--network', `container:${TESTNET}`, RUNNER_IMAGE, 'node', '-e',
      "fetch('http://localhost:15411/').then(()=>process.exit(0),()=>process.exit(1))"])
    // The homeserver is only resolvable once its PKARR packet is published (a few seconds after the relay answers).
    if (r.status === 0 && (tryDocker(['logs', '--tail', '400', TESTNET]) ?? '').includes('Testnet running')) { console.log('testnet ready'); return }
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)'])
  }
  console.error(tryDocker(['logs', '--tail', '40', TESTNET]))
  throw new Error('testnet did not become ready')
}

function run (files) {
  const r = spawnSync('docker', ['run', '--rm', '--network', `container:${TESTNET}`, '-v', `${STATE}:/state`,
    '-v', `${process.env.PPR_HS_DIR ?? path.resolve(import.meta.dirname, '..', 'homeserver')}:/w/homeserver:ro`,
    '-v', `${path.resolve(import.meta.dirname, '..', 'src')}:/w/src:ro`, '-e', 'PUBKY_TESTNET_HOST=localhost',
    RUNNER_IMAGE, 'node', '--test', '--test-timeout=180000', ...files], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

// Whole experiment, in order, from a clean state. Each suite is its own container (a "new device").
function all () {
  const T = 'homeserver/test'
  const suites = [
    ['01', [`${T}/01-identity-recovery.test.mjs`]],
    ['02', [`${T}/02-grants-external-signer.test.mjs`]],
    ['03', [`${T}/03-pear-directory-revocation.test.mjs`]],
    ['04a', [`${T}/04a-outage-prepare.test.mjs`]],
    ['pause'],
    ['04b', [`${T}/04b-outage-frozen.test.mjs`]],
    ['unpause'],
    ['04c', [`${T}/04c-outage-recovered.test.mjs`]]
  ]
  let failed = 0
  for (const [name, files] of suites) {
    if (name === 'pause' || name === 'unpause') { docker([name, TESTNET]); console.log(`== ${name}`); continue }
    console.log(`== suite ${name}`)
    const r = spawnSync(process.execPath, [path.resolve(import.meta.filename), 'run', ...files], { stdio: 'inherit' })
    if (r.status !== 0) failed++
  }
  process.exit(failed ? 1 : 0)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'all') all()
else if (cmd === 'up') up()
else if (cmd === 'run') run(rest)
else if (cmd === 'pause') console.log(docker(['pause', TESTNET]))
else if (cmd === 'unpause') console.log(docker(['unpause', TESTNET]))
else if (cmd === 'logs') console.log(docker(['logs', '--tail', rest[0] ?? '200', TESTNET]))
else if (cmd === 'down') down()
else { console.error('usage: up | run <files> | pause | unpause | logs [n] | down'); process.exit(2) }
