/**
 * FeePolicyVersionRepository — Missão 11 Fase 2.2 economic accounting
 * foundation.
 *
 * Structural foundation ONLY — see fee-policy.service.ts's own header for
 * the full scope disclaimer (no real rate/split is chosen anywhere in this
 * file; every value is caller-supplied).
 *
 * Deliberately narrow (Fase 2.1 §1 / Fase 2.2 §2 decision): no generic
 * update() exists anywhere in this interface. `create()` writes a DRAFT row
 * whose economic fields are freely re-creatable only by discarding and
 * re-creating the DRAFT (there is no updateDraft() either — a DRAFT row is
 * cheap to delete and recreate, and not exposing any update path at all is
 * the simplest way to guarantee the repository itself can never become the
 * accidental backdoor this design exists to close). `publish()` and
 * `retire()` are the ONLY two methods that ever touch an existing row, and
 * each touches only the columns its own name implies (status +
 * publishedAt/retiredAt) — never the economic columns. This mirrors
 * EscrowRepository's own one-named-method-per-mutation discipline exactly.
 *
 * This repository is the FIRST of two independent immutability layers
 * (Fase 2.1 §1 decision D): the second is a real PostgreSQL BEFORE UPDATE
 * trigger (see <timestamp>_add_fee_policy_versioning_foundation/migration.sql)
 * that rejects a raw SQL UPDATE touching the economic columns once
 * status != 'DRAFT', independent of this application entirely. Proven
 * directly against a real Postgres instance — see Missão 11 Fase 2.2's own
 * report.
 */
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'

type FeePolicyVersionRow = NonNullable<Awaited<ReturnType<typeof prisma.feePolicyVersion.findUnique>>>

export interface CreateDraftFeePolicyVersionData {
  label: string
  railScope: string
  protocolFeeRate: Prisma.Decimal | string
  payerModel: 'SELLER_PAYS'
  economicBasis: 'SELLER_DELIVERED_VALUE'
  // Missão 11 Fase 7.3.1 §F — real gap closed: publish()'s own validation
  // (fee-policy.service.ts) has always required this to be a positive
  // integer before a policy can go live, but this create() input never
  // had a field for it at all — every draft created through this
  // repository's own real method was structurally unpublishable, with no
  // update() to fix it afterward either (this file's own header comment
  // on why no update() exists). Required, no default — same "never
  // chosen here" discipline as protocolFeeRate above; every caller must
  // supply a real decision.
  requiredConfirmations: number
  // Missão 11 Fase 7.2 (CTO decision, §I) — no longer normative inputs for
  // a NEW policy's economics (DistributionPolicyVersion alone determines
  // allocation now); optional, matching the schema's own nullable columns.
  nodeOperatorPct?: Prisma.Decimal | string
  treasuryPct?: Prisma.Decimal | string
  walletRebatePct?: Prisma.Decimal | string
  arbitratorReservePct?: Prisma.Decimal | string
  smallTradeRule?: Prisma.InputJsonValue
  triggerSemantics?: Prisma.InputJsonValue
  /** G3: the signed policy document, frozen with the row once it leaves DRAFT. Requiring it to publish comes with D-E1. */
  signedDocument?: Prisma.InputJsonValue
  createdBy: string
}

export interface FeePolicyVersionRepository {
  /** Always writes status = DRAFT — the only status create() can ever produce. */
  create(input: CreateDraftFeePolicyVersionData): Promise<FeePolicyVersionRow>

  findById(id: string): Promise<FeePolicyVersionRow | null>

  /** fee-policy.service.ts's publishFeePolicyVersion()'s own shape — the
   *  currently PUBLISHED version(s) for a given rail, most-recent first.
   *  **Corrected 2026-08-23 (Missão 11 Fase 7.2)** — this comment
   *  previously said more than one PUBLISHED row per rail "is not
   *  prevented at this layer." That's stale: the real Postgres partial
   *  unique index `fee_policy_versions_single_published_per_rail_key`
   *  (migration 20260823182951) now makes it structurally impossible at
   *  the database level. This method may still, in principle, return more
   *  than one row for a legacy/corrupt/raw-SQL-bypass state — callers must
   *  not blindly take index 0 (see FeePolicyService.findLivePolicyForRail()'s
   *  own fail-closed handling). */
  findPublishedForRail(railScope: string): Promise<FeePolicyVersionRow[]>

  /** DRAFT -> PUBLISHED. Touches status + publishedAt only — never an economic column.
   *  Caller (fee-policy.service.ts) is responsible for structural validation
   *  BEFORE calling this; this method itself does not re-validate, matching
   *  the "business logic stays in the service, persistence stays here" split
   *  every other repository in this module already follows. */
  publish(id: string): Promise<FeePolicyVersionRow>

  /** PUBLISHED -> RETIRED. Touches status + retiredAt only. */
  retire(id: string): Promise<FeePolicyVersionRow>
}

class PrismaFeePolicyVersionRepository implements FeePolicyVersionRepository {
  async create(input: CreateDraftFeePolicyVersionData) {
    return prisma.feePolicyVersion.create({
      data: {
        label: input.label,
        railScope: input.railScope,
        status: 'DRAFT',
        protocolFeeRate: input.protocolFeeRate,
        payerModel: input.payerModel,
        economicBasis: input.economicBasis,
        requiredConfirmations: input.requiredConfirmations,
        nodeOperatorPct: input.nodeOperatorPct,
        treasuryPct: input.treasuryPct,
        walletRebatePct: input.walletRebatePct,
        arbitratorReservePct: input.arbitratorReservePct,
        smallTradeRule: input.smallTradeRule ?? {},
        triggerSemantics: input.triggerSemantics ?? {},
        signedDocument: input.signedDocument,
        createdBy: input.createdBy,
      },
    })
  }

  async findById(id: string) {
    return prisma.feePolicyVersion.findUnique({ where: { id } })
  }

  async findPublishedForRail(railScope: string) {
    return prisma.feePolicyVersion.findMany({
      where: { railScope, status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
    })
  }

  async publish(id: string) {
    return prisma.feePolicyVersion.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    })
  }

  async retire(id: string) {
    return prisma.feePolicyVersion.update({
      where: { id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    })
  }
}

export const feePolicyVersionRepository: FeePolicyVersionRepository = new PrismaFeePolicyVersionRepository()
