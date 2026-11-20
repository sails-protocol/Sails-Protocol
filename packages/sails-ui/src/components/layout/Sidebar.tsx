import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { ShoppingCart, ArrowLeftRight, User, Scale, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { isNavActive } from './navMatch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { IdentityAvatar } from '../ui/IdentityAvatar'
import { cn } from '../../lib/utils'
import { SailsLogo, SailsMark } from '../brand/SailsLogo'

/**
 * Product navigation, shared by the desktop Sidebar and the mobile BottomNav (same destinations, icons and
 * labels at every width). Five real destinations: Market, Trades, Disputas, Perfil, Configurações. No
 * "coming soon" entries: an item appears only when its route exists. Planned capabilities are disabled
 * rows INSIDE Configurações (pages/Settings.tsx), never menu entries.
 *
 * "Trades" opens /profile/active and stays active on /profile/history too (`also`): both pages remain
 * separate, linked by a shared tab header (TradesTabs.tsx). `Perfil` is exact-match (`end`) so it does
 * not light up on its /profile/* children. `Disputas` keeps its session guard (no admin/operator gate
 * exists; a signed-out visitor just doesn't see it). Perfil draws the viewer's avatar (ProfileNavIcon).
 */
export const NAV_ITEMS = [
  { to: '/', label: 'Market', icon: ShoppingCart, end: true, requiresAuth: false },
  { to: '/profile/active', also: ['/profile/history'], label: 'Trades', icon: ArrowLeftRight, end: false, requiresAuth: false },
  { to: '/disputes', label: 'Disputas', icon: Scale, end: false, requiresAuth: true },
  { to: '/profile', label: 'Perfil', icon: User, end: true, requiresAuth: false },
  { to: '/settings', label: 'Configurações', icon: Settings, end: false, requiresAuth: false },
] as const

export type NavItem = (typeof NAV_ITEMS)[number]

/**
 * "Perfil" drawn as a profile picture: the signed-in user's identity avatar (public key, else user id) in
 * the viewer's avatar style; signed out, the neutral placeholder (empty circle, person silhouette). No
 * photo exists (no upload), so none is implied. The active item gets an orange ring.
 */
export function ProfileNavIcon({ active }: { active?: boolean }) {
  const { user } = useAuth()
  return (
    <IdentityAvatar
      seed={user ? user.publicKey || user.id : null}
      size={24}
      className={cn('ring-1', active ? 'ring-brand-orange-accent' : 'ring-brand-border')}
    />
  )
}

export function NavIcon({ item, active }: { item: NavItem; active: boolean }) {
  if (item.to === '/profile') return <ProfileNavIcon active={active} />
  return <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
}

/** Active/rest tone of a nav row, shared by the Sidebar and the top bar (one active-state language). */
export function navItemTone(isActive: boolean): string {
  // Active: orange tint + orange icon/text (orange is the one action accent).
  return cn('font-medium', isActive ? 'bg-brand-orange-accent/10 text-brand-orange-hover' : 'text-brand-text-secondary state-layer hover:text-brand-text')
}

const STORAGE_KEY = 'sails_ui_sidebar_collapsed'
const XL_QUERY = '(min-width: 1280px)'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function useIsXl(): boolean {
  const [isXl, setIsXl] = useState(() => window.matchMedia(XL_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(XL_QUERY)
    const onChange = () => setIsXl(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isXl
}

/**
 * Desktop sidebar (md+), collapsible. xl+: expanded by default and pushes the content; the viewer's
 * choice is remembered in localStorage (best effort). md–lg: a 64px icon rail; expanding opens the full
 * panel OVER the content (scrim; Esc or a click outside closes and returns focus to the toggle), so the
 * Market table is never squeezed. Collapsed items keep their label as tooltip and accessible name.
 */
export function Sidebar({ hideFromLg = false }: { hideFromLg?: boolean }) {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const items = NAV_ITEMS.filter((item) => !item.requiresAuth || user)
  const isXl = useIsXl()
  const [collapsedXl, setCollapsedXl] = useState(readCollapsed)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const expanded = isXl ? !collapsedXl : overlayOpen
  const overlay = !isXl && overlayOpen

  // The overlay never survives a navigation or a resize into the pushing layout.
  useEffect(() => setOverlayOpen(false), [pathname, isXl])

  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOverlayOpen(false)
      toggleRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [overlay])

  const toggle = () => {
    if (!isXl) {
      setOverlayOpen((o) => !o)
      return
    }
    const next = !collapsedXl
    setCollapsedXl(next)
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // the preference just isn't remembered
    }
  }

  const toggleLabel = expanded ? 'Recolher menu' : 'Expandir menu'
  const motion = 'transition-[width] duration-medium ease-standard motion-reduce:transition-none'
  const rowClass = 'flex h-9 touch:h-11 w-full items-center gap-3 rounded-md px-[11px] text-sm whitespace-nowrap transition-colors'

  // Collapsed: the label shows as a tooltip and stays the accessible name.
  const withTooltip = (label: string, node: ReactElement) =>
    expanded ? node : (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )

  return (
    // The outer box reserves the layout width (64px, or 224px when expanded at xl); below xl the panel
    // inside is wider than it when open, so it covers the content instead of pushing it.
    // hideFromLg: the viewer chose the top bar, which takes over from 1024 px (Layout.tsx).
    <div className={cn('hidden md:block shrink-0', hideFromLg && 'lg:hidden', 'sticky top-0 h-screen z-50', motion, isXl && expanded ? 'w-56' : 'w-16')}>
      {overlay && (
        <div
          aria-hidden="true"
          onClick={() => { setOverlayOpen(false); toggleRef.current?.focus() }}
          className="fixed inset-0 bg-scrim"
        />
      )}
      <aside
        aria-label="Navegação principal"
        className={cn(
          'absolute inset-y-0 left-0 flex flex-col overflow-hidden border-r border-brand-border-subtle bg-brand-surface',
          motion,
          expanded ? 'w-56' : 'w-16',
          overlay && 'shadow-elevation-3'
        )}
      >
        <div className={cn('h-14 flex items-center border-b border-brand-border-subtle shrink-0', expanded ? 'px-5' : 'justify-center')}>
          <NavLink to="/" className="inline-flex items-center touch:min-h-11 touch:min-w-11 justify-center font-display font-semibold tracking-tight text-brand-text whitespace-nowrap rounded-md" aria-label="Sails Market">
            {expanded ? <SailsLogo /> : <SailsMark size={28} />}
          </NavLink>
        </div>
        <nav className="flex-1 py-3 flex flex-col gap-1 px-2">
          {items.map((item) => {
            const isActive = isNavActive(pathname, item)
            return (
              <div key={item.to}>
                {withTooltip(item.label, (
                  <Link
                    to={item.to}
                    aria-label={item.label}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(rowClass, navItemTone(isActive))}
                  >
                    <span className="flex w-6 shrink-0 justify-center"><NavIcon item={item} active={isActive} /></span>
                    {expanded && <span>{item.label}</span>}
                  </Link>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="shrink-0 border-t border-brand-border-subtle p-2">
          {withTooltip(toggleLabel, (
            <button
              ref={toggleRef}
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              aria-label={toggleLabel}
              className={cn(rowClass, 'text-brand-text-secondary state-layer hover:text-brand-text')}
            >
              <span className="flex w-6 shrink-0 justify-center">
                {expanded ? <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" /> : <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" />}
              </span>
              {expanded && <span>{toggleLabel}</span>}
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}
