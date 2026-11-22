/**
 * Layer A: "Prévia do mercado criado" (DECISIONS.md "Criar mercado, fluxo completo com dados reais"). Shows a
 * MarketPreviewModel (lib/createMarket.ts) as the market page its participants would see and, for a private market,
 * the invites screen. `banner` is the caller's persistent label (preview or demo, plus its dependencies). Nothing here
 * is persisted or sent. Copy from props, tokens only.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Inbox, Pencil, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { StateBlock } from '../ui/StateBlock'
import { MarketIcon } from './MarketIcon'
import type { MarketPreviewModel } from '../../lib/createMarket'
import type { MarketInfrastructure, MarketVisibility } from '../../lib/myMarkets'

export interface MarketPreviewCopy {
  title: string
  visibility: Record<MarketVisibility, string>
  noDescription: string
  facts: {
    marketId: string
    marketIdPending: string
    brand: string
    brandPending: string
    participation: string
    publishes: string
    trades: string
    infrastructure: string
  }
  preset: Record<MarketPreviewModel['preset'], { label: string; publishes: string; trades: string }>
  infrastructure: Record<MarketInfrastructure, string>
  offersTitle: string
  offersEmptyTitle: string
  offersEmptyBody: string
  invitesTitle: string
  invitesLead: string
  invitesEmpty: string
  pending: string
  statesTitle: string
  states: readonly { key: string; title: string; description: string }[]
  edit: string
  discard: string
}

const SECTION = 'rounded-lg bg-brand-elevated p-4'

export function MarketPreview({ preview, copy, banner, onEdit, onDiscard }: {
  preview: MarketPreviewModel
  copy: MarketPreviewCopy
  banner: ReactNode
  onEdit: () => void
  onDiscard: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Land keyboard and screen-reader users on the preview they just opened.
  useEffect(() => { headingRef.current?.focus() }, [])
  const preset = copy.preset[preview.preset]
  const facts: readonly [string, ReactNode][] = [
    [copy.facts.marketId, <span className="text-brand-text-secondary">{copy.facts.marketIdPending}</span>],
    [copy.facts.brand, <span className="text-brand-text-secondary">{copy.facts.brandPending}</span>],
    [copy.facts.participation, preset.label],
    [copy.facts.publishes, preset.publishes],
    [copy.facts.trades, preset.trades],
    [copy.facts.infrastructure, copy.infrastructure[preview.infrastructure]],
  ]
  return (
    <div className="space-y-4">
      <h2 ref={headingRef} tabIndex={-1} className="text-section-title outline-none">{copy.title}</h2>
      {banner}

      <section aria-labelledby="market-preview-name" className={SECTION}>
        <div className="flex items-start gap-3">
          <MarketIcon market={{ relation: 'admin', visibility: preview.visibility }} size="lg" className="bg-brand-surface" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 id="market-preview-name" className="min-w-0 break-words text-sm font-medium text-brand-text">{preview.name}</h3>
              <Badge variant="outline" className="border-transparent bg-brand-tonal font-medium text-brand-text-secondary">{copy.visibility[preview.visibility]}</Badge>
            </div>
            <p className="mt-0.5 break-words text-caption text-brand-text-secondary">{preview.description ?? copy.noDescription}</p>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-brand-border-subtle">
          {facts.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
              <dt className="text-caption text-brand-text-muted sm:w-40 sm:shrink-0">{k}</dt>
              <dd className="min-w-0 break-words text-body-sm text-brand-text">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="market-preview-offers" className={SECTION}>
        <h3 id="market-preview-offers" className="text-sm font-medium text-brand-text">{copy.offersTitle}</h3>
        <StateBlock kind="empty" bare icon={Inbox} title={copy.offersEmptyTitle} description={copy.offersEmptyBody} className="py-6" />
      </section>

      {preview.invites && (
        <section aria-labelledby="market-preview-invites" className={SECTION}>
          <h3 id="market-preview-invites" className="text-sm font-medium text-brand-text">{copy.invitesTitle}</h3>
          <p className="mt-0.5 text-caption text-brand-text-secondary">{copy.invitesLead}</p>
          {preview.invites.length === 0 ? (
            <p className="mt-3 text-body-sm text-brand-text-secondary">{copy.invitesEmpty}</p>
          ) : (
            <ul aria-label={copy.invitesTitle} className="mt-3 divide-y divide-brand-border-subtle">
              {preview.invites.map((i) => (
                <li key={i.identifier} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span translate="no" className="min-w-0 flex-1 break-all font-mono text-caption text-brand-text">{i.identifier}</span>
                  <Badge variant="outline" className="shrink-0 border-transparent bg-brand-tonal font-medium text-brand-text">{copy.pending}</Badge>
                </li>
              ))}
            </ul>
          )}
          <h4 className="mt-4 text-caption font-medium text-brand-text">{copy.statesTitle}</h4>
          <dl className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.states.map((s) => (
              <div key={s.key} className="min-w-0">
                <dt className="text-caption font-medium text-brand-text">{s.title}</dt>
                <dd className="text-caption text-brand-text-secondary">{s.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" onClick={onDiscard} className="touch:min-h-11">
          <Trash2 aria-hidden="true" />{copy.discard}
        </Button>
        <Button type="button" variant="secondary" onClick={onEdit} className="touch:min-h-11">
          <Pencil aria-hidden="true" />{copy.edit}
        </Button>
      </div>
    </div>
  )
}
