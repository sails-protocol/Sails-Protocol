/**
 * C12: the two contest blocks of a dispute on the trade page (lib/disputeAppeal.ts holds every rule).
 * A. Contest of the arbiter's decision: only what the backend view says; without the view (production today) an
 *    honest "not available" line, with no deadline, countdown or button.
 * B. Contest of the automatic suggestion: only for AUTO_PROPOSED with a backend deadline, with a countdown on
 *    the server-corrected clock (lib/serverClock.ts), amber under 1 h, announced only at key moments.
 * Every action opens the page's confirmation dialog; the backend decides at submission. When a deadline reaches
 * zero with the screen open, the block switches to the expired visual at once and asks the page to re-read.
 * Status = icon + label (+ tint only for notices); danger only for errors. Flat inside the dispute panel.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Dispute } from '@satsails/p2p-trading-sdk'
import { AlertTriangle, CheckCircle2, Clock, Info, type LucideIcon } from 'lucide-react'
import { Alert } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { busyProps } from '../../lib/busy'
import { cn } from '../../lib/utils'
import { formatDateTime } from '../../lib/format'
import { formatRemaining, remainingAnnouncement } from '../../lib/escrowDeadline'
import {
  deriveAppealBlock, deriveContestBlock, type AppealViewState, type DeadlineDisplay, type SubmitFailure,
} from '../../lib/disputeAppeal'
import { serverNow } from '../../lib/serverClock'
import { useMilestoneAnnouncement, useTickingNow } from './useDeadlineClock'
import { t, type MessageKey } from '../../i18n'

/** The outcome of a refused or unconfirmed submission, shown in its block until the next action. */
export interface DisputeNotice {
  block: 'appeal' | 'contest'
  kind: SubmitFailure | 'refreshFailed'
  /** The page is re-reading the dispute; no new send until it ends. */
  refreshing: boolean
  /** For refreshFailed: the outcome the failed re-read was for, kept for "Tentar de novo". */
  cause?: SubmitFailure
}

interface Props {
  dispute: Dispute
  isParty: boolean
  view: AppealViewState
  /** Demo mode: every state here is fictional and carries the visible "Demonstração" badge. */
  demo: boolean
  acting: boolean
  notice: DisputeNotice | null
  onAppeal: () => void
  onContest: () => void
  /** A shown deadline reached zero with the screen open: re-read the dispute (once per deadline). */
  onDeadlinePassed: () => void
  onRetryView: () => void
  onRetryRefresh: () => void
}

const NOTICE_KEY: Record<DisputeNotice['kind'], MessageKey> = {
  changed: 'trade.dispute.noticeChanged',
  forbidden: 'trade.dispute.noticeForbidden',
  notFound: 'trade.dispute.noticeNotFound',
  unknown: 'trade.dispute.noticeUnknownDone',
  refreshFailed: 'trade.dispute.noticeRefreshFailed',
}

function StatusLine({ icon: Icon, tone = 'neutral', children }: { icon: LucideIcon; tone?: 'neutral' | 'warning' | 'info'; children: ReactNode }) {
  const color = tone === 'warning' ? 'text-brand-warning' : tone === 'info' ? 'text-brand-info' : 'text-brand-text-secondary'
  return (
    <p className="flex gap-2 text-body-sm text-brand-text">
      <Icon aria-hidden="true" className={cn('mt-0.5 size-icon-sm shrink-0', color)} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function DeadlineRow({ label, deadline }: { label: string; deadline: DeadlineDisplay }) {
  const ended = deadline.remainingMs <= 0
  const attention = !ended && deadline.tone === 'attention'
  const announcement = useMilestoneAnnouncement(deadline.milestone)
  const remainingText = ended ? t('trade.dispute.deadlineEnded') : formatRemaining(deadline.remainingMs)
  return (
    <>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 min-[360px]:grid-cols-2">
        <div>
          <dt className="text-caption text-brand-text-secondary">{label}</dt>
          <dd className="text-body-sm tabular-nums text-brand-text">{formatDateTime(deadline.at)}</dd>
        </div>
        <div>
          <dt className="text-caption text-brand-text-secondary">{t('trade.dispute.remaining')}</dt>
          <dd className={cn('flex items-center gap-1.5 text-body-sm font-medium tabular-nums', attention || ended ? 'text-brand-warning-fg' : 'text-brand-text')}>
            {(attention || ended) ? <AlertTriangle aria-hidden="true" className="size-icon-sm shrink-0" /> : <Clock aria-hidden="true" className="size-icon-sm shrink-0" />}
            <span aria-hidden="true">{remainingText}</span>
            <span className="sr-only">{remainingAnnouncement(remainingText, ended ? 'expired' : deadline.tone)}</span>
          </dd>
        </div>
      </dl>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </>
  )
}

function Block({ title, demo, children }: { title: string; demo: boolean; children: ReactNode }) {
  return (
    <div className="border-t border-brand-border-subtle pt-3">
      <h3 className="flex flex-wrap items-center gap-2 text-xs font-semibold text-brand-text-secondary">
        {title}
        {demo && <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text">{t('trade.dispute.demoBadge')}</Badge>}
      </h3>
      <div className="mt-1 space-y-2">{children}</div>
      {demo && <p className="mt-2 text-caption text-brand-text-secondary">{t('trade.dispute.demoNote')}</p>}
    </div>
  )
}

function NoticeAlert({ notice, onRetryRefresh }: { notice: DisputeNotice; onRetryRefresh: () => void }) {
  const danger = notice.kind === 'forbidden' || notice.kind === 'notFound' || notice.kind === 'refreshFailed'
  const text = notice.kind === 'unknown' && notice.refreshing ? t('trade.dispute.noticeUnknownRefreshing') : t(NOTICE_KEY[notice.kind])
  return (
    <Alert
      tone={danger ? 'danger' : 'warning'}
      live
      action={notice.kind === 'refreshFailed' ? <Button variant="outline" onClick={onRetryRefresh} className="min-h-10 touch:min-h-11 text-sm">{t('trade.dispute.retry')}</Button> : undefined}
    >
      {text}
    </Alert>
  )
}

export function DisputeAppealBlock({
  dispute, isParty, view, demo, acting, notice, onAppeal, onContest, onDeadlinePassed, onRetryView, onRetryRefresh,
}: Props) {
  // Only a shown deadline ticks: B's from the dispute or view, A's only when the view has a non-null one.
  const first = { contest: deriveContestBlock(dispute, isParty, view, serverNow()), appeal: deriveAppealBlock(dispute, view, serverNow()) }
  const running = first.contest.kind !== 'hidden' ? first.contest.deadline.at : first.appeal.kind === 'open' ? first.appeal.deadline?.at : undefined
  const now = useTickingNow(running ? Date.parse(running) : null, serverNow)
  const contest = deriveContestBlock(dispute, isParty, view, now)
  const appeal = deriveAppealBlock(dispute, view, now)

  const [runningKey, setRunningKey] = useState<string | null>(null)
  const run = (key: string, fn: () => void) => () => { setRunningKey(key); fn() }

  // Zero reached with the screen open: re-read once per deadline (the backend decides; this only refreshes).
  const firedFor = useRef<string | null>(null)
  const passed = contest.kind === 'expired' ? contest.deadline.at : appeal.kind === 'expired' ? appeal.deadlineAt ?? null : null
  useEffect(() => {
    if (passed && firedFor.current !== passed) { firedFor.current = passed; onDeadlinePassed() }
  }, [passed, onDeadlinePassed])

  const noticeFor = (block: DisputeNotice['block']) => notice?.block === block ? <NoticeAlert notice={notice} onRetryRefresh={onRetryRefresh} /> : null
  const busy = acting || !!notice?.refreshing

  return (
    <>
      {contest.kind !== 'hidden' && (
        <Block title={t('trade.dispute.contestTitle')} demo={demo}>
          {contest.kind === 'open' ? (
            <>
              <p className="text-body-sm text-brand-text">{t('trade.dispute.contestEffect')}</p>
              <p className="text-body-sm text-brand-text-secondary">{t('trade.dispute.contestRule')}</p>
            </>
          ) : (
            <StatusLine icon={Info}>{t('trade.dispute.contestExpired')}</StatusLine>
          )}
          <DeadlineRow label={t('trade.dispute.contestDeadline')} deadline={contest.deadline} />
          {noticeFor('contest')}
          {contest.kind === 'open' && contest.canContest && (
            <Button variant="outline" onClick={run('contest', onContest)} {...busyProps(busy, runningKey, 'contest')} className="min-h-10 touch:min-h-11 text-sm">
              {t('trade.dispute.contest')}
            </Button>
          )}
        </Block>
      )}

      {appeal.kind !== 'hidden' && (
        <Block title={t('trade.dispute.appealTitle')} demo={demo && appeal.kind !== 'unknown'}>
          {appeal.kind === 'loading' && (
            <div role="status" className="space-y-2">
              <span className="sr-only">{t('trade.dispute.appealLoading')}</span>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
          {appeal.kind === 'error' && (
            <Alert tone="danger" live action={<Button variant="outline" onClick={onRetryView} className="min-h-10 touch:min-h-11 text-sm">{t('trade.dispute.retry')}</Button>}>
              {t('trade.dispute.appealLoadFailed')}
            </Alert>
          )}
          {appeal.kind === 'unknown' && <StatusLine icon={Info}>{t('trade.dispute.appealUnknown')}</StatusLine>}
          {appeal.kind === 'not_available' && <StatusLine icon={Info}>{t('trade.dispute.appealNotAvailable')}</StatusLine>}
          {appeal.kind === 'submitted' && <StatusLine icon={Info} tone="info">{t('trade.dispute.appealSubmitted')}</StatusLine>}
          {appeal.kind === 'expired' && <StatusLine icon={Clock}>{t('trade.dispute.appealExpired')}</StatusLine>}
          {appeal.kind === 'resolved' && <StatusLine icon={CheckCircle2} tone="info">{t('trade.dispute.appealResolved')}</StatusLine>}
          {appeal.kind === 'open' && (
            <>
              <StatusLine icon={Info} tone="info">{t(appeal.canAppeal ? 'trade.dispute.appealOpen' : 'trade.dispute.appealNoRight')}</StatusLine>
              {appeal.deadline && <DeadlineRow label={t('trade.dispute.appealDeadline')} deadline={appeal.deadline} />}
            </>
          )}
          {noticeFor('appeal')}
          {appeal.kind === 'open' && appeal.canAppeal && (
            <Button variant="outline" onClick={run('appeal', onAppeal)} {...busyProps(busy, runningKey, 'appeal')} className="min-h-10 touch:min-h-11 text-sm">
              {t('trade.dispute.appealAction')}
            </Button>
          )}
        </Block>
      )}
    </>
  )
}
