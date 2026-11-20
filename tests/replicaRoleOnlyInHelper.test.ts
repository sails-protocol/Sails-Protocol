/**
 * F4 / Despacho 031 (D), GK condition: the replica role (the switch that turns triggers AND foreign keys off) must not spread. Static guard
 * over src/**, scripts/** and tests/**: the only file that may introduce it is tests/integration/helpers/legacyEscrowSeed.ts. The five files
 * below already used it BEFORE the F4 work (their own DB-invariant proofs, and the runtime-privilege boot check that reads the setting); they are
 * listed by name, so a NEW user anywhere else fails this test and an old one cannot be added silently.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = join(__dirname, '..')
const NEEDLE = 'session_' + 'replication_role' // not spelled in one piece, so this file is not a user either
const HELPER = 'tests/integration/helpers/legacyEscrowSeed.ts'
const PRE_EXISTING = [
  'src/common/database/runtime-privileges.ts',
  'tests/integration/dbNativeInvariants.test.ts',
  'tests/integration/disputeEvidenceCas.test.ts',
  'tests/integration/feeCollectionRecognitionIntegration.test.ts',
  'tests/integration/runtimePrivileges.test.ts',
]
const EXT = /\.(ts|tsx|js|mjs|cjs|sql|sh)$/

export function findReplicaUsers(files: Record<string, string>): string[] {
  return Object.entries(files).filter(([p, s]) => p !== HELPER && s.toLowerCase().includes(NEEDLE)).map(([p]) => p).sort()
}

function collect(dir: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (EXT.test(name)) out[relative(ROOT, full).split(sep).join('/')] = readFileSync(full, 'utf8')
  }
}

describe('the replica role has ONE new user: the legacy-seed helper', () => {
  const real = () => { const f: Record<string, string> = {}; for (const d of ['src', 'scripts', 'tests']) collect(join(ROOT, d), f); return f }

  it('real tree: apart from the helper, only the named pre-existing files use it', () => {
    const files = real()
    expect(Object.keys(files).length).toBeGreaterThan(200)
    expect(findReplicaUsers(files)).toEqual([...PRE_EXISTING].sort())
  })

  it('the helper itself does use it (the guard is not vacuous) and is under tests/ only (never src/ or scripts/)', () => {
    const files = real()
    expect(files[HELPER]).toBeDefined()
    expect(files[HELPER]).toContain('GUC')
    expect(Object.keys(files).filter((p) => (p.startsWith('src/') || p.startsWith('scripts/')) && p.includes('legacyEscrowSeed'))).toEqual([])
    expect(Object.entries(files).filter(([p, s]) => !p.startsWith('tests/') && /legacyEscrowSeed/.test(s)).map(([p]) => p)).toEqual([]) // nothing outside tests imports it
  })

  it.each([
    ['a new test uses it directly', 'tests/integration/newSuite.test.ts', `await db.query("SET ${NEEDLE} = 'replica'")`],
    ['upper case', 'tests/integration/newSuite.test.ts', `SET ${NEEDLE.toUpperCase()} = replica`],
    ['a runtime source file', 'src/modules/open-settlement/x.ts', `const q = "SET ${NEEDLE}"`],
    ['an operator script', 'scripts/seed.sql', `SET ${NEEDLE} = replica;`],
  ])('MUTANT: %s is reported', (_n, path, code) => {
    expect(findReplicaUsers({ [path]: code, [HELPER]: `GUC ${NEEDLE}` })).toEqual([path])
  })
})
