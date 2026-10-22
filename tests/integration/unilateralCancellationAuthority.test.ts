// tests/integration/unilateralCancellationAuthority.test.ts
//
// #235 R7G-B1 — UNILATERAL_INTENT_REVOCATION_V1 and FAILED_CANCELLATION_NO_DURABLE_EFFECT_V1, on real
// PostgreSQL.
//
// A manual cancellation (tradeService.updateStatus) is accepted only while no funds can exist for the trade on
// its rail: no escrow; MULTISIG with no persisted deposit address; WDK_USDT_EVM with no transfer attempt that
// may have been submitted. FUNDS_LOCKED, PAYMENT_PENDING and EXPIRED (and the #294 governed states) refuse it,
// and the refund / dispute / settlement exits stay open. Key submission and lockFunds() — the two calls that
// create a funding surface or a lock — take the same trade-lifecycle lock and refuse a CANCELLED trade. A
// cancellation that fails leaves nothing behind: not the Trade write, not the Intent write, not an event.
//
// Interleavings are forced: one request is paused inside its transaction (a proxied transaction client) while
// another node (its own module graph, PrismaClient and pool) runs, and the database is observed meanwhile.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount, deleteFixtureAccounts } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

type Node = { prisma: any; escrowService: any; tradeService: any; repo: any; providers: (type: string) => any; eventBus: any; redis?: any }

const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'
const PAYOUT = 'bc1q7mrvhs3xxzg9jyesd60nvda26ueukn9nc404xk'
const COMMITTED = /can no longer be cancelled unilaterally|governs the outcome/

describe('#235 R7G-B1 — unilateral cancellation authority (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let A: Node
  const extraNodes: Node[] = []
  let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false' // real MULTISIG address derivation
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'dust-integrity-test-seed'
    process.env.TRUSTED_ARBITRATORS = process.env.TRUSTED_ARBITRATORS || 'dust-test-arbiter'
    process.env.MULTISIG_NETWORK = 'bitcoin'
    process.env.MULTISIG_EXPLORER_API_URL = process.env.MULTISIG_EXPLORER_API_URL || 'https://mempool.space/api'
    process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS || '1'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    A = load(() => undefined)
    realFetch = global.fetch
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    global.fetch = realFetch
    try {
      const users = (await prisma.user.findMany({ where: { displayName: { startsWith: 'r7gb1-' } }, select: { id: true } })).map((u) => u.id)
      const trades = await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true, intentId: true } })
      const tradeIds = trades.map((t) => t.id)
      const intentIds = trades.map((t) => t.intentId).filter(Boolean) as string[]
      const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      const disputeIds = (await prisma.dispute.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((d) => d.id)
      const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId', 'disputeId')
          AND table_name NOT IN ('trades', 'escrows', 'disputes', 'escrow_participant_keys')`
      await prisma.$transaction(async (tx) => {
        // The key commitments are immutable by trigger (#235 R7G-B2A); test-owned rows only, re-enabled in the same transaction.
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRaw`DELETE FROM escrow_participant_keys WHERE "escrowId" = ANY(${escrowIds})`
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
        // #235 R7G-F6B - signed LOCK attempts cannot be deleted; test-owned rows only, re-enabled in the same transaction.
        await tx.$executeRawUnsafe('ALTER TABLE wdk_transfer_attempts DISABLE TRIGGER wdk_transfer_attempts_signed_identity_guard')
        await tx.$executeRaw`DELETE FROM wdk_transfer_attempts WHERE "escrowId" = ANY(${escrowIds})`
        await tx.$executeRawUnsafe('ALTER TABLE wdk_transfer_attempts ENABLE TRIGGER wdk_transfer_attempts_signed_identity_guard')
      })
      for (let pass = 0; pass < 4; pass++) {
        for (const { table_name, column_name } of refs) {
          const ids = column_name === 'tradeId' ? tradeIds : column_name === 'disputeId' ? disputeIds : escrowIds
          await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, ids).catch(() => undefined)
        }
        await prisma.$executeRaw`DELETE FROM disputes WHERE id = ANY(${disputeIds})`.catch(() => undefined)
      }
      await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
      await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
      await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
      await deleteFixtureAccounts(prisma, users)
      await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" = ANY(${intentIds})`
      await prisma.$executeRaw`DELETE FROM intents WHERE id = ANY(${intentIds})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      for (const n of extraNodes) {
        await n.prisma.$disconnect().catch(() => undefined)
        await n.redis?.quit().catch(() => undefined)
      }
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  function load(wrap: (fn: () => void) => void): Node {
    let n!: Node
    const body = () => {
      n = {
        prisma: require('../../src/common/database').prisma,
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        tradeService: require('../../src/modules/open-p2p/trade.service').tradeService,
        repo: require('../../src/modules/open-p2p/trade-repository').tradeRepository,
        providers: require('../../src/modules/open-settlement/escrow-providers').getSettlementProvider,
        eventBus: require('../../src/common/events/event-bus').eventBus,
      }
    }
    wrap(body)
    if (!n) body()
    return n
  }

  /** Another node: a fresh module graph with its own PrismaClient and pool. */
  function node(): Node {
    const n = load((body) => jest.isolateModules(body))
    n.redis = (() => { let r: any; jest.isolateModules(() => { r = require('../../src/common/redis').redis }); return r })()
    extraNodes.push(n)
    return n
  }

  async function party(label: string) {
    const tag = randomBytes(5).toString('hex')
    const u = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7gb1-${label}-${tag}` } })
    return u
  }

  /** An ACTIVE trade (state fixture), optionally behind an Intent in `intentStatus`. */
  async function trade(label: string, asset = 'BTC', amount = '0.001', intentStatus?: string) {
    const seller = await party(`${label}-s`)
    const buyer = await party(`${label}-b`)
    for (const p of [buyer, seller]) await prisma.payoutAddress.create({ data: { participantId: p.id, asset: asset as any, address: PAYOUT } }).catch(() => undefined)
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: asset as any, side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000', ...boundOfferRow(acct) } })
    const intent = intentStatus
      ? await prisma.intent.create({ data: { type: 'TradeIntent', participantId: seller.id, moduleId: 'openp2p', payload: {}, status: intentStatus } })
      : null
    const t = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: asset as any, amount, priceUsd: '1', totalUsd: amount, status: 'ACTIVE', intentId: intent?.id ?? null } })
    return { t, seller, buyer, amount, asset, intent }
  }
  type Fx = Awaited<ReturnType<typeof trade>>

  /** A real escrow through createEscrow() (MULTISIG / MOCK). */
  const escrow = (n: Node, f: Fx, type: string) => n.escrowService.createEscrow({ tradeId: f.t.id, asset: f.asset, lockedAmount: f.amount, type }, f.seller.id)
  /** A state fixture escrow (WDK_USDT_EVM rows the provider would have written). */
  const fixtureEscrow = (f: Fx, type: string, status: string, extra: Record<string, unknown> = {}) =>
    prisma.escrow.create({ data: { tradeId: f.t.id, type: type as any, status: status as any, asset: f.asset as any, lockedAmount: f.amount, ...extra } })
  const attempt = (escrowId: string, status: string, operationType = 'LOCK') =>
    prisma.wdkTransferAttempt.create({ data: { escrowId, operationType: operationType as any, status: status as any, destination: '0x' + 'ab'.repeat(20), amount: '5' } })

  /** A SIGNED_RAW_V1 LOCK attempt in `status`, written past the signed-identity trigger (state fixture). */
  const signedAttempt = (escrowId: string, status: string) => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE wdk_transfer_attempts DISABLE TRIGGER wdk_transfer_attempts_signed_identity_guard')
    // Evidence the database requires for each state: finality (#235 R7G-F6B-P) for CONFIRMED/REVERTED; both
    // corroborating sources (#235 R7G-F6B-P1) for every terminal state; NONCE_CONSUMED_ELSEWHERE has no receipt.
    const nce = status === 'NONCE_CONSUMED_ELSEWHERE'
    const terminal = nce || status === 'CONFIRMED' || status === 'REVERTED'
    await tx.$executeRawUnsafe(
      `INSERT INTO wdk_transfer_attempts (id, "escrowId", "operationType", status, destination, amount, authority, "chainId", "fromAddress", "tokenContract", nonce, "signedRawTx", "txHash", "updatedAt",
         "receiptBlockNumber", "receiptBlockHash", "finalityHeadBlock", "finalityRule", "finalizedAt",
         "primarySource", "corroboratingSource", "corroboratingHeadBlock", "nonceConsumedAtBlock")
       VALUES (gen_random_uuid()::text, $1, 'LOCK', $2::"WdkTransferAttemptStatus", '0x${'ab'.repeat(20)}', 5, 'SIGNED_RAW_V1', 31337, $4, '0x${'ef'.repeat(20)}', 0, '0x02', $3, now(),
         ${nce ? 'NULL, NULL' : `10, '0x${'cd'.repeat(32)}'`}, 11, 'CONFIRMATIONS:2', now(),
         ${terminal ? `'primary', 'corroborator', 11, ${nce ? 10 : 'NULL'}` : 'NULL, NULL, NULL, NULL'})`,
      escrowId, status, '0x' + randomBytes(32).toString('hex'), '0x' + randomBytes(20).toString('hex')) // own signer: (chain, signer, nonce) is unique
    await tx.$executeRawUnsafe('ALTER TABLE wdk_transfer_attempts ENABLE TRIGGER wdk_transfer_attempts_signed_identity_guard')
  })
  const cancel = (n: Node, f: Fx, by: 'buyer' | 'seller' = 'buyer') => n.tradeService.updateStatus(f.t.id, 'CANCELLED', f[by].id)
  const keyOf = (n: Node, e: { id: string }, f: Fx, role: 'buyer' | 'seller') =>
    n.escrowService.submitParticipantKey(e.id, f[role].id, role === 'buyer' ? BUYER_PUBKEY : SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
  const tradeOf = (id: string) => prisma.trade.findUniqueOrThrow({ where: { id } })
  const escrowOf = (id: string) => prisma.escrow.findUniqueOrThrow({ where: { id } })
  const statusEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'openp2p.trade.status_changed' } })
  const keysOf = (escrowId: string) => prisma.escrowParticipantKey.count({ where: { escrowId, role: { in: ['buyer', 'seller'] } } })
  const settle = () => new Promise((r) => setTimeout(r, 300))

  function fund(sats: number) {
    const txid = randomBytes(32).toString('hex')
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 1 }) } as any
      if (u.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (u.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      return { ok: true, json: async () => [{ txid, vout: 0, value: sats, status: { confirmed: true } }] } as any
    }) as any
  }

  /** A MULTISIG escrow with both keys (address persisted), funded on the mocked chain and locked. */
  async function lockedMultisig(f: Fx) {
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    await keyOf(A, e, f, 'seller')
    fund(100_000)
    await A.escrowService.lockFunds(e.id, f.seller.id)
    await settle()
    return e
  }

  /** Runs the node's NEXT interactive transaction through a client whose model.method awaits `after()` once resolved. */
  function pauseInNextTransaction(n: Node, model: string, method: string, after: (result: unknown) => Promise<void>) {
    const original = n.prisma.$transaction.bind(n.prisma)
    return jest.spyOn(n.prisma, '$transaction').mockImplementationOnce((fn: any, ...rest: any[]) =>
      original((tx: any) => fn(new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop)
          if (prop === '$executeRaw' && model === '$executeRaw') {
            return async (...args: any[]) => { const r = await value.apply(target, args); await after(r); return r }
          }
          if (prop !== model) return typeof value === 'function' ? value.bind(target) : value
          return new Proxy(value, {
            get(delegate, m) {
              const fnv = Reflect.get(delegate, m)
              if (m !== method) return typeof fnv === 'function' ? fnv.bind(delegate) : fnv
              return async (...args: any[]) => { const r = await fnv.apply(delegate, args); await after(r); return r }
            },
          })
        },
      })), ...rest))
  }

  async function becomes(probe: () => Promise<boolean>, ms = 1500): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await probe()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return probe()
  }

  async function expectRefusedClean(f: Fx, n: Node = A) {
    const before = (await tradeOf(f.t.id)).status
    const events = await statusEvents(f.t.id)
    await expect(cancel(n, f)).rejects.toThrow(COMMITTED)
    expect((await tradeOf(f.t.id)).status).toBe(before)
    expect(await statusEvents(f.t.id)).toBe(events)
  }

  // ─── MULTISIG commitment boundary ─────────────────────────────────────────────────────────────────────

  it('MUL1: MULTISIG escrow CREATED with no address — cancellation succeeds', async () => {
    pg.requirePostgres('MUL1')
    const f = await trade('mul1')
    await escrow(A, f, 'MULTISIG')
    await cancel(A, f)
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
  })

  it('MUL2: one participant key, still no address — cancellation follows the predicate (succeeds)', async () => {
    pg.requirePostgres('MUL2')
    const f = await trade('mul2')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    expect((await escrowOf(e.id)).multisigAddr).toBeNull()
    await cancel(A, f)
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
  })

  it('MUL3/MUL4/MUL5: once the second key persists the address, cancellation is refused — observed UTXO or not, funded or not', async () => {
    pg.requirePostgres('MUL3-5')
    const f = await trade('mul3')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    await keyOf(A, e, f, 'seller')
    expect((await escrowOf(e.id)).multisigAddr).toBeTruthy()
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => [] })) as any // MUL4: no UTXO observable
    await expectRefusedClean(f)
    fund(100_000) // MUL5: funded externally, lockFunds not yet called
    await expectRefusedClean(f)
    expect((await escrowOf(e.id)).status).toBe('CREATED')
  })

  it('MUL6/MUL7: FUNDS_LOCKED and PAYMENT_PENDING refuse; refund initiation, payment claim and dispute stay open', async () => {
    pg.requirePostgres('MUL6/7')
    const f = await trade('mul6')
    const e = await lockedMultisig(f)
    expect((await escrowOf(e.id)).status).toBe('FUNDS_LOCKED')
    await expectRefusedClean(f)
    const g = await trade('mul6r')
    const eg = await lockedMultisig(g)
    await expect(A.escrowService.initiateRefund(eg.id, g.seller.id)).resolves.toBeTruthy() // MULTISIG refund path intact

    await A.escrowService.markPaymentSent(e.id, f.buyer.id)
    await settle()
    expect((await escrowOf(e.id)).status).toBe('PAYMENT_PENDING')
    await expect(cancel(A, f, 'seller')).rejects.toThrow(COMMITTED) // the buyer's fiat-sent claim cannot be hidden
    expect((await tradeOf(f.t.id)).status).toBe('ACTIVE')
    const arbiter = await party('mul7-arb')
    const { DisputeService } = require('../../src/modules/open-settlement/dispute.service')
    const { TrustedArbitratorProvider } = require('../../src/modules/open-settlement/arbitration-provider')
    await new DisputeService(new TrustedArbitratorProvider([arbiter.id])).raiseDispute(f.t.id, f.buyer.id, 'paid, seller tried to cancel')
    expect((await escrowOf(e.id)).status).toBe('DISPUTED')
  })

  it('MUL8/WDK9/J: EXPIRED is governed — cancellation refused; the recovery/refund exit is still allowed', async () => {
    pg.requirePostgres('MUL8')
    const f = await trade('mul8')
    const e = await lockedMultisig(f)
    await prisma.escrow.update({ where: { id: e.id }, data: { status: 'EXPIRED' } })
    await expectRefusedClean(f)
    await expect(A.escrowService.initiateRefund(e.id, f.seller.id)).resolves.toBeTruthy()

    const w = await trade('wdk9', 'USDT_ERC20', '5')
    await fixtureEscrow(w, 'WDK_USDT_EVM', 'EXPIRED')
    await expectRefusedClean(w)
  })

  // ─── WDK commitment boundary ──────────────────────────────────────────────────────────────────────────

  it('WDK1: WDK escrow CREATED with no transfer attempt — cancellation succeeds', async () => {
    pg.requirePostgres('WDK1')
    const f = await trade('wdk1', 'USDT_ERC20', '5')
    await fixtureEscrow(f, 'WDK_USDT_EVM', 'CREATED')
    await cancel(A, f)
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
  })

  it.each([
    ['WDK2 PREPARED (transfer() never called before SUBMISSION_UNKNOWN is durable)', 'PREPARED', true],
    ['WDK2 FAILED_BEFORE_SUBMISSION', 'FAILED_BEFORE_SUBMISSION', true],
    // #235 R7G-F6B - a legacy transfer() REVERTED was written for any receipt status !== 1 (NF2): not proof.
    ['WDK2 legacy REVERTED (old status !== 1 rule) no longer proves nothing moved', 'REVERTED', false],
    ['WDK3 SUBMISSION_UNKNOWN', 'SUBMISSION_UNKNOWN', false],
    ['WDK4 SUBMITTED', 'SUBMITTED', false],
    ['WDK5/WDK6 CONFIRMED while the escrow reads CREATED (lock reverted after the transfer)', 'CONFIRMED', false],
    // #235 R7G-F6B - signed-raw LOCK attempts: a committed signed transaction is a bearer authorization.
    ['F6B SIGNED (signed and persisted, never seen on-chain)', 'signed:SIGNED', false],
    ['F6B SUBMITTED', 'signed:SUBMITTED', false],
    ['F6B REVERTED (final receipt status 0)', 'signed:REVERTED', true],
    ['F6B NONCE_CONSUMED_ELSEWHERE (operator review)', 'signed:NONCE_CONSUMED_ELSEWHERE', false],
  ])('%s', async (_label, state, allowed) => {
    pg.requirePostgres(String(_label))
    const f = await trade('wdk-a', 'USDT_ERC20', '5')
    const e = await fixtureEscrow(f, 'WDK_USDT_EVM', 'CREATED')
    if (String(state).startsWith('signed:')) await signedAttempt(e.id, String(state).slice('signed:'.length))
    else await attempt(e.id, state as string)
    if (allowed) {
      await cancel(node(), f) // C10: any node reads the same durable attempt truth
      expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
    } else {
      await expectRefusedClean(f, node())
    }
  })

  it.each([['WDK7 FUNDS_LOCKED', 'FUNDS_LOCKED'], ['WDK8 PAYMENT_PENDING', 'PAYMENT_PENDING']])('%s refuses', async (_label, status) => {
    pg.requirePostgres(String(_label))
    const f = await trade('wdk-s', 'USDT_ERC20', '5')
    const e = await fixtureEscrow(f, 'WDK_USDT_EVM', status as string)
    await attempt(e.id, 'CONFIRMED')
    await expectRefusedClean(f)
  })

  // ─── F1: a failed cancellation leaves nothing behind ──────────────────────────────────────────────────

  it('F1: Intent COMMITTED — the cancellation is refused and Trade, Intent and events are untouched', async () => {
    pg.requirePostgres('F1')
    const f = await trade('f1', 'BTC', '0.001', 'COMMITTED')
    await expect(cancel(A, f)).rejects.toThrow(/Invalid Intent transition: COMMITTED → CANCELLED/)
    expect((await tradeOf(f.t.id)).status).toBe('ACTIVE')
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: f.intent!.id } })).status).toBe('COMMITTED')
    expect(await statusEvents(f.t.id)).toBe(0)
    expect(await prisma.intentEvent.count({ where: { intentId: f.intent!.id } })).toBe(0)
  })

  it('F1/O: a valid cancellation commits Trade + Intent + audit entry together and publishes one status_changed and one intent.cancelled', async () => {
    pg.requirePostgres('F1 ok')
    const f = await trade('f1ok', 'BTC', '0.001', 'NEGOTIATING')
    await cancel(A, f)
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: f.intent!.id } })).status).toBe('CANCELLED')
    expect(await prisma.intentEvent.count({ where: { intentId: f.intent!.id, toStatus: 'CANCELLED' } })).toBe(1)
    expect(await statusEvents(f.t.id)).toBe(1)
    expect(await prisma.durableEventRecord.count({ where: { correlationId: f.intent!.id, eventName: 'intent.cancelled' } })).toBe(1)
    await expect(cancel(A, f)).rejects.toThrow() // a retry is refused, not a second truth
    expect(await statusEvents(f.t.id)).toBe(1)
  })

  it.each([
    ['C1 after the lifecycle lock, before the commitment read', '$executeRaw', ''],
    ['C2 after the commitment read, before validation', 'escrow', 'findUnique'],
    ['C3 after the Trade write, before the Intent', 'trade', 'updateMany'],
    ['C4 between the Trade and Intent writes', 'intent', 'findUnique'],
    ['C5 after the Intent claim, before commit', 'intentEvent', 'create'],
  ])('%s — the cancellation fails with no durable effect, and the lock is released', async (_label, model, method) => {
    pg.requirePostgres(String(_label))
    const f = await trade('crash', 'BTC', '0.001', 'NEGOTIATING')
    await escrow(A, f, 'MOCK')
    const spy = pauseInNextTransaction(A, model as string, method as string, async () => { throw new Error('injected crash') })
    try {
      await expect(cancel(A, f)).rejects.toThrow('injected crash')
    } finally {
      spy.mockRestore()
    }
    expect((await tradeOf(f.t.id)).status).toBe('ACTIVE')
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: f.intent!.id } })).status).toBe('NEGOTIATING')
    expect(await statusEvents(f.t.id)).toBe(0)
    expect(await prisma.intentEvent.count({ where: { intentId: f.intent!.id } })).toBe(0)
    await cancel(node(), f) // C10: the lock is free for any node
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
  })

  // ─── key submission side door ─────────────────────────────────────────────────────────────────────────

  it('K1/K5: cancellation first — the first key is refused, on this node and on a fresh one', async () => {
    pg.requirePostgres('K1/K5')
    const f = await trade('k1')
    const e = await escrow(A, f, 'MULTISIG')
    await cancel(A, f)
    await expect(keyOf(A, e, f, 'buyer')).rejects.toThrow(/is CANCELLED: no participant key/)
    await expect(keyOf(node(), e, f, 'seller')).rejects.toThrow(/is CANCELLED: no participant key/)
    expect(await keysOf(e.id)).toBe(0)
  })

  it('K2: cancellation between the first and second key — the second key is refused and no address exists', async () => {
    pg.requirePostgres('K2')
    const f = await trade('k2')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    await cancel(A, f)
    await expect(keyOf(A, e, f, 'seller')).rejects.toThrow(/is CANCELLED/)
    expect((await escrowOf(e.id)).multisigAddr).toBeNull()
  })

  it('K3: the address exists first — the cancellation sees the funding surface and is refused', async () => {
    pg.requirePostgres('K3')
    const f = await trade('k3')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    await keyOf(A, e, f, 'seller')
    await expectRefusedClean(f)
  })

  it('K4a/R3/N: node A\'s cancellation holds the lock; node B\'s second key cannot commit meanwhile and is then refused — no address', async () => {
    pg.requirePostgres('K4a')
    const f = await trade('k4a')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    const B = node()
    let second!: Promise<string>
    let addressWhileCancelHeld = false
    const spy = pauseInNextTransaction(A, 'escrow', 'findUnique', async () => {
      second = keyOf(B, e, f, 'seller').then(() => 'ok', (err: Error) => err.message)
      addressWhileCancelHeld = await becomes(async () => !!(await escrowOf(e.id)).multisigAddr)
    })
    try { await cancel(A, f) } finally { spy.mockRestore() }
    expect(addressWhileCancelHeld).toBe(false)
    expect(await second).toMatch(/is CANCELLED/)
    expect((await escrowOf(e.id)).multisigAddr).toBeNull()
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
  })

  it('K4b/R3/N: node A\'s second key holds the lock; node B\'s cancellation cannot commit meanwhile and is then refused', async () => {
    pg.requirePostgres('K4b')
    const f = await trade('k4b')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    const B = node()
    let cancellation!: Promise<string>
    let cancelledWhileKeyHeld = false
    const spy = pauseInNextTransaction(A, 'trade', 'findUnique', async () => {
      cancellation = cancel(B, f).then(() => 'cancelled', (err: Error) => err.message)
      cancelledWhileKeyHeld = await becomes(async () => (await tradeOf(f.t.id)).status === 'CANCELLED')
    })
    try { await keyOf(A, e, f, 'seller') } finally { spy.mockRestore() }
    expect(cancelledWhileKeyHeld).toBe(false)
    expect(await cancellation).toMatch(COMMITTED)
    expect((await escrowOf(e.id)).multisigAddr).toBeTruthy()
    expect((await tradeOf(f.t.id)).status).toBe('ACTIVE')
  })

  it('K4c/R2/R3: unforced two-node races of cancel vs the second key — every outcome is legal', async () => {
    pg.requirePostgres('K4c')
    const B = node()
    const seen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      const f = await trade(`k4c${i}`)
      const e = await escrow(A, f, 'MULTISIG')
      await keyOf(A, e, f, 'buyer')
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const head = (i % 6) * 10
      const [key, cancelled] = await Promise.allSettled([
        delay(i % 2 ? head : 0).then(() => keyOf(i % 2 ? A : B, e, f, 'seller')),
        delay(i % 2 ? 0 : head).then(() => cancel(i % 2 ? B : A, f)),
      ])
      const addr = (await escrowOf(e.id)).multisigAddr
      const status = (await tradeOf(f.t.id)).status
      expect(key.status === 'fulfilled' ? !!addr && status === 'ACTIVE' && cancelled.status === 'rejected' : !addr && status === 'CANCELLED').toBe(true)
      seen.add(key.status)
    }
    expect(seen.size).toBe(2)
  })

  it('C7: a crash in key submission after the address write rolls the key and the address back', async () => {
    pg.requirePostgres('C7')
    const f = await trade('c7')
    const e = await escrow(A, f, 'MULTISIG')
    await keyOf(A, e, f, 'buyer')
    const spy = pauseInNextTransaction(A, 'escrow', 'update', async () => { throw new Error('injected crash') })
    try { await expect(keyOf(A, e, f, 'seller')).rejects.toThrow('injected crash') } finally { spy.mockRestore() }
    expect((await escrowOf(e.id)).multisigAddr).toBeNull()
    expect(await keysOf(e.id)).toBe(1)
    await cancel(node(), f) // still pre-commitment, lock free
    expect((await tradeOf(f.t.id)).status).toBe('CANCELLED')
  })

  // ─── lockFunds side door ──────────────────────────────────────────────────────────────────────────────

  it('L1/L4/L5: cancellation first — lockFunds is refused on this node and on a fresh one, and no provider is called', async () => {
    pg.requirePostgres('L1')
    const f = await trade('l1')
    const e = await escrow(A, f, 'MOCK')
    await cancel(A, f)
    const B = node()
    const spies = [jest.spyOn(A.providers('MOCK'), 'lockFunds'), jest.spyOn(B.providers('MOCK'), 'lockFunds')]
    try {
      await expect(A.escrowService.lockFunds(e.id, f.seller.id)).rejects.toThrow(/is CANCELLED: its escrow cannot be locked/)
      await expect(B.escrowService.lockFunds(e.id, f.seller.id)).rejects.toThrow(/is CANCELLED: its escrow cannot be locked/)
      expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0)
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
    expect((await escrowOf(e.id)).status).toBe('CREATED')

    const w = await trade('l1w', 'USDT_ERC20', '5')
    const ew = await fixtureEscrow(w, 'WDK_USDT_EVM', 'CREATED')
    await cancel(A, w)
    const wdk = jest.spyOn(A.providers('WDK_USDT_EVM'), 'lockFunds')
    try {
      await expect(A.escrowService.lockFunds(ew.id, w.seller.id)).rejects.toThrow(/is CANCELLED/)
      expect(wdk).not.toHaveBeenCalled()
    } finally { wdk.mockRestore() }
    expect(await prisma.wdkTransferAttempt.count({ where: { escrowId: ew.id } })).toBe(0)
  })

  it('L2: lockFunds first — the cancellation sees FUNDS_LOCKED and is refused', async () => {
    pg.requirePostgres('L2')
    const f = await trade('l2')
    const e = await escrow(A, f, 'MOCK')
    await A.escrowService.lockFunds(e.id, f.seller.id)
    await expectRefusedClean(f, node())
  })

  it('L3a/R4/N: node A\'s cancellation holds the lock; node B\'s lockFunds waits, is refused, and its provider is never called', async () => {
    pg.requirePostgres('L3a')
    const f = await trade('l3a')
    const e = await escrow(A, f, 'MOCK')
    const B = node()
    const spyB = jest.spyOn(B.providers('MOCK'), 'lockFunds')
    let lock!: Promise<string>
    let lockedWhileCancelHeld = false
    const spy = pauseInNextTransaction(A, 'escrow', 'findUnique', async () => {
      lock = B.escrowService.lockFunds(e.id, f.seller.id).then(() => 'locked', (err: Error) => err.message)
      lockedWhileCancelHeld = await becomes(async () => (await escrowOf(e.id)).status !== 'CREATED')
    })
    try { await cancel(A, f) } finally { spy.mockRestore() }
    expect(lockedWhileCancelHeld).toBe(false)
    expect(await lock).toMatch(/is CANCELLED/)
    expect(spyB).not.toHaveBeenCalled()
    spyB.mockRestore()
    expect((await escrowOf(e.id)).status).toBe('CREATED')
  })

  it('L3b/R7/N: node A\'s lockFunds holds the lock; node B\'s cancellation waits and is then refused (FUNDS_LOCKED)', async () => {
    pg.requirePostgres('L3b')
    const f = await trade('l3b')
    const e = await escrow(A, f, 'MOCK')
    const B = node()
    let cancellation!: Promise<string>
    let cancelledWhileLockHeld = false
    const spy = pauseInNextTransaction(A, 'trade', 'findUnique', async () => {
      cancellation = cancel(B, f).then(() => 'cancelled', (err: Error) => err.message)
      cancelledWhileLockHeld = await becomes(async () => (await tradeOf(f.t.id)).status === 'CANCELLED')
    })
    try { await A.escrowService.lockFunds(e.id, f.seller.id) } finally { spy.mockRestore() }
    expect(cancelledWhileLockHeld).toBe(false)
    expect(await cancellation).toMatch(COMMITTED)
    expect((await escrowOf(e.id)).status).toBe('FUNDS_LOCKED')
  })

  it('C9/R5/R6: a lock that failed after its WDK transfer was submitted leaves CREATED + SUBMISSION_UNKNOWN — refused on every node', async () => {
    pg.requirePostgres('C9')
    const f = await trade('c9', 'USDT_ERC20', '5')
    const e = await fixtureEscrow(f, 'WDK_USDT_EVM', 'CREATED')
    await attempt(e.id, 'SUBMISSION_UNKNOWN')
    await expectRefusedClean(f, A)
    await expectRefusedClean(f, node())
  })

  // ─── economic exits stay open; races against them ─────────────────────────────────────────────────────

  it('K/R8-R12: with funds locked, cancellation is refused in every order against payment claim, dispute, refund, release and projection — and each exit still works', async () => {
    pg.requirePostgres('R8-R12')
    const B = node()
    const arbiter = await party('rx-arb')
    const { DisputeService } = require('../../src/modules/open-settlement/dispute.service')
    const { TrustedArbitratorProvider } = require('../../src/modules/open-settlement/arbitration-provider')
    const disputes = new DisputeService(new TrustedArbitratorProvider([arbiter.id]))
    const ops: Array<[string, (f: Fx, e: any) => Promise<unknown>, string]> = [
      ['R8 markPaymentSent', (f, e) => A.escrowService.markPaymentSent(e.id, f.buyer.id), 'PAYMENT_PENDING'],
      ['R9 dispute', (f) => disputes.raiseDispute(f.t.id, f.buyer.id, 'race'), 'DISPUTED'],
      ['R10 refund', (f, e) => A.escrowService.refundFunds(e.id, f.seller.id), 'REFUNDED'],
      ['R12 projection', (f, e) => A.repo.projectEscrowStatus(f.t.id, e.id), 'FUNDS_LOCKED'],
    ]
    for (const [label, op, escrowAfter] of ops) {
      const f = await trade(`rx-${label.split(' ')[0]}`)
      const e = await escrow(A, f, 'MOCK')
      await A.escrowService.lockFunds(e.id, f.seller.id)
      await settle()
      const [cancelled, done] = await Promise.allSettled([cancel(B, f), op(f, e)])
      expect([label, cancelled.status]).toEqual([label, 'rejected'])
      expect([label, done.status]).toEqual([label, 'fulfilled'])
      await settle()
      expect([label, (await escrowOf(e.id)).status]).toEqual([label, escrowAfter])
    }
    // R11: release / completion after a refused cancellation.
    const f = await trade('rx-R11')
    const e = await escrow(A, f, 'MOCK')
    await A.escrowService.lockFunds(e.id, f.seller.id)
    await A.escrowService.markPaymentSent(e.id, f.buyer.id)
    const [cancelled, released] = await Promise.allSettled([cancel(B, f, 'seller'), A.escrowService.releaseFunds(e.id, undefined, f.seller.id)])
    expect([cancelled.status, released.status]).toEqual(['rejected', 'fulfilled'])
    await settle()
    expect((await escrowOf(e.id)).status).toBe('COMPLETED')
    expect((await tradeOf(f.t.id)).status).toBe('COMPLETED')
  })

  it('R1: the R7G-A gate — a cancelled trade still takes no new escrow', async () => {
    pg.requirePostgres('R1')
    const f = await trade('r1')
    await cancel(A, f)
    await expect(escrow(node(), f, 'MOCK')).rejects.toThrow(/is CANCELLED: no new escrow/)
  })
})
