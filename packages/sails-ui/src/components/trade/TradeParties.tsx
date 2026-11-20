import type { ReactNode } from 'react'
import type { User } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { FavoriteButton } from '../ui/FavoriteButton'
import { VouchButton } from '../ui/VouchButton'
import { REPUTATION_EXPLANATION, trustItems } from '../../lib/reputation'
import { TrustLine } from '../ui/TrustLine'
import { ExplanationPopover } from '../ui/ExplanationPopover'
import { Card } from '../ui/card'
import { Divider } from '../ui/divider'

// counterpartyOnline (2026-08-02): real presence for whichever of
// buyer/seller ISN'T currentUserId, sourced from Trade.tsx's chat
// WebSocketChannel USER_ONLINE/USER_OFFLINE frames — see UserAvatar.tsx's
// own comment on the `online` prop for why this can't extend to both
// rows (there's no real presence source for "yourself" here either).
//
// Trade workspace (L3): for a trade party this is the counterparty block —
// the other party first, with the same trust line as the Market and the
// offer (reputation, trades, disputes; no derived percentage or badge), the
// host's chat entry, then the viewer's own row. A non-party sees both rows
// with presence unknown (the channel only reports a party's counterparty).
export function TradeParties({
  buyer, seller, currentUserId, counterpartyOnline, children,
}: {
  buyer: User
  seller: User
  currentUserId?: string
  counterpartyOnline?: boolean | null
  /** Host slot under the counterparty (the chat entry). */
  children?: ReactNode
}) {
  const viewerIsBuyer = buyer.id === currentUserId
  const viewerIsSeller = seller.id === currentUserId
  if (!viewerIsBuyer && !viewerIsSeller) {
    return (
      <Card aria-label="Partes do trade" className="px-4 py-1.5 divide-y divide-brand-border-subtle">
        <PartyRow user={buyer} role="Comprador" isYou={false} online={null} />
        <PartyRow user={seller} role="Vendedor" isYou={false} online={null} />
      </Card>
    )
  }
  const other = viewerIsBuyer ? seller : buyer
  const you = viewerIsBuyer ? buyer : seller
  return (
    <Card aria-labelledby="trade-counterparty-title" className="px-4 py-3">
      <h2 id="trade-counterparty-title" className="text-xs font-medium text-brand-text-secondary">Contraparte</h2>
      <PartyRow user={other} role={viewerIsBuyer ? 'Vendedor' : 'Comprador'} isYou={false} online={counterpartyOnline} />
      {children}
      <Divider className="mt-2" />
      <PartyRow user={you} role={viewerIsBuyer ? 'Comprador' : 'Vendedor'} isYou />
    </Card>
  )
}

function PartyRow({ user, role, isYou, online }: { user: User; role: string; isYou: boolean; online?: boolean | null }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <UserAvatar user={user} size="sm" showPresence={!isYou} online={online} />
      <div className="text-sm min-w-0">
        <span className="font-medium text-brand-text [overflow-wrap:anywhere]">{user.displayName}</span>
        {isYou && <span className="ml-1.5 text-xs bg-brand-orange-accent/10 text-brand-orange-hover dark:text-brand-orange-accent rounded-sm px-1.5 py-0.5">Você</span>}
        <span className="ml-1.5 text-xs text-brand-text-secondary">· {role}</span>
        {/* Same trust line as the Market rows: server counters only, no derived percentage. */}
        {/* Inline (not flex) so the info button wraps with the text on narrow phones. */}
        <div className="text-xs text-brand-text-muted">
          <TrustLine items={trustItems(user)} />
          <ExplanationPopover explanation={REPUTATION_EXPLANATION} label={REPUTATION_EXPLANATION.title} className="ml-1.5 align-middle" />
        </div>
      </div>
      {/* Only the other party — real `user.id` here comes from a real
          `identity.get()` call (Trade.tsx's own `toParticipantUser`),
          so favoriting yourself would be a meaningless no-op the
          feature isn't meant to support. Same reasoning for VouchButton
          (RFC-021 D7) — the server rejects self-vouch anyway. */}
      {!isYou && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <VouchButton voucheeId={user.id} />
          <FavoriteButton userId={user.id} />
        </div>
      )}
    </div>
  )
}
