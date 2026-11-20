import { useState } from 'react'
import { Link, useOutletContext } from 'react-router'
import {
  Activity, Bell, Globe, HelpCircle, Info, KeyRound, Languages, Link2, LifeBuoy, Lock, LogOut, MapPin,
  Moon, Palette, Plug, Server, ServerCog, Shield, ShieldCheck, Users, Wallet, type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { shortKey, useDisconnect } from '../components/layout/AccountMenu'
import type { LayoutOutletContext } from '../components/layout/Layout'
import { SettingsGroup, SettingsRow } from '../components/settings/SettingsRow'
import { CopyButton } from '../components/ui/CopyButton'
import { Switch } from '../components/ui/switch'
import { ListSkeleton } from '../components/ui/skeleton'
import { buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'

/**
 * LOOSE_WIRES: every planned ("Em breve") row on this page and the contract
 * it needs before it can become real. Planned rows render from this list
 * only, disabled, with no value and no action.
 */
const LOOSE_WIRES = {
  publicPrivateServers: { label: 'Servidores públicos e privados', icon: Globe, contract: 'SDK/config: catalogue of selectable API endpoints + SailsClient re-init on switch' },
  manualServer: { label: 'Servidor manual', icon: ServerCog, contract: 'validated user-supplied baseUrl, persisted, SailsClient rebuilt with it' },
  connectionDiagnostics: { label: 'Diagnóstico de conexão', icon: Activity, contract: 'SDK health/latency call (none exposed today)' },
  satsailsWallet: { label: 'Satsails Wallet', icon: Wallet, contract: 'Satsails Wallet WalletAdapter connector (same gap as the connect-wallet dialog)' },
  walletConnect: { label: 'WalletConnect', icon: Link2, contract: 'WalletConnect WalletAdapter connector (same gap as the connect-wallet dialog)' },
  defaultReceiveAddress: { label: 'Endereço de recebimento padrão', icon: MapPin, contract: 'per-asset payout address on the participant profile (SDK + backend field)' },
  language: { label: 'Idioma', icon: Languages, contract: 'i18n layer + translation catalogue (sails-ui is pt-BR only today)' },
  notifications: { label: 'Notificações', icon: Bell, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  displayCurrency: { label: 'Moeda de exibição', icon: Info, contract: 'FX rate source in the SDK; priceUsd is the only real price unit today' },
  keyBackup: { label: 'Backup e recuperação da chave', icon: KeyRound, contract: 'encrypted key export/import + recovery flow over AuthContext keypair' },
  sessionLock: { label: 'Bloqueio da sessão', icon: Lock, contract: 'idle-lock policy over AuthContext session (re-prompt passphrase)' },
  communities: { label: 'Comunidades', icon: Users, contract: 'community / restricted-market membership contract in the SDK (none today)' },
  helpCenter: { label: 'Central de ajuda', icon: LifeBuoy, contract: 'help content destination (docs URL) owned by the product' },
} as const

const SOON = 'Em breve'

function Planned({ id, description }: { id: keyof typeof LOOSE_WIRES; description?: string }) {
  const wire = LOOSE_WIRES[id]
  return <SettingsRow icon={wire.icon} label={wire.label} description={description} plannedLabel={SOON} />
}

const SECTIONS: ReadonlyArray<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'conexao', label: 'Conexão', icon: Plug },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
  { id: 'aplicativo', label: 'Aplicativo', icon: Palette },
  { id: 'seguranca', label: 'Segurança', icon: Shield },
  { id: 'comunidades', label: 'Comunidades', icon: Users },
  { id: 'ajuda', label: 'Ajuda e Sobre', icon: HelpCircle },
]

/**
 * Configurações (/settings). Desktop: section list on the left, one section
 * on the right. Mobile: every section stacked (the mobile lot revisits
 * this). Real rows reuse existing logic (ThemeContext, AuthContext,
 * AccountMenu's disconnect, Layout's tour); everything else is a planned
 * row from LOOSE_WIRES. No app version row: the build exposes none.
 */
export function Settings() {
  const [active, setActive] = useState(SECTIONS[0].id)
  const { replayTour } = useOutletContext<LayoutOutletContext>()
  const { theme, toggleTheme } = useTheme()
  const { user, loading: authLoading } = useAuth()
  const disconnect = useDisconnect()

  const groupClass = (id: string) => cn('mb-8 md:mb-0', active !== id && 'md:hidden')

  return (
    <div>
      <h1 className="text-page-title">Configurações</h1>
      <div className="mt-6 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8 md:items-start">
        <nav aria-label="Seções de configurações" className="hidden md:flex md:flex-col gap-1 sticky top-20">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              aria-controls={s.id}
              aria-current={active === s.id ? 'true' : undefined}
              className={cn(
                'flex items-center gap-3 min-h-11 rounded-lg border-l-2 px-3 text-sm font-medium text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange-accent',
                active === s.id
                  ? 'border-brand-orange-accent bg-brand-orange-accent/10 text-brand-orange-hover'
                  : 'border-transparent text-brand-text-secondary hover:bg-brand-elevated hover:text-brand-text'
              )}
            >
              <s.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          <SettingsGroup id="conexao" title="Conexão" icon={Plug} className={groupClass('conexao')}>
            {/* The app talks to one API base fixed by its build config (lib/sailsClient.ts); no live connection signal exists, so no status line. */}
            <SettingsRow icon={Server} label="Servidor" description="Definido pela configuração deste app" value="Automático" />
            <Planned id="publicPrivateServers" />
            <Planned id="manualServer" />
            <Planned id="connectionDiagnostics" />
          </SettingsGroup>

          <SettingsGroup id="wallet" title="Wallet" icon={Wallet} className={groupClass('wallet')}>
            {authLoading ? (
              <li><ListSkeleton label="Verificando sessão" rows={2} rowClassName="h-14" /></li>
            ) : user ? (
              <>
                <SettingsRow icon={KeyRound} label="Wallet conectada" description="Guardada neste navegador" value="Chave local" />
                <SettingsRow
                  icon={ShieldCheck}
                  label="Chave pública"
                  value={<span className="font-mono text-xs">{shortKey(user.publicKey)}</span>}
                  control={<CopyButton value={user.publicKey} className="min-h-11 md:min-h-9 px-3" />}
                />
                <SettingsRow icon={LogOut} label="Desconectar" onClick={disconnect} />
              </>
            ) : (
              <SettingsRow
                icon={Wallet}
                label="Nenhuma wallet conectada"
                control={
                  <Link to="/login" state={{ from: '/settings' }} className={cn(buttonVariants({ className: 'min-h-11 md:min-h-9 px-4 text-sm shrink-0' }))}>
                    Conectar wallet
                  </Link>
                }
              />
            )}
            <Planned id="satsailsWallet" />
            <Planned id="walletConnect" />
            <Planned id="defaultReceiveAddress" />
          </SettingsGroup>

          <SettingsGroup id="aplicativo" title="Aplicativo" icon={Palette} className={groupClass('aplicativo')}>
            <SettingsRow
              icon={Moon}
              label="Tema escuro"
              value={theme === 'dark' ? 'Ativado' : 'Desativado'}
              control={<Switch checked={theme === 'dark'} onCheckedChange={toggleTheme} aria-label="Tema escuro" className="relative shrink-0 after:absolute after:-inset-2.5 after:content-['']" />}
            />
            <Planned id="language" />
            <Planned id="notifications" />
            <Planned id="displayCurrency" description="Os preços são exibidos em USD." />
          </SettingsGroup>

          <SettingsGroup id="seguranca" title="Segurança" icon={Shield} className={groupClass('seguranca')}>
            <Planned id="keyBackup" />
            <Planned id="sessionLock" />
          </SettingsGroup>

          <SettingsGroup id="comunidades" title="Comunidades" icon={Users} className={groupClass('comunidades')}>
            <Planned id="communities" description="Comunidades e mercados restritos de que você participa" />
          </SettingsGroup>

          <SettingsGroup id="ajuda" title="Ajuda e Sobre" icon={HelpCircle} className={groupClass('ajuda')}>
            <SettingsRow icon={HelpCircle} label="Rever tour" description="Tour de boas-vindas do Sails Market" onClick={replayTour} />
            <Planned id="helpCenter" />
          </SettingsGroup>
        </div>
      </div>
    </div>
  )
}
