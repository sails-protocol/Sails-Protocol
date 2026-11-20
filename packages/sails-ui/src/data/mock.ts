/**
 * Reference/seed data for real pickers and filters — not fake data
 * standing in for a real API. `ASSETS`/`ASSETS_FILTERABLE`,
 * `PAYMENT_METHODS`/`PAYMENT_METHODS_FILTERABLE`, and `COUNTRIES` back
 * real UI pickers; PublishOffer.tsx submits against the real backend
 * (`lib/realOffers.ts`'s `discover()` fan-out), never anything from
 * this file. See README.md's "What this is not" for the full real-vs-
 * mock status.
 *
 * The mock users/offers/trade that used to live here (`MOCK_USERS`,
 * `CURRENT_USER`, `MOCK_OFFERS`, `MOCK_TRADE`, and `lib/buildTrade.ts`,
 * which consumed them) were confirmed dead — zero real imports left
 * anywhere — and removed 2026-08-11.
 */

// The real AssetType enum (prisma/schema.prisma) — not a fictional
// list. Alphabetical order (2026-07-29, requested directly) — by the
// asset *code* itself, since AssetPicker renders the raw code, not
// ASSET_LABELS' friendly name.
//
// USDT_ERC20 briefly removed from this list (2026-07-28) on a wrong
// assumption that it had no multisig escrow path — reverted the same
// day after checking settlement.routes.ts directly: `SAFE_GUARD_EVM`
// (SailsEscrowSafe, RFC-020) is a real, registered EscrowType, a 2-of-3
// Safe multisig (buyer + seller + KMS co-signer) that's asset-agnostic
// within EVM, not restricted to native ETH — it covers USDT_ERC20 the
// same as `MultisigProvider` covers the Bitcoin-family assets here.
//
// SPARK removed 2026-07-29 (requested directly, verified before acting
// this time — see types.ts's own comment) — genuinely has zero
// settlement-provider wiring anywhere in the real backend, unlike
// USDT_ERC20's confirmed path above.
export const ASSETS = ['BTC', 'LIQUID_BTC', 'LN_BTC', 'RSK_BTC', 'STACKS', 'USDT_ERC20', 'USDT_LIGHTNING', 'USDT_LIQUID', 'USDT_TRC20'] as const

// Adds the UI-only assets (types.ts's own comment has the full sourcing)
// on top of the real list above, alphabetically merged in (not
// appended) — filter/display + Marketplace's own discover() fan-out
// (lib/realOffers.ts), never PublishOffer.tsx's real submission (that
// page deliberately keeps importing `ASSETS`, not this). Note
// `LIQUID_BTC`/`USDT_LIQUID` above already are "L-BTC"/the real Liquid-
// network USD stablecoin — no separate value was needed for those.
export const ASSETS_FILTERABLE = [
  'BNB', 'BTC', 'DEPIX', 'ETH', 'LIQUID_BTC', 'LN_BTC', 'LTC', 'RSK_BTC',
  'SBTC_STACKS', 'SOL', 'STACKS', 'USDC_BASE', 'USDC_ERC20', 'USDC_POLYGON', 'USDCX_STACKS',
  'USDT_ERC20', 'USDT_LIGHTNING', 'USDT_LIQUID', 'USDT_TRC20', 'WBTC',
] as const

// The real backend `PaymentMethod` enum (prisma/schema.prisma) exactly —
// used anywhere a value round-trips to a real @satsails/p2p-trading-sdk call
// (PublishOffer.tsx's `liquidity.publish()`, a live POST). Alphabetical
// by the friendly label (PAYMENT_METHOD_LABELS), matching what
// PaymentMethodPicker/FilterPanel/PublishOffer's own <select> actually
// render, not by this array's own raw key spelling.
export const PAYMENT_METHODS = ['CRYPTO_DIRECT', 'CASH', 'LIGHTNING_DIRECT', 'OTHER', 'PIX', 'TED', 'BANK_TRANSFER'] as const

// Adds the UI-only payment methods (see types.ts's own comment for the
// full per-platform sourcing) on top of the real list above, alphabetized
// by friendly label across the *whole* merged set (not real-then-extra) —
// filter/display contexts only (Marketplace's PaymentMethodPicker,
// FilterPanel), never PublishOffer.tsx's real submission (that page's own
// comment on why). Exhaustive per the direct request: every method
// actually listed by at least one of HodlHodl, Airtm, El Dorado, Noones,
// or Binance P2P (PicPay specifically), not just the ones repeated across
// all of them.
export const PAYMENT_METHODS_FILTERABLE = [
  'ADVCASH', 'BANCOLOMBIA', 'BOLETO', 'CREDIT_DEBIT_CARD', 'CASH_APP', 'CRYPTO_DIRECT',
  'DEPIX', 'LOTERICA_DEPOSIT', 'CASH', 'MOBILE_MONEY', 'CASH_BY_MAIL', 'LIGHTNING_DIRECT',
  'MERCADO_PAGO', 'NETELLER', 'NEQUI', 'OTHER', 'PAYEER', 'PAYONEER', 'PAYPAL', 'PERFECT_MONEY',
  'PICPAY', 'PIX', 'PLIN', 'REVOLUT', 'SKRILL', 'TED', 'BANK_TRANSFER', 'GIFT_CARD', 'VENMO', 'WALLY',
  'WEBMONEY', 'WISE', 'YAPE', 'ZELLE', 'ZINLI',
  // HodlHodl (2026-08-01) — see types.ts's own comment on this same group
  // for why these 8 and not HodlHodl's full bank-name-granular list.
  'UPI', 'INTERAC', 'ALIPAY', 'WECHAT_PAY', 'BIZUM', 'AIRTM', 'ASTROPAY', 'BINANCE_PAY',
] as const

export const COUNTRIES: { code: string; label: string }[] = [
  { code: 'BR', label: 'Brasil' },
  { code: 'US', label: 'Estados Unidos' },
  { code: 'DE', label: 'Alemanha' },
  { code: 'AR', label: 'Argentina' },
  { code: 'MX', label: 'México' },
  { code: 'NG', label: 'Nigéria' },
  { code: 'IN', label: 'Índia' },
  { code: 'PT', label: 'Portugal' },
  // Added 2026-07-29 alongside FiatCurrency's own VES/COP/PEN/BOB/EGP —
  // see that type's comment in types.ts for the Airtm/El Dorado sourcing.
  { code: 'VE', label: 'Venezuela' },
  { code: 'CO', label: 'Colômbia' },
  { code: 'PE', label: 'Peru' },
  { code: 'BO', label: 'Bolívia' },
  { code: 'EG', label: 'Egito' },
  // HodlHodl (hodlhodl.com/offers, live filter dropdown checked
  // 2026-08-01 — requested directly, "escolher os mesmos que a HodlHodl
  // tem disponível") — its own country picker is the full ISO-3166 list,
  // not a curated business decision, so skipped here: Antarctica, Bouvet
  // Island, Heard Island and McDonald Islands, French Southern and
  // Antarctic Lands (no permanent population, zero realistic P2P
  // trading relevance). Everything else HodlHodl lists is kept, even
  // small/low-volume territories, since "match HodlHodl" was the direct
  // ask for this list specifically (unlike payment methods above, no
  // "skip inefficient ones" caveat was given for countries).
  { code: 'AF', label: 'Afeganistão' },
  { code: 'AL', label: 'Albânia' },
  { code: 'DZ', label: 'Argélia' },
  { code: 'AD', label: 'Andorra' },
  { code: 'AO', label: 'Angola' },
  { code: 'AI', label: 'Anguila' },
  { code: 'AG', label: 'Antígua e Barbuda' },
  { code: 'AM', label: 'Armênia' },
  { code: 'AW', label: 'Aruba' },
  { code: 'AU', label: 'Austrália' },
  { code: 'AT', label: 'Áustria' },
  { code: 'AZ', label: 'Azerbaijão' },
  { code: 'BH', label: 'Bahrein' },
  { code: 'BD', label: 'Bangladesh' },
  { code: 'BB', label: 'Barbados' },
  { code: 'BE', label: 'Bélgica' },
  { code: 'BZ', label: 'Belize' },
  { code: 'BJ', label: 'Benin' },
  { code: 'BM', label: 'Bermudas' },
  { code: 'BT', label: 'Butão' },
  { code: 'BA', label: 'Bósnia e Herzegovina' },
  { code: 'BW', label: 'Botsuana' },
  { code: 'IO', label: 'Território Britânico do Oceano Índico' },
  { code: 'VG', label: 'Ilhas Virgens Britânicas' },
  { code: 'BN', label: 'Brunei' },
  { code: 'BG', label: 'Bulgária' },
  { code: 'BF', label: 'Burkina Faso' },
  { code: 'BI', label: 'Burundi' },
  { code: 'KH', label: 'Camboja' },
  { code: 'CM', label: 'Camarões' },
  { code: 'CA', label: 'Canadá' },
  { code: 'CV', label: 'Cabo Verde' },
  { code: 'KY', label: 'Ilhas Cayman' },
  { code: 'CF', label: 'República Centro-Africana' },
  { code: 'TD', label: 'Chade' },
  { code: 'CL', label: 'Chile' },
  { code: 'CN', label: 'China' },
  { code: 'CX', label: 'Ilha Christmas' },
  { code: 'CC', label: 'Ilhas Cocos (Keeling)' },
  { code: 'KM', label: 'Comores' },
  { code: 'CK', label: 'Ilhas Cook' },
  { code: 'CR', label: 'Costa Rica' },
  { code: 'CI', label: 'Costa do Marfim' },
  { code: 'HR', label: 'Croácia' },
  { code: 'CU', label: 'Cuba' },
  { code: 'CW', label: 'Curaçao' },
  { code: 'CY', label: 'Chipre' },
  { code: 'CZ', label: 'República Tcheca' },
  { code: 'CD', label: 'República Democrática do Congo' },
  { code: 'DK', label: 'Dinamarca' },
  { code: 'DJ', label: 'Djibuti' },
  { code: 'DM', label: 'Dominica' },
  { code: 'DO', label: 'República Dominicana' },
  { code: 'TL', label: 'Timor-Leste' },
  { code: 'EC', label: 'Equador' },
  { code: 'SV', label: 'El Salvador' },
  { code: 'GQ', label: 'Guiné Equatorial' },
  { code: 'ER', label: 'Eritreia' },
  { code: 'EE', label: 'Estônia' },
  { code: 'ET', label: 'Etiópia' },
  { code: 'FK', label: 'Ilhas Malvinas' },
  { code: 'FO', label: 'Ilhas Faroé' },
  { code: 'FM', label: 'Micronésia' },
  { code: 'FJ', label: 'Fiji' },
  { code: 'FI', label: 'Finlândia' },
  { code: 'FR', label: 'França' },
  { code: 'GF', label: 'Guiana Francesa' },
  { code: 'PF', label: 'Polinésia Francesa' },
  { code: 'GA', label: 'Gabão' },
  { code: 'GE', label: 'Geórgia' },
  { code: 'GH', label: 'Gana' },
  { code: 'GI', label: 'Gibraltar' },
  { code: 'GR', label: 'Grécia' },
  { code: 'GL', label: 'Groenlândia' },
  { code: 'GD', label: 'Granada' },
  { code: 'GP', label: 'Guadalupe' },
  { code: 'GT', label: 'Guatemala' },
  { code: 'GN', label: 'Guiné' },
  { code: 'GW', label: 'Guiné-Bissau' },
  { code: 'GY', label: 'Guiana' },
  { code: 'HT', label: 'Haiti' },
  { code: 'VA', label: 'Vaticano' },
  { code: 'HN', label: 'Honduras' },
  { code: 'HK', label: 'Hong Kong' },
  { code: 'HU', label: 'Hungria' },
  { code: 'IS', label: 'Islândia' },
  { code: 'ID', label: 'Indonésia' },
  { code: 'IR', label: 'Irã' },
  { code: 'IE', label: 'Irlanda' },
  { code: 'IL', label: 'Israel' },
  { code: 'IT', label: 'Itália' },
  { code: 'JM', label: 'Jamaica' },
  { code: 'SJ', label: 'Jan Mayen' },
  { code: 'JP', label: 'Japão' },
  { code: 'JO', label: 'Jordânia' },
  { code: 'KZ', label: 'Cazaquistão' },
  { code: 'KE', label: 'Quênia' },
  { code: 'KI', label: 'Kiribati' },
  { code: 'XK', label: 'Kosovo' },
  { code: 'KW', label: 'Kuwait' },
  { code: 'KG', label: 'Quirguistão' },
  { code: 'LA', label: 'Laos' },
  { code: 'LV', label: 'Letônia' },
  { code: 'LB', label: 'Líbano' },
  { code: 'LS', label: 'Lesoto' },
  { code: 'LR', label: 'Libéria' },
  { code: 'LY', label: 'Líbia' },
  { code: 'LI', label: 'Liechtenstein' },
  { code: 'LT', label: 'Lituânia' },
  { code: 'LU', label: 'Luxemburgo' },
  { code: 'MO', label: 'Macau' },
  { code: 'MK', label: 'Macedônia do Norte' },
  { code: 'MG', label: 'Madagascar' },
  { code: 'MW', label: 'Malawi' },
  { code: 'MY', label: 'Malásia' },
  { code: 'MV', label: 'Maldivas' },
  { code: 'ML', label: 'Mali' },
  { code: 'MT', label: 'Malta' },
  { code: 'MH', label: 'Ilhas Marshall' },
  { code: 'MQ', label: 'Martinica' },
  { code: 'MR', label: 'Mauritânia' },
  { code: 'MU', label: 'Maurício' },
  { code: 'YT', label: 'Mayotte' },
  { code: 'MC', label: 'Mônaco' },
  { code: 'MN', label: 'Mongólia' },
  { code: 'ME', label: 'Montenegro' },
  { code: 'MS', label: 'Montserrat' },
  { code: 'MA', label: 'Marrocos' },
  { code: 'MZ', label: 'Moçambique' },
  { code: 'MM', label: 'Mianmar' },
  { code: 'NA', label: 'Namíbia' },
  { code: 'NR', label: 'Nauru' },
  { code: 'NP', label: 'Nepal' },
  { code: 'NL', label: 'Países Baixos' },
  { code: 'NC', label: 'Nova Caledônia' },
  { code: 'NZ', label: 'Nova Zelândia' },
  { code: 'NI', label: 'Nicarágua' },
  { code: 'NE', label: 'Níger' },
  { code: 'NU', label: 'Niue' },
  { code: 'NF', label: 'Ilha Norfolk' },
  { code: 'NO', label: 'Noruega' },
  { code: 'OM', label: 'Omã' },
  { code: 'PK', label: 'Paquistão' },
  { code: 'PW', label: 'Palau' },
  { code: 'PA', label: 'Panamá' },
  { code: 'PG', label: 'Papua-Nova Guiné' },
  { code: 'PY', label: 'Paraguai' },
  { code: 'PH', label: 'Filipinas' },
  { code: 'PN', label: 'Ilhas Pitcairn' },
  { code: 'PL', label: 'Polônia' },
  { code: 'QA', label: 'Catar' },
  { code: 'MD', label: 'Moldávia' },
  { code: 'CG', label: 'República do Congo' },
  { code: 'RE', label: 'Reunião' },
  { code: 'RO', label: 'Romênia' },
  { code: 'RW', label: 'Ruanda' },
  { code: 'SH', label: 'Santa Helena' },
  { code: 'KN', label: 'São Cristóvão e Névis' },
  { code: 'LC', label: 'Santa Lúcia' },
  { code: 'PM', label: 'Saint-Pierre e Miquelon' },
  { code: 'VC', label: 'São Vicente e Granadinas' },
  { code: 'WS', label: 'Samoa' },
  { code: 'SM', label: 'San Marino' },
  { code: 'ST', label: 'São Tomé e Príncipe' },
  { code: 'SA', label: 'Arábia Saudita' },
  { code: 'SN', label: 'Senegal' },
  { code: 'RS', label: 'Sérvia' },
  { code: 'SC', label: 'Seicheles' },
  { code: 'SL', label: 'Serra Leoa' },
  { code: 'SG', label: 'Cingapura' },
  { code: 'SK', label: 'Eslováquia' },
  { code: 'SI', label: 'Eslovênia' },
  { code: 'SB', label: 'Ilhas Salomão' },
  { code: 'SO', label: 'Somália' },
  { code: 'ZA', label: 'África do Sul' },
  { code: 'GS', label: 'Geórgia do Sul' },
  { code: 'KR', label: 'Coreia do Sul' },
  { code: 'SS', label: 'Sudão do Sul' },
  { code: 'ES', label: 'Espanha' },
  { code: 'LK', label: 'Sri Lanka' },
  { code: 'PS', label: 'Palestina' },
  { code: 'SR', label: 'Suriname' },
  { code: 'SZ', label: 'Essuatíni' },
  { code: 'SE', label: 'Suécia' },
  { code: 'CH', label: 'Suíça' },
  { code: 'TW', label: 'Taiwan' },
  { code: 'TJ', label: 'Tajiquistão' },
  { code: 'TZ', label: 'Tanzânia' },
  { code: 'TH', label: 'Tailândia' },
  { code: 'BS', label: 'Bahamas' },
  { code: 'GM', label: 'Gâmbia' },
  { code: 'TG', label: 'Togo' },
  { code: 'TK', label: 'Tokelau' },
  { code: 'TO', label: 'Tonga' },
  { code: 'TT', label: 'Trindade e Tobago' },
  { code: 'TN', label: 'Tunísia' },
  { code: 'TR', label: 'Turquia' },
  { code: 'TM', label: 'Turcomenistão' },
  { code: 'TC', label: 'Ilhas Turcas e Caicos' },
  { code: 'TV', label: 'Tuvalu' },
  { code: 'UG', label: 'Uganda' },
  { code: 'UA', label: 'Ucrânia' },
  { code: 'AE', label: 'Emirados Árabes Unidos' },
  { code: 'GB', label: 'Reino Unido' },
  { code: 'UY', label: 'Uruguai' },
  { code: 'UZ', label: 'Uzbequistão' },
  { code: 'VU', label: 'Vanuatu' },
  { code: 'VN', label: 'Vietnã' },
  { code: 'WF', label: 'Wallis e Futuna' },
  { code: 'EH', label: 'Saara Ocidental' },
  { code: 'YE', label: 'Iêmen' },
  { code: 'ZM', label: 'Zâmbia' },
  { code: 'ZW', label: 'Zimbábue' },
]
