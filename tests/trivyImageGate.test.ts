// The Trivy image gate (scripts/trivy-image-gate.js): CRITICAL/HIGH without a valid, unexpired, exactly-scoped
// exception fails in enforce mode and is reported as "would fail" in observe mode; a broken exceptions file or an
// unreadable scan never turns into a silent pass.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateExceptions, flatten, evaluate, main } = require('../scripts/trivy-image-gate.js')

type Vuln = { VulnerabilityID: string; PkgName: string; InstalledVersion: string; Severity: string; FixedVersion?: string; Status?: string }
const report = (os: Vuln[] = [], node: Vuln[] = []) => ({
  SchemaVersion: 2,
  ArtifactName: 'img',
  Results: [
    { Class: 'os-pkgs', Target: 'debian', Vulnerabilities: os },
    { Class: 'lang-pkgs', Target: 'Node.js', Vulnerabilities: node.map(v => ({ ...v, PkgPath: `usr/local/lib/node_modules/npm/node_modules/${v.PkgName}/package.json` })) },
  ],
})
const zlib: Vuln = { VulnerabilityID: 'CVE-2023-45853', PkgName: 'zlib1g', InstalledVersion: '1:1.2.13', Severity: 'CRITICAL', Status: 'will_not_fix' }
const undiciHigh: Vuln = { VulnerabilityID: 'CVE-2026-19534', PkgName: 'undici', InstalledVersion: '6.28.0', Severity: 'HIGH', FixedVersion: '6.28.1' }
const medium: Vuln = { VulnerabilityID: 'CVE-2026-00001', PkgName: 'tar', InstalledVersion: '1.0', Severity: 'MEDIUM' }
const exception = (over: Record<string, unknown> = {}) => ({
  cve: 'CVE-2023-45853', package: 'zlib1g', image: 'server', reason: 'Debian marks it will_not_fix; minizip is not used by zlib1g consumers here', owner: 'cto', expires: '2026-12-31', ...over,
})
const doc = (...exceptions: unknown[]) => ({ schema: 1, exceptions })
const findings = (image: string, ...vulns: Vuln[]) => flatten(report(vulns.filter(v => v === zlib), vulns.filter(v => v !== zlib)), image, ['CRITICAL', 'HIGH'])

describe('trivy image gate', () => {
  describe('flatten', () => {
    it('keeps only the gated severities and tells OS packages from Node packages', () => {
      const f = flatten(report([zlib], [undiciHigh, medium]), 'server', ['CRITICAL', 'HIGH'])
      expect(f.map((x: { pkg: string }) => x.pkg).sort()).toEqual(['undici', 'zlib1g'])
      expect(f.find((x: { pkg: string }) => x.pkg === 'zlib1g').klass).toBe('os-pkgs')
      expect(f.find((x: { pkg: string }) => x.pkg === 'undici').path).toContain('node_modules/npm')
    })
    it('rejects something that is not a Trivy report', () => {
      expect(() => flatten({ hello: 'world' }, 'server', ['HIGH'])).toThrow(/not a Trivy/)
      expect(() => flatten(null, 'server', ['HIGH'])).toThrow(/not a Trivy/)
    })
  })

  describe('exceptions', () => {
    const today = '2026-10-24'
    it('without any exception every CRITICAL/HIGH blocks', () => {
      const r = evaluate({ findingsByImage: { server: findings('server', zlib, undiciHigh) }, exceptionsDoc: doc(), today })
      expect(r.blocking).toHaveLength(2)
      expect(r.excepted).toHaveLength(0)
    })
    it('a valid exception excuses exactly its CVE + package + image', () => {
      const r = evaluate({ findingsByImage: { server: findings('server', zlib, undiciHigh), migrate: findings('migrate', zlib) }, exceptionsDoc: doc(exception()), today })
      expect(r.excepted.map((f: { pkg: string; image: string }) => `${f.image}:${f.pkg}`)).toEqual(['server:zlib1g'])
      expect(r.blocking.map((f: { pkg: string; image: string }) => `${f.image}:${f.pkg}`).sort()).toEqual(['migrate:zlib1g', 'server:undici'])
    })
    it('a version-scoped exception does not excuse another installed version', () => {
      const r = evaluate({ findingsByImage: { server: findings('server', zlib) }, exceptionsDoc: doc(exception({ version: '9.9.9' })), today })
      expect(r.blocking).toHaveLength(1)
    })
    it('an expired exception does not apply, the finding blocks, and the match is reported', () => {
      const r = evaluate({ findingsByImage: { server: findings('server', zlib) }, exceptionsDoc: doc(exception({ expires: '2026-10-23' })), today })
      expect(r.blocking).toHaveLength(1)
      expect(r.expiredMatches).toHaveLength(1)
    })
    it('applies through its expiry day, inclusive', () => {
      const r = evaluate({ findingsByImage: { server: findings('server', zlib) }, exceptionsDoc: doc(exception({ expires: '2026-10-24' })), today })
      expect(r.blocking).toHaveLength(0)
    })
    it('lists unused exceptions so they get removed', () => {
      const r = evaluate({ findingsByImage: { server: findings('server', undiciHigh) }, exceptionsDoc: doc(exception()), today })
      expect(r.unused).toHaveLength(1)
    })
    it('rejects malformed exceptions instead of ignoring them', () => {
      const bad = [
        exception({ image: '*' }), exception({ image: 'both' }), exception({ reason: 'too short' }), exception({ owner: '' }),
        exception({ expires: '2026-13-45' }), exception({ expires: 'next year' }), exception({ cve: 'not-an-id' }), exception({ package: '' }),
      ]
      const { exceptions, errors } = validateExceptions(doc(...bad))
      expect(exceptions).toHaveLength(0)
      expect(errors).toHaveLength(bad.length)
      expect(validateExceptions({ nope: true }).errors[0]).toMatch(/schema/)
    })
    it('accepts a GHSA id and a well-formed entry', () => {
      expect(validateExceptions(doc(exception({ cve: 'GHSA-mrhx-c7xc-m3w5' }))).errors).toEqual([])
    })
  })

  describe('main (exit codes)', () => {
    let dir: string
    const write = (name: string, body: unknown) => { const p = join(dir, name); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); return p }
    const base = () => {
      write('gate-observe.json', { mode: 'observe', severities: ['CRITICAL', 'HIGH'] })
      write('gate-enforce.json', { mode: 'enforce', severities: ['CRITICAL', 'HIGH'] })
      write('scanner.json', { image: 'aquasec/trivy', version: '0.76.1', digest: 'sha256:abc' })
      write('no-exceptions.json', doc())
    }
    const run = (extra: string[], config = 'gate-observe.json', exceptions = 'no-exceptions.json') =>
      main(['--config', join(dir, config), '--scanner', join(dir, 'scanner.json'), '--exceptions', join(dir, exceptions), '--out', join(dir, 'out'), ...extra], {}, new Date('2026-10-24T12:00:00Z'))
    let log: jest.SpyInstance, err: jest.SpyInstance
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trivy-gate-')); base(); log = jest.spyOn(console, 'log').mockImplementation(() => undefined); err = jest.spyOn(console, 'error').mockImplementation(() => undefined) })
    afterEach(() => { log.mockRestore(); err.mockRestore(); rmSync(dir, { recursive: true, force: true }) })

    it('observe mode: findings exit 0 but the report says it WOULD FAIL', () => {
      const code = run(['--scan', `server=${write('s.json', report([zlib]))}`])
      expect(code).toBe(0)
      expect(readFileSync(join(dir, 'out', 'trivy-gate-report.md'), 'utf8')).toMatch(/OBSERVE MODE — THIS WOULD FAIL/)
      expect(JSON.parse(readFileSync(join(dir, 'out', 'trivy-gate-summary.json'), 'utf8')).wouldFail).toBe(true)
    })
    it('enforce mode: findings exit 1; a clean scan exits 0', () => {
      expect(run(['--scan', `server=${write('s.json', report([zlib]))}`], 'gate-enforce.json')).toBe(1)
      expect(run(['--scan', `server=${write('clean.json', report())}`], 'gate-enforce.json')).toBe(0)
    })
    it('enforce mode with a valid exception passes and names the exception in the report', () => {
      write('with.json', doc(exception()))
      expect(run(['--scan', `server=${write('s.json', report([zlib]))}`], 'gate-enforce.json', 'with.json')).toBe(0)
      expect(readFileSync(join(dir, 'out', 'trivy-gate-report.md'), 'utf8')).toMatch(/CVE-2023-45853[^\n]*cto/)
    })
    it('an unreadable scan: observe says GATE DID NOT RUN (exit 0), enforce fails (exit 2)', () => {
      const broken = write('broken.json', 'not json at all')
      expect(run(['--scan', `server=${broken}`])).toBe(0)
      expect(existsSync(join(dir, 'out', 'trivy-gate-report.md')) && readFileSync(join(dir, 'out', 'trivy-gate-report.md'), 'utf8')).toMatch(/GATE DID NOT RUN/)
      expect(run(['--scan', `server=${broken}`], 'gate-enforce.json')).toBe(2)
    })
    it('a broken exceptions file fails in BOTH modes (exit 2)', () => {
      write('bad.json', doc(exception({ image: '*' })))
      const scan = ['--scan', `server=${write('s.json', report())}`]
      expect(run(scan, 'gate-observe.json', 'bad.json')).toBe(2)
      expect(run(scan, 'gate-enforce.json', 'bad.json')).toBe(2)
    })
  })

  it('the committed configuration is valid and registers NO exception for the current findings', () => {
    const exceptions = JSON.parse(readFileSync(join(__dirname, '..', 'security', 'trivy-exceptions.json'), 'utf8'))
    expect(validateExceptions(exceptions).errors).toEqual([])
    expect(exceptions.exceptions).toEqual([])
    const scanner = JSON.parse(readFileSync(join(__dirname, '..', 'security', 'trivy-scanner.json'), 'utf8'))
    expect(scanner.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const gate = JSON.parse(readFileSync(join(__dirname, '..', 'security', 'trivy-gate.json'), 'utf8'))
    expect(['observe', 'enforce']).toContain(gate.mode)
  })
})
