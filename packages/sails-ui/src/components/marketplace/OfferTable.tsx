import { Link } from 'react-router'
import type { Offer } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { PaymentMethods } from '../ui/PaymentMethods'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

const SELLER_FALLBACK = 'Anunciante'

/**
 * Desktop offer table: Anunciante | Preço | Limites | Pagamento | Ação.
 * Rows are split by one hairline, no boxes. The action is the row's one real link
 * (keyboard reachable); its ::after stretches over the row so the whole row is clickable.
 */
export function OfferTable({ offers, isOwn }: { offers: Offer[]; isOwn?: (offer: Offer) => boolean }) {
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Ofertas</caption>
      {/* Fixed widths (narrower from 1024, full from 1280); only the seller column absorbs extra width. */}
      <colgroup>
        <col />
        <col className="w-[11rem] xl:w-[12rem]" />
        <col className="w-[9.5rem] xl:w-[12rem]" />
        <col className="w-[10rem] xl:w-[12rem]" />
        <col className="w-[8rem]" />
      </colgroup>
      <TableHeader>
        <tr>
          <TableHead className="pl-5">
            {/* The explanation sits in the header, not in a row: each row is already one stretched link. */}
            <span className="inline-flex items-center gap-1.5">
              Anunciante
              <ExplanationPopover explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.title} />
            </span>
          </TableHead>
          <TableHead>Preço</TableHead>
          <TableHead>Limites</TableHead>
          <TableHead>Pagamento</TableHead>
          <TableHead className="pr-5"><span className="sr-only">Ação</span></TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {offers.map((offer) => <OfferTableRow key={offer.id} offer={offer} own={!!isOwn?.(offer)} />)}
      </TableBody>
    </Table>
  )
}

function OfferTableRow({ offer, own }: { offer: Offer; own: boolean }) {
  const { name, items } = sellerTrust(offer)
  // The viewer's own offer gets no trade action, only a quiet link to the offer.
  const action = own ? 'Sua oferta' : offer.side === 'SELL' ? 'Comprar' : 'Vender'
  const price = formatPrice(offer.priceFiat, offer.fiatCurrency)
  const limits = `${formatAmount(offer.minAmount)} – ${formatAmount(offer.maxAmount)} ${ASSET_SHORT_LABELS[offer.asset]}`
  // One method per offer today (schema); the list component already handles several.
  const methods = [offer.paymentMethod].map((m) => PAYMENT_METHOD_LABELS[m])
  const label = `${action} ${ASSET_LABELS[offer.asset]} por ${price}, ${name ?? SELLER_FALLBACK}, ${methods.join(', ')}, limites ${limits}`

  return (
    <TableRow interactive className="relative h-[4.25rem]">
      <TableCell className="pl-5">
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
      </TableCell>
      <TableCell>
        <div data-price className="money-lg text-brand-text whitespace-nowrap">{price}</div>
        <div className="text-xs text-brand-text-muted whitespace-nowrap">por {ASSET_LABELS[offer.asset]}</div>
      </TableCell>
      <TableCell className="text-body-sm text-brand-text-secondary tabular-nums whitespace-nowrap">{limits}</TableCell>
      <TableCell>
        <PaymentMethods labels={methods} max={2} />
      </TableCell>
      <TableCell className="pr-5 text-right">
        <Link
          to={`/offer/${offer.id}`}
          aria-label={label}
          className={cn(
            own
              ? 'inline-flex min-h-9 items-center text-xs font-medium text-brand-text-secondary hover:text-brand-text rounded-md'
              // The row action IS the viewer's side: tonal green "Comprar" / tonal red "Vender".
              : cn(buttonVariants({ variant: offer.side === 'SELL' ? 'buy-tonal' : 'sell-tonal', size: 'sm' }), 'min-w-[5.5rem]'),
            'after:absolute after:inset-0 after:content-[""]'
          )}
        >
          {action}
        </Link>
      </TableCell>
    </TableRow>
  )
}
