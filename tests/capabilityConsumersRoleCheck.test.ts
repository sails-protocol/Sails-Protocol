// tests/capabilityConsumersRoleCheck.test.ts
//
// A CapabilityGrant is self-issued (POST /v1/capabilities/register: grantedTo = issuedBy = the caller). It may only restrict:
// every fund-movement gate that consumes a grant keeps a role check (trade party / assigned arbiter) BEFORE it, in the same
// function; the pending-execution gate is consumed only where reviewed; and no consumer reads `issuedBy` (a grant is never
// treated as authority from someone else). Static text scan, no database; it fails when a new consumer appears unreviewed.
import { readdirSync, readFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { stripComments, enclosingFunctionRange } from './helpers/economicChokeScan'

const ROOT = join(__dirname, '..')

/** A role check that must precede a fund-movement capability check in the same function. */
const ROLE_CHECKS = ['loadEscrowWithAuthorization(', 'assertDisputedDispositionAuthority(', 'isSellerOrAssignedArbiter(']
const GATE_A = 'checkFundMovementCapability('
const GATE_A_DEFINITION = 'src/modules/open-settlement/escrow-lifecycle.ts'
const GATE_B = 'authorizePendingExecution('
const GATE_B_DEFINITION = 'src/modules/open-settlement/capability-execution-authorization.ts'
/** Reviewed Gate B consumers: both execute a round that was admitted through Gate A's role checks. */
const GATE_B_CONSUMERS = [
  'src/modules/open-settlement/escrow-pending-tx.ts',
  'src/modules/open-settlement/escrow-settlement-reconciliation.service.ts',
]
/** Files that may mention `issuedBy`: the type, the writer, the registry and the self-issuing route. */
const ISSUED_BY_FILES = [
  'src/common/types/capability.ts',
  'src/core/capability-grant-repository.ts',
  'src/core/capability-registry.ts',
  'src/modules/open-agents/capability.routes.ts',
]

function collect(dir: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (/\.ts$/.test(entry.name)) out[relative(ROOT, full).split(sep).join('/')] = readFileSync(full, 'utf8')
  }
}

function indexesOf(code: string, needle: string): number[] {
  const out: number[] = []
  for (let i = code.indexOf(needle); i >= 0; i = code.indexOf(needle, i + 1)) {
    if (!/[\w$]/.test(code[i - 1] ?? '')) out.push(i)
  }
  return out
}

export function scanCapabilityConsumers(files: Record<string, string>): string[] {
  const violations: string[] = []
  for (const [path, raw] of Object.entries(files)) {
    const code = stripComments(raw)
    if (path !== GATE_A_DEFINITION) {
      for (const i of indexesOf(code, GATE_A)) {
        const fn = enclosingFunctionRange(code, i)
        const before = fn ? code.slice(fn.start, i) : ''
        if (!ROLE_CHECKS.some((r) => before.includes(r))) violations.push(`${path}: ${GATE_A} without a preceding role check in ${fn?.name ?? '<top level>'}`)
      }
    }
    if (path !== GATE_B_DEFINITION && !GATE_B_CONSUMERS.includes(path) && indexesOf(code, GATE_B).length > 0) {
      violations.push(`${path}: unreviewed ${GATE_B} consumer`)
    }
    if (!ISSUED_BY_FILES.includes(path) && indexesOf(code, 'issuedBy').length > 0) {
      violations.push(`${path}: reads issuedBy`)
    }
  }
  return violations
}

describe('capability consumers keep the role check (a self-issued grant only restricts)', () => {
  it('the real src/** tree: every fund-movement capability check follows a role check; Gate B and issuedBy stay where reviewed', () => {
    const files: Record<string, string> = {}
    collect(join(ROOT, 'src'), files)
    expect(Object.keys(files).length).toBeGreaterThan(100)
    expect(scanCapabilityConsumers(files)).toEqual([])
    // The scan is not vacuous: the known consumers are present.
    const all = Object.values(files).map(stripComments).join('\n')
    expect(indexesOf(all, GATE_A).length).toBeGreaterThanOrEqual(5)
    for (const p of GATE_B_CONSUMERS) expect(indexesOf(stripComments(files[p]), GATE_B).length).toBeGreaterThan(0)
  })

  const ok = 'async function releaseFunds(id: string, by: string) {\n  const { escrow } = await loadEscrowWithAuthorization(id, by)\n  await checkFundMovementCapability(by, "settlement.escrow.released")\n}\n'

  it('MUTANT: a capability check with no role check before it is caught', () => {
    expect(scanCapabilityConsumers({ 'src/x.ts': ok })).toEqual([])
    expect(scanCapabilityConsumers({ 'src/x.ts': 'async function releaseFunds(id: string, by: string) {\n  await checkFundMovementCapability(by, "settlement.escrow.released")\n}\n' })).toHaveLength(1)
  })

  it('MUTANT: a role check AFTER the capability check does not count', () => {
    expect(scanCapabilityConsumers({ 'src/x.ts': 'async function releaseFunds(id: string, by: string) {\n  await checkFundMovementCapability(by, "settlement.escrow.released")\n  await loadEscrowWithAuthorization(id, by)\n}\n' })).toHaveLength(1)
  })

  it('MUTANT: a new pending-execution consumer, or a new reader of issuedBy, is caught', () => {
    expect(scanCapabilityConsumers({ 'src/y.ts': 'async function run(p: any) {\n  await authorizePendingExecution(p)\n}\n' })).toHaveLength(1)
    expect(scanCapabilityConsumers({ 'src/z.ts': 'async function trust(g: any) {\n  return g.issuedBy === "issuer"\n}\n' })).toHaveLength(1)
  })
})
