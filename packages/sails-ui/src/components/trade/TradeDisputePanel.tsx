/**
 * Extracted out of Trade.tsx (2026-08-11, codebase-quality pass ahead
 * of dev handoff) — the dispute section had grown into its own
 * self-contained unit (status, QVAC auto-resolution recommendation,
 * evidence submission, appeal), reusing none of Trade.tsx's escrow/chat
 * state directly. Real, trade-party-only actions (dispute.service.ts's
 * own 403 check) — see Disputes.tsx's own comment for why the arbiter
 * console doesn't offer these same three, and why it CAN resolve
 * directly instead of needing this evidence step.
 *
 * Lote B: one danger alert, neutral sections below it. Evidence is
 * rendered as given (untyped `unknown[]` on the record): nothing here is
 * marked as verified. The automatic suggestion is labelled as a
 * suggestion, never a decision.
 */
import type { ReactNode } from 'react'
import type { Dispute } from '@satsails/p2p-trading-sdk'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { formatDateTime } from '../../lib/format'
import { DISPUTE_RULING_LABEL } from '../../lib/labels'
import { AlertTriangle } from 'lucide-react'

interface Props {
  dispute: Dispute
  isBuyer: boolean
  isSeller: boolean
  acting: boolean
  evidenceNote: string
  /** Maps a participant id to a role label ("Você", "Comprador", ...). */
  partyLabel: (participantId: string) => string
  onEvidenceNoteChange: (value: string) => void
  onSubmitEvidence: () => void
  onContestAutoResolution: () => void
  onAppeal: () => void
}

function readEvidence(e: unknown) {
  const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {}
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  return { type: str('type'), note: str('note'), uri: str('uri') ?? str('url'), by: str('submittedBy'), at: str('submittedAt') }
}

const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-brand-border-subtle pt-3">
      <h3 className="text-xs font-semibold text-brand-text-secondary">{title}</h3>
      <div className="mt-1 text-sm text-brand-text">{children}</div>
    </div>
  )
}

export function TradeDisputePanel({
  dispute, isBuyer, isSeller, acting, evidenceNote, partyLabel,
  onEvidenceNoteChange, onSubmitEvidence, onContestAutoResolution, onAppeal,
}: Props) {
  const isParty = isBuyer || isSeller
  const resolved = dispute.status === 'RESOLVED'
  const evidence = (dispute.evidence ?? []).map(readEvidence)

  return (
    <section aria-label="Disputa" className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4 space-y-3">
      {resolved ? (
        <p className="text-sm font-semibold text-brand-text">Disputa resolvida</p>
      ) : (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-brand-danger/50 bg-brand-danger/10 px-3 py-2 text-sm text-brand-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brand-danger" aria-hidden="true" />
          <span>
            Disputa aberta por <strong>{partyLabel(dispute.openedBy)}</strong> em {formatDateTime(dispute.createdAt)}. As ações normais do trade ficam suspensas até a resolução.
          </span>
        </div>
      )}

      <Section title="Motivo">
        <p className="whitespace-pre-line [overflow-wrap:anywhere]">{dispute.reason}</p>
      </Section>

      <Section title={`Evidências (${evidence.length})`}>
        {evidence.length === 0 ? (
          <p className="text-brand-text-secondary">Nenhuma evidência enviada ainda.</p>
        ) : (
          <ul className="space-y-2">
            {evidence.map((ev, i) => (
              <li key={i} className="rounded-md bg-brand-elevated px-3 py-2">
                <p className="text-xs text-brand-text-secondary">
                  {[ev.type ? `Tipo: ${ev.type}` : null, ev.by ? `Enviada por ${partyLabel(ev.by)}` : null, ev.at ? formatDateTime(ev.at) : null].filter(Boolean).join(' · ') || 'Sem metadados'}
                </p>
                {ev.note && <p className="mt-0.5 whitespace-pre-line [overflow-wrap:anywhere]">{ev.note}</p>}
                {ev.uri && (isHttpUrl(ev.uri)
                  ? <a href={ev.uri} target="_blank" rel="noopener noreferrer nofollow" className="mt-0.5 inline-block text-brand-orange-accent underline [overflow-wrap:anywhere]">{ev.uri}</a>
                  : <p className="mt-0.5 font-mono text-xs [overflow-wrap:anywhere]">{ev.uri}</p>)}
              </li>
            ))}
          </ul>
        )}
        {isParty && (dispute.status === 'OPENED' || dispute.status === 'EVIDENCE_SUBMITTED') && (
          <div className="mt-3">
            <label htmlFor="dispute-evidence" className="text-xs font-medium text-brand-text-secondary">Adicionar evidência</label>
            <Textarea
              id="dispute-evidence"
              value={evidenceNote}
              onChange={(e) => onEvidenceNoteChange(e.target.value)}
              placeholder="Ex.: comprovante de pagamento, explicação..."
              className="mt-1 w-full"
              rows={2}
            />
            <Button variant="outline" onClick={onSubmitEvidence} disabled={acting || !evidenceNote.trim()} className="mt-2 min-h-11 text-sm">
              Enviar evidência
            </Button>
          </div>
        )}
      </Section>

      {dispute.appealRound > 0 && (
        <Section title="Apelação">
          <p>
            Rodada de apelação {dispute.appealRound}
            {dispute.previousRuling && ` — decisão anterior: ${DISPUTE_RULING_LABEL[dispute.previousRuling]}`}
          </p>
        </Section>
      )}

      {dispute.autoResolutionRecommendation && (
        <Section title="Sugestão automática (sugestão, não decisão)">
          <p>Sugere: {DISPUTE_RULING_LABEL[dispute.autoResolutionRecommendation]}</p>
          {dispute.autoResolutionReasoning && <p className="mt-1 text-brand-text-secondary">{dispute.autoResolutionReasoning}</p>}
          {dispute.status === 'AUTO_PROPOSED' && dispute.autoResolutionDeadline && (
            <p className="mt-1 text-xs text-brand-text-secondary">
              Aplica-se em {formatDateTime(dispute.autoResolutionDeadline)} se nenhuma parte contestar.
            </p>
          )}
          {isParty && dispute.status === 'AUTO_PROPOSED' && (
            <Button variant="outline" onClick={onContestAutoResolution} disabled={acting} className="mt-2 min-h-11 text-sm">
              Contestar sugestão
            </Button>
          )}
        </Section>
      )}

      {resolved && (
        <Section title="Decisão registrada">
          {dispute.ruling ? (
            <p>
              {DISPUTE_RULING_LABEL[dispute.ruling] ?? dispute.ruling}
              {dispute.resolvedAt && ` — ${formatDateTime(dispute.resolvedAt)}`}
            </p>
          ) : (
            <p className="text-brand-text-secondary">Decisão não informada no registro.</p>
          )}
          {isParty && (
            <>
              <p className="mt-2 text-xs text-brand-text-secondary">
                Você ainda pode apelar: a apelação reabre a disputa para um novo árbitro. O servidor pode recusá-la conforme o tipo de escrow e a configuração de arbitragem.
              </p>
              <Button variant="outline" onClick={onAppeal} disabled={acting} className="mt-2 min-h-11 text-sm">
                Apelar da decisão
              </Button>
            </>
          )}
        </Section>
      )}
    </section>
  )
}
