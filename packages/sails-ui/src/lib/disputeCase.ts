/**
 * Pure helpers for the arbiter case file (pages/Disputes.tsx): which
 * decisions can be offered, who a participant is in this escrow, and a
 * defensive read of Dispute.evidence (typed `unknown[]` by the SDK).
 */
import type { Dispute, DisputeRuling, Escrow, EscrowType } from '@satsails/p2p-trading-sdk'

// RFC-021 D9 — SPLIT only works for these three; SAFE_GUARD_EVM's
// immutable Guard contract and LIGHTNING_HODL's fixed-leaf VtxoScript
// each can't represent a partial payout (settlement.ts's own
// resolveDispute() doc comment has the full per-provider reasoning).
export const SPLIT_SUPPORTED: ReadonlySet<EscrowType> = new Set(['MOCK', 'WDK_USDT_EVM', 'MULTISIG'])

// MULTISIG SPLIT is offered by the protocol but this interface cannot sign
// it: buildMultisigSigningIntent() refuses split PSBTs (multisigSigningIntent.ts),
// and the server's split PSBT still needs a party signature.
const SPLIT_NOT_SIGNABLE_HERE: ReadonlySet<EscrowType> = new Set(['MULTISIG'])
export const SPLIT_UNAVAILABLE_REASON = 'Não disponível nesta interface: a assinatura da divisão ainda não é suportada.'

// One wording for a ruling everywhere on the arbiter console: list, case file and confirmation.
export const RULING_DECISION: Record<DisputeRuling, string> = {
  RELEASE: 'Liberar ao comprador',
  REFUND: 'Devolver ao vendedor',
  SPLIT: 'Dividir 50/50',
}

export type DecisionChoice = DisputeRuling | 'SUGGESTION'

export interface DecisionOption {
  value: DecisionChoice
  ruling: DisputeRuling
  label: string
  detail?: string
  /** Set when the option is shown but cannot be chosen here. */
  unavailableReason?: string
}

/** The automatic suggestion can be accepted only while it is pending (AUTO_PROPOSED). */
export function pendingSuggestion(dispute: Dispute): DisputeRuling | null {
  return dispute.status === 'AUTO_PROPOSED' ? dispute.autoResolutionRecommendation : null
}

/** True when this ruling cannot be signed by this interface for this escrow type. */
export function splitUnavailableHere(ruling: DisputeRuling, escrowType: EscrowType | null): boolean {
  return ruling === 'SPLIT' && !!escrowType && SPLIT_NOT_SIGNABLE_HERE.has(escrowType)
}

/** Decisions the arbiter may pick; empty once the dispute is resolved. */
export function decisionOptions(dispute: Dispute, escrowType: EscrowType | null): DecisionOption[] {
  if (dispute.status === 'RESOLVED') return []
  const rulings: DisputeRuling[] = escrowType && SPLIT_SUPPORTED.has(escrowType) ? ['RELEASE', 'REFUND', 'SPLIT'] : ['RELEASE', 'REFUND']
  const reason = (ruling: DisputeRuling) => (splitUnavailableHere(ruling, escrowType) ? { unavailableReason: SPLIT_UNAVAILABLE_REASON } : {})
  const options: DecisionOption[] = rulings.map((ruling) => ({ value: ruling, ruling, label: RULING_DECISION[ruling], ...reason(ruling) }))
  const suggested = pendingSuggestion(dispute)
  if (suggested) options.push({ value: 'SUGGESTION', ruling: suggested, label: 'Aceitar a sugestão automática', detail: RULING_DECISION[suggested], ...reason(suggested) })
  return options
}

export type PartyRole = 'buyer' | 'seller'

/** Only options without an unavailableReason can be submitted. */
export function selectableOption(options: DecisionOption[], choice: DecisionChoice | null): DecisionOption | null {
  return options.find((o) => o.value === choice && !o.unavailableReason) ?? null
}

/** MULTISIG disputed release/refund: the server requires the winning side's signature (buyer for RELEASE, seller for REFUND). */
export function multisigPendingSigner(ruling: DisputeRuling): string | null {
  return ruling === 'RELEASE' ? 'o comprador' : ruling === 'REFUND' ? 'o vendedor' : null
}

/** Buyer/seller only when the escrow itself says so (participantKeys); never guessed. */
export function partyRole(participantId: string, escrow: Escrow | null): PartyRole | null {
  const role = escrow?.participantKeys?.find((k) => k.participantId === participantId)?.role
  return role === 'buyer' || role === 'seller' ? role : null
}

export function partyIdFor(role: PartyRole, escrow: Escrow | null): string | null {
  return escrow?.participantKeys?.find((k) => k.role === role)?.participantId ?? null
}

export interface EvidenceItem {
  type: string
  note: string | null
  uri: string | null
  /** Same string as `uri`, set only when it is an http(s) URL. */
  href: string | null
  referenceId: string | null
  submittedBy: string | null
  submittedAt: string | null
}

export function safeHttpHref(uri: string): string | null {
  try {
    const { protocol } = new URL(uri)
    return protocol === 'http:' || protocol === 'https:' ? uri : null
  } catch {
    return null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

export function parseEvidence(raw: unknown[] | null | undefined): EvidenceItem[] {
  return (raw ?? []).flatMap((e) => {
    if (!e || typeof e !== 'object') return []
    const r = e as Record<string, unknown>
    const uri = str(r.uri)
    return [{
      type: str(r.type) ?? 'desconhecido',
      note: str(r.note),
      uri,
      href: uri ? safeHttpHref(uri) : null,
      referenceId: str(r.evidenceReferenceId),
      submittedBy: str(r.submittedBy),
      submittedAt: str(r.submittedAt),
    }]
  })
}
