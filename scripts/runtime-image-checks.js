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

if (failures.length > 0) {
  console.log(`\n${failures.length} runtime image check(s) FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nall runtime image checks passed')
