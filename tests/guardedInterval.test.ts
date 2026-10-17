/**
 * common/guarded-interval.ts — the lifecycle primitive startServer() uses for the escrow timelock,
 * MULTISIG fee-confirmation and MULTISIG funding-reorg sweepers. Scheduling semantics only, on fake
 * timers; what a run does (and why a duplicate run across instances is safe) is proven against real
 * PostgreSQL in the integration tests named in the production-sweeper hardening PR.
 */
import { startGuardedInterval } from '../src/common/guarded-interval'

const INTERVAL = 300_000

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

describe('startGuardedInterval()', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it('runs once per interval, and not before the first interval elapses', async () => {
    const run = jest.fn().mockResolvedValue(undefined)
    const guarded = startGuardedInterval(run, INTERVAL)
    try {
      expect(run).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(run).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(INTERVAL * 4)
      expect(run).toHaveBeenCalledTimes(5)
    } finally {
      await guarded.stop()
    }
  })

  it('a stuck run is never overlapped and nothing queues behind it: ten elapsed intervals still mean one run, and scheduling resumes normally once it finishes', async () => {
    const stuck = deferred()
    let active = 0
    let maxActive = 0
    const run = jest.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (run.mock.calls.length === 1) await stuck.promise
      } finally {
        active--
      }
    })
    const guarded = startGuardedInterval(run, INTERVAL)
    try {
      await jest.advanceTimersByTimeAsync(INTERVAL) // run 1 starts and blocks
      await jest.advanceTimersByTimeAsync(INTERVAL * 10)
      expect(run).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(1) // the one interval — no backlog of queued timers or runs

      stuck.resolve()
      await jest.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledTimes(1) // finishing does not trigger a catch-up burst
      await jest.advanceTimersByTimeAsync(INTERVAL)
      expect(run).toHaveBeenCalledTimes(2)
      await jest.advanceTimersByTimeAsync(INTERVAL * 3)
      expect(run).toHaveBeenCalledTimes(5)
      expect(maxActive).toBe(1)
    } finally {
      await guarded.stop()
    }
  })

  it('stop() clears the timer at once and resolves only after the run already in flight has finished', async () => {
    const stuck = deferred()
    const run = jest.fn(() => stuck.promise)
    const guarded = startGuardedInterval(run, INTERVAL)
    await jest.advanceTimersByTimeAsync(INTERVAL)

    let drained = false
    const stopping = guarded.stop().then(() => { drained = true })
    expect(jest.getTimerCount()).toBe(0)
    await jest.advanceTimersByTimeAsync(INTERVAL * 10)
    expect(drained).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)

    stuck.resolve()
    await stopping
    expect(drained).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stop() with nothing in flight resolves immediately; stopping twice is harmless', async () => {
    const guarded = startGuardedInterval(jest.fn().mockResolvedValue(undefined), INTERVAL)
    await expect(guarded.stop()).resolves.toBeUndefined()
    await expect(guarded.stop()).resolves.toBeUndefined()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('a run that contains its own failure (the startServer() call sites log and resolve) keeps the schedule alive', async () => {
    const log = jest.fn()
    const sweep = jest.fn().mockRejectedValue(new Error('explorer unreachable'))
    const guarded = startGuardedInterval(() => sweep().catch((err: Error) => log(err.message)), INTERVAL)
    try {
      await jest.advanceTimersByTimeAsync(INTERVAL * 3)
      expect(sweep).toHaveBeenCalledTimes(3)
      expect(log).toHaveBeenCalledTimes(3)
      expect(log).toHaveBeenCalledWith('explorer unreachable')
    } finally {
      await guarded.stop()
    }
  })

  it('the interval is unref()\'d, so it never keeps the process alive on its own', async () => {
    const unref = jest.fn()
    const spy = jest.spyOn(global, 'setInterval').mockReturnValueOnce({ unref } as any)
    const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined)
    try {
      await startGuardedInterval(jest.fn().mockResolvedValue(undefined), INTERVAL).stop()
      expect(unref).toHaveBeenCalledTimes(1)
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      clear.mockRestore()
    }
  })
})
