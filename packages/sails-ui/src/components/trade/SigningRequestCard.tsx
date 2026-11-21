/**
 * Layer A: a pending escrow transaction the viewer may be asked to sign —
 * what it authorizes, where the funds go, signature progress and the
 * verification result. Presentational only: the view-model comes from
 * deriveSigningRequest(), the copy for loading/error from the host page,
 * and nothing is signed or cancelled here — the buttons only ask the host
 * to open its confirmation step or to re-read the round.
 *
 * `embedded`: rendered inside the current-stage card (or the dispute panel),
 * separated by a divider instead of its own box, heading one level down.
 */
import { useId, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Hourglass, Info, Loader2, PenLine, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react'
import type { SigningRequestView } from '../../lib/signingRequest'
import { Button } from '../ui/button'
import { CopyButton } from '../ui/CopyButton'
import { cn } from '../../lib/utils'
import { busyProps } from '../../lib/busy'
import { formatDateTime } from '../../lib/format'

type Props = { embedded?: boolean } & (
  | { status: 'loading'; label: string }
  | { status: 'error'; message: string; retryLabel: string; onRetry: () => void }
  | { status: 'ready'; view: SigningRequestView; acting: boolean; onReview: () => void; onCancel: () => void; onRefresh: () => void }
)

const boxed = 'mt-4 rounded-lg border border-brand-border-subtle bg-brand-elevated p-4 border-t-4'
// One boundary per element: inside a card the round is a section under a divider, never a box in a box.
const inCard = 'mt-4 border-t border-brand-border-subtle pt-4'

export function SigningRequestCard(props: Props) {
  const titleId = useId()
  // Shared `acting`: the clicked action shows loading, the others are blocked (lib/busy.ts).
  const [running, setRunning] = useState<string | null>(null)
  const shell = props.embedded ? inCard : boxed
  // The top accent belongs to the boxed card only.
  const accent = (c: string) => (props.embedded ? '' : c)
  const Heading = props.embedded ? 'h3' : 'h2'

  if (props.status === 'loading') {
    return (
      <section aria-busy="true" className={cn(shell, accent('border-t-brand-border'))}>
        <p role="status" className="flex items-center gap-2 text-sm text-brand-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {props.label}
        </p>
      </section>
    )
  }

  if (props.status === 'error') {
    return (
      <section className={cn(shell, accent('border-t-brand-warning'))}>
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
  const run = (key: string, fn: () => void) => () => { setRunning(key); fn() }
  const ActorIcon = view.state === 'sign' ? PenLine : view.state === 'blocked' ? ShieldAlert : view.state === 'complete' ? CheckCircle2 : Hourglass
  const check = view.check

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        shell,
        accent(view.state === 'sign' ? 'border-t-brand-orange' : view.state === 'blocked' ? 'border-t-brand-danger' : 'border-t-brand-border'),
      )}
    >
      <p className={cn(
        'flex items-center gap-1.5 text-xs font-medium',
        view.state === 'sign' ? 'text-brand-orange-accent' : view.state === 'blocked' ? 'text-brand-danger-fg' : 'text-brand-text-muted',
      )}>
        <ActorIcon className="size-icon-xs" aria-hidden="true" />
        {view.actorLabel}
      </p>
      <Heading id={titleId} className="mt-1.5 text-heading text-brand-text">{view.title}</Heading>
      <p role={view.state === 'waiting' || view.state === 'complete' ? 'status' : undefined} className="mt-1 text-sm text-brand-text-secondary">
        {view.description}
      </p>

      <dl className="mt-3 space-y-2">
        {view.destinations.map((d) => (
          <div key={d.label + d.address}>
            <dt className="text-xs text-brand-text-muted">{d.label}</dt>
            <dd className="mt-0.5 flex items-start gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-xs text-brand-text">{d.address}</span>
              <CopyButton value={d.address} className="shrink-0 touch:min-h-11" />
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
                ? <CheckCircle2 className="size-icon-xs text-brand-success" aria-hidden="true" />
                : <Circle className="size-icon-xs text-brand-text-muted" aria-hidden="true" />}
              <span>{s.label}: {s.statusText}{s.at && ` · ${formatDateTime(s.at)}`}</span>
            </li>
          ))}
        </ul>
      </div>

      {check && (
        <div
          role={check.tone === 'ok' ? undefined : 'alert'}
          className={cn(
            // Alert look (DESIGN_SYSTEM.md 5.3): tint + icon, no border inside the card.
            'mt-3 rounded-md p-3 text-sm',
            check.tone === 'ok' ? 'bg-brand-success-bg' : check.tone === 'danger' ? 'bg-brand-danger-bg' : 'bg-brand-warning-bg',
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
          <Button onClick={run('review', onReview)} {...busyProps(acting, running, 'review')} className="w-full min-h-11 py-2.5 text-sm">
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {view.primary.label}
          </Button>
        )}
        {view.cancel && (
          <Button
            variant="outline"
            onClick={run('cancel', onCancel)}
            {...busyProps(acting, running, 'cancel')}
            className="w-full min-h-11 py-2 text-sm border-brand-danger/70 text-brand-danger-fg hover:bg-brand-danger/10 hover:text-brand-danger-fg"
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
            {view.cancel.label}
          </Button>
        )}
        <Button variant="outline" onClick={run('refresh', onRefresh)} {...busyProps(acting, running, 'refresh')} className="w-full min-h-11 py-2 text-sm">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {view.refreshLabel}
        </Button>
      </div>
    </section>
  )
}
