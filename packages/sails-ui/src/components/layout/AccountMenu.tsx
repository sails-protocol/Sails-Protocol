import { Link, useNavigate } from 'react-router'
import { toast } from '../ui/toast'
import { ChevronDown, Copy, LogOut, Settings, User as UserIcon } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import type { User } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/menu'
import { t } from '../../i18n'

export const shortKey = (key: string) => (key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key)

/** Disconnect flow shared by AccountMenu and Configurações: end the session, confirm, go to the Market. */
export function useDisconnect() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  return () => {
    logout()
    toast.success(t('shell.account.disconnected'))
    navigate('/')
  }
}

/**
 * Connected-account chip + menu (common DeFi pattern): short identity on
 * the trigger; copy public key, profile, settings, disconnect inside. `compact` shows
 * only the avatar, for the mobile header.
 */
export function AccountMenu({ user, compact = false }: { user: User; compact?: boolean }) {
  const disconnectWallet = useDisconnect()

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(user.publicKey)
      toast.success(t('shell.account.keyCopied'))
    } catch {
      toast.error(t('common.copyFailed'))
    }
  }

  // Menu primitive (DESIGN_SYSTEM.md 5.3): role=menu, arrow keys, typeahead, Esc; picking an item closes it.
  return (
    <Menu>
      <MenuTrigger
        aria-label={t('shell.account.menu')}
        className="flex items-center gap-2 min-h-11 rounded-lg px-2 py-1.5 transition-colors state-layer"
      >
        <UserAvatar user={user} size="sm" />
        {!compact && (
          <>
            <span className="text-sm font-medium text-brand-text tabular-nums">{shortKey(user.publicKey)}</span>
            <ChevronDown aria-hidden="true" className="size-icon-xs text-brand-text-muted" />
          </>
        )}
      </MenuTrigger>
      <MenuContent label={t('shell.account.menu')}>
        <MenuLabel>
          <div className="text-sm font-medium text-brand-text truncate">{user.displayName ?? t('shell.account.noName')}</div>
          <div className="text-xs text-brand-text-muted font-mono">{shortKey(user.publicKey)}</div>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={copyKey}>
          <Copy aria-hidden="true" /> {t('shell.account.copyKey')}
        </MenuItem>
        <MenuItem asChild>
          <Link to="/profile"><UserIcon aria-hidden="true" /> {t('shell.account.myProfile')}</Link>
        </MenuItem>
        <MenuItem asChild>
          <Link to="/settings"><Settings aria-hidden="true" /> {t('shell.nav.settings')}</Link>
        </MenuItem>
        {/* Session exit kept apart from the navigation items. */}
        <MenuSeparator />
        <MenuItem onSelect={disconnectWallet}>
          <LogOut aria-hidden="true" /> {t('shell.account.disconnect')}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
