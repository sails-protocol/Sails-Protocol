/**
 * Layer C: Perguntas frequentes (/settings/help/faq; DECISIONS.md, CTO/PO 2026-11-23). Real content in demo and
 * real mode alike, so no "Simulado" marker. Group headings, one disclosure per question (any number open), and a
 * stable anchor per question: opening `#faq-<slug>` opens that answer and scrolls to it. Tables become stacked
 * lists below sm; the step diagrams are StepFlow.
 */
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { Card } from '../components/ui/card'
import { StepFlow, type FlowStep } from '../components/ui/StepFlow'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { SafetyCenterLink } from '../components/safety/SafetyCenterLink'
import { FAQ_GROUPS, FAQ_ITEMS, FAQ_LINKS, faqAnchor, faqSlugFromHash, type FaqExtra, type FaqItem } from '../lib/faq'
import { ESCROW_STATE_LABEL } from '../lib/tradeState'
import { cn } from '../lib/utils'
import { t, type MessageKey } from '../i18n'

const k = (key: string) => t(key as MessageKey)

/** One table: real <table> from sm, a stacked list of label/value pairs below (each row its own group). */
function FaqTable({ caption, cols, rows }: { caption: string; cols: string[]; rows: string[][] }) {
  return (
    <div className="mt-3">
      <Table className="hidden text-body-sm sm:table">
        <caption className="pb-1 text-left text-caption font-medium text-brand-text-secondary">{caption}</caption>
        <TableHeader>
          <TableRow className="border-t-0">{cols.map((c) => <TableHead key={c} className="px-0 pr-4">{c}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r[0]}>
              {r.map((cell, i) => <TableCell key={i} className={cn('px-0 pr-4 align-top', i === 0 ? 'font-medium text-brand-text' : 'text-brand-text-secondary')}>{cell}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="sm:hidden">
        <p className="text-caption font-medium text-brand-text-secondary">{caption}</p>
        <ul className="mt-1 divide-y divide-brand-border-subtle">
          {rows.map((r) => (
            <li key={r[0]} className="py-2">
              <dl className="space-y-0.5 text-body-sm">
                {r.map((cell, i) => (
                  <div key={i} className={i === 0 ? 'font-medium text-brand-text' : 'text-brand-text-secondary'}>
                    <dt className={i === 0 ? 'sr-only' : 'inline text-caption text-brand-text-muted'}>{cols[i]}{i > 0 && ': '}</dt>
                    <dd className="inline">{cell}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Extra({ id }: { id: FaqExtra }) {
  if (id === 't1') {
    return (
      <FaqTable
        caption={k('faq.t1.caption')}
        cols={[k('faq.t1.col.state'), k('faq.t1.col.who'), k('faq.t1.col.todo')]}
        rows={[
          [ESCROW_STATE_LABEL.CREATED, k('faq.t1.who.seller'), k('faq.t1.todo.created')],
          [ESCROW_STATE_LABEL.FUNDS_LOCKED, k('faq.t1.who.buyer'), k('faq.t1.todo.fundsLocked')],
          [ESCROW_STATE_LABEL.PAYMENT_PENDING, k('faq.t1.who.seller'), k('faq.t1.todo.paymentPending')],
          [k('faq.t1.signing'), k('faq.t1.who.signers'), k('faq.t1.todo.signing')],
          [ESCROW_STATE_LABEL.COMPLETED, k('faq.t1.who.nobody'), k('faq.t1.todo.completed')],
          [ESCROW_STATE_LABEL.DISPUTED, k('faq.t1.who.arbiter'), k('faq.t1.todo.disputed')],
        ]}
      />
    )
  }
  if (id === 't2') {
    return (
      <FaqTable
        caption={k('faq.t2.caption')}
        cols={[k('faq.t2.col.does'), k('faq.t2.col.doesNot')]}
        rows={[1, 2, 3, 4].map((n) => [k(`faq.t2.does${n}`), k(`faq.t2.not${n}`)])}
      />
    )
  }
  if (id === 't4') {
    return (
      <FaqTable
        caption={k('faq.fees.t4.caption')}
        cols={[k('faq.fees.t4.col.fee'), k('faq.fees.t4.col.today'), k('faq.fees.t4.col.note')]}
        rows={['protocol', 'network', 'external', 'space'].map((r) => [k(`faq.fees.t4.${r}`), k(`faq.fees.t4.${r}Today`), k(`faq.fees.t4.${r}Note`)])}
      />
    )
  }
  // D1: the person acts on "Pagamento enviado". D2: the dashed links are branches that may not happen.
  const steps: FlowStep[] = id === 'd1'
    ? [1, 2, 3, 4, 5].map((n) => ({ label: k(`faq.d1.s${n}`), yours: n === 3 }))
    : [
      { label: k('faq.d2.s1') },
      { label: k('faq.d2.s2'), yours: true, link: 'dashed' },
      { label: k('faq.d2.s3') },
      { label: k('faq.d2.s4'), link: 'dashed' },
    ]
  return <StepFlow steps={steps} label={k(`faq.${id}.aria`)} className="mt-3" />
}

function Question({ item, open, onToggle }: { item: FaqItem; open: boolean; onToggle: () => void }) {
  const id = faqAnchor(item.slug)
  // The fee item keeps its keys under faq.fees.* (economy guard whitelist); every other answer is faq.<key>.a.
  const answer = item.key === 'fees' ? [k('faq.fees.answer'), k('faq.fees.note')] : [k(`faq.${item.key}.a`)]
  return (
    <li id={id} className="scroll-mt-20">
      <h3>
        <button
          type="button"
          id={`${id}-button`}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={onToggle}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-brand-text transition-colors state-layer focus-visible:-outline-offset-2"
        >
          <span className="min-w-0 flex-1">{k(`faq.${item.key}.q`)}</span>
          <ChevronDown aria-hidden="true" className={cn('size-icon-sm shrink-0 text-brand-text-muted transition-transform duration-short', open && 'rotate-180')} />
        </button>
      </h3>
      <div id={`${id}-panel`} role="region" aria-labelledby={`${id}-button`} hidden={!open} className="px-4 pb-4">
        {answer.map((p) => <p key={p} className="mt-1 max-w-[68ch] text-body-sm text-brand-text-secondary first:mt-0">{p}</p>)}
        {item.extras?.map((e) => <Extra key={e} id={e} />)}
        {item.links && (
          <p className="mt-2 flex flex-wrap gap-x-4 text-body-sm">
            {item.links.map((l) => <Link key={l} to={FAQ_LINKS[l]} className="inline-flex min-h-8 touch:min-h-11 items-center font-medium text-brand-link underline underline-offset-2 hover:decoration-2">{k(`faq.link.${l}`)}</Link>)}
          </p>
        )}
        {item.more && (
          <p className="mt-3 flex flex-wrap items-center gap-x-4 text-body-sm">
            <span className="basis-full text-caption text-brand-text-muted">{t('faq.learnMore')}</span>
            {item.more.map((page) => <SafetyCenterLink key={page} page={page}>{k(`faq.more.${page}`)}</SafetyCenterLink>)}
          </p>
        )}
      </div>
    </li>
  )
}

export function Faq() {
  const { hash } = useLocation()
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  // A deep link (#faq-escrow) opens that answer and brings it into view, with focus on its question.
  useEffect(() => {
    const slug = faqSlugFromHash(hash)
    if (!slug) return
    setOpen((prev) => new Set(prev).add(slug))
    // After the open answer renders (a timeout, not rAF: it also runs in a background tab).
    const timer = setTimeout(() => {
      const el = document.getElementById(faqAnchor(slug))
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      el?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
      document.getElementById(`${faqAnchor(slug)}-button`)?.focus({ preventScroll: true })
    }, 0)
    return () => clearTimeout(timer)
  }, [hash])

  const toggle = (slug: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (!next.delete(slug)) next.add(slug)
    return next
  })

  return (
    <Page width="form">
      <PageHeader
        title={t('faq.title')}
        back={(
          <Link to="/settings?section=ajuda" className="-my-2 inline-flex min-h-11 items-center gap-1 rounded-md text-body-sm text-brand-text-secondary hover:text-brand-text">
            <ArrowLeft className="size-icon-sm" aria-hidden="true" /> {t('settings.section.help')}
          </Link>
        )}
      />
      <div className="space-y-6">
        {FAQ_GROUPS.map((g) => (
          <section key={g} aria-labelledby={`faq-group-${g}`}>
            <h2 id={`faq-group-${g}`} className="mb-2 text-section-title">{k(`faq.group.${g}`)}</h2>
            <Card className="overflow-hidden border-brand-border-subtle bg-brand-surface">
              <ul className="divide-y divide-brand-border-subtle">
                {FAQ_ITEMS.filter((i) => i.group === g).map((i) => (
                  <Question key={i.slug} item={i} open={open.has(i.slug)} onToggle={() => toggle(i.slug)} />
                ))}
              </ul>
            </Card>
          </section>
        ))}
      </div>
    </Page>
  )
}
