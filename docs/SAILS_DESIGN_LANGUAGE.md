# Sails Design Language — Foundation (2026-09-12)

> **Corrected/Implemented 2026-11-27 (delimitation):** this is a dated foundation record. A design system being used in code does not mean its visual direction or its token set has been approved or homologated: the companion `SAILS_MARKET_DESIGN_DIRECTION.md` records the visual direction as open pending a decision, and no later approval is recorded in this document.

`DESIGN-LANGUAGE-1`. Institutionalizes the first version of a **reusable
visual/interaction language** shared across every first-party and
opted-in third-party Sails surface. Complementary to, not a replacement
for, `docs/SAILS_MARKET_DESIGN_DIRECTION.md`:

- **`SAILS_MARKET_DESIGN_DIRECTION.md`** — the specific visual direction
  of the **Sails Market** commercial product (its shell decision, its
  copy tone, its default entry point, its own screen-by-screen review).
- **`SAILS_DESIGN_LANGUAGE.md` (this document)** — the visual/
  interaction language reusable **between** Sails Market, Reusable
  Reference Components, the White-label P2P Base, Satsails Wallet where
  appropriate, future first-party Sails apps, and third-party
  compositions that opt into the system. Where the two overlap (e.g.
  §17/§19/§22/§24 of the Market doc), this document is the promoted,
  cross-product version of that material; the Market doc keeps the
  product-specific instantiation and now cross-links back here.

**Design Language ≠ Protocol Semantics.** Nothing in this document
changes `Asset`, `SettlementRail`, `SettlementScope`, `EscrowType`,
Provider Identity, capability maturity, SDK boundaries, or any other
protocol/architecture truth (`docs/PROJECT_CONTEXT.md`, ADR-002). This
is a visual-and-interaction contract layered *on top of* those, never a
redefinition of them.

## 0. North star

Applies the same discipline this repo's architecture already uses, one
layer up:

- **PRODUCT → ARCHITECTURE → IMPLEMENTATION → EVIDENCE.**
- **Stable semantics, replaceable edges** (`docs/PRINCIPLES.md`) — now
  extended explicitly to the visual layer: **brands may vary,
  interaction semantics must not.** A theme can change what a warning
  looks like; it cannot change what counts as a warning, or make a
  warning read as calmer than a success state.
- **Simple, not simplified** — a design language reduces inconsistency,
  it does not reduce expressiveness or force every product into one
  visual skin.
- **Interfaces may multiply; protocol semantics must not** — now:
  **brand customization must not alter economic meaning.** The UI may
  change brand, theme, and visual composition. Risk, authority,
  economic state, and action semantics may never change silently with
  branding.
- **Technical sophistication should reduce user complexity, not expose
  it** (`UI-POLISH-2`) — a powerful protocol should feel *simpler* than
  the complexity it actually coordinates, not more intimidating for
  reflecting it faithfully.
- **Responsive adaptation may change layout, density, and presentation
  — it must preserve meaning, priority, actionability, and state
  visibility.** Critical product information must never depend on a
  desktop-only spatial affordance (hover, a wide fixed column, a side-
  by-side layout with no narrow-width equivalent) to remain reachable
  or legible. Information may reflow across breakpoints; it must not
  *fracture* semantically — see §19 (Cross-Platform Information
  Integrity) for the concrete audit method and rules this implies.

## 1. Base visual identity — Sails brand

The Sails Market identity (`packages/sails-ui/src/index.css`) is built
from four families: **black / charcoal / dark gray** (surfaces),
**neutral gray** (text, borders, muted content), and **Sails orange**
(`--color-orange` / `--color-orange-accent`, currently `#c2410c` light /
`#f97316` dark-as-accent — both independently WCAG-AA-verified against
their own surfaces). Orange is the **single primary brand/action
accent** — it marks "this is the one thing to notice or act on," not a
universal signifier. It is never used decoratively as a filler accent
across a screen — overuse dilutes exactly the "one clear signal"
property that makes it work as an active-nav/CTA accent.

**Corrected `UI-GATE-CLOSE-1-R1` (2026-09-12) — brand orange and
semantic orange are separate roles, not one exclusive claim.** An
earlier version of this paragraph stated orange is "never repurposed
as a semantic-state color," contradicted by `StatusBadges.tsx`'s own,
already-shipped `EscrowStatus.EXPIRED` badge, which uses orange
specifically to mean "expired" — a real, pre-existing semantic use
this document had simply failed to account for. **Corrected rule:**
**brand orange** (`--color-orange` / `--color-orange-accent`) represents
primary brand/action emphasis — active navigation, primary CTAs, the
one thing to notice — and stays reserved for that role, per §2's own
axis separation. **Semantic orange** (a plain Tailwind `orange-500`
utility, a deliberately different token than the brand accent above)
may be used for warning/expiry-shaped states — `EXPIRED` is the one
real instance today — where icon, text, and context already make the
meaning unambiguous. **Semantic meaning must never depend on orange
color alone**, same as every other semantic color (§5's "color is
never the only cue") — `EXPIRED` already complies: it pairs the color
with an `XCircle` icon and the text label "Expirado." No badge, token,
or component changed by this correction — the visual result is
unchanged; only the rule describing it was wrong.

## 2. Semantic colors — a separate axis from brand

Semantic state colors exist **independently of brand** and must never
be overridden in a way that destroys their meaning. Current tokens
(`index.css`, `tailwind.config.js`'s `colors.brand.*`):

| Meaning | Token | Tailwind class |
|---|---|---|
| Success / positive completion | `--color-success` | `bg-brand-success`, `text-brand-success` |
| Information / neutral important state | `--color-info` | `bg-brand-info`, `text-brand-info` |
| Attention / warning / pending | `--color-warning` | `bg-brand-warning`, `text-brand-warning` |
| Danger / destructive / failure | `--color-danger` (aliases `--destructive`) | `bg-brand-danger`, `text-brand-danger` |

**Frozen rule:** a white-label theme, a future dark-mode variant, or any
future visual pass may change the *exact hue* of these (e.g. a
colorblind-safe palette variant) but may never **swap their meaning**
(danger reading calmer than success, warning and info becoming
visually indistinguishable) or drop the accompanying icon/text pairing
that carries meaning for colorblind users (§6's accessibility rule —
color is never the only cue). These four are not "branding
alternatives" to be replaced by a tenant's palette; they are meaning.

**Note (`UI-GATE-CLOSE-1-R1`):** this table names the four *tokenized*
semantic categories — it is not a claim that no other semantic color
use exists. `EscrowStatus.EXPIRED` (`StatusBadges.tsx`) uses a plain
Tailwind `orange-500` for an expiry-shaped meaning distinct from these
four and distinct from the brand accent (§1's own correction) — a
narrow, single-purpose case, not a fifth formal token. The same rule
still applies to it: icon + text must always accompany it, color alone
is never sufficient.

## 3. Surface system

Formalizes the hierarchy already implemented in `index.css`, now named
explicitly as a system rather than an implicit convention:

| Layer | Token | Role |
|---|---|---|
| `background` | `--color-bg` | Page canvas |
| `surface` | `--color-surface` | Primary content containers (cards, panels, the Sidebar/Topbar) |
| `surface-elevated` | `--color-elevated` | Raised above `surface` — pressed toggles, active toolbar segments, popover/select content |
| `border-subtle` | `--color-border-subtle` | Purely decorative dividers/container edges — tonal separation does the real work |
| `border-functional` | `--color-border` | Real interactive-component boundaries (inputs, buttons with an outline variant) — the WCAG 1.4.11 non-text-contrast-verified hairline; never downgraded to `border-subtle` |
| `overlay` | Radix `Dialog`/`Sheet`/`Popover`'s own backdrop | Modal/drawer/popover scrims |

**Governing rule (added `UI-FOUNDATION-1-VISUAL-CORRECTION`,
reaffirmed here):** prefer **tonal separation + elevation + subtle
borders** over **black boxes with bright white outlines**. A bright,
uniform border on every container was the concrete, CTO-flagged
"wireframe" defect this rule now exists to prevent structurally, not
just patch once. `border-functional` is not deprecated — it is scoped
down to the actual interactive-component case WCAG 1.4.11 protects
(inputs, functional control outlines), never used as the default for
a merely decorative card or row divider.

## 4. Typography system

Named, reusable levels (`index.css`'s `@layer components`, first added
`UI-FOUNDATION-1`), deliberately small — not a full type-scale plugin:

- `.text-page-title` — page-level heading (`Market`, `Entrar`).
- `.text-section-title` — a titled sub-section within a page.
- `.text-label` — small, uppercase, tracking-wide category/field label
  (filter section headers, table column headers, form field labels —
  unified in this mission; previously form labels used an ad-hoc
  `text-xs text-brand-text-muted` pairing instead of this class).
- `.text-metadata` — supporting/secondary detail text.
- `.text-numeric` — tabular numerals for anything scanned as a column
  of numbers (price, amounts).
- **Technical/advanced detail** (new naming, no new class needed): the
  existing pattern of putting technical detail behind an `InfoTooltip`
  (Login's Ed25519 explainer, the AI surface's `BOUNDARY_TEXT`) *is*
  this level — advanced detail stays available, never forced into the
  primary reading path.

No additional type scale is authorized without a demonstrated gap —
these six cover every real level in use today.

## 5. Interaction states

Formalized across every primitive touched this mission
(`button`/`input`/`select`/`switch`/`checkbox`/`.toolbar-chip`):
**default, hover, active/pressed, selected, focus-visible, disabled,
loading, error, success, warning.** Concrete rules:

- **Focus-visible is mandatory on every interactive element** — a real
  gap found and fixed this mission: `.toolbar-chip` (the Asset/Currency/
  PaymentMethod picker triggers) had no focus ring at all before
  `DESIGN-LANGUAGE-1`; it now uses the same `focus-visible:ring-2
  focus-visible:ring-ring` convention every shadcn primitive already
  uses.
- **Color is never the only cue.** Semantic states (§2) always pair
  color with an icon and/or text, never color alone — already true for
  every status badge (`StatusBadges.tsx`) and now for the empty/error
  states (icon + message, not a colored dot).
- **Active navigation must be strong and unambiguous.** For Sails
  Market, orange is the primary active-brand signal (Sidebar's left
  rail + tinted background + orange icon/text; BottomNav's top accent
  bar) — a plain `elevated`-background "gray" active state is
  insufficient (found and corrected `UI-FOUNDATION-1-VISUAL-CORRECTION`).
  A white-label theme may retheme this accent color (§9) but not remove
  the requirement that exactly one destination reads as unambiguously
  active at a time (§ Escopo A, this mission's own nav-matching fix).
- **Selected ≠ hover ≠ active.** A selected filter chip/badge and a
  hovered-but-unselected one must never share the same visual weight —
  already true via `badgeVariants`' `default`/`secondary` split.

## 6. Iconography system

**Evaluated this mission**, not replaced wholesale. Current library:
**Lucide** (`lucide-react`, ~6,100 icons, MIT-licensed, tree-shakeable —
only imported icons ship, already the case here via named imports).

- **Coverage:** excellent for navigation, action, status, empty/loading/
  error, and generic agent/AI iconography (`Bot`, `SearchX`,
  `AlertTriangle`, `ShieldCheck`, etc. — all already in use). **Zero
  coverage** for asset/token brand marks — Lucide ships no
  cryptocurrency logos (confirmed by direct inventory this mission: no
  `Bitcoin`/coin-branded icon exists in the installed version).
- **Decision: keep Lucide** as the base icon set for every category
  *except* asset/token identity. No license, bundle-impact, or
  accessibility concern was found; replacing it would be change without
  evidence, exactly what this mission was told not to do.
- **Icon-category rules:**
  - *Navigation icons* — one per primary destination, paired with a
    text label always visible at `lg+` (never icon-only navigation on
    desktop; icon-only is acceptable only at the collapsed `md`-`lg`
    rail width and on `BottomNav`, both already label-adjacent or
    tooltip-able).
  - *Action icons* — precede the action label (`<KeyRound/> Conectar
    Carteira`), never replace it silently.
  - *Status icons* — always paired with the matching semantic color
    (§2) and text, never color alone.
  - *Asset/token icons* — see §7; explicitly **not** Lucide's job.
  - *Rail/network icons* — not introduced this mission; a real rail is
    currently represented by its label text only (`ASSET_LABELS`,
    e.g. "Bitcoin (Liquid)"). A dedicated rail-icon set is future work,
    not authorized here.
  - *Agent/AI icons* — `Bot` (Lucide), inside a tonal orange-accent
    badge (§9's own visual treatment) — evaluated as sufficient; no
    dedicated agent glyph needed yet.
  - *Security/risk/authority icons* — `ShieldCheck`/`Scale`/`Lock`
    (Lucide) — evaluated as sufficient for current surfaces.
  - *Empty/loading/error* — a Lucide icon (e.g. `SearchX`,
    `AlertTriangle`) + primary message + supporting detail, never an
    icon alone and never bare text alone (§ Escopo A's empty-state
    rule, corrected `UI-FOUNDATION-1-VISUAL-CORRECTION`, re-applied this
    mission).

## 7. Asset / token visual representation

**Visual identity ≠ protocol identity.** No icon, logo, or color
introduced under this section may redefine, alias, or stand in for
`Asset`, `SettlementRail`, or `SettlementScope` (ADR-002) — it is a
*display* affordance only, and the underlying enum value is always
still what is stored/filtered/submitted.

**Strategy adopted (minimal, real, implemented this mission):**
`packages/sails-ui/src/components/ui/AssetIcon.tsx` — a small,
self-contained registry mapping each `AssetType` to a tonal monogram
badge (a 1-2 character glyph, e.g. `₿` for every Bitcoin-family rail,
`U` for USDT/USDC families distinguished by hue, `Ξ` for Ethereum) keyed
off the same `ASSET_SHORT_LABELS` (`lib/labels.ts`) already shown as
text everywhere else. **Why a monogram, not a real logo library:**
adopting a real crypto-icon package sight-unseen would skip exactly the
evaluation this mission requires (license, bundle impact, coverage of
the actual asset list, accessibility) — a real logo library is a future
decision, evaluated on its own before adoption, not implied by this
foundation. The monogram is deliberately swappable: every call site
renders `<AssetIcon asset={...}/>`, so a future real-logo pass changes
one file, not every screen that shows an asset.

**Applied this mission:** `AssetPicker.tsx`'s trigger and dropdown rows
(the one representative usage required as evidence). Not yet applied to
`OfferCard.tsx`, `CurrencyPicker.tsx`, or elsewhere — extending it is
authorized future work, not required by this foundation.

**Pattern rule:** icon/logo is always paired with the asset name/symbol
as text (`icon + name`), never a bare icon substituting for the label —
consistent with §6's "icon never replaces the label" rule and with
accessibility (the icons here are `aria-hidden`; the adjacent text is
the accessible name).

**Color note:** the per-asset accent colors in `AssetIcon.tsx` (Bitcoin-
orange, Tether-teal-ish, Circle-blue, etc.) are a **third color axis**,
separate from brand (§1) and semantic-state (§2) colors — asset
identity, not brand identity and not a risk/state signal. They must
never be reused for UI meaning (e.g. the Bitcoin accent orange must
never be read as "warning" just because it is also orange-family).

## 8. Sails Agent

**`Sails Agent`** is now the product-level identity for AI/agent
assistance across the Sails ecosystem — not a protocol module, not an
OpenAgents scope change, purely a **naming/presentation layer** over
existing, already-real capability. The Marketplace's existing AI
surface (`AgentIntentionPanel.tsx`, previously labeled "AI Negotiator")
is the first concrete **composition** of this identity: **"Sails Agent
— Market Negotiation."** A future agent surface elsewhere in the
product (e.g. a dispute-assistance agent, if one is ever built) would
be a *different* composition of the same "Sails Agent" identity, not a
competing brand name — this is a naming/product-identity pattern, to be
reused, not a one-off rename.

**Renamed this mission** (visible copy only — component name, props,
route, and the underlying real QVAC-backed intent/propose/approve flow
are unchanged): the panel's header, its `aria-label`s, its
authentication-required toast, and its mandate-section heading. **Left
unchanged, deliberately:** the primary CTA microcopy ("Gerar com QVAC",
"QVAC pensando...") — that copy is capability attribution under an
active user action (§10's own allowed case), not this feature's
product-level identity; renaming it was judged a separate, more
visible copy decision than this mission's classification work covers,
and is not required by "Sails Agent" adoption.

**Frozen principle:** **access does not imply economic authority.**
Sails Agent (or any future agent identity) being granted *access* to
generate intentions, search offers, and present proposals never by
itself confers *authority* to move funds, sign, or complete a trade —
authority is a separate grant, never an implicit side effect of access.
This mirrors, at the product-naming level, the same boundary
`docs/PROJECT_CONTEXT.md` §2E's Security Constraint (item 9) already
holds for signer technology: naming something "Agent" must never by
itself read as "Agent already has economic authority."

**Corrected `UI-POLISH-2` (2026-09-12) — this is not a permanent
prohibition.** An earlier version of this section stated the human-
approval step (`handleApprove` — currently the only route from a QVAC
proposal to a real `Trade`/escrow call) as something Sails Agent "can
never" do without, phrased as a standing ban on delegated agent
authority. That overclaimed: it described today's implementation as if
it were a frozen constraint on all future implementations. **Corrected
statement:** *current Sails Market behavior requires human approval
before a QVAC-generated proposal becomes real economic action — this
is current implementation/product behavior, not a permanent
prohibition on delegated agent authority.* A future, separately
authorized economic authority for an agent may exist, provided it is:
**explicit** (granted, not assumed), **scoped** (limited to a named
capability/action set), **limited** (bounded amount/frequency/context),
**observable** (its use is visible to the affected parties), **revocable**
(can be withdrawn), **auditable** (a real record of what it did and
when), and **governed** (subject to the same kind of capability-grant
discipline `RFC-005`'s `CapabilityGrant` already models for other
scoped permissions). **Not implemented, not designed, not scheduled by
this correction** — this section only removes an institutional
overclaim, it does not propose or authorize a delegated-authority
mechanism.

## 9. QVAC representation

QVAC is a **capability/technology**, not the product's primary
identity — the identity is "Sails Agent" (§8); QVAC is what currently
powers one composition of it. Recommended visual use, **only when
material**: capability attribution (the existing `InfoTooltip`
boundary text), advanced/technical context, a "Powered by QVAC"-style
diagnostic line (the existing `LLAMA_3_2_1B_INST_Q4_0 · inferência
local` loading-state line), or relevant execution-context detail. **Not
recommended:** a QVAC logo/wordmark repeated across every AI-touched
screen — that would let implementation/provider branding compete with
"Sails Agent" as the thing a user is meant to recognize, exactly what
this rule prevents. **Current state evaluated as already compliant** —
the two existing QVAC mentions (the info-tooltip boundary text, the
diagnostic loading line) already sit in the "advanced/technical
context" and "diagnostic information" buckets this rule allows; no
change was needed or made to QVAC's own visibility this mission.

## 10. White-label theming contract

Formalizes, for the **visual** layer, the same boundary
`docs/PROJECT_CONTEXT.md` §2D item 4 already froze for **functional**
configuration: **configuration selects from a compliant palette; it
never redefines meaning.**

**Customizable by a white-label tenant:**
- Primary brand/action accent color (replaces Sails orange)
- Logo / wordmark
- Typography, within a compatibility-tested font-pairing set
- Corner radius (`--radius`)
- Selected surface tones (within the same light/dark structure)
- Selected spacing/density presets, where justified (§10 of the Market
  doc's existing density system)
- Some brand-specific surfaces (e.g. Login's always-dark brand panel)
- An icon/branding layer on top of the shared iconography (§6)

**Not customizable in a way that would be semantically destructive:**
- Danger / warning / success / informational meaning (§2)
- Risk hierarchy and authority cues
- Funding/signing semantic states (`docs/PROJECT_CONTEXT.md` §2E items
  7/8, once implemented)
- The distinction between an error state and a success state
- Accessibility requirements (contrast minimums, focus visibility,
  touch target size, color-is-never-the-only-cue)
- Economic state meaning

**Goal, stated plainly:** partner A's wallet can be blue, partner B's
can be green, Satsails uses orange — but the same class of risk/state
must stay legible and coherent across all of them. This is not yet
implemented as a runtime theme-switching mechanism (§11) — it is the
**contract** a future implementation must satisfy.

## 11. Token / theme architecture

**Current state (accurate as of this document):** already a
three-layer system, just not previously named as such —

1. **Primitive** — raw `"R G B"` triplet values in `index.css`'s
   `:root`/`:root.dark` blocks (e.g. `--color-orange: 194 65 12`).
2. **Semantic** — named-by-meaning aliases over primitives (`--primary`,
   `--color-success`, `--color-border-subtle`, shadcn's own
   `--background`/`--card`/`--input`/`--ring` slots — all aliased onto
   the primitives above, never a second independent palette).
3. **Component** — Tailwind class names / `@layer components` classes
   consuming the semantic layer (`bg-brand-orange-accent`,
   `.toolbar-chip`, `.text-label`) — never a raw utility color
   (`bg-orange-500`) outside the one documented exception (§7's
   asset-accent registry, itself contained to one file).

**Required, not yet built:** a fourth **brand-token indirection** — a
tenant-swappable layer between semantic and primitive specifically for
`--primary`/`--color-orange*` (so white-label swaps one set of values,
not every component). This mission's authorized scope was foundation +
minimal proof, not this mechanism; it is the concrete next
implementation block (§ Next recommended block, PR body).

**Explicitly avoided:** hardcoded color proliferation, raw utility
colors scattered outside the token system, arbitrary theme-specific
hacks, and a new, heavyweight theme-engine abstraction. Tailwind stays
the styling engine — the requirement is token discipline, not a stack
change.

## 12. Operating-system-style design grammar

Sails Design Language is intended to function the way a design system
inside an operating system does for the apps built on it — **not** to
make every Sails-adjacent app look identical, impose one required
appearance, or erase partner branding. It **is** intended to guarantee:
interaction consistency, predictable navigation, consistent feedback,
consistent state semantics, consistent spacing rhythm, consistent
accessibility behavior, coherent component expectations, and a shared
visual grammar underneath whatever brand sits on top.

**Institutional formulation:** *applications may express different
brands while preserving a shared interaction grammar.*

## 13. Visual references

Each reference has a **specific, bounded role** — principles, never
pixels, brand, or literal layout:

- **Zest Protocol — primary visual refinement reference.** Premium
  financial feel, dark composition, breathing room, hierarchy,
  restrained use of accent.
- **Binance — secondary operational reference.** Dense market
  workflows, filters, tables, operational scanning, multi-control
  toolbar layout (this mission's own toolbar-container/`.toolbar-chip`
  work draws directly from this role).
- **Sovryn — additional visual/system reference (new this mission).**
  Layered dark surfaces, cards, semantic status colors, reducing
  white-outline dependency, readable dark-state composition — the
  same direction as §3's surface-system rule.

## 14. Relationship between product layers

Respects the already-frozen structure (`docs/PROJECT_CONTEXT.md` §2D
item 1), stated here in visual-language terms:

- **Reusable Reference Components (Layer A)** — must stay semantically
  neutral and reusable; no Sails-specific personality baked in (no
  hardcoded orange, no "Sails Agent" naming inside a generic component
  — composition adds that on top).
- **White-label P2P Base (Layer B)** — may theme strongly (§10) without
  redefining economic meaning.
- **Sails Market** — may use the strongest Sails personality: orange
  brand accent as primary active signal, "Sails Agent" identity,
  Sails-specific composition and copy tone. This is where §1/§8's full
  brand expression lives.
- **Satsails Wallet** — may reuse this language and its components
  where it fits, without being forced to visually copy Sails Market —
  a sibling composition, not a derivative (`docs/PROJECT_CONTEXT.md`
  §2D's frozen topology: no forced parenthood between first-party
  products).

## 16. Responsive Navigation Grammar (`NAVIGATION-FILTER-1`)

**North star, extended:** navigation hierarchy must remain semantically
consistent across breakpoints, even when its visual representation
changes. Responsive adaptation may change **presentation**, never
**information hierarchy**. Desktop, tablet, and mobile may represent
navigation differently; they may not change the product's mental map.

### 16.1 Three distinct layers — must stay explicit, never merged

- **Primary Product Navigation** — "where am I in the product?" Durable,
  always-available top-level destinations. Today: Market, Trades
  Ativos, Meus Trades, Disputas (auth-gated), Perfil.
- **Market Context Navigation** — "which market / discovery context am
  I exploring?" Not yet implemented (§17 registers the concept and
  future pattern) — this is a **separate, higher layer** than either
  Primary Navigation or Screen Filters, and must never collapse into
  either. A future public/private market or community switcher belongs
  here, never as a "payment method"-style filter chip.
- **Screen Filters** — "how do I filter the content of the current
  context?" Everything in `FilterPanel.tsx`/the Market toolbar (asset,
  currency, payment method, amount, country, sort, side). Filters
  narrow what's shown within a context; they never change which context
  you're in.

Conflating these (e.g. exposing a future market/community switcher as
a filter chip) would misrepresent a navigation-level decision as a
content-level one — this is the concrete failure mode this section
exists to prevent, named directly because it was the risk flagged going
into this mission.

### 16.2 Current destination audit and classification

| Destination | Surface(s) | Classification |
|---|---|---|
| Market | Sidebar, BottomNav, wordmark link | Primary Navigation |
| Trades Ativos | Sidebar, BottomNav ("Ativos") | Primary Navigation |
| Meus Trades | Sidebar, BottomNav ("Trades") | Primary Navigation |
| Disputas | Sidebar (auth-gated) | Primary Navigation (conditional) |
| Perfil | Sidebar, BottomNav, Topbar avatar | Primary Navigation **+** Profile/Account root (dual role, see below) |
| Nova Oferta | Button inside Perfil | Action |
| Tema (dark/light) | Topbar, mobile header | Utility |
| Rever tour | Topbar, mobile header (auth only) | Utility |
| Conectar / session avatar | Topbar, mobile header | Profile/Account entry point |
| Asset/Currency/PaymentMethod pickers, Filtros, Ordenar, Buscar, side toggle | Market toolbar | Screen Filters |
| Sails Agent panel | Market page | Contextual action surface (not navigation, not a filter) |

**Note on Perfil's dual role:** it is simultaneously a persistent
Primary Navigation item and the root of the Profile/Account area
(reputation, my offers, Nova Oferta, dispute history). This is not a
defect — most P2P reference products (Binance P2P, HodlHodl) do the
same — but it's worth naming explicitly so a future Profile/Account
redesign doesn't accidentally also change Primary Navigation's shape.

### 16.3 Primary navigation minimal-set recommendation

The current 5-item set (Market/Trades Ativos/Meus Trades/Disputas/
Perfil) is coherent as Primary Navigation today — every item is a real,
Journey-complete destination (`docs/PROJECT_CONTEXT.md` §2E's
capability map), no placeholder was added. **Registered product
recommendation, not implemented this mission (no route changed):**
"Trades Ativos" and "Meus Trades" are two views over the same
underlying concept (the current user's own trades, split by status) —
a future consolidation into one "Meus Trades" destination with an
Ativos/Histórico segmented control **inside** that screen is worth
evaluating once/if Primary Navigation needs to make room for a Market
Context Navigation entry (§17) or another real destination. Not done
here: it would require an actual routing change, out of this mission's
audit-and-document scope.

### 16.4 Desktop / tablet / mobile grammar

- **Desktop (`lg+`):** full `Sidebar.tsx` (icon + label, all 5 Primary
  Navigation items visible) + `Topbar.tsx` (utilities only, §16.5).
- **Tablet (`md`–`lg`):** `Sidebar.tsx`'s icon-rail mode — same items,
  same order, same active-state treatment, labels hidden but available
  via each link's `title` attribute (native tooltip on hover) — same
  semantic hierarchy, denser presentation, not a different navigation.
- **Mobile (`<md`):** `BottomNav.tsx` — Primary Navigation only, no
  Topbar equivalent (a lightweight header carries brand + session +
  theme instead, deliberately not a second nav surface, §16.5).
  Current 4 unauthenticated / 5 authenticated items fit directly with
  no overflow needed. **Overflow strategy, registered for when the set
  grows:** once Primary Navigation would exceed roughly 5 mobile items,
  the least-frequently-primary item(s) should move into a "Mais" sheet/
  drawer entry (a 5th+6th BottomNav slot reading "Mais" that opens a
  `Sheet` listing the overflow destinations) rather than shrinking touch
  targets or wrapping to a second row — not needed today, not built.
- **Labels may shorten, meaning must not change.** `BottomNav.tsx`'s
  "Ativos"/"Trades" are compressed forms of Sidebar's "Trades Ativos"/
  "Meus Trades" — same destination, same meaning, just terser for
  mobile width. This is the existing, correct pattern (confirmed during
  this mission's audit) — contrast with the "Comprar" vs "Market" case
  `DESIGN-LANGUAGE-1` fixed, where the mobile label named a *different
  concept* (an action) than the desktop label (a destination/space):
  that was a semantic remapping, not a shortening, which is why it was
  a bug and this is not.
- **Responsive presentation ≠ semantic remapping.** The route each item
  points to, and the active-state matching logic (`end: true`/`false`
  per item, `DESIGN-LANGUAGE-1`'s own bug fix — re-audited this mission,
  confirmed as the only `NavLink` usage in the app), are shared across
  `Sidebar.tsx` and `BottomNav.tsx` — never independently re-derived per
  breakpoint. A destination's meaning lives in its route, not its label
  or icon.

### 16.5 Topbar role — audited, confirmed correctly scoped

`Topbar.tsx` was audited against its own stated purpose
(session/identity, theme, help/utilities) — confirmed it does **not**
duplicate Primary Navigation (no nav links live there, only
`ThemeToggle`, the onboarding-replay utility, and the session/Conectar
entry point) and does **not** carry a Search or Notifications entry
that doesn't exist as a real capability yet
(`docs/PROJECT_CONTEXT.md` §2E's capability map — Notifications remains
Future/Planned). **No code change made** — this is confirmation of
correct existing scope, not a new rule.

### 16.6 Future Market Context Navigation pattern — evaluated, not implemented

No runtime UI exists for this today (no public/private market switcher,
no server/community selector) — this is a pattern evaluation only, so a
future implementation starts from a considered default instead of an
ad-hoc one. Options evaluated, desktop and mobile:

- **Tabs / segmented control** (e.g. "Público" / "Privado" directly atop
  the Market toolbar) — low implementation cost, reads clearly at both
  breakpoints, but scales poorly past 2-3 contexts and visually
  resembles a Screen Filter (§16.1's exact conflation risk) unless
  deliberately styled distinctly from `.toolbar-chip`.
- **Contextual Topbar selector** (a dropdown in `Topbar.tsx`, desktop
  only) — keeps Market Context Navigation visually separate from both
  Primary Navigation (Sidebar) and Screen Filters (toolbar), but needs
  its own mobile equivalent (Topbar doesn't exist on mobile, §16.5).
- **Sidebar secondary section** (a divider + a second, smaller group
  below Primary Navigation) — best preserves the "separate layer" reading
  at desktop/tablet, but has no direct mobile analogue (BottomNav has no
  room for a second group) and would need a distinct mobile entry point.
- **Market selector as its own top-level control**, above the Market
  toolbar and visually distinct from it (e.g. a bordered dropdown with
  its own icon language, not styled as a filter chip) — recommended
  direction if/when this ships: reads as navigation-adjacent without
  needing new Sidebar/Topbar real estate, translates to mobile as a
  single control below the page header.

**Recommendation, not a decision:** the last option (a distinct
top-level market selector, not a Sidebar/Topbar/filter-toolbar entry)
best satisfies §16.1's separation requirement at both breakpoints with
the least structural disruption — registered for the CTO/product
decision this needs before any implementation; see
`docs/PROJECT_CONTEXT.md`'s Public/Private Markets and Servers product
direction and `docs/BACKLOG.md` for the corresponding backlog item.

## 17. Filter / Discovery UX Grammar (`NAVIGATION-FILTER-1`)

### 17.1 Filter hierarchy

`FilterPanel.tsx` is organized into six labeled sections, in this
order: **A. Qualidade do anunciante** (negotiable-only, high-reputation,
previously-traded) → **B. Valor** (amount + presets) → **C. Tempo de
pagamento** → **D. País/Região** → **E. Método de pagamento** → **F.
Ordenação**. Each section has a consistent title/spacing/divider
treatment (a `Section` wrapper, not six independently-styled blocks) —
this ordering and the underlying runtime fields are unchanged from
before this mission, only the visual grouping and hierarchy are new.

### 17.2 Grouped, searchable payment methods — country prioritizes, never restricts

The prior flat "wall of chips" (all 43 filterable `PaymentMethod`
values rendered at once) is replaced by:

1. **Selected methods**, always visible, pinned first, removable
   in-place (a small `×` on the chip).
2. **Country-suggested methods** — when a country is selected and has a
   registered priority list (`lib/paymentMethodMeta.ts`'s
   `COUNTRY_PRIORITY_METHODS`), its most locally-relevant methods
   surface next, still just ordinary toggleable chips.
3. A collapsed-by-default **"Ver todos os métodos"** disclosure containing
   a search field and the remaining methods grouped by category
   (`PAYMENT_METHOD_CATEGORY_LABELS`: Transferência bancária, Carteiras
   digitais, Dinheiro/presencial, Cripto/Lightning, Internacional/
   remessas, Outros).

**Frozen rule: country selection PRIORITIZES, it never RESTRICTS.** A
country's priority list only reorders which methods surface first —
`FilterPanel.tsx` never filters the underlying `PAYMENT_METHODS_FILTERABLE`
list by country; every method remains reachable via "Ver todos" and
searchable regardless of the selected country. There is no "resident of
country X = only these methods" rule anywhere in this UI, and none is
authorized — a Brazilian user can still find and select Wise, PayPal,
or Revolut.

**Categories are a frontend display grouping only** (`lib/paymentMethodMeta.ts`'s
own header comment) — never protocol truth, never round-tripped to the
backend, never read by `PublishOffer.tsx`'s real submission path (which
keeps using the narrower real `PAYMENT_METHODS` enum, untouched).

### 17.3 Sorting — copy must match actual behavior, not aspiration

`trades`→"Mais trades" and `reputation`→"Maior reputação" are correctly
"best-first" today (higher `totalTrades`/`reputationScore` is
unambiguously better) regardless of context — their copy says so.
`price` is `Menor preço` (lowest-first), **deliberately not** "Melhor
preço" — the actual sort (`a.priceUsd - b.priceUsd`, always ascending)
is only genuinely "best for the viewer" when browsing SELL-side offers
(the viewer is buying, lowest price wins); for BUY-side offers (the
viewer would be selling to the offer's maker) ascending surfaces the
*worst* price first. **Registered gap, not fixed this mission:** a
truly side-aware "best price" sort needs the comparator to flip
direction based on the active side filter — a logic change, out of
this pass's copy-and-hierarchy scope. Until that lands, sort labels
must keep describing actual direction (`Menor`/`Maior`/`Mais`), never
claim "melhor"/"best" where the implementation doesn't yet back it.

### 17.4 Active-filter visibility and footer

A proportional summary — "N filtros ativos" + a single "Limpar tudo"
action — sits below the drawer title when at least one filter is
active; this was judged sufficient without also duplicating every
active filter as a second row of removable chips (the per-section
toggle states already visible below already serve that purpose,
avoiding redundant chrome). The drawer's footer (`Limpar` / `Aplicar
filtros`) is now a sticky flex sibling of the scrolling content region,
not part of the scrolling document — a mobile user never has to scroll
to the bottom to act on it. `Limpar` resets every field that narrows
results back to `DEFAULT_FILTERS`, while preserving the user's
`saveForNext` preference and current sort choice (sort is display
ordering, not a search criterion).

### 17.5 Desktop vs. mobile

Both breakpoints reuse the exact same `FilterPanel.tsx` — the Radix
`Sheet` already renders full-height on mobile and a fixed-width side
panel on desktop (`sm:max-w-sm`) via its own existing variant, so no
mobile-specific filter component was needed; the sticky footer and
collapsible payment-method section both work identically at both
widths (verified live, §Evidence).

## 18. Explicit non-goals of this foundation

This document does **not**: implement `FundingInstruction` or
`SigningRequest` UX, expand OpenLiquidity or OpenAgents protocol scope,
create Private Markets/OTC/Portfolio/notification-backend modules,
introduce a new protocol primitive, change the custody/signer model or
Day-0 settlement scope, or close any capability-maturity backlog item
by virtue of a CSS/UI change. It does not require an ADR — no new
architectural constraint is introduced; this formalizes and names an
existing, already-implemented token/component pattern and extends it
with a small, real proof (checkbox/switch/asset-icon/toolbar
consistency), not a new architecture.

## 19. Mobile Secondary Surface Semantics — Back vs. Close (`UI-POLISH-2`)

**Rule:** a full-screen (or near-full-screen) mobile surface reached by
drilling into a flow reads as a **secondary surface** — the user's
mental model is "I went somewhere," not "something popped up over what
I was doing." It uses **Back** semantics (an arrow, top-left, paired
with the surface's title). A narrower, clearly-layered overlay/drawer/
dialog — the same surface at `sm+`, or any true modal that doesn't
consume the full viewport — uses **Close** semantics (`X`), since the
mental model there genuinely is "something appeared over my content."

**Do not** default to a component library's built-in dismiss control
(e.g. Radix `Dialog`/`Sheet`'s own `X`) at every breakpoint just
because it ships that way — check which mental model the surface
actually presents at that breakpoint. `FilterPanel.tsx`'s `Sheet` is
the concrete instance: full-width on mobile (a secondary surface — now
a back arrow) vs. a `sm:max-w-sm` side drawer on desktop/tablet (a
genuine overlay — `X` stays correct there). Both controls call the
identical cancel handler; only the icon and position differ.

**Both are still cancel/dismiss actions, not distinct behaviors** —
this section is about which *icon and position* the shared dismiss
action wears at a given breakpoint, not two different action semantics
(see §21 for what "cancel" itself must and must not do when a surface
holds a staged edit).

## 20. Filter / Panel Commit Semantics — Live vs. Staged (`UI-POLISH-2`)

**Rule, chosen for this app:** an advanced-filter (or similarly-scoped
edit) panel that presents an explicit "Apply"-style action **must
actually stage changes** — edits inside the panel affect a local draft
only; the real, applied state changes exactly once, when the user
confirms. A panel must never present staged-commit affordances while
actually mutating live state as the user types/toggles — found and
fixed in `FilterPanel.tsx` (§22 below) — that mismatch reads as a bug
even when nothing is technically broken, because the UI's own language
promised something the runtime didn't do.

**If a future panel genuinely wants live filtering instead** (edits
visibly affect results immediately, no separate confirmation step),
that is a legitimate, different model — but it must **not** also show
an "Apply" button that implies a held-back commit. Pick one model per
surface and let its own controls honestly describe it; never a hybrid.

**Required behavior once staged is chosen** (formalized here, applied
in `FilterPanel.tsx`):
- Opening the panel seeds a fresh draft from the real, currently-
  applied state.
- Every control inside edits the draft only.
- Exactly one action commits the draft to real state (e.g. "Aplicar
  filtros").
- Every dismissal path — Back (mobile), Close/`X` (desktop), Escape,
  clicking outside a modal overlay — discards the draft. None of them
  may silently apply it.
- A "Clear"/"Limpar" control inside the panel edits the draft the same
  way every other control does; it does not affect real state until
  the user also commits.

## 21. Agent Authority Boundary (`UI-POLISH-2`, corrects `DESIGN-LANGUAGE-1` §8)

Full text lives in §8, corrected this mission — named here as its own
heading because it is a standing boundary this document enforces, not
a one-time fix. In one line: **agent access ≠ agent authority; today's
human-approval requirement is current product behavior, not a
permanent prohibition on a future, properly-governed delegated
authority** (explicit, scoped, limited, observable, revocable,
auditable, governed — §8's own full list). Any future document,
comment, or UI copy describing what an agent identity can or cannot do
must use this framing, not an absolute "can never."

## 22. Iconography Governance — system-level, not page-level (`UI-POLISH-2`, extends §6)

**Rule:** an icon's meaning is decided once, for a category, at the
design-system level — never re-decided per page or per component.
Two different screens must never use different icons for the same
status, action, or identity, and the same icon must never carry two
different meanings across the app. §6 evaluated Lucide and named seven
categories; this mission adds three the audit had missed and confirms
current coverage:

| Category | Coverage | Example |
|---|---|---|
| Primary Navigation | Lucide, sufficient | `Sidebar.tsx`'s 5 nav icons |
| Actions | Lucide, sufficient | `KeyRound` (Conectar), `SlidersHorizontal` (Filtros) |
| Status | Lucide, sufficient — **added this mission** | `StatusBadges.tsx`'s Trade/Escrow/Offer status pills now pair an icon with their existing color+text (was color+text only) |
| Security / Authority | Lucide, sufficient | `ShieldCheck` (Login), `Scale` (Disputas), `Lock` (escrow funds-locked status) |
| Agent / AI | Lucide, sufficient | `Bot` (Sails Agent) |
| Empty / Loading / Error | Lucide, sufficient | `SearchX`, `Loader2`, `AlertTriangle` (Marketplace) |
| Asset / Token | **Not Lucide's job** — a monogram registry (§7) | `AssetIcon.tsx` |
| Rail / Network | Not yet needed (§7-adjacent, see below) | none today |
| Operator / Diagnostic | Lucide, sufficient, lightly used | the QVAC inference-model diagnostic line (text only today — no icon judged necessary, low-frequency surface) |
| Market Context / Access | **N/A — no runtime exists yet** (§16.1/§17) | reserved for whenever Market Context Navigation ships |

**Icons reinforce meaning; they do not manufacture hierarchy.** An
icon is added only where it demonstrably improves scanning, reduces
ambiguity, reinforces an existing status, or aids mobile recognition —
never decoratively. Important actions prefer **icon + label**; an
important action is never hidden behind an icon-only control without a
clear, obvious affordance (a labeled tooltip, sufficient size, and
established convention — e.g. a lone `X` close control is
conventional; a lone unlabeled action icon for something consequential
is not).

**Rail/network icon strategy (§4.5):** no logo invented for Bitcoin
L1/Lightning/Spark/Arkade/Liquid/EVM chains/Solana/Tron/TON/BNB Chain —
none is used visually today (rails are represented by label text only,
e.g. "Bitcoin (Liquid)"). Direction registered, not built: if/when a
rail needs its own icon (e.g. a future multi-rail selector), it should
follow the same "real registry, swappable, evaluated before adopting a
real logo source" pattern `AssetIcon.tsx` already established for
assets — not a new, separate pattern.

## 23. Cross-Platform Information Integrity (`UI-POLISH-2`)

**Rule:** responsive adaptation may change **presentation** (layout,
density, grouping, which controls are visible without scrolling) — it
must never fracture **meaning** (what the user is looking at, what
state something is in, what action is available, what is required).

**Never silently truncated, at any breakpoint** — product identity
(e.g. "Sails Agent"), economic state, a required action, critical
counterparty information, authority/risk status, an asset or amount,
an error state, or the currently-active destination. Ellipsis is
permitted only for genuinely secondary information that has another
way to be reached in full (a tooltip, an expanded view, a detail page)
— found and fixed this mission: `AgentIntentionPanel.tsx`'s header
used to truncate "Sails Agent — Market Negotiation" as one string on
narrow widths, clipping the identity itself. Corrected to a two-line
layout — see §16.4's own "labels may shorten, meaning must not change"
rule for the navigation-specific version of this same principle.

**Audit method used this mission** (repeatable for future surfaces):
check desktop wide (≥1440px), desktop medium (~1024–1280px), tablet
(~768–900px), and mobile (~360–430px) for: truncation, wrapping,
title/subtitle integrity, action visibility, selected-state visibility,
touch target size, focus visibility, tooltip availability on touch,
hover-only affordances with no touch equivalent, horizontal overflow,
CTA visibility, sticky-area behavior, and any information that is
lost, duplicated, or silently reordered between breakpoints.

**Example of correct reflow** (already true, confirmed this mission):
a title/subtitle pair sits horizontally on desktop and stacks to two
lines on mobile — same information, same order, no loss. **Example of
incorrect reflow** (the bug this section exists to prevent): a full
label on desktop silently becoming an unrecoverable ellipsis on mobile
with no alternative access to the full text.

## 24. Typography Preservation (`UI-POLISH-2`)

**Typography is currently one of the strongest parts of the Sails
Market visual system.** Preserve the current direction — display
typeface for brand/headlines, system stack for body/density, the
named type levels in §4 — unless there is concrete evidence of a
readability, hierarchy, responsiveness, or accessibility problem. Do
not change font, scale, or hierarchy for novelty or personal
preference.

**Audited this mission, not redesigned:** clipping, wrapping,
responsive scale, line-height, hierarchy, contrast, numeric scanning,
and localization resilience (Portuguese copy running measurably longer
than English in several labels — already accommodated by existing
wrap/truncate behavior, no overflow found). **No typography change was
made** — the one real defect found and fixed this mission
(`AgentIntentionPanel.tsx`'s identity truncation, §23) was a layout/
truncation bug, not a typography defect; the type levels and scale
themselves were never in question.

## Closing confirmations

- Design Language ≠ Protocol Semantics — confirmed, no protocol/SDK/
  Core file touched by this document or its accompanying implementation.
- No new product scope, module, or backlog-closure claim is made here.
- `docs/SAILS_MARKET_DESIGN_DIRECTION.md` remains the product-specific
  instantiation; this document is the reusable layer it now explicitly
  cross-links to (§17/§19/§22/§24 there point here for the promoted
  material).
- `docs/PROJECT_CONTEXT.md` §2D item 4 now cross-links here for the
  visual-layer instantiation of its frozen white-label configuration
  boundary — the functional boundary itself is unchanged.
- `NAVIGATION-FILTER-1` (§16/§17) added Responsive Navigation Grammar
  and Filter/Discovery UX Grammar — no runtime Market Context Navigation,
  Private Markets, or server/community UI was implemented; §16.6's
  pattern options are an evaluation for a future decision, not a build.
- `UI-POLISH-2` (§19-§24) corrected an institutional overclaim (§8/§21
  — Agent Authority is no longer phrased as a permanent prohibition),
  fixed a real information-integrity bug (§23 — Sails Agent's mobile
  identity truncation), converted `FilterPanel.tsx` from a false live/
  staged hybrid to a real staged-draft model (§20), formalized Back-vs-
  Close semantics (§19), extended iconography governance with three
  categories the prior pass missed (§22), and reaffirmed typography as
  already correct, unchanged (§24). No delegated agent authority, no
  Private Markets/server runtime, no icon library or typography change
  implemented by this mission.
