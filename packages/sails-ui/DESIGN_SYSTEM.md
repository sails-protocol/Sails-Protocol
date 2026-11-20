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
- **Um botão sólido laranja por tela** (a ação primária).
- **Azul da marca ≠ info.** Tokens diferentes mesmo quando o valor coincide (escuro: ambos #60A5FA no texto). O azul da marca é para links, seleção, gráficos e destaques; info é status.
- A cor nunca é o único sinal: todo status tem rótulo (e, nas badges, ícone).
- **Lado e status têm formas diferentes** (**provisório — ratificação pendente**). Na tela, compra ≈ sucesso
  (mesmo matiz 158° no escuro) e venda ≈ perigo; para quem não distingue
  vermelho/verde eles colapsam. Então: **lado = texto colorido + seta**
  (`SideBadge`: `ArrowDownLeft` Comprar, o ativo entra; `ArrowUpRight` Vender, o
  ativo sai; sem pílula); **status = pílula com tint + ícone + rótulo**
  (`TONE_CLASS`). Nunca só cor. Botão sólido buy/sell só na ação única do ticket.
- **Marcado ≠ ação.** Checkbox e switch ligados usam `--color-checked` (azul da
  marca), nunca laranja: laranja = agir, azul = escolhido. Navegação ativa
  (sidebar, bottom nav, abas) segue laranja ("você está aqui").
- **Tons de escrow** (**provisório — ratificação pendente**): `COMPLETED` = neutro (CTO 437: escrow
  concluído ≠ finalidade de liquidação; igual ao chip de `tradeState`),
  `EXPIRED` = atenção, `SPLIT` = neutro. Neutro usa borda sutil, como os outros tons.

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
| Compra | #4CC79A | 6.82 | 5.63 | 6.82 | #0D8259 / branco | 4.82 |
| Venda | #FB7185 | 5.35 | 4.64 | 5.35 | #B9384E / branco | 5.62 |
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
| 2 inverso | `inverse` (novo) | `elevation-2` | — | tooltip (toast na fase 3) |
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
| `Button` (`ui/button.tsx`) | `default` = ação primária (uma por tela); `secondary` (tonal; `outline` é alias) para ações de apoio; `ghost` para baixa ênfase; `destructive` só para ação destrutiva; carregando = prop `loading` (ver 5.2), indisponível = `disabled` | dois sólidos laranja lado a lado; cor manual em botão; contorno cinza em botão; `disabled` para "carregando" |
| `Input` | rótulo visível; erro = `aria-invalid` (a borda fica danger via `field-focus`) + mensagem `text-brand-danger-fg` ligada por `aria-describedby` | placeholder no lugar de rótulo; outline em volta de campo |
| Badges (`StatusBadges.tsx`) | `SideBadge` (lado: texto + seta), `TradeStatusBadge`, `EscrowStatusBadge`, `OfferStatusBadge` (status: pílula + ícone + rótulo); rótulos longos quebram linha, nunca transbordam | cor solta por tela; status só por cor; lado em pílula |
| `TONE_CLASS` (`lib/tone.ts`) | chips e avisos de status | reutilizar buy/sell como status |
| `StateBlock` | loading / empty / error / signedOut em toda superfície de conteúdo | spinner solto, tela vazia sem saída |
| `ConfirmActionDialog` | toda ação irreversível: resumo, consequência, avisos; foco inicial em Cancelar | confirmar com Enter por acidente |
| `SegmentedControl`, `.toolbar-chip`, `Select`, `Popover`, `Sheet`, `Dialog`, `Tooltip`, `Checkbox`, `Switch` | seletores, menus, filtros, modais; tooltip inverso; marcado em azul | criar variantes paralelas |
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
| `secondary` (= `outline`, alias mantido) | **tonal**: preenchido um passo acima da superfície onde está (`bg-brand-tonal`, cor do texto a 8% no escuro / 7% no claro), sem contorno, texto principal | ações de apoio: Voltar, Tentar de novo, Limpar, Comprar/Vender na linha do Market |
| `ghost` | sem preenchimento até o hover | baixa ênfase: ações de toolbar, "Detalhes" |
| `destructive` | sólido danger | ação destrutiva (sempre via `ConfirmActionDialog`) |
| `link` | texto `orange-accent` (AA no claro) sublinhado no hover | navegação dentro do texto |

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
| Claro | 1.16–1.26 | 19.80 | 6.20–6.73 | 2.53 |

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
| foco | `--state-focus-a` 0.12 | só dentro de widgets compostos sem outline (itens de listbox: `focus:bg-brand-tonal`) |
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
- `duration-NNN` e `ease-in/out/in-out/linear` crus (use os tokens de movimento).

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
`lib/currency.ts`) e uma política: **todo número em pt-BR** (milhar ".",
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

## 8. Checklist para agentes e builders

- [ ] Reusei um componente existente antes de criar um novo.
- [ ] Só tokens: nenhuma cor de paleta, hex ou tamanho arbitrário (o guard passa sem `ds-allow`).
- [ ] Cor com um significado: marca ≠ lado ≠ status; disputa = danger.
- [ ] AA nos dois temas (texto 4.5:1, UI e texto grande 3:1).
- [ ] Borda só onde carrega significado; nenhuma caixa com borda dentro de container com borda.
- [ ] Foco: nada de `ring-offset`/`outline-none` sem substituto; campos usam `field-focus`.
- [ ] Alvos de 44px no toque e no móvel (`touch:`); 36/40 com ponteiro fino.
- [ ] Hover/pressionado com `state-layer`; carregando com `loading`, não `disabled`.
- [ ] Lado = texto + seta; status = pílula + ícone; marcado = azul.
- [ ] Números pelo `lib/format.ts` (pt-BR).
- [ ] Estados loading, empty e error completos (`StateBlock`).
- [ ] Ação irreversível passa por `ConfirmActionDialog`.
- [ ] Nenhum estado, garantia, prazo ou custódia de protocolo inventado (CTO 437).
