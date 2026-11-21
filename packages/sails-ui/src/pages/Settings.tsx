import { useState } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router'
import {
  Award, Bell, HelpCircle, KeyRound, Languages, LogOut, Monitor, Moon, Network, Server, Shield, ShieldCheck, Sun, SunMoon,
  Ticket, Users, Wallet, ArrowLeft, type LucideIcon,
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
import { useNavPosition, type NavPosition } from '../lib/navPosition'
import { NavPositionThumb } from '../components/layout/NavPositionThumb'
import { REPUTATION_EXPLANATION } from '../lib/reputation'
import { ExplanationPopover } from '../components/ui/ExplanationPopover'
import type { IdentityAvatarStyle } from '../lib/identityAvatar'
import { Tabs } from '../components/ui/tabs'
import { RadioCard, RadioGroup } from '../components/ui/radio-group'
import { LOOSE_WIRES, type LooseWireId } from '../lib/looseWires'
import type { ThemePreference } from '../lib/themePreference'
import { useLocalePreference, type LocalePreference } from '../lib/locale'
import { sectionFromSearch } from '../lib/settingsSection'
import { NetworkRow, NetworkSettingsRows } from '../components/settings/NetworkSettings'
import { MARKETS_ROUTES } from '../components/layout/navMatch'
import { t } from '../i18n'

// Option lists are built at render so their labels follow the interface language.
const avatarStyleOptions = (): ReadonlyArray<{ value: IdentityAvatarStyle; label: string }> => [
  { value: 'vela', label: t('settings.appearance.avatarVela') },
  { value: 'mare', label: t('settings.appearance.avatarMare') },
  { value: 'grade', label: t('settings.appearance.avatarGrade') },
]
// Preview seed when no wallet is connected (a sample, not anyone's identity).
const SAMPLE_AVATAR_SEED = 'sails-exemplo'

const themeOptions = (): ReadonlyArray<{ value: ThemePreference; label: string; icon: LucideIcon }> => [
  { value: 'system', label: t('settings.systemDefault'), icon: Monitor },
  { value: 'dark', label: t('settings.appearance.dark'), icon: Moon },
  { value: 'light', label: t('settings.appearance.light'), icon: Sun },
]

const navPositionOptions = (): ReadonlyArray<{ value: NavPosition; label: string }> => [
  { value: 'side', label: t('settings.appearance.navSide') },
  { value: 'top', label: t('settings.appearance.navTop') },
]

// Each language in its own name (how people find their language in a list); only "system default" is translated.
const localeOptions = (): ReadonlyArray<{ value: LocalePreference; label: string; lang?: string }> => [
  { value: 'system', label: t('settings.systemDefault') },
  { value: 'pt-BR', label: 'Português (Brasil)', lang: 'pt-BR' },
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'es', label: 'Español', lang: 'es' },
  { value: 'fr', label: 'Français', lang: 'fr' },
  { value: 'de', label: 'Deutsch', lang: 'de' },
]

function Planned({ id, description }: { id: LooseWireId; description?: string }) {
  const wire = LOOSE_WIRES[id]
  return <SettingsRow icon={wire.icon} label={wire.label} description={description} plannedLabel={t('common.soon')} />
}

// Order by use (DECISIONS.md "Reorganização pela visão do usuário"); the ids are unchanged.
const sections = (): ReadonlyArray<{ id: string; label: string; icon: LucideIcon }> => [
  { id: 'wallet', label: t('settings.section.wallet'), icon: Wallet },
  { id: 'aparencia', label: t('settings.section.appearance'), icon: SunMoon },
  { id: 'idioma', label: t('settings.section.language'), icon: Languages },
  { id: 'notificacoes', label: t('settings.section.notifications'), icon: Bell },
  { id: 'seguranca', label: t('settings.section.security'), icon: Shield },
  // Renamed "Rede e nós" (CTO final correction for plan 1.4); the id stays so ?section=no-sails keeps working.
  { id: 'no-sails', label: t('settings.section.network'), icon: Network },
  { id: 'comunidades', label: t('settings.section.communities'), icon: Users },
  { id: 'ajuda', label: t('settings.section.help'), icon: HelpCircle },
]

/**
 * Configurações (/settings). md+: section list on the left, one section
 * on the right. Below md: a list of sections (native settings screen); a
 * section opens on its own with a back button to the list. Real rows
 * reuse existing logic (ThemeContext, AuthContext, AccountMenu's disconnect, Layout's tour, the stored
 * language preference); everything else is a planned row from LOOSE_WIRES (lib/looseWires.ts). No app version row: the build exposes none.
 */
export function Settings() {
  // The open section lives in the URL (?section=<id>, replaced, not pushed) so each one is deep-linkable.
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionList = sections()
  const { id: active, fromUrl } = sectionFromSearch(searchParams, sectionList.map((s) => s.id))
  const setActive = (id: string) => setSearchParams((prev) => { prev.set('section', id); return prev }, { replace: true })
  // Below md only: whether a section is open (otherwise the section list shows); a deep link opens it.
  const [mobileOpen, setMobileOpen] = useState(fromUrl)
  const activeLabel = sectionList.find((s) => s.id === active)?.label
  const { replayTour } = useOutletContext<LayoutOutletContext>()
  const { preference, setPreference } = useTheme()
  const [locale, setLocale] = useLocalePreference()
  const { user, loading: authLoading } = useAuth()
  const disconnect = useDisconnect()
  const [avatarStyle, setAvatarStyle] = useAvatarStyle()
  const [navPosition, setNavPosition] = useNavPosition()

  const groupClass = (id: string) => cn(active !== id ? 'hidden' : !mobileOpen && 'hidden md:block')
  const panel = (id: string) => ({ id, className: groupClass(id), panelOf: 'settings' })

  return (
    <Page width="detail">
      <PageHeader
        title={<><span className="md:hidden">{mobileOpen ? activeLabel : t('settings.title')}</span><span className="hidden md:inline">{t('settings.title')}</span></>}
        back={mobileOpen ? (
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="md:hidden min-h-11 -my-2 inline-flex items-center gap-1 text-body-sm text-brand-text-secondary hover:text-brand-text rounded-md"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('settings.title')}
          </button>
        ) : undefined}
      />
      {!mobileOpen && (
        <nav aria-label={t('settings.sectionsLabel')} className="md:hidden">
          <Card className="overflow-hidden border-brand-border-subtle bg-brand-surface">
            <ul className="divide-y divide-brand-border-subtle">
              {sectionList.map((s) => (
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
          label={t('settings.sectionsLabel')}
          idBase="settings"
          items={sectionList.map((s) => ({ value: s.id, label: s.label, icon: s.icon }))}
          value={active}
          onChange={setActive}
          className="hidden md:flex sticky top-20"
        />

        <div className="min-w-0">
          <SettingsGroup {...panel('no-sails')} title={t('settings.section.network')} icon={Network}>
            {/* Rede Sails is the default and works behind the scenes; markets live in the Market area, not here. */}
            <NetworkRow />
            {/* The app talks to one API base fixed by its build config (lib/sailsClient.ts); no live connection signal exists, so no status line. */}
            <SettingsRow icon={Server} label={t('settings.network.node')} description={t('settings.network.nodeDescription')} value={t('markets.node.automatic')} />
            {/* "Nós públicos e privados" and "Nó manual" are covered by the node catalogue (nodeCatalog, under Avançado) and
                "Adicionar nó manualmente" (wire manualServer): node profiles are never market types (DECISIONS). */}
            <NetworkSettingsRows advanced={<Planned id="connectionDiagnostics" />} />
          </SettingsGroup>

          <SettingsGroup {...panel('wallet')} title={t('settings.section.wallet')} icon={Wallet}>
            {authLoading ? (
              <li><ListSkeleton label={t('settings.wallet.checking')} rows={2} rowClassName="h-14" /></li>
            ) : user ? (
              <>
                <SettingsRow icon={KeyRound} label={t('settings.wallet.connected')} description={t('settings.wallet.storedHere')} value={t('settings.wallet.localKey')} />
                <SettingsRow
                  icon={ShieldCheck}
                  label={t('settings.wallet.publicKey')}
                  value={<span className="font-mono text-xs">{shortKey(user.publicKey)}</span>}
                  control={<CopyButton value={user.publicKey} className="min-h-9 touch:min-h-11 px-3" />}
                />
                <SettingsRow icon={LogOut} label={t('settings.wallet.disconnect')} onClick={disconnect} />
              </>
            ) : (
              <SettingsRow
                icon={Wallet}
                label={t('settings.wallet.none')}
                control={
                  <Link to="/login" state={{ from: '/settings' }} className={cn(buttonVariants({ className: 'min-h-9 touch:min-h-11 px-4 text-sm shrink-0' }))}>
                    {t('settings.wallet.connect')}
                  </Link>
                }
              />
            )}
            <Planned id="satsailsWallet" />
            <Planned id="walletConnect" />
            <Planned id="defaultReceiveAddress" />
          </SettingsGroup>

          <SettingsGroup {...panel('aparencia')} title={t('settings.section.appearance')} icon={SunMoon}>
            <li className="px-4 py-3">
              <RadioGroup legend={t('settings.appearance.theme')} description={t('settings.appearance.themeHelp')} listClassName="flex flex-wrap gap-2">
                {themeOptions().map((o) => (
                  <RadioCard key={o.value} name="theme" value={o.value} checked={preference === o.value} onChange={() => setPreference(o.value)} className="py-1.5">
                    <o.icon className="h-4 w-4 text-brand-text-secondary" aria-hidden="true" />
                    {o.label}
                  </RadioCard>
                ))}
              </RadioGroup>
            </li>
            {/* DECISIONS.md "Posição do menu no desktop": saved in this browser, no toggle in the bar. */}
            <li className="px-4 py-3">
              <RadioGroup
                legend={t('settings.appearance.navPosition')}
                description={t('settings.appearance.navHelp')}
                listClassName="flex flex-wrap gap-2"
              >
                {navPositionOptions().map((o) => (
                  <RadioCard key={o.value} name="nav-position" value={o.value} checked={navPosition === o.value} onChange={() => setNavPosition(o.value)} className="py-1.5">
                    <NavPositionThumb position={o.value} />
                    {o.label}
                  </RadioCard>
                ))}
              </RadioGroup>
            </li>
            {/* Viewer display preference: changes how every avatar looks to this viewer only. */}
            <li className="px-4 py-3">
              <RadioGroup
                legend={t('settings.appearance.avatarStyle')}
                description={t('settings.appearance.avatarHelp')}
                listClassName="flex flex-wrap gap-2"
              >
                {avatarStyleOptions().map((o) => (
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
            <Planned id="publicAvatar" description={t('settings.appearance.publicAvatar')} />
            <Planned id="displayCurrency" description={t('settings.appearance.displayCurrency')} />
          </SettingsGroup>

          <SettingsGroup {...panel('idioma')} title={t('settings.section.language')} icon={Languages}>
            <li className="px-4 py-3">
              <RadioGroup legend={t('settings.language.legend')} listClassName="grid gap-2 sm:grid-cols-2">
                {localeOptions().map((o) => (
                  <RadioCard key={o.value} name="locale" value={o.value} checked={locale === o.value} onChange={() => setLocale(o.value)}>
                    <span lang={o.lang}>{o.label}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
            </li>
          </SettingsGroup>

          {/* No notification system exists (LOOSE_WIRES notify*): planned rows only, no toggles that do nothing. */}
          <SettingsGroup {...panel('notificacoes')} title={t('settings.section.notifications')} icon={Bell}>
            <Planned id="notifyTrades" />
            <Planned id="notifyChat" />
            <Planned id="notifyDisputes" />
          </SettingsGroup>

          <SettingsGroup {...panel('seguranca')} title={t('settings.section.security')} icon={Shield}>
            <Planned id="keyBackup" />
            <Planned id="sessionLock" />
          </SettingsGroup>

          <SettingsGroup {...panel('comunidades')} title={t('settings.section.communities')} icon={Users}>
            <Planned id="communities" description={t('settings.communities.description')} />
            {/* Markets live in the Market area (CTO final correction for plan 1.4); these rows only lead there. */}
            <SettingsRow icon={Users} label={t('markets.action.mine')} description={t('settings.communities.myMarketsDescription')} to={MARKETS_ROUTES.mine} />
            <SettingsRow icon={Ticket} label={t('markets.action.join')} description={t('markets.action.joinDescription')} to={MARKETS_ROUTES.join} />
          </SettingsGroup>

          <SettingsGroup {...panel('ajuda')} title={t('settings.section.help')} icon={HelpCircle}>
            <SettingsRow icon={HelpCircle} label={t('settings.help.tour')} description={t('settings.help.tourDescription')} onClick={replayTour} />
            <SettingsRow
              icon={Award}
              label={REPUTATION_EXPLANATION.title}
              description={t('settings.help.reputationDescription')}
              control={<ExplanationPopover explanation={REPUTATION_EXPLANATION} label={t('settings.help.details')} variant="text" className="shrink-0" />}
            />
            <Planned id="helpCenter" />
          </SettingsGroup>
        </div>
      </div>
    </Page>
  )
}
