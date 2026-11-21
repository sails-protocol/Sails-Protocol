# @sails/ui

Reference UI for the Sails P2P Trading SDK. Structural flow built first,
then given the real Satsails brand identity directly (2026-07-18) —
black + orange, light and dark theme, orange constant across both. See
`docs/TODO.md` section 11.

## What this is

### Monetary truth correction — CTO 118 (2026-11-14)

This correction supersedes the historical FX descriptions below. Discovery,
offer detail, own offers, Trade and Trade History display `priceUsd` /
`totalUsd` as USD, without FX conversion. The optional legacy `priceBrl`
field is not used to infer a binding quote currency. This does not establish
fiat-payment commitment or multi-fiat support; B7 / #623 still owns that work.

Publish Offer defaults to USD and accepts fixed USD prices only. Other
currency selections show an unavailable message and cannot advance or
submit. The illustrative FX table is removed; the entered positive USD
decimal is passed unchanged (at most 16 integer and 8 fractional digits).
The existing public SDK call is preserved, with no new economic endpoint,
settlement integration, custody change or production activation.

Targeted regression: `npx jest --runInBand packages/sails-ui/tests/publicationPrice.test.ts`.
Funding/signing UX, SPLIT presentation, recovery, reusable packaging, Sails
Pay reconciliation and CC17 acceptance remain separate, unfinished work.

**Screen list corrected 2026-08-04** — no more Admin Dashboard/Manage
Offers (removed the same day, see "What this is not" below), routing is
`react-router` v8 (not `react-router-dom`, dropped in a dependency audit
between then and now). 9 screens, fully navigable: Marketplace, Offer
Detail, Trade (chat + escrow state machine + real dispute view), Login,
Profile, Publish Offer (3-step wizard), Trade History, Disputes
(arbiter-scoped, not an admin console — see below).

**Publish Offer** (`PublishOffer.tsx`, `/profile/new-offer`): a 3-step
wizard matching the Binance P2P ad-posting flow, requested directly with
a reference screenshot — Definir tipo e preço → Definir valor e método →
Definir condições. Every field that reaches the final `Offer` object
maps onto the real backend's `CreateOfferInput`
(`liquidity.service.ts`, checked before building this): asset, side,
priceUsd, priceBrl, minAmount, maxAmount, paymentMethod, paymentDetails,
network, description. (`requiresKyc` was removed from this UI on
2026-08-09 — non-custodial and no-centralized-identity-visibility are
the same promise from two angles, so a per-offer KYC flag doesn't
belong even as an opt-in; the field still exists on the backend as of
this writing, a separate, backend-owned removal.) Two things are
honestly not backed by that real shape: "Tipo de Preço: Flutuante" (a market-pegged price —
`liquidity.service.ts` has no live FX/price-feed integration at all,
selectable for fidelity to the reference screenshot but disabled with a
tooltip explaining why) and `priceUsd` itself when pricing in a non-USD
currency (derived via `lib/currency.ts`'s new `ILLUSTRATIVE_FX_TO_USD`,
same "illustrative, not live" honesty boundary `AMOUNT_PRESETS` already
uses). **Corrected 2026-08-04:** `handlePublish()` calls the real
`sailsClient.liquidity.publish()` (`POST /v1/liquidity/offers`) directly
— `lib/offersStore.ts`/`localStorage` is gone (deleted, along with the
fake "operator" admin console it also used to back — see "What this is
not"). The one remaining mock touchpoint is the "suggested price range"
helper, which still reads the seed `MOCK_OFFERS` for comparable prices
instead of a real `liquidity.discover()` call — a real gap, not a
custody/visibility one (comparable prices are already public
marketplace data, same as `Marketplace.tsx` itself shows). Verified live
in browser: full 3-step flow, validation on under-filled steps, the
published offer appearing correctly in Marketplace, Profile, and its
own detail page with the right side/price/limits.

**Design system** (`src/index.css`, `tailwind.config.js`): CSS custom
properties define the full palette for both themes — `:root` (light)
and `:root.dark` (dark), toggled via `ThemeContext`
(`src/context/ThemeContext.tsx`), defaulting to the visitor's system
preference and persisted to `localStorage`. Orange (`--color-orange`,
`#f97316`) is the one constant across both themes. A handful of
component classes (`.card`, `.btn-primary`, `.btn-ghost`, `.input-field`,
`.pill-active`/`.pill-inactive`) live in `@layer components` so a future
white-label partner edits ~8 rules, not every component file — the
whole point of building the structure and the identity as separable
layers, even though both are now real.

**Marketplace filters** (`src/components/marketplace/`): a Binance
P2P-style advanced filter system, requested directly —
- `AssetPicker`: search-based asset selector (not a lateral pill row —
  doesn't scale once more assets exist).
- `CurrencyPicker`: fiat currency filter (BRL/USD/EUR/...). The real
  backend only models one local-fiat price (`Offer.priceBrl`,
  `prisma/schema.prisma`) — `FiatCurrency`/`Offer.priceFiat`
  (`src/types.ts`) generalize that for the UI, honestly flagged as
  presentation-layer in that type's own comment, not a backend claim.
- `FilterPanel`: a drawer with the exact requested option set (save
  filter, negotiable-only, high-reputation-only, previously-traded,
  amount presets by currency, payment time limit, payment method,
  country/region, sort by) — each with an "i" `InfoTooltip` explaining
  what it does. `negotiableOnly`/`highReputationOnly`/
  `previouslyTradedOnly` filter against UI-only demonstration fields on
  `Offer` (`blockedRelationship`, `tradedWithCurrentUser`) — a real
  version needs a real block-list and trade-history join, neither built
  in the backend yet; flagged in `types.ts`'s own comments, not hidden.

**Agent QVAC surface** (`src/components/agent/`, `src/lib/qvacAgent.ts`):
reflects the real `QvacAgentProvider`/`BuyerAgent`/`SellerAgent`
(`src/modules/open-agents/*.ts`) — a real local LLM (`@qvac/sdk`,
llama.cpp, no cloud dependency). **Corrected 2026-08-09:** this used to
be a client-side heuristic simulation (no HTTP route existed) — the
engineering session shipped `POST /v1/agents/generate-trade-intent` /
`generate-offer-intent` / `assess-intent-risk` (`agent.routes.ts`) the
same day, in direct response to this file's own "Next steps" item 6
below, and `qvacAgent.ts` now calls the real routes via `@satsails/p2p-trading-sdk`'s
new `sailsClient.agents.*`. Both routes require an active session (real
inference has a real per-call cost, gated the same way the backend
gates other expensive real operations).
- `AgentIntentionPanel` (Marketplace, "🤖 AI Negotiator"): natural-
  language goal → a real structured trade intent via
  `generateTradeIntent()` (used for both BUY/SELL goals — this panel
  narrows the Marketplace filter, it doesn't publish an offer, so
  `generateOfferIntent()`'s own shape, lacking a `currency` field, isn't
  the right fit here; it's real and SDK-exposed too, just has no UI
  consumer yet). Once generated, the panel exposes a bounded delegation
  mandate (quantity, limit price, deadline, tolerance, and a Negotiation
  Profile — Conservative/Balanced/Aggressive/Instant,
  `src/lib/aiNegotiator.ts`) — the user always hands the agent a
  mandate, never open-ended control. "Delegar para IA" still starts a
  client-side SIMULATION of the negotiation itself (status timeline, an
  "Agent Strategy" readout, a converging "Melhor oferta") — only the
  structured-intent generation above is real now; no backend accepts a
  full delegation mandate yet (see Next steps). A permanent
  "🛑 Parar Agente / Assumir Controle" button halts the simulated
  negotiation at the current step regardless.
- `AgentRiskCard` (Trade page): real risk assessment via
  `assessIntentRisk()`, the same step that runs before Intent
  coordination (RFC-012) server-side. Requires an active session — shows
  a "conecte sua carteira" message instead of attempting the call when
  logged out, and a real error state (not previously possible when this
  was a simulation that could never fail).

**Crypto-Native Agent boundary (RFC-016,
`docs/rfcs/RFC-016-qvac-crypto-native-agent-boundary.md`):** both
components' `InfoTooltip` copy states this directly — QVAC only ever
acts on digital assets already in the wallet, via WDK. It never calls a
banking API and never touches PIX or any other fiat rail; that
conversion is a regulated on/off-ramp provider's job, entirely outside
this protocol. The one negotiation step that names a fiat action
("Aguardando pagamento") is always something the human counterparty
does — the agent only waits for and observes it.

**Scam-prevention warnings (RFC-017,
`docs/rfcs/RFC-017-timeline-and-social-engineering-agent.md`):**
`ChatWindow`/`ChatMessage` render a `RISK_WARNING` message type — the
same name and shape the real backend's WS protocol uses
(`chat.routes.ts`'s broadcast of `agents.social_engineering.risk_detected`).
The real backend detector (`SocialEngineeringAgent.evaluate()`, QVAC via
`assessSocialEngineeringRisk()`) is real code, off by default
(`config.features.socialEngineeringDetection`) — but this UI has no live
connection to it. `src/lib/socialEngineering.ts`'s `detectRiskLocally()`
is a plain keyword regex standing in for that real QVAC call, purely so
`Trade.tsx`'s chat has something to react to; it detects the same two
patterns the real agent detects today (`off_channel_migration`,
`payment_instruction_change` — try sending "vamos falar no whatsapp" or
"nova chave pix" in the demo chat). Verified in browser: both patterns
fire correctly, a plain message doesn't false-positive.

**Chat image/video attach** (`ChatWindow`/`ChatMessage`): the 📎 button
creates a local `URL.createObjectURL()` blob — the file never leaves the
browser tab, nothing is sent "via Pears" yet. `ChatWindow.tsx`'s own
comment spells out what's actually missing on the real backend: an
upload/storage step (`Message.content` is Postgres text, not a place for
a raw video blob) and a Pears event kind carrying media (today's
WS→Pears relay in `chat.routes.ts` only forwards plain text). `msgType`
itself needs no migration — it's already a free-form `String` in
`prisma/schema.prisma`.

## What this is not

- **Partially wired to the real backend — corrected 2026-08-01, this
  paragraph had gone stale.** It used to claim "no `@satsails/p2p-trading-sdk` call
  happens anywhere in this package" — checked directly against current
  source (`grep` for `sailsClient.`/`from '@satsails/p2p-trading-sdk'`) and that's no
  longer true. Real, live calls exist in: `context/AuthContext.tsx`
  (Login — `identity.create`/`authenticate`), `lib/realOffers.ts`
  (Marketplace — `liquidity.discover`), `pages/OfferDetail.tsx`
  (`liquidity.getOffer`), `pages/PublishOffer.tsx` (the actual publish
  action — `liquidity.publish`; only its "comparable price" helper still
  reads `MOCK_OFFERS`, not the publish call itself), `pages/Trade.tsx`
  (`openp2p.trade`/`getTrade`/`getMessages`, `settlement.create`/`lock`/
  `markPaymentSent`/`release`/`dispute`/`submitDisputeEvidence`/
  `contestAutoResolution`/`appealDispute`, and a real `openp2p.chat()`
  WebSocket with real presence via `USER_ONLINE`/`USER_OFFLINE` frames),
  `hooks/useEscrowKey.ts` (now signs MULTISIG/LIGHTNING_HODL/
  SAFE_GUARD_EVM release rounds for real), and `pages/Profile.tsx`
  ("Minhas Ofertas" calls `liquidity.getMyOffers()`/`updateStatus()`
  directly, no `localStorage` fallback). **Corrected further, 2026-08-04:**
  `pages/TradeHistory.tsx` is real now too (`openp2p.getTrades()`), and
  `pages/Disputes.tsx` (moved out of `pages/admin/`, real
  `settlement.listDisputes()`/`getDispute()` + all four dispute actions).
  Only remaining mock reads: `PublishOffer.tsx`'s comparable-price helper
  and `pages/admin/Dashboard.tsx`/`ManageOffers.tsx` — except those two
  don't exist anymore, deleted the same day (next bullet).
- **No platform-operator/admin tier — removed 2026-08-04, not just left
  unbuilt.** `pages/admin/Dashboard.tsx` (platform-wide stats) and
  `ManageOffers.tsx` (manage-everyone's-offers) used to exist here as
  mocked stand-ins for a role this protocol's authorization model has no
  real concept of — every actual read endpoint stays scoped to the
  calling participant or a genuine assigned role like `Dispute.arbiterId`
  (`Disputes.tsx`, real, correctly scoped, never was the problem — it was
  just misfiled under `admin/`). Not custodying funds and not
  centralizing visibility into every user's data are the same
  non-custodial commitment seen from two angles: an operator who could
  see everyone's trades/disputes would be a custodian-like privileged
  position in all but name. `context/AuthContext.tsx`'s `isOperator`/
  `toggleRole` (a client-side, self-assignable role toggle with no real
  backend behind it) went with them. If this tier is ever genuinely
  needed, it requires a real authorization primitive designed on
  purpose, not a UI checkbox — see the CTO-level architecture decision
  this was escalated as, rather than built.
- **Not where WDK/Pears code runs.** `wdk-settlement.provider.ts` and
  `pear.service.ts` (the real signing/P2P code) are server-only — a
  browser can never import them directly (they hold seed material /
  need `hyperdht`, Node-only). This UI only ever talks to the real
  backend's HTTP/WS routes, never those modules.

## Real bug found and fixed while testing this in a browser

`AuthContext`'s login state used to be read from `localStorage` inside
a `useEffect`. On a hard navigation straight to `/profile`, React runs
effects child-to-parent on mount — `Profile`'s own `if (!user)
navigate('/login')` effect fired before `AuthProvider`'s effect had a
chance to populate `user`, bouncing a genuinely logged-in session back
to the login screen. Fixed by reading `localStorage` synchronously via
a lazy `useState` initializer instead — the same pattern `ThemeContext`
uses for the same reason (see its own comment). `npm run build`
(type-checking only) never caught either — both are runtime
effect-ordering issues, found by actually clicking through the app in a
browser, not by the type checker.

A second one, found the same way while adding the Agent QVAC panel:
`AgentIntentionPanel`'s collapsible header was a `<button>` wrapping an
`InfoTooltip`, which renders its own `<button>` — invalid HTML (a button
can't contain a button) and a real interaction bug, since clicking the
info icon would bubble up and also toggle the whole panel closed. The
browser's console flagged it as a React DOM-nesting warning; `tsc` had
no opinion, since it's valid TypeScript. Fixed by pulling `InfoTooltip`
out to be a sibling of the toggle button instead of a descendant.

## Three real UX bugs found and fixed (asked directly: "tem erros de UX?")

None of these were caught by `tsc`/`npm run build` — all three are
runtime navigation/state bugs, found by actually clicking through the
full offer → login → trade flow, not by the type checker.

1. **Any offer landed on the same hardcoded trade.** `OfferDetail`'s
   "Iniciar Trade" always navigated to `/trade/trade-a1b2c3d4` — the
   `MOCK_TRADE` id — regardless of which offer or amount was picked.
   Browsing the STX offer and starting a trade landed on a screen
   showing BTC, a different amount, and a different counterparty. Fixed
   by `src/lib/buildTrade.ts`'s `buildTradeFromOffer()`, which
   constructs a real `Trade` from the offer + amount passed through
   `navigate()`'s router state; `Trade.tsx` uses it when that state is
   present and falls back to `MOCK_TRADE` only for direct/bookmarked
   navigation (no offer to build from) — an intentional fallback, not
   the bug. Also swapped `Trade.tsx`'s hardcoded `formatBrl()` for
   `formatByCurrency(trade.totalBrl, trade.offer.fiatCurrency)`, since a
   trade built from a non-BRL offer needs the right currency symbol.
2. **Login lost all context.** `Login`'s `handleConnect()` always
   navigated to `/`. An unauthenticated user redirected here from
   `OfferDetail`'s "Iniciar Trade" would connect, land on the
   Marketplace, and have to re-find the offer and retype the amount.
   Fixed with a standard return-to pattern: `OfferDetail` passes
   `{ from: location.pathname, amount }` in `navigate()`'s state when
   redirecting to `/login`; `Login` reads it back and navigates to
   `from` (forwarding `amount`) instead of always `/`; `OfferDetail`
   prefills its amount field from that returned state on mount.
3. **`AgentIntentionPanel` and the offer grid never referenced each
   other.** Delegating a mandate to the AI Negotiator never filtered or
   highlighted any real offer, and picking an offer manually never
   referenced anything from the mandate — two parallel entry points to
   the same goal that felt bolted together rather than one flow. Fixed
   with a new `onIntentGenerated` prop: as soon as QVAC parses a goal
   (before the user even delegates), `Marketplace` narrows its own
   asset/side/currency filters to match, so the offer grid updates
   live. The generated-intent card also gained a "Ver ofertas
   correspondentes no Marketplace ↓" link that scrolls to the (now
   filtered) grid (`id="marketplace-offer-grid"`).

## Six real UX bugs found by a cold-start walkthrough (asked directly: "está fidedigno o suficiente para achar os furos de UX?")

Cleared `localStorage`, reloaded, and clicked through the app as a
genuinely new user instead of using backend/code knowledge to predict
behavior — the same methodology as the "Three real UX bugs" pass above,
applied a second time after the offer-publishing wizard and AI
Negotiator shipped. It surfaced two critical bugs no prior functional
test had caught, because those passes always verified "does the happy
path work," not "does an unexpected but natural human input break
silently."

1. **Self-trading was possible.** Nothing checked `user.id ===
   offer.userId` before `OfferDetail`'s "Iniciar Trade" — logging in as
   `bob_sats` and opening `bob_sats`'s own offer showed a working
   trade-start form, and the resulting trade showed `bob_sats` as both
   Comprador and Vendedor. Fixed with an `isOwnOffer` check that swaps
   the trade-start form for an explanatory card ("Esta é a sua oferta")
   linking to Perfil instead.
2. **AI Negotiator's currency parsing was hardcoded to BRL.**
   `qvacAgent.ts`'s `generateIntentWithQvac()` always returned
   `currency: 'BRL'` regardless of what the goal said — a goal like
   "quero comprar 100 dólares em USDT" silently produced a BRL-filtered
   Marketplace with zero matching offers, with nothing explaining why.
   Fixed the root cause with a `CURRENCY_HINTS` regex table (mirrors the
   existing `ASSET_HINTS`/`METHOD_HINTS` pattern), and added a
   safety net regardless: `Marketplace` now passes its live post-filter
   `offers.length` into `AgentIntentionPanel`, which shows "N ofertas
   correspondem a este filtro" or, on zero matches, "Nenhuma oferta
   encontrada com X + Y" plus a "Redefinir filtros" action.
3. **Mobile had no login/wallet indicator.** `TopNav` (desktop) shows
   avatar+name or a "Conectar" link, but it's `hidden md:flex` — on
   mobile, `Layout`'s own header showed only the logo and theme toggle,
   giving a first-time mobile user no way to tell if they were connected
   without opening Perfil. Fixed by mirroring TopNav's same pattern into
   the mobile header.
4. **Login led with jargon.** "Use seu keypair Ed25519 para autenticar"
   and "🔑 Conectar com WDK" were the first and only copy a brand-new
   user saw — meaningless without already knowing the product. The
   technical detail is accurate and this is a reference implementation
   of real crypto, so it wasn't deleted — it moved behind an
   `InfoTooltip` next to a plain "Entrar" heading, and the button now
   reads "Conectar Carteira".
5. **Raw backend enums leaked into UI copy.** `USDT_ERC20`,
   `BANK_TRANSFER`, `CRYPTO_DIRECT`, etc. were rendered verbatim in
   `Badge.tsx`, `FilterPanel`, `PublishOffer`, `Trade`, and
   `AgentIntentionPanel`. Fixed with a single `lib/labels.ts`
   (`ASSET_LABELS`, `ASSET_SHORT_LABELS`, `PAYMENT_METHOD_LABELS`)
   instead of per-component ad-hoc strings — the stored/filtered/
   submitted value is untouched, only the rendered text changes.
6. **`OfferDetail` showed the price twice.** The USD price appeared
   both in the big price line and again as a redundant "≈ $X USD"
   sub-line even when the offer was already priced in USD. Fixed by
   only showing the conversion sub-line when `fiatCurrency !== 'USD'`.

## Order history + identity key clarity (asked directly, in Portuguese: "minhas ordens tem que ter data e horario... e o usuario poder... remover a ordem")

Two direct owner requests, checked against how Binance P2P, Bisq,
HodlHodl, El Dorado, and P2P.me actually handle a user's own listings
before building anything:

- **"Minhas Ofertas" was a read-only, unordered dump — no date, no way
  to remove anything.** Every real P2P platform shows a dated,
  filterable list of your own ads with a way to take one down. Fixed in
  `Profile.tsx`: offers now sort newest-first, a status filter chip row
  (`Todos`/`Ativa`/`Pausada`/`Concluída`/`Cancelada`, reusing
  `OFFER_STATUS_LABEL`, now exported from `Badge.tsx`) narrows the list,
  each row shows `Criada em {formatDateTime(o.createdAt)}`, and
  ACTIVE/PAUSED offers get "Pausar"/"Ativar" plus a destructive
  "Cancelar oferta" action gated behind an inline confirm ("Sim,
  cancelar" / "Voltar") — no browser `confirm()`, matching this app's
  existing inline-confirm pattern (`Trade.tsx`'s dispute form). None of
  these platforms hard-delete a listing's row on cancel (Binance/Bisq/
  HodlHodl all just deactivate it), so `lib/offersStore.ts` gained
  `updateOfferStatus()` — a status-only mutation via a localStorage
  override map layered on top of both `MOCK_OFFERS` and locally-created
  offers, mirroring the real backend's actual mutation shape
  (`PATCH /v1/liquidity/offers/:id/status`, `liquidity.routes.ts`,
  ownership-checked in `liquidity.service.ts`) rather than inventing a
  DELETE that doesn't exist server-side.
  - **Second real bug this surfaced immediately:** `Marketplace.tsx`'s
    offer filter never checked `status` at all — until this fix nothing
    in the UI could ever move an offer off `ACTIVE`, so the gap was
    unreachable. Cancelling an offer and then finding it still listed
    for sale confirmed it live. Fixed with `if (o.status !== 'ACTIVE')
    return false` as the first filter check — a cancelled/paused offer
    now only appears to its owner, in "Minhas Ofertas".
- **The user's own public key was shown with zero label.** Raised
  directly after opening Keet (a Holepunch/Pears app) and seeing an
  unlabeled "Public Key" there too — it wasn't clear if Sails Protocol's
  version was even the same *kind* of key, let alone *whose*. It
  genuinely is the same key, not a simplification: `PearNode`'s own
  Ed25519 keypair *is* the identity keypair
  (`src/infrastructure/p2p/pear.service.ts`'s `getKeyPair()`;
  `docs/ARCHITECTURE.md` calls it "each PearNode's real identity
  keypair" outright) — used both to sign/authenticate
  (`common/middleware/auth.ts`) and to run the Hyperswarm/HyperDHT P2P
  node (`pear.routes.ts`'s `POST /v1/peers/start` takes the same secret
  key straight from the identity flow). `Profile.tsx` now labels it
  "Sua chave de identidade (Pears / P2P)" with an `InfoTooltip`
  explaining both roles in one sentence and naming Keet directly, so the
  connection to what the user already saw there is explicit.

## Running it

```bash
npm run dev -w @sails/ui       # http://localhost:5173
npm run build -w @sails/ui     # type-check + production build
```

The dev server proxies `/v1`/`/api` to `http://localhost:3000` (the
real backend) — not used by anything yet, but means swapping a mock
data read for a real `fetch`/`@satsails/p2p-trading-sdk` call later doesn't also
require touching `vite.config.ts`.

## Next steps (not done here)

> **Correction, 2026-08-01:** items 1-3 and 10 below were written before
> the real-SDK integration pass documented in "What this is not" above
> — they described work as fully outstanding that's now partially or
> mostly done. Left in place (not deleted) so the remaining, genuinely
> open piece of each is still visible: item 1's remaining scope is
> `Profile.tsx` + the admin console + `TradeHistory.tsx` specifically,
> not "every screen"; items 2 and 3 are done; item 10 is done for the
> publish action itself (see the corrected section above).

1. ~~Swap `src/data/mock.ts` reads for real `@satsails/p2p-trading-sdk` calls, route by
   route~~ — done for Login/Marketplace/OfferDetail/PublishOffer/Trade/
   Profile/TradeHistory/Disputes (2026-08-04). Still open:
   `PublishOffer.tsx`'s comparable-price helper. The admin console isn't
   "still open" — it was deleted, not left for a future real backend
   (see "What this is not").
2. ~~Real auth~~ — done. `AuthContext.tsx` uses `identity.create()`/
   `identity.authenticate()`'s real Ed25519 challenge-response flow.
3. ~~Real chat~~ — done. `Trade.tsx` uses a real `openp2p.chat(tradeId)`
   WebSocket, not a local-only `onSend`.
4. A real multi-fiat price field on `Offer` (backend), or a real FX-rate
   source, to back `CurrencyPicker`/`AMOUNT_PRESETS` with something
   other than illustrative numbers.
5. A real block-list model and trade-history join to back
   `negotiableOnly`/`previouslyTradedOnly` for real.
6. ~~A real `POST /v1/agents/...` route wrapping
   `qvacAgentProvider.generateTradeIntent()`/`.generateOfferIntent()`/
   `.assessIntentRisk()`~~ — done, 2026-08-09 (`agent.routes.ts` +
   `sailsClient.agents.*`). `AgentIntentionPanel`/`AgentRiskCard` both
   call the real routes now. Still open: the negotiation-mandate
   simulation `aiNegotiator.ts` drives after "Delegar para IA" — no
   backend accepts a full delegation mandate yet, only the structured-
   intent generation step before it.
7. Real media messages: an upload/storage endpoint plus a Pears event
   kind carrying a media reference, to back the chat's 📎 attach button
   with something beyond a local, never-transmitted blob URL.
8. A real `NegotiationIntent`-accepting backend for the AI Negotiator's
   delegation mandate — today `src/lib/aiNegotiator.ts`'s status
   timeline and Strategy panel are a client-side simulation with no
   agent actually running.
9. Real `RISK_WARNING`: `new WebSocket('/v1/openp2p/chat?token=...')`
   already delivers this message type once real chat (item 3) is wired
   — nothing extra is needed on the backend side, that route already
   broadcasts it (RFC-017). What's needed is only replacing
   `src/lib/socialEngineering.ts`'s keyword regex with just listening
   for the real WS message.
10. ~~A real `POST /v1/liquidity/offers` call~~ — done, and (2026-08-01)
    so is the read-back side: `Profile.tsx` no longer falls through to
    `lib/offersStore.ts`/`localStorage` at all, it calls the real
    `liquidity.getMyOffers()`. A real live-rate source would still let
    "Tipo de Preço: Flutuante" stop being disabled — that part remains
    open.
