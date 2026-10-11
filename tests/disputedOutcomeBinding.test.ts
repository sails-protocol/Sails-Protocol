// tests/disputedOutcomeBinding.test.ts
//
// AUD-1 - the shared binding between a disputed signing round and the signed ruling / durable Outcome it executes.
// Orchestration-level proof with the collaborators controlled (the translation guard's own logic is proven with real
// PSBTs in tests/dispatchTranslationGuard.test.ts; the whole path, on real PostgreSQL and real PSBTs, in
// tests/integration/disputedOutcomeBinding.test.ts).
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

jest.mock('../src/config', () => ({ config: { multisig: { network: 'testnet' } } }))
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({ networkFor: jest.fn(() => 'testnet-network') }))

const mockLoadRecord = jest.fn()
const mockFromRow = jest.fn()
jest.mock('../src/modules/open-settlement/dispute-outcome', () => ({
  loadDisputeRulingRecord: (...args: unknown[]) => mockLoadRecord(...args),
  fromDisputeRulingRow: (...args: unknown[]) => mockFromRow(...args),
}))

const mockGuard = jest.fn()
jest.mock('../src/modules/open-settlement/dispatch-translation-guard', () => ({
  assertTranslationMatchesOutcome: (...args: unknown[]) => mockGuard(...args),
}))

import { assertRoundBoundToDisputeAuthority, DisputedRoundFacts, BindingDispute } from '../src/modules/open-settlement/disputed-outcome-binding'
import { assertDispositionMatchesRuling } from '../src/modules/open-settlement/disposition-ruling-binding'

const client = { semanticTransitionRecord: {} } as any

function round(overrides: Partial<DisputedRoundFacts> = {}): DisputedRoundFacts {
  return {
    escrowId: 'escrow-1', escrowType: 'MULTISIG', kind: 'release', unsignedPsbtBase64: 'psbt', minerFeeSats: 250,
    buyerBps: null, disputeId: 'dispute-1', rulingAppealRound: 0, rulingOutcome: 'RELEASE', ...overrides,
  }
}
function dispute(overrides: Partial<BindingDispute> = {}): BindingDispute {
  return { id: 'dispute-1', escrowId: 'escrow-1', status: 'RESOLVED', ruling: 'RELEASE', authorityBuyerBps: null, ...overrides }
}
const OUTCOME_ROW = { outcomeContent: { ruling: 'RELEASE' }, toState: 'RESOLVED' }
const OUTCOME = { content: { ruling: 'RELEASE' } }

beforeEach(() => {
  for (const m of [mockLoadRecord, mockFromRow, mockGuard]) m.mockReset()
  mockLoadRecord.mockResolvedValue(OUTCOME_ROW)
  mockFromRow.mockReturnValue({ outcome: OUTCOME })
})

describe('assertRoundBoundToDisputeAuthority() - AUD-1', () => {
  it('passes a round that is exactly what the signed ruling decided, judged against its own Outcome by the shared guard', async () => {
    await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute())).resolves.toBeUndefined()
    expect(mockLoadRecord).toHaveBeenCalledWith('escrow-1', 0, client)
    expect(mockGuard).toHaveBeenCalledWith('psbt', OUTCOME, 'testnet-network', 250)
  })

  it('refuses a round that is not this dispute\'s, or whose dispute belongs to another escrow', async () => {
    await expect(assertRoundBoundToDisputeAuthority(client, round({ disputeId: null }), dispute())).rejects.toThrow(/does not belong to dispute/)
    await expect(assertRoundBoundToDisputeAuthority(client, round({ disputeId: 'dispute-2' }), dispute())).rejects.toThrow(/does not belong to dispute/)
    await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute({ escrowId: 'escrow-2' }))).rejects.toThrow(/another escrow/)
    expect(mockGuard).not.toHaveBeenCalled()
  })

  it('refuses when the dispute has no resolved ruling (any status but RESOLVED, or a null ruling)', async () => {
    for (const d of [dispute({ status: 'APPEALED', ruling: null }), dispute({ status: 'OPENED' }), dispute({ status: 'MOOT' }), dispute({ ruling: null })]) {
      await expect(assertRoundBoundToDisputeAuthority(client, round(), d)).rejects.toThrow(/no resolved ruling/)
    }
  })

  it('refuses a round carrying a ruling other than the dispute\'s', async () => {
    await expect(assertRoundBoundToDisputeAuthority(client, round({ rulingOutcome: 'REFUND' }), dispute())).rejects.toThrow(/carries ruling REFUND/)
    await expect(assertRoundBoundToDisputeAuthority(client, round({ rulingOutcome: null }), dispute())).rejects.toThrow(/carries ruling none/)
  })

  it('refuses every kind the ruling does not authorize, in both directions', async () => {
    const cases: Array<[string, string, string]> = [
      ['RELEASE', 'refund', 'refund'], ['RELEASE', 'split', 'split'],
      ['REFUND', 'release', 'release'], ['REFUND', 'split', 'split'],
      ['SPLIT', 'release', 'release'], ['SPLIT', 'refund', 'refund'],
    ]
    for (const [ruling, kind] of cases) {
      await expect(assertRoundBoundToDisputeAuthority(client, round({ kind, rulingOutcome: ruling }), dispute({ ruling })))
        .rejects.toThrow(/contradicts the signed ruling/)
    }
    expect(mockGuard).not.toHaveBeenCalled()
  })

  it('binds the buyer share of a SPLIT round to the signed bps; a ruling that signed none cannot be compared and is left to the Outcome', async () => {
    const split = { kind: 'split', rulingOutcome: 'SPLIT', escrowType: 'LIGHTNING_HODL' }
    await expect(assertRoundBoundToDisputeAuthority(client, round({ ...split, buyerBps: 6000 }), dispute({ ruling: 'SPLIT', authorityBuyerBps: 6000 }))).resolves.toBeUndefined()
    await expect(assertRoundBoundToDisputeAuthority(client, round({ ...split, buyerBps: 9000 }), dispute({ ruling: 'SPLIT', authorityBuyerBps: 6000 }))).rejects.toThrow(/signed ruling authorized 6000/)
    await expect(assertRoundBoundToDisputeAuthority(client, round({ ...split, buyerBps: null }), dispute({ ruling: 'SPLIT', authorityBuyerBps: 6000 }))).rejects.toThrow(/signed ruling authorized 6000/)
    await expect(assertRoundBoundToDisputeAuthority(client, round({ ...split, buyerBps: 1234 }), dispute({ ruling: 'SPLIT', authorityBuyerBps: null }))).resolves.toBeUndefined()
  })

  it('on a rail with no durable Outcome only the kind / ruling / bps binding applies: no record is read, no guard runs', async () => {
    await expect(assertRoundBoundToDisputeAuthority(client, round({ escrowType: 'SAFE_GUARD_EVM' }), dispute())).resolves.toBeUndefined()
    expect(mockLoadRecord).not.toHaveBeenCalled()
    expect(mockGuard).not.toHaveBeenCalled()
  })

  describe('MULTISIG - the durable Outcome', () => {
    it('fails closed without an appeal round, without a record, or without Outcome content', async () => {
      await expect(assertRoundBoundToDisputeAuthority(client, round({ rulingAppealRound: null }), dispute())).rejects.toThrow(/no appeal round/)
      mockLoadRecord.mockResolvedValueOnce(null)
      await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute())).rejects.toThrow(/no durable Core-authoritative Outcome/)
      mockLoadRecord.mockResolvedValueOnce({ outcomeContent: null, toState: 'RESOLVED' })
      await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute())).rejects.toThrow(/no durable Core-authoritative Outcome/)
      expect(mockGuard).not.toHaveBeenCalled()
    })

    it('refuses an Outcome that is not the RESOLVED transition of THIS ruling', async () => {
      for (const row of [
        { outcomeContent: { ruling: 'REFUND' }, toState: 'RESOLVED' },
        { outcomeContent: { ruling: 'RELEASE' }, toState: 'OPENED' },
        { outcomeContent: {}, toState: 'RESOLVED' },
        { outcomeContent: 'RELEASE', toState: 'RESOLVED' },
        { outcomeContent: ['RELEASE'], toState: 'RESOLVED' },
      ]) {
        mockLoadRecord.mockResolvedValueOnce(row)
        await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute())).rejects.toThrow(/not the RESOLVED RELEASE transition/)
      }
      expect(mockGuard).not.toHaveBeenCalled()
    })

    it('refuses a record that reconstructs to no Outcome', async () => {
      mockFromRow.mockReturnValueOnce({ outcome: null })
      await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute())).rejects.toThrow(/carries no Outcome/)
    })

    it('lets the shared translation guard\'s verdict (destinations, amounts, outputs, cost ceiling) stand: a mismatch is an error', async () => {
      mockGuard.mockImplementationOnce(() => { throw new Error('Translated settlement transaction does not correspond to the authoritative Outcome') })
      await expect(assertRoundBoundToDisputeAuthority(client, round(), dispute())).rejects.toThrow(/does not correspond to the authoritative Outcome/)
    })

    it('judges a round of an earlier appeal round against THAT round\'s Outcome (the generation the round carries)', async () => {
      mockLoadRecord.mockResolvedValueOnce({ outcomeContent: { ruling: 'REFUND' }, toState: 'RESOLVED' })
      await assertRoundBoundToDisputeAuthority(client, round({ rulingAppealRound: 1, rulingOutcome: 'REFUND', kind: 'refund' }), dispute({ ruling: 'REFUND' }))
      expect(mockLoadRecord).toHaveBeenCalledWith('escrow-1', 1, client)
    })
  })
})

// Structural: a signing round is created in exactly one place, and that place judges it before persisting it.
describe('AUD-1 structural - one creator of a round, and it is bound', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
  const sources = walk(join(__dirname, '../src')).map((p) => ({ p: p.replace(/\\/g, '/'), s: readFileSync(p, 'utf8') }))

  it('only escrow-pending-tx.ts creates an EscrowPendingTransaction, and the binding call precedes the create', () => {
    const creators = sources.filter(({ s }) => /escrowPendingTransaction\.create\(/.test(s))
    expect(creators.map((c) => c.p.split('/src/')[1])).toEqual(['modules/open-settlement/escrow-pending-tx.ts'])
    const s = creators[0].s
    expect(s.indexOf('assertRoundBoundToDisputeAuthority(tx')).toBeGreaterThan(-1)
    expect(s.indexOf('assertRoundBoundToDisputeAuthority(tx')).toBeLessThan(s.indexOf('escrowPendingTransaction.create('))
  })

  it('only the ADR-005 gate commits an EconomicDispositionAuthorization, and it judges the round (reuse path included) first', () => {
    const creators = sources.filter(({ s }) => /economicDispositionAuthorization\.create\(/.test(s))
    expect(creators.map((c) => c.p.split('/src/')[1])).toEqual(['modules/open-settlement/economic-disposition-authority.ts'])
    const s = creators[0].s
    const firstBound = s.indexOf('await assertBound(')
    expect(firstBound).toBeGreaterThan(-1)
    expect((s.match(/await assertBound\(/g) ?? []).length).toBe(2) // the live generation AND the reuse of a committed authorization
    expect(firstBound).toBeLessThan(s.indexOf('economicDispositionAuthorization.create('))
  })
})

describe('assertDispositionMatchesRuling() - AUD-1, the part every executor shares (signing rounds and direct executors)', () => {
  const d = (ruling: string | null, authorityBuyerBps: number | null = null) => ({ id: 'dispute-1', ruling, authorityBuyerBps })

  it('accepts exactly the ruled disposition', () => {
    expect(() => assertDispositionMatchesRuling('release', null, d('RELEASE'), 'x')).not.toThrow()
    expect(() => assertDispositionMatchesRuling('refund', null, d('REFUND'), 'x')).not.toThrow()
    expect(() => assertDispositionMatchesRuling('split', 6000, d('SPLIT', 6000), 'x')).not.toThrow()
  })

  it('refuses every other disposition and an unresolved or unknown ruling', () => {
    for (const [kind, ruling] of [['refund', 'RELEASE'], ['split', 'RELEASE'], ['release', 'REFUND'], ['split', 'REFUND'], ['release', 'SPLIT'], ['refund', 'SPLIT']]) {
      expect(() => assertDispositionMatchesRuling(kind, null, d(ruling), 'x')).toThrow(/contradicts the signed ruling/)
    }
    expect(() => assertDispositionMatchesRuling('release', null, d(null), 'x')).toThrow(/contradicts the signed ruling none/)
    expect(() => assertDispositionMatchesRuling('release', null, d('OTHER'), 'x')).toThrow(/unknown disposition/)
  })

  it('binds the buyer share of a SPLIT to the signed bps when one was signed', () => {
    expect(() => assertDispositionMatchesRuling('split', 9000, d('SPLIT', 6000), 'x')).toThrow(/authorized 6000/)
    expect(() => assertDispositionMatchesRuling('split', null, d('SPLIT', 6000), 'x')).toThrow(/authorized 6000/)
    expect(() => assertDispositionMatchesRuling('split', 1234, d('SPLIT', null), 'x')).not.toThrow()
  })
})
