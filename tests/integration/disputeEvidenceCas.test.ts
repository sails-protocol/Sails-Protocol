/**
 * #367 / CTO 340 - submitEvidence() must never overwrite a dispute that changed after it was read.
 *
 * GK reproduction on main 501208f0 (EPM-registros/GK_CTO340_367_reproducao_concorrencia.md): persistEvidence() wrote
 * `evidence` and `status` with an unconditional UPDATE by id, so (A) a concurrent evidence append was lost and (B) a
 * concurrent RESOLVED/RELEASE ruling was turned back into EVIDENCE_SUBMITTED with the ruling still set, hiding it from
 * C4 and ruling-finalization recovery.
 *
 * The interleaving is forced, not timed: a second connection holds the dispute row lock, submitEvidence() reads the row
 * (MVCC, not blocked), validates it, and its write blocks on the lock (observed in pg_locks); the second connection then
 * commits its change and releases the lock. Every production writer of `disputes` bumps "updatedAt" (Prisma's
 * @updatedAt, and the explicit "updatedAt" of the raw auto-resolution UPDATEs), and the concurrent changes below do the
 * same. The fix is the compare-and-set of #642 (f7c1366a), identical text.
 */
// getDisputeService() needs an arbitration provider; set before src/config is first loaded (by the harness probe).
process.env.TRUSTED_ARBITRATORS = process.env.TRUSTED_ARBITRATORS || 'cas367-arbiter'

import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

jest.setTimeout(60_000)

describe('#367 - submitEvidence() is a compare-and-set on the dispute it validated (real PostgreSQL)', () => {
  const pg = createPostgresIntegrationHarness()
  let admin: Client
  let service: any

  beforeAll(async () => {
    await pg.probe()
    pg.requirePostgres('dispute evidence compare-and-set')
    admin = new Client({ connectionString: pg.getUrl() })
    await admin.connect()
    service = require('../../src/modules/open-settlement/dispute.service').getDisputeService()
  })

  afterAll(async () => {
    await require('../../src/common/database').prisma.$disconnect().catch(() => {})
    await admin?.end()
  })

  // A dispute in EVIDENCE_SUBMITTED with one evidence entry (e0); the trade only needs to name the two parties.
  async function dispute(name: string): Promise<string> {
    const id = `cas367-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fill = async (table: string, fixed: Record<string, unknown>) => {
      const { rows } = await admin.query(`SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`, [table])
      const cols: string[] = []
      const vals: unknown[] = []
      for (const r of rows) {
        if (r.column_name in fixed) continue
        let v: unknown
        if (r.data_type === 'USER-DEFINED') v = (await admin.query(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY enumsortorder LIMIT 1`, [r.udt_name])).rows[0].enumlabel
        else if (/int|numeric|double|real/.test(r.data_type)) v = 1
        else if (r.data_type === 'boolean') v = false
        else if (/timestamp|date/.test(r.data_type)) v = new Date()
        else if (/json/.test(r.data_type)) v = '{}'
        else v = 'cas367'
        cols.push(`"${r.column_name}"`)
        vals.push(v)
      }
      for (const [k, v] of Object.entries(fixed)) { cols.push(`"${k}"`); vals.push(v) }
      await admin.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')})`, vals)
    }
    await admin.query('BEGIN')
    await admin.query('SET LOCAL session_replication_role = replica') // fixture only: the trade's parents are irrelevant here
    await fill('trades', { id: `${id}-t`, buyerId: 'cas367-buyer', sellerId: 'cas367-seller' })
    await admin.query(`INSERT INTO disputes (id, "tradeId", "escrowId", "openedBy", reason, evidence, status, "updatedAt")
      VALUES ($1, $2, 'cas367-escrow', 'cas367-buyer', 'cas367', $3::jsonb, 'EVIDENCE_SUBMITTED', now())`,
    [id, `${id}-t`, JSON.stringify([{ type: 'TEXT', uri: 'e0', submittedBy: 'cas367-buyer' }])])
    await admin.query('COMMIT')
    return id
  }

  const submit = (id: string) => service.submitEvidence(id, 'cas367-seller', { type: 'TEXT', uri: 'e1', note: 'cas367', externalReference: true })
    .then(() => 'recorded', (e: any) => `refused: ${String(e?.message)}`)

  // Runs submitEvidence() with its write parked behind a row lock, commits `concurrentSql` meanwhile, returns the outcome.
  async function interleave(id: string, concurrentSql: string) {
    const holder = new Client({ connectionString: pg.getUrl() })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM disputes WHERE id = $1 FOR UPDATE', [id])
    let settled = false
    const call = submit(id).finally(() => { settled = true })
    let blocked = false
    for (let i = 0; i < 300 && !settled; i++) {
      const { rowCount } = await admin.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database() AND a.query ILIKE '%disputes%'`)
      if (rowCount) { blocked = true; break }
      await new Promise((r) => setTimeout(r, 20))
    }
    await holder.query(concurrentSql, [id])
    await holder.query('COMMIT')
    await holder.end()
    const result = await call
    const { rows: [row] } = await admin.query('SELECT status, ruling, evidence FROM disputes WHERE id = $1', [id])
    return { blocked, result, status: row.status, ruling: row.ruling, uris: (row.evidence ?? []).map((e: any) => e.uri) }
  }

  it('control: with no concurrent change the evidence is appended', async () => {
    const id = await dispute('control')
    expect(await submit(id)).toBe('recorded')
    const { rows: [row] } = await admin.query('SELECT status, evidence FROM disputes WHERE id = $1', [id])
    expect({ status: row.status, uris: row.evidence.map((e: any) => e.uri) }).toEqual({ status: 'EVIDENCE_SUBMITTED', uris: ['e0', 'e1'] })
  })

  it('A: a concurrent evidence append committed while the write waited is never lost; the stale submission is refused', async () => {
    const id = await dispute('A')
    const out = await interleave(id, `UPDATE disputes SET evidence = evidence || '[{"type":"TEXT","uri":"e2","submittedBy":"cas367-buyer"}]'::jsonb, "updatedAt" = now() WHERE id = $1`)
    expect(out.blocked).toBe(true)
    expect(out.result).toMatch(/refused: .*changed while this evidence was being validated/)
    expect(out.uris).toEqual(['e0', 'e2'])
    expect(out.status).toBe('EVIDENCE_SUBMITTED')
    expect(await submit(id)).toBe('recorded') // the retry the error asks for reads the fresh row and succeeds
  })

  it('B: a concurrent RESOLVED/RELEASE ruling is never overwritten back to EVIDENCE_SUBMITTED', async () => {
    const id = await dispute('B')
    const out = await interleave(id, `UPDATE disputes SET status = 'RESOLVED', ruling = 'RELEASE', "resolvedAt" = now(), "updatedAt" = now() WHERE id = $1`)
    expect(out.blocked).toBe(true)
    expect(out.result).toMatch(/refused: /)
    expect({ status: out.status, ruling: out.ruling, uris: out.uris }).toEqual({ status: 'RESOLVED', ruling: 'RELEASE', uris: ['e0'] })
    expect(await submit(id)).toMatch(/refused: .*cannot accept new evidence/) // and a fresh submission is refused by status
  })
})
