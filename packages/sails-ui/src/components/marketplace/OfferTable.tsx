import { Link } from 'react-router'
import type { Offer } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { PaymentBadge } from '../ui/StatusBadges'
import { buttonVariants } from '../ui/button'
import { formatAmount } from '../../lib/format'
import { formatPrice } from '../../lib/currency'
import { ASSET_LABELS, ASSET_SHORT_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { cn } from '../../lib/utils'
import { Check } from 'lucide-react'
import { sellerTrust } from './offerList'
import { TrustLine } from '../ui/TrustLine'
import { ExplanationPopover } from '../ui/ExplanationPopover'
import { REPUTATION_EXPLANATION } from '../../lib/reputation'

const SELLER_FALLBACK = 'Anunciante'

/**
 * Desktop offer table: Anunciante | Preço | Limites | Pagamento | Ação.
 * Rows are split by one hairline, no boxes. The action is the row's one real link
 * (keyboard reachable); its ::after stretches over the row so the whole row is clickable.
 */
export function OfferTable({ offers, isOwn }: { offers: Offer[]; isOwn?: (offer: Offer) => boolean }) {
  return (
    <table className="w-full table-fixed text-left border-collapse">
      <caption className="sr-only">Ofertas</caption>
      {/* Fixed widths (narrower from 1024, full from 1280); only the seller column absorbs extra width. */}
      <colgroup>
        <col />
        <col className="w-[9.5rem] xl:w-[11rem]" />
        <col className="w-[10rem] xl:w-[12.5rem]" />
        <col className="w-[10rem] xl:w-[12rem]" />
        <col className="w-[8rem]" />
      </colgroup>
      <thead>
        <tr className="text-xs font-medium text-brand-text-muted">
          <th scope="col" className="font-medium py-2.5 pl-5 pr-4">
            {/* The explanation sits in the header, not in a row: each row is already one stretched link. */}
            <span className="inline-flex items-center gap-1.5">
              Anunciante
              <ExplanationPopover explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.title} />
            </span>
          </th>
          <th scope="col" className="font-medium py-2.5 px-4">Preço</th>
          <th scope="col" className="font-medium py-2.5 px-4">Limites</th>
          <th scope="col" className="font-medium py-2.5 px-4">Pagamento</th>
          <th scope="col" className="py-2.5 pl-4 pr-5"><span className="sr-only">Ação</span></th>
        </tr>
      </thead>
      <tbody>
        {offers.map((offer) => <OfferTableRow key={offer.id} offer={offer} own={!!isOwn?.(offer)} />)}
      </tbody>
    </table>
  )
}

function OfferTableRow({ offer, own }: { offer: Offer; own: boolean }) {
  const { name, items } = sellerTrust(offer)
  // The viewer's own offer gets no trade action, only a quiet link to the offer.
  const action = own ? 'Sua oferta' : offer.side === 'SELL' ? 'Comprar' : 'Vender'
  const price = formatPrice(offer.priceFiat, offer.fiatCurrency)
  const limits = `${formatAmount(offer.minAmount)} – ${formatAmount(offer.maxAmount)} ${ASSET_SHORT_LABELS[offer.asset]}`
  const label = `${action} ${ASSET_LABELS[offer.asset]} por ${price}, ${name ?? SELLER_FALLBACK}, ${PAYMENT_METHOD_LABELS[offer.paymentMethod]}, limites ${limits}`

  return (
    <tr className="relative h-[4.25rem] border-t border-brand-border-subtle transition-colors hover:bg-brand-elevated/60">
      <td className="py-3 pl-5 pr-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <UserAvatar user={{ id: offer.user.id, displayName: name ?? SELLER_FALLBACK }} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span data-seller-name className="text-sm font-medium text-brand-text truncate">{name ?? SELLER_FALLBACK}</span>
              {offer.user.verified && <Check aria-label="Verificado" className="h-3.5 w-3.5 shrink-0 text-brand-orange-accent" />}
            </div>
            <TrustLine items={items} className="block text-xs text-brand-text-muted" />
          </div>
        </div>
      </td>
      <td className="py-3 px-4">
        <div data-price className="text-lg font-semibold text-brand-text tabular-nums leading-tight whitespace-nowrap">{price}</div>
        <div className="text-xs text-brand-text-muted whitespace-nowrap">por {ASSET_LABELS[offer.asset]}</div>
      </td>
      <td className="py-3 px-4 text-body-sm text-brand-text-secondary tabular-nums whitespace-nowrap">{limits}</td>
      <td className="py-3 px-4">
        <PaymentBadge method={offer.paymentMethod} />
      </td>
      <td className="py-3 pl-4 pr-5 text-right">
        <Link
          to={`/offer/${offer.id}`}
          aria-label={label}
          className={cn(
            own
              ? 'inline-flex min-h-9 items-center text-xs font-medium text-brand-text-secondary hover:text-brand-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md'
              : cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-w-[5.5rem]'),
            'after:absolute after:inset-0 after:content-[""]'
          )}
        >
          {action}
        </Link>
      </td>
    </tr>
  )
}
