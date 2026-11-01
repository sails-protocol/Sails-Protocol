// Adversarial recovery probe for the bundled evidence store and the database dump (P3-R4, Front D).
// Throwaway containers and volumes only (names r4probe-*), keys generated per run and never printed, no network
// beyond 127.0.0.1, nothing of the kit or of any real stack is touched. Needs docker, the images below, and
// @aws-sdk/client-s3 (already a dependency of the server).
//
//   node scripts/self-host-recovery-probe.js [--out probe-report.json]
//
// Each case ends PASS (the safe behaviour was observed), FAIL (an unsafe behaviour was observed) or INFO (a
// behaviour worth knowing that is not pass/fail). The exit status is 1 when any case FAILs.
// It proves facts about SeaweedFS 4.48 + PostgreSQL 16 tooling as the kit uses them; it does NOT prove that
// `sails-node` calls them safely (see docs/SELF_HOST_BACKUP_AND_KEYS.md for the kit-level gaps).
const { execFileSync, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const STORE = 'chrislusf/seaweedfs:4.48'
const TOOLS = 'postgres:16-alpine' // sh + tar + dd, the same image the kit uses for its one-shot containers
const RUN = `r4probe-${crypto.randomBytes(3).toString('hex')}`
const work = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN}-`))
const report = []
const secrets = new Set()

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
const docker = (...args) => { const r = sh('docker', args); if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${scrub(r.stderr).slice(0, 300)}`); return r.stdout.trim() }
const scrub = (s) => { let t = String(s); for (const v of secrets) t = t.split(v).join('<secret>'); return t }
const hex32 = () => { const v = crypto.randomBytes(32).toString('hex'); secrets.add(v); return v }
const record = (id, status, note) => { report.push({ id, status, note }); console.log(`${status.padEnd(4)} ${id}: ${note}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const access = 'probe-access'
const secret = crypto.randomBytes(12).toString('hex'); secrets.add(secret)

function startStore(name, volume, kek) {
  docker('run', '-d', '--name', name, '-e', `AWS_ACCESS_KEY_ID=${access}`, '-e', `AWS_SECRET_ACCESS_KEY=${secret}`, '-e', `WEED_S3_SSE_KEK=${kek}`,
    '-v', `${volume}:/data`, '-p', '127.0.0.1::8333', STORE, 'server', '-dir=/data', '-s3')
  const port = docker('port', name, '8333/tcp').split(':').pop()
  return { name, volume, endpoint: `http://127.0.0.1:${port}` }
}
// A restarted container gets a NEW random host port: re-read it.
function restartStore(store) {
  docker('start', store.name)
  store.endpoint = `http://127.0.0.1:${docker('port', store.name, '8333/tcp').split(':').pop()}`
  return store
}
const clientFor = (store) => {
  const { S3Client } = require('@aws-sdk/client-s3')
  return new S3Client({ endpoint: store.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: access, secretAccessKey: secret } })
}
async function waitReady(store) {
  const { ListBucketsCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3')
  const c = clientFor(store)
  for (let i = 0; i < 40; i++) {
    try { await c.send(new ListBucketsCommand({})); break } catch { await sleep(1500) }
    if (i === 39) throw new Error(`${store.name} never answered on S3`)
  }
  try { await c.send(new HeadBucketCommand({ Bucket: 'evidence' })) } catch { await c.send(new CreateBucketCommand({ Bucket: 'evidence' })) }
  return c
}
const put = async (c, key, body) => { const { PutObjectCommand } = require('@aws-sdk/client-s3'); await c.send(new PutObjectCommand({ Bucket: 'evidence', Key: key, Body: body, ServerSideEncryption: 'AES256' })) }
const get = async (c, key) => { const { GetObjectCommand } = require('@aws-sdk/client-s3'); const r = await c.send(new GetObjectCommand({ Bucket: 'evidence', Key: key })); return Buffer.from(await r.Body.transformToByteArray()) }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
// Read with bounded retries (a store that was just started answers late); returns {bytes} or {error}.
async function tryGet(c, key) {
  let last
  for (let i = 0; i < 6; i++) { try { return { bytes: await get(c, key) } } catch (e) { last = e; await sleep(1500) } }
  return { error: scrub(last && last.name ? `${last.name}` : String(last)) }
}
const tools = (volumeMounts, script, ...args) => docker('run', '--rm', ...volumeMounts, '--entrypoint', 'sh', TOOLS, '-c', script, ...args)
const rm = (...names) => { for (const n of names) sh('docker', ['rm', '-f', n]) }
const rmVol = (...vols) => { for (const v of vols) sh('docker', ['volume', 'rm', '-f', v]) }

async function evidenceCases() {
  const kekA = hex32(), kekB = hex32()
  const payload = crypto.randomBytes(8192)
  const key = `${sha(payload)}.bin`
  const vol = `${RUN}-a`, restored = `${RUN}-restored`, wrong = `${RUN}-wrong`, trunc = `${RUN}-trunc`, tamper = `${RUN}-tamper`, rot = `${RUN}-rot`
  const names = []
  try {
    // E1 baseline + cold snapshot
    let a = startStore(`${RUN}-sa`, vol, kekA); names.push(a.name)
    let c = await waitReady(a)
    await put(c, key, payload)
    const g1 = await tryGet(c, key)
    record('E1 baseline read', g1.bytes && g1.bytes.equals(payload) ? 'PASS' : 'FAIL', g1.bytes ? 'object reads back byte-for-byte' : `cannot read: ${g1.error}`)
    docker('stop', a.name)
    tools(['-v', `${vol}:/data:ro`, '-v', `${work}:/b`], 'tar czf /b/snap.tar.gz -C /data .')
    const snap = path.join(work, 'snap.tar.gz')
    record('E2 cold snapshot taken', fs.statSync(snap).size > 0 ? 'PASS' : 'FAIL', `${fs.statSync(snap).size} bytes`)

    // E3 restore into a fresh volume with the right key
    const unpack = (volume, file) => tools(['-v', `${volume}:/data`, '-v', `${path.dirname(file)}:/b:ro`], 'tar xzf "/b/$0" -C /data', path.basename(file))
    unpack(restored, snap)
    let r = startStore(`${RUN}-sr`, restored, kekA); names.push(r.name)
    c = await waitReady(r)
    const g3 = await tryGet(c, key)
    record('E3 restore + right key', g3.bytes && g3.bytes.equals(payload) ? 'PASS' : 'FAIL', g3.bytes ? 'restored object reads back byte-for-byte' : `cannot read: ${g3.error}`)

    // E4 restore with the WRONG key: must fail closed, never return other bytes
    unpack(wrong, snap)
    let w = startStore(`${RUN}-sw`, wrong, kekB); names.push(w.name)
    c = await waitReady(w)
    const g4 = await tryGet(c, key)
    if (g4.bytes) record('E4 restore + wrong key', g4.bytes.equals(payload) ? 'FAIL' : 'FAIL', g4.bytes.equals(payload) ? 'the wrong key still returned the plaintext (SSE does not protect the data)' : 'the wrong key returned DIFFERENT bytes without an error (silent corruption)')
    else record('E4 restore + wrong key', 'PASS', `read refused (${g4.error}); no plaintext, no wrong bytes returned`)

    // E5 truncated snapshot: the archive must be rejected before anything is served from it
    const half = path.join(work, 'half.tar.gz')
    fs.writeFileSync(half, fs.readFileSync(snap).subarray(0, Math.floor(fs.statSync(snap).size / 2)))
    const t = sh('docker', ['run', '--rm', '-v', `${work}:/b:ro`, '--entrypoint', 'sh', TOOLS, '-c', 'tar tzf /b/half.tar.gz >/dev/null'])
    record('E5 truncated snapshot is detectable', t.status !== 0 ? 'PASS' : 'FAIL', t.status !== 0 ? 'tar -tzf fails on the truncated archive (a pre-restore check would catch it)' : 'tar -tzf accepted a truncated archive')
    const x = sh('docker', ['run', '--rm', '-v', `${trunc}:/data`, '-v', `${work}:/b:ro`, '--entrypoint', 'sh', TOOLS, '-c', 'tar xzf /b/half.tar.gz -C /data'])
    let tr = startStore(`${RUN}-st`, trunc, kekA); names.push(tr.name)
    c = await waitReady(tr)
    const g5 = await tryGet(c, key)
    record('E5b serving from a half-extracted archive', g5.bytes ? (g5.bytes.equals(payload) ? 'INFO' : 'FAIL') : 'PASS',
      g5.bytes ? (g5.bytes.equals(payload) ? `extraction exit ${x.status}; object survived the cut` : 'half-extracted store returned WRONG bytes') : `extraction exit ${x.status}; object not served (${g5.error}): fails closed, but the store is up and looks healthy`)

    // E6 tampered data file: is a flipped byte detected by the store, or only by comparing sha256 to the key?
    unpack(tamper, snap)
    tools(['-v', `${tamper}:/data`], 'f=$(ls -S /data/*.dat | head -n1); sz=$(wc -c < "$f"); printf "\\377\\377\\377\\377" | dd of="$f" bs=1 seek=$((sz/2)) conv=notrunc 2>/dev/null; echo "$f $sz" >/dev/null')
    let tp = startStore(`${RUN}-sp`, tamper, kekA); names.push(tp.name)
    c = await waitReady(tp)
    const g6 = await tryGet(c, key)
    if (!g6.bytes) record('E6 tampered data file', 'PASS', `store refused to serve the tampered object (${g6.error})`)
    else if (g6.bytes.equals(payload)) record('E6 tampered data file', 'INFO', 'the flipped bytes did not land inside this object (not a result); rerun with another offset')
    else record('E6 tampered data file', sha(g6.bytes) === key.split('.')[0] ? 'FAIL' : 'INFO',
      sha(g6.bytes) === key.split('.')[0] ? 'impossible' : 'the store returned ALTERED bytes without an error: only the sha256 in the object key (compared by the caller) detects it. The evidence provider must verify it on retrieve')

    // E7 controlled key rotation by copy: A -> B through S3, verify every object, only then retire A
    restartStore(a)
    c = await waitReady(a)
    let b = startStore(`${RUN}-sb`, rot, kekB); names.push(b.name)
    const cb = await waitReady(b)
    const objs = [[key, payload]]
    for (let i = 0; i < 4; i++) { const p = crypto.randomBytes(1000 + i); const k = `${sha(p)}.bin`; await put(c, k, p); objs.push([k, p]) }
    let ok = 0
    for (const [k, p] of objs) { const got = await tryGet(c, k); if (got.bytes && got.bytes.equals(p)) { await put(cb, k, got.bytes); ok++ } }
    let verified = 0
    for (const [k, p] of objs) { const got = await tryGet(cb, k); if (got.bytes && got.bytes.equals(p)) verified++ }
    record('E7 rotation by copy A->B', ok === objs.length && verified === objs.length ? 'PASS' : 'FAIL', `${ok}/${objs.length} read under the old key, ${verified}/${objs.length} verified byte-for-byte under the new key`)
    // the new store must not depend on the old key any more
    rm(a.name); rmVol(vol)
    docker('stop', b.name); restartStore(b)
    const cb2 = await waitReady(b)
    const after = await tryGet(cb2, key)
    record('E8 new store survives the loss of the old key and volume', after.bytes && after.bytes.equals(payload) ? 'PASS' : 'FAIL', after.bytes ? 'objects read with the new key alone' : `cannot read: ${after.error}`)
  } finally {
    rm(...names); rmVol(vol, restored, wrong, trunc, tamper, rot)
  }
}

async function dumpCases() {
  const pg = `${RUN}-pg`, pgv = `${RUN}-pgdata`
  const pw = crypto.randomBytes(8).toString('hex'); secrets.add(pw)
  try {
    docker('run', '-d', '--name', pg, '-e', `POSTGRES_PASSWORD=${pw}`, '-v', `${pgv}:/var/lib/postgresql/data`, TOOLS)
    for (let i = 0; i < 40; i++) { if (sh('docker', ['exec', pg, 'pg_isready', '-U', 'postgres']).status === 0) break; await sleep(1500) }
    await sleep(2000)
    const psql = (sql, db = 'postgres') => docker('exec', pg, 'psql', '-U', 'postgres', '-d', db, '-Atc', sql)
    psql('create database src'); psql('create table t(id int primary key, v text); insert into t select g, md5(g::text) from generate_series(1,20000) g', 'src')
    docker('exec', pg, 'sh', '-c', 'pg_dump -U postgres -d src -Fc > /tmp/full.dump && ls -l /tmp/full.dump >/dev/null')
    const size = Number(docker('exec', pg, 'sh', '-c', 'wc -c < /tmp/full.dump'))
    docker('exec', pg, 'sh', '-c', `head -c ${Math.floor(size * 0.6)} /tmp/full.dump > /tmp/cut.dump`)
    // D1: is a truncated dump detectable before restoring?
    const list = sh('docker', ['exec', pg, 'sh', '-c', 'pg_restore --list /tmp/cut.dump >/dev/null 2>&1'])
    record('D1 pg_restore --list on a truncated dump', list.status !== 0 ? 'PASS' : 'INFO', list.status !== 0 ? 'rejected before any restore' : 'the table of contents is intact, so --list ACCEPTS a truncated dump: it is not an integrity check; a sha256 sidecar (or a full test restore) is')
    // D2: restore of a truncated dump: how does it fail, and what is left behind?
    psql('create database dst1')
    const r1 = sh('docker', ['exec', pg, 'sh', '-c', 'pg_restore -U postgres -d dst1 --no-owner /tmp/cut.dump >/dev/null 2>&1'])
    const left1 = psql("select count(*) from information_schema.tables where table_schema='public'", 'dst1')
    const rows1 = (() => { try { return psql('select count(*) from t', 'dst1') } catch { return 'n/a' } })()
    record('D2 default restore of a truncated dump', r1.status !== 0 ? 'PASS' : 'FAIL', `pg_restore exit ${r1.status} (non-zero = it does not claim success); LEFT BEHIND: ${left1} table(s), ${rows1} row(s) in t (a partial database that a naive "restore verified" would not notice)`)
    // D3: single-transaction restore leaves nothing behind
    psql('create database dst2')
    const r2 = sh('docker', ['exec', pg, 'sh', '-c', 'pg_restore -U postgres -d dst2 --no-owner --single-transaction --exit-on-error /tmp/cut.dump >/dev/null 2>&1'])
    const left2 = psql("select count(*) from information_schema.tables where table_schema='public'", 'dst2')
    record('D3 --single-transaction restore of a truncated dump', r2.status !== 0 && left2 === '0' ? 'PASS' : 'FAIL', `exit ${r2.status}; tables left behind: ${left2} (atomic: nothing partial survives)`)
    // D4: the intact dump restores completely and verifiably
    psql('create database dst3')
    const r3 = sh('docker', ['exec', pg, 'sh', '-c', 'pg_restore -U postgres -d dst3 --no-owner --single-transaction --exit-on-error /tmp/full.dump >/dev/null 2>&1'])
    const same = psql("select md5(string_agg(id||v, ',' order by id)) from t", 'src') === psql("select md5(string_agg(id||v, ',' order by id)) from t", 'dst3')
    record('D4 intact dump restores and matches', r3.status === 0 && same ? 'PASS' : 'FAIL', `exit ${r3.status}; content digest of source and restored table ${same ? 'equal' : 'DIFFERENT'}`)
  } finally { rm(pg); rmVol(pgv) }
}

async function main() {
  const outIdx = process.argv.indexOf('--out')
  const out = outIdx >= 0 ? process.argv[outIdx + 1] : null
  let fatal = null
  try {
    for (const image of [STORE, TOOLS]) docker('image', 'inspect', image)
    await evidenceCases()
    await dumpCases()
  } catch (e) { fatal = scrub(e.message); record('PROBE', 'FAIL', `probe could not complete: ${fatal}`) }
  finally { fs.rmSync(work, { recursive: true, force: true }) }
  const failed = report.filter(r => r.status === 'FAIL').length
  console.log(`\n${report.length} cases: ${report.filter(r => r.status === 'PASS').length} PASS, ${failed} FAIL, ${report.filter(r => r.status === 'INFO').length} INFO`)
  if (out) fs.writeFileSync(out, JSON.stringify({ run: RUN, images: { STORE, TOOLS }, report }, null, 2))
  return failed ? 1 : 0
}

main().then(code => process.exit(code))
