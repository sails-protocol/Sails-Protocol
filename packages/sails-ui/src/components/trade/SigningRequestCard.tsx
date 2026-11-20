/**
 * Layer A: a pending escrow transaction the viewer may be asked to sign —
 * what it authorizes, where the funds go, signature progress and the
 * verification result. Presentational only: the view-model comes from
 * deriveSigningRequest(), the copy for loading/error from the host page,
 * and nothing is signed or cancelled here — the buttons only ask the host
 * to open its confirmation step or to re-read the round.
 */
import { useId } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Hourglass, Info, Loader2, PenLine, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react'
import type { SigningRequestView } from '../../lib/signingRequest'
import { Button } from '../ui/button'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'

type Props =
  | { status: 'loading'; label: string }
  | { status: 'error'; message: string; retryLabel: string; onRetry: () => void }
  | { status: 'ready'; view: SigningRequestView; acting: boolean; onReview: () => void; onCancel: () => void; onRefresh: () => void }

const shell = 'mt-4 rounded-lg border border-brand-border-subtle bg-brand-elevated p-4 border-t-4'

export function SigningRequestCard(props: Props) {
  const titleId = useId()

  if (props.status === 'loading') {
    return (
      <section aria-busy="true" className={cn(shell, 'border-t-brand-border')}>
        <p role="status" className="flex items-center gap-2 text-sm text-brand-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {props.label}
        </p>
      </section>
    )
  }

  if (props.status === 'error') {
    return (
      <section className={cn(shell, 'border-t-brand-warning')}>
        <p role="alert" className="flex items-start gap-2 text-sm text-brand-text">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-brand-warning" aria-hidden="true" />
          {props.message}
        </p>
        <Button variant="outline" onClick={props.onRetry} className="mt-3 w-full min-h-11 text-sm">
          {props.retryLabel}
        </Button>
      </section>
    )
  }

  const { view, acting, onReview, onCancel, onRefresh } = props
  const ActorIcon = view.state === 'sign' ? PenLine : view.state === 'blocked' ? ShieldAlert : view.state === 'complete' ? CheckCircle2 : Hourglass
  const check = view.check

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        shell,
        view.state === 'sign' ? 'border-t-brand-orange' : view.state === 'blocked' ? 'border-t-brand-danger' : 'border-t-brand-border',
      )}
    >
      <p className={cn(
        'flex items-center gap-1.5 text-xs font-medium',
        view.state === 'sign' ? 'text-brand-orange-accent' : view.state === 'blocked' ? 'text-brand-danger-fg' : 'text-brand-text-muted',
      )}>
        <ActorIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {view.actorLabel}
      </p>
      <h2 id={titleId} className="mt-1.5 text-heading text-brand-text">{view.title}</h2>
      <p role={view.state === 'waiting' || view.state === 'complete' ? 'status' : undefined} className="mt-1 text-sm text-brand-text-secondary">
        {view.description}
      </p>

      <dl className="mt-3 space-y-2">
        {view.destinations.map((d) => (
          <div key={d.label + d.address}>
            <dt className="text-xs text-brand-text-muted">{d.label}</dt>
            <dd className="mt-0.5 flex items-start gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-xs text-brand-text">{d.address}</span>
              <CopyButton value={d.address} className="shrink-0 min-h-11 sm:min-h-0" />
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3">
        <p className="text-xs font-medium text-brand-text-secondary">{view.progress.text}</p>
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {view.signers.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5 text-xs text-brand-text-secondary">
              {s.signed
                ? <CheckCircle2 className="h-3.5 w-3.5 text-brand-success" aria-hidden="true" />
                : <Circle className="h-3.5 w-3.5 text-brand-text-muted" aria-hidden="true" />}
              <span>{s.label}: {s.statusText}</span>
            </li>
          ))}
        </ul>
      </div>

      {check && (
        <div
          role={check.tone === 'ok' ? undefined : 'alert'}
          className={cn(
            'mt-3 rounded-md border p-3 text-sm',
            check.tone === 'ok' ? 'border-brand-success/30 bg-brand-success/10'
              : check.tone === 'danger' ? 'border-brand-danger/30 bg-brand-danger/10'
              : 'border-brand-warning/25 bg-brand-warning/10',
          )}
        >
          <p className="flex items-start gap-2 font-medium text-brand-text">
            {check.tone === 'ok'
              ? <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-brand-success" aria-hidden="true" />
              : check.tone === 'danger'
                ? <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-brand-danger" aria-hidden="true" />
                : <Info className="h-4 w-4 shrink-0 mt-0.5 text-brand-warning" aria-hidden="true" />}
            {check.title}
          </p>
          {check.note && <p className="mt-1.5 pl-6 text-xs text-brand-text-secondary">{check.note}</p>}
          {check.items.length > 0 && (
            <ul className="mt-2 space-y-1 pl-6 text-xs text-brand-text-secondary">
              {check.items.map((it, i) => (
                <li key={i} className={cn(check.tone !== 'ok' && 'list-disc')}>
                  {it.label}
                  {it.value && <>: <span className={cn('text-brand-text', it.mono && 'font-mono break-all')}>{it.value}</span></>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {view.primary && (
          <Button onClick={onReview} disabled={acting} className="w-full min-h-11 py-2.5 text-sm">
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {view.primary.label}
          </Button>
        )}
        {view.cancel && (
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={acting}
            className="w-full min-h-11 py-2 text-sm border-brand-danger/70 text-brand-danger-fg hover:bg-brand-danger/10 hover:text-brand-danger-fg"
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
            {view.cancel.label}
          </Button>
        )}
        <Button variant="outline" onClick={onRefresh} disabled={acting} className="w-full min-h-11 py-2 text-sm">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {view.refreshLabel}
        </Button>
      </div>
    </section>
  )
}
