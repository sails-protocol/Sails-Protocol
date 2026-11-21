/**
 * View-model for SigningRequestCard: what a pending escrow transaction
 * asks the viewer to authorize, who still has to sign, and whether the
 * reference UI may offer a sign button at all. Pure and type-only, so it
 * can be unit-tested without the SDK runtime.
 *
 * A sign action exists ONLY when the viewer is a required signer who has
 * not signed yet, the escrow is not in dispute, AND the transaction passed
 * verifySigningIntent (MULTISIG). Unsupported escrow types, mismatches and
 * "cannot verify" never get one.
 *
 * What "verified" means, exactly: the PSBT spends this escrow's funding
 * deposit and pays exactly the outputs and network fee rebuilt from the
 * pending round the SERVER returned (its toAddress, minerFeeSats) plus the
 * escrow's own funding/fee data. The destination is not compared with any
 * address the user registered, and the fee is not bounded — the copy says
 * so instead of claiming "the trade terms".
 */
import { getLocale } from './locale'
import { t } from '../i18n'
import type { EscrowPendingTransaction } from '@satsails/p2p-trading-sdk'

export type SigningVerification =
  | { status: 'verified'; outputs: { address: string; sats: bigint }[]; minerFeeSats: bigint }
  | { status: 'mismatch'; fields: string[] }
  | { status: 'cannotVerify'; reason: string }
  | { status: 'unsupported' }

export type SigningRequestState = 'sign' | 'blocked' | 'waiting' | 'complete'

export interface SigningRequestView {
  state: SigningRequestState
  actorLabel: string
  title: string
  description: string
  destinations: { label: string; address: string }[]
  progress: { signed: number; required: number; text: string }
  /** `at`: the signer's submittedAt from the round record; null while pending. */
  signers: { label: string; signed: boolean; statusText: string; at: string | null }[]
  check?: { tone: 'ok' | 'danger' | 'unavailable'; title: string; note?: string; items: { label: string; value: string; mono?: boolean }[] }
  primary?: { label: string }
  cancel?: { label: string }
  refreshLabel: string
}

export type PendingForView = Pick<EscrowPendingTransaction, 'kind' | 'toAddress' | 'toAddressSecondary' | 'requiredSigners' | 'signedBy'>

export const unknownSignerLabel = () => t('escrow.signing.unknownSigner')

/** The round a confirmation dialog was opened for. */
export type RoundSnapshot = Pick<EscrowPendingTransaction, 'id' | 'unsignedPsbtBase64'>

/** True when the live/re-read round is not the exact one the user reviewed (gone, replaced or rebuilt). */
export function roundSnapshotChanged(snapshot: RoundSnapshot, current: RoundSnapshot | null | undefined): boolean {
  return !current || current.id !== snapshot.id || current.unsignedPsbtBase64 !== snapshot.unsignedPsbtBase64
}

const ACTION = {
  release: 'escrow.signing.actionRelease',
  refund: 'escrow.signing.actionRefund',
  split: 'escrow.signing.actionSplit',
} as const satisfies Record<EscrowPendingTransaction['kind'], string>

export function signingActionLabel(kind: EscrowPendingTransaction['kind']): string {
  return t(ACTION[kind])
}

export function formatSats(sats: bigint): string {
  return `${sats.toLocaleString(getLocale())} sats`
}

function destinationsFor(p: PendingForView): { label: string; address: string }[] {
  if (p.kind === 'refund') return [{ label: t('escrow.signing.sellerAddress'), address: p.toAddress }]
  const out = [{ label: t('escrow.signing.buyerAddress'), address: p.toAddress }]
  if (p.kind === 'split' && p.toAddressSecondary) out.push({ label: t('escrow.signing.sellerAddress'), address: p.toAddressSecondary })
  return out
}

// SDK mismatch field names (wallet-verification.ts) in plain language; deduplicated.
export function describeMismatches(fields: string[]): string[] {
  const key = (f: string) =>
    f === 'psbt' ? 'escrow.signing.mismatchPsbt'
    : f === 'network' ? 'escrow.signing.mismatchNetwork'
    : f.startsWith('input') ? 'escrow.signing.mismatchInput'
    : f === 'witnessScript' || f === 'threshold' || f === 'participantPubkeys' ? 'escrow.signing.mismatchKeys'
    : /^outputs(\[\d+\])?\.value$/.test(f) ? 'escrow.signing.mismatchValue'
    : f.startsWith('outputs') ? 'escrow.signing.mismatchDestination'
    : f === 'minerFee' ? 'escrow.signing.mismatchMinerFee'
    : 'escrow.signing.mismatchOther'
  return [...new Set(fields.map(key))].map((k) => t(k))
}

function outputLabel(address: string, index: number, destinations: { label: string; address: string }[], protocolFeeAddress?: string | null) {
  return destinations.find((d) => d.address === address)?.label
    ?? (protocolFeeAddress && address === protocolFeeAddress ? t('escrow.signing.protocolFee') : t('escrow.signing.output', { n: index + 1 }))
}

// Labels double as list/summary keys: suffix repeats so every key is unique.
function uniqueLabels<T extends { label: string }>(items: T[]): T[] {
  const seen = new Map<string, number>()
  return items.map((it) => {
    const n = (seen.get(it.label) ?? 0) + 1
    seen.set(it.label, n)
    return n === 1 ? it : { ...it, label: `${it.label} (${n})` }
  })
}

function checkFor(v: SigningVerification, destinations: { label: string; address: string }[], protocolFeeAddress?: string | null): SigningRequestView['check'] {
  switch (v.status) {
    case 'verified':
      return {
        tone: 'ok',
        title: t('escrow.signing.verifiedTitle'),
        note: t('escrow.signing.verifiedNote'),
        items: uniqueLabels([
          ...v.outputs.map((o, i) => ({ label: outputLabel(o.address, i, destinations, protocolFeeAddress), value: t('escrow.signing.outputValue', { amount: formatSats(o.sats), address: o.address }), mono: true })),
          { label: t('escrow.signing.networkFee'), value: formatSats(v.minerFeeSats) },
        ]),
      }
    case 'mismatch':
      return {
        tone: 'danger',
        title: t('escrow.signing.mismatchTitle'),
        items: describeMismatches(v.fields).map((m) => ({ label: m, value: '' })),
      }
    case 'cannotVerify':
      return { tone: 'unavailable', title: t('escrow.signing.cannotVerifyTitle'), items: [{ label: v.reason, value: '' }] }
    case 'unsupported':
      return {
        tone: 'unavailable',
        title: t('escrow.signing.unsupportedTitle'),
        items: [],
      }
  }
}

// Matched against the signer label the page gives (escrow.actor.buyer / .seller); any other label gets the generic count.
const waitingFor = (label: string): string | null =>
  label === t('escrow.actor.buyer') ? t('escrow.signing.waitingBuyer') : label === t('escrow.actor.seller') ? t('escrow.signing.waitingSeller') : null

export function deriveSigningRequest({ pending, viewerId, verification, signerLabel, disputed = false, canCancel = false, protocolFeeAddress }: {
  pending: PendingForView
  viewerId: string | null | undefined
  verification: SigningVerification
  signerLabel: (participantId: string) => string
  /** Escrow is DISPUTED: whether this round comes from the ruling is not exposed, so signing is not offered. */
  disputed?: boolean
  /** The viewer may cancel this round (seller, MULTISIG, non-disputed, non-terminal, not fully signed). */
  canCancel?: boolean
  protocolFeeAddress?: string | null
}): SigningRequestView {
  const signedAt = new Map((pending.signedBy ?? []).map((s) => [s.participantId, s.submittedAt]))
  const signedIds = new Set(signedAt.keys())
  const signers = pending.requiredSigners.map((id) => ({ label: signerLabel(id), signed: signedIds.has(id), statusText: t(signedIds.has(id) ? 'escrow.signing.signed' : 'escrow.signing.pending'), at: signedAt.get(id) ?? null }))
  const signed = signers.filter((s) => s.signed).length
  const required = signers.length
  const remaining = signers.filter((s) => !s.signed)
  const progress = { signed, required, text: t('escrow.round.progress', { signed, count: required }) }
  const destinations = destinationsFor(pending)
  const title = t(ACTION[pending.kind])
  const mustSign = !!viewerId && pending.requiredSigners.includes(viewerId) && !signedIds.has(viewerId)
  const base = { title, destinations, progress, signers, refreshLabel: t('escrow.signing.refresh') }

  if (remaining.length === 0) {
    return {
      ...base, state: 'complete', actorLabel: t('escrow.signing.completeActor'),
      description: t('escrow.signing.completeDescription'),
    }
  }
  if (!mustSign) {
    return {
      ...base, state: 'waiting', actorLabel: t('escrow.signing.waitingActor'),
      description: (remaining.length === 1 && waitingFor(remaining[0].label)) || t('escrow.signing.waitingMany', { count: remaining.length }),
    }
  }
  if (disputed) {
    return {
      ...base, state: 'blocked', actorLabel: t('escrow.action.disputed.title'),
      check: { tone: 'unavailable', title: t('escrow.signing.disputedCheck'), items: [] },
      description: t('escrow.signing.cannotProceed'),
    }
  }
  // A payout address equal to the protocol fee address means an inconsistent round: never verified.
  const feeCollision = !!protocolFeeAddress && (pending.toAddress === protocolFeeAddress || pending.toAddressSecondary === protocolFeeAddress)
  const effective: SigningVerification = feeCollision
    ? { status: 'cannotVerify', reason: t('escrow.signing.feeCollision') }
    : verification
  const check = checkFor(effective, destinations, protocolFeeAddress)
  if (effective.status !== 'verified') {
    return {
      ...base, state: 'blocked', actorLabel: t('escrow.signing.blockedActor'), check,
      description: t(canCancel ? 'escrow.signing.blockedCancelDescription' : 'escrow.signing.cannotProceed'),
      ...(canCancel ? { cancel: { label: t('escrow.signing.cancelRound') } } : {}),
    }
  }
  return {
    ...base, state: 'sign', actorLabel: t('escrow.signing.signActor'), check,
    description: t('escrow.signing.signDescription'),
    primary: { label: t('escrow.signing.signLabel') },
  }
}
