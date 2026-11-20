import {
  Activity, Bell, CircleUser, Globe, Info, KeyRound, Languages, LifeBuoy, Link2, Lock, MapPin, MessageSquare,
  ServerCog, CalendarDays, Coins, CreditCard, Scale, Star, Users, Wallet,
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
  // Other screens.
  readRatings: { label: 'Avaliações', icon: Star, contract: 'Ler avaliações (média, quantidade, comentários) — endpoint + SDK (only reputation.rate() exists)' },
  publicMemberSince: { label: 'Membro desde', icon: CalendarDays, contract: 'Data de cadastro (mês/ano) nos dados públicos do anunciante (PublicOfferSeller has no createdAt)' },
  assetCatalogPairs: { label: 'Pares do catálogo de ativos', icon: Coins, contract: 'Os 13 pares "Em breve" do catálogo (lib/assetCatalog.ts): modelo Asset + SettlementRail do ADR-002 (§12 itens 2 e 3) ligado ao SDK e um rail de liquidação apto a produção por par; hoje só BTC on-chain (MULTISIG)' },
  multiPaymentMethods: { label: 'Vários métodos de pagamento', icon: CreditCard, contract: 'Oferta com vários métodos de pagamento (schema + SDK, decisão do CTO); PaymentMethods already renders a list' },
} as const

export type LooseWireId = keyof typeof LOOSE_WIRES
