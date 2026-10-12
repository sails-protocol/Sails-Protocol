/**
 * Sails OpenSettlement routes — API_REFERENCE.md section 4 (escrow) plus
 * a dispute-resolve route that section doesn't document yet (added here
 * per CONTRIBUTING.md's rule to document new routes, not just ship them
 * — see the API_REFERENCE.md edit alongside this file).
 *
 * The escrow.service.ts methods this wraps already existed and are
 * complete (BACKLOG.md P2: "most complete module today") — this file is
 * pure HTTP wiring, no new business logic.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ESCROW_TYPE_VALUES, ASSET_TYPE_VALUES } from '@satsails/p2p-schemas'
import { escrowService } from './escrow.service'
import { getDisputeService } from './dispute.service'
import { loadDisputeRulingRecord } from './dispute-outcome'
import { marketArbitrationProvider } from './market-arbitration.provider'
import { paymentAccountService } from './payment-account.service'
import { readEconomicPolicy } from './economic-policy'
import { payoutAddressService } from './payout-address.service'
import { tradeService } from '../open-p2p/trade.service'
import { requireAuth } from '../../common/middleware/auth'
import type { AuthenticatedRequest } from '../../common/middleware/auth'
import { createSharedRateLimit } from '../../common/middleware/redis-rate-limit'
import { config } from '../../config'
import { ForbiddenError, NotFoundError } from '../../common/errors'
import { docsOnlySchema } from '../../common/openapi'
import { MAX_PAGE_LIMIT } from '../../common/pagination'
import { positiveDecimalString } from '../../common/validation'
import { evidenceDescriptorInputSchema } from './evidence-descriptor-schema'
import { cancelResidualRecovery, getResidualRecovery, observeResidualValue, proposeResidualRecovery, submitResidualRecoverySignature } from './multisig-residual-recovery'

// CTO_DUE_DILIGENCE_REPORT.md A-SEC-05, closed 2026-08-08 — see
// config/index.ts's own comment on `rateLimit.criticalMax` for the full
// reasoning. Shared preHandler (not inlined per route) so all three
// dispute/arbitration routes below stay in sync if this is ever tuned.
// Missão 08B Fase 9 — moved from @fastify/rate-limit's per-route local
// store to a Redis-shared counter (redis-rate-limit.ts) so the limit is
// enforced across instances, not per-instance; the global plugin
// registration in app.ts still applies underneath, untouched.
const criticalRateLimit = createSharedRateLimit({
  max: config.rateLimit.criticalMax,
  windowMs: config.rateLimit.criticalWindowMs,
  keyPrefix: 'critical',
})

// ─── Schemas ───────────────────────────────────────────────────────────────────
// One zod schema per distinct request body shape — kept inline rather than
// extracted to a shared file because every schema is consumed by exactly one
// route, and the zod error shape already includes the path/field the caller
// failed on (the same shape `src/app.ts`'s setErrorHandler turns into a 400
// VALIDATION_ERROR).

// F5 (docs/TECHNICAL_DEBT_AUDIT.md #52) — type/asset enum values now come
// from @satsails/p2p-schemas's ESCROW_TYPE_VALUES/ASSET_TYPE_VALUES, the
// same canonical arrays packages/sails-sdk's CreateEscrowInput and this
// file's own escrow.service.ts import — a future addition/removal only
// needs to happen in that one shared file. WDK_USDT_EVM and SAFE_GUARD_EVM
// were both real, registered providers (escrow.service.ts's PROVIDERS map)
// once missing from this validator before that consolidation (RFC-020) —
// the exact drift class this shared source now structurally prevents.
// Exported (unlike every other schema in this file) so
// tests/escrowCreationSchemaParity.test.ts can inspect the REAL schema
// object directly — proving parity against the canonical source, not a
// reconstruction of it. No behavior change; visibility only.
export const createEscrowSchema = z.object({
  tradeId: z.string().min(1),
  type: z.enum(ESCROW_TYPE_VALUES).optional(),
  // 2026-08-15 security review — was z.string().min(1) (non-empty only,
  // no positive/finite check); see common/validation.ts's own header
  // comment for why that's the exact Bisq-incident bug class. Positivity
  // is a business rule, not part of the shared structural contract — see
  // packages/sails-p2p-schemas/src/escrow.ts's own header.
  lockedAmount: positiveDecimalString('lockedAmount'),
  asset: z.enum(ASSET_TYPE_VALUES),
  network: z.string().optional(),
  // Master Backlog R5 — accepted-but-inert, same status as releaseSchema's
  // toAddress below: still parsed so existing clients sending it are not
  // a 400, never read. The timelock is DEFAULT_TIMELOCK_HOURS, frozen on
  // the escrow by createEscrow().
  timelockHours: z.number().optional(),
})

// Sails Core Implementation Program M8-R2 (Destination Authority
// Conformance, cooperative path) — `toAddress` is accepted-but-inert here,
// same status `resolveDispute()`'s own `releaseToAddress` already has for
// MULTISIG (see that route's own comment). Kept optional, never required,
// purely so an existing caller that still sends one is not broken by a
// 400 — the route handler below never reads this field. Destination
// Authority belongs to the beneficiary (the buyer) alone, established via
// their own registered PayoutAddress, never via a value the release-
// triggering counterparty supplies in this request body. See
// docs/DESTINATION_AUTHORITY_ARCHITECTURE.md.
const releaseSchema = z.object({
  toAddress: z.string().min(1).optional(),
})

// 33-byte compressed secp256k1 pubkey, hex — same pattern
// escrow.service.ts's submitParticipantKey() validates against.
// Missão 11 Fase 9.1 §4/§5 — capabilityProfile is OPTIONAL on THIS
// request schema (a key submission without it is a well-formed request,
// not a 400) — but omitting it is NOT the same as it being accepted:
// fail-closed since Fase 9.1.1, escrowService.submitParticipantKey()'s
// own commit-gate (capability-profile.ts's findCapabilityCommitBlocker())
// rejects a MULTISIG commit once both keys exist unless BOTH declared a
// known, compatible profile. Unrecognized (but present) values are
// rejected earlier, at submission time (assertKnownCapabilityProfile()).
// "Known profile"/"required for this escrow type" are protocol-vocabulary
// questions, not request-shape ones, hence neither lives in this schema.
const submitKeySchema = z.object({
  pubkey: z.string().regex(/^0[23][0-9a-fA-F]{64}$/, 'must be a 33-byte compressed secp256k1 public key, hex-encoded'),
  capabilityProfile: z.string().min(1).optional(),
})

// Same accepted-but-inert status as releaseSchema.toAddress above — see
// that field's own comment.
const initiateReleaseSchema = z.object({
  toAddress: z.string().min(1).optional(),
})

// PSBT, base64-encoded — same format multisig.provider.ts's
// buildUnsignedRelease()/buildUnsignedRefund() emit and @satsails/p2p-trading-sdk's
// signEscrowPsbt() returns.
const submitTransactionSignatureSchema = z.object({
  signedPsbtBase64: z.string().min(1),
})

// Exported — Issue #266 CTO Gate re-gate. Lets a test prove the real
// HTTP-boundary schema (not a hand-copied duplicate that could silently
// drift) actually preserves `externalReference`/`evidenceReferenceId`
// through Zod's own parse, the same "export for direct testability"
// precedent createEscrowSchema above already establishes in this file.
export const disputeSchema = z.object({
  reason: z.string().min(1),
  evidence: z.array(evidenceDescriptorInputSchema).optional(),
})

const resolveSchema = z.object({
  ruling: z.enum(['RELEASE', 'REFUND', 'SPLIT']),
  releaseToAddress: z.string().optional(),
  // RFC-021 D9 (2026-08-02) — SPLIT-only: seller's payout address and the
  // buyer's share in basis points (0-10000, exclusive of both ends — a
  // real split, not an all-or-nothing RELEASE/REFUND in disguise).
  refundToAddress: z.string().optional(),
  splitBuyerBps: z.number().int().min(1).max(9999).optional(),
  // Missão 13 Fase 2 — INV-12 (Attributed Authority Integrity). Required:
  // the arbiter's own Ed25519 signature (hex) over this exact dispute/
  // escrow/outcome/allocation, produced client-side, and the ISO-8601
  // timestamp bound into that same signature — see
  // arbitration-authority.ts's canonical payload. Never optional; there is
  // no conformant fallback to the bare `ruling` field alone.
  authoritySignature: z.string().min(1),
  authorityIssuedAt: z.string().min(1),
})

// RFC-021 D8
// Exported — see disputeSchema's own identical comment above.
export const submitEvidenceSchema = evidenceDescriptorInputSchema.extend({
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37) — optional; a caller
  // that omits it gets exactly today's behavior. See
  // src/common/idempotency.ts's own header for the full contract.
  idempotencyKey: z.string().min(1).max(200).optional(),
})

// RFC-021 D2 — permissionless arbiter registration.
const registerArbiterSchema = z.object({
  monetaryCollateral: z.string().min(1),
  collateralAsset: z.string().optional(),
})

// RFC-021 D5 — accountHash is computed client-side (@satsails/p2p-trading-sdk's
// hashPaymentAccount()) — the raw PIX key/bank account number is never
// sent here, only its hash.
const registerPaymentAccountSchema = z.object({
  accountHash: z.string().min(1),
  paymentMethod: z.enum(['PIX', 'TED', 'BANK_TRANSFER', 'CRYPTO_DIRECT', 'LIGHTNING_DIRECT', 'CASH', 'OTHER']),
})

// BACKLOG.md's own "Participant payout address" gap, closed 2026-08-04 —
// see payout-address.service.ts's own header comment for the full
// rationale. `asset` intentionally not validated against a stricter
// per-network address format here — that check already lives at the
// point of actual use (multisig.provider.ts's own address parsing,
// wdk-settlement.provider.ts's ethers address validation), not
// duplicated here against a value this route never spends.
const setPayoutAddressSchema = z.object({
  asset: z.string().min(1),
  address: z.string().min(1),
})

// Bounds match dispute.service.ts's listForArbiter() clamp (MAX_PAGE_LIMIT)
// exactly — until this fix, this was the only paginated list endpoint in
// the codebase relying on a service-layer clamp instead of route-level
// zod validation, so an out-of-range limit was silently coerced instead
// of returning 400 VALIDATION_ERROR like every sibling list endpoint
// (trade/reputation/chat/liquidity) already does.
const disputeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

// M10 SDK Adapter — GET .../semantic-record. appealRound is REQUIRED
// (never defaulted to the dispute's current round): this route answers
// "what did Core authorize for THIS specific historical appeal round,"
// a structurally different question from "what is the dispute's ruling
// right now" (GET .../disputes/:id above). Defaulting would silently
// conflate the two — see this route's own header comment below.
const semanticRecordQuerySchema = z.object({
  appealRound: z.coerce.number().int().min(0),
})

const arbiterProfileParamsSchema = z.object({ participantId: z.string().min(1) })

const accountHashParamsSchema = z.object({ accountHash: z.string().min(1) })

// #235 R7C — the trade whose clean completion authorizes the attestation. A selector only: the
// buyer, the bound account and the completion are all read from durable state.
const attestPaymentAccountSchema = z.object({ tradeId: z.string().min(1) })

const payoutAddressParamsSchema = z.object({
  participantId: z.string().min(1),
  asset: z.string().min(1),
})

// ─── Helpers ────────────────────────────────────────────────────────────────────
// Extracted from the original inline blocks to cut ~30 occurrences of the same
// 3-line pattern (`z.object({ id: ... }).parse(...)`, `participantId as string`,
// `reply.code(N).send({ success, data })`). Each is a one-liner with a single
// responsibility — exactly the shape SDK_GUIDE.md and CONTRIBUTING.md ask every
// other route file in this codebase to follow.

/** Path-param schema used by every escrow/dispute/arbitration route below. */
const idParam = z.object({ id: z.string().min(1) })

// #235 R7G F8A — residual value on a MULTISIG script: the outpoint and the destination the participants choose.
const proposeResidualRecoverySchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  vout: z.number().int().min(0),
  destination: z.string().min(1),
})
const residualRecoverySignatureSchema = z.object({ signedPsbtBase64: z.string().min(1) })

/** Pulls the authenticated participantId off the request, set by
 *  requireAuth's preHandler. Cast to string per the same pattern every other
 *  route in src/ uses (typed as `unknown` on the request object itself). */
function participantId(request: unknown): string {
  return (request as { participantId: string }).participantId
}

/** Standard success envelope — every route returns this shape. The real
 *  HTTP status code (201 Created / 200 OK) stays explicit at each call
 *  site via reply.code(); PRODUCTION_READINESS_FIXES.md P0, closed
 *  2026-08-08 — this used to also duplicate it inside the JSON body
 *  (`{ success, data, status }`), which was both redundant and
 *  confusing (a client reading body.status could easily mistake it for
 *  a domain status field, e.g. Escrow.status). */
function success<T>(data: T) {
  return { success: true as const, data }
}

export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/settlement/escrow', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], body: createEscrowSchema }),
  }, async (request, reply) => {
    // F5 (docs/TECHNICAL_DEBT_AUDIT.md #52) — no cast: `body`'s inferred
    // type must structurally satisfy createEscrow()'s CreateEscrowInput
    // parameter, both sourced from @satsails/p2p-schemas. If the two
    // ever diverge, this line fails to compile — the parity proof this
    // fix exists for, not a new mechanism.
    const body = createEscrowSchema.parse(request.body)
    const participantId = (request as AuthenticatedRequest).participantId
    const escrow = await escrowService.createEscrow(body, participantId)
    return reply.code(201).send(success(escrow))
  })

  // Missão 06.8 — corrected from a public read (found in Missão 06.7's
  // route audit: findByIdWithDetails() includes disputes: true, so this
  // route returned Dispute.reason/Dispute.evidence — real, free-text
  // negotiation/dispute content, potentially PII — to anyone who knew or
  // guessed an escrowId, no auth at all). Same class of exposure as the
  // Proof Bundle (Missão 06.6), same fix shape: requireAuth + resource
  // authorization, reusing what already exists rather than a new
  // primitive — tradeService.getTrade() (already used elsewhere in this
  // codebase for a bare fetch) for the buyer/seller check, and the
  // escrow's own already-loaded `disputes` array (no extra query) for
  // the assigned-arbiter case, so an arbiter reviewing a disputed escrow
  // they're assigned to isn't locked out.
  app.get('/v1/settlement/escrow/:id', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const callerId = participantId(request)
    const escrow = await escrowService.getEscrow(id)
    const trade = await tradeService.getTrade(escrow.tradeId)
    const isParty = callerId === trade.buyerId || callerId === trade.sellerId
    const isAssignedArbiter = escrow.disputes.some((d: { arbiterId: string | null }) => d.arbiterId === callerId)
    if (!isParty && !isAssignedArbiter) {
      throw new ForbiddenError(`${callerId} is not authorized to view escrow ${id}`)
    }
    return reply.code(200).send(success(escrow))
  })

  app.post('/v1/settlement/escrow/:id/lock', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const escrow = await escrowService.lockFunds(id, participantId(request))
    return reply.code(200).send(success(escrow))
  })

  // Client-held-keys write path (2026-07-27) — buyer or seller submits
  // only their own public key, generated client-side (@satsails/p2p-trading-sdk's
  // escrow-key module); see escrow.service.ts's submitParticipantKey()
  // and multisig.provider.ts's/lightning-hodl.provider.ts's own header
  // comments for the full custody-model disclosure. Only meaningful for
  // MULTISIG/LIGHTNING_HODL escrows — submitParticipantKey() itself
  // rejects any other type.
  app.post('/v1/settlement/escrow/:id/submit-key', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: submitKeySchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = submitKeySchema.parse(request.body)
    const result = await escrowService.submitParticipantKey(id, participantId(request), body.pubkey, body.capabilityProfile)
    return reply.code(200).send(success(result))
  })

  app.post('/v1/settlement/escrow/:id/payment-sent', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const escrow = await escrowService.markPaymentSent(id, participantId(request))
    return reply.code(200).send(success(escrow))
  })

  // Sails Core Implementation Program M8-R2 (Destination Authority
  // Conformance, cooperative path, 2026-09-11) — this route deliberately
  // parses `releaseSchema` (so a legacy `toAddress` in the request body
  // is accepted, not a 400) but never forwards `body.toAddress` to
  // `escrowService.releaseFunds()`. Forwarding it would let the caller
  // (the seller, per EscrowActions.tsx's own gating — never the buyer,
  // who is the actual beneficiary of a release) unilaterally choose or
  // substitute the buyer's payout destination — exactly Model E,
  // adversarially rejected in docs/DESTINATION_AUTHORITY_ARCHITECTURE.md
  // as "the status quo vulnerability itself." Passing `undefined` here
  // makes `releaseFunds()`'s own `resolvePayoutAddress()` call always
  // resolve the buyer's destination from their own registered
  // `PayoutAddress` (or fail closed with a clear error if none is
  // registered) — the beneficiary-controlled path F′ already requires.
  // `releaseFunds()`'s own `toAddress` parameter is UNCHANGED and still
  // honors an explicit value for its one remaining trusted-internal
  // caller (`dispute.service.ts`'s legacy `applyRuling()`, for the three
  // rails M8-R hasn't migrated yet — a disclosed residual gap, not
  // reintroduced here).
  app.post('/v1/settlement/escrow/:id/release', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: releaseSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    releaseSchema.parse(request.body ?? {})
    const escrow = await escrowService.releaseFunds(id, undefined, participantId(request))
    return reply.code(200).send(success(escrow))
  })

  // Phase 2 client-signature-collection flow (2026-07-27) — real for
  // MULTISIG only; escrowService.initiateRelease() itself rejects any
  // other escrow type with a clear error pointing back to the direct
  // /release route. See escrow.service.ts's own header comment on this
  // method for the full flow.
  // Same M8-R2 conformance fix as /release above, applied to the
  // signature-collection flow (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM) —
  // `body.toAddress` is parsed (accepted, not a 400) but never forwarded.
  // `escrowService.initiateRelease()`'s own resolution therefore always
  // snapshots the buyer's registered PayoutAddress into
  // `EscrowPendingTransaction.toAddress` at this exact moment, before any
  // signature is collected — satisfying "bind before signing," and, since
  // `submitTransactionSignature()` never re-resolves it, "retries and a
  // later PayoutAddress rotation cannot rewrite an already-bound
  // execution" for the same reason M8.5's MULTISIG-disputed binding
  // already relies on.
  app.post('/v1/settlement/escrow/:id/initiate-release', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: initiateReleaseSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    initiateReleaseSchema.parse(request.body ?? {})
    const pending = await escrowService.initiateRelease(id, undefined, participantId(request))
    return reply.code(201).send(success(pending))
  })

  // Mirror of initiate-release above, for refund.
  app.post('/v1/settlement/escrow/:id/initiate-refund', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const pending = await escrowService.initiateRefund(id, participantId(request))
    return reply.code(201).send(success(pending))
  })

  // Each required signer (EscrowPendingTransaction.requiredSigners) calls
  // this once with their own independently-signed copy of the unsigned
  // PSBT. Once every required signer has submitted, the response's
  // `data.complete` flips to true and the escrow has actually transitioned
  // (COMPLETED/REFUNDED) with a real txReleaseId.
  app.post('/v1/settlement/escrow/:id/submit-transaction-signature', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: submitTransactionSignatureSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = submitTransactionSignatureSchema.parse(request.body)
    const result = await escrowService.submitTransactionSignature(id, participantId(request), body.signedPsbtBase64)
    return reply.code(200).send(success(result))
  })

  // #235 R7G F8A — MULTISIG_RESIDUAL_VALUE_RECOVERY_V1: value on an escrow's original script outside its canonical
  // funding outpoint is recovered only by its buyer AND seller together (multisig-residual-recovery.ts). Every route
  // is participant-only; none returns a signed PSBT.
  app.get('/v1/settlement/escrow/:id/residual-value', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    return reply.code(200).send(success(await observeResidualValue(id, participantId(request))))
  })

  app.post('/v1/settlement/escrow/:id/residual-recoveries', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: proposeResidualRecoverySchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = proposeResidualRecoverySchema.parse(request.body)
    return reply.code(201).send(success(await proposeResidualRecovery(id, participantId(request), body)))
  })

  app.get('/v1/settlement/residual-recoveries/:id', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    return reply.code(200).send(success(await getResidualRecovery(id, participantId(request))))
  })

  app.post('/v1/settlement/residual-recoveries/:id/signature', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: residualRecoverySignatureSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = residualRecoverySignatureSchema.parse(request.body)
    return reply.code(200).send(success(await submitResidualRecoverySignature(id, participantId(request), body.signedPsbtBase64)))
  })

  app.post('/v1/settlement/residual-recoveries/:id/cancel', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    return reply.code(200).send(success(await cancelResidualRecovery(id, participantId(request))))
  })

  // Missão 07.6 release-readiness audit — found unauthenticated, same
  // exposure class Missão 06.8 already fixed on GET /v1/settlement/escrow/:id
  // above (this route was simply missed at the time): the pending
  // transaction includes the unsigned PSBT, destination address(es), and
  // every already-submitted signature for a live multisig release/refund/
  // split — real financial data, readable by anyone who knew or guessed
  // an escrowId. Same fix shape as the sibling route: requireAuth +
  // buyer/seller/assigned-arbiter check, reusing escrowService.getEscrow()
  // + tradeService.getTrade() rather than a new authorization primitive.
  app.get('/v1/settlement/escrow/:id/pending-transaction', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const callerId = participantId(request)
    const escrow = await escrowService.getEscrow(id)
    const trade = await tradeService.getTrade(escrow.tradeId)
    const isParty = callerId === trade.buyerId || callerId === trade.sellerId
    const isAssignedArbiter = escrow.disputes.some((d: { arbiterId: string | null }) => d.arbiterId === callerId)
    if (!isParty && !isAssignedArbiter) {
      throw new ForbiddenError(`${callerId} is not authorized to view escrow ${id}'s pending transaction`)
    }
    const pending = await escrowService.getPendingTransaction(id, callerId) // #239D X1 - the caller's own signature only
    return reply.code(200).send(success(pending))
  })

  // RFC-015 — two-person control. Records the calling participant's
  // approval; releaseFunds() above checks escrowService.hasDualApproval()
  // itself (gated behind config.features.requireDualApprovalForRelease)
  // rather than this route enforcing anything directly — this route's
  // only job is recording "who approved," not deciding when release is
  // allowed to proceed.
  app.post('/v1/settlement/escrow/:id/approve-release', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const approval = await escrowService.approveRelease(id, participantId(request))
    const readyToRelease = await escrowService.hasDualApproval(id)
    return reply.code(200).send(success({ ...approval, readyToRelease }))
  })

  // Missão 07.6 — same unauthenticated-sibling-route fix as
  // pending-transaction above; who has approved a release is trade-party/
  // arbiter-scoped information, not public.
  app.get('/v1/settlement/escrow/:id/release-approvals', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const callerId = participantId(request)
    const escrow = await escrowService.getEscrow(id)
    const trade = await tradeService.getTrade(escrow.tradeId)
    const isParty = callerId === trade.buyerId || callerId === trade.sellerId
    const isAssignedArbiter = escrow.disputes.some((d: { arbiterId: string | null }) => d.arbiterId === callerId)
    if (!isParty && !isAssignedArbiter) {
      throw new ForbiddenError(`${callerId} is not authorized to view escrow ${id}'s release approvals`)
    }
    const approvals = await escrowService.getReleaseApprovals(id)
    const readyToRelease = await escrowService.hasDualApproval(id)
    return reply.code(200).send(success({ approvals, readyToRelease }))
  })

  // Delegates to dispute.service.ts's raiseDispute (persists a Dispute
  // row + assigns an arbiter + notifies), not escrowService.openDispute
  // directly — that's the lower-level state transition raiseDispute
  // itself calls as its first step.
  app.post('/v1/settlement/escrow/:id/dispute', {
    preHandler: [criticalRateLimit, requireAuth],
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: disputeSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = disputeSchema.parse(request.body)
    const callerId = participantId(request)
    const escrow = await escrowService.getEscrow(id)
    const trade = await tradeService.getTrade(escrow.tradeId)

    // Authority boundary must precede arbitration deployment details.
    // getDisputeService() intentionally fails clearly when trusted-list
    // arbitration is unconfigured, but a caller who is not a party to
    // this trade must not reach that configuration disclosure first.
    // raiseDispute() repeats this check as the service-layer authority
    // guard; this route-level check is deliberately defense-in-depth for
    // failure ordering at the public HTTP boundary.
    if (callerId !== trade.buyerId && callerId !== trade.sellerId) {
      throw new ForbiddenError(`${callerId} is not a party to trade ${trade.id}`)
    }

    const dispute = await getDisputeService().raiseDispute(
      escrow.tradeId,
      callerId,
      body.reason,
      body.evidence as any
    )
    return reply.code(200).send(success(dispute))
  })

  // Missão 11 Fase 7.3.3 §D — the explicit, guided seller-only recovery
  // action for an escrow whose timelock genuinely expired (status
  // EXPIRED). A thin, scenario-specific wrapper around
  // dispute.service.ts's own raiseDispute() (see initiateExpiryRecovery()'s
  // own doc comment for the full authority reasoning) — invents no new
  // settlement mechanism, no new signature, no server-held key.
  app.post('/v1/settlement/escrow/:id/initiate-expiry-recovery', {
    preHandler: [criticalRateLimit, requireAuth],
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const dispute = await getDisputeService().initiateExpiryRecovery(id, participantId(request))
    return reply.code(200).send(success(dispute))
  })

  app.post('/v1/settlement/escrow/:id/refund', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const escrow = await escrowService.refundFunds(id, participantId(request))
    return reply.code(200).send(success(escrow))
  })

  // UI-audit gap (2026-08-03) — the operator/arbiter console had every
  // dispute *action* (resolve/appeal/evidence/contest, all below) but no
  // way to discover a disputeId to call them with. Scoped to the calling
  // participant's own arbiterId — see dispute.service.ts's
  // listForArbiter() for why this ignores any client-supplied arbiterId
  // rather than trusting a query param.
  app.get('/v1/settlement/disputes', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], querystring: disputeListQuerySchema }),
  }, async (request, reply) => {
    const { limit, offset } = disputeListQuerySchema.parse(request.query)
    const result = await getDisputeService().listForArbiter(participantId(request), { limit, offset })
    return reply.code(200).send(success(result))
  })

  // Missão 06.8 — corrected from a public read (Missão 06.7's route
  // audit: this returns Dispute.reason/Dispute.evidence directly — real,
  // free-text dispute content, potentially PII — to anyone who knew or
  // guessed a disputeId, no auth at all). Same class of exposure as the
  // Proof Bundle (Missão 06.6). Authorized readers: the trade's buyer,
  // its seller, or the dispute's own assigned arbiter (dispute.arbiterId) —
  // the same three actors already established as legitimate elsewhere in
  // this file (resolveDispute() below is arbiter-only; appeal/evidence/
  // contest are party-only) — a non-assigned arbiter gets the same 403 an
  // outsider would, matching resolveDispute()'s own existing boundary.
  app.get('/v1/settlement/disputes/:id', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const callerId = participantId(request)
    const dispute = await getDisputeService().getDispute(id)
    const trade = await tradeService.getTrade(dispute.tradeId)
    const isParty = callerId === trade.buyerId || callerId === trade.sellerId
    const isAssignedArbiter = dispute.arbiterId === callerId
    if (!isParty && !isAssignedArbiter) {
      throw new ForbiddenError(`${callerId} is not authorized to view dispute ${id}`)
    }
    return reply.code(200).send(success(dispute))
  })

  // M10 SDK Adapter — historical semantic read surface, DELIBERATELY
  // separate from the route above. GET /disputes/:id answers "what is
  // this dispute's current, legacy-shaped state" (Dispute.ruling is a
  // convenience/current field, never authoritative historical semantic
  // evidence — see Dispute.ruling's own JSDoc in
  // packages/sails-sdk/src/types.ts). THIS route answers "what did
  // Core's own frozen evaluators actually authorize for one specific,
  // named historical appeal round" — reading the durable
  // SemanticTransitionRecord `dispute-outcome.ts`'s existing, already-
  // tested `loadDisputeRulingRecord()` already knows how to fetch.
  //
  // Deliberately does NOT route through `fromDisputeRulingRow()`
  // (dispute-outcome.ts) — that function substitutes the CURRENT
  // in-memory DISPUTE_RULING_RULESET constant for rulesetRef instead of
  // reading the row's own persisted rulesetIdentity/Version/Commitment
  // columns. This route reads those persisted columns directly, so a
  // future change to the in-memory constant can never silently alter
  // what a past record is reported to have used.
  //
  // Authorization: parties (buyer/seller) ONLY — narrower than
  // /disputes/:id above. Real, evidenced reasons, not an oversight:
  //   1. dispute.arbiterId is CURRENT-round only (dispute.service.ts's
  //      appeal() reassigns it — the prior arbiter moves to
  //      previousArbiterId). Reusing it here would authorize whoever
  //      currently holds the role for a historical round they may have
  //      had no part in, while excluding the actor who actually decided
  //      it. Economic authority (who decided this) and information
  //      access authority (who may read about it) are distinct — this
  //      route never conflates them.
  //   2. Whether the ACTOR who actually decided this specific historical
  //      round (row.attributionActor) should retain a narrow read right
  //      to just that record is a real, open question — no existing
  //      route/test/RFC in this codebase grants a past arbiter ANY
  //      access once reassigned (previousArbiterId is used only for
  //      slashing, never for reads; listForArbiter() itself excludes a
  //      reassigned-away arbiter from even seeing the dispute exists).
  //      Registered as an explicit residual (Historical Arbiter Read
  //      Access Policy) rather than invented here either way.
  app.get('/v1/settlement/disputes/:id/semantic-record', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, querystring: semanticRecordQuerySchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const { appealRound } = semanticRecordQuerySchema.parse(request.query)
    const callerId = participantId(request)
    const dispute = await getDisputeService().getDispute(id)
    const trade = await tradeService.getTrade(dispute.tradeId)
    const isParty = callerId === trade.buyerId || callerId === trade.sellerId
    if (!isParty) {
      throw new ForbiddenError(`${callerId} is not authorized to view the semantic record for dispute ${id}`)
    }
    const record = await loadDisputeRulingRecord(dispute.escrowId, appealRound)
    if (!record) {
      // Absence, not uncertainty. 404 must never be reachable from
      // anything a caller could mistake for `conditionResult: 'UNKNOWN'`
      // — that value only ever appears INSIDE a 200 body, for a record
      // that exists and whose own Core evaluation was itself uncertain.
      // No record for this (escrowId, appealRound) is a structurally
      // different fact: this decision was never made (yet, or at all).
      throw new NotFoundError(`semantic record for dispute ${id}`, `appealRound=${appealRound}`)
    }
    // Every field below is a direct, unmodified read of a persisted
    // column — no branching that could alter meaning, no recomputation.
    // The actual (never merely expected) evaluator/profile identity —
    // rulesetExpectedEvaluatorName/Version and rulesetExpectedProfileName/
    // Version exist as SEPARATE columns on this same row and are never
    // read here.
    return reply.code(200).send(success({
      disputeId: id,
      escrowId: record.interactionId,
      appealRound: record.appealRound,
      rulesetIdentity: { name: record.rulesetIdentity, version: record.rulesetVersion },
      evaluatorIdentity: { name: record.evaluatorIdentityName, version: record.evaluatorIdentityVersion },
      profileIdentity: { name: record.profileIdentityName, version: record.profileIdentityVersion },
      conditionResult: record.conditionResult,
      attribution: record.attributionActor
        ? {
            actor: record.attributionActor,
            signatureHex: record.attributionRawProof,
            resolvedIdentityReference: record.attributionResolvedIdentity,
          }
        : null,
      outcome: record.outcomeContent
        ? {
            ...(record.outcomeContent as object),
            destinations: record.outcomeDestinationBinding ?? [],
          }
        : null,
    }))
  })

  // Not yet in API_REFERENCE.md's section 4 table — added alongside this
  // file's own doc update. Only the assigned arbiter may call this
  // (enforced in dispute.service.ts's resolveDispute).
  app.post('/v1/settlement/disputes/:id/resolve', {
    preHandler: [criticalRateLimit, requireAuth],
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: resolveSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = resolveSchema.parse(request.body)
    const dispute = await getDisputeService().resolveDispute(
      id, participantId(request), body.ruling, body.releaseToAddress, body.refundToAddress, body.splitBuyerBps,
      body.authoritySignature, body.authorityIssuedAt
    )
    return reply.code(200).send(success(dispute))
  })

  // RFC-021 D6 — only a party to the trade may appeal; only meaningful
  // under ARBITRATION_MODE=market (dispute.service.ts's appeal() surfaces
  // a clear config error otherwise, not a crash).
  app.post('/v1/settlement/disputes/:id/appeal', {
    preHandler: [criticalRateLimit, requireAuth],
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const result = await getDisputeService().appeal(id, participantId(request))
    return reply.code(200).send(success(result))
  })

  // RFC-021 D8 — either trade party may attach more evidence to their own
  // open dispute. Triggers a QVAC auto-resolution attempt (config-gated)
  // via the dispute.evidence_submitted event, not directly from this route.
  app.post('/v1/settlement/disputes/:id/evidence', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam, body: submitEvidenceSchema }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const body = submitEvidenceSchema.parse(request.body)
    const result = await getDisputeService().submitEvidence(id, participantId(request), body, body.idempotencyKey)
    return reply.code(200).send(success(result))
  })

  // RFC-021 D8 — either trade party can reject a proposed automated
  // ruling before its deadline, forcing the dispute back onto its
  // already-assigned human arbiter. No new arbiter assignment happens
  // here — one was already assigned at raiseDispute() time.
  app.post('/v1/settlement/disputes/:id/contest', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: idParam }),
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params)
    const result = await getDisputeService().contestAutoResolution(id, participantId(request))
    return reply.code(200).send(success(result))
  })

  // RFC-021 D2 — permissionless arbiter registration. No approval step:
  // the caller registers themselves, matching MarketArbitrationProvider's
  // own real logic. Works regardless of config.settlement.arbitrationMode
  // (a participant can register collateral/reputation ahead of a
  // deployment switching modes) — only assign() itself is mode-gated.
  app.post('/v1/settlement/arbitration/register', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], body: registerArbiterSchema }),
  }, async (request, reply) => {
    const body = registerArbiterSchema.parse(request.body)
    const profile = await marketArbitrationProvider.register(participantId(request), body.monetaryCollateral, body.collateralAsset)
    return reply.code(201).send(success(profile))
  })

  app.get('/v1/settlement/arbitration/profile/:participantId', {
    ...docsOnlySchema({ tags: ['open-settlement'], params: arbiterProfileParamsSchema }),
  }, async (request, reply) => {
    const { participantId: targetId } = arbiterProfileParamsSchema.parse(request.params)
    const profile = await marketArbitrationProvider.getProfile(targetId)
    if (!profile) {
      return reply.code(404).send({
        success: false,
        error: 'NOT_FOUND',
        message: `No ArbiterProfile for ${targetId}`,
        details: [],
      })
    }
    return reply.code(200).send(success(profile))
  })

  // RFC-021 D5 — payment-account trust ramp. Idempotent: registering an
  // already-known accountHash just returns the existing row.
  app.post('/v1/settlement/payment-accounts', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], body: registerPaymentAccountSchema }),
  }, async (request, reply) => {
    const body = registerPaymentAccountSchema.parse(request.body)
    const caller = participantId(request)
    const account = await paymentAccountService.getOrCreate(caller, body.accountHash, body.paymentMethod)
    // Missão 11 Fase 9.6 — INV-OP-10 fix (Kimi K3 R2 triage, Fase 9.5).
    // getOrCreate() returns the raw PaymentAccount row either way — a
    // brand-new registration IS self-referential (the caller just
    // created their own row, full disclosure is correct, same exception
    // this route's own comment above already documents), but the
    // existing-hash branch previously sent that same raw row —
    // ownerId/signedBy/id/moduleId/protocolVersion included — to ANY
    // authenticated caller who supplied someone else's real accountHash,
    // not just the owner. Only self-referential calls (new account, or
    // an owner re-submitting their own already-registered hash) get the
    // full row now; anyone else gets the identical public projection
    // GET /v1/settlement/payment-accounts/:accountHash already returns.
    const view = account.ownerId === caller ? account : paymentAccountService.toPublicView(account)
    return reply.code(201).send(success(view))
  })

  // Missão 11 Fase 9.3.1 — deliberately public (no requireAuth), matching
  // RFC-021 D5's own design intent and the SDK's own documented contract
  // (docs/API_STABLE.md: "no session required") — Bisq's real account-age-
  // witness precedent is explicitly a public commitment scheme, not an
  // authorization boundary. What changed: the response is now
  // getPublicView()'s privacy-preserving projection, not the raw
  // PaymentAccount row — see that method's own comment for exactly which
  // fields were removed (ownerId, signedBy, id, moduleId, protocolVersion,
  // updatedAt) and why: verifying a payment rail's trust history never
  // required knowing which platform identity owns or attested it.
  // #235 R7H-E3B — the trade-limit policy in force (governed rails, eligible payment methods), public and read-only:
  // clients use it to tell which offers can carry a protected escrow; escrow creation re-checks it in the database.
  app.get('/v1/settlement/economic-policy', {
    ...docsOnlySchema({ tags: ['open-settlement'] }),
  }, async (_request, reply) => {
    return reply.code(200).send(success(await readEconomicPolicy()))
  })

  app.get('/v1/settlement/payment-accounts/:accountHash', {
    ...docsOnlySchema({ tags: ['open-settlement'], params: accountHashParamsSchema }),
  }, async (request, reply) => {
    const { accountHash } = accountHashParamsSchema.parse(request.params)
    const view = await paymentAccountService.getPublicView(accountHash)
    return reply.code(200).send(success(view))
  })

  // RFC-021 D1's narrow-attestation framing: the caller attests a
  // specific completed trade, not the account owner's general
  // trustworthiness. #235 R7C — only the buyer of `tradeId`, a clean
  // COMPLETED trade bound to this exact account, may attest it; see
  // paymentAccountService.attestFromTrade().
  app.post('/v1/settlement/payment-accounts/:accountHash/sign', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: accountHashParamsSchema, body: attestPaymentAccountSchema }),
  }, async (request, reply) => {
    const { accountHash } = accountHashParamsSchema.parse(request.params)
    const { tradeId } = attestPaymentAccountSchema.parse(request.body ?? {})
    const caller = participantId(request)
    const account = await paymentAccountService.attestFromTrade(tradeId, accountHash, caller)
    // Missão 11 Fase 9.6 — same INV-OP-10 gap as the POST .../payment-accounts
    // route above, found in the same sweep: the signer attesting an
    // account is very often NOT its owner (RFC-021 D1 — an arbiter or
    // peer attests someone ELSE's account), so this response was sending
    // ownerId/signedBy/id/moduleId/protocolVersion to exactly the caller
    // this projection exists to keep that from.
    const view = account.ownerId === caller ? account : paymentAccountService.toPublicView(account)
    return reply.code(200).send(success(view))
  })

  // BACKLOG.md's own "Participant payout address" gap, closed 2026-08-04
  // — see payout-address.service.ts's own header comment for the full
  // rationale. Scoped to the caller's own participantId, never a
  // client-supplied one — same convention every self-service write route
  // in this file already follows.
  app.post('/v1/settlement/payout-addresses', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], body: setPayoutAddressSchema }),
  }, async (request, reply) => {
    const body = setPayoutAddressSchema.parse(request.body)
    const record = await payoutAddressService.setPayoutAddress(participantId(request), body.asset as any, body.address)
    return reply.code(201).send(success(record))
  })

  // F-06 (System Coherence & Integration Audit, 2026-09-13; Privacy
  // Decision Review, COHERENCE-CORRECTIVE-1): was public, no auth —
  // corrected to participant-scoped (requireAuth + self-check), same
  // "read by id needs no auth, but the id itself must be the caller's
  // own" convention GET /v1/settlement/escrow/:id already establishes
  // above via isParty/isAssignedArbiter, narrowed here to isSelf since
  // no real counterparty/arbiter consumer of this specific route was
  // found (see below).
  //
  // Superseded rationale, preserved for provenance, not deleted: this
  // route's original comment claimed "a counterparty legitimately needs
  // to look up who they're paying (e.g. a seller building a manual
  // release outside escrowService's own fallback)." Verified false
  // against real code during the Privacy Decision Review: every real
  // release path (settlement.routes.ts's own /release route, M8-R2's
  // applyRuling()) always passes `toAddress: undefined` and resolves
  // the BENEFICIARY's own registered PayoutAddress server-side — no
  // caller ever manually supplies one, so no "manual release" consumer
  // exists to need this lookup. The one real, live SDK/UI consumer
  // (packages/sails-ui/src/pages/Trade.tsx) calls
  // getPayoutAddress(user.id, ...) — always self-referential, already
  // holding an authenticated session — confirming self-scoped access is
  // the correct minimal change, not a regression for any real caller.
  // docs/PRODUCT_INTERACTION_MODEL.md §5's own Privacy Matrix already
  // froze "Payout/destination address: Public ○" — this brings runtime
  // into conformance with that already-decided intent, not a new
  // decision. INV-OP-10 (minimum necessary disclosure on a public
  // surface) is unaffected — this route is no longer a public surface
  // at all, and getPublicView()'s already-minimal projection
  // (participantId/asset/address only, still no id/moduleId/
  // protocolVersion/createdAt/updatedAt) is unchanged.
  app.get('/v1/settlement/payout-addresses/:participantId/:asset', {
    preHandler: requireAuth,
    ...docsOnlySchema({ tags: ['open-settlement'], params: payoutAddressParamsSchema }),
  }, async (request, reply) => {
    const { participantId: targetId, asset } = payoutAddressParamsSchema.parse(request.params)
    const callerId = participantId(request)
    if (callerId !== targetId) {
      throw new ForbiddenError(`${callerId} is not authorized to view payout address for ${targetId}`)
    }
    const view = await payoutAddressService.getPublicView(targetId, asset as any)
    if (!view) {
      return reply.code(404).send({ success: false, error: 'NOT_FOUND', message: `No PayoutAddress for ${targetId}/${asset}`, details: [] })
    }
    return reply.code(200).send(success(view))
  })
}
