import {
  Activity, Bell, CircleUser, Globe, Info, KeyRound, Languages, LifeBuoy, Link2, Lock, MapPin, MessageSquare,
  ServerCog, CalendarDays, Coins, CreditCard, Scale, Star, Users, Wallet, Network, Ticket, QrCode, UserCheck, Fingerprint, PlusCircle, Compass, Palette,
} from 'lucide-react'

/**
 * LOOSE_WIRES: every planned ("Em breve") item in the app and the contract it needs before it can
 * become real (issue #729's list in spirit). Settings renders its planned rows from this list only,
 * disabled, with no value and no action; the last group is shown on other screens (offer detail,
 * Perfil) or is a schema gap with no row of its own.
 */
export const LOOSE_WIRES = {
  publicPrivateServers: { label: 'Nós Sails públicos e privados', icon: Globe, contract: 'SDK/config: catalogue of selectable API endpoints + SailsClient re-init on switch' },
  manualServer: { label: 'Nó Sails manual', icon: ServerCog, contract: 'validated user-supplied baseUrl, persisted, SailsClient rebuilt with it' },
  connectionDiagnostics: { label: 'Diagnóstico de conexão', icon: Activity, contract: 'SDK health/latency call (none exposed today)' },
  satsailsWallet: { label: 'Satsails Wallet', icon: Wallet, contract: 'Satsails Wallet WalletAdapter connector (same gap as the connect-wallet dialog)' },
  walletConnect: { label: 'WalletConnect', icon: Link2, contract: 'WalletConnect WalletAdapter connector (same gap as the connect-wallet dialog)' },
  defaultReceiveAddress: { label: 'Endereço de recebimento padrão', icon: MapPin, contract: 'per-asset payout address on the participant profile (SDK + backend field)' },
  // The preference is stored today (lib/locale.ts, `sails_ui_locale`); only pt-BR copy exists.
  language: { label: 'Tradução da interface', icon: Languages, contract: 'i18n layer + translation catalogue reading sails_ui_locale (lot B; sails-ui is pt-BR only today)' },
  notifyTrades: { label: 'Novos trades e mudanças de estado', icon: Bell, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  notifyChat: { label: 'Mensagens do chat', icon: MessageSquare, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  notifyDisputes: { label: 'Disputas e prazos', icon: Scale, contract: 'notification system/backend (none exists, PROJECT_CONTEXT §2E Future)' },
  displayCurrency: { label: 'Moeda de exibição', icon: Info, contract: 'FX rate source in the SDK; priceUsd is the only real price unit today' },
  keyBackup: { label: 'Backup e recuperação da chave', icon: KeyRound, contract: 'encrypted key export/import + recovery flow over AuthContext keypair' },
  sessionLock: { label: 'Bloqueio da sessão', icon: Lock, contract: 'idle-lock policy over AuthContext session (re-prompt passphrase)' },
  communities: { label: 'Comunidades', icon: Users, contract: 'community / restricted-market membership contract in the SDK (none today)' },
  helpCenter: { label: 'Central de ajuda', icon: LifeBuoy, contract: 'help content destination (docs URL) owned by the product' },
  publicAvatar: { label: 'Avatar público', icon: CircleUser, contract: 'Avatar público escolhido pelo usuário (visível para as contrapartes) needs a profile field on the server' },
  // Nodes and private markets (DECISIONS.md "Nós e mercados privados", issue #147, issue #361, ADR-001). Formats of the
  // three identifiers are pending the Principal; the UI never invents a prefix, key format or definitive identifier.
  nodeCatalog: { label: 'Catálogo de nós Sails', icon: Network, contract: 'Node catalogue/discovery (ADR-001 §6 bootstrap, §26.2 discoverability) + per-node metadata (operator, region, status, fee, limits, declared custody model) + Sails Node ID format (Principal); adding a node also needs manualServer (validated endpoint, SailsClient rebuilt). Issue #361' },
  nodeStateSync: { label: 'Sincronização entre nós', icon: Network, contract: 'How offers, discovery and updates are distributed or synchronized between Sails nodes (ADR-001 §4 propagation / §5 convergence, Pears planned): unspecified; the UI never claims nodes share the same state. CTO gap, issues #361 and #147' },
  marketInvite: { label: 'Entrar com convite Sails', icon: Ticket, contract: 'Sails Market Invite: verifiable credential native to the protocol (OpenP2P + OpenIdentity), SDK call to validate it and report pending/granted/expired/revoked; a public key alone is never authorization. Issue #147' },
  marketInviteQr: { label: 'Ler convite por QR Code', icon: QrCode, contract: 'QR encoding of the Sails Market Invite (same credential as marketInvite) + camera permission flow in the app; no camera code exists. Issue #147' },
  marketMembership: { label: 'Mercados privados', icon: UserCheck, contract: 'Sails Market ID (independent of the hosting node) + membership and permissions read through the SDK, verified in backend and protocol (not only hidden on screen); the market selector and "Meus mercados" list only the default public market until then. Issue #147, ADR-001 §1' },
  marketPortability: { label: 'Mercados ligados à sua identidade', icon: Fingerprint, contract: 'Membership bound to the portable identity (Pubky planned as infrastructure, never market authority) and recognized after switching app or node, with verifiable support; no automatic recovery is promised. Issue #147, ADR-001 §10' },
  createMarket: { label: 'Criar mercado', icon: PlusCircle, contract: 'Create a market: name/description/branding, visibility (public or private), participation and permissions (Vitrine/Comunidade presets, Personalizado later; visibility never decides who publishes), infrastructure (Rede Sails hosting when supported, or own node), review; for private markets, participants and Sails Market Invites. Permission model by the Principal, authority limits validated by GK before implementation. Issue #147' },
  marketDiscovery: { label: 'Explorar mercados', icon: Compass, contract: 'Discovery of public markets on Rede Sails (several public markets allowed, e.g. a company storefront without own infrastructure) + follow/unfollow, read through the SDK; Sails Market ID format by the Principal. Issue #147, ADR-001 §6/§14' },
  marketBranding: { label: 'Identidade visual do mercado', icon: Palette, contract: 'Market name, description, logo/colors stored with the Sails Market and read through the SDK (white-label storefront); no field exists today. Issue #147' },
  // Other screens.
  readRatings: { label: 'Avaliações', icon: Star, contract: 'Ler avaliações (média, quantidade, comentários) — endpoint + SDK (only reputation.rate() exists)' },
  publicMemberSince: { label: 'Membro desde', icon: CalendarDays, contract: 'Data de cadastro (mês/ano) nos dados públicos do anunciante (PublicOfferSeller has no createdAt)' },
  assetCatalogPairs: { label: 'Pares do catálogo de ativos', icon: Coins, contract: 'Os 13 pares "Em breve" do catálogo (lib/assetCatalog.ts): modelo Asset + SettlementRail do ADR-002 (§12 itens 2 e 3) ligado ao SDK e um rail de liquidação apto a produção por par; hoje só BTC on-chain (MULTISIG)' },
  multiPaymentMethods: { label: 'Vários métodos de pagamento', icon: CreditCard, contract: 'Oferta com até 5 métodos de pagamento (MAX_PAYMENT_METHODS) validados no backend e no SDK (issue #735); PaymentMethods already renders a list, the demo already simulates it' },
  tradePaymentMethodChoice: { label: 'Escolher o método no trade', icon: CreditCard, contract: 'Escolher um dos métodos da oferta ao abrir o trade e prender a escolha aos termos aceitos (issue #735, Despacho 039); openp2p.trade() has no method argument today' },
} as const

export type LooseWireId = keyof typeof LOOSE_WIRES
