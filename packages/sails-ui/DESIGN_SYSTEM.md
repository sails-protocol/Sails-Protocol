# Sails Design System

> **Status:** Proposta — aguardando homologação do Design System Architect; DESIGN.md e SAILS_DESIGN_LANGUAGE.md serão reconciliados após a homologação.

Fonte única de cores, tipografia e tamanhos da Sails UI. Os tokens vivem em
`src/index.css` (variáveis CSS, tema claro em `:root`, escuro em `:root.dark`)
e em `tailwind.config.js` (utilitários). A página viva `/dev/design-system`
(apenas em desenvolvimento) mostra cada token com o contraste medido nos dois
temas. O teste `tests/designSystemGuard.test.ts` impede que valores fora dos
tokens voltem ao código.

Itens marcados **provisório — ratificação pendente** (2026-11-20) vêm da auditoria
M3/HIG/WCAG (`ui-refs/ds-audit-2026-11-20`), adotados pelo PM como padrão até a
ratificação do Design System Architect. Cada um é um token ou uma classe
compartilhada, então reverter é trocar um valor em um lugar.

## 1. Princípios

- **Referências de qualidade, não de visual:** Apple HIG (hierarquia, clareza,
  feedback, ergonomia), Material Design 3 (componentes, estados,
  responsividade, acessibilidade), WCAG 2.2 AA como mínimo. A identidade é da
  Sails: nunca copiar iOS ou Android.
- **Dark-first**, com tema claro e white-label preservados.
- **Desktop:** densidade profissional, mouse e teclado. **Móvel:** ergonomia,
  alvos de toque de 44px. **Tablet:** layout adaptado, nem celular esticado
  nem desktop espremido.
- **Fluxos econômicos:** clareza, prevenção de erro, confirmação de ações
  irreversíveis, estados fiéis ao protocolo (CTO 437: nenhum estado,
  garantia, prazo ou custódia inventados).
- **Reusar antes de criar.** Aplicar de forma progressiva, sem redesign amplo.

## 2. Cores: um significado por cor

Três eixos separados, que nunca se misturam:

| Eixo | Papéis | Regra |
|---|---|---|
| Marca | laranja, azul da marca | identidade e ação; nunca status, nunca lado |
| Lado do trade | buy (compra), sell (venda) | só "Comprar"/"Vender"; nunca sucesso/erro |
| Status | success, warning, danger, info, neutral | ciclo de vida e feedback; disputa = danger |

Regras:
- **buy/sell nunca para status.** Um chip "Vender" não pode parecer erro; uma disputa usa danger, nunca sell.
- **Laranja não é "compra"; verde não é necessariamente "compra"; vermelho não é "venda".**
- **Um botão sólido laranja por tela** (a ação primária). No ticket da oferta a ação primária é o próprio lado (sólido verde "Comprar" / sólido vermelho "Vender") e substitui o laranja ali; continua uma única ação primária.
- **Azul da marca ≠ info.** Tokens diferentes mesmo quando o valor coincide (escuro: ambos #60A5FA no texto). O azul da marca é para links, seleção, gráficos e destaques; info é status.
- A cor nunca é o único sinal: todo status tem rótulo (e, nas badges, ícone).
- **Lado e status têm formas diferentes** (**provisório — ratificação pendente**). Na tela, compra ≈ sucesso
  (mesmo matiz 158° no escuro) e venda ≈ perigo; para quem não distingue
  vermelho/verde eles colapsam. Então: **lado = texto colorido + seta**
  (`SideBadge`: `ArrowDownLeft` Comprar, o ativo entra; `ArrowUpRight` Vender, o
  ativo sai; sem pílula); **status = pílula com tint + ícone + rótulo**
  (`TONE_CLASS`). Nunca só cor. Botão de lado (fase 4A): sólido `buy`/`sell` só na ação única do ticket da
  oferta; tonal `buy-tonal`/`sell-tonal` na ação da linha do Market; "Sua oferta" fica neutra. O rótulo
  ("Comprar"/"Vender") sempre acompanha a cor.
- **Marcado ≠ ação.** Checkbox e switch ligados usam `--color-checked` (azul da
  marca), nunca laranja: laranja = agir, azul = escolhido. Navegação ativa
  (sidebar, bottom nav, abas) segue laranja ("você está aqui").
- **Tons de escrow** (**provisório — ratificação pendente**): `COMPLETED` = neutro (CTO 437: escrow
  concluído ≠ finalidade de liquidação; igual ao chip de `tradeState`),
  `EXPIRED` = atenção, `SPLIT` = neutro. Neutro usa borda sutil, como os outros tons.
- **Trade `COMPLETED` = neutro** (**provisório — ratificação pendente**, 2026-11-20, CTO 437):
  igual ao escrow `COMPLETED`. "Concluído" é o estado do registro, não uma
  afirmação de finalidade de liquidação, então não leva o verde de sucesso; o
  ícone de check e o rótulo carregam o estado. Era sucesso (verde).
- **Seleção ≠ marcado ≠ link** (fase 3): linha/opção selecionada = `bg-brand-selected`
  (azul da marca a 12 %) + sinal que não é cor (check, rádio, texto); link =
  `text-brand-link` (azul da marca). Laranja nunca é link nem seleção.

### 2.1 Estrutura de cada papel

| Token CSS | Utilitário | Uso |
|---|---|---|
| `--color-X` | `text-brand-X`, `border-brand-X`, `bg-brand-X/NN` | base: ícones, bordas funcionais (≥ 3:1), origem do tint |
| `--color-X-fg` | `text-brand-X-fg` | texto (≥ 4.5:1 em bg/superfície/elevado **e** no próprio tint) |
| base/10 | `bg-brand-X-bg` | tint sutil |
| base/25 | `border-brand-X-border` | borda de chip (decorativa) |
| `--color-X-solid` | `bg-brand-X-solid` | preenchimento sólido |
| `--color-on-X` | `text-brand-on-X` | texto sobre o sólido |

`X` = `success`, `warning`, `danger`, `info`, `buy`, `sell`, `blue` (azul da
marca, variáveis `--color-brand-blue*`). Para chips, badges e avisos use
`TONE_CLASS` (`src/lib/tone.ts`): `neutral | info | success | warning | danger | buy | sell`.

### 2.2 Valores e contraste medido

Mínimo entre fundo, superfície e elevado (claro: #FAFAFA / #FFFFFF / #F5F5F5;
escuro: #111318 / #1C2028 / #252A33). Tint = base a 10% sobre a superfície.
Medido pela página `/dev/design-system` a partir das variáveis carregadas.

**Escuro**

| Papel | texto (fg) | fg | no tint | base (UI) | sólido / on | sólido |
|---|---|---|---|---|---|---|
| Laranja | #F97316 | 5.14 | 4.51 | 5.14 | #F97316 / #111318 | 6.63 |
| Azul da marca | #60A5FA | 5.67 | 4.80 | 5.67 | #2563EB / branco | 5.17 |
| Compra | #4CC79A | 6.82 | 5.63 | 6.82 | #4CC79A / #111318 (fase 4A; era #0D8259 / branco 4.82) | 8.80 |
| Venda | #FB7185 | 5.35 | 4.64 | 5.35 | #FB7185 / #111318 (fase 4A; era #B9384E / branco 5.62) | 6.90 |
| Sucesso | #34D399 | 7.49 | 6.14 | 7.49 | #34D399 / #111318 | 9.67 |
| Atenção | #FBBF24 | 8.63 | 6.95 | 8.63 | #FBBF24 / #111318 | 11.13 |
| Perigo | #F87171 | 5.21 | 4.52 | 5.21 | #B91C1C / branco | 6.47 |
| Info | #60A5FA | 5.67 | 4.80 | 5.67 | #60A5FA / #111318 | 7.31 |
| Neutro | #A9B0BC | 6.60 | 6.60 (elevado) | 3.03 (#6B7385) | — | — |

**Claro**

| Papel | texto (fg) | fg | no tint | base (UI) | sólido / on | sólido |
|---|---|---|---|---|---|---|
| Laranja | #C2410C | 4.75 | **4.13** | 4.75 | #EA580C / #111318 (provisório) | 5.22 |
| Azul da marca | #1D4ED8 (base #2563EB) | 6.15 | 5.36 | 4.74 | #2563EB / branco | 5.17 |
| Compra | #0A6B49 (base #0D8259) | 6.00 | 5.29 | 4.42 | #0D8259 / branco | 4.82 |
| Venda | #A3324A (base #B9384E) | 6.19 | 5.36 | 5.15 | #B9384E / branco | 5.62 |
| Sucesso | #166534 (base #15803D) | 6.54 | 5.74 | 4.60 | #15803D / branco | 5.02 |
| Atenção | #92400E (base #B45309) | 6.50 | 5.71 | 4.61 | #B45309 / branco | 5.02 |
| Perigo | #B91C1C | 5.93 | 5.02 | 5.93 | #B91C1C / branco | 6.47 |
| Info | #1D4ED8 | 6.15 | 5.27 | 6.15 | #1D4ED8 / branco | 6.70 |
| Neutro | #525252 | 7.17 | 7.17 (elevado) | 3.30 (#878787) | — | — |

Laranja claro sobre tint laranja (4.13) **não é combinação aprovada** (hoje não
há uso). **Primário claro** (**provisório — ratificação pendente**): texto escuro #111318 sobre #EA580C
(5.22:1), a mesma regra do escuro ("texto escuro sobre laranja"); o
preenchimento mede 3.41 / 3.56 / 3.26 contra bg / superfície / elevado. Era
branco sobre #C2410C (5.18:1). `--primary` mudou; `--color-orange` (#C2410C)
continua sendo o laranja de texto e borda no claro, e `bg-brand-orange` não é
mais usado como sólido (só `bg-primary`). Bordas de chip (base/25) medem 1.2–1.8:1 e são decorativas: o rótulo
carrega o significado (WCAG 1.4.11 não se aplica). Bordas funcionais (input,
erro, foco) usam a base cheia.

### 2.3 Cores de ativo

`--color-asset-*` / `bg-asset-btc/15 text-asset-btc` (btc, usdt, usdc, depix,
eth, bnb, sol, ltc, stx, spark): identidade do ativo no `AssetIcon`
(monograma decorativo, `aria-hidden`). Iguais nos dois temas, não são tokens
de marca do white-label e nunca carregam significado.

**Catálogo de ativos** (2026-11-20, DECISIONS.md): os 14 pares oficiais vivem só
em `src/lib/assetCatalog.ts`. `AssetIcon` mostra a logo oficial do ativo com a
logo da rede numa pastilha `bg-asset-chip` (clara nos dois temas, anel de 1px
da superfície) no canto; tamanhos `sm`/`md`/`lg` = 16/20/24. Logos em
`public/brand/{assets,networks}`, sem alteração (`THIRD_PARTY_LOGOS.md`); o
monograma fica só para valores sem marca oficial. `AssetNetworkLabel` = ícone +
"BTC · On-chain", o único jeito de escrever um par na interface.

### 2.4 White-label

Uma marca pode mudar: laranja (`--color-orange*`, `--primary*`), azul da marca
(`--color-brand-blue*`), logo, tipografia (`--sails-font-*`) e navegação.
Não pode mudar: status (success/warning/danger/info/neutral), buy/sell, sinais
de risco/autoridade, acessibilidade (contrastes acima) e vocabulário de estados.

## 3. Tipografia

Inter (UI e títulos), IBM Plex Mono só para IDs/chaves/hashes/endereços.
Pesos 400/500/600 apenas. Móvel < 768px, desktop ≥ 768px.

| Utilitário | Papel | Móvel / desktop | Altura de linha | Peso | Tracking | Variável |
|---|---|---|---|---|---|---|
| `text-display` | valor de destaque | 28 / 32 | 1.15 | 600 | -0.02em | `--t-display` |
| `text-title` | título da página (h1) | 22 / 24 | 1.25 | 600 | -0.01em | `--t-page` |
| `text-heading` | título de seção | 16 / 16 | 1.35 | 600 | 0 | `--t-section` |
| `text-subheading` | subtítulo, grupo | 15 / 14 | 1.4 | 500 | 0 | `--t-body` |
| `text-body` (= `text-sm`) | texto e controles | 15 / 14 | 1.5 | 400 | 0 | `--t-body` |
| `text-body-sm` | secundário, células | 13 / 13 | 1.5 | 400 | 0 | `--t-body-sm` |
| `text-caption` (= `text-xs`) | metadados (piso 12) | 12 / 12 | 1.4 | 400 | 0 | `--t-meta` |
| `text-headline` (provisório) | título de diálogo, sheet, card, passo | 18 / 18 | 1.3 | 600 | -0.01em | `--t-headline` |
| `text-control` | rótulo de botão e campo | 14 / 14 | 1.25 | 500 | 0 | `--t-control` |
| `text-field` (provisório) | texto digitado em campo | 16 / 14 (16 no toque) | 1.4 | 400 | 0 | `--t-input` |
| `.money` / `tabular-nums` | numérico | 15 | 1.3 | 600 | 0 | `--t-money` |
| `.money-lg` (provisório) | preço em linha/tabela | 18 / 18 | 1.2 | 600 | -0.01em | `--t-headline` |
| `.money-hero` | valor principal do trade | 26 / 28 | 1.15 | 600 | -0.01em | `--t-money-hero` |
| `.mono-id` | mono, só IDs | 14 | 1.5 | 400 | 0 | `--t-mono` |

Tokens em **rem** (**provisório — ratificação pendente**): 1rem = 16px no padrão; quem aumenta a fonte do
navegador aumenta o texto (HIG: texto ampliável; WCAG 1.4.4 já passava pelo zoom).
O campo usa `text-field`, não `text-input`, porque `input` já é uma cor
(`border-input`) e o Tailwind leria `text-input` como cor. `text-base`, `text-lg`,
`text-xl`, `text-2xl` saíram de `src` (o guard falha neles).

Nomes antigos continuam válidos: `text-sm`, `text-xs`, `.text-page-title`,
`.text-section-title`, `.text-label`, `.text-metadata`, `.money`, `.money-hero`,
`.mono-id`. Novos nomes de tamanho precisam constar em `src/lib/utils.ts`
(configuração do twMerge), senão `cn()` os confunde com cor e os descarta.
Nada abaixo de 12px; nada de `text-[13px]`.

## 4. Tamanhos

| Grupo | Tokens |
|---|---|
| Espaçamento | escala de 4px do Tailwind; passos preferidos 1, 2, 3, 4, 6, 8 (4–32px) |
| Raios | ver 4.2 |
| Controles | por ponteiro (**provisório — ratificação pendente**): ponteiro fino 36 (`sm`, campos, chips) / 40 (botão padrão) / 32 (segmentado); variante `touch:` (ponteiro grosso em qualquer largura **ou** janela < 768px) leva tudo a 44. Tokens `h-control-sm`/`h-control`/`h-control-touch` = `h-9`/`h-10`/`h-11` |
| Ícones | `size-icon-sm` 16, `size-icon` 20, `size-icon-lg` 24 |
| Avatares | `UserAvatar` sm 28, md 36, lg 48, xl 64 |
| Elevação | ver 4.3 |

### 4.1 Layout: classes de janela

| Classe Sails | Largura | Tailwind | Classe M3 adaptada | Navegação | Margem | Gutter | Controles |
|---|---|---|---|---|---|---|---|
| Compacta | < 768 | base (`sm` 640 só no PageHeader) | compact + medium baixo | bottom nav + topo móvel | 16 | 16 | 44 |
| Média | 768–1023 | `md` | medium + expanded baixo | trilho de 64, expande por cima | 24 | 16 | pelo ponteiro: 36/40 fino, 44 toque |
| Expandida | 1024–1279 | `lg` | expanded | trilho de 64, expande por cima | 24 | 24 | pelo ponteiro |
| Grande | ≥ 1280 | `xl` | large | barra lateral de 224, empurra | 32 | 24 | pelo ponteiro |
| Extra grande | ≥ 1536 | `2xl` | extra-large | idem, conteúdo até 1280 | 32 | 24 | pelo ponteiro |

Os pontos de quebra são os do Tailwind que o código já usa (768/1024/1280); o
que muda é o significado de cada classe. **Tablet:** layout da classe Média ou
Expandida (trilho, tabela a partir de 1024), alvos pelo ponteiro: um iPad tem
44, um laptop estreito mantém 36/40. Nem celular esticado nem desktop espremido.
Margens no shell (`Layout`): `px-4 md:px-6 xl:px-8`. Larguras do `Page`
(`PageHeader.tsx`): `list` 1280, `detail` 1152 (aside opcional ≥ 1024), `form`
672, `prose` 68ch (medida de leitura). Diálogo 448 (confirmação) / 560
(formulário), popover 288. Abaixo de 1024 a tabela do Market vira linhas.

**Posição do menu no desktop** (DECISIONS.md, 2026-11-20): Configurações →
Aparência → "Posição do menu: Lateral | Superior", cartões de rádio com uma
miniatura de cada layout (`layout/NavPositionThumb.tsx`, só tokens). Padrão
**Lateral** (a barra lateral e o trilho acima, sem nenhuma mudança). Guardada em
`sails_ui_nav_position` (`lib/navPosition.ts`, leitura e escrita protegidas;
`useNavPosition()` no `Layout` e em Configurações). Não há botão de alternar na
barra. **Superior**, só a partir de 1024 (`lg`): a barra do topo (56, nível 1
fixo) vira três colunas, a logo (símbolo + "Sails Market") à esquerda, os
itens de `NAV_ITEMS` no centro (4) (ícone + rótulo, mesma ordem, rotas e
`isNavActive`, tom ativo `navItemTone` igual ao da barra lateral,
`aria-current="page"`, 36 com ponteiro fino / 44 no toque) e a conta à direita
(`AccountMenu`, ou "Conectar wallet" sem sessão); a barra lateral some nessa
largura e o conteúdo usa a largura toda (mesmas larguras de `Page`). Abaixo de
1024 vale o layout de hoje qualquer que seja a escolha; no celular, a barra
inferior não muda. Teclado: "Pular para o conteúdo" é a primeira parada (leva a
`#main-content`), depois logo → itens → conta.

**Navegação pela visão do usuário** (DECISIONS.md "Reorganização pela visão do
usuário", UX-031, 2026-11-20). Menu principal = `NAV_ITEMS`
(`layout/Sidebar.tsx`), o mesmo na barra lateral, na barra superior e na barra
inferior do celular (4 itens): **Market** `/` · **Trades** `/trades` · **Perfil**
`/profile` (avatar) · **Configurações** `/settings`. Disputas saiu do menu e
virou aba. Trades acende em qualquer `/trades/*` e na página do trade
`/trade/:id` (`isNavActive` com `also`, `layout/navMatch.ts`). Abas de Trades
(`layout/TradesTabs.tsx`, `TabLinks`, uma URL por aba): **Ativos** `/trades` ·
**Histórico** `/trades/history` · **Minhas ofertas** `/trades/offers` (lista com
pausar, ativar e cancelar; "Nova oferta" em `/trades/offers/new`) · **Disputas**
`/trades/disputes`. A aba Disputas mostra primeiro **os trades da própria
pessoa em disputa** (`getTrades()`, a mesma fonte de Ativos e Histórico, status
`DISPUTED`); cada linha abre o trade, onde fica o painel da disputa. Abaixo, só
para árbitros, a seção "Casos atribuídos a você como árbitro" (`listDisputes()`,
com o caso no painel lateral, sem mudança), que só aparece quando há pelo menos
um caso. Contador da aba Disputas: o número de trades da pessoa em disputa, só
com o dado carregado; pílula âmbar (`TONE_CLASS.warning`) com "em disputa" para
leitor de tela; sem dado, sem número. Abaixo de ~430 px (as quatro abas somam
398 px) a faixa rola na horizontal dentro dela mesma, com a aba atual trazida à
vista. Endereços antigos redirecionam com `replace`, mantendo query, hash e
`state` (`LEGACY_REDIRECTS`): `/profile/active` → `/trades`, `/profile/history`
→ `/trades/history`, `/profile/new-offer` → `/trades/offers/new`, `/disputes` →
`/trades/disputes`. O Perfil continua com a vitrine (identidade, reputação,
avaliações) e com a mesma seção "Minhas ofertas" (`MyOffersSection`,
compartilhada com a aba). Configurações, em ordem de uso: Wallet, Aparência,
Idioma, Notificações, Segurança, Rede e nós, Mercados, Ajuda e Sobre. A seção
aberta fica na URL, `?section=<id>` (substitui o histórico, não empilha; sem o
parâmetro ou com id desconhecido abre Wallet; `lib/settingsSection.ts`); no
celular um link direto já abre a seção.

### 4.2 Forma

| Token | Valor | Componentes |
|---|---|---|
| `rounded-none` | 0 | células, linhas de lista de borda a borda, bottom nav |
| `rounded-sm` | 4 | checkbox, itens de menu/listbox, thumb do segmentado, tooltip |
| `rounded-md` | 6 | botões, campos, selects, chips de toolbar, botões de ícone |
| `rounded-lg` | 8 | cards, popovers, diálogos, avisos, trilho do segmentado, StateBlock |
| `rounded-xl` | 12 | só balão de chat (e topo de bottom sheet, fase 3) |
| `rounded-full` | — | badges, avatares, switch, presença |

**Regra de aninhamento:** raio interno = raio externo − padding, mínimo 2.
Segmentado: trilho 8 com padding 4 → thumb 4 (concêntrico). Nunca um raio
interno maior que o do container. `rounded-2xl/3xl` saíram (guard).

### 4.3 Elevação por componente

| Nível | Superfície | Sombra | Borda | Componentes |
|---|---|---|---|---|
| 0 | `bg` | — | — | página |
| 1 | `surface` | — | `border-subtle` só sobre `bg` | cards, sidebar, bottom nav, contêiner de tabela |
| 1 fixo | `bg` 90 % + blur | — | hairline inferior | barra do topo |
| 2 | `floating` (novo) | `elevation-2` | `border-subtle` | popover, menu, lista do select |
| 2 inverso | `inverse` | `elevation-2` | — | tooltip, toast |
| 3 | `surface` | `elevation-3` | `border-subtle` | diálogo, sheet, overlay da sidebar |
| thumb | `raised` | `elevation-1` | — | thumb do segmentado e do switch |

`floating` (**provisório — ratificação pendente**): claro = branco (a sombra separa); escuro #2B303A, 1.23:1
contra a superfície, então um popover sobre um card deixa de ser superfície
sobre superfície. Texto nele 12.33 (escuro) / 19.80 (claro), secundário 6.07 /
7.81, muted 4.79 / 5.92. `inverse`: claro #252A33 com texto #F5F7FA (13.42:1),
escuro #E6E9EF com #111318 (15.28:1). **Scrim** (`bg-scrim`, **provisório — ratificação pendente**):
#0A0A0A a 40 % no claro, preto a 60 % no escuro (era `bg-black/80` e `/50`): o
contexto atrás de uma confirmação continua reconhecível. `shadow-sm/md/lg/xl` e
`bg-black/NN` saíram de `src` (guard).

### 4.4 Movimento (**provisório — ratificação pendente**)

| Token | Valor | Uso |
|---|---|---|
| `--duration-short` / `duration-short` | 100 ms | cor, hover, pressionado, tooltip; saídas curtas |
| `--duration-medium` / `duration-medium` | 200 ms | entrada de popover/menu/select; largura da sidebar; saída de diálogo/sheet |
| `--duration-long` / `duration-long` | 300 ms | entrada de diálogo e sheet |
| `--easing-standard` / `ease-standard` | cubic-bezier(0.2, 0, 0, 1) | mudanças no lugar |
| `--easing-decelerate` / `ease-decelerate` | cubic-bezier(0, 0, 0, 1) | entradas |
| `--easing-accelerate` / `ease-accelerate` | cubic-bezier(0.3, 0, 1, 1) | saídas |

As classes `animate-in`/`animate-out`, `fade-in-0`/`fade-out-0`,
`zoom-in-95`/`zoom-out-95`, `slide-in-from-*`/`slide-out-to-*` são nossas
(`@utility` + `@keyframes sails-enter/sails-exit` em `index.css`, sem
dependência). Antes elas não geravam CSS (o plugin nunca foi instalado) e os
overlays apareciam sem transição. Entrada desacelera; saída acelera e é mais
curta. `motion-overlay-long` (diálogo, sheet: entra 300, sai 200) e
`motion-overlay-short` (tooltip: 100/100). Com `prefers-reduced-motion: reduce`
toda animação e transição fica instantânea (regra global), spinners só giram com
`motion-safe:`. Nada de animação em linhas de tabela ou atualização de preço. Raw
`duration-NNN`/`ease-in/out` saíram de `src` (guard).

## 5. Componentes (reusar antes de criar)

| Componente | Faça | Não faça |
|---|---|---|
| `Button` (`ui/button.tsx`) | `default` = ação primária (uma por tela); `secondary` (tonal; `outline` é alias) para ações de apoio; `ghost` para baixa ênfase; `destructive` só para ação destrutiva; `buy`/`sell`/`buy-tonal`/`sell-tonal` só para a ação que é o lado do trade (5.1); carregando = prop `loading` (ver 5.2), indisponível = `disabled` | dois sólidos laranja lado a lado; cor manual em botão; contorno cinza em botão; `disabled` para "carregando" |
| `Input` | rótulo visível; erro = `aria-invalid` (a borda fica danger via `field-focus`) + mensagem `text-brand-danger-fg` ligada por `aria-describedby` | placeholder no lugar de rótulo; outline em volta de campo |
| Badges (`StatusBadges.tsx`) | `SideBadge` (lado: texto + seta), `TradeStatusBadge`, `EscrowStatusBadge`, `OfferStatusBadge` (status: pílula + ícone + rótulo); rótulos longos quebram linha, nunca transbordam | cor solta por tela; status só por cor; lado em pílula |
| `TONE_CLASS` (`lib/tone.ts`) | chips e avisos de status | reutilizar buy/sell como status |
| `StateBlock` | loading / empty / error / signedOut em toda superfície de conteúdo | spinner solto, tela vazia sem saída |
| `ConfirmActionDialog` | toda ação irreversível: resumo, consequência, avisos; foco inicial em Cancelar | confirmar com Enter por acidente |
| `SegmentedControl`, `.toolbar-chip`, `Select`, `Popover`, `Sheet`, `Dialog`, `Tooltip`, `Checkbox`, `Switch` | seletores, menus, filtros, modais; tooltip inverso; marcado em azul | criar variantes paralelas |
| `Toast`, `Tabs`/`TabLinks`, `Menu`, `RadioGroup`/`RadioCard`, `Table`, `Alert`, `Progress`, `Divider`, `IconButton`, `FilterChip`, `Combobox` (5.3) | o primitivo correspondente | menu, abas, rádio, listbox ou toast feitos à mão; `title=` em botão |
| Foco | automático: `:focus-visible` global (botões, links, linhas); `field-focus` em campos (ver 5.1) | `ring-offset-*`; `outline-none` sem substituto |

### 5.1 Superfícies, botões e foco (2026-11-20)

**Regra das bordas:** borda só onde carrega significado: campos (input, select,
textarea, seletores), foco e divisórias. Superfícies se separam por tom e
elevação (bg → superfície → elevado; sombra só em camadas flutuantes). Nunca uma
caixa com borda dentro de um container com borda: dentro de diálogo, card ou
popover, agrupar com **lista agrupada** (fundo elevado, linhas separadas por
`divide-brand-border-subtle`, sem borda externa), como o resumo do
`ConfirmActionDialog`. Avisos mantêm o tint, com borda no máximo sutil (base/25).
Diálogo, popover, select e tooltip: superfície + `border-brand-border-subtle` +
`shadow-elevation-2/3`.

**Botões (variantes e quando usar):**

| Variante | Visual | Uso |
|---|---|---|
| `default` | sólido laranja com texto escuro nos dois temas (claro #EA580C, provisório) | a ação primária, uma por tela |
| `secondary` (= `outline`, alias mantido) | **tonal**: preenchido um passo acima da superfície onde está (`bg-brand-tonal`, cor do texto a 8% no escuro / 7% no claro), sem contorno, texto principal | ações de apoio: Voltar, Tentar de novo, Limpar |
| `buy-tonal` / `sell-tonal` (fase 4A) | tint do lado a 10 % (`bg-brand-buy-bg` / `bg-brand-sell-bg`) + texto do lado (`-fg`), sem contorno; camada de estado `state-layer-buy/sell` | Comprar/Vender na linha do Market (OfferTable, OfferCard) |
| `buy` / `sell` (fase 4A) | sólido do lado (`bg-brand-buy-solid` / `bg-brand-sell-solid`) + rótulo `on-buy` / `on-sell` (claro: branco com camada escura; escuro: grafite #111318 sobre preenchimento claro, com camada clara, a mesma regra do primário laranja) | a ação primária do ticket da oferta ("Comprar BTC" / "Vender BTC"), no lugar do laranja |
| `ghost` | sem preenchimento até o hover | baixa ênfase: ações de toolbar, "Detalhes" |
| `destructive` | sólido danger | ação destrutiva (sempre via `ConfirmActionDialog`) |
| `link` | texto `brand-link` (azul da marca; 6.15+ claro, 5.67+ escuro) sublinhado no hover (era laranja: laranja = agir) | navegação dentro do texto |

**Botões de lado, medido** (rótulo vs preenchimento, mínimo entre fundo,
superfície e elevado; ao vivo em `/dev/design-system`, seção "Botões de lado"):

| Tema | Variante | repouso | hover | pressionado |
|---|---|---|---|---|
| Claro | `buy-tonal` | 5.29 | 4.82 | 4.60 |
| Claro | `sell-tonal` | 5.36 | 4.80 | 4.57 |
| Escuro | `buy-tonal` | 5.63 | 6.03 | 6.21 |
| Escuro | `sell-tonal` | 4.64 | 4.94 | 5.08 |
| Claro | `buy` (branco sobre #0D8259) | 4.82 | 5.49 | 5.95 |
| Claro | `sell` (branco sobre #B9384E) | 5.62 | 6.38 | 6.81 |
| Escuro | `buy` (#111318 sobre #4CC79A) | 8.80 | 9.29 | 9.63 |
| Escuro | `sell` (#111318 sobre #FB7185) | 6.90 | 7.42 | 7.72 |

Sólido vs superfície (≥ 3:1): claro compra 4.42–4.82, venda 5.15–5.62; escuro
compra 6.82–8.80, venda 5.35–6.90. Foco (contorno 2 px) vs superfície: 18.16+
claro, 13.42+ escuro. No escuro o sólido segue a regra do primário laranja
(preenchimento claro + rótulo escuro): com branco sobre #0D8259 / #B9384E o
botão media só 2.99 / 2.56 contra o elevado. Camada do sólido: preta no claro
(rótulo branco), branca no escuro (rótulo escuro), `state-layer-dark
dark:state-layer-light`. Estados lado a lado (repouso, hover, pressionado,
foco, desativado, carregando, mais "Sua oferta") e a linha real do OfferTable
estão em `/dev/design-system`, seção "Botões de lado".

A camada dos tonais é a cor do lado no claro e preta no escuro (tokens
`--state-layer-buy/sell`, utilitários `state-layer-buy/sell`): a camada padrão
(cor do texto) baixaria o rótulo para 4.10 (compra, claro) e 3.23 (venda,
escuro). Preenchimento vs container 1.13–1.21 (como o tonal: o rótulo identifica
o botão). Tokens: dois de camada novos (`--state-layer-buy/sell`) e, no
escuro, `--color-buy-solid`/`--color-sell-solid` e `--color-on-buy/sell`
trocados (usados só pelos botões de lado e pela página dev).

Estados: hover e pressionado são camadas de estado, desativado e carregando são
distintos (ver 5.2). Tamanhos: 40 / `sm` 36 / `lg` 44 com ponteiro fino; `touch:`
leva todos a 44. Padding 16 / 12 / 20 (o `px-8` do shadcn saiu).
Por que o tonal não precisa de borda 3:1: o botão é identificado pelo rótulo de
texto (≥ 10.6:1 sobre o tonal em qualquer superfície); o WCAG 1.4.11
(Understanding) não exige contraste da área do botão quando o texto basta para
identificá-lo. Medido (tonal vs container): escuro 1.21–1.26, claro 1.16.

**Controle segmentado** (`SegmentedControl`, `SEGMENT_TRACK`,
`segmentItemClass`, usados também no seletor de lado do Market e do Publicar).
Item 32 com ponteiro fino, 44 em `touch:`; trilho `rounded-lg` 8 com padding 4,
thumb `rounded-sm` 4 (concêntrico); hover/pressionado = `state-layer`:
trilho tonal sem contorno; item selecionado = `bg-brand-raised` (claro: branco
opaco; escuro: texto a 14% sobre o trilho) + `shadow-elevation-1` + texto
principal peso 500; não selecionado = texto secundário peso 400. Seleção por
preenchimento, elevação, cor e peso juntos, mais `aria-pressed`. Medido
(mín–máx entre fundo, superfície e elevado):

| Tema | thumb vs trilho | selecionado (texto/thumb) | não selecionado (secundário/trilho) | texto sel. vs não sel. |
|---|---|---|---|---|
| Escuro | 1.51–1.54 | 7.05–9.37 | 5.22–7.03 | 2.03 |
| Claro | **1.50–1.62** (era 1.16–1.26) | 19.80 | 4.82–5.22 (era 6.20–6.73) | 2.53 |

Trilho com tom próprio (fase 3): `bg-brand-segment-track` = texto a
`--segment-track-a` (claro 0.18, escuro 0.08 = o tonal). No claro o thumb
branco agora se separa pelo preenchimento (≥ 1.5) e mantém a sombra
`elevation-1`; sem anel, sem caixa. Medido trilho vs container: claro
1.49–1.50, escuro 1.21–1.26.

**Foco:** token `--color-focus` = cor do texto (#F5F7FA escuro, #0A0A0A claro).
Não é token de marca do white-label (acessibilidade é travada). Escolhido em vez
de laranja (se confunde com o primário e a seleção) e de azul (anel azul em volta
do botão laranja briga com a marca; azul vs laranja 1.0–1.1:1). Contraste com o
fundo adjacente (o vão de 2px é transparente): escuro 17.31 / 15.21 / 13.42,
claro 18.97 / 19.80 / 18.16 (bg / superfície / elevado); sobre o tonal ≥ 10.6.
- Botões, links, abas, itens segmentados, linhas e gatilhos: `:focus-visible`
  global em `index.css` = `outline: 2px solid` + `outline-offset: 2px` (só
  teclado, nunca no clique). Linhas dentro de listas recortadas usam
  `focus-visible:-outline-offset-2`.
- Campos (`Input`, `Textarea`, `Select`, `.input-field`, `.toolbar-chip`, seletor
  de contexto): **sem outline**. `field-focus` troca a própria borda pela cor de
  foco e soma 1px por dentro (`box-shadow inset`), 2px sem deslocar o layout; com
  `aria-invalid="true"` a borda é danger, e no foco danger 2px. Cartões de rádio e
  o campo de preço com botões usam `field-focus-within`.
- Uma borda visível por elemento em qualquer estado.

### 5.2 Estados: camadas, desativado e carregando (**provisório — ratificação pendente**)

**Camadas de estado** (valores M3), um sistema para todo elemento interativo,
utilitário `state-layer` em `index.css`. Substituiu os cinco estilos soltos
(`hover:bg-brand-elevated` em 28 lugares, `hover:bg-brand-elevated/60` nas
linhas, `hover:bg-primary/90`, `opacity-70 → 100` nos fechar, `tonal-hover/
pressed` da fase 1).

| Estado | Opacidade | Onde |
|---|---|---|
| hover | `--state-hover-a` 0.08 | só com ponteiro que tem hover (`@media (hover: hover)`: um toque não deixa hover preso) |
| foco | `--state-focus-a` 0.12 | só dentro de widgets compostos sem outline: utilitário `state-focus` (item de menu em `:focus-visible`, opção ativa do combobox em `data-active`) |
| pressionado | `--state-pressed-a` 0.12 | `:active`, todo elemento, inclusive sólidos |
| arrastado | `--state-dragged-a` 0.16 | reservado (sem arrastar hoje) |

Cor da camada (mais rígida que o M3: o rótulo nunca perde contraste): cor do
texto sobre fundos neutros (tonal, ghost, linhas, navegação); **branca** sobre
sólido de rótulo escuro (`state-layer-light`: primário); **preta** sobre sólido
de rótulo branco (`state-layer-dark`: destrutivo). Medido: primário claro 5.22 →
5.71 (hover) → 6.00 (pressionado); escuro 6.63 → 7.12 → 7.44; destrutivo 6.47 →
7.31 → 7.75; rótulo no tonal ≥ 11.83 (claro) e ≥ 7.19 (escuro, sobre elevado).
Sem mudança de tamanho no pressionado.

**Desativado** (atributo `disabled` ou `aria-disabled="true"`): recipiente 12 %
e conteúdo 38 % da cor do texto (`bg-brand-disabled-container`,
`text-brand-disabled-content`), sem laranja: um primário desativado não parece
mais uma ação laranja. Isento de 1.4.3/1.4.11 (componente inativo); medido
2.44–2.46 (claro) e 2.77–3.16 (escuro). Campos: borda 12 % e conteúdo 38 %.
Checkbox e switch: opacidade 0.5.

**Carregando** (`<Button loading>`): mantém o visual habilitado e a largura (o
rótulo fica invisível mas segue no nome acessível; spinner `motion-safe` por
cima), `aria-busy="true"`, cliques ignorados. Nunca parece desativado: num fluxo
de protocolo a ação está **em andamento**, não recusada. O texto do rótulo, se
mudar, usa o gerúndio do que está acontecendo, nunca diz que terminou (CTO 437).
Com várias ações que compartilham um `acting` (cartão de assinatura, painel de
disputa): o botão clicado fica `loading`, os outros ficam `disabled` enquanto
isso (bloqueados, não em andamento): `busyProps(acting, running, key)` em
`lib/busy.ts`. Cancelar de uma confirmação em andamento continua `disabled`.

### 5.3 Primitivos (fase 3, **provisório — ratificação pendente**, 2026-11-20)

Todos em `src/components/ui/`, texto só por props, só tokens, espécime com
todos os estados em `/dev/design-system`. Sem dependência nova: Radix Popover
(já instalado) dá posição, Esc, clique fora e volta do foco para Menu e
Combobox; Tabs, RadioGroup, Table, Progress, Divider e Chip são HTML nativo.
Contraste: `ui-refs/ds-primitives-2026-11-20/contrast.cjs`.

#### Toast (`ui/toast.tsx`, sobre o sonner já usado)
- **Anatomia:** superfície `inverse` + `elevation-2`, **sem borda**, raio 6;
  ícone por tom (sucesso, info, atenção, erro) nas cores `inverse-*`; título
  `text-body-sm` 500; ação opcional em `inverse-link`; botão Fechar.
- **Tamanhos:** largura do sonner (356), ação e Fechar 36 fino / 44 toque.
- **Comportamento:** `toast.success/info/warning/error(...)` importado de
  `ui/toast` (o guard proíbe importar de `sonner`). Duração (`lib/toast.ts`):
  4 s confirmação, 6 s atenção/erro, 8 s com ação; erro e ação têm Fechar. No
  máximo 3 empilhados; topo no móvel, canto inferior direito no desktop.
- **A11y:** região `aria-live="polite"`; nunca rouba o foco; Fechar em pt-BR.
  Movimento: transform/opacity com `duration-medium` + `easing-decelerate`;
  instantâneo com movimento reduzido.
- **Contraste:** texto 13.42 (claro) / 15.28 (escuro); ícones no claro 5.21–8.63,
  no escuro 4.12–5.51; link 5.67 / 5.51.
- **Use** para confirmar uma ação local ("Chave pública copiada"). **Não use**
  como único registro de mudança de estado do protocolo (CTO 437): ela aparece
  na timeline/status; o toast diz o que foi registrado, nunca "Pago!".

#### Abas (`ui/tabs.tsx`)
- **Duas espécies, um visual:** `Tabs` (na página: `role=tablist/tab/tabpanel`,
  `aria-selected`, `aria-controls`, tabindex rotativo, setas Esquerda/Direita
  ou Cima/Baixo na vertical, Home/End, seleção segue o foco; `tabPanelProps`
  liga o painel) e `TabLinks` (rotas: `nav` de links com `aria-current="page"`).
- **Anatomia:** rótulo `text-control` 500; ativa = texto principal + indicador
  laranja 2 px (horizontal: sublinhado; vertical: barra à esquerda + tint 10 %);
  inativa = texto secundário; hairline `border-subtle` sob a faixa horizontal.
- **Tamanhos:** 40 fino / 44 toque (vertical 36 / 44).
- **Onde:** Configurações md+ = `Tabs` verticais (trocam a seção, a URL fica;
  abaixo de md a mesma navegação é uma lista que abre a seção). Trades
  (Ativos | Histórico | Minhas ofertas | Disputas) = `TabLinks` (cada aba é uma URL). **Não use** para
  filtros (segmentado).

#### Menu (`ui/menu.tsx`)
- **Anatomia:** `floating`, `elevation-2`, borda sutil, raio 6, padding 4;
  itens 32 fino / 44 toque com ícone 16 + rótulo; `MenuSeparator` (Divider),
  `MenuLabel` (cabeçalho não interativo); item `destructive` em `danger-fg`.
- **Teclado:** Enter/Espaço/seta abaixo abrem no primeiro item, seta acima no
  último; setas, Home/End, typeahead (letras em 500 ms formam um prefixo); Tab e
  Esc fecham, o foco volta ao gatilho. Item-link ativa também com Espaço.
- **Estados:** hover 8 %, foco 12 % (`state-focus`, sem outline dentro do menu),
  pressionado 12 %.
- **Use** para comandos (AccountMenu). `role="menu"` fora do primitivo falha no
  guard. **Não use** para navegação principal nem para escolher um valor
  (Combobox/Select).

#### RadioGroup e cartões de rádio (`ui/radio-group.tsx`)
- **Anatomia:** `fieldset` + `legend` (pode ser sr-only) + descrição;
  `Radio` = rádio nativo de 18 px, anel 2 px na cor secundária, marcado = anel e
  ponto azul (`checked`, nunca laranja). `RadioCard` = o cartão inteiro é o
  rótulo (≥ 44 px), tonal sem contorno; selecionado = `bg-brand-selected` +
  rádio marcado (+ peso 500); desativado = recipiente 12 % e texto secundário,
  com o motivo ligado por `aria-describedby`.
- **A11y:** setas, Tab para o marcado e "1 de 3" vêm do navegador; foco pelo
  teclado = a borda do próprio cartão (`field-focus-within`, 2 px).
- **Onde:** estilo dos avatares (Configurações), decisão da disputa (Disputas).
  **Não use** para filtros (segmentado) nem para ligar/desligar (Switch).

#### Tabela (`ui/table.tsx`)
- **Anatomia:** `Table`, `TableHeader` (fixo com `sticky`: superfície 95 % +
  desfoque), `TableHead` (caption 500 muted, frase normal), `SortableTableHead`
  (botão dentro do `th`, `aria-sort` no `th`, ícone ↕ / ↑ / ↓), `TableRow`
  (hairline; `interactive` = camada de estado), `TableCell` (`numeric` = direita
  + tabular), `TableEmpty` (StateBlock sem borda numa linha cheia).
- **Ordenação:** `lib/sort.ts` (`nextSort`, `ariaSort`, `sortRows`: pt-BR,
  numérica, estável, vazios no fim; testado).
- **Listas-tabela:** Trades (Ativos/Histórico/Minhas ofertas/Disputas) e Perfil (ofertas) são
  listas que viram linhas abaixo de lg/xl; mantêm semântica de lista e usam o
  mesmo cabeçalho e linha (`TABLE_HEAD_ROW`, `TABLE_ROW`,
  `TABLE_ROW_INTERACTIVE`). OfferTable (Market ≥ lg) é a `<table>` real.
  Colunas e comportamento não mudaram; nenhuma tela ganhou ordenação nova.
- **Não faça:** animação em linha, borda em volta de cada célula.

#### Aviso inline (`ui/alert.tsx`, `Alert`)
- **Anatomia:** tint do tom (base/10) + ícone 16 na base do tom, **sem borda**,
  raio 6; título opcional 500; corpo na cor principal; ação opcional.
  `size="sm"` = caption (notas em formulários e cartões).
- **Tons:** info, success, warning, danger. Texto 15.36+ (claro) / 10.80+
  (escuro) em todo tint; ícone 4.04+ / 4.52+.
- **Papel:** `note` (estático), `live` = `status` (info/sucesso/atenção) ou
  `alert` (perigo novo).
- **Onde:** `SafetyNote` (agora um Alert `sm`, texto mantido), falha parcial do
  Market, aviso de vendedor novo (Oferta), disputa aberta (Trade); os avisos do
  `ConfirmActionDialog`, do cartão de assinatura e do chat perderam a borda.

#### Progresso linear (`ui/progress.tsx`)
- Trilho 4 px `border-subtle`, indicador azul da marca (3.95+ contra o trilho,
  4.74+ contra as superfícies). Determinado (`value`, `aria-valuenow`) só para
  progresso medido; indeterminado (sem `value`) para espera sem duração.
  Movimento só por transform; com movimento reduzido a barra fica parada.
  **Nunca** uma porcentagem inventada para espera do protocolo (CTO 437).

#### Divisória (`ui/divider.tsx`)
- 1 px `border-subtle`, horizontal, vertical ou recuada (`inset`); decorativa
  (`role=none`) ou `semantic` (`role=separator`). Usada no Menu e no Combobox.
  Nunca a borda de uma caixa.

#### Botão de ícone (`ui/icon-button.tsx`)
- **Regra:** `label` obrigatório = nome acessível **e** tooltip (hover e foco).
  `title=` em botão falha no guard.
- **Tamanhos:** `md` 36 (ícone 20), `sm` 32 (ícone 16), 44 no toque.
- **Variantes:** ghost (padrão), tonal; alternância `pressed` (`aria-pressed`,
  ligado = ícone azul); `loading` (spinner, `aria-busy`); indisponível com
  `aria-disabled` (mantém foco e dica).
- **Onde:** Favoritar, Avalizar (o motivo de indisponível agora é a dica, não
  um `title`), fechar/voltar dos filtros.

#### Chip de filtro (`ui/filter-chip.tsx`)
- Tonal, sem borda, `rounded-full`, 32 fino / 44 toque. Alternância (`onToggle`,
  `aria-pressed`): selecionado = `checked` a 12 % + check + texto `blue-fg`
  (5.21+ claro, 4.60+ escuro). Filtro aplicado (`onClear`): rótulo + botão
  próprio de remover (`clearLabel`, "Remover filtro PIX").
- **Onde:** Filtros avançados do Market (métodos selecionados = chips com
  remover; sugeridos, valores e ordenação = alternância). Era o badge laranja.

#### Combobox (`ui/combobox.tsx`)
- **Anatomia:** gatilho `.toolbar-chip` + seta, nome = rótulo + valor ("Ativo:
  Bitcoin"), `aria-haspopup=listbox`; lista no `floating`: linha de busca sem
  caixa própria (a borda do popup é a fronteira; Divider abaixo), opções 32 fino
  / 44 toque com visual à esquerda, detalhe e check azul à direita; selecionada
  = `bg-brand-selected`. Rodapé opcional ("Limpar seleção").
- **Teclado:** a busca (`role=combobox`, `aria-activedescendant`) mantém o foco;
  setas movem a opção ativa (camada 12 %), Enter escolhe, Esc fecha; seta no
  gatilho abre. Busca sem caixa e sem acento, também pelo código
  (`lib/combobox.ts`, testado). Única fecha ao escolher; `multiple` fica aberta
  (`aria-multiselectable`).
- **Grupos e desativados** (2026-11-20): opções com o mesmo `group` seguidas
  ficam sob um cabeçalho (`role=group`); `disabled` = visível, `aria-disabled`,
  texto secundário, sem camada, ignorada pelas setas e pelo clique. Usado no
  AssetPicker ("Em breve" = badge tonal sem borda + motivo em segunda linha).
- **Onde:** AssetPicker, CurrencyPicker (ganhou busca), PaymentMethodPicker.
  Mesmas opções, mesmos rótulos, mesmo "Todos". Valor ativo de filtro em azul
  (escolhido), não laranja.

#### Tokens novos

| Token | Claro | Escuro | Medido |
|---|---|---|---|
| `--color-selected` / `bg-brand-selected` | azul da marca a 12 % | idem | texto 15.40–16.73 / 10.91–14.43; secundário 6.08–6.60 / 5.36–7.09 |
| `--color-link` / `text-brand-link` | = `brand-blue-fg` #1D4ED8 | #60A5FA | 6.42 / 6.70 / 6.15 · 7.31 / 6.42 / 5.67 |
| `--segment-track-a` / `bg-brand-segment-track` | 0.18 | 0.08 | thumb vs trilho 1.50–1.62 / 1.51–1.54 |
| `--color-inverse-link` | #60A5FA | #1D4ED8 | 5.67 / 5.51 no inverso |
| `--color-inverse-{success,info,warning,danger}` | tons do escuro | tons do claro | 5.21–8.63 / 4.12–5.51 no inverso |

Seleção e link seguem o azul da marca (white-label pode trocá-lo, com o
contraste acima como piso); os `inverse-*` de status são travados como os
outros status.

### 5.4 Fase 4A (**provisório — ratificação pendente**, 2026-11-20)

#### Configurações
Seções (abas verticais md+, lista que abre a seção abaixo de md), em ordem de
uso: **Wallet**, **Aparência** (`SunMoon`), **Idioma** (`Languages`),
**Notificações** (`Bell`), **Segurança**, **Rede e nós** (`Network`, antes "Nó Sails"),
**Mercados** (antes Comunidades; o id `comunidades` continua, para `?section=` não quebrar: mercado que abre por padrão, convites recebidos, privacidade da participação "Em breve" e atalhos para Meus mercados e Entrar com convite), **Ajuda e Sobre**.
"Aplicativo" saiu: tema e estilo dos avatares foram para Aparência (com Avatar
público e Moeda de exibição, ainda "Em breve"); Idioma e Notificações viraram
seções. Nenhuma linha foi removida. Itens planejados vêm de `LOOSE_WIRES`
(`src/lib/looseWires.ts`, antes dentro de Settings.tsx), que também lista os
fios de outras telas (avaliações, data de cadastro pública, vários métodos de
pagamento).

#### Aparência (`lib/themePreference.ts`, `ThemeContext`)
Preferência `'system' | 'dark' | 'light'` em cartões de rádio (Padrão do
sistema / Escuro / Claro). `system` segue `prefers-color-scheme` ao vivo
(`matchMedia` + listener). Guardada em `sails_ui_theme` (mesma chave do antigo
toggle: o "dark"/"light" salvo continua valendo como escolha explícita);
leitura e escrita protegidas. Padrão continua **escuro** (dark-first) até o
Architect decidir. `useTheme()` agora dá `{ theme, preference, setPreference }`.

#### Idioma (`lib/locale.ts`)
`RadioGroup` com Padrão do sistema, Português (Brasil), English, Español,
Français, Deutsch (cada idioma no próprio nome, com `lang`). Guardado em
`sails_ui_locale`; a escolha vale na hora, sem recarregar, e "Padrão do
sistema" segue o navegador (ver 7.3).

#### Notificações
Sem sistema de notificações no SDK: três linhas "Em breve" (novos trades e
mudanças de estado, mensagens do chat, disputas e prazos). Nada de switch que
não faz nada.

#### PaymentMethods (`ui/PaymentMethods.tsx`, Layer A)
Recebe uma lista de rótulos. Mesmo visual do antigo `PaymentBadge` (texto
secundário após um traço da marca). Dois layouts:
- `stack` (tabela do Market, detalhe da oferta): um método por linha, o padrão
  de mercado P2P. Nomes longos quebram a linha em vez de serem cortados, e o
  "+N" segue o texto do último item.
- `inline` (cartão do Market no celular): uma linha só, um traço, nomes
  separados por vírgula e depois "+N". Quebra a linha se precisar, nunca corta.

Lista (Market): até `LIST_METHODS_MAX` = 3 métodos e depois "+N". Abaixo de
`sm`, até `LIST_METHODS_MAX_NARROW` = 2 e depois "+N". Detalhe da oferta:
todos. Máximo por oferta: `MAX_PAYMENT_METHODS` = 5 (`lib/paymentMethods.ts`;
vira regra de contrato na issue #735). O leitor de tela ouve a lista inteira uma
vez.

A UI lê os métodos só por `offerPaymentMethods(offer)`. Dado real = 1 método.
`demoPaymentMethods` existe apenas no modo demonstração (build de
desenvolvimento). Filtro = "qualquer um" dos métodos escolhidos
(`acceptsAnyMethod`).

Publicar:
- modo real: um método (Select);
- modo demonstração: multisseleção (Combobox `multiple`) com contador
  "N de 5", opções desabilitadas e aviso ao chegar a 5, e uma nota de
  demonstração permanente.

#### Item planejado (`ui/PlannedItem.tsx`, Layer A)
Rótulo + badge "Em breve" (o mesmo das linhas planejadas) + descrição + popover
de explicação opcional. Nunca valor, número ou ação. Usado para **Avaliações**
no Perfil e no bloco do anunciante da oferta (`RATINGS_EXPLANATION`: 1 a 5
estrelas, só informativas, nunca entram na reputação). Não aparece nas linhas
do Market. "Membro desde" no Perfil próprio = mês e ano (`formatMonthYear`,
"nov. de 2026"); a data pública do anunciante não existe no SDK (fio solto).

#### Resumo de avaliações (`lib/ratings.ts`, `ui/RatingSummaryLine.tsx`, item `rating` do `TrustLine`)
Nenhum endpoint lê as avaliações ainda (`LOOSE_WIRES.readRatings`), então todo
dado real dá `null` e nada muda na tela real. Só o modo demonstração (build de
desenvolvimento + `?demo=1`) preenche `demoRatings` / `demoMemberSince`, pelos
guards `demoRatingsOf` / `demoMemberSinceOf` de `lib/demoMarkers.ts`. A UI lê
só por `offerRatings(offer)` / `sellerRatings(seller)` / `sellerMemberSince(seller)`.
- **Compacta (linha do Market):** item `rating` do `TrustLine`, depois da
  reputação, estrela + "4,8 (126)". Nome acessível "Avaliação média 4,8 de 5,
  126 avaliações". Nunca "/5". Na tabela segue na mesma linha da reputação
  quando cabe e quebra para a linha de baixo quando não; no `OfferCard` fica
  sempre na linha de baixo. Sem dado: nada.
- **Completa (detalhe da oferta e Perfil):** `RatingSummaryLine` no lugar do
  `PlannedItem`, estrela + "4,8 · 126 avaliações" + "· desde jan. de 2025"
  (só no anunciante, só se houver data). Explicação `RATINGS_DEMO_EXPLANATION`
  (diz que os números são fictícios). Sem dado: o `PlannedItem` "Em breve".
- **Cor:** estrela preenchida em `brand-checked` (o mesmo azul do
  `StarRating`), nunca amarelo; texto no tom da linha.
- A explicação da reputação diz que as estrelas são avaliações entre pessoas,
  só informativas, e nunca mudam a reputação.

#### Avaliação da contraparte (`ui/star-rating.tsx`, `trade/RateCounterpartyCard.tsx`)
- **Quando:** trade `COMPLETED`, só para as duas partes; "Avaliar <nome>".
- **Estrelas:** `StarRating` sobre o `RadioGroup` (rádios nativos escondidos,
  um rótulo por estrela "3 estrelas"; setas mudam a nota); 40 px fino / 44 toque;
  escolhidas na cor de marcado (azul), nunca laranja; foco = outline no próprio
  rótulo; o texto "3 de 5" é anunciado (polite).
- **Comentário** opcional (vazio não é enviado), até `MAX_RATING_COMMENT` = 280
  caracteres (Complemento 051-A). Contador "N/280" sob o campo, à direita, em
  `tabular-nums`; anunciado (`aria-live="polite"`) só a partir de 260. Sem
  `maxLength` nativo, que cortaria uma colagem em silêncio: passou do limite, o
  texto fica inteiro, o campo fica `aria-invalid`, o contador vira `danger-fg`
  e aparece a mensagem "Passou N caracteres do limite de 280…"; o envio é
  recusado com foco no campo. Enviar com `loading`. Sem nota = erro no campo.
- **Resultado:** sucesso = toast + uma linha "Você avaliou este trade" no lugar
  do formulário; o 400 "already rated" do nó Sails = "Você já avaliou este
  trade"; outro erro = mensagem sob o formulário. `sessionStorage`
  (`sails_ui_rated:<tradeId>`) lembra só nesta aba, por conveniência.
- **Texto:** a avaliação é informativa e não muda a reputação (RFC-007).

### 5.5 Trilho do trade (`trade/TradeRail.tsx`, 2026-11-20, DECISIONS.md "O avanço do trade tem cor")

Um tom por etapa, de `stageTone(step, viewer)` (`lib/tradeState.ts`, testado em
`tests/tradeRail.test.ts`). A mesma regra do "Sua vez" do bastão: o anel e o
marcador nunca discordam. Sem token novo.

| Tom | Quando | Círculo | Linha até a próxima | Sinal que não é cor |
|---|---|---|---|---|
| `done` | etapa registrada | preenchido `brand-blue`, check `brand-surface` | 2 px `brand-blue` | ícone de check, "concluída" (leitor) |
| `yours` | etapa atual e o viewer pode agir aqui | anel `orange-accent` + pulso | 1 px `border` | número, pílula "Sua vez" (`bg-primary`) |
| `waiting` | etapa atual esperando outra pessoa (ou viewer observador) | anel `brand-blue`, número `blue-fg` | 1 px `border` | número, bastão "Vez de …" (chip azul) |
| `attention` | `blocked`, disputa ou prazo encerrado | anel `warning`, número `warning-fg` | — (o trilho para ali) | número, bastão neutro ou âmbar, status |
| `upcoming` | ainda não | contorno `border` | 1 px `border` | número, texto secundário |

- **Nunca verde:** concluído é o estado do registro, não finalidade de
  liquidação (CTO 437). `COMPLETED` = todas as etapas `done`, trilho todo azul,
  sem comemoração. Era cinza (`text-secondary`).
- **Disputa e prazo encerrado** pintam a etapa em âmbar no trilho; o chip de
  status continua com o tom dele (§2: disputa = perigo).
- **Pulso:** `motion-safe:animate-rail-pulse` (`@keyframes sails-rail-pulse`,
  só `transform`/`opacity`): um anel que cresce e some, 2 vezes de 2 s quando a
  etapa aparece, e para (menos de 5 s: WCAG 2.2.2 sem botão de pausa). Sem pulso
  com `prefers-reduced-motion` (fica o anel parado). Só na etapa `yours`.
- **Bastão:** laranja cheio só no "Sua vez" (também numa etapa em disputa, como
  a rodada da decisão que o viewer assina: o anel fica âmbar); a vez de outra
  parte numa etapa normal = chip azul da marca (era laranja); numa etapa em
  disputa ou com prazo encerrado = chip âmbar; espera indisponível = neutro.
- **Trilho compacto (< 1024):** mesmo código em pontos: `done` ponto azul
  cheio 8 px; atual = anel 10 px na cor do tom; futuro = contorno neutro.
- **Cartão da etapa atual** (`CurrentActionCard`): faixa de 4 px no topo pelo
  `tone`: `action` laranja, `waiting` azul (era neutra), `attention` âmbar,
  `terminal` neutra.

Contraste medido (anel/preenchimento ≥ 3:1, WCAG 1.4.11; texto ≥ 4.5:1),
superfície / elevado:

| | Claro | Escuro |
|---|---|---|
| `brand-blue` (preenchimento, anel, linha, faixa) | 5.17 / 4.74 | 6.42 / 5.67 |
| `orange-accent` (anel, número) / `orange` (faixa) | 5.18 / 4.75 | 5.82 / 5.14 |
| `warning` (anel, faixa) | 5.02 / 4.61 | 9.78 / 8.63 |
| `border` (contorno futuro) | 3.59 / 3.30 | 3.43 / 3.03 |
| check `brand-surface` sobre `brand-blue` | 5.17 | 6.42 |
| número `blue-fg` / `warning-fg` | 6.70 / 7.09 | 6.42 / 9.78 |
| "Sua vez" `primary-foreground` sobre `primary` | 5.22 | 6.63 |
| chip azul: `blue-fg` sobre tint | 5.82 | 5.45 |

Azul e laranja têm a mesma luminância (1.00 / 1.10 entre si): a diferença
entre `waiting` e `yours` é o matiz mais o pulso e a pílula "Sua vez", nunca
só a cor. Specimen em `/dev/design-system` → "Trilho do trade".

### 5.6 Prazo do escrow (`trade/EscrowCountdown.tsx`, UX-029, 2026-11-20, DECISIONS.md "Temporizador no fluxo do trade")

Contagem regressiva no cartão da etapa atual, **só** de `escrow.expiresAt` (valor
do nó Sails, `lockedAt + timelockHours`). Janela de pagamento, cancelamento
automático e prazos de liberação/apelação não existem no contrato (UX-012, issue
#740) e não aparecem. Regras puras em `lib/escrowDeadline.ts`, testadas em
`tests/escrowDeadline.test.ts`. Sem token novo.

| Estado | Quando | Visual |
|---|---|---|
| normal | falta ≥ 1 h e ≥ 10 % do total | relógio, rótulo `text-secondary`, número `.money-lg` `text` |
| atenção | falta < 1 h **ou** < 10 % do total (estritos: 1 h e 10 % exatos ainda são normais) | ícone de alerta (sinal que não é cor), rótulo e número `warning-fg` |
| encerrado | `expiresAt` já passou e o status ainda é ativo | "Encerrado" (nunca número negativo), "em dd/MM, HH:mm", sem barra |
| antes do bloqueio | `CREATED` sem `expiresAt` | "72 h a partir do bloqueio dos fundos", sem barra |
| indisponível | `expiresAt` ausente ou inválido fora de `CREATED` | "Prazo do escrow indisponível" |

- **Formato:** "39 h 05 min" a partir de 1 h; "12 min 05 s" / "42 s" abaixo de 1 h
  (segundos só abaixo de 1 h); espaço inseparável entre número e unidade;
  `tabular-nums`. Ao lado, o prazo absoluto local: "até 22/11, 14:30" (`formatDateTime`).
- **Barra:** `Progress` determinado com o tempo **decorrido** sobre o total
  (`timelockHours`). Sem total, sem barra: nunca uma porcentagem inventada.
- **Onde:** `CREATED`, `FUNDS_LOCKED`, `PAYMENT_PENDING` e `DISPUTED` (no painel
  da disputa, como já era). Nunca em `COMPLETED`, `REFUNDED`, `SPLIT` nem
  `EXPIRED` (o cartão da etapa e a faixa âmbar já dizem "Prazo do escrow encerrado").
- **Explicação** (`ExplanationPopover`), tirada do backend (`sweepExpiredEscrows`,
  `VALID_TRANSITIONS`): só `FUNDS_LOCKED` expira por este prazo; em
  `PAYMENT_PENDING` e em disputa o nó Sails não encerra o escrow por ele. Nada de
  "caminho de reembolso on-chain" (não há timelock no script MULTISIG do código).
- **Ritmo:** atualiza a cada 1 s abaixo de 1 h, a cada 30 s acima; para com a aba
  escondida (`visibilitychange`) e ressincroniza ao voltar; para no encerramento.
- **Leitor de tela:** o número que muda é `aria-hidden`, com uma cópia `sr-only`
  silenciosa. Um `role="status"` `aria-live="polite"` fala só nos marcos, quando
  são cruzados com a página aberta (nunca ao carregar): entrar em atenção, 10 min,
  1 min e encerramento. Nada por segundo.
- **Movimento:** nada pisca; a barra anda só por `transform` e fica parada com
  movimento reduzido (regra global).
- **Demonstração:** os trades perto do fim são semeados só por script
  (`sessionStorage`, como os demais scripts do trade); os dados da demo e os
  reais não mudam.

Contraste: `warning-fg` 7.09 (claro) / 9.78 (escuro), o mesmo do número do trilho (5.5); barra
como em 5.3. Specimen em `/dev/design-system` → "Prazo do escrow" (normal,
atenção, encerrado, sem total; claro e escuro).

## 6. Guarda e exceções

`tests/designSystemGuard.test.ts` varre `src/**/*.ts(x)` e falha em:
- classes da paleta crua do Tailwind (red, green, emerald, amber, yellow, blue,
  sky, orange, rose, lime, teal, violet, purple, slate, gray, zinc, neutral,
  stone, indigo, cyan, pink, fuchsia), com ou sem `/opacidade` e variantes;
- cores cruas (hex/rgb/hsl) em nomes de classe ou literais de string (style props);
  `rgb(var(--token))` é permitido;
- tamanhos de fonte arbitrários (`text-[13px]`, `text-[0.8rem]`);
- o foco antigo `ring-offset-background` / `ring-offset-N` (também em `index.css`);
- `Input`/`Textarea`/`Select` sem `field-focus` ou com `focus:`/`focus-visible:` `outline-*`/`ring-*`;
- tamanhos fora da escala `text-base/lg/xl/2xl…` (use `text-heading`, `text-headline`, `text-field`, `.money-lg`…);
- sombras cruas `shadow-sm/md/lg/xl/2xl/inner` (use `shadow-elevation-1/2/3`);
- scrims crus `bg-black/NN`, `bg-white/NN` (use `bg-scrim`);
- raios `rounded-2xl/3xl`;
- `duration-NNN` e `ease-in/out/in-out/linear` crus (use os tokens de movimento);
- (fase 3) `role="menu"`/`menuitem` fora de `ui/menu.tsx`; `role="tablist"`/`tab`/`tabpanel`
  fora de `ui/tabs.tsx`; `type="radio"`/`role="radio(group)"` fora de
  `ui/radio-group.tsx`; `role="listbox"`/`combobox`/`option` fora de
  `ui/combobox.tsx`; `role="progressbar"` fora de `ui/progress.tsx`; import de
  `sonner` fora de `ui/toast.tsx`; `title=` em `<button>`/`<Button>` (use `IconButton`);
- (fase 4A) tokens `brand-buy*`/`brand-sell*` fora das suas casas (`ui/button.tsx`,
  `ui/StatusBadges.tsx`, `lib/tone.ts`, a página dev) e variante/tom `buy`/`sell`
  (`-tonal`) ou `TONE_CLASS.buy/sell` numa linha que não escolhe a partir de um lado
  do trade (`side`): verde e vermelho de lado nunca viram status.

Exceção: comentário `ds-allow: <motivo>` na própria linha (`// ds-allow: ...`
ou `{/* ds-allow: ... */}`). O teste limita o total a 2; aumentar exige
revisão do Architect. Hoje: **0 exceções**. Arquivo isento só da regra de
hex: `src/lib/identityAvatar.ts` (paleta da arte SVG gerada dos avatares,
desenhada dentro de uma string SVG, nunca usada como classe ou style).

Para pedir um token novo: propor papel, valores claro/escuro e contraste
medido (`/dev/design-system` ou o script de contraste) ao Architect.

## 7. Conteúdo

### 7.1 Números, dinheiro e datas (**provisório — ratificação pendente**)

Um módulo (`src/lib/format.ts`, `formatPrice`/`formatByCurrency` em
`lib/currency.ts`) e uma política: **todo número no idioma da interface** (em pt-BR, milhar "." e
decimal ","), qualquer que seja a moeda, para uma linha nunca misturar "0.001
BTC" com "R$ 1.234,56".

| Tipo | Formato | Exemplo |
|---|---|---|
| BRL | moeda pt-BR | R$ 1.234,56 |
| USD | moeda USD em pt-BR | US$ 97.450,00 (preço por unidade sem arredondar: US$ 1,002) |
| Cripto | pt-BR, zeros à direita cortados, até 8 casas, unidade depois | 0,0015 BTC |
| Faixa | travessão com espaços | 10 – 500 USDT |
| Data este ano | dd/MM, HH:mm | 20/11, 14:32 |
| Data outro ano | dd/MM/aaaa, HH:mm | 03/09/2025, 09:05 |

Campos numéricos seguem aceitando o valor do navegador (`type="number"`), que
normaliza para ponto; só a exibição muda.

### 7.2 Voz

Você; frases em caixa normal; botões começam pelo verbo; sem exclamação, sem
emoji; rótulo de fechar em pt-BR ("Fechar").

**Termos (fase 4A):** o serviço com que o app fala é o **nó Sails** ("Nó Sails"
no início de frase ou como título), nunca "servidor": "Depósito registrado pelo
nó Sails", "Transação de pagamento registrada pelo nó Sails", "O nó Sails pode
recusar a apelação". O sentido não muda (é quem registra e responde); nomes de
código (`server-custodial-…`, `sailsClient`) ficam como estão.

### 7.3 Idiomas e catálogo de textos (`src/i18n/`, UX-028, 2026-11-21)

**Arquitetura.** Sem dependência nova. `src/i18n/areas/<área>.ts` guarda, por
área, o catálogo-fonte em pt-BR e as traduções en, es, fr e de
(`defineArea`): falta ou sobra de chave é erro de TypeScript. As chaves começam
pelo nome da área (`trade.*`, `market.*`). `t('chave', { nome, count })`
interpola `{nome}`, formata números no idioma e escolhe o plural por
`Intl.PluralRules` (`{ one, other }`). `useT()` faz o componente reagir; a troca
de idioma remonta a árvore de rotas (`App.tsx`, `Localized`), então os textos
calculados em `lib/` também mudam na hora, sem recarregar. `<html lang>`
acompanha; `dir` fica `ltr`.

**Idioma resolvido** (`lib/locale.ts`): a escolha em Configurações → Idioma
(`sails_ui_locale`); "Padrão do sistema" casa `navigator.languages` com os
cinco catálogos pela língua (pt-PT → pt-BR, de-AT → de); sem casamento, pt-BR.

**Layer A não importa o dicionário.** Os primitivos de `components/ui/`
recebem texto por props ou pelo `UiStringsProvider` (`ui/uiStrings.tsx`), que a
Sails Market preenche em `i18n/uiStrings.ts` e um parceiro white-label preenche
com o próprio catálogo. Exceção documentada: `StatusBadges`, `VouchButton` e
`AssetIcon` já são componentes do app dentro de `ui/` (importam `lib/` ou o
cliente) e podem usar `t()`.

**Formatação** (`lib/format.ts`, `lib/currency.ts`): números, moedas e datas no
idioma da interface. USD continua a única unidade de preço: pt-BR
"US$ 97.800,00" (formato do dólar em pt ainda pendente do PO), en
"$97,800.00", es "97.800,00 US$", fr "97 800,00 $US", de "97.800,00 $".
Nomes de moeda e de país vêm do `Intl.DisplayNames` fora do pt-BR.

**Fica em pt-BR:** as páginas `/dev/*`, os dados fictícios da demonstração
(nomes, mensagens de chat, descrições de oferta, erros simulados do nó em
`demo/demoBackend.ts`: são dados, como o texto que uma pessoa escreve) e as
mensagens de erro que o nó Sails devolve.

**Glossário obrigatório** (o guard de verdade confere):

| pt-BR | en | es | fr | de |
|---|---|---|---|---|
| nó Sails | Sails node | nodo Sails | nœud Sails | Sails-Knoten |
| Mercado aberto | Open market | Mercado abierto | Marché ouvert | Offener Markt |
| mercado privado | private market | mercado privado | marché privé | privater Markt |
| pagamento marcado como enviado | payment marked as sent | pago marcado como enviado | paiement marqué comme envoyé | Zahlung als gesendet markiert |
| Escrow marcado como concluído | Escrow marked as completed | Escrow marcado como completado | Escrow marqué comme terminé | Escrow als abgeschlossen markiert |
| Reputação N | Reputation N | Reputación N | Réputation N | Reputation N |
| avaliações | ratings | valoraciones | évaluations | Bewertungen |
| disputa | dispute | disputa | litige | Streitfall |
| árbitro | arbitrator | árbitro | arbitre | Schiedsperson |
| Em breve | Coming soon | Próximamente | Bientôt | Demnächst |
| Comprar / Vender | Buy / Sell | Comprar / Vender | Acheter / Vendre | Kaufen / Verkaufen |
| Configurações | Settings | Ajustes | Paramètres | Einstellungen |
| oferta | offer | oferta | offre | Angebot |

Nomes que não se traduzem: Sails, Sails Market, Rede Sails, Sails Agent,
Sails Node ID, Sails Market ID, Sails Market Invite, Market e Trades (itens do
menu), escrow, wallet, tickers e redes. Tratamento: en "you"; es "tú"; fr
"vous"; de "du" (provisório, para o Architect). Frases em caixa normal em
todos os idiomas (o alemão mantém a maiúscula dos substantivos).

**Revisão nativa obrigatória antes de publicar.** As chaves das áreas
dinheiro (`money`), disputa (`dispute`), prazo e temporizador do escrow
(`deadline`), explicação da reputação (`reputation`), custódia (`custody`) e
diálogos de confirmação (`confirmation`) ficam listadas em `review` no arquivo
da área e somadas em `NEEDS_NATIVE_REVIEW` (`i18n/catalog.ts`;
`tests/i18n.test.ts` imprime a lista). **Esses textos não vão para produção em
en, es, fr ou de antes da revisão de um falante nativo** (DECISIONS.md: "textos
de dinheiro e de disputa sem revisão nativa ficam fora da publicação"). Quando
um falante revisar, a chave sai da lista no mesmo commit, com o nome de quem
revisou na mensagem.

**Textos longos.** O alemão e o francês são até 35 % mais longos: rótulos
quebram linha em vez de cortar, botões têm `min-w-0` e o texto pode quebrar;
nada de largura fixa em rótulo. A auditoria de overflow roda nos cinco idiomas.

## 8. Checklist para agentes e builders

- [ ] Reusei um componente existente antes de criar um novo.
- [ ] Menu, abas, rádio, tabela, aviso, combobox, chip, toast e botão de ícone vêm dos primitivos (5.3); nada de `title=` em botão.
- [ ] Só tokens: nenhuma cor de paleta, hex ou tamanho arbitrário (o guard passa sem `ds-allow`).
- [ ] Cor com um significado: marca ≠ lado ≠ status; disputa = danger.
- [ ] AA nos dois temas (texto 4.5:1, UI e texto grande 3:1).
- [ ] Borda só onde carrega significado; nenhuma caixa com borda dentro de container com borda.
- [ ] Foco: nada de `ring-offset`/`outline-none` sem substituto; campos usam `field-focus`.
- [ ] Alvos de 44px no toque e no móvel (`touch:`); 36/40 com ponteiro fino.
- [ ] Hover/pressionado com `state-layer`; carregando com `loading`, não `disabled`.
- [ ] Lado = texto + seta; status = pílula + ícone; marcado = azul.
- [ ] Botão de lado só para "Comprar"/"Vender" (`buy`/`sell` no ticket, `-tonal` na linha), escolhido a partir do `side`.
- [ ] Recurso futuro = "Em breve" ligado a `LOOSE_WIRES` (`PlannedItem` ou linha planejada), sem número inventado.
- [ ] Números pelo `lib/format.ts` (no idioma da interface).
- [ ] Todo texto visível, `aria-label` e `sr-only` vem de `t()` (7.3); chave nova nas cinco línguas, e as de dinheiro, disputa, prazo, reputação, custódia e confirmação na lista `review`.
- [ ] Estados loading, empty e error completos (`StateBlock`).
- [ ] Ação irreversível passa por `ConfirmActionDialog`.
- [ ] Nenhum estado, garantia, prazo ou custódia de protocolo inventado (CTO 437).
