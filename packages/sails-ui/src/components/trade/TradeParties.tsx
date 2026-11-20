import type { User } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { FavoriteButton } from '../ui/FavoriteButton'
import { VouchButton } from '../ui/VouchButton'
import { trustParts } from '../../lib/reputation'
import { Card } from '../ui/card'

// counterpartyOnline (2026-08-02): real presence for whichever of
// buyer/seller ISN'T currentUserId, sourced from Trade.tsx's chat
// WebSocketChannel USER_ONLINE/USER_OFFLINE frames — see UserAvatar.tsx's
// own comment on the `online` prop for why this can't extend to both
// rows (there's no real presence source for "yourself" here either).
export function TradeParties({
  buyer, seller, currentUserId, counterpartyOnline,
}: {
  buyer: User
  seller: User
  currentUserId?: string
  counterpartyOnline?: boolean | null
}) {
  return (
    <Card className="px-4 py-1.5 divide-y divide-brand-border-subtle">
      <PartyRow user={buyer} role="Comprador" isYou={buyer.id === currentUserId} online={buyer.id === currentUserId ? undefined : counterpartyOnline} />
      <PartyRow user={seller} role="Vendedor" isYou={seller.id === currentUserId} online={seller.id === currentUserId ? undefined : counterpartyOnline} />
    </Card>
  )
}

function PartyRow({ user, role, isYou, online }: { user: User; role: string; isYou: boolean; online?: boolean | null }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <UserAvatar user={user} size="sm" showPresence online={online} />
      <div className="text-sm">
        <span className="font-medium text-brand-text">{user.displayName}</span>
        {isYou && <span className="ml-1.5 text-xs bg-brand-orange-accent/10 text-brand-orange-hover dark:text-brand-orange-accent rounded px-1.5 py-0.5">Você</span>}
        {/* Same trust line as the Market rows: server counters only, no derived percentage. */}
        <div className="text-xs text-brand-text-muted tabular-nums">{trustParts(user).join(' · ')}</div>
      </div>
      <span className="ml-auto text-xs text-brand-text-muted">{role}</span>
      {/* Only the other party — real `user.id` here comes from a real
          `identity.get()` call (Trade.tsx's own `toParticipantUser`),
          so favoriting yourself would be a meaningless no-op the
          feature isn't meant to support. Same reasoning for VouchButton
          (RFC-021 D7) — the server rejects self-vouch anyway. */}
      {!isYou && (
        <div className="flex items-center gap-1">
          <VouchButton voucheeId={user.id} />
          <FavoriteButton userId={user.id} />
        </div>
      )}
    </div>
  )
}
