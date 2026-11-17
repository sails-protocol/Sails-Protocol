// tests/c4EligibilityPredicateParity.test.ts
//
// CTO 341 - dispute-dispatch-recovery.ts selects its candidates with two SQL statements: the keyset page of the unbounded call
// (candidatePage) and the claim of a bounded call (claimCandidates). They MUST apply the same eligibility predicate: if one drifted
// from the other, a bounded run could claim - and stamp, and attempt - a dispute the unbounded run never considers, or the reverse.
// They are two literal statements (a shared nested SQL fragment broke whenever the module registry held two Prisma copies), so this
// test keeps the two texts identical. Pure text, no database.
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(__dirname, '..', 'src', 'modules', 'open-settlement', 'dispute-dispatch-recovery.ts'), 'utf8')

/** The predicate from `d.status = 'RESOLVED'` up to the end of the pending-round condition, whitespace-normalised. */
function predicateOf(statement: string): string {
  const start = statement.indexOf("d.status = 'RESOLVED'")
  const end = statement.indexOf('s."participantId" = required.id))))')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return statement.slice(start, end + 'required.id))))'.length).replace(/\s+/g, ' ').replace(/ --[^\n]*/g, '').trim()
}

function statement(name: string): string {
  const start = source.indexOf(`async function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n}\n', start))
}

describe('C4 candidate predicate: the keyset page and the claim agree', () => {
  it('candidatePage() and claimCandidates() carry the same eligibility predicate', () => {
    const page = predicateOf(statement('candidatePage'))
    const claim = predicateOf(statement('claimCandidates'))
    expect(page).toContain('semantic_transition_records')
    expect(page).toContain("e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')")
    expect(claim).toBe(page)
  })

  it('the claim writes only the stamp, only on a RESOLVED dispute, with the database clock (never status, never updatedAt)', () => {
    const claim = statement('claimCandidates').replace(/\s+/g, ' ')
    expect(claim).toContain('SET "dispatchRecoveryAttemptedAt" = (clock_timestamp() AT TIME ZONE \'UTC\')')
    expect(claim).toContain("d.status = 'RESOLVED'")
    expect(claim).toContain('FOR UPDATE OF d SKIP LOCKED')
    expect(claim.match(/ SET /g)).toHaveLength(1)
    expect(claim).not.toMatch(/"updatedAt"|status\s*=\s*'(?!RESOLVED')/)
  })
})
