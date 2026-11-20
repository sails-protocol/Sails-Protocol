# Sails Design System

> **Status:** Proposta — aguardando homologação do Design System Architect; DESIGN.md e SAILS_DESIGN_LANGUAGE.md serão reconciliados após a homologação.

Fonte única de cores, tipografia e tamanhos da Sails UI. Os tokens vivem em
`src/index.css` (variáveis CSS, tema claro em `:root`, escuro em `:root.dark`)
e em `tailwind.config.js` (utilitários). A página viva `/dev/design-system`
(apenas em desenvolvimento) mostra cada token com o contraste medido nos dois
temas. O teste `tests/designSystemGuard.test.ts` impede que valores fora dos
tokens voltem ao código.

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
| Laranja | #C2410C | 4.75 | **4.13** | 4.75 | #C2410C / branco | 5.18 |
| Azul da marca | #1D4ED8 (base #2563EB) | 6.15 | 5.36 | 4.74 | #2563EB / branco | 5.17 |
| Compra | #0A6B49 (base #0D8259) | 6.00 | 5.29 | 4.42 | #0D8259 / branco | 4.82 |
| Venda | #A3324A (base #B9384E) | 6.19 | 5.36 | 5.15 | #B9384E / branco | 5.62 |
| Sucesso | #166534 (base #15803D) | 6.54 | 5.74 | 4.60 | #15803D / branco | 5.02 |
| Atenção | #92400E (base #B45309) | 6.50 | 5.71 | 4.61 | #B45309 / branco | 5.02 |
| Perigo | #B91C1C | 5.93 | 5.02 | 5.93 | #B91C1C / branco | 6.47 |
| Info | #1D4ED8 | 6.15 | 5.27 | 6.15 | #1D4ED8 / branco | 6.70 |
| Neutro | #525252 | 7.17 | 7.17 (elevado) | 3.30 (#878787) | — | — |

Laranja claro sobre tint laranja (4.13) **não é combinação aprovada** (hoje não
há uso). Bordas de chip (base/25) medem 1.2–1.8:1 e são decorativas: o rótulo
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
| `.money` / `tabular-nums` | numérico | 15 (hero 26 / 28) | 1.3 | 600 | 0 | `--t-money*` |
| `.mono-id` | mono, só IDs | 14 | 1.5 | 400 | 0 | `--t-mono` |

Nomes antigos continuam válidos: `text-sm`, `text-xs`, `.text-page-title`,
`.text-section-title`, `.text-label`, `.text-metadata`, `.money`, `.money-hero`,
`.mono-id`. Novos nomes de tamanho precisam constar em `src/lib/utils.ts`
(configuração do twMerge), senão `cn()` os confunde com cor e os descarta.
Nada abaixo de 12px; nada de `text-[13px]`.

## 4. Tamanhos

| Grupo | Tokens |
|---|---|
| Espaçamento | escala de 4px do Tailwind; passos preferidos 1, 2, 3, 4, 6, 8 (4–32px) |
| Raios | `rounded-sm` 4, `rounded-md` 6 (controles), `rounded-lg` 8 (cards, diálogos), `rounded-full` (chips, avatares) |
| Controles | `h-control-sm` 36 (compacto desktop), `h-control` 40 (padrão desktop), `h-control-touch` 44 (móvel). Equivalem a `h-9`/`h-10`/`h-11`, que seguem válidos |
| Ícones | `size-icon-sm` 16, `size-icon` 20, `size-icon-lg` 24 |
| Avatares | `UserAvatar` sm 28, md 36, lg 48, xl 64 |
| Elevação | tonal primeiro (bg → surface → elevated); `shadow-elevation-1/2/3` só para camadas flutuantes |

## 5. Componentes (reusar antes de criar)

| Componente | Faça | Não faça |
|---|---|---|
| `Button` (`ui/button.tsx`) | `default` = ação primária (uma por tela); `outline`/`secondary`/`ghost` para o resto; `destructive` só para ação destrutiva; carregando = `disabled` + `aria-busy` + spinner `motion-safe` | dois sólidos laranja lado a lado; cor manual em botão |
| `Input` | rótulo visível; erro = `aria-invalid` + `border-brand-danger` + mensagem `text-brand-danger-fg` ligada por `aria-describedby` | placeholder no lugar de rótulo |
| Badges (`StatusBadges.tsx`) | `SideBadge` (buy/sell), `TradeStatusBadge`, `EscrowStatusBadge`, `OfferStatusBadge`: tom + rótulo + ícone | cor solta por tela; status só por cor |
| `TONE_CLASS` (`lib/tone.ts`) | chips e avisos de status | reutilizar buy/sell como status |
| `StateBlock` | loading / empty / error / signedOut em toda superfície de conteúdo | spinner solto, tela vazia sem saída |
| `ConfirmActionDialog` | toda ação irreversível: resumo, consequência, avisos; foco inicial em Cancelar | confirmar com Enter por acidente |
| `SegmentedControl`, `.toolbar-chip`, `Select`, `Popover`, `Sheet`, `Dialog` | seletores, menus, filtros, modais | criar variantes paralelas |
| Foco | `focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-background` | remover outline sem substituto |

## 6. Guarda e exceções

`tests/designSystemGuard.test.ts` varre `src/**/*.ts(x)` e falha em:
- classes da paleta crua do Tailwind (red, green, emerald, amber, yellow, blue,
  sky, orange, rose, lime, teal, violet, purple, slate, gray, zinc, neutral,
  stone, indigo, cyan, pink, fuchsia), com ou sem `/opacidade` e variantes;
- cores cruas (hex/rgb/hsl) em nomes de classe ou literais de string (style props);
  `rgb(var(--token))` é permitido;
- tamanhos de fonte arbitrários (`text-[13px]`, `text-[0.8rem]`).

Exceção: comentário `ds-allow: <motivo>` na própria linha (`// ds-allow: ...`
ou `{/* ds-allow: ... */}`). O teste limita o total a 2; aumentar exige
revisão do Architect. Hoje: **0 exceções**. Arquivo isento só da regra de
hex: `src/lib/identityAvatar.ts` (paleta da arte SVG gerada dos avatares,
desenhada dentro de uma string SVG, nunca usada como classe ou style).

Para pedir um token novo: propor papel, valores claro/escuro e contraste
medido (`/dev/design-system` ou o script de contraste) ao Architect.

## 7. Checklist para agentes e builders

- [ ] Reusei um componente existente antes de criar um novo.
- [ ] Só tokens: nenhuma cor de paleta, hex ou tamanho arbitrário (o guard passa sem `ds-allow`).
- [ ] Cor com um significado: marca ≠ lado ≠ status; disputa = danger.
- [ ] AA nos dois temas (texto 4.5:1, UI e texto grande 3:1).
- [ ] Alvos de 44px no móvel; 36/40 no desktop.
- [ ] Estados loading, empty e error completos (`StateBlock`).
- [ ] Ação irreversível passa por `ConfirmActionDialog`.
- [ ] Nenhum estado, garantia, prazo ou custódia de protocolo inventado (CTO 437).
