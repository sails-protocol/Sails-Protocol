// scripts/trivy-image-gate.js
//
//   node scripts/trivy-image-gate.js --scan server=trivy-report/trivy-server.json \
//        --scan migrate=trivy-report/trivy-migrate.json [--out trivy-report] [--mode observe|enforce] \
//        [--config security/trivy-gate.json] [--exceptions security/trivy-exceptions.json] \
//        [--scanner security/trivy-scanner.json] [--version-file trivy-report/trivy-version-server.txt ...]
//
// The vulnerability gate for the shipped images. Input: Trivy JSON reports (OS packages AND the Node
// packages found anywhere in the image, e.g. the npm bundled with the base image, which `npm audit` cannot
// see). Output: a Markdown report, a machine-readable summary and an explicit verdict.
//
//   mode "observe" : prints and records exactly what WOULD fail, exits 0.
//   mode "enforce" : any CRITICAL/HIGH finding without a valid exception exits 1.
//   exit 2         : the gate's own configuration is broken (malformed/expired-shaped exceptions file), or, in
//                    enforce mode, a scan could not be read. In observe mode an unreadable scan is reported
//                    as "GATE DID NOT RUN" and exits 0, so a scanner outage never reddens unrelated work.
//
// Exceptions (security/trivy-exceptions.json) are never implicit. Each one names the CVE/GHSA, the package,
// the image ("server" | "migrate", no wildcard), a justification (>= 20 chars), an owner and an expiry date;
// it stops applying the day after it expires, and unused ones are listed so they get removed.

const fs = require('fs')
const path = require('path')

const IMAGES = new Set(['server', 'migrate'])
const ID_RE = /^(CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1 }

function isRealDate(text) {
  if (!DATE_RE.test(text)) return false
  const d = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text
}

/** Validates the exceptions document. Pure. Returns { exceptions, errors }. */
function validateExceptions(doc) {
  const errors = []
  if (!doc || doc.schema !== 1 || !Array.isArray(doc.exceptions)) {
    return { exceptions: [], errors: ['exceptions file must be {"schema": 1, "exceptions": [...]}'] }
  }
  const exceptions = []
  doc.exceptions.forEach((e, i) => {
    const where = `exceptions[${i}]`
    const problems = []
    if (!e || typeof e !== 'object') { errors.push(`${where}: not an object`); return }
    if (typeof e.cve !== 'string' || !ID_RE.test(e.cve)) problems.push('cve must be a CVE-YYYY-N or GHSA-xxxx-xxxx-xxxx id')
    if (typeof e.package !== 'string' || e.package.trim() === '') problems.push('package is required')
    if (!IMAGES.has(e.image)) problems.push('image must be exactly "server" or "migrate" (no wildcard)')
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) problems.push('reason (justification) must be at least 20 characters')
    if (typeof e.owner !== 'string' || e.owner.trim() === '') problems.push('owner is required')
    if (typeof e.expires !== 'string' || !isRealDate(e.expires)) problems.push('expires must be a real YYYY-MM-DD date')
    if (e.version !== undefined && typeof e.version !== 'string') problems.push('version, when present, must be a string')
    if (problems.length > 0) errors.push(`${where}: ${problems.join('; ')}`)
    else exceptions.push(e)
  })
  return { exceptions, errors }
}

/** Flattens one Trivy JSON report into findings of the gated severities. Pure. Throws on an unusable report. */
function flatten(report, image, severities) {
  if (!report || typeof report !== 'object' || (report.SchemaVersion === undefined && report.ArtifactName === undefined)) {
    throw new Error('not a Trivy JSON report')
  }
  const gated = new Set(severities)
  const findings = []
  for (const result of report.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      if (!gated.has(v.Severity)) continue
      findings.push({
        image,
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        version: v.InstalledVersion,
        fixed: v.FixedVersion ?? '',
        severity: v.Severity,
        status: v.Status ?? '',
        klass: result.Class ?? '',
        path: v.PkgPath ?? '',
        title: (v.Title ?? '').slice(0, 120),
      })
    }
  }
  return findings
}

/** Pure. `today` is a YYYY-MM-DD string; an exception applies through its expiry date inclusive. */
function evaluate({ findingsByImage, exceptionsDoc, today }) {
  const { exceptions, errors } = validateExceptions(exceptionsDoc)
  const used = new Set()
  const blocking = []
  const excepted = []
  const expiredMatches = []
  for (const findings of Object.values(findingsByImage)) {
    for (const f of findings) {
      const matches = exceptions.filter(e =>
        e.cve.toLowerCase() === String(f.id).toLowerCase() && e.package === f.pkg && e.image === f.image && (e.version === undefined || e.version === f.version),
      )
      const valid = matches.find(e => e.expires >= today)
      if (valid) {
        used.add(valid)
        excepted.push({ ...f, exception: valid })
        continue
      }
      if (matches.length > 0) expiredMatches.push({ ...f, exception: matches[0] })
      blocking.push(f)
    }
  }
  const order = f => (SEVERITY_ORDER[f.severity] ?? 9) * 1e6
  blocking.sort((a, b) => order(a) - order(b) || a.image.localeCompare(b.image) || a.pkg.localeCompare(b.pkg) || String(a.id).localeCompare(String(b.id)))
  return { blocking, excepted, expiredMatches, unused: exceptions.filter(e => !used.has(e)), configErrors: errors }
}

function countsTable(findingsByImage) {
  const lines = ['| image | OS packages CRITICAL | OS packages HIGH | Node/other packages CRITICAL | Node/other packages HIGH |', '|---|---:|---:|---:|---:|']
  for (const [image, findings] of Object.entries(findingsByImage)) {
    const n = (os, sev) => findings.filter(f => (f.klass === 'os-pkgs') === os && f.severity === sev).length
    lines.push(`| ${image} | ${n(true, 'CRITICAL')} | ${n(true, 'HIGH')} | ${n(false, 'CRITICAL')} | ${n(false, 'HIGH')} |`)
  }
  return lines.join('\n')
}

function groupedRows(list, max = 250) {
  const groups = new Map()
  for (const f of list) {
    const key = `${f.image}|${f.klass}|${f.pkg}|${f.version}|${f.severity}`
    if (!groups.has(key)) groups.set(key, { ...f, ids: [] })
    groups.get(key).ids.push(f.id)
  }
  const rows = [...groups.values()].map(g =>
    `| ${g.image} | ${g.klass === 'os-pkgs' ? 'OS' : 'Node/other'} | \`${g.pkg}@${g.version}\` | ${g.severity} | ${g.ids.slice(0, 4).join(', ')}${g.ids.length > 4 ? ` (+${g.ids.length - 4})` : ''} | ${g.fixed || 'no fix yet'}${g.status ? ` (${g.status})` : ''} | ${g.path ? `\`${g.path}\`` : ''} |`,
  )
  const shown = rows.slice(0, max)
  if (rows.length > max) shown.push(`| … | | ${rows.length - max} more packages not shown (see the JSON summary) | | | | |`)
  return ['| image | layer | package | severity | ids | fixed in | path |', '|---|---|---|---|---|---|---|', ...shown].join('\n')
}

function render({ mode, scanner, versionTexts, unreadable, findingsByImage, result, today }) {
  const out = []
  const wouldFail = result.blocking.length > 0 || unreadable.length > 0
  out.push('# Image vulnerability gate (Trivy)', '')
  const verdict =
    result.configErrors.length > 0 ? 'GATE CONFIGURATION ERROR'
    : mode === 'enforce' ? (wouldFail ? 'FAIL' : 'PASS')
    : wouldFail ? 'OBSERVE MODE — THIS WOULD FAIL' : 'OBSERVE MODE — this would pass'
  out.push(`**Verdict: ${verdict}**  ·  mode: \`${mode}\`  ·  date: ${today}`, '')
  out.push(`Scanner: \`${scanner.image}@${scanner.digest}\` (Trivy ${scanner.version}), gated severities: CRITICAL, HIGH.`, '')
  for (const [label, text] of Object.entries(versionTexts)) out.push(`<details><summary>trivy version / vulnerability DB (${label})</summary>`, '', '```', text.trim(), '```', '</details>', '')
  if (unreadable.length > 0) out.push('## GATE DID NOT RUN for: ' + unreadable.map(u => `${u.image} (${u.reason})`).join('; '), '')
  if (result.configErrors.length > 0) out.push('## Configuration errors', ...result.configErrors.map(e => `- ${e}`), '')
  out.push('## Findings by image', '', countsTable(findingsByImage), '')
  out.push(`## Blocking findings (${result.blocking.length}) — CRITICAL/HIGH without a valid exception`, '', result.blocking.length ? groupedRows(result.blocking) : '_none_', '')
  out.push(`## Excepted findings (${result.excepted.length})`, '')
  if (result.excepted.length) {
    out.push('| image | package | id | owner | expires | justification |', '|---|---|---|---|---|---|')
    for (const f of result.excepted) out.push(`| ${f.image} | \`${f.pkg}@${f.version}\` | ${f.id} | ${f.exception.owner} | ${f.exception.expires} | ${f.exception.reason} |`)
  } else out.push('_none: no exception is registered_')
  out.push('')
  if (result.expiredMatches.length) out.push('## EXPIRED exceptions that matched a finding (the finding blocks)', ...result.expiredMatches.map(f => `- ${f.id} ${f.pkg}@${f.version} (${f.image}) — exception of ${f.exception.owner} expired ${f.exception.expires}`), '')
  if (result.unused.length) out.push('## Unused exceptions (remove them)', ...result.unused.map(e => `- ${e.cve} ${e.package} (${e.image}), expires ${e.expires}`), '')
  return out.join('\n')
}

function parseArgs(argv) {
  const args = { scans: [], versionFiles: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scan') args.scans.push(argv[++i])
    else if (a === '--version-file') args.versionFiles.push(argv[++i])
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i]
    else throw new Error(`unexpected argument ${a}`)
  }
  return args
}

function main(argv, env = process.env, now = new Date()) {
  const args = parseArgs(argv)
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  const config = read(args.config ?? 'security/trivy-gate.json')
  const scanner = read(args.scanner ?? 'security/trivy-scanner.json')
  const exceptionsDoc = read(args.exceptions ?? 'security/trivy-exceptions.json')
  const mode = args.mode ?? config.mode
  if (mode !== 'observe' && mode !== 'enforce') throw new Error(`mode must be observe or enforce, got ${mode}`)
  const today = now.toISOString().slice(0, 10)
  const severities = config.severities ?? ['CRITICAL', 'HIGH']

  const findingsByImage = {}
  const unreadable = []
  for (const spec of args.scans) {
    const [image, file] = spec.split('=')
    if (!IMAGES.has(image)) throw new Error(`--scan label must be server or migrate, got ${image}`)
    try {
      findingsByImage[image] = flatten(read(file), image, severities)
    } catch (error) {
      unreadable.push({ image, reason: String(error.message).slice(0, 120) })
      findingsByImage[image] = []
    }
  }
  const versionTexts = {}
  for (const file of args.versionFiles) { try { versionTexts[path.basename(file)] = fs.readFileSync(file, 'utf8') } catch { /* optional */ } }

  const result = evaluate({ findingsByImage, exceptionsDoc, today })
  const report = render({ mode, scanner, versionTexts, unreadable, findingsByImage, result, today })
  const summary = {
    mode, date: today, scanner: `${scanner.image}@${scanner.digest}`, scannerVersion: scanner.version,
    gateDidNotRun: unreadable, configErrors: result.configErrors,
    wouldFail: result.blocking.length > 0 || unreadable.length > 0 || result.configErrors.length > 0,
    counts: Object.fromEntries(Object.entries(findingsByImage).map(([i, f]) => [i, { total: f.length, os: f.filter(x => x.klass === 'os-pkgs').length, node: f.filter(x => x.klass !== 'os-pkgs').length }])),
    blocking: result.blocking, excepted: result.excepted.map(f => ({ ...f, exception: f.exception })), expiredMatches: result.expiredMatches.map(f => ({ id: f.id, pkg: f.pkg, image: f.image })),
    unusedExceptions: result.unused,
  }
  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true })
    fs.writeFileSync(path.join(args.out, 'trivy-gate-report.md'), report)
    fs.writeFileSync(path.join(args.out, 'trivy-gate-summary.json'), JSON.stringify(summary, null, 2))
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report + '\n')

  const headline = report.split('\n').find(l => l.startsWith('**Verdict'))
  console.log(headline.replace(/\*\*/g, ''))
  console.log(`blocking: ${result.blocking.length}  excepted: ${result.excepted.length}  unreadable scans: ${unreadable.length}`)
  for (const [image, f] of Object.entries(findingsByImage)) console.log(`  ${image}: ${f.length} CRITICAL/HIGH findings (${f.filter(x => x.klass === 'os-pkgs').length} OS, ${f.filter(x => x.klass !== 'os-pkgs').length} Node/other)`)
  if (result.configErrors.length > 0) { for (const e of result.configErrors) console.error(`CONFIG ERROR: ${e}`); return 2 }
  if (unreadable.length > 0) {
    console.error(`GATE DID NOT RUN for: ${unreadable.map(u => `${u.image} (${u.reason})`).join('; ')}`)
    return mode === 'enforce' ? 2 : 0
  }
  if (result.blocking.length > 0) {
    console.error(mode === 'enforce' ? `${result.blocking.length} blocking finding(s): see the report` : `OBSERVE MODE: ${result.blocking.length} finding(s) WOULD fail the gate in enforce mode`)
    return mode === 'enforce' ? 1 : 0
  }
  return 0
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))) } catch (error) { console.error(`trivy image gate COULD NOT RUN: ${error.message}`); process.exit(2) }
}
module.exports = { validateExceptions, flatten, evaluate, main }
