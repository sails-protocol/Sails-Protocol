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
import { useState, type ReactNode } from 'react'
import type { Dispute } from '@satsails/p2p-trading-sdk'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { formatDateTime } from '../../lib/format'
import { DISPUTE_RULING_LABEL } from '../../lib/labels'
import { busyProps } from '../../lib/busy'
import { AlertTriangle } from 'lucide-react'
import { Alert } from '../ui/alert'
import { parseEvidence } from '../../lib/disputeCase'

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
  /** Who the dispute waits on now (the rail's bastão text), e.g. "Com o árbitro"; omitted when the records do not say. */
  turnLabel?: string | null
  /** Host slot after the opening alert (the timelock, a ruling's signing round). */
  children?: ReactNode
}

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
  onEvidenceNoteChange, onSubmitEvidence, onContestAutoResolution, onAppeal, turnLabel, children,
}: Props) {
  const isParty = isBuyer || isSeller
  // Shared `acting`: the clicked action shows loading, the others are blocked (lib/busy.ts).
  const [running, setRunning] = useState<string | null>(null)
  const run = (key: string, fn: () => void) => () => { setRunning(key); fn() }
  const resolved = dispute.status === 'RESOLVED'
  // One reading of Dispute.evidence for the trade page and the arbiter console (SDK descriptor field: `uri`).
  const evidence = parseEvidence(dispute.evidence)

  return (
    <section aria-label="Disputa" className="rounded-lg border border-brand-border-subtle bg-brand-surface p-4 space-y-3">
      {resolved ? (
        <p className="text-sm font-semibold text-brand-text">Disputa resolvida</p>
      ) : (
        <Alert tone="danger" live icon={AlertTriangle} className="text-sm">
          Disputa aberta por <strong className="font-semibold">{partyLabel(dispute.openedBy)}</strong> em {formatDateTime(dispute.createdAt)}. As ações normais do trade ficam suspensas até a resolução.
        </Alert>
      )}
      {turnLabel && (
        <p className="text-sm text-brand-text-secondary">
          Agora: <strong className="font-semibold text-brand-text">{turnLabel}</strong>
        </p>
      )}
      {children}

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
                  {[`Tipo: ${ev.type}`, ev.submittedBy ? `Enviada por ${partyLabel(ev.submittedBy)}` : null, ev.submittedAt ? formatDateTime(ev.submittedAt) : null].filter(Boolean).join(' · ')}
                </p>
                {ev.note && <p className="mt-0.5 whitespace-pre-line [overflow-wrap:anywhere]">{ev.note}</p>}
                {ev.uri && (ev.href
                  ? <a href={ev.href} target="_blank" rel="noopener noreferrer nofollow" className="mt-0.5 inline-block text-brand-link underline [overflow-wrap:anywhere]">{ev.uri}</a>
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
            <Button variant="outline" onClick={run('evidence', onSubmitEvidence)} disabled={!evidenceNote.trim()} {...busyProps(acting, running, 'evidence')} className="mt-2 min-h-11 text-sm">
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
            <Button variant="outline" onClick={run('contest', onContestAutoResolution)} {...busyProps(acting, running, 'contest')} className="mt-2 min-h-11 text-sm">
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
                Você ainda pode apelar: a apelação reabre a disputa para um novo árbitro. O nó Sails pode recusá-la conforme o tipo de escrow e a configuração de arbitragem.
              </p>
              <Button variant="outline" onClick={run('appeal', onAppeal)} {...busyProps(acting, running, 'appeal')} className="mt-2 min-h-11 text-sm">
                Apelar da decisão
              </Button>
            </>
          )}
        </Section>
      )}
    </section>
  )
}
