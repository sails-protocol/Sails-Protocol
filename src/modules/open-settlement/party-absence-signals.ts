/**
 * party-absence-signals.ts - F32, alternative A (CTO Despacho 012, P46): a PURE, read-only derivation of the
 * operational signals shown while a MULTISIG dispute ruling waits for the signature of the *required party*.
 *
 * WHAT THIS IS NOT. It never moves funds, never signs, never writes, never changes an economic state and never
 * authorizes anything. Every value here is operational EVIDENCE, not proof: the time comes from the application
 * clock the operator controls, so the output NEVER proves that a party is unavailable. A signature that is not
 * observed is not "an absent party".
 *
 * THREE STATES. Each signal is OBSERVADO / NAO_OBSERVADO / DESCONHECIDO. DESCONHECIDO is never downgraded to
 * NAO_OBSERVADO: a failed read, an inconsistent time or a missing round is unknown, not "absent". "No signature
 * observed" is only ever reported when E0 (the live round of the current ruling generation), the ruling and the
 * read of the signatures are all observed.
 *
 * E0 = `EscrowPendingTransaction.createdAt` of the live round of the current ruling generation, on the APPLICATION
 * clock (the same source as `Dispute.resolvedAt`). It is NEVER compared with a database clock (that would mix two
 * clocks, and the column is a timezone-less TIMESTAMP): this module takes no database-clock input at all for its
 * decisions. S3 (the database clock) is context only and is copied to the output untouched.
 *
 * No I/O, no `Date.now()`, no `new Date()`: the caller injects `nowApp` and every reading, so the module is
 * deterministic and testable without a database.
 */

export type SignalState = 'OBSERVADO' | 'NAO_OBSERVADO' | 'DESCONHECIDO'

export interface Signal<T = undefined> {
  readonly state: SignalState
  /** Why the signal has this state (always set for DESCONHECIDO; set for NAO_OBSERVADO when it needs explaining). */
  readonly reason?: string
  readonly value?: T
}

/** A reading that either succeeded or failed: a failed read is an explicit input, never an empty result. */
export type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

export interface DisputeSnapshot {
  readonly id: string
  readonly status: string
  readonly ruling: string | null
  readonly appealRound: number
  readonly arbiterId: string | null
  readonly authoritySignature: string | null
  /** Application clock (`new Date()` at the ruling commit); null while no ruling is committed or after a revert. */
  readonly resolvedAt: Date | null
}

export interface RoundSignatureSnapshot {
  readonly participantId: string
}

export interface RoundSnapshot {
  readonly id: string
  /** Application clock: the Prisma client sends it in the INSERT. */
  readonly createdAt: Date
  readonly kind: string
  readonly requiredSigners: readonly string[]
  /** `EscrowPendingTransaction.disputeId` / `rulingAppealRound`: the ruling generation this round was built for. */
  readonly disputeId: string | null
  readonly rulingAppealRound: number | null
  readonly minerFeeSats: number | null
  readonly signatures: readonly RoundSignatureSnapshot[]
}

export interface ParticipantKeySnapshot {
  readonly participantId: string
  readonly role: string
}

export interface RetirementSnapshot {
  readonly signedBy: readonly string[]
  readonly retiredAt: Date
}

export interface OutpointSnapshot {
  readonly spent: boolean
  readonly spendingTxid: string | null
}

export interface PartyAbsenceInput {
  /** Application clock, injected by the caller. */
  readonly nowApp: Date
  /** False for any escrow that is not a MULTISIG one: nothing here applies. */
  readonly applicable: boolean
  /** The latest dispute of the escrow (highest appealRound); `null` when the escrow has none. */
  readonly dispute: Reading<DisputeSnapshot | null>
  /** Every pending round of the escrow (the table is unique per escrow, so 0 or 1; the evaluator does not rely on it). */
  readonly rounds: Reading<readonly RoundSnapshot[]>
  readonly keys: Reading<readonly ParticipantKeySnapshot[]>
  readonly retirements: Reading<readonly RetirementSnapshot[]>
  /** The funding outpoint read; `NO_VOUT` for a legacy escrow without a recorded vout (ambiguous). */
  readonly outpoint: Reading<OutpointSnapshot | 'NO_VOUT'>
  readonly chainTipHeight: Reading<number>
  /** Context only (S3): never read by any decision in this module. */
  readonly databaseClock: Reading<Date>
}

export type DisplayStatus =
  | 'NAO_APLICAVEL'
  | 'AGUARDANDO_RULING'
  | 'ASSINATURA_OBSERVADA'
  | 'AGUARDANDO_ASSINATURA_DA_PARTE_EXIGIDA'
  | 'DESCONHECIDO'

export type E0UnknownReason =
  | 'LEITURA_FALHOU'
  | 'SEM_RULING_COMITADO'
  | 'RULING_NULO_OU_REVERTIDO'
  | 'SEM_ROUND'
  | 'ROUND_AMBIGUO'
  | 'DATA_INVALIDA'
  | 'ROUND_FUTURO'
  | 'ROUND_ANTERIOR_AO_RULING'

export interface PartyAbsenceSignals {
  readonly applicable: boolean
  readonly status: DisplayStatus
  readonly signals: {
    /** E0: the round's own creation time on the application clock. NAO_OBSERVADO is never produced for E0. */
    readonly s0RoundCommitted: Signal<{ readonly roundId: string; readonly at: string }>
    readonly s1RequiredSignature: Signal<{ readonly signedBy: readonly string[] }>
    readonly s3DatabaseClock: Signal<{ readonly at: string }>
    readonly s4ChainTip: Signal<{ readonly height: number }>
    readonly s5FundingOutpoint: Signal<OutpointSnapshot>
    readonly s7Ruling: Signal<{ readonly ruling: string; readonly appealRound: number }>
    readonly s9ArbiterWithoutRuling: Signal<{ readonly arbiterId: string | null }>
    readonly s10RequiredKeys: Signal<{ readonly required: readonly string[] }>
    /** Informative only. */
    readonly s6RecordedFee: Signal<{ readonly recordedMinerFeeSats: number; readonly obsolescenceEvaluated: false }>
    readonly s8Retirements: Signal<{ readonly count: number; readonly lastRetiredAt: string }>
  }
  /** Two separate intervals, both on the application clock; `null` when not derivable. Never merged. */
  readonly intervals: {
    readonly sinceCurrentRoundMs: number | null
    readonly sinceRulingMs: number | null
  }
  readonly disclosure: typeof PARTY_ABSENCE_DISCLOSURE
}

/** Approved text (CTO Despacho 010/012, GK documental GO): shown with every response. */
export const PARTY_ABSENCE_DISCLOSURE = {
  timeIndicator:
    'The time shown comes from the application clock, which the operator controls. It only measures how long the current round exists and how long ago the ruling was committed. It does NOT prove that a party is unavailable: a signature not observed is an operational signal, never a conclusion about the party, and it never authorizes any action on the funds.',
  limitation:
    'A MULTISIG escrow is a 2-of-3 script (buyer, seller, arbiter) with no time condition. If the party required by the decided outcome (the buyer for a release or a split, the seller for a refund) can never sign again, the decided outcome cannot be executed through Sails, and Sails does not move funds because time passed.',
  arbiterKey:
    'The arbiter key belongs to the node operator. The operator together with one of the parties can therefore build and sign a different transaction outside the Sails software; the 2-of-3 script does not restrict the outputs, and that the software only builds the decided outcome for disputed rounds is a software and trust guarantee, not a property of the script.',
} as const

const undetermined = <T = undefined>(reason: string): Signal<T> => ({ state: 'DESCONHECIDO', reason })

function validDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime())
}

/** The dispute counts as "ruled" only with status RESOLVED, a ruling, a verified-and-persisted signature and a commit time. */
function isRuled(d: DisputeSnapshot): boolean {
  return d.status === 'RESOLVED' && d.ruling !== null && d.authoritySignature !== null && d.resolvedAt !== null
}

interface E0Result {
  readonly signal: Signal<{ readonly roundId: string; readonly at: string }>
  readonly round: RoundSnapshot | null
}

function evaluateE0(input: PartyAbsenceInput): E0Result {
  const fail = (reason: E0UnknownReason): E0Result => ({ signal: undetermined(reason), round: null })
  if (!input.dispute.ok || !input.rounds.ok) return fail('LEITURA_FALHOU')
  const dispute = input.dispute.value
  if (dispute === null || dispute.status !== 'RESOLVED') return fail('SEM_RULING_COMITADO')
  if (!isRuled(dispute)) return fail('RULING_NULO_OU_REVERTIDO')
  const resolvedAt = dispute.resolvedAt as Date

  const generation = input.rounds.value.filter((r) => r.disputeId === dispute.id && r.rulingAppealRound === dispute.appealRound)
  if (generation.length === 0) return fail('SEM_ROUND')
  if (generation.length > 1) return fail('ROUND_AMBIGUO')
  const round = generation[0]

  if (!validDate(round.createdAt) || !validDate(resolvedAt) || !validDate(input.nowApp)) return fail('DATA_INVALIDA')
  // Rule 3: not in the future, on the SAME (application) clock. No database clock is consulted.
  if (round.createdAt.getTime() > input.nowApp.getTime()) return fail('ROUND_FUTURO')
  // Rule 4: not before the ruling, both on the application clock.
  if (round.createdAt.getTime() < resolvedAt.getTime()) return fail('ROUND_ANTERIOR_AO_RULING')

  return { signal: { state: 'OBSERVADO', value: { roundId: round.id, at: round.createdAt.toISOString() } }, round }
}

export function evaluatePartyAbsenceSignals(input: PartyAbsenceInput): PartyAbsenceSignals {
  const e0 = evaluateE0(input)
  const dispute = input.dispute.ok ? input.dispute.value : null
  const generationRound = e0.round

  // S7 - ruling and generation.
  let s7: Signal<{ readonly ruling: string; readonly appealRound: number }>
  if (!input.dispute.ok) s7 = undetermined('LEITURA_FALHOU')
  else if (dispute === null) s7 = { state: 'NAO_OBSERVADO', reason: 'SEM_DISPUTA' }
  else if (isRuled(dispute)) s7 = { state: 'OBSERVADO', value: { ruling: dispute.ruling as string, appealRound: dispute.appealRound } }
  else s7 = { state: 'NAO_OBSERVADO', reason: 'SEM_RULING_COMITADO' }

  // S9 - an arbiter without a ruling.
  let s9: Signal<{ readonly arbiterId: string | null }>
  if (!input.dispute.ok) s9 = undetermined('LEITURA_FALHOU')
  else if (dispute === null) s9 = { state: 'NAO_OBSERVADO', reason: 'SEM_DISPUTA' }
  else if (dispute.status !== 'RESOLVED') s9 = { state: 'OBSERVADO', value: { arbiterId: dispute.arbiterId } }
  else s9 = { state: 'NAO_OBSERVADO', reason: 'RULING_COMITADO' }

  // S1 - a signature of a required signer on the live round. Only reported absent when E0 is observed.
  let s1: Signal<{ readonly signedBy: readonly string[] }>
  if (e0.signal.state !== 'OBSERVADO' || generationRound === null) s1 = undetermined('E0_DESCONHECIDO')
  else {
    const signedBy = generationRound.signatures.map((s) => s.participantId).filter((p) => generationRound.requiredSigners.includes(p))
    s1 = signedBy.length > 0 ? { state: 'OBSERVADO', value: { signedBy } } : { state: 'NAO_OBSERVADO' }
  }

  // S10 - every required signer has a registered key (capacity, not presence).
  let s10: Signal<{ readonly required: readonly string[] }>
  if (!input.keys.ok || !input.rounds.ok) s10 = undetermined('LEITURA_FALHOU')
  else if (generationRound === null) s10 = undetermined('SEM_ROUND_DA_GERACAO')
  else {
    const registered = new Set(input.keys.value.filter((k) => k.role === 'buyer' || k.role === 'seller').map((k) => k.participantId))
    const missing = generationRound.requiredSigners.filter((p) => !registered.has(p))
    s10 = missing.length === 0
      ? { state: 'OBSERVADO', value: { required: generationRound.requiredSigners } }
      : { state: 'NAO_OBSERVADO', reason: 'CHAVE_NAO_REGISTRADA' }
  }

  // S6 - informative: the recorded miner fee; obsolescence against a live fee rate is NOT evaluated here.
  let s6: Signal<{ readonly recordedMinerFeeSats: number; readonly obsolescenceEvaluated: false }>
  if (generationRound === null) s6 = undetermined('SEM_ROUND_DA_GERACAO')
  else if (generationRound.minerFeeSats === null) s6 = undetermined('SEM_TAXA_REGISTRADA')
  else s6 = { state: 'OBSERVADO', value: { recordedMinerFeeSats: generationRound.minerFeeSats, obsolescenceEvaluated: false } }

  // S8 - informative: cooperative rounds that this escrow's rulings superseded.
  let s8: Signal<{ readonly count: number; readonly lastRetiredAt: string }>
  if (!input.retirements.ok) s8 = undetermined('LEITURA_FALHOU')
  else {
    const valid = input.retirements.value.filter((r) => validDate(r.retiredAt))
    if (valid.length === 0) s8 = { state: 'NAO_OBSERVADO' }
    else {
      const last = valid.reduce((a, b) => (a.retiredAt.getTime() >= b.retiredAt.getTime() ? a : b))
      s8 = { state: 'OBSERVADO', value: { count: valid.length, lastRetiredAt: last.retiredAt.toISOString() } }
    }
  }

  // S3 - the database clock: context only, copied through, never compared with anything.
  const s3: Signal<{ readonly at: string }> = !input.databaseClock.ok || !validDate(input.databaseClock.value)
    ? undetermined(input.databaseClock.ok ? 'DATA_INVALIDA' : input.databaseClock.reason)
    : { state: 'OBSERVADO', value: { at: input.databaseClock.value.toISOString() } }

  // S4 / S5 - chain context.
  const s4: Signal<{ readonly height: number }> = !input.chainTipHeight.ok
    ? undetermined(input.chainTipHeight.reason)
    : Number.isFinite(input.chainTipHeight.value) ? { state: 'OBSERVADO', value: { height: input.chainTipHeight.value } } : undetermined('ALTURA_INVALIDA')
  let s5: Signal<OutpointSnapshot>
  if (!input.outpoint.ok) s5 = undetermined(input.outpoint.reason)
  else if (input.outpoint.value === 'NO_VOUT') s5 = undetermined('SEM_VOUT_LEGADO')
  else s5 = { state: 'OBSERVADO', value: input.outpoint.value }

  // Two separate intervals, both on the application clock (never merged with each other or with S3).
  const nowMs = validDate(input.nowApp) ? input.nowApp.getTime() : null
  const roundMs = e0.signal.state === 'OBSERVADO' && generationRound !== null ? generationRound.createdAt.getTime() : null
  const resolvedMs = dispute !== null && dispute.resolvedAt !== null && validDate(dispute.resolvedAt) ? dispute.resolvedAt.getTime() : null
  const interval = (fromMs: number | null): number | null => (nowMs === null || fromMs === null || fromMs > nowMs ? null : nowMs - fromMs)
  const intervals = { sinceCurrentRoundMs: interval(roundMs), sinceRulingMs: interval(resolvedMs) }

  // The display status. "Waiting for the required party's signature" only when E0, the ruling and S1 are all observed.
  let status: DisplayStatus
  if (!input.applicable) status = 'NAO_APLICAVEL'
  else if (!input.dispute.ok) status = 'DESCONHECIDO'
  else if (dispute === null) status = 'NAO_APLICAVEL'
  else if (s7.state === 'NAO_OBSERVADO') status = 'AGUARDANDO_RULING'
  else if (s7.state === 'DESCONHECIDO' || e0.signal.state !== 'OBSERVADO') status = 'DESCONHECIDO'
  else if (s1.state === 'OBSERVADO') status = 'ASSINATURA_OBSERVADA'
  else if (s1.state === 'NAO_OBSERVADO') status = 'AGUARDANDO_ASSINATURA_DA_PARTE_EXIGIDA'
  else status = 'DESCONHECIDO'

  return {
    applicable: input.applicable,
    status,
    signals: {
      s0RoundCommitted: e0.signal,
      s1RequiredSignature: s1,
      s3DatabaseClock: s3,
      s4ChainTip: s4,
      s5FundingOutpoint: s5,
      s7Ruling: s7,
      s9ArbiterWithoutRuling: s9,
      s10RequiredKeys: s10,
      s6RecordedFee: s6,
      s8Retirements: s8,
    },
    intervals,
    disclosure: PARTY_ABSENCE_DISCLOSURE,
  }
}
