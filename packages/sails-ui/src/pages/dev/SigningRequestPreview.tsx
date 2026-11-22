/** Dev-only (see App.tsx): every state of SigningRequestCard, from view-model data only (no PSBTs, no signatures). */
import { useState } from 'react'
import { deriveSigningRequest, type PendingForView, type SigningVerification } from '../../lib/signingRequest'
import { SigningRequestCard } from '../../components/trade/SigningRequestCard'

const BUYER = 'tb1qexamplebuyeraddress0000000000000000000000000000'
const pending: PendingForView = { kind: 'release', toAddress: BUYER, requiredSigners: ['me', 'buyer'], signedBy: [] }
const signed = (...ids: string[]) => ids.map((participantId) => ({ participantId, submittedAt: '2026-01-01T00:00:00Z' }))
const label = (id: string) => (id === 'me' ? 'Você' : id === 'buyer' ? 'Comprador' : 'Participante não identificado')
const verified: SigningVerification = {
  status: 'verified',
  outputs: [{ address: BUYER, sats: 99_000n }, { address: 'tb1qexamplefeeaddress00000000000000000000000000000000', sats: 500n }],
  minerFeeSats: 500n,
}

const FEE = 'tb1qexamplefeeaddress00000000000000000000000000000000'
const CASES: { title: string; pending: PendingForView; verification: SigningVerification; disputed?: boolean; canCancel?: boolean }[] = [
  { title: 'Precisa da sua assinatura — conferido', pending, verification: verified },
  { title: 'Divergência na conferência — vendedor pode cancelar', pending, verification: { status: 'mismatch', fields: ['outputs[0].address', 'outputs[0].value'] }, canCancel: true },
  { title: 'Divergência na conferência — sem saída nesta interface', pending, verification: { status: 'mismatch', fields: ['minerFee'] } },
  { title: 'Tipo de escrow sem conferência', pending, verification: { status: 'unsupported' } },
  { title: 'Não foi possível conferir', pending: { ...pending, kind: 'split', toAddressSecondary: 'tb1qexampleselleraddress000000000000000000000000000' }, verification: { status: 'cannotVerify', reason: 'A conferência de uma divisão (split) ainda não é suportada nesta interface.' } },
  { title: 'Trade em disputa', pending, verification: verified, disputed: true },
  { title: 'Você já assinou — aguardando o comprador', pending: { ...pending, signedBy: signed('me') }, verification: verified },
  { title: 'Aguardando — signatário não identificado', pending: { ...pending, requiredSigners: ['me', 'other'], signedBy: signed('me') }, verification: verified },
  { title: 'Todas as assinaturas registradas', pending: { ...pending, signedBy: signed('me', 'buyer') }, verification: verified },
]

export function SigningRequestPreview() {
  const [acting, setActing] = useState(false)
  const [last, setLast] = useState('nenhum')

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div role="note" className="rounded-lg border border-brand-warning/25 bg-brand-warning/10 text-brand-warning text-sm px-4 py-3">
        Pré-visualização de desenvolvimento — dados de exemplo
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-brand-text-secondary">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={acting} onChange={(e) => setActing(e.target.checked)} />
          Simular ação em andamento
        </label>
        <span aria-live="polite">Último clique: {last}</span>
      </div>
      <div className="mt-2 grid gap-x-4 md:grid-cols-2">
        {CASES.map((c) => (
          <section key={c.title} className="mt-4">
            <h1 className="text-xs font-mono text-brand-text-muted">{c.title}</h1>
            <SigningRequestCard
              status="ready"
              view={deriveSigningRequest({ pending: c.pending, viewerId: 'me', verification: c.verification, signerLabel: label, disputed: c.disputed, canCancel: c.canCancel, protocolFeeAddress: FEE })}
              acting={acting}
              onReview={() => setLast(`${c.title}: revisar`)}
              onCancel={() => setLast(`${c.title}: cancelar rodada`)}
              onRefresh={() => setLast(`${c.title}: atualizar`)}
            />
          </section>
        ))}
        <section className="mt-4">
          <h1 className="text-xs font-mono text-brand-text-muted">Carregando</h1>
          <SigningRequestCard status="loading" label="Consultando assinaturas pendentes…" />
        </section>
        <section className="mt-4">
          <h1 className="text-xs font-mono text-brand-text-muted">Erro de leitura</h1>
          <SigningRequestCard status="error" message="Não foi possível consultar se há uma assinatura pendente neste escrow." retryLabel="Tentar novamente" onRetry={() => setLast('tentar novamente')} />
        </section>
      </div>
    </div>
  )
}
