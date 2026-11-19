/**
 * F32 alternative A (CTO Despacho 012, P46): acceptance cases T-A1..T-A14 for the pure evaluator and the read-only
 * service. No database and no network: the evaluator is pure and the service gets fake readers. The behavioural
 * cases below are also the ones that kill the T-A12 mutants (see the "kills" notes).
 */
import * as fs from 'fs'
import * as path from 'path'

jest.mock('../src/common/database', () => ({ prisma: {} }))
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  fetchChainTipHeight: jest.fn(),
  fetchOutpointSpendStatus: jest.fn(),
}))

import {
  evaluatePartyAbsenceSignals,
  PARTY_ABSENCE_DISCLOSURE,
  type DisputeSnapshot,
  type PartyAbsenceInput,
  type RoundSnapshot,
} from '../src/modules/open-settlement/party-absence-signals'
import { getPartyAbsenceSignals, type PartyAbsenceReaders } from '../src/modules/open-settlement/party-absence-signals.service'

const T = (iso: string) => new Date(iso)
const RULING_AT = T('2026-01-01T10:00:00.000Z')
const ROUND_AT = T('2026-01-01T10:00:05.000Z')
const NOW = T('2026-01-01T12:00:00.000Z')

const dispute = (over: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
  id: 'd1', status: 'RESOLVED', ruling: 'RELEASE', appealRound: 0, arbiterId: 'arb', authoritySignature: 'sig', resolvedAt: RULING_AT, ...over,
})
const round = (over: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', createdAt: ROUND_AT, kind: 'release', requiredSigners: ['buyer'], disputeId: 'd1', rulingAppealRound: 0, minerFeeSats: 1000, signatures: [], ...over,
})
const base = (over: Partial<PartyAbsenceInput> = {}): PartyAbsenceInput => ({
  nowApp: NOW,
  applicable: true,
  dispute: { ok: true, value: dispute() },
  rounds: { ok: true, value: [round()] },
  keys: { ok: true, value: [{ participantId: 'buyer', role: 'buyer' }, { participantId: 'seller', role: 'seller' }] },
  retirements: { ok: true, value: [] },
  outpoint: { ok: true, value: { spent: false, spendingTxid: null } },
  chainTipHeight: { ok: true, value: 900000 },
  databaseClock: { ok: true, value: NOW },
  ...over,
})

describe('F32-A party-absence signals (pure evaluator)', () => {
  it('T-A1 a valid round of the current generation gives E0 OBSERVADO on the application clock', () => {
    const out = evaluatePartyAbsenceSignals(base())
    expect(out.signals.s0RoundCommitted).toEqual({ state: 'OBSERVADO', value: { roundId: 'r1', at: ROUND_AT.toISOString() } })
    expect(out.signals.s7Ruling.state).toBe('OBSERVADO')
  })

  it('T-A2 no round: E0 and S1 are DESCONHECIDO, never "no signature observed" (kills: S1 NAO_OBSERVADO with unknown E0)', () => {
    const out = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [] } }))
    expect(out.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'SEM_ROUND' })
    expect(out.signals.s1RequiredSignature.state).toBe('DESCONHECIDO')
    expect(out.status).toBe('DESCONHECIDO')
    expect(out.intervals.sinceCurrentRoundMs).toBeNull()
  })

  it('T-A3 a reverted or missing ruling makes E0 DESCONHECIDO', () => {
    const reverted = evaluatePartyAbsenceSignals(base({ dispute: { ok: true, value: dispute({ status: 'RESOLVED', resolvedAt: null }) } }))
    expect(reverted.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'RULING_NULO_OU_REVERTIDO' })
    expect(reverted.signals.s1RequiredSignature.state).toBe('DESCONHECIDO')
    const noRuling = evaluatePartyAbsenceSignals(base({ dispute: { ok: true, value: dispute({ status: 'OPENED', ruling: null, authoritySignature: null, resolvedAt: null }) } }))
    expect(noRuling.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'SEM_RULING_COMITADO' })
    expect(noRuling.status).toBe('AGUARDANDO_RULING')
  })

  it('T-A4 a round in the future of the application clock makes E0 DESCONHECIDO (kills: removing the future check)', () => {
    const out = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ createdAt: T('2026-01-01T12:00:01.000Z') })] } }))
    expect(out.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'ROUND_FUTURO' })
    expect(out.signals.s1RequiredSignature.state).toBe('DESCONHECIDO')
  })

  it('T-A5 a round before the ruling makes E0 DESCONHECIDO (kills: removing createdAt >= resolvedAt)', () => {
    const out = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ createdAt: T('2026-01-01T09:59:59.000Z') })] } }))
    expect(out.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'ROUND_ANTERIOR_AO_RULING' })
    expect(out.signals.s1RequiredSignature.state).toBe('DESCONHECIDO')
  })

  it('T-A6 a signature of a required signer is OBSERVADO; a signature of someone else does not count', () => {
    const signed = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ signatures: [{ participantId: 'buyer' }] })] } }))
    expect(signed.signals.s1RequiredSignature).toEqual({ state: 'OBSERVADO', value: { signedBy: ['buyer'] } })
    expect(signed.status).toBe('ASSINATURA_OBSERVADA')
    const other = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ signatures: [{ participantId: 'seller' }] })] } }))
    expect(other.signals.s1RequiredSignature.state).toBe('NAO_OBSERVADO')
  })

  it('T-A7 E0 valid and no signature: NAO_OBSERVADO and "waiting"; an unavailable explorer changes nothing about S1', () => {
    const out = evaluatePartyAbsenceSignals(base({ chainTipHeight: { ok: false, reason: 'LEITURA_FALHOU' }, outpoint: { ok: false, reason: 'LEITURA_FALHOU' } }))
    expect(out.signals.s1RequiredSignature.state).toBe('NAO_OBSERVADO')
    expect(out.status).toBe('AGUARDANDO_ASSINATURA_DA_PARTE_EXIGIDA')
    expect(out.signals.s4ChainTip.state).toBe('DESCONHECIDO')
    expect(out.signals.s5FundingOutpoint.state).toBe('DESCONHECIDO')
  })

  it('T-A8 a replaced round restarts the operational E0; the interval since the ruling is unchanged (kills: merged intervals)', () => {
    const first = evaluatePartyAbsenceSignals(base())
    const replaced = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ id: 'r2', createdAt: T('2026-01-01T11:00:00.000Z') })] } }))
    expect(first.intervals.sinceRulingMs).toBe(NOW.getTime() - RULING_AT.getTime())
    expect(replaced.intervals.sinceRulingMs).toBe(first.intervals.sinceRulingMs)
    expect(first.intervals.sinceCurrentRoundMs).toBe(NOW.getTime() - ROUND_AT.getTime())
    expect(replaced.intervals.sinceCurrentRoundMs).toBe(NOW.getTime() - T('2026-01-01T11:00:00.000Z').getTime())
    expect(replaced.intervals.sinceCurrentRoundMs).not.toBe(replaced.intervals.sinceRulingMs)
  })

  it('T-A9 an appeal is a new generation: a round of the previous generation is not the E0 of the current one', () => {
    const appealed = dispute({ appealRound: 1 })
    const old = evaluatePartyAbsenceSignals(base({ dispute: { ok: true, value: appealed }, rounds: { ok: true, value: [round({ rulingAppealRound: 0 })] } }))
    expect(old.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'SEM_ROUND' })
    const current = evaluatePartyAbsenceSignals(base({ dispute: { ok: true, value: appealed }, rounds: { ok: true, value: [round({ rulingAppealRound: 1 })] } }))
    expect(current.signals.s0RoundCommitted.state).toBe('OBSERVADO')
  })

  it('T-A10 a failed read is DESCONHECIDO everywhere it matters, never "absent" (kills: failed read as NAO_OBSERVADO)', () => {
    const noDispute = evaluatePartyAbsenceSignals(base({ dispute: { ok: false, reason: 'LEITURA_FALHOU' } }))
    expect(noDispute.status).toBe('DESCONHECIDO')
    expect(noDispute.signals.s7Ruling.state).toBe('DESCONHECIDO')
    expect(noDispute.signals.s9ArbiterWithoutRuling.state).toBe('DESCONHECIDO')
    expect(noDispute.signals.s1RequiredSignature.state).toBe('DESCONHECIDO')
    const noRounds = evaluatePartyAbsenceSignals(base({ rounds: { ok: false, reason: 'LEITURA_FALHOU' } }))
    expect(noRounds.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'LEITURA_FALHOU' })
    expect(noRounds.signals.s1RequiredSignature.state).toBe('DESCONHECIDO')
    expect(noRounds.signals.s10RequiredKeys.state).toBe('DESCONHECIDO')
    expect(noRounds.status).toBe('DESCONHECIDO')
    const noKeys = evaluatePartyAbsenceSignals(base({ keys: { ok: false, reason: 'LEITURA_FALHOU' } }))
    expect(noKeys.signals.s10RequiredKeys.state).toBe('DESCONHECIDO')
    const noRetire = evaluatePartyAbsenceSignals(base({ retirements: { ok: false, reason: 'LEITURA_FALHOU' } }))
    expect(noRetire.signals.s8Retirements.state).toBe('DESCONHECIDO')
  })

  it('T-A10b two rounds of the same generation are ambiguous: DESCONHECIDO', () => {
    const out = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round(), round({ id: 'r2' })] } }))
    expect(out.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'ROUND_AMBIGUO' })
  })

  it('T-A10c an invalid date is DESCONHECIDO, not an exception', () => {
    const out = evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ createdAt: new Date('not a date') })] } }))
    expect(out.signals.s0RoundCommitted).toEqual({ state: 'DESCONHECIDO', reason: 'DATA_INVALIDA' })
  })

  it('T-A11a the evaluator is pure: no imports, no I/O, no clock of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/modules/open-settlement/party-absence-signals.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(/)
    expect(code).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now|fetch\(|prisma|process\./)
  })

  it('T-A11b the service has no write path and never builds, signs or broadcasts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/modules/open-settlement/party-absence-signals.service.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/)
    expect(code).not.toMatch(/\$executeRaw|\$transaction|\$queryRawUnsafe|\$executeRawUnsafe/)
    expect(code).not.toMatch(/broadcast|buildUnsigned|finalize|reconcilePendingSettlement|signInput|escrowService|claimEscrowTransition/i)
    // The only database call that is not a plain find* is the read-only clock query.
    const raw = code.match(/\$queryRaw/g) ?? []
    expect(raw).toHaveLength(1)
  })

  it('T-A12 mutant guard: every state of every approved signal is reachable and distinct', () => {
    const ok = evaluatePartyAbsenceSignals(base({ retirements: { ok: true, value: [{ signedBy: ['seller'], retiredAt: T('2026-01-01T09:00:00.000Z') }] } }))
    expect(ok.signals.s8Retirements).toEqual({ state: 'OBSERVADO', value: { count: 1, lastRetiredAt: '2026-01-01T09:00:00.000Z' } })
    expect(evaluatePartyAbsenceSignals(base()).signals.s8Retirements.state).toBe('NAO_OBSERVADO')
    expect(evaluatePartyAbsenceSignals(base({ keys: { ok: true, value: [{ participantId: 'seller', role: 'seller' }] } })).signals.s10RequiredKeys)
      .toEqual({ state: 'NAO_OBSERVADO', reason: 'CHAVE_NAO_REGISTRADA' })
    expect(evaluatePartyAbsenceSignals(base()).signals.s10RequiredKeys.state).toBe('OBSERVADO')
    expect(evaluatePartyAbsenceSignals(base({ outpoint: { ok: true, value: 'NO_VOUT' } })).signals.s5FundingOutpoint).toEqual({ state: 'DESCONHECIDO', reason: 'SEM_VOUT_LEGADO' })
    expect(evaluatePartyAbsenceSignals(base({ outpoint: { ok: true, value: { spent: true, spendingTxid: 'tx1' } } })).signals.s5FundingOutpoint)
      .toEqual({ state: 'OBSERVADO', value: { spent: true, spendingTxid: 'tx1' } })
    expect(evaluatePartyAbsenceSignals(base({ rounds: { ok: true, value: [round({ minerFeeSats: null })] } })).signals.s6RecordedFee).toEqual({ state: 'DESCONHECIDO', reason: 'SEM_TAXA_REGISTRADA' })
    expect(evaluatePartyAbsenceSignals(base()).signals.s6RecordedFee).toEqual({ state: 'OBSERVADO', value: { recordedMinerFeeSats: 1000, obsolescenceEvaluated: false } })
    expect(evaluatePartyAbsenceSignals(base({ dispute: { ok: true, value: dispute({ status: 'OPENED', ruling: null, authoritySignature: null, resolvedAt: null }) } })).signals.s9ArbiterWithoutRuling)
      .toEqual({ state: 'OBSERVADO', value: { arbiterId: 'arb' } })
    expect(evaluatePartyAbsenceSignals(base()).signals.s9ArbiterWithoutRuling.state).toBe('NAO_OBSERVADO')
  })

  it('T-A13 S3 (database clock) is context only: copied through, never compared (not applicable as a comparison)', () => {
    const out = evaluatePartyAbsenceSignals(base({ databaseClock: { ok: true, value: T('2030-01-01T00:00:00.000Z') } }))
    expect(out.signals.s3DatabaseClock).toEqual({ state: 'OBSERVADO', value: { at: '2030-01-01T00:00:00.000Z' } })
    expect(evaluatePartyAbsenceSignals(base({ databaseClock: { ok: false, reason: 'LEITURA_FALHOU' } })).signals.s3DatabaseClock.state).toBe('DESCONHECIDO')
  })

  it('T-A14 the database clock never changes any decision (kills: re-introducing clock_timestamp() into rule 3)', () => {
    const reference = evaluatePartyAbsenceSignals(base())
    const strip = (o: ReturnType<typeof evaluatePartyAbsenceSignals>) => ({ ...o, signals: { ...o.signals, s3DatabaseClock: undefined } })
    for (const dbClock of [T('1999-01-01T00:00:00.000Z'), T('2099-01-01T00:00:00.000Z'), T('2026-01-01T09:00:00.000Z'), T('2026-01-01T10:00:01.000Z')]) {
      const out = evaluatePartyAbsenceSignals(base({ databaseClock: { ok: true, value: dbClock } }))
      expect(strip(out)).toEqual(strip(reference))
    }
    expect(strip(evaluatePartyAbsenceSignals(base({ databaseClock: { ok: false, reason: 'LEITURA_FALHOU' } })))).toEqual(strip(reference))
    // The evaluator file never names the database clock; the service names it exactly once, in the S3 reader.
    const evaluatorSrc = fs.readFileSync(path.join(__dirname, '../src/modules/open-settlement/party-absence-signals.ts'), 'utf8')
    const evaluatorCode = evaluatorSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(evaluatorCode).not.toMatch(/clock_timestamp/i)
    const serviceSrc = fs.readFileSync(path.join(__dirname, '../src/modules/open-settlement/party-absence-signals.service.ts'), 'utf8')
    const serviceCode = serviceSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(serviceCode.match(/clock_timestamp/gi) ?? []).toHaveLength(1)
  })

  it('no dispute, or a non-MULTISIG escrow, is NAO_APLICAVEL', () => {
    expect(evaluatePartyAbsenceSignals(base({ dispute: { ok: true, value: null } })).status).toBe('NAO_APLICAVEL')
    expect(evaluatePartyAbsenceSignals(base({ applicable: false })).status).toBe('NAO_APLICAVEL')
  })

  it('the disclosure carries the approved statements', () => {
    expect(PARTY_ABSENCE_DISCLOSURE.timeIndicator).toMatch(/does NOT prove that a party is unavailable/)
    expect(PARTY_ABSENCE_DISCLOSURE.timeIndicator).toMatch(/application clock, which the operator controls/)
    expect(PARTY_ABSENCE_DISCLOSURE.arbiterKey).toMatch(/belongs to the node operator/)
    expect(PARTY_ABSENCE_DISCLOSURE.limitation).toMatch(/2-of-3/)
    expect(evaluatePartyAbsenceSignals(base()).disclosure).toBe(PARTY_ABSENCE_DISCLOSURE)
  })
})

describe('F32-A party-absence signals (read-only service with fake readers)', () => {
  const readers = (type: string): { r: PartyAbsenceReaders; inputCalls: () => number } => {
    let calls = 0
    return {
      inputCalls: () => calls,
      r: {
        escrow: async () => ({ type, txLockId: 'funding', txLockVout: 0 }),
        input: async () => {
          calls += 1
          const { nowApp: _n, applicable: _a, ...rest } = base()
          void _n; void _a
          return rest
        },
      },
    }
  }

  it('an unknown escrow throws NotFoundError', async () => {
    const r: PartyAbsenceReaders = { escrow: async () => null, input: async () => { throw new Error('must not read') } }
    await expect(getPartyAbsenceSignals('nope', r, NOW)).rejects.toThrow(/not found|Escrow/i)
  })

  it('a non-MULTISIG escrow reads nothing else (no explorer, no dispute) and is NAO_APLICAVEL', async () => {
    const { r, inputCalls } = readers('LIGHTNING_HODL')
    const out = await getPartyAbsenceSignals('e1', r, NOW)
    expect(out.status).toBe('NAO_APLICAVEL')
    expect(out.applicable).toBe(false)
    expect(inputCalls()).toBe(0)
  })

  it('a MULTISIG escrow is evaluated with the injected application clock', async () => {
    const { r, inputCalls } = readers('MULTISIG')
    const out = await getPartyAbsenceSignals('e1', r, NOW)
    expect(inputCalls()).toBe(1)
    expect(out.status).toBe('AGUARDANDO_ASSINATURA_DA_PARTE_EXIGIDA')
    expect(out.intervals.sinceCurrentRoundMs).toBe(NOW.getTime() - ROUND_AT.getTime())
  })
})
