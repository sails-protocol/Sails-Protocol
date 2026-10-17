/**
 * FeeCollectionEvidenceRepository — Missão 11 Fase 2.2 economic accounting
 * foundation.
 *
 * Append-only, mirroring EscrowEvent's own discipline exactly (Fase 2.1 §8 /
 * Fase 2.2 §7): this interface exposes create() and reads only — there is
 * no update()/delete() method anywhere here, by design, not by omission. A
 * correction (RBF replacement, reorg, drop) is always recorded as a NEW row
 * referencing the same feeObligationId, never an edit to a prior one, so
 * the full forensic history of what was believed true at each point in time
 * is permanently preserved.
 *
 * No blockchain watcher, no polling, no external calls — this is pure
 * persistence of caller-supplied facts (Fase 2.2 §7's explicit scope).
 */
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'

type FeeCollectionEvidenceRow = NonNullable<Awaited<ReturnType<typeof prisma.feeCollectionEvidence.findFirst>>>

export type FeeCollectionEvidenceKind = 'BROADCAST' | 'CONFIRMED' | 'REPLACED' | 'DROPPED' | 'REORGED_OUT' | 'ALTERNATE_SPEND'

export interface RecordEvidenceInput {
  feeObligationId: string
  kind: FeeCollectionEvidenceKind
  txid?: string
  vout?: number
  scriptPubKey?: string
  amount?: Prisma.Decimal | string
  confirmedAtHeight?: number
  note?: string
  // Missão 11 Fase 7.2 — meaningful ONLY for kind='CONFIRMED'; resolved
  // once by fee-collection-recognition.service.ts's recognizeConfirmation()
  // and passed here as part of the SAME insert that creates the CONFIRMED
  // row (never set via a later, separate call) — see the schema's own
  // comment on FeeCollectionEvidence.distributionPolicyVersionId for the
  // full immutability/binding-time reasoning. `null` is a real, permanent,
  // legitimate value (zero DistributionPolicyVersion was PUBLISHED at
  // confirmation time) — explicitly distinct from `undefined` (this field
  // simply wasn't relevant, e.g. for a BROADCAST row).
  distributionPolicyVersionId?: string | null
}

export interface FeeCollectionEvidenceRepository {
  // Missão 11 Fase 7.2.1 — optional `tx`: when the caller already holds an
  // open `prisma.$transaction` client, passing it here inserts this row
  // inside that same transaction instead of a new top-level one.
  // fee-collection-recognition.service.ts's recognizeConfirmation() uses
  // this to commit the CONFIRMED-evidence insert atomically with the
  // IN_PROGRESS -> COLLECTED transition — proven necessary by direct
  // adversarial reproduction (a crash between two separate top-level
  // writes, followed by the real periodic sweep job's automatic retry,
  // could produce two CONFIRMED rows for one on-chain confirmation, each
  // frozen to a different DistributionPolicyVersion if a policy rotation
  // happened in between). Additive — every existing caller omits it and
  // gets the exact previous behavior.
  record(input: RecordEvidenceInput, tx?: Prisma.TransactionClient): Promise<FeeCollectionEvidenceRow>
  // Issue #245 - optional `tx`, same additive reason record()'s own comment documents:
  // recordBroadcastAndAdvance() needs to read prior evidence inside the same transaction it will
  // conditionally write to. Every existing caller omits it and gets the exact previous behavior.
  listForObligation(feeObligationId: string, tx?: Prisma.TransactionClient): Promise<FeeCollectionEvidenceRow[]>
}

class PrismaFeeCollectionEvidenceRepository implements FeeCollectionEvidenceRepository {
  async record(input: RecordEvidenceInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.feeCollectionEvidence.create({
      data: {
        feeObligationId: input.feeObligationId,
        kind: input.kind,
        txid: input.txid,
        vout: input.vout,
        scriptPubKey: input.scriptPubKey,
        amount: input.amount,
        confirmedAtHeight: input.confirmedAtHeight,
        note: input.note,
        distributionPolicyVersionId: input.distributionPolicyVersionId,
      },
    })
  }

  async listForObligation(feeObligationId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.feeCollectionEvidence.findMany({
      where: { feeObligationId },
      orderBy: { recordedAt: 'asc' },
    })
  }
}

export const feeCollectionEvidenceRepository: FeeCollectionEvidenceRepository = new PrismaFeeCollectionEvidenceRepository()
