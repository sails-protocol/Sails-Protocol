/**
 * Bounded Remediation (WDK Fund-Moving Safety, 2026-09-08) — adversarial
 * evidence for wdk-execution-truth.ts + WdkSettlementProvider's new
 * durable operation truth, closing the DEMONSTRATED gaps
 * docs/WDK_UNKNOWN_OUTCOME_RETRY_SAFETY.md (#56) and
 * docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md (#58) found.
 *
 * Unlike tests/wdkLockFundsRetrySafety.test.ts / tests/wdkFundMovingOperationsSafety.test.ts
 * (which mock wdkSettlementProvider ENTIRELY to test escrow.service.ts's
 * own orchestration), this file exercises the REAL WdkSettlementProvider
 * and the REAL wdk-execution-truth.ts/wdk-transfer-attempt-repository.ts
 * — the actual new safety mechanism — against a fake WDK account object
 * and a mocked database. This is where the property is actually enforced
 * now, so this is where it must be demonstrated.
 *
 * As always: external side effects (transfer()/getTransactionReceipt())
 * are SIMULATED via a fake account object — no real network call is made
 * anywhere in this file.
 */
export {} // see chatUnification.test.ts's identical comment

jest.mock('../src/config', () => ({
  config: {
    wdk: {
      seedPhrase: 'test-seed', rpcUrl: 'http://localhost', usdtContract: '0xtoken',
      // Small, fast bounds — these tests never need to observe a real
      // multi-second wait; they control exactly what getTransactionReceipt
      // returns on each poll.
      receiptPollAttempts: 2,
      receiptPollIntervalMs: 0,
    },
  },
}))

const mockGetAddress = jest.fn()
const mockTransfer = jest.fn()
const mockGetTransactionReceipt = jest.fn()
const fakeAccount = {
  getAddress: (...args: unknown[]) => mockGetAddress(...args),
  transfer: (...args: unknown[]) => mockTransfer(...args),
  getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
}

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount() { return fakeAccount }
    async getAccountByPath() { return fakeAccount }
  },
}))

const mockAttemptFindFirst = jest.fn()
// D7 - ensureAttempt()'s per-escrow guard (findPotentiallySent(), the only findFirst filtering by status) has its own
// mock: these single-operation scenarios have no other operation's attempt, and the queued findLatest() answers
// above must not be consumed by it.
const mockPotentiallySentFindFirst = jest.fn().mockResolvedValue(null)
const mockAttemptCreate = jest.fn()
const mockAttemptUpdate = jest.fn()
const mockAttemptUpdateMany = jest.fn()
const mockAttemptFindUnique = jest.fn()
const mockTransaction = jest.fn()

jest.mock('../src/common/database', () => ({
  prisma: {
    wdkTransferAttempt: {
      findFirst: (args: { where?: { status?: unknown } }) => (args?.where?.status ? mockPotentiallySentFindFirst(args) : mockAttemptFindFirst(args)),
      create: (...args: unknown[]) => mockAttemptCreate(...args),
      update: (...args: unknown[]) => mockAttemptUpdate(...args),
      updateMany: (...args: unknown[]) => mockAttemptUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockAttemptFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

import { WdkSettlementProvider } from '../src/modules/open-settlement/wdk-settlement.provider'

const provider = new WdkSettlementProvider()
const escrow = { id: 'escrow-1', tradeId: 'trade-1', lockedAmount: '5' }

// A minimal, growable in-memory row shape mirroring what the real
// PrismaWdkTransferAttemptRepository would return — `amount` is a plain
// string here (strings already have .toString()), standing in for
// Prisma's real Decimal wrapper, which the code under test also only
// ever calls .toString() on.
function row(overrides: Partial<{ id: string; status: string; destination: string; amount: string; txHash: string | null }>) {
  return {
    id: 'attempt-1', escrowId: 'escrow-1', operationType: 'LOCK', status: 'PREPARED',
    destination: '0xdest', amount: '5.00000000', txHash: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAddress.mockResolvedValue('0xEscrowAddr')
  mockAttemptCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => row({ id: 'attempt-new', status: 'PREPARED', ...args.data } as any))
  mockAttemptUpdate.mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => row({ id: args.where.id, ...args.data } as any))
  mockAttemptUpdateMany.mockResolvedValue({ count: 1 })
  mockAttemptFindUnique.mockImplementation(async (args: { where: { id: string } }) => row({ id: args.where.id }))
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      wdkTransferAttempt: {
        updateMany: mockAttemptUpdateMany,
        create: mockAttemptCreate,
      },
    })
  )
})

describe('lockFunds() — durable operation truth', () => {
  it('unknown outcome (provider throws with no hash) blocks blind retry — provider is never invoked a second time', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(null) // no prior attempt
    mockTransfer.mockRejectedValueOnce(new Error('simulated: response lost after submission'))

    await expect(provider.lockFunds(escrow)).rejects.toThrow('simulated: response lost after submission')
    expect(mockAttemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUBMISSION_UNKNOWN' } }))

    // Retry: the durable row is now SUBMISSION_UNKNOWN.
    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-1', status: 'SUBMISSION_UNKNOWN', destination: '0xEscrowAddr', amount: '5.00000000' }))

    await expect(provider.lockFunds(escrow)).rejects.toThrow(/outcome is UNKNOWN/)
    // Dispositive: transfer() was invoked exactly once, ever.
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })

  it('a receipt confirming REVERTED is not economic success, and the txId is never returned — but a fresh retry is genuinely safe afterward', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(null)
    mockTransfer.mockResolvedValueOnce({ hash: '0xSIMULATED_TX', fee: 1n })
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 0 })

    await expect(provider.lockFunds(escrow)).rejects.toThrow(/reverted on-chain/)
    expect(mockAttemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REVERTED' } }))

    // A definitively reverted transfer proves no funds moved — a fresh
    // retry for the same logical operation is genuinely safe, unlike the
    // SUBMISSION_UNKNOWN case above.
    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-1', status: 'REVERTED', destination: '0xEscrowAddr', amount: '5.00000000', txHash: '0xSIMULATED_TX' }))
    mockTransfer.mockResolvedValueOnce({ hash: '0xSIMULATED_TX_2', fee: 1n })
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 })

    const retried = await provider.lockFunds(escrow)
    expect(retried.txId).toBe('0xSIMULATED_TX_2')
    expect(mockTransfer).toHaveBeenCalledTimes(2)
  })

  it('a receipt confirming CONFIRMED (status 1) is the only path to a returned txId', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(null)
    mockTransfer.mockResolvedValueOnce({ hash: '0xSIMULATED_TX', fee: 1n })
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 })

    const result = await provider.lockFunds(escrow)
    expect(result.txId).toBe('0xSIMULATED_TX')
    expect(mockAttemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CONFIRMED' } }))
  })

  it('a receipt that never appears within the bounded wait stays PENDING — not declared success', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(null)
    mockTransfer.mockResolvedValueOnce({ hash: '0xSIMULATED_TX', fee: 1n })
    mockGetTransactionReceipt.mockResolvedValue(null) // never mined within the (small, test-bounded) poll window

    await expect(provider.lockFunds(escrow)).rejects.toThrow(/not yet confirmed/)
    // Still SUBMITTED — no update call ever moved it to CONFIRMED or REVERTED.
    expect(mockAttemptUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CONFIRMED' } }))
    expect(mockAttemptUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REVERTED' } }))
  })

  it('a completed (CONFIRMED) operation is idempotently protected — resumed without ever calling transfer() again', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-1', status: 'CONFIRMED', destination: '0xEscrowAddr', amount: '5.00000000', txHash: '0xALREADY_CONFIRMED' }))

    const result = await provider.lockFunds(escrow)
    expect(result.txId).toBe('0xALREADY_CONFIRMED')
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('a stale PREPARED row (process crashed before the pre-submission commit was ever written) is durably reused, not duplicated — crash/restart survives on persisted state alone', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-stale', status: 'PREPARED', destination: '0xEscrowAddr', amount: '5.00000000' }))
    mockTransfer.mockResolvedValueOnce({ hash: '0xSIMULATED_TX', fee: 1n })
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 })

    await provider.lockFunds(escrow)

    // No new attempt row was created — the existing PREPARED row (the
    // only durable evidence of the pre-crash intent) was reused. Nothing
    // about this test relied on in-process memory: the mocked "prior
    // process's" row is the only thing that made this call proceed
    // correctly.
    expect(mockAttemptCreate).not.toHaveBeenCalled()
    expect(mockAttemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'attempt-stale' }), data: expect.objectContaining({ status: 'SUBMITTED' }) }))
  })

  // ─── CTO Gate Correction (2026-09-08) — closing the PREPARED ->
  // transfer() -> SUBMITTED crash window ────────────────────────────────
  it('a durable pre-submission-boundary commit (SUBMISSION_UNKNOWN, written BEFORE transfer() is ever called) blocks a retry even when no first call in THIS test ever threw — simulating a crash mid-transfer() on a prior process', async () => {
    // No "first call that threw" happens in this test at all — the row
    // simply already exists at SUBMISSION_UNKNOWN, exactly as it would if
    // a PRIOR process had reached the pre-commit and then crashed before
    // transfer() ever resolved or rejected (a hash may or may not have
    // actually been broadcast — Sails cannot tell, which is the whole
    // point). The retry after that simulated crash/restart must never
    // reach transfer() at all.
    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-crashed', status: 'SUBMISSION_UNKNOWN', destination: '0xEscrowAddr', amount: '5.00000000' }))

    await expect(provider.lockFunds(escrow)).rejects.toThrow(/outcome is UNKNOWN/)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('transfer() returns a real hash, but persisting SUBMITTED itself fails — a subsequent retry still blocks, transfer() is never called again', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(null) // fresh attempt
    mockTransfer.mockResolvedValueOnce({ hash: '0xSIMULATED_TX_LOST_ON_WRITE', fee: 1n })
    // First update() call is the pre-submission commit (SUBMISSION_UNKNOWN)
    // — succeeds normally. Second update() call is the SUBMITTED write
    // with the real hash — simulates a DB failure recording it (e.g. a
    // dropped Postgres connection right after the transfer succeeded).
    mockAttemptUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // PREPARED -> SUBMISSION_UNKNOWN
      .mockRejectedValueOnce(new Error('simulated: DB write failure recording SUBMITTED'))

    await expect(provider.lockFunds(escrow)).rejects.toThrow('simulated: DB write failure recording SUBMITTED')
    // transfer() genuinely ran and returned a real hash — but it was
    // never durably recorded. The row's last SUCCESSFUL write is still
    // the pre-commit's SUBMISSION_UNKNOWN.
    expect(mockTransfer).toHaveBeenCalledTimes(1)

    // Retry: the row is found exactly where the failed write left it —
    // SUBMISSION_UNKNOWN, with no txHash ever durably recorded, even
    // though transfer() itself genuinely succeeded once already.
    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-new', status: 'SUBMISSION_UNKNOWN', destination: '0xEscrowAddr', amount: '5.00000000', txHash: null }))

    await expect(provider.lockFunds(escrow)).rejects.toThrow(/outcome is UNKNOWN/)
    // Dispositive: transfer() was invoked exactly once, ever, across both
    // calls — the DB write failure did not cause a second real transfer.
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })
})


describe('SUBMITTED reconciliation — idempotent execution truth', () => {
  it('reconciles a persisted SUBMITTED receipt to CONFIRMED without broadcasting again', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(row({
      id: 'attempt-submitted',
      status: 'SUBMITTED',
      destination: '0xEscrowAddr',
      amount: '5.00000000',
      txHash: '0xPERSISTED_TX',
    }))
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 })

    const result = await provider.lockFunds(escrow)

    expect(result.txId).toBe('0xPERSISTED_TX')
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(mockAttemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'attempt-submitted', status: { in: ['SUBMITTED'] } }),
      data: { status: 'CONFIRMED' },
    }))
  })

  it('a stale concurrent reconciler cannot turn an already CONFIRMED generation into a new submission', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(row({
      id: 'attempt-submitted',
      status: 'SUBMITTED',
      destination: '0xEscrowAddr',
      amount: '5.00000000',
      txHash: '0xPERSISTED_TX',
    }))
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 })
    mockAttemptUpdateMany.mockResolvedValueOnce({ count: 0 })
    mockAttemptFindUnique.mockResolvedValueOnce(row({
      id: 'attempt-submitted',
      status: 'CONFIRMED',
      destination: '0xEscrowAddr',
      amount: '5.00000000',
      txHash: '0xPERSISTED_TX',
    }))

    await expect(provider.lockFunds(escrow)).rejects.toThrow(/transition ownership lost/)
    expect(mockTransfer).not.toHaveBeenCalled()
  })
})

describe('releaseFunds() — same mechanism, same property', () => {
  it('unknown outcome blocks blind retry', async () => {
    mockAttemptFindFirst.mockResolvedValueOnce(null)
    mockTransfer.mockRejectedValueOnce(new Error('simulated: response lost after submission'))

    await expect(provider.releaseFunds(escrow, '0xbuyer')).rejects.toThrow('simulated: response lost after submission')

    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-1', status: 'SUBMISSION_UNKNOWN', destination: '0xbuyer', amount: '5.00000000' }))
    await expect(provider.releaseFunds(escrow, '0xbuyer')).rejects.toThrow(/outcome is UNKNOWN/)
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })
})

describe('refundFunds() — same mechanism, same property', () => {
  it('unknown outcome blocks blind retry', async () => {
    mockGetAddress.mockResolvedValue('0xTreasuryAddr')
    mockAttemptFindFirst.mockResolvedValueOnce(null)
    mockTransfer.mockRejectedValueOnce(new Error('simulated: response lost after submission'))

    await expect(provider.refundFunds(escrow)).rejects.toThrow('simulated: response lost after submission')

    mockAttemptFindFirst.mockResolvedValueOnce(row({ id: 'attempt-1', status: 'SUBMISSION_UNKNOWN', destination: '0xTreasuryAddr', amount: '5.00000000' }))
    await expect(provider.refundFunds(escrow)).rejects.toThrow(/outcome is UNKNOWN/)
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })
})

describe('splitFunds() — Property D, safe multi-leg resume', () => {
  it('leg 1 confirmed + leg 2 failure -> leg 1 is never replayed on retry', async () => {
    // First splitFunds() call: leg 1 (buyer) succeeds and confirms; leg 2
    // (seller) throws with no hash.
    mockAttemptFindFirst
      .mockResolvedValueOnce(null) // buyer leg: no prior attempt
      .mockResolvedValueOnce(null) // seller leg: no prior attempt
    mockTransfer
      .mockResolvedValueOnce({ hash: '0xBUYER_TX', fee: 1n }) // buyer leg transfer
      .mockRejectedValueOnce(new Error('simulated: seller leg response lost after submission')) // seller leg transfer
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 }) // buyer leg receipt: confirmed

    await expect(provider.splitFunds(escrow, '0xbuyer', '0xseller', 6000)).rejects.toThrow(
      'simulated: seller leg response lost after submission'
    )
    expect(mockTransfer).toHaveBeenCalledTimes(2) // buyer attempted once, seller attempted once (and failed)

    // Retry: buyer leg is now CONFIRMED (durable), seller leg is SUBMISSION_UNKNOWN.
    mockAttemptFindFirst
      .mockResolvedValueOnce(row({ id: 'buyer-attempt', status: 'CONFIRMED', destination: '0xbuyer', amount: '3.00000000', txHash: '0xBUYER_TX' }))
      .mockResolvedValueOnce(row({ id: 'seller-attempt', status: 'SUBMISSION_UNKNOWN', destination: '0xseller', amount: '2.00000000' }))

    await expect(provider.splitFunds(escrow, '0xbuyer', '0xseller', 6000)).rejects.toThrow(/outcome is UNKNOWN/)

    // Dispositive: transfer() was called exactly twice total across BOTH
    // splitFunds() calls (the original buyer success + the original
    // seller failure) — the retry added ZERO new transfer() calls. The
    // buyer leg specifically was never replayed.
    expect(mockTransfer).toHaveBeenCalledTimes(2)
  })

  it('leg 2 unknown -> no whole-operation replay on a further retry (neither leg calls transfer() again)', async () => {
    // Picks up exactly where the previous scenario's retry left off:
    // buyer CONFIRMED, seller SUBMISSION_UNKNOWN. One more retry attempt.
    mockAttemptFindFirst
      .mockResolvedValueOnce(row({ id: 'buyer-attempt', status: 'CONFIRMED', destination: '0xbuyer', amount: '3.00000000', txHash: '0xBUYER_TX' }))
      .mockResolvedValueOnce(row({ id: 'seller-attempt', status: 'SUBMISSION_UNKNOWN', destination: '0xseller', amount: '2.00000000' }))

    await expect(provider.splitFunds(escrow, '0xbuyer', '0xseller', 6000)).rejects.toThrow(/outcome is UNKNOWN/)

    // Neither leg's transfer() fired on this call at all — the whole
    // operation was not blindly replayed.
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('buyer leg confirmed + a prior seller leg REVERTED -> seller retries safely, buyer is never touched again', async () => {
    mockAttemptFindFirst
      .mockResolvedValueOnce(row({ id: 'buyer-attempt', status: 'CONFIRMED', destination: '0xbuyer', amount: '3.00000000', txHash: '0xBUYER_TX' }))
      .mockResolvedValueOnce(row({ id: 'seller-attempt-1', status: 'REVERTED', destination: '0xseller', amount: '2.00000000', txHash: '0xSELLER_REVERTED_TX' }))
    mockTransfer.mockResolvedValueOnce({ hash: '0xSELLER_TX_2', fee: 1n }) // only the seller leg's fresh attempt
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 1 })

    const result = await provider.splitFunds(escrow, '0xbuyer', '0xseller', 6000)
    expect(result.txIds).toEqual(['0xBUYER_TX', '0xSELLER_TX_2'])
    // The buyer leg's transfer() was never called this round — only the
    // seller leg's fresh attempt was.
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })
})
