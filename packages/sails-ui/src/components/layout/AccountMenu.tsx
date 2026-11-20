import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ChevronDown, Copy, LogOut, User as UserIcon } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import type { User } from '../../types'
import { UserAvatar } from '../ui/UserAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

const shortKey = (key: string) => (key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key)

/**
 * Connected-account chip + menu (common DeFi pattern): short identity on
 * the trigger; copy public key, profile, disconnect inside. `compact` shows
 * only the avatar, for the mobile header.
 */
export function AccountMenu({ user, compact = false }: { user: User; compact?: boolean }) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const copyKey = async () => {
    setOpen(false)
    try {
      await navigator.clipboard.writeText(user.publicKey)
      toast.success('Chave pública copiada')
    } catch {
      toast.error('Não foi possível copiar')
    }
  }

  const disconnect = () => {
    setOpen(false)
    logout()
    toast.success('Wallet desconectada')
    navigate('/')
  }

  const item = 'w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-brand-text-secondary hover:bg-brand-elevated hover:text-brand-text'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Menu da conta"
        className="flex items-center gap-2 rounded-lg border border-brand-border-subtle px-2 py-1.5 hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange-accent"
      >
        <UserAvatar user={user} size="sm" />
        {!compact && (
          <>
            <span className="text-sm font-medium text-brand-text tabular-nums">{shortKey(user.publicKey)}</span>
            <ChevronDown className="h-3.5 w-3.5 text-brand-text-muted" />
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5">
        <div className="px-2.5 py-2">
          <div className="text-sm font-medium text-brand-text truncate">{user.displayName ?? 'Sem nome'}</div>
          <div className="text-xs text-brand-text-muted font-mono">{shortKey(user.publicKey)}</div>
        </div>
        <div className="my-1 h-px bg-brand-border-subtle" />
        <button type="button" onClick={copyKey} className={item}>
          <Copy className="h-4 w-4" /> Copiar chave pública
        </button>
        <Link to="/profile" onClick={() => setOpen(false)} className={item}>
          <UserIcon className="h-4 w-4" /> Meu perfil
        </Link>
        <button type="button" onClick={disconnect} className={item}>
          <LogOut className="h-4 w-4" /> Desconectar
        </button>
      </PopoverContent>
    </Popover>
  )
}
