/**
 * guarded-interval.ts — the lifecycle rules startServer()'s background sweepers need, in one place:
 *
 *   - at most one invocation of a sweeper in flight per process: a tick that fires while the previous
 *     run is still going is skipped, never queued, so a stuck run cannot build a backlog of runs;
 *   - explicit ownership of the timer, unref()'d so it never keeps the process alive on its own;
 *   - stop() clears the timer and resolves once a run already in flight has finished, so graceful
 *     shutdown can drain it before closing the Postgres/Redis connections it is using.
 *
 * Same semantics as the settlement/C4 recovery schedule (settlement-recovery-schedule.ts). The
 * in-flight guard is operational only: what makes a duplicate run across instances or restarts safe
 * is each sweeper's own durable guard in PostgreSQL, never this flag.
 *
 * `run` must contain its own errors (log and resolve). A rejection would leave no one to observe it.
 */
export interface GuardedInterval {
  /** Stops future runs and resolves once a run already in flight has finished (never rejects while `run` keeps its contract). */
  stop: () => Promise<void>
}

export function startGuardedInterval(run: () => Promise<void>, intervalMs: number): GuardedInterval {
  let inFlight: Promise<void> | null = null
  const interval = setInterval(() => {
    if (inFlight) return
    inFlight = run().finally(() => { inFlight = null })
  }, intervalMs)
  interval.unref()
  return {
    stop: async () => {
      clearInterval(interval)
      await inFlight
    },
  }
}
