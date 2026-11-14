# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: developers and companies integrating `@satsails/p2p-trading-sdk`
who want a working, production-realistic P2P trading interface to ship
against, instead of building a wallet-grade UI from zero. Their job is
"plug the SDK, get the interface too" — sails-ui exists to shorten that
path.

Secondary (downstream, not directly served by this package): the
end-trader who uses whatever product an integrator ships on top of the
SDK+UI — buying/selling crypto and stablecoins peer-to-peer against fiat
rails (PIX, bank transfer, cash) or crypto-direct/Lightning.

## Product Purpose

sails-ui is the reference UI for the Sails P2P Trading SDK. Every screen
calls the real SDK against real backend endpoints — never mock data
standing in for a capability that doesn't exist yet — so an integrator
can see and directly reuse a working interface rather than a scaffold.
Success means an integrator can plug in the SDK and already have a
credible, wallet-grade trading UI, not a proof of concept.

## Positioning

Three things together, not any one alone: (1) non-custody is a normative protocol invariant, while actual signing/custody guarantees and production eligibility depend on the selected provider (`WDK_USDT_EVM` is a server-custodial, production-ineligible reference path; `SAFE_GUARD_EVM` is not production-activated — RFC-019/RFC-020); the UI is designed without a platform-operator/admin visibility tier; (2) the SDK and this
UI are real from day one — no mocked backend calls standing in for
missing capability; (3) an embedded AI agent (QVAC, RFC-023) can
discover and negotiate a trade within user-declared price/reputation
limits and return a concrete proposal for human approval — real
negotiation authority, deliberately with no settlement authority. The
combined claim a competing protocol-only offering can't truthfully
match: plug the SDK, get a working, agent-capable trading interface
immediately.

## Operating Context

Web app (Vite/React 19, Tailwind v4, shadcn/ui). Nine screens today:
Marketplace (offer grid + AI Negotiator panel), Offer Detail, Trade
(chat + escrow state machine + dispute view), Login, Profile, Publish
Offer (3-step wizard), Trade History, Disputes (arbiter-scoped, not an
admin console). Core workflows: discover/filter offers, publish an
offer, start a trade, walk an escrow through lock/payment/release,
dispute and arbitration, reputation/vouching.

## Capabilities and Constraints

- Every SDK call in this UI is real (`@satsails/p2p-trading-sdk` against
  the actual Fastify backend) — this must never regress into mocked
  data standing in for a missing capability; any real gap is disclosed
  in code comments, not hidden behind a fake success state.
- Non-custodial is an architectural invariant, not marketing copy: no
  platform-operator/admin role exists or should be built: every read
  stays scoped to the calling participant.
- Visual language should read as "a normal crypto wallet app" in
  general — broadly legible against both the consumer-colorful family
  (MetaMask/Rainbow/Phantom) and the corporate/dashboard family (Trust
  Wallet, exchange-style wallets) — not chasing one specific brand,
  so an integrator's own users don't feel like they landed somewhere
  unfamiliar.
- Existing WCAG 2.1 AA contrast work (text and non-text/border
  contrast) is a working baseline established this project — preserve
  it, don't reopen it as part of general design work.

## Brand Commitments

Satsails identity: black + orange, orange constant across light and
dark themes. Space Grotesk for display/headline type (wordmark, page
titles); system font stack for body text, chosen for density on
info-heavy trading screens. Full light and dark theme support, user
switchable.

## Evidence on Hand

Real backend (Fastify + Prisma) and real SDK
(`@satsails/p2p-trading-sdk`) already wired through every screen — not
a hypothesis, verified throughout this project's own build history.
shadcn/ui migration already complete. No professional design audit has
been done yet — that gap is what this Impeccable engagement starts
closing. No user research/testing evidence on hand; do not fabricate
any.

## Product Principles

- Real over mocked, always disclosed when it isn't yet real — the UI's
  own credibility as "this is what plugging the SDK actually gets you"
  depends on this being true, not just claimed.
- Non-custodial is never compromised for a shortcut, in design or code:
  no operator/admin surface, no implied custody in copy or UI pattern.
- Familiar over novel: this UI should feel like "a wallet app," not
  like a bespoke design experiment — the whole point is that someone
  integrating the SDK doesn't have to teach their users a new visual
  language.
- Ship the whole surface, not a fragment: a feature's loading, empty,
  and error states must all feel finished (SLC — Simple, Lovable,
  Complete — not an MVP bar).

## Accessibility & Inclusion

WCAG 2.1 AA is the established standard for this project (both text and
non-text/UI-component contrast already brought into line this project).
Preserve as a floor for all new and revised work.
