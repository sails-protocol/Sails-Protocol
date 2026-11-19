/**
 * party-absence-signals.service.ts - F32, alternative A: the READ-ONLY reader that feeds the pure evaluator in
 * `party-absence-signals.ts`. It only reads (Prisma `find*` and explorer GETs); it has no write path, never calls a
 * transaction builder, never broadcasts and never touches an economic state.
 *
 * Every read is wrapped so a failure becomes an explicit `{ ok: false }` input (DESCONHECIDO downstream), never an
 * empty result and never an exception that hides the other signals.
 */
import { prisma } from '../../common/database'
import { NotFoundError } from '../../common/errors'
import { fetchChainTipHeight, fetchOutpointSpendStatus } from './multisig.provider'
import {
  evaluatePartyAbsenceSignals,
  type PartyAbsenceInput,
  type PartyAbsenceSignals,
  type Reading,
} from './party-absence-signals'

async function readOnce<T>(fn: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch {
    // Deliberately generic: the reason is shown to a trade party, never the internal error text.
    return { ok: false, reason: 'LEITURA_FALHOU' }
  }
}

export interface PartyAbsenceReaders {
  readonly escrow: (escrowId: string) => Promise<{ type: string; txLockId: string | null; txLockVout: number | null } | null>
  readonly input: (escrowId: string, escrow: { txLockId: string | null; txLockVout: number | null }) => Promise<Omit<PartyAbsenceInput, 'nowApp' | 'applicable'>>
}

/**
 * S3 (the database clock) is CONTEXT ONLY: it is read here and copied to the output untouched; no decision in the
 * evaluator receives it. This is the only place in the feature that names the database clock.
 */
async function readDatabaseClock(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return rows[0].now
}

const defaultReaders: PartyAbsenceReaders = {
  escrow: (escrowId) => prisma.escrow.findUnique({ where: { id: escrowId }, select: { type: true, txLockId: true, txLockVout: true } }),

  input: async (escrowId, escrow) => {
    const dispute = await readOnce(() =>
      prisma.dispute.findFirst({
        where: { escrowId },
        orderBy: { appealRound: 'desc' },
        select: { id: true, status: true, ruling: true, appealRound: true, arbiterId: true, authoritySignature: true, resolvedAt: true },
      }),
    )

    // One round per escrow (`escrowId` is unique). Read twice and compare the ids: a round replaced between the two
    // reads makes the reading fail (DESCONHECIDO) instead of mixing two rounds.
    const rounds = await readOnce(async () => {
      const first = await prisma.escrowPendingTransaction.findUnique({
        where: { escrowId },
        select: {
          id: true, createdAt: true, kind: true, requiredSigners: true, disputeId: true, rulingAppealRound: true, minerFeeSats: true,
          signatures: { select: { participantId: true } },
        },
      })
      const second = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId }, select: { id: true } })
      if ((first?.id ?? null) !== (second?.id ?? null)) throw new Error('round replaced during the read')
      return first === null ? [] : [first]
    })

    const keys = await readOnce(() => prisma.escrowParticipantKey.findMany({ where: { escrowId }, select: { participantId: true, role: true } }))
    const retirements = await readOnce(() => prisma.escrowPendingRoundRetirement.findMany({ where: { escrowId }, select: { signedBy: true, retiredAt: true } }))

    const outpoint = await readOnce(async () => {
      if (!escrow.txLockId || escrow.txLockVout === null || escrow.txLockVout === undefined) return 'NO_VOUT' as const
      return fetchOutpointSpendStatus(escrow.txLockId, escrow.txLockVout)
    })
    const chainTipHeight = await readOnce(() => fetchChainTipHeight())
    const databaseClock = await readOnce(() => readDatabaseClock())

    return { dispute, rounds, keys, retirements, outpoint, chainTipHeight, databaseClock }
  },
}

/**
 * Derives the operational signals for one escrow. `nowApp` is the application clock (injected for tests). Throws
 * only NotFoundError for an unknown escrow; every other failure is a DESCONHECIDO signal.
 */
export async function getPartyAbsenceSignals(
  escrowId: string,
  readers: PartyAbsenceReaders = defaultReaders,
  nowApp: Date = new Date(),
): Promise<PartyAbsenceSignals> {
  const escrow = await readers.escrow(escrowId)
  if (!escrow) throw new NotFoundError('Escrow', escrowId)

  // Nothing here applies to a rail that is not MULTISIG: no reads, no explorer calls.
  if (escrow.type !== 'MULTISIG') {
    const none = { ok: true as const, value: null }
    return evaluatePartyAbsenceSignals({
      nowApp,
      applicable: false,
      dispute: none,
      rounds: { ok: true, value: [] },
      keys: { ok: true, value: [] },
      retirements: { ok: true, value: [] },
      outpoint: { ok: false, reason: 'NAO_APLICAVEL' },
      chainTipHeight: { ok: false, reason: 'NAO_APLICAVEL' },
      databaseClock: { ok: false, reason: 'NAO_APLICAVEL' },
    })
  }

  const input = await readers.input(escrowId, escrow)
  return evaluatePartyAbsenceSignals({ nowApp, applicable: true, ...input })
}
