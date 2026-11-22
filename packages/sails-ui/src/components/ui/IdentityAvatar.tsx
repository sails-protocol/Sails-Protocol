import { useMemo } from 'react'
import { UserRound } from 'lucide-react'
import { identityAvatarSvg, type IdentityAvatarStyle } from '../../lib/identityAvatar'
import { useAvatarStyle } from '../../lib/avatarStyle'
import { seedFor, useOwnAvatar } from '../../lib/avatarChoice'
import { cn } from '../../lib/utils'

/**
 * Layer A identity avatar: the deterministic SVG for `seed` (a public key) in the viewer's chosen style,
 * drawn locally (data URI, no request). No seed (e.g. a list row whose maker the API does not return):
 * a neutral placeholder, never a random avatar. Decorative unless `label` is given.
 * The signed-in person's own key draws their deck pick (lib/avatarChoice.ts) unless `style` is forced.
 */
export function IdentityAvatar({ seed, size, label, className, style: styleOverride }: {
  seed: string | null | undefined
  /** Diameter in px. */
  size: number
  /** Accessible name; omit when the name is already next to the avatar. */
  label?: string
  className?: string
  /** Draw in this style instead of the viewer's preference (style picker previews). */
  style?: IdentityAvatarStyle
}) {
  const [preferred] = useAvatarStyle()
  const own = useOwnAvatar()
  const pick = !styleOverride && seed && own?.publicKey === seed ? own.choice : null
  const style = styleOverride ?? pick?.style ?? preferred
  const drawn = seed && pick ? seedFor(seed, pick.variant) : seed
  const src = useMemo(() => (drawn ? `data:image/svg+xml;utf8,${encodeURIComponent(identityAvatarSvg(drawn, style))}` : null), [drawn, style])
  const box = cn('shrink-0 rounded-full', className)
  if (!src) {
    return (
      <span
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        style={{ width: size, height: size }}
        className={cn(box, 'flex items-center justify-center border border-brand-border bg-brand-elevated text-brand-text-muted')}
      >
        <UserRound style={{ width: size * 0.55, height: size * 0.55 }} aria-hidden="true" />
      </span>
    )
  }
  return <img src={src} alt={label ?? ''} width={size} height={size} draggable={false} className={box} />
}
