/**
 * Who must act now, and what the next permitted action is, from the
 * viewer's point of view. Gating is identical to the former
 * EscrowActions.tsx (which mirrored escrow.service.ts's ownership rules):
 * seller + CREATED -> lock, buyer + FUNDS_LOCKED -> mark payment sent,
 * seller + PAYMENT_PENDING -> release; either party may open a dispute
 * unless the status is COMPLETED, DISPUTED or REFUNDED.
 */
import type { EscrowStatus } from '../types'

export type CurrentActionKind = 'lock' | 'markPaymentSent' | 'release'

export interface CurrentAction {
  tone: 'action' | 'waiting' | 'terminal' | 'attention'
  actorLabel: string
  title: string
  description: string
  primary?: { action: CurrentActionKind; label: string }
  canDispute: boolean
}

const WAITING = 'Aguardando a contraparte'

export function deriveCurrentAction({ status, isBuyer, isSeller }: { status: EscrowStatus; isBuyer: boolean; isSeller: boolean }): CurrentAction {
  const canDispute = (isBuyer || isSeller) && status !== 'COMPLETED' && status !== 'DISPUTED' && status !== 'REFUNDED'
  const party = isBuyer || isSeller

  switch (status) {
    case 'CREATED':
      return isSeller
        ? { tone: 'action', actorLabel: 'Ação necessária — vendedor', title: 'Bloquear os fundos no escrow', description: 'Registra o bloqueio dos fundos que você já depositou no escrow. Se o depósito ainda não for aceito, a ação será recusada. Não libera nada ao comprador.', primary: { action: 'lock', label: 'Bloquear Fundos' }, canDispute }
        : { tone: 'waiting', actorLabel: party ? WAITING : 'Acompanhamento', title: 'Aguardando o vendedor bloquear os fundos', description: 'Não envie nenhum pagamento antes de os fundos estarem bloqueados no escrow.', canDispute }
    case 'FUNDS_LOCKED':
      return isBuyer
        ? { tone: 'action', actorLabel: 'Ação necessária — comprador', title: 'Marcar o pagamento como enviado', description: 'Avisa o vendedor de que você enviou o pagamento. Não libera os fundos — isso só acontece quando o vendedor liberar. Toque só depois de concluir a transferência no app do seu banco.', primary: { action: 'markPaymentSent', label: 'Marcar Pagamento Enviado' }, canDispute }
        : { tone: 'waiting', actorLabel: party ? WAITING : 'Acompanhamento', title: 'Aguardando o comprador marcar o pagamento como enviado', description: 'O servidor registrou o bloqueio dos fundos.', canDispute }
    case 'PAYMENT_PENDING':
      return isSeller
        ? { tone: 'action', actorLabel: 'Ação necessária — vendedor', title: 'Liberar os fundos ao comprador', description: 'O comprador marcou o pagamento como enviado. Confira o recebimento na sua conta antes de liberar. Em alguns escrows, a liberação só é concluída depois das assinaturas necessárias.', primary: { action: 'release', label: 'Liberar Fundos' }, canDispute }
        : { tone: 'waiting', actorLabel: party ? WAITING : 'Acompanhamento', title: 'Aguardando o vendedor liberar', description: 'O pagamento foi marcado como enviado. O vendedor ainda precisa conferir o recebimento e liberar os fundos.', canDispute }
    case 'COMPLETED':
      return { tone: 'terminal', actorLabel: 'Encerrado', title: 'Escrow marcado como concluído', description: 'Não há mais ações disponíveis neste trade.', canDispute }
    case 'REFUNDED':
      return { tone: 'terminal', actorLabel: 'Encerrado', title: 'Escrow reembolsado', description: 'O escrow foi marcado como reembolsado.', canDispute }
    case 'SPLIT':
      return { tone: 'terminal', actorLabel: 'Resultado do escrow', title: 'Escrow dividido entre as partes', description: 'O escrow foi marcado como dividido entre as partes por decisão da disputa.', canDispute }
    case 'DISPUTED':
      return { tone: 'attention', actorLabel: 'Em disputa', title: 'Trade em disputa', description: 'As ações normais do trade estão suspensas. A resolução segue pela disputa.', canDispute }
    case 'EXPIRED':
      return { tone: 'attention', actorLabel: 'Prazo encerrado', title: 'O prazo do escrow terminou', description: 'O escrow não está mais aberto para as etapas normais do trade.', canDispute }
  }
}
