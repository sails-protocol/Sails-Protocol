// tests/economicChokePointCompleteness.test.ts
//
// F4 / invariant 3b, STATIC layer of the completeness guard (P54b §3.1 + GK 4.1). No database. It fails when an economic
// choke-point (escrow creation, deposit-address derivation/persistence, funding) is CALLED from a place nobody reviewed, and when a
// reviewed call disappears (so the allow-list cannot age silently). The structural layer (triggers) is S1 of the F4 plan: a text
// scan cannot see an alias, raw SQL built from parts, or another process.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { CHOKE_RULES, scanChokePoints, stripComments, enclosingFunction } from './helpers/economicChokeScan'

const ROOT = join(__dirname, '..')
const SCOPE = ['src', 'scripts']
const EXT = /\.(ts|tsx|js|mjs|cjs|sql|sh)$/

function collect(dir: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) collect(full, out)
    else if (EXT.test(name)) out[relative(ROOT, full).split(sep).join('/')] = readFileSync(full, 'utf8')
  }
}

function realTree(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const d of SCOPE) collect(join(ROOT, d), files)
  return files
}

const SERVICE = 'src/modules/open-settlement/escrow.service.ts'
const REPO = 'src/modules/open-settlement/escrow-repository.ts'
const ROUTES = 'src/modules/open-settlement/settlement.routes.ts'
const ORCH = 'src/modules/open-settlement/settlement-orchestrator.ts'

describe('economic choke-points: the static completeness guard', () => {
  it('the real src/** + scripts/** tree has no call outside the reviewed list, and no reviewed call has disappeared', () => {
    const files = realTree()
    expect(Object.keys(files).length).toBeGreaterThan(100)
    const { violations, stale } = scanChokePoints(files)
    expect(violations).toEqual([])
    expect(stale).toEqual([])
  })

  it('every rule of the guard matched at least one real call (the scanner is not vacuous)', () => {
    const { matches } = scanChokePoints(realTree())
    const seen = new Set(matches.map((m) => m.rule))
    for (const rule of CHOKE_RULES.filter((r) => r.allowed.length > 0)) expect(seen.has(rule.id)).toBe(true)
  })

  it('the scope includes scripts/** (an operator script is a consumer too)', () => {
    expect(Object.keys(realTree()).some((f) => f.startsWith('scripts/'))).toBe(true)
  })
})

describe('economic choke-points: the guard itself is mutation-tested (synthetic trees)', () => {
  /** A minimal, compliant tree: every reviewed call exactly where it is allowed. */
  function compliant(): Record<string, string> {
    return {
      [REPO]: 'export class R {\n  async create(d) {\n    return prisma.escrow.create({ data: d })\n  }\n  async updateMultisigAddr(id, a) {\n    return prisma.escrow.update({ where: { id }, data: { multisigAddr: a } })\n  }\n  async updateLockResult(id, data: { multisigAddr: string; lockedAt: Date }) {\n    return prisma.escrow.update({ where: { id }, data })\n  }\n}\n',
      [SERVICE]: 'export class S {\n  async createEscrow(i) {\n    await lockPairForEffect(tx, i)\n    return this.repo.create(i)\n  }\n  async submitParticipantKey(id) {\n    const x = await provider.getDepositAddress(id)\n    return this.repo.updateMultisigAddr(id, x)\n  }\n  async lockFunds(id) {\n    const r = await provider.lockFunds(id)\n    return this.repo.updateLockResult(id, { multisigAddr: r.address, lockedAt: new Date() })\n  }\n}\n',
      [ROUTES]: "export async function settlementRoutes(app) {\n  app.post('/x', async () => { await escrowService.createEscrow(b) })\n  app.post('/y', async () => { await escrowService.lockFunds(i) })\n}\n",
      [ORCH]: 'export async function executeSettlement(i) {\n  await escrowService.createEscrow(i)\n  await escrowService.lockFunds(i)\n}\n',
    }
  }

  it('the compliant synthetic tree passes (baseline for the mutants below)', () => {
    const r = scanChokePoints(compliant())
    expect(r.violations).toEqual([])
    expect(r.stale).toEqual([])
  })

  const mutate = (path: string, code: string): Record<string, string> => ({ ...compliant(), [path]: code })

  it.each([
    ['escrow.create in an unrelated file', 'src/other/a.ts', 'export function f() {\n  return prisma.escrow.create({ data: {} })\n}\n'],
    ['escrow.createMany', 'src/other/a.ts', 'export function f() {\n  return tx.escrow.createMany({ data: [] })\n}\n'],
    ['escrow.upsert', 'src/other/a.ts', 'export function f() {\n  return tx.escrow.upsert({ where: {}, create: {}, update: {} })\n}\n'],
    ['raw INSERT INTO "escrows"', 'src/other/a.ts', 'export function f() {\n  return prisma.$executeRaw`INSERT INTO "escrows" (id) VALUES (1)`\n}\n'],
    ['raw INSERT INTO escrows inside scripts/**', 'scripts/seed.sql', 'INSERT INTO escrows (id) VALUES (1);\n'],
    ['escrow.update with multisigAddr, anywhere else', 'src/other/a.ts', 'export function f() {\n  return tx.escrow.update({ where: { id }, data: { multisigAddr: x } })\n}\n'],
    ['escrow.update where multisigAddr travels in a data VARIABLE (the updateLockResult shape), in another file', 'src/other/a.ts', 'export async function writeIt(id, data: { multisigAddr: string }) {\n  return prisma.escrow.update({ where: { id }, data })\n}\n'],
    ['updateLockResult called from another place', 'src/other/a.ts', 'export function f() {\n  return repo.updateLockResult(i, d)\n}\n'],
    ['escrow.updateMany with multisigAddr','src/other/a.ts', 'export function f() {\n  return tx.escrow.updateMany({ where: {}, data: { multisigAddr: x } })\n}\n'],
    ['raw UPDATE "escrows" ... multisigAddr', 'src/other/a.ts', 'export function f() {\n  return prisma.$executeRaw`UPDATE "escrows" SET "multisigAddr" = ${x} WHERE id = ${i}`\n}\n'],
    ['getDepositAddress in another file', 'src/other/a.ts', 'export function f() {\n  return provider.getDepositAddress(t)\n}\n'],
    ['updateMultisigAddr in another file', 'src/other/a.ts', 'export function f() {\n  return repo.updateMultisigAddr(i, a)\n}\n'],
    ['provider.lockFunds in another file', 'scripts/rescue.ts', 'export function f() {\n  return multisigProvider.lockFunds(e)\n}\n'],
    ['escrowService.createEscrow in a new consumer', 'src/other/a.ts', 'export async function f() {\n  await escrowService.createEscrow(i)\n}\n'],
    ['escrowService.lockFunds in a new consumer', 'src/other/a.ts', 'export async function f() {\n  await escrowService.lockFunds(i)\n}\n'],
    ['lockPairForEffect from the reconciler (it holds the escrow lock: would invert the lock order)', 'src/modules/open-settlement/escrow-settlement-reconciliation.service.ts', 'export async function f() {\n  await lockPairForEffect(tx, ref)\n}\n'],
    ['lockPairForEffect from another function of escrow.service.ts', SERVICE, 'export class S {\n  async lockFundsX(i) {\n    await lockPairForEffect(tx, i)\n  }\n}\n'],
    ['escrowRepository.create anywhere', 'src/other/a.ts', 'export async function f() {\n  await escrowRepository.create(i)\n}\n'],
  ])('MUTANT: %s is reported as a violation', (_name, path, code) => {
    const r = scanChokePoints(mutate(path, code))
    expect(r.violations.length).toBeGreaterThan(0)
  })

  it('MUTANT: the reviewed call moves to another function of the same file (getDepositAddress outside submitParticipantKey)', () => {
    const tree = compliant()
    tree[SERVICE] = tree[SERVICE].replace('async submitParticipantKey(id) {\n    const x = await provider.getDepositAddress(id)', 'async somethingElse(id) {\n    const x = await provider.getDepositAddress(id)')
    expect(scanChokePoints(tree).violations.map((v) => v.rule)).toContain('DEPOSIT_ADDRESS_DERIVATION')
  })

  it.each([
    ['getDepositAddress', SERVICE, /await provider\.getDepositAddress\(id\)/, 'DEPOSIT_ADDRESS_DERIVATION'],
    ['updateMultisigAddr', SERVICE, /return this\.repo\.updateMultisigAddr\(id, x\)/, 'DEPOSIT_ADDRESS_PERSIST'],
    ['provider.lockFunds', SERVICE, /const r = await provider\.lockFunds\(id\)/, 'LOCK_FUNDS_CALL'],
    ['updateLockResult (the second multisigAddr writer, in the repository)', REPO, /return prisma\.escrow\.update\(\{ where: \{ id \}, data \}\)/, 'MULTISIG_ADDR_UPDATE_MODEL'],
    ['updateLockResult call in lockFunds', SERVICE, /return this\.repo\.updateLockResult\(id, \{ multisigAddr: r\.address, lockedAt: new Date\(\) \}\)/, 'DEPOSIT_ADDRESS_PERSIST_AT_LOCK'],
    ['lockPairForEffect in createEscrow', SERVICE, /await lockPairForEffect\(tx, i\)\n    /, 'LOCK_PAIR_FOR_EFFECT_CALL'],
    ['createEscrow (orchestrator)', ORCH, /await escrowService\.createEscrow\(i\)/, 'CREATE_ESCROW_CALL'],
  ])('MUTANT: the reviewed %s call disappears -> the allow-list entry is reported stale', (_name, path, call, rule) => {
    const tree = compliant()
    tree[path] = tree[path].replace(call, 'void 0')
    expect(scanChokePoints(tree).stale.map((s) => s.rule)).toContain(rule)
  })

  it('MUTANT: the guard is not fooled by the words in a comment, nor does it flag a definition', () => {
    const tree = mutate('src/other/a.ts', '// prisma.escrow.create( and provider.getDepositAddress( are only words here\n/* tx.escrow.update({ data: { multisigAddr } }) */\nexport function updateMultisigAddr() {}\n')
    expect(scanChokePoints(tree).violations).toEqual([])
  })

  it('the helpers behave: comments are stripped, the enclosing function is found', () => {
    expect(stripComments('a // x.escrow.create(\nb')).not.toMatch(/escrow\.create/)
    expect(enclosingFunction('class A {\n  async foo(a: number) {\n    return bar\n  }\n}\n', 40)).toBe('foo')
  })
})
