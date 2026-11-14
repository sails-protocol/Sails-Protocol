// scripts/production-image-audit.js <npm-audit.json> <image-inventory.tsv> [exceptions.json]
//
// Vulnerability audit aligned with what the production image REALLY contains.
//
// `npm audit --omit=dev` audits the lockfile's production graph. That graph includes things the
// serving image does not ship (the Prisma CLI chain lives in the `migrate` image; the front-end
// workspaces are pruned) and PR #451's way of excluding them, `--omit=optional`, would also drop
// native components the server needs (bare-runtime-linux-x64, used by the QVAC SDK). So the audit
// keeps the full lockfile view but only FAILS on an advisory whose vulnerable range matches a
// package copy actually installed in the image (inventory from scripts/image-package-inventory.js).
//
//   high / critical, present in the image  -> FAIL, unless a formal exception covers it
//   a formal exception                     -> printed on every run; EXPIRES (reviewBy) and then FAILS
//   moderate / low, present                -> reported, does not fail
//   not in the image / version outside     -> listed as such (nothing is silently dropped)
//   unusable npm audit output (offline...) -> exit 2: an audit that did not run is not a pass

const fs = require('fs')
const semver = require('semver')

const FAIL_AT = new Set(['high', 'critical'])

function parseInventory(text) {
  const inventory = new Map()
  for (const line of text.split('\n')) {
    const [rel, name, version] = line.replace(/\r$/, '').split('\t')
    if (!rel || !name || !version) continue
    if (!inventory.has(name)) inventory.set(name, new Set())
    inventory.get(name).add(version)
  }
  return inventory
}

function evaluate({ audit, inventory, exceptions = [], today = new Date() }) {
  if (!audit || audit.error || !audit.vulnerabilities || !audit.metadata) {
    throw new Error(`npm audit output is not usable (${audit && audit.error ? JSON.stringify(audit.error).slice(0, 200) : 'no vulnerabilities/metadata'})`)
  }
  if (inventory.size === 0) throw new Error('the image inventory is empty: nothing to match the advisories against')

  const findings = []
  for (const [name, vuln] of Object.entries(audit.vulnerabilities)) {
    const installed = [...(inventory.get(name) ?? [])].sort()
    const affected = installed.filter(version => semver.satisfies(version, vuln.range ?? '*', { includePrerelease: true }))
    if (affected.length === 0) {
      findings.push({ name, severity: vuln.severity, status: installed.length ? 'outside-range' : 'not-in-image', installed })
      continue
    }
    let status = FAIL_AT.has(vuln.severity) ? 'FAIL' : 'reported'
    let exception
    if (status === 'FAIL') {
      exception = exceptions.find(e => e.package === name && affected.every(version => semver.satisfies(version, e.appliesTo ?? '*', { includePrerelease: true })))
      if (exception) status = new Date(exception.reviewBy) >= today ? 'excepted' : 'FAIL-exception-expired'
    }
    findings.push({ name, severity: vuln.severity, status, installed: affected, exception })
  }
  return { findings, failed: findings.filter(f => f.status.startsWith('FAIL')) }
}

function main(argv) {
  const [auditFile, inventoryFile, exceptionsFile] = argv
  if (!auditFile || !inventoryFile) {
    console.error('usage: node scripts/production-image-audit.js <npm-audit.json> <image-inventory.tsv> [exceptions.json]')
    return 2
  }
  let result
  try {
    const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8').replace(/^﻿/, ''))
    const inventory = parseInventory(fs.readFileSync(inventoryFile, 'utf8'))
    const exceptions = exceptionsFile ? JSON.parse(fs.readFileSync(exceptionsFile, 'utf8')) : []
    result = evaluate({ audit, inventory, exceptions })
  } catch (error) {
    console.error(`production image audit COULD NOT RUN: ${error.message}`)
    return 2
  }
  const order = { FAIL: 0, 'FAIL-exception-expired': 0, excepted: 1, reported: 2, 'outside-range': 3, 'not-in-image': 4 }
  for (const f of result.findings.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))) {
    console.log(`${f.status.padEnd(22)} ${f.severity.padEnd(9)} ${f.name.padEnd(28)} installed: ${f.installed.join(', ') || '-'}`)
    if (f.exception) console.log(`${' '.repeat(22)} exception until ${f.exception.reviewBy}: ${f.exception.reason}`)
  }
  if (result.failed.length > 0) {
    console.error(`\n${result.failed.length} advisory/ies affect packages shipped in the production image and are not covered by a valid exception`)
    return 1
  }
  console.log('\nno unexcepted high/critical advisory affects a package shipped in the production image')
  return 0
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { evaluate, parseInventory }
