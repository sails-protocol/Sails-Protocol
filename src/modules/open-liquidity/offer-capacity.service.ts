// M-1b: sets the capacity of a LOGICAL Offer from an owner-signed declaration (sails-offer-capacity-v1). The SIGNATURE is the
// authorization; the authenticated session must additionally belong to the same key (defense in depth), and a session alone
// never changes a capacity. Buyer, integrator and CommitmentPair fields have no path here.
import { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { ForbiddenError, ValidationError } from '../../common/errors'
import { config } from '../../config'
import { offerEnvelopeRepository } from './offer-envelope-repository'
import { verifyOfferCapacity, SignedOfferCapacityDeclaration } from './offer-capacity-declaration'

export interface DeclareCapacityInput {
  /** users.publicKey of the authenticated session (the route resolves it from participantId). */
  sessionPublicKey: string
  declaration: SignedOfferCapacityDeclaration
  /** Network/environment of THIS node; defaults to the configured multisig network. */
  networkId?: string
}

export async function declareOfferCapacity(input: DeclareCapacityInput): Promise<{ capacityRevision: number; capacityTotal: string }> {
  const d = input.declaration
  const verdict = verifyOfferCapacity(d, input.networkId ?? config.multisig.network)
  if (!verdict.valid) throw new ValidationError(`capacity declaration refused: ${verdict.reason}`)
  if (input.sessionPublicKey !== d.ownerPublicKey) throw new ForbiddenError('the session does not belong to the declaring owner key')

  // The Offer must exist and be resolved for this identity, in the unit the declaration names.
  const latest = await offerEnvelopeRepository.getLatest(d.ownerPublicKey, d.logicalOfferId)
  if (latest.status !== 'RESOLVED') throw new ValidationError(`the Offer is not resolved for this identity (${latest.status})`)
  if (latest.row.asset !== d.asset) throw new ValidationError('the declared asset differs from the Offer asset')

  return prisma.$transaction(async (tx) => {
    // Resolve-and-lock in one statement; create the row on first declaration (ON CONFLICT then lock, so two first
    // declarations also serialize on the row).
    await tx.$executeRaw`INSERT INTO "offer_capacity" ("ownerPublicKey","logicalOfferId","capacityRevision") VALUES (${d.ownerPublicKey}, ${d.logicalOfferId}, 0) ON CONFLICT DO NOTHING`
    const rows = await tx.$queryRaw<Array<{ capacityRevision: number }>>`SELECT "capacityRevision" FROM "offer_capacity" WHERE "ownerPublicKey" = ${d.ownerPublicKey} AND "logicalOfferId" = ${d.logicalOfferId} FOR UPDATE`
    const current = rows[0]?.capacityRevision ?? 0
    if (d.capacityRevision <= current) throw new ValidationError(`capacityRevision must be greater than the current ${current} (anti-replay)`)
    const { signature, ...content } = d
    await tx.$executeRaw`UPDATE "offer_capacity" SET "capacityTotal" = ${new Prisma.Decimal(d.capacityTotal)}, "capacityRevision" = ${d.capacityRevision}, "declaredAt" = ${new Date(d.issuedAt)}, "declaration" = ${JSON.stringify(content)}::jsonb, "declarationSignature" = ${signature}, "updatedAt" = clock_timestamp() WHERE "ownerPublicKey" = ${d.ownerPublicKey} AND "logicalOfferId" = ${d.logicalOfferId}`
    return { capacityRevision: d.capacityRevision, capacityTotal: d.capacityTotal }
  })
}
