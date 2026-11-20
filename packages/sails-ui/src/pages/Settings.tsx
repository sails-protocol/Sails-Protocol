import { useState } from 'react'
import { Link, useOutletContext } from 'react-router'
import {
  Award, Bell, HelpCircle, KeyRound, Languages, LogOut, Monitor, Moon, Network, Server, Shield, ShieldCheck, Sun, SunMoon,
  Users, Wallet, ArrowLeft, type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { shortKey, useDisconnect } from '../components/layout/AccountMenu'
import type { LayoutOutletContext } from '../components/layout/Layout'
import { SettingsGroup, SettingsRow } from '../components/settings/SettingsRow'
import { CopyButton } from '../components/ui/CopyButton'
import { ListSkeleton } from '../components/ui/skeleton'
import { buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'
import { Page, PageHeader } from '../components/layout/PageHeader'
import { Card } from '../components/ui/card'
import { IdentityAvatar } from '../components/ui/IdentityAvatar'
import { useAvatarStyle } from '../lib/avatarStyle'
import { REPUTATION_EXPLANATION } from '../lib/reputation'
import { ExplanationPopover } from '../components/ui/ExplanationPopover'
import type { IdentityAvatarStyle } from '../lib/identityAvatar'
import { Tabs } from '../components/ui/tabs'
import { RadioCard, RadioGroup } from '../components/ui/radio-group'
import { Alert } from '../components/ui/alert'
import { LOOSE_WIRES, type LooseWireId } from '../lib/looseWires'
import type { ThemePreference } from '../lib/themePreference'
import { translationPending, useLocalePreference, type LocalePreference } from '../lib/locale'

const AVATAR_STYLE_OPTIONS: ReadonlyArray<{ value: IdentityAvatarStyle; label: string }> = [
  { value: 'vela', label: 'Vela' },
  { value: 'mare', label: 'Maré' },
  { value: 'grade', label: 'Grade' },
]
// Preview seed when no wallet is connected (a sample, not anyone's identity).
const SAMPLE_AVATAR_SEED = 'sails-exemplo'

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'Padrão do sistema', icon: Monitor },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'light', label: 'Claro', icon: Sun },
]

// Each language in its own name (how people find their language in a list).
const LOCALE_OPTIONS: ReadonlyArray<{ value: LocalePreference; label: string; lang?: string }> = [
  { value: 'system', label: 'Padrão do sistema' },
  { value: 'pt-BR', label: 'Português (Brasil)', lang: 'pt-BR' },
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'es', label: 'Español', lang: 'es' },
  { value: 'fr', label: 'Français', lang: 'fr' },
  { value: 'de', label: 'Deutsch', lang: 'de' },
]

const SOON = 'Em breve'

function Planned({ id, description }: { id: LooseWireId; description?: string }) {
  const wire = LOOSE_WIRES[id]
  return <SettingsRow icon={wire.icon} label={wire.label} description={description} plannedLabel={SOON} />
}

const SECTIONS: ReadonlyArray<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'no-sails', label: 'Nó Sails', icon: Network },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
  { id: 'aparencia', label: 'Aparência', icon: SunMoon },
  { id: 'idioma', label: 'Idioma', icon: Languages },
  { id: 'notificacoes', label: 'Notificações', icon: Bell },
  { id: 'seguranca', label: 'Segurança', icon: Shield },
  { id: 'comunidades', label: 'Comunidades', icon: Users },
  { id: 'ajuda', label: 'Ajuda e Sobre', icon: HelpCircle },
]

/**
 * Configurações (/settings). md+: section list on the left, one section
 * on the right. Below md: a list of sections (native settings screen); a
 * section opens on its own with a back button to the list. Real rows
 * reuse existing logic (ThemeContext, AuthContext, AccountMenu's disconnect, Layout's tour, the stored
 * language preference); everything else is a planned row from LOOSE_WIRES (lib/looseWires.ts). No app version row: the build exposes none.
 */
export function Settings() {
  const [active, setActive] = useState(SECTIONS[0].id)
  // Below md only: whether a section is open (otherwise the section list shows).
  const [mobileOpen, setMobileOpen] = useState(false)
  const activeLabel = SECTIONS.find((s) => s.id === active)?.label
  const { replayTour } = useOutletContext<LayoutOutletContext>()
  const { preference, setPreference } = useTheme()
  const [locale, setLocale] = useLocalePreference()
  const browserLanguage = typeof navigator === 'undefined' ? undefined : navigator.language
  const { user, loading: authLoading } = useAuth()
  const disconnect = useDisconnect()
  const [avatarStyle, setAvatarStyle] = useAvatarStyle()

  const groupClass = (id: string) => cn(active !== id ? 'hidden' : !mobileOpen && 'hidden md:block')
  const panel = (id: string) => ({ id, className: groupClass(id), panelOf: 'settings' })

  return (
    <Page width="detail">
      <PageHeader
        title={<><span className="md:hidden">{mobileOpen ? activeLabel : 'Configurações'}</span><span className="hidden md:inline">Configurações</span></>}
        back={mobileOpen ? (
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="md:hidden min-h-11 -my-2 inline-flex items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text rounded-md"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Configurações
          </button>
        ) : undefined}
      />
      {!mobileOpen && (
        <nav aria-label="Seções de configurações" className="md:hidden">
          <Card className="overflow-hidden border-brand-border-subtle bg-brand-surface">
            <ul className="divide-y divide-brand-border-subtle">
              {SECTIONS.map((s) => (
                <SettingsRow key={s.id} icon={s.icon} label={s.label} onClick={() => { setActive(s.id); setMobileOpen(true) }} />
              ))}
            </ul>
          </Card>
        </nav>
      )}
      <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8 md:items-start">
        {/* md+: in-page tabs (they switch the section shown, the URL stays). Below md the same sections are a
            drill-down list (above), so this tab list is hidden there. */}
        <Tabs
          orientation="vertical"
          label="Seções de configurações"
          idBase="settings"
          items={SECTIONS.map((s) => ({ value: s.id, label: s.label, icon: s.icon }))}
          value={active}
          onChange={setActive}
          className="hidden md:flex sticky top-20"
        />

        <div className="min-w-0">
          <SettingsGroup {...panel('no-sails')} title="Nó Sails" icon={Network}>
            {/* The app talks to one API base fixed by its build config (lib/sailsClient.ts); no live connection signal exists, so no status line. */}
            <SettingsRow icon={Server} label="Nó Sails" description="Definido pela configuração deste app" value="Automático" />
            <Planned id="publicPrivateServers" />
            <Planned id="manualServer" />
            <Planned id="connectionDiagnostics" />
          </SettingsGroup>

          <SettingsGroup {...panel('wallet')} title="Wallet" icon={Wallet}>
            {authLoading ? (
              <li><ListSkeleton label="Verificando sessão" rows={2} rowClassName="h-14" /></li>
            ) : user ? (
              <>
                <SettingsRow icon={KeyRound} label="Wallet conectada" description="Guardada neste navegador" value="Chave local" />
                <SettingsRow
                  icon={ShieldCheck}
                  label="Chave pública"
                  value={<span className="font-mono text-xs">{shortKey(user.publicKey)}</span>}
                  control={<CopyButton value={user.publicKey} className="min-h-9 touch:min-h-11 px-3" />}
                />
                <SettingsRow icon={LogOut} label="Desconectar" onClick={disconnect} />
              </>
            ) : (
              <SettingsRow
                icon={Wallet}
                label="Nenhuma wallet conectada"
                control={
                  <Link to="/login" state={{ from: '/settings' }} className={cn(buttonVariants({ className: 'min-h-9 touch:min-h-11 px-4 text-sm shrink-0' }))}>
                    Conectar wallet
                  </Link>
                }
              />
            )}
            <Planned id="satsailsWallet" />
            <Planned id="walletConnect" />
            <Planned id="defaultReceiveAddress" />
          </SettingsGroup>

          <SettingsGroup {...panel('aparencia')} title="Aparência" icon={SunMoon}>
            <li className="px-4 py-3">
              <RadioGroup legend="Tema" description="Padrão do sistema segue o tema claro ou escuro do seu aparelho." listClassName="flex flex-wrap gap-2">
                {THEME_OPTIONS.map((o) => (
                  <RadioCard key={o.value} name="theme" value={o.value} checked={preference === o.value} onChange={() => setPreference(o.value)} className="py-1.5">
                    <o.icon className="h-4 w-4 text-brand-text-secondary" aria-hidden="true" />
                    {o.label}
                  </RadioCard>
                ))}
              </RadioGroup>
            </li>
            {/* Viewer display preference: changes how every avatar looks to this viewer only. */}
            <li className="px-4 py-3">
              <RadioGroup
                legend="Estilo dos avatares"
                description="Muda como você vê todos os avatares, o seu e os das contrapartes. Só você vê esta escolha."
                listClassName="flex flex-wrap gap-2"
              >
                {AVATAR_STYLE_OPTIONS.map((o) => (
                  <RadioCard
                    key={o.value}
                    name="avatar-style"
                    value={o.value}
                    checked={avatarStyle === o.value}
                    onChange={() => setAvatarStyle(o.value)}
                    className="py-1.5"
                  >
                    <IdentityAvatar seed={user ? user.publicKey || user.id : SAMPLE_AVATAR_SEED} size={28} style={o.value} />
                    {o.label}
                  </RadioCard>
                ))}
              </RadioGroup>
            </li>
            <Planned id="publicAvatar" description="Um avatar escolhido por você e visto pelas contrapartes" />
            <Planned id="displayCurrency" description="Os preços são exibidos em USD." />
          </SettingsGroup>

          {/* The choice is stored now (sails_ui_locale); the copy stays pt-BR until the translation lot (LOOSE_WIRES.language). */}
          <SettingsGroup {...panel('idioma')} title="Idioma" icon={Languages}>
            <li className="px-4 py-3">
              <RadioGroup legend="Idioma da interface" listClassName="grid gap-2 sm:grid-cols-2">
                {LOCALE_OPTIONS.map((o) => (
                  <RadioCard key={o.value} name="locale" value={o.value} checked={locale === o.value} onChange={() => setLocale(o.value)}>
                    <span lang={o.lang}>{o.label}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
              {translationPending(locale, browserLanguage) && (
                <Alert tone="info" size="sm" live className="mt-3">
                  Tradução em andamento. Por enquanto a interface continua em português; sua escolha fica salva.
                </Alert>
              )}
            </li>
          </SettingsGroup>

          {/* No notification system exists (LOOSE_WIRES notify*): planned rows only, no toggles that do nothing. */}
          <SettingsGroup {...panel('notificacoes')} title="Notificações" icon={Bell}>
            <Planned id="notifyTrades" />
            <Planned id="notifyChat" />
            <Planned id="notifyDisputes" />
          </SettingsGroup>

          <SettingsGroup {...panel('seguranca')} title="Segurança" icon={Shield}>
            <Planned id="keyBackup" />
            <Planned id="sessionLock" />
          </SettingsGroup>

          <SettingsGroup {...panel('comunidades')} title="Comunidades" icon={Users}>
            <Planned id="communities" description="Comunidades e mercados restritos de que você participa" />
          </SettingsGroup>

          <SettingsGroup {...panel('ajuda')} title="Ajuda e Sobre" icon={HelpCircle}>
            <SettingsRow icon={HelpCircle} label="Rever tour" description="Tour de boas-vindas do Sails Market" onClick={replayTour} />
            <SettingsRow
              icon={Award}
              label={REPUTATION_EXPLANATION.title}
              description="Soma de pontos sem valor máximo: +2 por trade concluído, −5 por disputa perdida"
              control={<ExplanationPopover explanation={REPUTATION_EXPLANATION} label="Ver detalhes" variant="text" className="shrink-0" />}
            />
            <Planned id="helpCenter" />
          </SettingsGroup>
        </div>
      </div>
    </Page>
  )
}
