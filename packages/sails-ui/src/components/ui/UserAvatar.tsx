import type { User } from '../../types'
import { IdentityAvatar } from './IdentityAvatar'
import { useUiStrings } from './uiStrings'

// Technical Debt #61 (2026-09-10) — only `id`/`displayName` are ever
// read below; loosened from the full `User` so callers with a narrower
// public projection (e.g. OfferDetail.tsx's PublicOfferSeller, which
// legitimately has no disputeCount/totalVolumeBtc/createdAt) can pass
// their seller object directly instead of padding out unused fields.
// Every existing `User`-typed caller still satisfies this exactly.
// The avatar is the identity avatar of the public key (else the user id); with neither (a list row whose
// maker the API does not return, id 'unknown') a neutral placeholder.
type AvatarUser = Pick<User, 'id' | 'displayName'> & { publicKey?: string | null }

const SIZES = { sm: 28, md: 36, lg: 48, xl: 64 } as const
const DOT_SIZES = { sm: 'w-2 h-2', md: 'w-2.5 h-2.5', lg: 'w-3 h-3', xl: 'w-3.5 h-3.5' } as const

export function UserAvatar({
  user,
  size = 'md',
  showPresence = false,
  // Real presence only (2026-08-09) — the old deterministic-hash
  // "illustrative" fallback was removed rather than left faking a
  // signal this UI has no way to back for real outside a trade's own
  // chat WebSocket. `null` means "a real channel exists but no
  // USER_ONLINE/USER_OFFLINE event has arrived yet" (chat.routes.ts
  // broadcasts these on room join/leave/socket close) — shown as a
  // distinct neutral/unknown dot, never guessed as true/false.
  // Marketplace/OfferCard/OfferDetail no longer pass `showPresence` at
  // all for exactly this reason: no live channel exists for an
  // arbitrary trader in a list, and the real one (TradeParties.tsx,
  // inside an actual trade) is the only place this can be honest.
  online = null,
}: {
  user: AvatarUser
  size?: keyof typeof SIZES
  showPresence?: boolean
  online?: boolean | null
}) {
  const seed = user.publicKey || (user.id && user.id !== 'unknown' ? user.id : null)
  const strings = useUiStrings()
  const dotTitle = online === null ? strings.presenceUnknown : online ? strings.presenceOnline : strings.presenceOffline
  return (
    <div className="relative shrink-0">
      <IdentityAvatar seed={seed} size={SIZES[size]} />
      {showPresence && (
        <span
          title={dotTitle}
          className={`absolute -bottom-0.5 -right-0.5 ${DOT_SIZES[size]} rounded-full border-2 border-brand-surface ${
            online === null ? 'bg-brand-text-muted/40' : online ? 'bg-brand-success' : 'bg-brand-text-muted'
          }`}
        />
      )}
    </div>
  )
}
