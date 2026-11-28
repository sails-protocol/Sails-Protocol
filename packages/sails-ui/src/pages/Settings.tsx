import { useState } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router'
import {
  Activity, Award, Bell, HelpCircle, KeyRound, Languages, LogOut, Monitor, Moon, Link2, Network, Server, Shield, ShieldCheck, Sun, SunMoon,
  Globe, LayoutGrid, MessageCircleQuestion, Ticket, UsersRound, Wallet, ArrowLeft, type LucideIcon,
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
import { SimulatedSettingRow } from '../components/settings/SimulatedSettings'
import { MARKETS_ROUTES } from '../components/layout/navMatch'
import { Badge } from '../components/ui/badge'
import { MarketIcon } from '../components/markets/MarketIcon'
import { useVisibleMarkets } from './markets/shared'
import { ownMarkets } from '../lib/myMarkets'
import { demoReceivedInvites, isDemoMode } from '../lib/demoMarkers'
import { BASE_URL } from '../lib/sailsClient'
import { useNodeConnection } from '../hooks/useNodeConnection'
import type { NodeConnectionStatus } from '../lib/nodeConnection'
import { t } from '../i18n'
import { safetyCenterHref, safetyCenterLanguageNote } from '../components/safety/SafetyCenterLink'
import { FAQ_ROUTE } from '../lib/faq'
import { FaqTextLink } from '../components/faq/FaqLink'

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
  // Demo: a working simulation (or an honest notice for real secrets and money); real mode: "Em breve" (CTO 437).
  const simulated = isDemoMode() ? <SimulatedSettingRow id={id} description={description} /> : null
  return simulated ?? <SettingsRow icon={wire.icon} label={wire.label} description={description} plannedLabel={t('common.soon')} />
}

// Host of the build-time node address; the raw value when it is not a URL, so a misconfigured build shows what it uses.
function nodeHost(): string {
  try { return new URL(BASE_URL).host } catch { return BASE_URL }
}

const CONNECTION_TONE: Record<NodeConnectionStatus, string> = {
  online: 'text-brand-success-fg',
  unreachable: 'text-brand-danger-fg',
  unknown: 'text-brand-text-secondary',
}

/** Live status from lib/nodeConnection.ts: the last SDK request got a response, got none, or none was made yet. */
function ConnectionStatus({ status }: { status: NodeConnectionStatus }) {
  return <span className={CONNECTION_TONE[status]}>{t(`settings.network.status.${status}`)}</span>
}

const SOON_TAG = 'border-transparent bg-brand-tonal font-medium text-brand-text'

/** A preference row with its own content (radio list, list) under the same icon tile as SettingsRow. */
function PreferenceItem({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-elevated">
        <Icon className="h-4 w-4 text-brand-text-secondary" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}

/**
 * "Mercado que abre por padrão" (DECISIONS.md "Configurações → Mercados"). Only Mercado aberto can open today: market
 * offers do not exist in the protocol (LOOSE_WIRES.marketMembership), so every other market is listed but disabled.
 */
function DefaultMarketChoice() {
  const markets = ownMarkets(useVisibleMarkets())
  const soon = t('common.soon')
  return (
    <RadioGroup legend={t('settings.markets.defaultLegend')} description={t('settings.markets.defaultHelp')} listClassName="grid gap-2">
      {markets.map((m) => {
        const selectable = m.relation === 'default'
        return (
          <RadioCard key={m.id} name="default-market" value={m.id} checked={selectable} disabled={!selectable} onChange={() => undefined} className="items-start">
            <MarketIcon market={m} size="sm" />
            <span className="min-w-0">
              <span className="block break-words">{m.name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-caption font-normal text-brand-text-secondary">
                {selectable ? t('markets.default.description') : <>{m.illustrative && <span>{t('markets.fictionalExample')}</span>}<Badge variant="outline" className={SOON_TAG}>{soon}</Badge></>}
              </span>
            </span>
          </RadioCard>
        )
      })}
      {markets.length === 1 && <p className="text-caption text-brand-text-muted">{t('settings.markets.othersLater')}</p>}
    </RadioGroup>
  )
}

/** "Convites recebidos": no invite can be read yet (LOOSE_WIRES.marketInvite); demo mode lists one fictional invite. */
function ReceivedInvites() {
  const invites = isDemoMode() ? demoReceivedInvites() : []
  return (
    <>
      <h3 className="text-sm font-medium text-brand-text">{t('settings.markets.invitesTitle')}</h3>
      {invites.length === 0 ? (
        <>
          <p className="mt-0.5 text-body-sm text-brand-text-secondary">{t('settings.markets.invitesEmpty')}</p>
          <p className="mt-0.5 text-caption text-brand-text-muted">{t('settings.markets.invitesEmptyHelp')}</p>
        </>
      ) : (
        <ul className="mt-2 divide-y divide-brand-border-subtle rounded-lg bg-brand-elevated">
          {invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
              <span className="min-w-0 flex-1 basis-40">
                <span className="block break-words text-sm text-brand-text">{i.market}</span>
                <span className="block text-caption text-brand-text-secondary">{t('settings.markets.inviteFrom', { from: i.from })} · {t('markets.fictionalExample')}</span>
              </span>
              <Link to={MARKETS_ROUTES.join} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0 touch:min-h-11')}>
                {t('settings.markets.openInvite')}<span className="sr-only">: {i.market}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
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
  // Renamed "Mercados" (DECISIONS.md "Configurações → Mercados"); the id stays so ?section=comunidades keeps working.
  { id: 'comunidades', label: t('settings.section.markets'), icon: LayoutGrid },
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
  const nodeStatus = useNodeConnection()
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
            {/* The app talks to one API base fixed by its build config (VITE_API_BASE_URL, lib/sailsClient.ts). */}
            <SettingsRow icon={Server} label={t('settings.network.node')} description={t('settings.network.nodeDescription')} value={t('markets.node.automatic')} />
            <SettingsRow
              icon={Link2}
              label={t('settings.network.address')}
              value={<span className="font-mono text-xs">{nodeHost()}</span>}
              control={<CopyButton value={BASE_URL} ariaLabel={t('settings.network.copyAddress')} className="min-h-9 touch:min-h-11 px-3" />}
            />
            <SettingsRow icon={Activity} label={t('settings.network.connection')} value={<ConnectionStatus status={nodeStatus} />} />
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
                  control={<CopyButton value={user.publicKey} ariaLabel={t('settings.wallet.copyKey')} className="min-h-9 touch:min-h-11 px-3" />}
                />
                <SettingsRow icon={LogOut} label={t('settings.wallet.disconnect')} onClick={disconnect} />
              </>
            ) : (
              <SettingsRow
                icon={Wallet}
                label={t('settings.wallet.none')}
                control={
                  <Link to="/login" state={{ from: '/settings' }} className={cn(buttonVariants({ variant: 'secondary', className: 'min-h-9 touch:min-h-11 px-4 text-sm shrink-0' }))}>
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
            {/* CTO R1 (2026-11-23): what is true today, in both modes; the backup itself is "Em breve". */}
            <SettingsRow icon={LOOSE_WIRES.keyBackup.icon} label={LOOSE_WIRES.keyBackup.label} description={t('settings.security.recovery')} plannedLabel={t('common.soon')} />
            <Planned id="keyBackupExport" />
            <Planned id="keyBackupImport" />
            <Planned id="sessionLock" />
          </SettingsGroup>

          {/* Preferences about markets, not the markets: those live in the Market area. The old "Comunidades" planned row
              (communities wire) is covered by "Meus mercados" below and the marketMembership wire. */}
          <SettingsGroup {...panel('comunidades')} title={t('settings.section.markets')} icon={LayoutGrid}>
            <PreferenceItem icon={Globe}><DefaultMarketChoice /></PreferenceItem>
            <PreferenceItem icon={Ticket}><ReceivedInvites /></PreferenceItem>
            <Planned id="marketParticipationPrivacy" description={t('settings.markets.privacyDescription')} />
            {/* Markets live in the Market area (CTO final correction for plan 1.4); these rows only lead there. */}
            <SettingsRow icon={UsersRound} label={t('markets.action.mine')} description={t('settings.communities.myMarketsDescription')} to={MARKETS_ROUTES.mine} />
            <SettingsRow icon={Ticket} label={t('markets.action.join')} description={t('markets.action.joinDescription')} to={MARKETS_ROUTES.join} />
          </SettingsGroup>

          <SettingsGroup {...panel('ajuda')} title={t('settings.section.help')} icon={HelpCircle}>
            {/* External, live Safety Center (PO 2026-11-23): first in Ajuda e Sobre, in demo and real mode alike. */}
            <SettingsRow
              icon={ShieldCheck}
              label={t('shell.safetyCenter.label')}
              description={t('shell.safetyCenter.description') + safetyCenterLanguageNote()}
              href={safetyCenterHref()}
              newTabLabel={t('shell.safetyCenter.newTab')}
            />
            {/* Real content (CTO/PO 2026-11-23): second in Ajuda e Sobre, no "Simulado" marker. */}
            <SettingsRow icon={MessageCircleQuestion} label={t('faq.title')} description={t('faq.rowDescription')} to={FAQ_ROUTE} />
            <SettingsRow icon={HelpCircle} label={t('settings.help.tour')} description={t('settings.help.tourDescription')} onClick={replayTour} />
            <SettingsRow
              icon={Award}
              label={REPUTATION_EXPLANATION.title}
              description={t('settings.help.reputationDescription')}
              control={<ExplanationPopover explanation={REPUTATION_EXPLANATION} label={t('settings.help.details')} variant="text" className="shrink-0" more={<FaqTextLink slug="reputacao">{t('faq.reputationLink')}</FaqTextLink>} />}
            />
            <Planned id="helpCenter" />
          </SettingsGroup>
        </div>
      </div>
    </Page>
  )
}
