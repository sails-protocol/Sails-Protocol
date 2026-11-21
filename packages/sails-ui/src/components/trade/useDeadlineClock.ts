/**
 * Shared clock for the trade page countdowns (EscrowCountdown, DisputeAppealBlock): ticks every second under
 * 1 h and every 30 s otherwise, only while a deadline runs, pauses while the tab is hidden and resyncs on return.
 * Milestone announcements fire only when a later key moment is reached with the page open (never on load).
 */
import { useEffect, useRef, useState } from 'react'
import { MILESTONE_ANNOUNCEMENT } from '../../lib/escrowDeadline'

/** `deadlineMs`: the running deadline (epoch ms), or null when nothing ticks. `clock` defaults to the device clock. */
export function useTickingNow(deadlineMs: number | null, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock)
  const remaining = deadlineMs === null || Number.isNaN(deadlineMs) ? null : deadlineMs - now
  const running = remaining !== null && remaining > 0
  const fast = running && remaining < 3_600_000
  useEffect(() => {
    if (!running) return
    let id: number | undefined
    const start = () => { setNow(clock()); id = window.setInterval(() => setNow(clock()), fast ? 1000 : 30_000) }
    const onVisibility = () => { window.clearInterval(id); if (!document.hidden) start() }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisibility) }
  }, [running, fast, clock])
  return now
}

export function useMilestoneAnnouncement(milestone: 0 | 1 | 2 | 3 | 4): string {
  const seen = useRef(milestone)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (milestone > seen.current) setAnnouncement(MILESTONE_ANNOUNCEMENT[milestone as 1 | 2 | 3 | 4])
    seen.current = milestone
  }, [milestone])
  return announcement
}
