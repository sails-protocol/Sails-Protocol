/**
 * AUD-1 - the part of the disputed-disposition binding that needs nothing but a signed ruling: WHICH disposition the
 * ruling authorizes. Shared by the signing-round validator (disputed-outcome-binding.ts, every rail) and by the
 * direct executors (escrow.service.ts releaseFunds/refundFunds/splitFunds, the rails that settle without a signing
 * round). A leaf on purpose: the lifecycle module imports it without importing the Outcome machinery.
 */
import { EscrowError } from '../../common/errors'

const KIND_OF_RULING: Readonly<Record<string, string>> = { RELEASE: 'release', REFUND: 'refund', SPLIT: 'split' }

export function assertDispositionMatchesRuling(
  kind: string,
  buyerBps: number | null,
  dispute: { id: string; ruling: string | null; authorityBuyerBps: number | null },
  what: string,
): void {
  const authorizedKind = dispute.ruling ? KIND_OF_RULING[dispute.ruling] : undefined
  if (!authorizedKind || kind !== authorizedKind) {
    throw new EscrowError(
      `AUD-1: ${what} contradicts the signed ruling ${dispute.ruling ?? 'none'} of dispute ${dispute.id} ` +
      `(it is a ${kind}, the ruling authorizes a ${authorizedKind ?? 'unknown disposition'}); refusing.`
    )
  }
  if (dispute.ruling === 'SPLIT' && dispute.authorityBuyerBps !== null && buyerBps !== dispute.authorityBuyerBps) {
    throw new EscrowError(
      `AUD-1: ${what} splits ${buyerBps ?? 'no'} bps to the buyer, the signed ruling authorized ${dispute.authorityBuyerBps}; refusing.`
    )
  }
}
