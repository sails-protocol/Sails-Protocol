/**
 * Issue #253 (Intent atomicity) - unit contract of recoverUnpublishedIntentEvents(): it republishes only what the
 * repository says is owed, tags the event with the IntentEvent id (transitionId), reports per-row failures without
 * stopping, and honours the grace window. The crash/concurrency behaviour is proven on PostgreSQL in
 * tests/integration/intentTransitionAtomicity.test.ts.
 */
const mockEmit = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/common/events/event-bus', () => ({ eventBus: { emit: (...args: unknown[]) => mockEmit(...args) } }))
jest.mock('../src/core/intent-repository', () => ({ intentRepository: {} }))

import { recoverUnpublishedIntentEvents } from '../src/core/intent-publication-recovery'

const row = (id: string, eventName = 'intent.committed') => ({ id, intentId: `intent-${id}`, eventName, eventPayload: { intentId: `intent-${id}`, settlementId: 's' } })

function fakeRepo(rows: any[], outcomes: Record<string, string | Error> = {}) {
  return {
    findUnpublishedEvents: jest.fn().mockResolvedValue(rows),
    publishOwedEvent: jest.fn(async (id: string, publish: (r: any) => Promise<void>) => {
      const outcome = outcomes[id] ?? 'PUBLISHED'
      if (outcome instanceof Error) throw outcome
      if (outcome === 'PUBLISHED') await publish(rows.find((r) => r.id === id))
      return outcome
    }),
  } as any
}

describe('recoverUnpublishedIntentEvents', () => {
  beforeEach(() => mockEmit.mockClear())

  it('republishes an owed event from its durable record, tagged with the IntentEvent id', async () => {
    const repo = fakeRepo([row('ie-1')])
    const report = await recoverUnpublishedIntentEvents({ repo })

    expect(report).toEqual({ republished: ['ie-1'], markedPublished: [], failed: [] })
    expect(mockEmit).toHaveBeenCalledWith('intent.committed', { intentId: 'intent-ie-1', settlementId: 's', transitionId: 'ie-1' }, 'intent-ie-1')
  })

  it('does not emit again for an event whose durable copy already exists (only marks it)', async () => {
    const report = await recoverUnpublishedIntentEvents({ repo: fakeRepo([row('ie-1')], { 'ie-1': 'ALREADY_PUBLISHED' }) })

    expect(report.markedPublished).toEqual(['ie-1'])
    expect(report.republished).toEqual([])
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('reports a failing row and keeps recovering the others', async () => {
    const repo = fakeRepo([row('ie-1'), row('ie-2')], { 'ie-1': new Error('bus down') })
    const report = await recoverUnpublishedIntentEvents({ repo })

    expect(report.failed).toEqual([{ intentEventId: 'ie-1', error: 'bus down' }])
    expect(report.republished).toEqual(['ie-2'])
  })

  it('asks the repository only for events older than the grace window', async () => {
    const repo = fakeRepo([])
    const before = Date.now()
    await recoverUnpublishedIntentEvents({ repo, graceMs: 60_000 })

    const cutoff = (repo.findUnpublishedEvents.mock.calls[0][0] as Date).getTime()
    expect(cutoff).toBeLessThanOrEqual(before - 60_000 + 50)
    expect(cutoff).toBeGreaterThan(before - 60_000 - 5_000)
  })
})
