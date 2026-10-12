/**
 * settlement-recovery-schedule.ts — the production tick that runs settlement crash recovery and M9-R/C4
 * dispatch recovery (started by app.ts's startServer()). Scheduling behaviour only: both reconcilers are
 * mocked here, and fake timers drive the interval deterministically. Economic correctness of what a tick
 * does is proven against real PostgreSQL in tests/integration/m9rDispatchRecovery.test.ts (the WIRING
 * tests run this exact schedule on real timers); tests/startServerRecoveryWiring.test.ts proves the real
 * boot path starts and stops it.
 */
const mockReconcilePendingSettlements = jest.fn()
const mockReconcileMissingDispatch = jest.fn()

jest.mock('../src/modules/open-settlement/escrow-settlement-reconciliation.service', () => ({
  reconcilePendingSettlements: (...args: unknown[]) => mockReconcilePendingSettlements(...args),
}))
jest.mock('../src/modules/open-settlement/dispute-dispatch-recovery', () => ({
  reconcileMissingDispatch: (...args: unknown[]) => mockReconcileMissingDispatch(...args),
}))
// #235 R7G F8A — the tick's third step (residual recoveries); its economics are proven in
// tests/integration/multisigResidualRecovery.test.ts.
jest.mock('../src/modules/open-settlement/multisig-residual-recovery', () => ({
  reconcileResidualRecoveries: jest.fn().mockResolvedValue({ confirmed: [], submitted: [], pending: [], review: [], failed: [] }),
}))

import { startSettlementRecoverySchedule, runSettlementRecoveryTick } from '../src/modules/open-settlement/settlement-recovery-schedule'

const INTERVAL = 60_000

function emptySettlementReport() {
  return { recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [] }
}
function emptyDispatchReport() {
  return { claimed: [], resumed: [], alreadyResumedConcurrently: [], notEligible: [], guardFailed: [], failed: [] }
}
function makeLog() {
  return { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } as any
}
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('settlement recovery schedule (M9-R/C4 production wiring)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockReconcilePendingSettlements.mockReset().mockResolvedValue(emptySettlementReport())
    mockReconcileMissingDispatch.mockReset().mockResolvedValue(emptyDispatchReport())
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('each tick runs settlement reconciliation, then ONE bounded C4 recovery call with the canonical default batch', async () => {
    const schedule = startSettlementRecoverySchedule(makeLog(), INTERVAL)
    try {
      expect(mockReconcileMissingDispatch).not.toHaveBeenCalled() // nothing before the first interval
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(mockReconcilePendingSettlements).toHaveBeenCalledTimes(1)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(1)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledWith() // no limit override: DISPATCH_RECOVERY_BATCH applies
      expect(mockReconcilePendingSettlements.mock.invocationCallOrder[0]).toBeLessThan(mockReconcileMissingDispatch.mock.invocationCallOrder[0])
    } finally {
      schedule.stop()
    }
  })

  it('repeated ticks each make exactly one call per reconciler - no catch-up loop, however large the backlog', async () => {
    mockReconcileMissingDispatch.mockResolvedValue({ ...emptyDispatchReport(), claimed: Array(10).fill('e'), failed: Array(10).fill({ escrowId: 'e', error: 'x' }) })
    const schedule = startSettlementRecoverySchedule(makeLog(), INTERVAL)
    try {
      await jest.advanceTimersByTimeAsync(INTERVAL * 5)
      expect(mockReconcilePendingSettlements).toHaveBeenCalledTimes(5)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(5)
    } finally {
      schedule.stop()
    }
  })

  it('a slow tick (e.g. an explorer outage) never overlaps: at most one invocation in flight, and the next tick starts only after it finishes', async () => {
    const slow = deferred<ReturnType<typeof emptyDispatchReport>>()
    mockReconcileMissingDispatch.mockReturnValueOnce(slow.promise)
    const schedule = startSettlementRecoverySchedule(makeLog(), INTERVAL)
    try {
      await jest.advanceTimersByTimeAsync(INTERVAL) // tick 1 starts and blocks
      await jest.advanceTimersByTimeAsync(INTERVAL * 10) // ten more intervals elapse while it is stuck
      expect(mockReconcilePendingSettlements).toHaveBeenCalledTimes(1)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(1)

      slow.resolve(emptyDispatchReport())
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(2) // resumed on the next interval, not a burst of 10
    } finally {
      schedule.stop()
    }
  })

  it('a failing settlement pass is logged and contained, and C4 recovery still runs in the same tick', async () => {
    mockReconcilePendingSettlements.mockRejectedValue(new Error('db unavailable'))
    const log = makeLog()
    const schedule = startSettlementRecoverySchedule(log, INTERVAL)
    try {
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(1)
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Settlement reconciliation failed', err: 'db unavailable' }))
    } finally {
      schedule.stop()
    }
  })

  it('a failing C4 pass is logged, never thrown, and the schedule keeps running', async () => {
    mockReconcileMissingDispatch.mockRejectedValueOnce(new Error('claim query failed'))
    const log = makeLog()
    const schedule = startSettlementRecoverySchedule(log, INTERVAL)
    try {
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: 'C4 dispatch recovery failed', err: 'claim query failed' }))
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(2)
    } finally {
      schedule.stop()
    }
    // runSettlementRecoveryTick itself never rejects, whatever the reconcilers do.
    mockReconcilePendingSettlements.mockRejectedValueOnce(new Error('a'))
    mockReconcileMissingDispatch.mockRejectedValueOnce(new Error('b'))
    await expect(runSettlementRecoveryTick(makeLog())).resolves.toBeUndefined()
  })

  it('C4 findings (resumed / failed / guard failures / not eligible) are observable as one structured warning; a quiet pass logs nothing', async () => {
    const log = makeLog()
    await runSettlementRecoveryTick(log)
    expect(log.warn).not.toHaveBeenCalledWith(expect.objectContaining({ module: 'dispute-dispatch-recovery' }))

    mockReconcileMissingDispatch.mockResolvedValueOnce({
      ...emptyDispatchReport(), claimed: ['a', 'b', 'c'],
      resumed: [{ escrowId: 'a', disputeId: 'd', ruling: 'RELEASE' }], failed: [{ escrowId: 'b', error: 'explorer unreachable' }], notEligible: [{ escrowId: 'c', reason: 'r' }],
    })
    await runSettlementRecoveryTick(log)
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'C4 dispatch recovery completed with findings', module: 'dispute-dispatch-recovery',
      claimed: 3, resumed: 1, failed: 1, notEligible: 1, guardFailed: 0, alreadyResumedConcurrently: 0,
    }))
  })

  it('stop() ends scheduling and drains: it resolves only once the tick already running has finished, and no tick fires afterwards', async () => {
    const slow = deferred<ReturnType<typeof emptyDispatchReport>>()
    mockReconcileMissingDispatch.mockReturnValueOnce(slow.promise)
    const schedule = startSettlementRecoverySchedule(makeLog(), INTERVAL)
    await jest.advanceTimersByTimeAsync(INTERVAL)
    expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(1)

    let drained = false
    const stopping = schedule.stop().then(() => { drained = true })
    await jest.advanceTimersByTimeAsync(INTERVAL * 10)
    expect(drained).toBe(false) // the in-flight tick is still running
    expect(jest.getTimerCount()).toBe(0) // but nothing is scheduled any more

    slow.resolve(emptyDispatchReport())
    await stopping
    expect(drained).toBe(true)
    await jest.advanceTimersByTimeAsync(INTERVAL * 10)
    expect(mockReconcilePendingSettlements).toHaveBeenCalledTimes(1)
    expect(mockReconcileMissingDispatch).toHaveBeenCalledTimes(1)
  })

  it('stop() with no tick in flight resolves at once, and never rejects even when the last tick failed', async () => {
    mockReconcileMissingDispatch.mockRejectedValue(new Error('boom'))
    const schedule = startSettlementRecoverySchedule(makeLog(), INTERVAL)
    await jest.advanceTimersByTimeAsync(INTERVAL)
    await expect(schedule.stop()).resolves.toBeUndefined()
    await expect(startSettlementRecoverySchedule(makeLog(), INTERVAL).stop()).resolves.toBeUndefined()
  })

  it('the interval is unref()\'d - it never keeps the process alive on its own', async () => {
    const unref = jest.fn()
    const spy = jest.spyOn(global, 'setInterval').mockReturnValueOnce({ unref } as any)
    const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined)
    try {
      await startSettlementRecoverySchedule(makeLog(), INTERVAL).stop()
      expect(unref).toHaveBeenCalledTimes(1)
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      clear.mockRestore()
    }
  })
})
