import {
  Activity, Bell, CircleUser, Globe, Info, KeyRound, Languages, LifeBuoy, Link2, Lock, MapPin, MessageSquare,
  ServerCog, CalendarDays, Coins, CreditCard, Scale, Star, Users, Wallet, Network, Ticket, QrCode, UserCheck, Fingerprint, PlusCircle, Compass, Palette, EyeOff,
  Store, ShieldCheck, MessagesSquare, BadgeCheck, ShoppingBag,
} from 'lucide-react'
import { t } from '../i18n'

/**
 * LOOSE_WIRES: every planned ("Em breve") item in the app and the contract it needs before it can
 * become real (issue #729's list in spirit). Settings renders its planned rows from this list only,
 * disabled, with no value and no action; the last group is shown on other screens (offer detail,
 * Perfil) or is a schema gap with no row of its own. `label` is read at render (a getter over `looseWires.<id>`) so it
 * follows the interface language; `contract` is developer text and stays as is.
 */
export const LOOSE_WIRES = {
  publicPrivateServers: { get label() { return t('looseWires.publicPrivateServers') }, icon: Globe, contract: 'SDK/config: catalogue of selectable API endpoints + SailsClient re-init on switch' },
  manualServer: { get label() { return t('looseWires.manualServer') }, icon: ServerCog, contract: 'validated user-supplied baseUrl, persisted, SailsClient rebuilt with it' },
  connectionDiagnostics: { get label() { return t('looseWires.connectionDiagnostics') }, icon: Activity, contract: 'SDK health/latency call (none exposed today)' },
  satsailsWallet: { get label() { return t('looseWires.satsailsWallet') }, icon: Wallet, contract: 'Satsails Wallet WalletAdapter connector (same gap as the connect-wallet dialog)' },
  walletConnect: { get label() { return t('looseWires.walletConnect') }, icon: Link2, contract: 'WalletConnect WalletAdapter connector (same gap as the connect-wallet dialog)' },
  defaultReceiveAddress: { get label() { return t('looseWires.defaultReceiveAddress') }, icon: MapPin, contract: 'per-asset payout address on the participant profile (SDK + backend field)' },
  // Shipped (UX-028): no longer rendered as planned anywhere; the id stays so references keep working.
  language: { get label() { return t('looseWires.language') }, icon: Languages, contract: 'i18n layer exists (src/i18n, five catalogs, reads sails_ui_locale); remaining work: native review of the needsNativeReview keys (NEEDS_NATIVE_REVIEW in src/i18n/catalog.ts) before en/es/fr/de ship' },
  notifyTrades: { get label() { return t('looseWires.notifyTrades') }, icon: Bell, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  notifyChat: { get label() { return t('looseWires.notifyChat') }, icon: MessageSquare, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  notifyDisputes: { get label() { return t('looseWires.notifyDisputes') }, icon: Scale, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  displayCurrency: { get label() { return t('looseWires.displayCurrency') }, icon: Info, contract: 'FX rate source in the SDK; priceUsd is the only real price unit today' },
  keyBackup: { get label() { return t('looseWires.keyBackup') }, icon: KeyRound, contract: 'encrypted key export/import + recovery flow over AuthContext keypair' },
  sessionLock: { get label() { return t('looseWires.sessionLock') }, icon: Lock, contract: 'idle-lock policy over AuthContext session (re-prompt passphrase)' },
  // Superseded on screen by marketMembership (Configurações → Mercados → Meus mercados, plan 1.5); the id stays so references keep working.
  communities: { get label() { return t('looseWires.communities') }, icon: Users, contract: 'community / restricted-market membership contract in the SDK (none today)' },
  helpCenter: { get label() { return t('looseWires.helpCenter') }, icon: LifeBuoy, contract: 'help content destination (docs URL) owned by the product' },
  publicAvatar: { get label() { return t('looseWires.publicAvatar') }, icon: CircleUser, contract: 'Avatar público escolhido pelo usuário (visível para as contrapartes) needs a profile field on the server' },
  // Nodes and private markets (DECISIONS.md "Nós e mercados privados", issue #147, issue #361, ADR-001). Formats of the
  // three identifiers are pending the Principal; the UI never invents a prefix, key format or definitive identifier.
  nodeCatalog: { get label() { return t('looseWires.nodeCatalog') }, icon: Network, contract: 'Node catalogue/discovery (ADR-001 §6 bootstrap, §26.2 discoverability) + per-node metadata (operator, region, status, fee, limits, declared custody model) + Sails Node ID format (Principal); adding a node also needs manualServer (validated endpoint, SailsClient rebuilt). Issue #361' },
  nodeStateSync: { get label() { return t('looseWires.nodeStateSync') }, icon: Network, contract: 'How offers, discovery and updates are distributed or synchronized between Sails nodes (ADR-001 §4 propagation / §5 convergence, Pears planned): unspecified; the UI never claims nodes share the same state. CTO gap, issues #361 and #147' },
  marketInvite: { get label() { return t('looseWires.marketInvite') }, icon: Ticket, contract: 'Sails Market Invite: verifiable credential native to the protocol (OpenP2P + OpenIdentity), SDK call to validate it and report pending/granted/expired/revoked; a public key alone is never authorization. Issue #147' },
  marketInviteQr: { get label() { return t('looseWires.marketInviteQr') }, icon: QrCode, contract: 'QR encoding of the Sails Market Invite (same credential as marketInvite) + camera permission flow in the app; no camera code exists. Issue #147' },
  marketMembership: { get label() { return t('looseWires.marketMembership') }, icon: UserCheck, contract: 'Sails Market ID (independent of the hosting node) + membership and permissions read through the SDK, verified in backend and protocol (not only hidden on screen); the market selector and "Meus mercados" list only the default public market until then. Issue #147, ADR-001 §1' },
  marketPortability: { get label() { return t('looseWires.marketPortability') }, icon: Fingerprint, contract: 'Membership bound to the portable identity (Pubky planned as infrastructure, never market authority) and recognized after switching app or node, with verifiable support; no automatic recovery is promised. Issue #147, ADR-001 §10' },
  createMarket: { get label() { return t('looseWires.createMarket') }, icon: PlusCircle, contract: 'Create a market: name/description/branding, visibility (public or private), participation and permissions (Vitrine and Todos publicam presets, internal ids vitrine/comunidade; Personalizado later; visibility never decides who publishes), infrastructure (Rede Sails hosting when supported, or own node), review; for private markets, participants and Sails Market Invites. Permission model by the Principal, authority limits validated by GK before implementation. Issue #147' },
  marketDiscovery: { get label() { return t('looseWires.marketDiscovery') }, icon: Compass, contract: 'Discovery of public markets on Rede Sails (several public markets allowed, e.g. a company storefront without own infrastructure) + follow/unfollow, read through the SDK; Sails Market ID format by the Principal. Issue #147, ADR-001 §6/§14' },
  marketParticipationPrivacy: { get label() { return t('looseWires.marketParticipationPrivacy') }, icon: EyeOff, contract: 'Who can see which markets a person belongs to (membership visibility to other members, admins, nodes): unspecified until the #147 permission/privacy spec by the Principal; GK validates the limits. Issue #147' },
  marketBranding: { get label() { return t('looseWires.marketBranding') }, icon: Palette, contract: 'Market name, description, logo/colors stored with the Sails Market and read through the SDK (white-label storefront); no field exists today. Issue #147' },
  // Market Spaces (DECISIONS.md "Mercados (Market Spaces)", Principal contract draft in lib/marketContract.ts; proposal,
  // the CTO has not ratified the Day 0 cut). Each contract names the future SDK call the screen will read.
  marketPage: { get label() { return t('looseWires.marketPage') }, icon: Store, contract: 'Market page: sails.markets.get(id) -> Market (MarketSummary + entryPolicy, listed, state); 404 for a private market the caller is not a member of (the UI never confirms it exists); offers via liquidity.discover({ marketId }); participantsCount; admin view: sails.markets.members(id) -> public keys only' },
  marketEntryPolicy: { get label() { return t('looseWires.marketEntryPolicy') }, icon: ShieldCheck, contract: 'Market.entryPolicy { kyc: none|above_threshold|all, thresholdUsd?, providerUrl? (admin link, never fetched by the node), social: X|LINKEDIN|GITHUB[] }, written by sails.markets.create/update. Declarative: the admin or their provider evaluates it; restricts joining and new trades only, never funds, settlement or a trade already in escrow. Sails stores no documents' },
  marketGroupChat: { get label() { return t('looseWires.marketGroupChat') }, icon: MessagesSquare, contract: 'Market group chat: not in Day 0. Needs a market-scoped message channel with membership checks (sails.markets.members) separate from the per-trade chat, which stays the only real chat' },
  marketVerification: { get label() { return t('looseWires.marketVerification') }, icon: BadgeCheck, contract: 'Market "Verificado" seal: not in Day 0; criteria to be set by the CTO and the protocol (ratings, number and volume of trades are only the demo idea). Until then the real UI never shows the seal (N1)' },
  managedNode: { get label() { return t('looseWires.managedNode') }, icon: ServerCog, contract: 'Managed Sails node (a node run for the customer): not in Day 0, no provisioning, price or availability defined; Satsails service, not protocol' },
  spacePurchase: { get label() { return t('looseWires.spacePurchase') }, icon: ShoppingBag, contract: 'Satsails commercial service (not protocol, not SDK): one-time purchase of a market space tied to the owner identity (transfer later). No price, payment rail or order API exists; demo only. The protocol stays permissionless: anyone can create markets with the SDKs without buying' },
  // Other screens.
  disputeAppealView: { get label() { return t('looseWires.disputeAppealView') }, icon: Scale, contract: 'C12: read-only GET /v1/settlement/disputes/:id/appeal-view returning DisputeAppealView (lib/disputeAppeal.ts: appealSupported, appealStatus, appealDeadlineAt (null today, gap G1), canCurrentUserAppeal, decisionFinalAt, optional autoProposal), computed on the backend with no rule change, plus an SDK method to read it; until then the trade page shows the contest of the decision as not available and never infers it. PRINCIPAL-C12 §2/§3' },
  readRatings: { get label() { return t('looseWires.readRatings') }, icon: Star, contract: 'Ler avaliações (média, quantidade, comentários) — endpoint + SDK (only reputation.rate() exists)' },
  publicMemberSince: { get label() { return t('looseWires.publicMemberSince') }, icon: CalendarDays, contract: 'Data de cadastro (mês/ano) nos dados públicos do anunciante (PublicOfferSeller has no createdAt)' },
  assetCatalogPairs: { get label() { return t('looseWires.assetCatalogPairs') }, icon: Coins, contract: 'Os 13 pares "Em breve" do catálogo (lib/assetCatalog.ts): modelo Asset + SettlementRail do ADR-002 (§12 itens 2 e 3) ligado ao SDK e um rail de liquidação apto a produção por par; hoje só BTC on-chain (MULTISIG)' },
  multiPaymentMethods: { get label() { return t('looseWires.multiPaymentMethods') }, icon: CreditCard, contract: 'Oferta com até 5 métodos de pagamento (MAX_PAYMENT_METHODS) validados no backend e no SDK (issue #735); PaymentMethods already renders a list, the demo already simulates it' },
  tradePaymentMethodChoice: { get label() { return t('looseWires.tradePaymentMethodChoice') }, icon: CreditCard, contract: 'Escolher um dos métodos da oferta ao abrir o trade e prender a escolha aos termos aceitos (issue #735, Despacho 039); openp2p.trade() has no method argument today' },
} as const

export type LooseWireId = keyof typeof LOOSE_WIRES
