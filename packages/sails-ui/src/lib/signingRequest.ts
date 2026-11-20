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

export const UNKNOWN_SIGNER = 'Participante não identificado'

/** The round a confirmation dialog was opened for. */
export type RoundSnapshot = Pick<EscrowPendingTransaction, 'id' | 'unsignedPsbtBase64'>

/** True when the live/re-read round is not the exact one the user reviewed (gone, replaced or rebuilt). */
export function roundSnapshotChanged(snapshot: RoundSnapshot, current: RoundSnapshot | null | undefined): boolean {
  return !current || current.id !== snapshot.id || current.unsignedPsbtBase64 !== snapshot.unsignedPsbtBase64
}

const ACTION: Record<EscrowPendingTransaction['kind'], string> = {
  release: 'Autorizar a liberação dos fundos ao comprador',
  refund: 'Autorizar o reembolso dos fundos ao vendedor',
  split: 'Autorizar a divisão dos fundos entre comprador e vendedor',
}

export function signingActionLabel(kind: EscrowPendingTransaction['kind']): string {
  return ACTION[kind]
}

export function formatSats(sats: bigint): string {
  return `${sats.toLocaleString('pt-BR')} sats`
}

function destinationsFor(p: PendingForView): { label: string; address: string }[] {
  if (p.kind === 'refund') return [{ label: 'Endereço do vendedor', address: p.toAddress }]
  const out = [{ label: 'Endereço do comprador', address: p.toAddress }]
  if (p.kind === 'split' && p.toAddressSecondary) out.push({ label: 'Endereço do vendedor', address: p.toAddressSecondary })
  return out
}

// SDK mismatch field names (wallet-verification.ts) in plain language; deduplicated.
export function describeMismatches(fields: string[]): string[] {
  const text = (f: string) =>
    f === 'psbt' ? 'Não foi possível ler a transação recebida.'
    : f === 'network' ? 'A rede Bitcoin da transação não confere.'
    : f.startsWith('input') ? 'A transação não gasta o depósito deste escrow.'
    : f === 'witnessScript' || f === 'threshold' || f === 'participantPubkeys' ? 'As chaves do escrow na transação não conferem.'
    : /^outputs(\[\d+\])?\.value$/.test(f) ? 'O valor enviado é diferente do esperado.'
    : f.startsWith('outputs') ? 'O destino dos fundos é diferente do esperado.'
    : f === 'minerFee' ? 'A taxa de rede é diferente da registrada.'
    : 'Um campo da transação não confere com o esperado.'
  return [...new Set(fields.map(text))]
}

function outputLabel(address: string, index: number, destinations: { label: string; address: string }[], protocolFeeAddress?: string | null) {
  return destinations.find((d) => d.address === address)?.label
    ?? (protocolFeeAddress && address === protocolFeeAddress ? 'Taxa do protocolo' : `Saída ${index + 1}`)
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
        title: 'Conferido com a transação informada pelo servidor para este escrow',
        note: 'Conferido: a transação gasta o depósito deste escrow e paga exatamente os destinos, valores e a taxa de rede abaixo. O endereço de destino é o que o servidor informou para esta rodada — confira-o.',
        items: uniqueLabels([
          ...v.outputs.map((o, i) => ({ label: outputLabel(o.address, i, destinations, protocolFeeAddress), value: `${formatSats(o.sats)} para ${o.address}`, mono: true })),
          { label: 'Taxa de rede', value: formatSats(v.minerFeeSats) },
        ]),
      }
    case 'mismatch':
      return {
        tone: 'danger',
        title: 'A transação não corresponde ao que era esperado para este escrow — não assine',
        items: describeMismatches(v.fields).map((m) => ({ label: m, value: '' })),
      }
    case 'cannotVerify':
      return { tone: 'unavailable', title: 'Não foi possível conferir a transação', items: [{ label: v.reason, value: '' }] }
    case 'unsupported':
      return {
        tone: 'unavailable',
        title: 'Assinatura indisponível nesta interface para este tipo de escrow: ainda não há verificação dos termos antes de assinar.',
        items: [],
      }
  }
}

const WAITING_FOR: Record<string, string> = { Comprador: 'Aguardando a assinatura do comprador.', Vendedor: 'Aguardando a assinatura do vendedor.' }

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
  const signers = pending.requiredSigners.map((id) => ({ label: signerLabel(id), signed: signedIds.has(id), statusText: signedIds.has(id) ? 'Assinou' : 'Pendente', at: signedAt.get(id) ?? null }))
  const signed = signers.filter((s) => s.signed).length
  const required = signers.length
  const remaining = signers.filter((s) => !s.signed)
  const progress = { signed, required, text: `${signed} de ${required} assinaturas` }
  const destinations = destinationsFor(pending)
  const title = ACTION[pending.kind]
  const mustSign = !!viewerId && pending.requiredSigners.includes(viewerId) && !signedIds.has(viewerId)
  const base = { title, destinations, progress, signers, refreshLabel: 'Atualizar' }

  if (remaining.length === 0) {
    return {
      ...base, state: 'complete', actorLabel: 'Assinaturas registradas',
      description: 'Todas as assinaturas necessárias foram registradas. Isso não confirma a transmissão nem a confirmação da transação na rede.',
    }
  }
  if (!mustSign) {
    return {
      ...base, state: 'waiting', actorLabel: 'Aguardando assinaturas',
      description: (remaining.length === 1 && WAITING_FOR[remaining[0].label]) || `Aguardando assinatura de ${remaining.length} participante(s).`,
    }
  }
  if (disputed) {
    return {
      ...base, state: 'blocked', actorLabel: 'Trade em disputa',
      check: { tone: 'unavailable', title: 'Esta interface não consegue confirmar se esta rodada vem da decisão da disputa.', items: [] },
      description: 'Você não pode prosseguir por esta interface.',
    }
  }
  // A payout address equal to the protocol fee address means an inconsistent round: never verified.
  const feeCollision = !!protocolFeeAddress && (pending.toAddress === protocolFeeAddress || pending.toAddressSecondary === protocolFeeAddress)
  const effective: SigningVerification = feeCollision
    ? { status: 'cannotVerify', reason: 'O endereço de destino informado é o mesmo endereço da taxa do protocolo — rodada inconsistente.' }
    : verification
  const check = checkFor(effective, destinations, protocolFeeAddress)
  if (effective.status !== 'verified') {
    return {
      ...base, state: 'blocked', actorLabel: 'Sua assinatura é pedida', check,
      description: canCancel
        ? 'Esta interface não oferece a assinatura desta transação. Você pode cancelar esta rodada de assinatura.'
        : 'Você não pode prosseguir por esta interface.',
      ...(canCancel ? { cancel: { label: 'Cancelar rodada de assinatura' } } : {}),
    }
  }
  return {
    ...base, state: 'sign', actorLabel: 'Ação necessária — sua assinatura', check,
    description: 'Revise o destino e os valores conferidos antes de assinar.',
    primary: { label: 'Revisar e assinar' },
  }
}
