// tests/broadcastAuthorization.test.ts
//
// CTO 90 item 7 / GK VERIFY #629 mutants Q2-Q6: each structural refusal of the broadcast-point authorization is
// asserted by its own reason (and by what it does NOT read afterwards), so a mutant that drops one check can no longer
// hide behind a later, redundant refusal. The database and the two read-only authorization checks are stubs here; the
// real-PostgreSQL proof is tests/integration/capabilityAuthorityEnforced.test.ts.
import * as bitcoin from 'bitcoinjs-lib'

const mockEscrowFindUnique = jest.fn()
const mockPendingFindUnique = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: { findUnique: (a: unknown) => mockEscrowFindUnique(a) },
    escrowPendingTransaction: { findUnique: (a: unknown) => mockPendingFindUnique(a) },
  },
}))
const mockAdr004 = jest.fn(async (_p: unknown) => {})
const mockAdr005 = jest.fn(async (_p: unknown) => {})
jest.mock('../src/modules/open-settlement/capability-execution-authorization', () => ({ assertDurableExecutionAuthorization: (p: unknown) => mockAdr004(p) }))
jest.mock('../src/modules/open-settlement/economic-disposition-authority', () => ({ assertDurableEconomicDispositionAuthorization: (p: unknown) => mockAdr005(p) }))

import { assertBroadcastAuthorized } from '../src/modules/open-settlement/broadcast-authorization'
import { BroadcastNotAuthorized } from '../src/modules/open-settlement/broadcast-outcome'

const FUNDING = 'ab'.repeat(32)
const OUT = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7) }).output!
function psbtOf(inputs: Array<[string, number]>, value = 90_000n) {
  const p = new bitcoin.Psbt()
  for (const [txid, vout] of inputs) p.addInput({ hash: txid, index: vout, witnessUtxo: { script: OUT, value: 100_000n } })
  p.addOutput({ script: OUT, value })
  return p
}
const txOf = (p: bitcoin.Psbt) => bitcoin.Transaction.fromBuffer(p.data.globalMap.unsignedTx.toBuffer())
const pendingRow = (p: bitcoin.Psbt) => ({ id: 'round-1', escrowId: 'escrow-1', unsignedPsbtBase64: p.toBase64() })
const refusal = (p: Promise<void>) => p.then(() => 'authorized', (e: any) => (e instanceof BroadcastNotAuthorized ? `refused: ${e.message}` : `OTHER ${e?.constructor?.name}: ${e?.message}`))

beforeEach(() => {
  jest.clearAllMocks()
  mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', type: 'MULTISIG' })
})

it('Q2: a transaction with 2 inputs is refused for that reason, before any lookup', async () => {
  const r = await refusal(assertBroadcastAuthorized(txOf(psbtOf([[FUNDING, 0], ['cd'.repeat(32), 1]]))))
  expect(r).toMatch(/^refused: .*spends 2 inputs/)
  expect(mockEscrowFindUnique).not.toHaveBeenCalled()
})

it('Q3: the escrow is looked up by the exact funding outpoint (txid AND vout) through the unique key', async () => {
  const round = psbtOf([[FUNDING, 3]])
  mockPendingFindUnique.mockResolvedValue(pendingRow(round))
  expect(await refusal(assertBroadcastAuthorized(txOf(round)))).toBe('authorized')
  expect(mockEscrowFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { txLockId_txLockVout: { txLockId: FUNDING, txLockVout: 3 } } }))
})

it('Q4: a funding outpoint recorded by a non-MULTISIG escrow is refused for that reason, before the round is read', async () => {
  mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', type: 'LIGHTNING' })
  const r = await refusal(assertBroadcastAuthorized(txOf(psbtOf([[FUNDING, 0]]))))
  expect(r).toMatch(/^refused: .*is not the recorded funding of a MULTISIG escrow/)
  expect(mockPendingFindUnique).not.toHaveBeenCalled()
})

it('an outpoint no escrow records is refused (B3: one escrow at most, @@unique([txLockId, txLockVout]))', async () => {
  mockEscrowFindUnique.mockResolvedValue(null)
  expect(await refusal(assertBroadcastAuthorized(txOf(psbtOf([[FUNDING, 0]]))))).toMatch(/^refused: .*is not the recorded funding of a MULTISIG escrow/)
})

it('Q6: an escrow with no persisted round is refused for that reason (typed, not a crash)', async () => {
  mockPendingFindUnique.mockResolvedValue(null)
  expect(await refusal(assertBroadcastAuthorized(txOf(psbtOf([[FUNDING, 0]]))))).toMatch(/^refused: .*has no persisted round/)
  expect(mockAdr004).not.toHaveBeenCalled()
})

it('a transaction that is not the persisted round (same funding, other outputs) is refused before either authorization is read', async () => {
  mockPendingFindUnique.mockResolvedValue(pendingRow(psbtOf([[FUNDING, 0]], 90_000n)))
  const r = await refusal(assertBroadcastAuthorized(txOf(psbtOf([[FUNDING, 0]], 89_999n))))
  expect(r).toMatch(/^refused: .*persisted round round-1 is transaction [0-9a-f]{64}, not this one/)
  expect(mockAdr004).not.toHaveBeenCalled(); expect(mockAdr005).not.toHaveBeenCalled()
})

it('ADR-004 and ADR-005 are both consulted with the persisted round, and either refusal is a typed BroadcastNotAuthorized', async () => {
  const round = psbtOf([[FUNDING, 0]])
  mockPendingFindUnique.mockResolvedValue(pendingRow(round))
  expect(await refusal(assertBroadcastAuthorized(txOf(round)))).toBe('authorized')
  expect(mockAdr004).toHaveBeenCalledWith(expect.objectContaining({ id: 'round-1' }))
  expect(mockAdr005).toHaveBeenCalledWith(expect.objectContaining({ id: 'round-1' }))
  mockAdr004.mockRejectedValueOnce(new Error('no durable ADR-004 authorization'))
  expect(await refusal(assertBroadcastAuthorized(txOf(round)))).toMatch(/^refused: .*ADR-004: no durable ADR-004 authorization/)
  mockAdr005.mockRejectedValueOnce(new Error('dispute not RESOLVED'))
  expect(await refusal(assertBroadcastAuthorized(txOf(round)))).toMatch(/^refused: .*ADR-005: dispute not RESOLVED/)
})
