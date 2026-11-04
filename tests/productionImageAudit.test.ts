// The image-aligned vulnerability audit (scripts/production-image-audit.js): it must fail on what is
// really shipped, ignore what is not, honour a formal exception only while it is valid, and never
// treat an audit that did not run as a pass.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { evaluate, parseInventory } = require('../scripts/production-image-audit.js')

const audit = (vulnerabilities: Record<string, { severity: string; range: string }>) => ({ metadata: { vulnerabilities: {} }, vulnerabilities })
const inventory = (...rows: string[]) => parseInventory(rows.map(r => `node_modules/${r.split('@')[0]}\t${r.split('@')[0]}\t${r.split('@')[1]}`).join('\n'))
const statusOf = (result: { findings: { name: string; status: string }[] }, name: string) => result.findings.find(f => f.name === name)?.status

describe('production image audit', () => {
  const today = new Date('2026-10-23')

  it('fails on a high advisory that matches a package copy shipped in the image', () => {
    const r = evaluate({ audit: audit({ fastify: { severity: 'high', range: '<=5.12.4' } }), inventory: inventory('fastify@5.12.1'), today })
    expect(statusOf(r, 'fastify')).toBe('FAIL')
    expect(r.failed).toHaveLength(1)
  })

  it('does not fail on advisories for packages that are not in the image (Prisma CLI chain, front-end workspaces)', () => {
    const r = evaluate({ audit: audit({ prisma: { severity: 'high', range: '<=7.10.0' }, next: { severity: 'critical', range: '16.0.0 - 16.4.0' } }), inventory: inventory('fastify@5.12.5'), today })
    expect(statusOf(r, 'prisma')).toBe('not-in-image')
    expect(statusOf(r, 'next')).toBe('not-in-image')
    expect(r.failed).toHaveLength(0)
  })

  it('does not fail when the shipped version is outside the vulnerable range', () => {
    const r = evaluate({ audit: audit({ fastify: { severity: 'high', range: '<=5.12.4' } }), inventory: inventory('fastify@5.12.5'), today })
    expect(statusOf(r, 'fastify')).toBe('outside-range')
    expect(r.failed).toHaveLength(0)
  })

  it('reports moderate advisories without failing', () => {
    const r = evaluate({ audit: audit({ pkg: { severity: 'moderate', range: '<2.0.0' } }), inventory: inventory('pkg@1.0.0'), today })
    expect(statusOf(r, 'pkg')).toBe('reported')
    expect(r.failed).toHaveLength(0)
  })

  it('honours a formal exception only while it has not expired, and only for the versions it names', () => {
    const exceptions = [{ package: 'fastify', appliesTo: '<=5.12.4', reviewBy: '2026-11-15', reason: 'tracked' }]
    const a = audit({ fastify: { severity: 'high', range: '<=5.12.4' } })
    expect(statusOf(evaluate({ audit: a, inventory: inventory('fastify@5.12.1'), exceptions, today }), 'fastify')).toBe('excepted')
    expect(statusOf(evaluate({ audit: a, inventory: inventory('fastify@5.12.1'), exceptions, today: new Date('2026-11-16') }), 'fastify')).toBe('FAIL-exception-expired')
    // a different vulnerable version than the one the exception was written for is not excused
    const other = audit({ fastify: { severity: 'high', range: '<=6.0.0' } })
    expect(statusOf(evaluate({ audit: other, inventory: inventory('fastify@5.12.1', 'fastify@6.0.0'), exceptions, today }), 'fastify')).toBe('FAIL')
  })

  it('treats an audit that did not run, or an empty inventory, as an error and not as a pass', () => {
    expect(() => evaluate({ audit: { error: { code: 'ENOTFOUND' } }, inventory: inventory('a@1.0.0'), today })).toThrow(/not usable/)
    expect(() => evaluate({ audit: undefined, inventory: inventory('a@1.0.0'), today })).toThrow(/not usable/)
    expect(() => evaluate({ audit: audit({}), inventory: parseInventory(''), today })).toThrow(/inventory is empty/)
  })
})
