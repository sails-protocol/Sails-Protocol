// scripts/runtime-image-checks.js
//
// Runs INSIDE the production image (stage `runtime`), fed on stdin by
// scripts/docker-runtime-test.sh:  docker run --rm -i --entrypoint node IMAGE - < this-file
// Exit 0 only when every check passes; every failure is listed, none is
// swallowed. Checks what the image must satisfy before it ever serves a
// request:
//   1. the Node version is the one the Dockerfile pins (EXPECTED_NODE);
//   2. the process is not root;
//   3. NODE_ENV defaults to production;
//   4. every package the compiled server `require()`s resolves from where
//      the file lives — this is the class of bug that kept the image from
//      booting ("Cannot find module '@sails/core'": a workspace package linked
//      in node_modules whose target the runtime stage never copied);
//   5. the native / generated modules actually LOAD, not merely resolve.
// It does not need a database, Redis or any configuration.

const fs = require('fs')
const path = require('path')
const { builtinModules, createRequire } = require('module')

const failures = []
const pass = (name, detail) => console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
const fail = (name, detail) => {
  failures.push(name)
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1–3: runtime facts
const expected = process.env.EXPECTED_NODE
if (!expected) fail('EXPECTED_NODE provided', 'the harness must say which Node the Dockerfile pins')
else if (process.version === `v${expected}`) pass('node version', process.version)
else fail('node version', `expected v${expected}, got ${process.version}`)

const uid = process.getuid()
const user = require('os').userInfo().username
if (uid !== 0) pass('runs as a non-root user', `${user} uid=${uid}`)
else fail('runs as a non-root user', 'uid 0')

if (process.env.NODE_ENV === 'production') pass('NODE_ENV defaults to production')
else fail('NODE_ENV defaults to production', `got ${JSON.stringify(process.env.NODE_ENV)}`)

// 4: every bare specifier in the compiled server resolves from its own file
const root = '/app'
const distDir = path.join(root, 'dist')
const builtins = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)])
const requireRe = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g
const files = []
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) files.push(full)
  }
}
if (!fs.existsSync(distDir)) {
  fail('compiled server present', `${distDir} missing`)
} else {
  walk(distDir)
  const unresolved = new Map() // specifier -> first file that needs it
  const specifiers = new Set()
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(requireRe)) {
      const spec = match[2]
      if (spec.startsWith('.') || spec.startsWith('/') || builtins.has(spec)) continue
      specifiers.add(spec)
      const from = createRequire(file)
      try {
        from.resolve(spec)
      } catch (error) {
        if (!unresolved.has(spec)) unresolved.set(spec, `${path.relative(root, file)}: ${String(error.message).split('\n')[0]}`)
      }
    }
  }
  if (files.length === 0) fail('compiled server present', 'no .js files under dist')
  else if (unresolved.size === 0) pass('every package required by dist/ resolves', `${specifiers.size} specifiers, ${files.length} files`)
  else for (const [spec, where] of unresolved) fail(`resolve ${spec}`, where)
}

// 5: modules that must load (native addons, generated client, workspace packages)
const rootRequire = createRequire(path.join(root, 'package.json'))
for (const name of ['@sails/core', '@prisma/client', 'sodium-native', 'tiny-secp256k1']) {
  try {
    rootRequire(name)
    pass(`load ${name}`)
  } catch (error) {
    fail(`load ${name}`, String(error.message).split('\n')[0])
  }
}
try {
  const { PrismaClient } = rootRequire('@prisma/client')
  if (typeof PrismaClient === 'function') pass('generated Prisma client exports PrismaClient')
  else fail('generated Prisma client exports PrismaClient', typeof PrismaClient)
} catch (error) {
  fail('generated Prisma client exports PrismaClient', String(error.message).split('\n')[0])
}

// 6: the installed production tree is consistent with its manifests: starting from the root
// package, every non-optional dependency of every reachable package must resolve (Node's own
// node_modules lookup) to a copy whose version satisfies the declared range. This is what
// `npm ls --omit=dev --all` reported (missing / invalid), without needing npm in the image:
// the final stages ship without npm and corepack. Copies nothing reaches ("extraneous") are
// not visited, exactly as `npm ls` treated them. Optional dependencies may be absent (native
// builds for other platforms); peer dependencies are not checked.
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const lookup = (fromDir, name) => {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    if (path.dirname(dir) === dir) return null
  }
}
let semver = null
try { semver = rootRequire('semver') } catch { /* reported below */ }
if (!semver) {
  fail('dependency tree', 'semver is not resolvable from /app, so declared ranges cannot be verified')
} else {
  const problems = []
  const seen = new Set()
  const visit = (dir, manifest, chain) => {
    if (seen.has(dir)) return
    seen.add(dir)
    for (const [name, range] of Object.entries(manifest.dependencies || {})) {
      const found = lookup(dir, name)
      if (!found) { problems.push(`missing: ${name}@${range}, required by ${chain}`); continue }
      const child = readJson(path.join(found, 'package.json'))
      // npm: / file: / git specs and workspace links carry no semver range to compare
      if (semver.validRange(range) && !semver.satisfies(child.version, range, { includePrerelease: true })) {
        problems.push(`invalid: ${name}@${child.version} does not satisfy ${range}, required by ${chain}`)
      }
      visit(found, child, `${name}@${child.version}`)
    }
    for (const name of Object.keys(manifest.optionalDependencies || {})) {
      const found = lookup(dir, name)
      if (found) visit(found, readJson(path.join(found, 'package.json')), `${name} (optional)`)
    }
  }
  try {
    visit(root, readJson(path.join(root, 'package.json')), 'the root package')
    if (problems.length === 0) pass('production dependency tree has no missing/invalid packages', `${seen.size} packages reachable from the root`)
    else for (const p of problems) fail('dependency tree', p.slice(0, 200))
  } catch (error) {
    fail('dependency tree', `could not walk the tree: ${String(error.message).split('\n')[0]}`)
  }
}

// 6b: the Node base image's package managers are gone from the final image (see the Dockerfile).
for (const tool of ['npm', 'npx', 'corepack']) {
  const present = ['/usr/local/bin', '/usr/bin', '/bin'].some(dir => fs.existsSync(path.join(dir, tool)))
  if (!present) pass(`${tool} is not in the image`)
  else fail(`${tool} is not in the image`, 'still present')
}
if (!fs.existsSync('/usr/local/lib/node_modules/npm') && !fs.existsSync('/usr/local/lib/node_modules/corepack')) pass('npm and corepack module trees are not in the image')
else fail('npm and corepack module trees are not in the image', '/usr/local/lib/node_modules still has them')

// 7: packages of the other workspaces (front-end / examples) must not ride along into the
// server image: the `pruned` stage installs only the server's closure. (react and
// typescript are NOT sentinels: other packages in that closure may legitimately need them.)
const leaked = ['next', 'tailwindcss', 'lucide-react'].filter(name => fs.existsSync(path.join(root, 'node_modules', name)))
if (leaked.length === 0) pass('no other-workspace packages in node_modules')
else fail('other-workspace packages in node_modules', leaked.join(', '))

// ... and neither may the root's devDependencies (test runners, load-test and local test
// infrastructure): a prune that skips the root package ships them to production.
const devOnly = ['artillery', 'jest', 'ts-jest', 'embedded-postgres', 'redis-memory-server', 'pino-pretty'].filter(name => fs.existsSync(path.join(root, 'node_modules', name)))
if (devOnly.length === 0) pass('no devDependencies in node_modules')
else fail('devDependencies in node_modules', devOnly.join(', '))

// 8: the Prisma CLI chain is NOT in the serving image (it lives in the `migrate` image), while
// the Prisma runtime pieces and the optional native runtime QVAC needs ARE.
const cliChain = ['prisma', '@prisma/config', '@prisma/engines', '@prisma/studio-core', 'mysql2', 'deepmerge-ts', 'c12', 'effect'].filter(name => fs.existsSync(path.join(root, 'node_modules', name)))
if (cliChain.length === 0) pass('Prisma CLI chain absent from the serving image')
else fail('Prisma CLI chain in the serving image', cliChain.join(', '))
// `npm prune --omit=optional` would also drop bare-runtime-linux-x64: the QVAC SDK spawns its worker with it.
// The platform package is named after the architecture the image runs on (linux-x64 or linux-arm64): npm installs only the matching one.
const BARE_PLATFORM_PKG = `bare-runtime-linux-${process.arch}`
for (const name of ['@prisma/client', '@prisma/adapter-pg', 'pg', 'bare-runtime', BARE_PLATFORM_PKG]) {
  try {
    rootRequire.resolve(name)
    pass(`present: ${name}`)
  } catch {
    fail(`present: ${name}`, 'not resolvable from /app')
  }
}

// 9: the QVAC worker's executable can actually START. npm leaves bare-runtime-linux-x64/bin/bare at mode 644 and the package's
// wrapper repairs it with a chmod at the first spawn: that write fails on a read-only root filesystem (EROFS). The Debian
// production image still has this defect (reported, not failed: it works on a writable rootfs). The distroless candidate sets
// the mode at build time and is checked with REQUIRE_BARE_EXECUTABLE=1, where a binary that cannot start FAILS the image.
{
  const bare = path.join(root, 'node_modules', BARE_PLATFORM_PKG, 'bin', 'bare')
  const required = process.env.REQUIRE_BARE_EXECUTABLE === '1'
  try {
    const run = require('child_process').spawnSync(bare, ['--version'], { encoding: 'utf8', timeout: 15000 })
    if (!run.error && run.status === 0) pass('the Bare runtime starts', `${(run.stdout || '').trim().slice(0, 40)}`)
    else if (required) fail('the Bare runtime starts', run.error ? run.error.code || run.error.message : `exit ${run.status} ${(run.stderr || '').slice(0, 80)}`)
    else console.log(`NOTE  the Bare runtime does not start as shipped (${run.error ? run.error.code : `exit ${run.status}`}): mode ${(fs.statSync(bare).mode & 0o777).toString(8)}; the package repairs it at first spawn on a writable rootfs only. Set REQUIRE_BARE_EXECUTABLE=1 to make this a failure.`)
  } catch (error) {
    if (required) fail('the Bare runtime starts', String(error.message).split('\n')[0])
    else console.log(`NOTE  the Bare runtime check could not run: ${String(error.message).split('\n')[0]}`)
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} runtime image check(s) FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nall runtime image checks passed')
