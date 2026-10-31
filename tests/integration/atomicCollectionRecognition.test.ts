// tests/integration/atomicCollectionRecognition.test.ts
//
// Missão 11 Fase 7.2.1 — real-Postgres adversarial proof of
// recognizeConfirmation()'s transaction-integrity hardening.
//
// Direct reproduction (this phase's own §A/§B audit, performed by hand
// before this file existed) confirmed the PRE-fix shape — two separate
// top-level writes (CONFIRMED-evidence insert, then the IN_PROGRESS ->
// COLLECTED transition) — could produce two CONFIRMED rows for the SAME
// on-chain confirmation event, independently frozen to DIFFERENT
// DistributionPolicyVersions, if a crash (or a losing concurrent caller)
// landed between the two writes and a policy rotation happened before the
// real periodic sweep job's automatic retry (multisig-fee-confirmation-
// job.ts re-selects any still-IN_PROGRESS obligation every tick — this is
// that job's own normal recovery behavior, not a hypothetical). This file
// proves the fix: both writes now commit inside one prisma.$transaction
// (fee-collection-recognition.service.ts's own header comment has the
// full design rationale), so a crash/rollback anywhere in that window
// leaves NO trace, and a subsequent retry is genuinely fresh.
//
// tests/integration/collectedTimeDistributionFreeze.test.ts already
// covers normal-path convergence, reorg/reconfirmation, and permanent
// zero-policy semantics under the atomic version — not duplicated here.

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('recognizeConfirmation() atomicity (Missão 11 Fase 7.2.1, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let distributionPolicyService: typeof import('../../src/modules/open-settlement/distribution-policy.service').distributionPolicyService
  let distributionRecipientRepository: typeof import('../../src/modules/open-settlement/distribution-recipient-repository').distributionRecipientRepository
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let feeCollectionEvidenceRepository: typeof import('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service'))
    ;({ distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ feeCollectionEvidenceRepository } = require('../../src/modules/open-settlement/fee-collection-evidence-repository'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function suffix() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

  async function retireLivePolicyIfAny() {
    const live = await distributionPolicyService.findLivePolicy()
    if (live) await distributionPolicyService.retire(live.id)
  }

  async function publish100PctPolicy(): Promise<string> {
    await retireLivePolicyIfAny()
    const r = await distributionRecipientRepository.create({ class: `ATOMIC_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`, label: 'atomic-fixture-recipient' })
    const draft = await distributionPolicyService.createDraft({ label: `atomic-policy-${suffix()}`, createdBy: 'fase7-2-1-atomicity-test' })
    await distributionPolicyService.addRecipient(draft.id, r.id, '100')
    const published = await distributionPolicyService.publish(draft.id)
    return published.id
  }

  async function fixtureObligation(): Promise<{ obligationId: string; txid: string }> {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-atomic-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-atomic-${s}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const railScope = `FIXTURE_RAIL_ATOMICITY-${s}`
    const feePolicy = await prisma.feePolicyVersion.create({
      data: { label: `atomic-feepolicy-${s}`, railScope, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 1, createdBy: 'fase7-2-1-atomicity-test' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' } })
    const obligation = await prisma.feeObligation.create({
      data: { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.00000500', asset: 'BTC' },
    })
    const txid = require('crypto').createHash('sha256').update(obligation.id + s).digest('hex')
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, { txid, vout: 1, scriptPubKey: 'deadbeef', amountSats: 1 })
    return { obligationId: obligation.id, txid }
  }

  // ─── Items 2/3/6: simulated crash inside the transaction rolls back  ────
  // ─── BOTH writes; a subsequent retry is genuinely fresh and reflects ────
  // ─── whatever policy is live AT RETRY TIME — never a resurrected P1. ────
  it('a simulated crash between the CONFIRMED-insert and the COLLECTED-transition rolls back both writes; retry never duplicates and never resurrects the rolled-back policy', async () => {
    requirePostgres('simulated crash + retry')
    const p1 = await publish100PctPolicy()
    const { obligationId, txid } = await fixtureObligation()

    // Simulate "process died mid-transaction": perform the exact same two
    // writes recognizeConfirmation() would, inside a real transaction,
    // then force a throw before it can commit — Postgres rolls back
    // everything in that transaction, which is indistinguishable from a
    // real crash from the database's point of view (an uncommitted
    // transaction never partially persists).
    await expect(
      prisma.$transaction(async (tx) => {
        await feeCollectionEvidenceRepository.record({
          feeObligationId: obligationId, kind: 'CONFIRMED', txid, vout: 1, scriptPubKey: 'deadbeef', amount: '0.00000001',
          confirmedAtHeight: 800000, distributionPolicyVersionId: p1,
        }, tx)
        await tx.feeObligation.updateMany({ where: { id: obligationId, collectionStatus: 'IN_PROGRESS' }, data: { collectionStatus: 'COLLECTED' } })
        throw new Error('SIMULATED CRASH — must never commit')
      })
    ).rejects.toThrow('SIMULATED CRASH')

    // Nothing persisted — the rollback was total, not partial.
    const confirmedRowsAfterCrash = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
    expect(confirmedRowsAfterCrash).toHaveLength(0)
    const obligationAfterCrash = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    expect(obligationAfterCrash!.collectionStatus).toBe('IN_PROGRESS')

    // Policy rotation during the "crash window."
    await distributionPolicyService.retire(p1)
    const p2 = await publish100PctPolicy()

    // Retry through the REAL entrypoint — exactly what the periodic sweep
    // job would do on its next tick, since the obligation is still
    // IN_PROGRESS.
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000)

    // Exactly ONE CONFIRMED row — no orphan from the crashed attempt —
    // frozen to whatever was live AT RETRY TIME (P2), never P1.
    const confirmedRowsAfterRetry = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
    expect(confirmedRowsAfterRetry).toHaveLength(1)
    expect(confirmedRowsAfterRetry[0].distributionPolicyVersionId).toBe(p2)
    const obligationAfterRetry = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    expect(obligationAfterRetry!.collectionStatus).toBe('COLLECTED')
  })

  // ─── Items 4/5/9: concurrent recognition attempts for the SAME ──────────
  // ─── confirmation cannot produce competing CONFIRMED generations or ─────
  // ─── duplicate entitlement. ──────────────────────────────────────────────
  it('two concurrent recognizeConfirmation() calls for the same obligation+txid: exactly one wins, exactly one CONFIRMED row exists, no duplicate entitlement possible', async () => {
    requirePostgres('concurrent recognition race')
    await publish100PctPolicy()
    const { obligationId, txid } = await fixtureObligation()

    const results = await Promise.allSettled([
      feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000),
      feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // Exactly one CONFIRMED row — the loser's own evidence insert rolled
    // back along with its failed transition claim, inside its own
    // transaction. Before the Fase 7.2.1 fix this would have been 2.
    const confirmedRows = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
    expect(confirmedRows).toHaveLength(1)

    const obligation = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    expect(obligation!.collectionStatus).toBe('COLLECTED')

    // Allocation can only ever find the one real generation — structurally
    // safe from duplicate entitlement, not merely by allocate()'s own
    // tie-break convention.
    const { entitlementAllocationService } = require('../../src/modules/open-settlement/entitlement-allocation.service')
    const entries = await entitlementAllocationService.allocate(obligationId)
    expect(entries).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Issue #245 (CTO decision D-245) — recordBroadcastAndAdvance(): the BROADCAST evidence insert and the
// PENDING_COLLECTION -> IN_PROGRESS claim are ONE PostgreSQL transaction; retries are idempotent only
// after a canonical txid+vout+scriptPubKey+amount match; anything else is an auditable conflict.
//
// Everything below runs on REAL PostgreSQL through the same fail-closed harness as above (explicit
// authorization, host allowlist, non-production database name). Mocks are used only to INJECT failures or
// to hold a transaction open at a chosen point; the properties asserted are read back from the database.
// Lines starting with "EVIDENCE" are printed on purpose: they are the reproducible interleaving record.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('recordBroadcastAndAdvance() atomicity and retry semantics (Issue #245, real Postgres)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let FeeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').FeeCollectionRecognitionService
  let FeeBroadcastEvidenceConflictError: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').FeeBroadcastEvidenceConflictError
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let feeCollectionEvidenceRepository: typeof import('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository
  let feeObligationRepository: typeof import('../../src/modules/open-settlement/fee-obligation-repository').feeObligationRepository
  let feeObligationService: typeof import('../../src/modules/open-settlement/fee-obligation.service').feeObligationService
  let distributionPolicyService: typeof import('../../src/modules/open-settlement/distribution-policy.service').distributionPolicyService
  let distributionRecipientRepository: typeof import('../../src/modules/open-settlement/distribution-recipient-repository').distributionRecipientRepository

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ FeeCollectionRecognitionService, FeeBroadcastEvidenceConflictError, feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ feeCollectionEvidenceRepository } = require('../../src/modules/open-settlement/fee-collection-evidence-repository'))
    ;({ feeObligationRepository } = require('../../src/modules/open-settlement/fee-obligation-repository'))
    ;({ feeObligationService } = require('../../src/modules/open-settlement/fee-obligation.service'))
    ;({ distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service'))
    ;({ distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const evidenceLine = (label: string, data: unknown) => process.stdout.write(`EVIDENCE[#245] ${label}: ${JSON.stringify(data)}\n`)
  const BROADCAST = { vout: 1, scriptPubKey: 'deadbeef', amountSats: 4000 }
  const txidFor = (obligationId: string, tag = '') => require('crypto').createHash('sha256').update(obligationId + tag).digest('hex')

  /** A PENDING_COLLECTION obligation with NO evidence (unlike fixtureObligation() above, which broadcasts it). */
  async function pendingObligation(): Promise<{ obligationId: string; txid: string }> {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-245-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-245-${s}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const feePolicy = await prisma.feePolicyVersion.create({
      data: { label: `fp-245-${s}`, railScope: `FIXTURE_RAIL_245-${s}`, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 1, createdBy: 'issue-245-test' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' } })
    const obligation = await prisma.feeObligation.create({
      data: { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.00000500', asset: 'BTC' },
    })
    return { obligationId: obligation.id, txid: txidFor(obligation.id, s) }
  }

  async function state(obligationId: string) {
    const [rows, obligation] = await Promise.all([
      prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId }, orderBy: { recordedAt: 'asc' } }),
      prisma.feeObligation.findUnique({ where: { id: obligationId } }),
    ])
    const count = (kind: string) => rows.filter((r) => r.kind === kind).length
    return { status: obligation!.collectionStatus, broadcast: count('BROADCAST'), confirmed: count('CONFIRMED'), replaced: count('REPLACED'), rows }
  }

  /** A service over the REAL repositories whose evidence insert can be paused or made to fail at chosen points. */
  function hookedService(hooks: { beforeInsert?: () => Promise<void>; afterInsert?: () => Promise<void> } = {}, policy?: any) {
    const evidenceRepo = {
      record: async (input: any, tx?: any) => {
        await hooks.beforeInsert?.()
        const row = await feeCollectionEvidenceRepository.record(input, tx)
        await hooks.afterInsert?.()
        return row
      },
      listForObligation: (id: string, tx?: any) => feeCollectionEvidenceRepository.listForObligation(id, tx),
    }
    return new FeeCollectionRecognitionService(feeObligationRepository, evidenceRepo as any, feeObligationService, policy)
  }

  async function publish100PctPolicy(): Promise<string> {
    const live = await distributionPolicyService.findLivePolicy()
    if (live) await distributionPolicyService.retire(live.id)
    const r = await distributionRecipientRepository.create({ class: `A245_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`, label: 'issue-245-recipient' })
    const draft = await distributionPolicyService.createDraft({ label: `policy-245-${suffix()}`, createdBy: 'issue-245-test' })
    await distributionPolicyService.addRecipient(draft.id, r.id, '100')
    return (await distributionPolicyService.publish(draft.id)).id
  }

  // ─── A. rollback on a failure between the two logical steps ───────────────────────────────────
  it('A1 a failure AFTER the evidence insert and before commit leaves no BROADCAST row and the obligation PENDING_COLLECTION', async () => {
    pg.requirePostgres('A1')
    const { obligationId, txid } = await pendingObligation()
    const svc = hookedService({ afterInsert: async () => { throw new Error('INJECTED FAILURE after insert, before commit') } })
    await expect(svc.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).rejects.toThrow('INJECTED FAILURE')
    const s = await state(obligationId)
    evidenceLine('A1 after failure-after-insert', { status: s.status, broadcastRows: s.broadcast })
    expect(s).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 0 })
  })

  it('A2 a failure AFTER the claim and BEFORE the insert rolls the claim back (obligation PENDING_COLLECTION, no row)', async () => {
    pg.requirePostgres('A2')
    const { obligationId, txid } = await pendingObligation()
    const svc = hookedService({ beforeInsert: async () => { throw new Error('INJECTED FAILURE after claim, before insert') } })
    await expect(svc.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).rejects.toThrow('INJECTED FAILURE')
    const s = await state(obligationId)
    evidenceLine('A2 after failure-after-claim', { status: s.status, broadcastRows: s.broadcast })
    expect(s).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 0 })
  })

  it('A3 retry after either rollback, with a brand new service instance: exactly one BROADCAST row and IN_PROGRESS', async () => {
    pg.requirePostgres('A3')
    const { obligationId, txid } = await pendingObligation()
    await expect(hookedService({ afterInsert: async () => { throw new Error('INJECTED') } }).recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).rejects.toThrow('INJECTED')
    const outcome = await hookedService().recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    const s = await state(obligationId)
    evidenceLine('A3 retry after rollback', { outcome, status: s.status, broadcastRows: s.broadcast })
    expect(outcome).toBe('RECORDED')
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
  })

  // ─── B. a REAL process crash (the child is killed while its transaction is open) ──────────────
  it('B1 a process killed with the transaction open (insert done, not committed) leaves nothing; the retry then records exactly one row', async () => {
    pg.requirePostgres('B1')
    const { obligationId, txid } = await pendingObligation()
    const { spawn } = require('child_process')
    const root = require('path').resolve(__dirname, '..', '..')
    const code = `
      const { FeeCollectionRecognitionService } = require(${JSON.stringify(root + '/src/modules/open-settlement/fee-collection-recognition.service')})
      const { feeCollectionEvidenceRepository: ev } = require(${JSON.stringify(root + '/src/modules/open-settlement/fee-collection-evidence-repository')})
      const { feeObligationRepository } = require(${JSON.stringify(root + '/src/modules/open-settlement/fee-obligation-repository')})
      const { feeObligationService } = require(${JSON.stringify(root + '/src/modules/open-settlement/fee-obligation.service')})
      const repo = { record: async (i, t) => { const r = await ev.record(i, t); process.stdout.write('INSERTED\\n'); await new Promise(() => {}); return r }, listForObligation: (id, t) => ev.listForObligation(id, t) }
      new FeeCollectionRecognitionService(feeObligationRepository, repo, feeObligationService)
        .recordBroadcastAndAdvance(${JSON.stringify(obligationId)}, ${JSON.stringify({ txid, ...BROADCAST })}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
    `
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', code], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('child never reached the open transaction. stderr: ' + stderr.slice(0, 600))), 90_000)
      child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('INSERTED')) { clearTimeout(t); resolve() } })
      child.on('exit', () => { clearTimeout(t); reject(new Error('child exited early. stderr: ' + stderr.slice(0, 600))) })
    })
    child.kill('SIGKILL')
    await new Promise((r) => child.on('exit', r))
    // The server drops the dead connection's transaction; the retry below waits on the row lock until it does.
    const outcome = await hookedService().recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    const s = await state(obligationId)
    evidenceLine('B1 real process kill, then retry', { outcome, status: s.status, broadcastRows: s.broadcast })
    expect(outcome).toBe('RECORDED')
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
  })

  // ─── C. concurrency ─────────────────────────────────────────────────────────────────────────────
  it('C1 forced interleaving: the second identical caller blocks while the first holds its open transaction, then sees the committed evidence and is an idempotent no-op', async () => {
    pg.requirePostgres('C1')
    const { obligationId, txid } = await pendingObligation()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let firstInserted!: () => void
    const firstHasInserted = new Promise<void>((r) => { firstInserted = r })
    const first = hookedService({ afterInsert: async () => { firstInserted(); await gate } })
    const second = hookedService()

    const p1 = first.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    await firstHasInserted // T1: claim done, row inserted, transaction OPEN and uncommitted
    let secondSettled = false
    const p2 = second.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST }).finally(() => { secondSettled = true })
    await sleep(750)
    const midway = await state(obligationId) // read from a third connection while T1 is uncommitted
    evidenceLine('C1 while T1 is open', { secondStillBlocked: !secondSettled, committedBroadcastRows: midway.broadcast, committedStatus: midway.status })
    expect(secondSettled).toBe(false)
    expect(midway).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 0 }) // nothing of T1 is visible before its commit

    release()
    const [o1, o2] = await Promise.all([p1, p2])
    const s = await state(obligationId)
    evidenceLine('C1 after release', { first: o1, second: o2, status: s.status, broadcastRows: s.broadcast })
    expect(o1).toBe('RECORDED')
    expect(o2).toBe('ALREADY_RECORDED')
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
  })

  it('C2 forced interleaving with a DIVERGENT second caller (different vout): it conflicts, writes nothing, and the first writer\'s evidence stands', async () => {
    pg.requirePostgres('C2')
    const { obligationId, txid } = await pendingObligation()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let firstInserted!: () => void
    const firstHasInserted = new Promise<void>((r) => { firstInserted = r })
    const p1 = hookedService({ afterInsert: async () => { firstInserted(); await gate } }).recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    await firstHasInserted
    const p2 = hookedService().recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST, vout: 2 })
    const settled2 = p2.then(() => 'resolved', (e) => e)
    await sleep(500)
    release()
    const [o1, r2] = await Promise.all([p1, settled2])
    const s = await state(obligationId)
    evidenceLine('C2 divergent second caller', { first: o1, second: r2 instanceof Error ? r2.name : r2, status: s.status, broadcastRows: s.broadcast, storedVout: s.rows[0]?.vout })
    expect(o1).toBe('RECORDED')
    expect(r2).toBeInstanceOf(FeeBroadcastEvidenceConflictError)
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
    expect(s.rows[0].vout).toBe(1)
  })

  it('C3 unforced stress: 6 simultaneous identical callers on each of 12 obligations always produce exactly one row and one RECORDED', async () => {
    pg.requirePostgres('C3')
    const tallies: Record<string, number> = { RECORDED: 0, ALREADY_RECORDED: 0, ADVANCED_EXISTING_EVIDENCE: 0, rejected: 0 }
    for (let n = 0; n < 12; n++) {
      const { obligationId, txid } = await pendingObligation()
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => hookedService().recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })))
      for (const r of results) { if (r.status === 'fulfilled') tallies[r.value]++; else tallies.rejected++ }
      const s = await state(obligationId)
      expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
      expect(results.filter((r) => r.status === 'fulfilled' && r.value === 'RECORDED')).toHaveLength(1)
    }
    evidenceLine('C3 stress tallies over 12 obligations x 6 callers', tallies)
    expect(tallies).toEqual({ RECORDED: 12, ALREADY_RECORDED: 60, ADVANCED_EXISTING_EVIDENCE: 0, rejected: 0 })
  })

  it('C4 unforced stress with divergent callers: exactly one row ever, equal to the winner\'s; every loser is ALREADY_RECORDED (identical to the winner) or a conflict', async () => {
    pg.requirePostgres('C4')
    for (let n = 0; n < 8; n++) {
      const { obligationId, txid } = await pendingObligation()
      const calls = [1, 1, 1, 2, 2, 3].map((vout) => hookedService().recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST, vout }))
      const results = await Promise.allSettled(calls)
      const s = await state(obligationId)
      const winners = results.filter((r) => r.status === 'fulfilled' && r.value === 'RECORDED')
      expect(winners).toHaveLength(1)
      expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
      results.forEach((r, i) => {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(FeeBroadcastEvidenceConflictError)
        else if (r.value === 'ALREADY_RECORDED') expect([1, 1, 1, 2, 2, 3][i]).toBe(s.rows[0].vout) // only a caller identical to the stored row may be absorbed
      })
    }
  })

  // ─── D. retries after commit ────────────────────────────────────────────────────────────────────
  it('D1 an identical retry after commit is a no-op; a retry that differs in txid, vout, scriptPubKey or amount is a conflict; the row and the status never change', async () => {
    pg.requirePostgres('D1')
    const { obligationId, txid } = await pendingObligation()
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    const before = await state(obligationId)
    expect(await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).toBe('ALREADY_RECORDED')
    const divergent = [
      { txid: txidFor(obligationId, 'other'), ...BROADCAST },
      { txid, ...BROADCAST, vout: 7 },
      { txid, ...BROADCAST, scriptPubKey: 'cafe' },
      { txid, ...BROADCAST, amountSats: 4001 },
    ]
    for (const d of divergent) await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, d)).rejects.toBeInstanceOf(FeeBroadcastEvidenceConflictError)
    const after = await state(obligationId)
    evidenceLine('D1 retries after commit', { identical: 'ALREADY_RECORDED', divergentConflicts: divergent.length, broadcastRows: after.broadcast, status: after.status })
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id))
    expect(after).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
  })

  it('D2 after CONFIRMED the obligation is COLLECTED: a retry of the same broadcast is a no-op, adds no BROADCAST, no second CONFIRMED, and the allocation stays a single generation (no duplicate revenue)', async () => {
    pg.requirePostgres('D2')
    await publish100PctPolicy()
    const { obligationId, txid } = await pendingObligation()
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000)
    expect(await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).toBe('ALREADY_RECORDED')
    const s = await state(obligationId)
    const { entitlementAllocationService } = require('../../src/modules/open-settlement/entitlement-allocation.service')
    const entries = await entitlementAllocationService.allocate(obligationId)
    evidenceLine('D2 retry after COLLECTED', { status: s.status, broadcastRows: s.broadcast, confirmedRows: s.confirmed, allocationEntries: entries.length })
    expect(s).toMatchObject({ status: 'COLLECTED', broadcast: 1, confirmed: 1 })
    expect(entries).toHaveLength(1)
  })

  it('D3 a reorg that reverts COLLECTED -> IN_PROGRESS keeps the broadcast retry a no-op (no new BROADCAST row, no revenue duplicated)', async () => {
    pg.requirePostgres('D3')
    await publish100PctPolicy()
    const { obligationId, txid } = await pendingObligation()
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000)
    await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, txid)
    const reverted = await state(obligationId)
    expect(reverted.status).toBe('IN_PROGRESS')
    expect(await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).toBe('ALREADY_RECORDED')
    const s = await state(obligationId)
    evidenceLine('D3 retry after reorg-revert', { status: s.status, broadcastRows: s.broadcast, confirmedRows: s.confirmed })
    expect(s.broadcast).toBe(1)
    expect(s.confirmed).toBe(1)
  })

  // ─── E. replacement and legacy orphans ──────────────────────────────────────────────────────────
  it('E1 replaying a REPLACED txid is a conflict, never an idempotent retry; the append-only history is untouched', async () => {
    pg.requirePostgres('E1')
    const { obligationId, txid } = await pendingObligation()
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    const newTxid = txidFor(obligationId, 'rbf')
    await feeCollectionRecognitionService.recordReplacement(obligationId, txid, newTxid)
    await feeCollectionEvidenceRepository.record({ feeObligationId: obligationId, kind: 'BROADCAST', txid: newTxid, vout: 1, scriptPubKey: 'deadbeef', amount: '0.00004' }) // the separate RBF flow's job, simulated
    const before = await state(obligationId)
    await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })).rejects.toBeInstanceOf(FeeBroadcastEvidenceConflictError)
    await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid: newTxid, ...BROADCAST })).rejects.toBeInstanceOf(FeeBroadcastEvidenceConflictError) // two different broadcasts: ambiguous
    const after = await state(obligationId)
    evidenceLine('E1 replay around a replacement', { broadcastRows: after.broadcast, replacedRows: after.replaced, status: after.status })
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id))
  })

  it('E2 a pre-fix orphan (BROADCAST row on a PENDING_COLLECTION obligation): the matching call advances the obligation on it WITHOUT a second row; a differing call is a conflict and the claim rolls back', async () => {
    pg.requirePostgres('E2')
    const matching = await pendingObligation()
    await feeCollectionEvidenceRepository.record({ feeObligationId: matching.obligationId, kind: 'BROADCAST', txid: matching.txid, vout: 1, scriptPubKey: 'deadbeef', amount: '0.00004' })
    expect(await feeCollectionRecognitionService.recordBroadcastAndAdvance(matching.obligationId, { txid: matching.txid, ...BROADCAST })).toBe('ADVANCED_EXISTING_EVIDENCE')
    const adopted = await state(matching.obligationId)

    const differing = await pendingObligation()
    await feeCollectionEvidenceRepository.record({ feeObligationId: differing.obligationId, kind: 'BROADCAST', txid: differing.txid, vout: 9, scriptPubKey: 'deadbeef', amount: '0.00004' })
    await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(differing.obligationId, { txid: differing.txid, ...BROADCAST })).rejects.toBeInstanceOf(FeeBroadcastEvidenceConflictError)
    const refused = await state(differing.obligationId)
    evidenceLine('E2 legacy orphans', { matching: { status: adopted.status, broadcastRows: adopted.broadcast }, differing: { status: refused.status, broadcastRows: refused.broadcast } })
    expect(adopted).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1 })
    expect(refused).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 1 }) // the orphan is kept as found, the claim rolled back
  })

  // ─── F. adjacent risk, CHARACTERIZED (not fixed here; D-245 keeps RBF/CONFIRMED serialization out of scope) ─
  it('F1 CHARACTERIZATION (known residual risk, not a fix): recognizeConfirmation() validates the latest BROADCAST BEFORE its transaction, so a replacement landing in between does not stop the CONFIRMED of the OLD txid', async () => {
    pg.requirePostgres('F1')
    const { obligationId, txid } = await pendingObligation()
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, ...BROADCAST })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let paused!: () => void
    const isPaused = new Promise<void>((r) => { paused = r })
    const slowPolicy = { findLivePolicy: async () => { paused(); await gate; return null } } as any // awaited between the BROADCAST check and the transaction
    const svc = new FeeCollectionRecognitionService(feeObligationRepository, feeCollectionEvidenceRepository, feeObligationService, slowPolicy)
    const confirming = svc.recognizeConfirmation(obligationId, txid, 800000)
    await isPaused
    const newTxid = txidFor(obligationId, 'rbf-race')
    await feeCollectionRecognitionService.recordReplacement(obligationId, txid, newTxid)
    await feeCollectionEvidenceRepository.record({ feeObligationId: obligationId, kind: 'BROADCAST', txid: newTxid, vout: 1, scriptPubKey: 'deadbeef', amount: '0.00004' })
    release()
    await confirming
    const s = await state(obligationId)
    const confirmed = s.rows.find((r) => r.kind === 'CONFIRMED')
    evidenceLine('F1 confirmation raced by a replacement', { status: s.status, confirmedTxid: confirmed?.txid?.slice(0, 8), currentBroadcastTxid: newTxid.slice(0, 8) })
    // Documents TODAY's behaviour: the old txid is confirmed although a newer BROADCAST exists. Flip these expectations when serialization is added.
    expect(s.status).toBe('COLLECTED')
    expect(confirmed!.txid).toBe(txid)
  })
})
